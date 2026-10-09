-- Fix PL/pgSQL ambiguity between RETURNS TABLE timestamp names and bookings columns.
-- No booking rows or security policies are changed by this migration.
begin;

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
    update public.bookings as target set
      status=next_status,
      accepted_at=case when next_status='accepted' then now() else target.accepted_at end,
      on_way_at=case when next_status='on_way' then now() else target.on_way_at end,
      passenger_onboard_at=case when next_status='passenger_onboard' then now() else target.passenger_onboard_at end,
      completed_at=case when next_status='completed' then now() else target.completed_at end
    where target.id=target_booking_id and target.company_id=target_company_id and target.driver_id=target_driver_id
    returning target.* into booking_row;
    insert into public.driver_job_events(company_id,booking_id,driver_id,event_type,from_status,to_status,actor_type,actor_id)
      values(target_company_id,target_booking_id,target_driver_id,'status_changed',previous_status,next_status,'driver',target_driver_id::text);
  end if;

  return query select booking_row.id,lower(booking_row.status),booking_row.accepted_at,booking_row.on_way_at,
    booking_row.passenger_onboard_at,booking_row.completed_at,
    public.driver_job_available_at(booking_row.journey_date,booking_row.journey_time,company_timezone),duplicate_request;
end $$;

revoke all on function public.transition_driver_booking(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.transition_driver_booking(uuid,uuid,uuid,text) to service_role;

notify pgrst,'reload schema';
commit;
