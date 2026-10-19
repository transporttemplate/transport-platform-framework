begin;

create extension if not exists btree_gist;

alter table public.drivers add column if not exists driver_type text not null default 'fleet_driver';
alter table public.drivers drop constraint if exists drivers_driver_type_check;
alter table public.drivers add constraint drivers_driver_type_check check(driver_type in ('owner_driver','fleet_driver'));

alter table public.vehicles add column if not exists ownership_type text not null default 'company_fleet';
alter table public.vehicles add column if not exists operational_status text not null default 'available';
alter table public.vehicles add column if not exists notes text;
alter table public.vehicles drop constraint if exists vehicles_ownership_type_check;
alter table public.vehicles add constraint vehicles_ownership_type_check check(ownership_type in ('driver_owned','company_fleet','other_leased'));
alter table public.vehicles drop constraint if exists vehicles_operational_status_check;
alter table public.vehicles add constraint vehicles_operational_status_check check(operational_status in ('available','unavailable','off_road'));

create table if not exists public.driver_vehicle_links(
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id) on delete cascade,
 driver_id uuid not null,
 vehicle_id uuid not null,
 link_type text not null check(link_type in ('owner','default','eligible')),
 authorised_by uuid references auth.users(id),
 authorised_at timestamptz not null default now(),
 notes text,
 foreign key(driver_id,company_id) references public.drivers(id,company_id) on delete cascade,
 foreign key(vehicle_id,company_id) references public.vehicles(id,company_id) on delete cascade,
 unique(company_id,driver_id,vehicle_id,link_type)
);
create unique index if not exists one_default_vehicle_per_driver on public.driver_vehicle_links(company_id,driver_id) where link_type='default';
create unique index if not exists one_owner_per_vehicle on public.driver_vehicle_links(company_id,vehicle_id) where link_type='owner';
create index if not exists driver_vehicle_links_vehicle_idx on public.driver_vehicle_links(company_id,vehicle_id,link_type);

alter table public.driver_vehicle_assignments add column if not exists assignment_type text not null default 'current';
alter table public.driver_vehicle_assignments add column if not exists reason text;
alter table public.driver_vehicle_assignments add column if not exists ended_by uuid references auth.users(id);
alter table public.driver_vehicle_assignments add column if not exists updated_at timestamptz not null default now();
alter table public.driver_vehicle_assignments drop constraint if exists driver_vehicle_assignments_assignment_type_check;
alter table public.driver_vehicle_assignments add constraint driver_vehicle_assignments_assignment_type_check check(assignment_type in ('current','temporary','shift'));
drop index if exists public.one_current_vehicle_per_driver;

do $$ begin
 if not exists(select 1 from pg_constraint where conname='driver_vehicle_assignments_driver_no_overlap') then
  alter table public.driver_vehicle_assignments add constraint driver_vehicle_assignments_driver_no_overlap exclude using gist
   (company_id with =,driver_id with =,tstzrange(effective_from,coalesce(effective_to,'infinity'::timestamptz),'[)') with &&);
 end if;
 if not exists(select 1 from pg_constraint where conname='driver_vehicle_assignments_vehicle_no_overlap') then
  alter table public.driver_vehicle_assignments add constraint driver_vehicle_assignments_vehicle_no_overlap exclude using gist
   (company_id with =,vehicle_id with =,tstzrange(effective_from,coalesce(effective_to,'infinity'::timestamptz),'[)') with &&);
 end if;
end $$;

create or replace function public.driver_vehicle_admin(target_company_id uuid) returns boolean
language sql stable security definer set search_path=public as $$
 select auth.uid() is not null and exists(select 1 from public.company_users u where u.company_id=target_company_id and u.user_id=auth.uid() and lower(u.role) in ('owner','admin'))
$$;

create or replace function public.set_driver_vehicle_relationships(
 target_company_id uuid,target_driver_id uuid,target_driver_type text,
 target_owned_vehicle_ids uuid[],target_default_vehicle_id uuid,target_eligible_vehicle_ids uuid[],
 target_current_vehicle_id uuid,target_assignment_type text default 'current',target_reason text default null
) returns jsonb language plpgsql security definer set search_path=public as $$
declare vehicle_id uuid; owner_id uuid; now_at timestamptz:=now();
begin
 if not public.driver_vehicle_admin(target_company_id) then raise exception 'Admin company access required'; end if;
 if target_driver_type not in('owner_driver','fleet_driver') then raise exception 'Invalid driver type'; end if;
 if not exists(select 1 from drivers where id=target_driver_id and company_id=target_company_id) then raise exception 'Driver not found'; end if;
 update drivers set driver_type=target_driver_type where id=target_driver_id and company_id=target_company_id;
 delete from driver_vehicle_links where company_id=target_company_id and driver_id=target_driver_id and link_type in('owner','default','eligible');
 foreach vehicle_id in array coalesce(target_owned_vehicle_ids,array[]::uuid[]) loop
  if not exists(select 1 from vehicles where id=vehicle_id and company_id=target_company_id) then raise exception 'Vehicle does not belong to this company'; end if;
  insert into driver_vehicle_links(company_id,driver_id,vehicle_id,link_type,authorised_by) values(target_company_id,target_driver_id,vehicle_id,'owner',auth.uid());
 end loop;
 if target_default_vehicle_id is not null then
  if not exists(select 1 from vehicles where id=target_default_vehicle_id and company_id=target_company_id) then raise exception 'Default vehicle does not belong to this company'; end if;
  insert into driver_vehicle_links(company_id,driver_id,vehicle_id,link_type,authorised_by) values(target_company_id,target_driver_id,target_default_vehicle_id,'default',auth.uid());
 end if;
 foreach vehicle_id in array coalesce(target_eligible_vehicle_ids,array[]::uuid[]) loop
  if not exists(select 1 from vehicles where id=vehicle_id and company_id=target_company_id) then raise exception 'Eligible vehicle does not belong to this company'; end if;
  insert into driver_vehicle_links(company_id,driver_id,vehicle_id,link_type,authorised_by) values(target_company_id,target_driver_id,vehicle_id,'eligible',auth.uid()) on conflict do nothing;
 end loop;
 if target_current_vehicle_id is distinct from (select a.vehicle_id from driver_vehicle_assignments a where a.company_id=target_company_id and a.driver_id=target_driver_id and a.effective_to is null order by a.effective_from desc limit 1) then
  update driver_vehicle_assignments set effective_to=now_at,ended_by=auth.uid(),updated_at=now_at where company_id=target_company_id and driver_id=target_driver_id and effective_to is null;
  if target_current_vehicle_id is not null then
   select l.driver_id into owner_id from driver_vehicle_links l where l.company_id=target_company_id and l.vehicle_id=target_current_vehicle_id and l.link_type='owner' and l.driver_id<>target_driver_id limit 1;
   if owner_id is not null and not exists(select 1 from driver_vehicle_links where company_id=target_company_id and driver_id=target_driver_id and vehicle_id=target_current_vehicle_id and link_type='eligible') then raise exception 'Another driver owns this vehicle and explicit authorisation is required'; end if;
   if not exists(select 1 from vehicles where id=target_current_vehicle_id and company_id=target_company_id and active and operational_status='available') then raise exception 'Vehicle is inactive, unavailable or off road'; end if;
   update driver_vehicle_assignments set effective_to=now_at,ended_by=auth.uid(),updated_at=now_at where company_id=target_company_id and vehicle_id=target_current_vehicle_id and effective_to is null;
   insert into driver_vehicle_assignments(company_id,driver_id,vehicle_id,effective_from,assignment_type,reason,created_by) values(target_company_id,target_driver_id,target_current_vehicle_id,now_at,coalesce(target_assignment_type,'current'),nullif(trim(target_reason),''),auth.uid());
  end if;
 end if;
 return jsonb_build_object('ok',true,'driver_id',target_driver_id,'current_vehicle_id',target_current_vehicle_id);
end $$;

create or replace function public.save_vehicle_relationships(
 target_company_id uuid,target_vehicle_id uuid,target_ownership_type text,target_owner_driver_id uuid,
 target_current_driver_id uuid,target_notes text
) returns jsonb language plpgsql security definer set search_path=public as $$
declare now_at timestamptz:=now(); existing_owner uuid;
begin
 if not public.driver_vehicle_admin(target_company_id) then raise exception 'Admin company access required'; end if;
 if target_ownership_type not in('driver_owned','company_fleet','other_leased') then raise exception 'Invalid ownership type'; end if;
 if not exists(select 1 from vehicles where id=target_vehicle_id and company_id=target_company_id) then raise exception 'Vehicle not found'; end if;
 if target_owner_driver_id is not null and not exists(select 1 from drivers where id=target_owner_driver_id and company_id=target_company_id) then raise exception 'Owner driver does not belong to this company'; end if;
 update vehicles set ownership_type=target_ownership_type,notes=nullif(trim(target_notes),''),updated_at=now_at where id=target_vehicle_id and company_id=target_company_id;
 delete from driver_vehicle_links where company_id=target_company_id and vehicle_id=target_vehicle_id and link_type='owner';
 if target_owner_driver_id is not null then
  insert into driver_vehicle_links(company_id,driver_id,vehicle_id,link_type,authorised_by) values(target_company_id,target_owner_driver_id,target_vehicle_id,'owner',auth.uid());
  update drivers set driver_type='owner_driver' where id=target_owner_driver_id and company_id=target_company_id;
 end if;
 if target_current_driver_id is distinct from (select driver_id from driver_vehicle_assignments where company_id=target_company_id and vehicle_id=target_vehicle_id and effective_to is null order by effective_from desc limit 1) then
  update driver_vehicle_assignments set effective_to=now_at,ended_by=auth.uid(),updated_at=now_at where company_id=target_company_id and vehicle_id=target_vehicle_id and effective_to is null;
  if target_current_driver_id is not null then
   select driver_id into existing_owner from driver_vehicle_links where company_id=target_company_id and vehicle_id=target_vehicle_id and link_type='owner' and driver_id<>target_current_driver_id limit 1;
   if existing_owner is not null and not exists(select 1 from driver_vehicle_links where company_id=target_company_id and driver_id=target_current_driver_id and vehicle_id=target_vehicle_id and link_type='eligible') then raise exception 'Another driver owns this vehicle and explicit authorisation is required'; end if;
   update driver_vehicle_assignments set effective_to=now_at,ended_by=auth.uid(),updated_at=now_at where company_id=target_company_id and driver_id=target_current_driver_id and effective_to is null;
   insert into driver_vehicle_assignments(company_id,driver_id,vehicle_id,effective_from,assignment_type,reason,created_by) values(target_company_id,target_current_driver_id,target_vehicle_id,now_at,'current','Vehicle management update',auth.uid());
  end if;
 end if;
 return jsonb_build_object('ok',true,'vehicle_id',target_vehicle_id,'owner_driver_id',target_owner_driver_id,'current_driver_id',target_current_driver_id);
end $$;

create or replace function public.booking_vehicle_guard() returns trigger language plpgsql set search_path=public as $$
declare candidate uuid; owner_id uuid; starts_at timestamptz; ends_at timestamptz;
begin
 if new.driver_id is null then return new; end if;
 if tg_op='UPDATE' and new.driver_id is not distinct from old.driver_id and new.vehicle_id is not distinct from old.vehicle_id and new.journey_date is not distinct from old.journey_date and new.journey_time is not distinct from old.journey_time and new.route_duration_minutes is not distinct from old.route_duration_minutes and new.passengers is not distinct from old.passengers and not (lower(coalesce(old.status,'')) in('completed','cancelled','canceled','no_show') and lower(coalesce(new.status,'')) not in('completed','cancelled','canceled','no_show')) then return new; end if;
 if new.vehicle_id is null or (tg_op='UPDATE' and new.driver_id is distinct from old.driver_id and new.vehicle_id is not distinct from old.vehicle_id) then
  select a.vehicle_id into candidate from driver_vehicle_assignments a join vehicles v on v.id=a.vehicle_id and v.company_id=a.company_id where a.company_id=new.company_id and a.driver_id=new.driver_id and a.effective_to is null and v.active and v.operational_status='available' order by a.effective_from desc limit 1;
  if candidate is null then select l.vehicle_id into candidate from driver_vehicle_links l join vehicles v on v.id=l.vehicle_id and v.company_id=l.company_id where l.company_id=new.company_id and l.driver_id=new.driver_id and l.link_type='default' and v.active and v.operational_status='available' limit 1; end if;
  new.vehicle_id:=candidate;
 end if;
 if new.vehicle_id is null then return new; end if;
 if not exists(select 1 from vehicles where id=new.vehicle_id and company_id=new.company_id and active and operational_status='available' and passenger_seats>=coalesce(new.passengers,1)) then raise exception 'Selected vehicle is unavailable, off road or has insufficient capacity'; end if;
 select driver_id into owner_id from driver_vehicle_links where company_id=new.company_id and vehicle_id=new.vehicle_id and link_type='owner' and driver_id<>new.driver_id limit 1;
 if owner_id is not null and not exists(select 1 from driver_vehicle_links where company_id=new.company_id and driver_id=new.driver_id and vehicle_id=new.vehicle_id and link_type='eligible') then raise exception 'Driver is not authorised to use this privately owned vehicle'; end if;
 starts_at:=(new.journey_date+new.journey_time) at time zone coalesce((select timezone from settings where company_id=new.company_id),'Europe/London');
 ends_at:=starts_at+make_interval(mins=>greatest(30,coalesce(new.route_duration_minutes,60))::integer);
 if lower(coalesce(new.status,'')) not in('completed','cancelled','canceled','no_show') and exists(select 1 from bookings b where b.company_id=new.company_id and b.vehicle_id=new.vehicle_id and b.id<>new.id and lower(coalesce(b.status,'')) not in('completed','cancelled','canceled','no_show') and ((b.journey_date+b.journey_time) at time zone coalesce((select timezone from settings where company_id=new.company_id),'Europe/London'))<ends_at and (((b.journey_date+b.journey_time) at time zone coalesce((select timezone from settings where company_id=new.company_id),'Europe/London'))+make_interval(mins=>greatest(30,coalesce(b.route_duration_minutes,60))::integer))>starts_at) then raise exception 'Vehicle already has an overlapping booking'; end if;
 return new;
end $$;
drop trigger if exists booking_vehicle_guard_trigger on public.bookings;
create trigger booking_vehicle_guard_trigger before insert or update of driver_id,vehicle_id,journey_date,journey_time,route_duration_minutes,status,passengers on public.bookings for each row execute function public.booking_vehicle_guard();

create or replace function public.select_driver_shift_vehicle(target_company_id uuid,target_driver_id uuid,target_vehicle_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare now_at timestamptz:=now(); current_vehicle uuid;
begin
 if auth.role()<>'service_role' then raise exception 'Service role required'; end if;
 if not exists(select 1 from drivers where company_id=target_company_id and id=target_driver_id and active) then raise exception 'Driver not found'; end if;
 if exists(select 1 from bookings where company_id=target_company_id and driver_id=target_driver_id and lower(coalesce(status,'')) in('on_way','arrived','passenger_onboard')) then raise exception 'Finish the current journey before changing vehicle'; end if;
 select vehicle_id into current_vehicle from driver_vehicle_assignments where company_id=target_company_id and driver_id=target_driver_id and effective_to is null order by effective_from desc limit 1;
 if current_vehicle is not distinct from target_vehicle_id then return jsonb_build_object('ok',true,'vehicle_id',target_vehicle_id); end if;
 if target_vehicle_id is not null then
  if not exists(select 1 from vehicles where company_id=target_company_id and id=target_vehicle_id and active and operational_status='available') then raise exception 'This vehicle is unavailable or off road'; end if;
  if not exists(select 1 from driver_vehicle_links where company_id=target_company_id and driver_id=target_driver_id and vehicle_id=target_vehicle_id and link_type in('owner','default','eligible')) then raise exception 'You are not authorised to use this vehicle'; end if;
 end if;
 update driver_vehicle_assignments set effective_to=now_at,updated_at=now_at,reason='Driver portal vehicle change' where company_id=target_company_id and driver_id=target_driver_id and effective_to is null;
 if target_vehicle_id is not null then
  begin
   insert into driver_vehicle_assignments(company_id,driver_id,vehicle_id,effective_from,assignment_type,reason) values(target_company_id,target_driver_id,target_vehicle_id,now_at,'shift','Driver selected at shift start');
  exception when exclusion_violation then raise exception 'This vehicle is already assigned to another driver'; end;
 end if;
 return jsonb_build_object('ok',true,'vehicle_id',target_vehicle_id);
end $$;

alter table public.driver_vehicle_links enable row level security;
drop policy if exists driver_vehicle_links_admin_all on public.driver_vehicle_links;
create policy driver_vehicle_links_admin_all on public.driver_vehicle_links for all to authenticated using(public.driver_vehicle_admin(company_id)) with check(public.driver_vehicle_admin(company_id));
grant select,insert,update,delete on public.driver_vehicle_links to authenticated;
grant execute on function public.set_driver_vehicle_relationships(uuid,uuid,text,uuid[],uuid,uuid[],uuid,text,text) to authenticated;
grant execute on function public.save_vehicle_relationships(uuid,uuid,text,uuid,uuid,text) to authenticated;
revoke all on function public.select_driver_shift_vehicle(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.select_driver_shift_vehicle(uuid,uuid,uuid) to service_role;

commit;
