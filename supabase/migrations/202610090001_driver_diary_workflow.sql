-- Driver diary workflow: atomic transitions, activation window and audit trail.
-- Additive only. Review and apply to an isolated environment before production.
begin;

create table if not exists public.driver_job_events (
  id uuid primary key default extensions.gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  booking_id uuid not null,
  driver_id uuid,
  event_type text not null,
  from_status text,
  to_status text,
  actor_type text not null check (actor_type in ('driver','admin','system')),
  actor_id text,
  reason text,
  created_at timestamptz not null default now(),
  foreign key (booking_id, company_id) references public.bookings(id, company_id) on delete cascade,
  foreign key (driver_id, company_id) references public.drivers(id, company_id)
);

create index if not exists driver_job_events_booking_idx
  on public.driver_job_events(company_id, booking_id, created_at desc);
create index if not exists driver_job_events_driver_idx
  on public.driver_job_events(company_id, driver_id, created_at desc);

alter table public.driver_job_events enable row level security;
revoke all on table public.driver_job_events from public, anon, authenticated;
grant select on table public.driver_job_events to authenticated;

drop policy if exists driver_job_events_company_admin_select on public.driver_job_events;
create policy driver_job_events_company_admin_select
on public.driver_job_events for select to authenticated
using (public.user_can_access_company(company_id));

-- Several jobs may be accepted, but only one may be operationally active.
create unique index if not exists bookings_one_active_job_per_driver
  on public.bookings(company_id, driver_id)
  where driver_id is not null
    and lower(coalesce(status,'')) in ('on_way','passenger_onboard');

create or replace function public.driver_job_available_at(
  target_journey_date date,
  target_journey_time time,
  target_timezone text
) returns timestamptz
language sql stable
set search_path=public
as $$
  select ((target_journey_date + target_journey_time)
    at time zone coalesce(nullif(target_timezone,''),'Europe/London'))
    - interval '3 hours 30 minutes';
$$;

revoke all on function public.driver_job_available_at(date,time,text) from public,anon,authenticated;
grant execute on function public.driver_job_available_at(date,time,text) to service_role;

create or replace function public.enforce_booking_workflow()
returns trigger
language plpgsql
set search_path=public
as $$
declare
  old_status text := lower(coalesce(old.status,''));
  new_status text := lower(coalesce(new.status,''));
  company_timezone text;
  activation_at timestamptz;
  target_start timestamptz;
  target_end timestamptz;
  admin_override boolean := coalesce(current_setting('app.driver_workflow_admin_override',true),'')='true';
begin
  if old_status = new_status then return new; end if;
  new.booking_status:=new.status;

  if new.driver_id is not null then
    perform pg_advisory_xact_lock(hashtextextended(new.company_id::text||':'||new.driver_id::text,0));
  end if;

  if not (
    (old_status in ('','pending','waiting') and new_status in ('waiting','assigned','cancelled','canceled','no_show')) or
    (old_status='assigned' and new_status in ('waiting','accepted','cancelled','canceled','no_show')) or
    (old_status='accepted' and new_status in ('on_way','cancelled','canceled','no_show')) or
    (old_status='on_way' and new_status in ('passenger_onboard','cancelled','canceled','no_show')) or
    (old_status='passenger_onboard' and new_status in ('completed','cancelled','canceled','no_show'))
  ) then
    raise exception 'Invalid booking transition: % to %', old_status, new_status;
  end if;

  if new_status in ('assigned','accepted','on_way','passenger_onboard') and new.driver_id is null then
    raise exception 'An active booking status requires an assigned driver';
  end if;

  if new_status='accepted' then
    select coalesce(nullif(s.timezone,''),'Europe/London') into company_timezone
    from public.settings s where s.company_id=new.company_id;
    company_timezone:=coalesce(company_timezone,'Europe/London');
    target_start:=(new.journey_date+new.journey_time) at time zone company_timezone;
    target_end:=target_start+make_interval(mins=>greatest(1,coalesce(new.route_duration_minutes,60))::integer);
    if exists(
      select 1 from public.bookings other
      where other.company_id=new.company_id and other.driver_id=new.driver_id and other.id<>new.id
        and lower(coalesce(other.status,'')) in ('accepted','on_way','passenger_onboard')
        and tstzrange(
          (other.journey_date+other.journey_time) at time zone company_timezone,
          ((other.journey_date+other.journey_time) at time zone company_timezone)+make_interval(mins=>greatest(1,coalesce(other.route_duration_minutes,60))::integer),
          '[)'
        ) && tstzrange(target_start,target_end,'[)')
    ) then raise exception 'This job overlaps another accepted job'; end if;
  end if;

  if old_status='accepted' and new_status='on_way' and not admin_override then
    select coalesce(nullif(s.timezone,''),'Europe/London') into company_timezone
    from public.settings s where s.company_id=new.company_id;
    activation_at := public.driver_job_available_at(new.journey_date,new.journey_time,company_timezone);
    if activation_at is null or now() < activation_at then
      raise exception 'This job can be started at %', activation_at;
    end if;
  end if;

  return new;
end $$;

drop trigger if exists enforce_booking_workflow_trigger on public.bookings;
create trigger enforce_booking_workflow_trigger
before update of status on public.bookings
for each row execute function public.enforce_booking_workflow();

create or replace function public.transition_driver_booking(
  target_company_id uuid,
  target_driver_id uuid,
  target_booking_id uuid,
  requested_status text
) returns table(
  booking_id uuid,
  status text,
  accepted_at timestamptz,
  on_way_at timestamptz,
  passenger_onboard_at timestamptz,
  completed_at timestamptz,
  operational_available_at timestamptz,
  idempotent boolean
)
language plpgsql security definer set search_path=public
as $$
declare
  booking_row public.bookings%rowtype;
  previous_status text;
  next_status text := lower(trim(coalesce(requested_status,'')));
  company_timezone text;
  decline_allowed boolean;
  duplicate_request boolean := false;
  target_start timestamptz;
  target_end timestamptz;
begin
  if next_status not in ('accepted','on_way','passenger_onboard','completed','declined') then
    raise exception 'Invalid job status';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(target_company_id::text||':'||target_driver_id::text,0));

  select * into booking_row from public.bookings
  where id=target_booking_id and company_id=target_company_id and driver_id=target_driver_id
  for update;
  if not found then raise exception 'Assigned job not found'; end if;

  previous_status := lower(coalesce(booking_row.status,''));
  select coalesce(nullif(timezone,''),'Europe/London'),coalesce(driverreject,false)
    into company_timezone,decline_allowed
  from public.settings where company_id=target_company_id;

  if next_status='declined' then
    if not decline_allowed then raise exception 'Drivers cannot decline jobs for this company'; end if;
    if previous_status<>'assigned' then raise exception 'Only an allocated job awaiting response can be declined'; end if;
    update public.bookings set status='waiting',driver_id=null,dispatched_at=null
      where id=target_booking_id and company_id=target_company_id and driver_id=target_driver_id;
    insert into public.driver_job_events(company_id,booking_id,driver_id,event_type,from_status,to_status,actor_type,actor_id)
      values(target_company_id,target_booking_id,target_driver_id,'declined',previous_status,'waiting','driver',target_driver_id::text);
    return query select target_booking_id,'waiting'::text,booking_row.accepted_at,booking_row.on_way_at,
      booking_row.passenger_onboard_at,booking_row.completed_at,
      public.driver_job_available_at(booking_row.journey_date,booking_row.journey_time,company_timezone),false;
    return;
  end if;

  if previous_status=next_status then duplicate_request:=true;
  elsif not (
    (previous_status='assigned' and next_status='accepted') or
    (previous_status='accepted' and next_status='on_way') or
    (previous_status='on_way' and next_status='passenger_onboard') or
    (previous_status='passenger_onboard' and next_status='completed')
  ) then
    raise exception 'Invalid job transition: % to %', previous_status,next_status;
  end if;

  if not duplicate_request and next_status='accepted' then
    target_start:=(booking_row.journey_date+booking_row.journey_time) at time zone company_timezone;
    target_end:=target_start+make_interval(mins=>greatest(1,coalesce(booking_row.route_duration_minutes,60))::integer);
    if exists(
      select 1 from public.bookings other
      where other.company_id=target_company_id and other.driver_id=target_driver_id and other.id<>target_booking_id
        and lower(coalesce(other.status,'')) in ('accepted','on_way','passenger_onboard')
        and tstzrange(
          (other.journey_date+other.journey_time) at time zone company_timezone,
          ((other.journey_date+other.journey_time) at time zone company_timezone)+make_interval(mins=>greatest(1,coalesce(other.route_duration_minutes,60))::integer),
          '[)'
        ) && tstzrange(target_start,target_end,'[)')
    ) then raise exception 'This job overlaps another accepted job'; end if;
  end if;

  if not duplicate_request then
    update public.bookings set
      status=next_status,
      accepted_at=case when next_status='accepted' then now() else accepted_at end,
      on_way_at=case when next_status='on_way' then now() else on_way_at end,
      passenger_onboard_at=case when next_status='passenger_onboard' then now() else passenger_onboard_at end,
      completed_at=case when next_status='completed' then now() else completed_at end
    where id=target_booking_id and company_id=target_company_id and driver_id=target_driver_id
    returning * into booking_row;
    insert into public.driver_job_events(company_id,booking_id,driver_id,event_type,from_status,to_status,actor_type,actor_id)
      values(target_company_id,target_booking_id,target_driver_id,'status_changed',previous_status,next_status,'driver',target_driver_id::text);
  end if;

  return query select booking_row.id,lower(booking_row.status),booking_row.accepted_at,booking_row.on_way_at,
    booking_row.passenger_onboard_at,booking_row.completed_at,
    public.driver_job_available_at(booking_row.journey_date,booking_row.journey_time,company_timezone),duplicate_request;
end $$;

revoke all on function public.transition_driver_booking(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.transition_driver_booking(uuid,uuid,uuid,text) to service_role;

create or replace function public.admin_transition_booking(
  target_company_id uuid,
  target_booking_id uuid,
  requested_status text,
  override_reason text default null
) returns boolean
language plpgsql security definer set search_path=public
as $$
declare
  booking_row public.bookings%rowtype;
  previous_status text;
  next_status text := lower(trim(coalesce(requested_status,'')));
  reason_text text := nullif(trim(coalesce(override_reason,'')),'');
  company_timezone text;
  activation_at timestamptz;
begin
  if not public.user_can_access_company(target_company_id) then raise exception 'Admin company access required'; end if;
  if next_status not in ('accepted','on_way','passenger_onboard','completed','cancelled','no_show') then raise exception 'Invalid admin job status'; end if;
  select * into booking_row from public.bookings where id=target_booking_id and company_id=target_company_id for update;
  if not found then return false; end if;
  previous_status:=lower(coalesce(booking_row.status,''));

  if previous_status='accepted' and next_status='on_way' then
    select coalesce(nullif(timezone,''),'Europe/London') into company_timezone from public.settings where company_id=target_company_id;
    activation_at:=public.driver_job_available_at(booking_row.journey_date,booking_row.journey_time,company_timezone);
    if now()<activation_at then
      if reason_text is null then raise exception 'An override reason is required to start a job before %',activation_at; end if;
      perform set_config('app.driver_workflow_admin_override','true',true);
    end if;
  end if;

  update public.bookings set
    status=next_status,
    accepted_at=case when next_status='accepted' then now() else accepted_at end,
    on_way_at=case when next_status='on_way' then now() else on_way_at end,
    passenger_onboard_at=case when next_status='passenger_onboard' then now() else passenger_onboard_at end,
    completed_at=case when next_status='completed' then now() else completed_at end,
    cancelled_at=case when next_status='cancelled' then now() else cancelled_at end,
    no_show_at=case when next_status='no_show' then now() else no_show_at end
  where id=target_booking_id and company_id=target_company_id;

  insert into public.driver_job_events(company_id,booking_id,driver_id,event_type,from_status,to_status,actor_type,actor_id,reason)
    values(target_company_id,target_booking_id,booking_row.driver_id,
      case when reason_text is null then 'admin_status_changed' else 'admin_override' end,
      previous_status,next_status,'admin',auth.uid()::text,reason_text);
  return true;
end $$;

revoke all on function public.admin_transition_booking(uuid,uuid,text,text) from public,anon;
grant execute on function public.admin_transition_booking(uuid,uuid,text,text) to authenticated;

notify pgrst,'reload schema';
commit;
