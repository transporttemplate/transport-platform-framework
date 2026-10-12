-- Release 4: additive, tenant-safe manual availability and driver leave workflow.
-- Manual blocks are enforced at the database boundary. Automatic capacity
-- rejection is deliberately disabled by default and is not enabled here.
begin;

alter table public.settings
  add column if not exists availability_mode text not null default 'manual'
    check (availability_mode in ('manual','automatic')),
  add column if not exists automatic_capacity_enforced boolean not null default false,
  add column if not exists turnaround_buffer_minutes integer not null default 0
    check (turnaround_buffer_minutes between 0 and 240);

create table if not exists public.availability_blocks (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  whole_day boolean not null default false,
  reason text,
  recurrence_frequency text check (recurrence_frequency in ('daily','weekly')),
  recurrence_interval integer not null default 1 check (recurrence_interval between 1 and 52),
  recurrence_until date,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  check (ends_at > starts_at),
  check (recurrence_frequency is not null or recurrence_until is null)
);
create index if not exists availability_blocks_company_time_idx
  on public.availability_blocks(company_id, starts_at, ends_at) where active;

create table if not exists public.availability_block_audit (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  block_id uuid not null,
  action text not null check (action in ('created','updated','deleted')),
  actor_user_id uuid references auth.users(id),
  previous_values jsonb,
  new_values jsonb,
  created_at timestamptz not null default now()
);
create index if not exists availability_block_audit_company_idx
  on public.availability_block_audit(company_id, block_id, created_at desc);

alter table public.driver_unavailability
  add column if not exists request_status text not null default 'approved'
    check (request_status in ('pending','approved','rejected')),
  add column if not exists reviewed_at timestamptz,
  add column if not exists reviewed_by uuid references auth.users(id),
  add column if not exists review_note text;

alter table public.bookings
  add column if not exists availability_override_reason text,
  add column if not exists availability_overridden_by uuid references auth.users(id),
  add column if not exists availability_overridden_at timestamptz;

create table if not exists public.availability_override_audit (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  booking_id uuid not null,
  block_ids uuid[] not null default '{}',
  authorised_by uuid not null references auth.users(id),
  reason text not null,
  created_at timestamptz not null default now()
);

alter table public.availability_blocks enable row level security;
alter table public.availability_block_audit enable row level security;
alter table public.availability_override_audit enable row level security;
revoke all on public.availability_blocks, public.availability_block_audit,
  public.availability_override_audit from public, anon;
grant select,insert,update,delete on public.availability_blocks to authenticated;
grant select on public.availability_block_audit, public.availability_override_audit to authenticated;

drop policy if exists availability_blocks_admin on public.availability_blocks;
create policy availability_blocks_admin on public.availability_blocks for all to authenticated
  using (public.user_can_access_company(company_id))
  with check (public.user_can_access_company(company_id));
drop policy if exists availability_block_audit_admin on public.availability_block_audit;
create policy availability_block_audit_admin on public.availability_block_audit for select to authenticated
  using (public.user_can_access_company(company_id));
drop policy if exists availability_override_audit_admin on public.availability_override_audit;
create policy availability_override_audit_admin on public.availability_override_audit for select to authenticated
  using (public.user_can_access_company(company_id));

create or replace function public.audit_availability_block() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  -- Serialise block changes with booking acceptance for this company. This is
  -- intentionally company-wide: overnight and multi-day blocks cross dates.
  perform pg_advisory_xact_lock(hashtextextended(coalesce(new.company_id,old.company_id)::text,0));
  if tg_op='INSERT' then
    new.created_by:=auth.uid(); new.updated_by:=auth.uid();
    insert into public.availability_block_audit(company_id,block_id,action,actor_user_id,new_values)
    values(new.company_id,new.id,'created',auth.uid(),to_jsonb(new)); return new;
  elsif tg_op='UPDATE' then
    new.updated_at:=now(); new.updated_by:=auth.uid();
    insert into public.availability_block_audit(company_id,block_id,action,actor_user_id,previous_values,new_values)
    values(new.company_id,new.id,case when old.active and not new.active then 'deleted' else 'updated' end,auth.uid(),to_jsonb(old),to_jsonb(new)); return new;
  else
    insert into public.availability_block_audit(company_id,block_id,action,actor_user_id,previous_values)
    values(old.company_id,old.id,'deleted',auth.uid(),to_jsonb(old)); return old;
  end if;
end $$;
drop trigger if exists availability_block_audit_trigger on public.availability_blocks;
create trigger availability_block_audit_trigger before insert or update or delete on public.availability_blocks
for each row execute function public.audit_availability_block();

-- Expands only occurrences that could overlap the requested half-open interval
-- [requested_start, requested_end). PostgreSQL timezone conversion handles DST.
create or replace function public.availability_conflicts(
  target_company_id uuid, requested_start timestamptz, requested_end timestamptz
) returns table(block_id uuid, occurrence_start timestamptz, occurrence_end timestamptz, reason text)
language sql stable security definer set search_path=public as $$
  with expanded as (
    select b.id,b.reason,b.starts_at as occurrence_start,b.ends_at as occurrence_end
    from public.availability_blocks b
    where b.company_id=target_company_id and b.active and b.recurrence_frequency is null
    union all
    select b.id,b.reason,
      (g at time zone coalesce(s.timezone,'Europe/London')) as occurrence_start,
      ((g+((b.ends_at at time zone coalesce(s.timezone,'Europe/London'))-(b.starts_at at time zone coalesce(s.timezone,'Europe/London')))) at time zone coalesce(s.timezone,'Europe/London')) as occurrence_end
    from public.availability_blocks b
    left join public.settings s on s.company_id=b.company_id
    cross join lateral generate_series(
      b.starts_at at time zone coalesce(s.timezone,'Europe/London'),
      least(coalesce((b.recurrence_until+1)::timestamp, requested_end at time zone coalesce(s.timezone,'Europe/London')), requested_end at time zone coalesce(s.timezone,'Europe/London')),
      case b.recurrence_frequency when 'daily' then make_interval(days=>b.recurrence_interval)
        else make_interval(weeks=>b.recurrence_interval) end
    ) g
    where b.company_id=target_company_id and b.active and b.recurrence_frequency is not null
  )
  select id,occurrence_start,occurrence_end,reason from expanded
  where occurrence_start < requested_end and occurrence_end > requested_start;
$$;

create or replace function public.check_booking_availability(
  target_company_id uuid, journey_start timestamptz, journey_duration_minutes integer
) returns jsonb language plpgsql stable security definer set search_path=public as $$
declare ids uuid[]; finish timestamptz; buffer integer;
begin
  if journey_start is null then raise exception 'Journey start is required'; end if;
  select greatest(0,coalesce(turnaround_buffer_minutes,0)) into buffer from public.settings where company_id=target_company_id;
  -- Unknown duration is deliberately conservative but explicit: pickup instant
  -- plus a one-minute interval. Reliable route duration is used when supplied.
  finish:=journey_start+make_interval(mins=>greatest(1,coalesce(journey_duration_minutes,1))+coalesce(buffer,0));
  select coalesce(array_agg(block_id),'{}') into ids
  from public.availability_conflicts(target_company_id,journey_start,finish);
  return jsonb_build_object('available',cardinality(ids)=0,'block_ids',ids,'starts_at',journey_start,'ends_at',finish,'duration_reliable',journey_duration_minutes is not null);
end $$;

create or replace function public.enforce_booking_availability() returns trigger
language plpgsql security definer set search_path=public as $$
declare tz text; start_at timestamptz; result jsonb; reason_text text; actor uuid;
begin
  if lower(coalesce(new.status,new.booking_status,'')) in ('cancelled','canceled','no_show') then return new; end if;
  -- Do not let a later block interfere with ordinary edits or driver workflow
  -- transitions on an already accepted booking.
  if tg_op='UPDATE' and new.company_id is not distinct from old.company_id
    and new.journey_date is not distinct from old.journey_date
    and new.journey_time is not distinct from old.journey_time
    and new.route_duration_minutes is not distinct from old.route_duration_minutes then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(new.company_id::text,0));
  select coalesce(timezone,'Europe/London') into tz from public.settings where company_id=new.company_id;
  start_at:=(new.journey_date+new.journey_time::time) at time zone tz;
  result:=public.check_booking_availability(new.company_id,start_at,new.route_duration_minutes);
  if not coalesce((result->>'available')::boolean,false) then
    reason_text:=nullif(trim(coalesce(new.availability_override_reason,'')),''); actor:=auth.uid();
    if reason_text is null or actor is null or not public.user_can_access_company(new.company_id) then
      raise exception 'FULLY_BOOKED: Sorry, we are fully booked at the selected time. Please choose another time or date.' using errcode='P0001';
    end if;
    new.availability_overridden_by:=actor; new.availability_overridden_at:=now();
  end if;
  return new;
end $$;
drop trigger if exists enforce_booking_availability_trigger on public.bookings;
create trigger enforce_booking_availability_trigger before insert or update of journey_date,journey_time,route_duration_minutes,company_id
on public.bookings for each row execute function public.enforce_booking_availability();

create or replace function public.record_availability_override() returns trigger
language plpgsql security definer set search_path=public as $$
declare tz text; start_at timestamptz; ids uuid[];
begin
  if new.availability_overridden_at is null or new.availability_override_reason is null then return new; end if;
  select coalesce(timezone,'Europe/London') into tz from public.settings where company_id=new.company_id;
  start_at:=(new.journey_date+new.journey_time::time) at time zone tz;
  select coalesce(array_agg(block_id),'{}') into ids from public.availability_conflicts(new.company_id,start_at,start_at+make_interval(mins=>greatest(1,coalesce(new.route_duration_minutes,1))));
  insert into public.availability_override_audit(company_id,booking_id,block_ids,authorised_by,reason)
  values(new.company_id,new.id,ids,new.availability_overridden_by,new.availability_override_reason);
  return new;
end $$;
drop trigger if exists record_availability_override_trigger on public.bookings;
create trigger record_availability_override_trigger after insert on public.bookings
for each row execute function public.record_availability_override();

revoke all on function public.availability_conflicts(uuid,timestamptz,timestamptz) from public,anon,authenticated;
revoke all on function public.check_booking_availability(uuid,timestamptz,integer) from public,anon,authenticated;
grant execute on function public.availability_conflicts(uuid,timestamptz,timestamptz) to service_role;
grant execute on function public.check_booking_availability(uuid,timestamptz,integer) to service_role;

commit;
notify pgrst,'reload schema';
