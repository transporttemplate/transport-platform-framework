-- Driver Arrived stage and atomic drop-off payment confirmation.
-- Additive data changes only; existing bookings, payments and audit rows are preserved.
begin;

alter table public.bookings add column if not exists arrived_at timestamptz;

-- Arrived is an active stage, so it must participate in the one-active-job invariant.
drop index if exists public.bookings_one_active_job_per_driver;
create unique index bookings_one_active_job_per_driver
  on public.bookings(company_id, driver_id)
  where driver_id is not null
    and lower(coalesce(status,'')) in ('on_way','arrived','passenger_onboard');

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
    (old_status='on_way' and new_status in ('arrived','cancelled','canceled','no_show')) or
    (old_status='arrived' and new_status in ('passenger_onboard','cancelled','canceled','no_show')) or
    (old_status='passenger_onboard' and new_status in ('completed','cancelled','canceled','no_show'))
  ) then
    raise exception 'Invalid booking transition: % to %', old_status, new_status;
  end if;

  if new_status in ('assigned','accepted','on_way','arrived','passenger_onboard') and new.driver_id is null then
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
        and lower(coalesce(other.status,'')) in ('accepted','on_way','arrived','passenger_onboard')
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
  if next_status not in ('accepted','on_way','arrived','passenger_onboard','declined') then
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
    (previous_status='on_way' and next_status='arrived') or
    (previous_status='arrived' and next_status='passenger_onboard')
  ) then
    raise exception 'Invalid job transition: % to %', previous_status,next_status;
  end if;

  if not duplicate_request and next_status='accepted' then
    target_start:=(booking_row.journey_date+booking_row.journey_time) at time zone company_timezone;
    target_end:=target_start+make_interval(mins=>greatest(1,coalesce(booking_row.route_duration_minutes,60))::integer);
    if exists(
      select 1 from public.bookings other
      where other.company_id=target_company_id and other.driver_id=target_driver_id and other.id<>target_booking_id
        and lower(coalesce(other.status,'')) in ('accepted','on_way','arrived','passenger_onboard')
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
      arrived_at=case when next_status='arrived' then now() else target.arrived_at end,
      passenger_onboard_at=case when next_status='passenger_onboard' then now() else target.passenger_onboard_at end
    where target.id=target_booking_id and target.company_id=target_company_id and target.driver_id=target_driver_id
    returning target.* into booking_row;
    insert into public.driver_job_events(company_id,booking_id,driver_id,event_type,from_status,to_status,actor_type,actor_id)
      values(target_company_id,target_booking_id,target_driver_id,
        case when next_status='arrived' then 'driver_arrived' else 'status_changed' end,
        previous_status,next_status,'driver',target_driver_id::text);
  end if;

  return query select booking_row.id,lower(booking_row.status),booking_row.accepted_at,booking_row.on_way_at,
    booking_row.passenger_onboard_at,booking_row.completed_at,
    public.driver_job_available_at(booking_row.journey_date,booking_row.journey_time,company_timezone),duplicate_request;
end $$;

revoke all on function public.transition_driver_booking(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.transition_driver_booking(uuid,uuid,uuid,text) to service_role;

create or replace function public.mark_driver_cash_booking_paid(target_company_id uuid,target_driver_id uuid,target_booking_id uuid)
returns boolean language plpgsql security definer set search_path=public as $$
declare
  booking_row public.bookings%rowtype;
  paid_time timestamptz:=now();
  paid_amount numeric;
  paid_before numeric;
  fare_total numeric;
  cash_eligible boolean;
begin
  select * into booking_row from public.bookings
  where id=target_booking_id and company_id=target_company_id and driver_id=target_driver_id for update;
  if not found then return false; end if;
  cash_eligible:=regexp_replace(lower(trim(coalesce(booking_row.payment_method,''))),'[^a-z0-9]+','_','g') in ('cash','pay_in_car','pay_by_cash')
    or regexp_replace(lower(trim(coalesce(booking_row.payment_type,''))),'[^a-z0-9]+','_','g')='pay_in_car'
    or (regexp_replace(lower(trim(coalesce(booking_row.payment_type,''))),'[^a-z0-9]+','_','g')='deposit' and lower(trim(coalesce(booking_row.payment_status,'')))='deposit_paid');
  if not cash_eligible then raise exception 'Only an eligible outstanding in-car balance can be marked paid'; end if;
  if lower(coalesce(booking_row.status,'')) not in ('accepted','on_way','arrived','passenger_onboard','completed') then raise exception 'Payment cannot be recorded at this stage'; end if;
  if lower(coalesce(booking_row.payment_status,''))='paid' then return true; end if;
  paid_before:=greatest(0,coalesce(booking_row.amount_paid,0));
  fare_total:=greatest(0,coalesce(booking_row.price,booking_row.job_price,0),paid_before+greatest(0,coalesce(booking_row.balance_due,0)));
  paid_amount:=greatest(0,fare_total-paid_before);
  if paid_amount<=0 then
    update public.bookings set payment_status='paid',paid_at=coalesce(paid_at,paid_time),balance_due=0
    where id=target_booking_id and company_id=target_company_id and driver_id=target_driver_id;
    return true;
  end if;
  insert into public.payments(company_id,booking_id,amount,method,status,reference,paid_at)
    values(target_company_id,target_booking_id,paid_amount,'driver_cash','paid','driver-cash:'||target_booking_id,paid_time)
    on conflict do nothing;
  update public.bookings set payment_status='paid',paid_at=paid_time,amount_paid=paid_before+paid_amount,balance_due=0
  where id=target_booking_id and company_id=target_company_id and driver_id=target_driver_id;
  insert into public.driver_job_events(company_id,booking_id,driver_id,event_type,from_status,to_status,actor_type,actor_id,reason)
    values(target_company_id,target_booking_id,target_driver_id,'driver_cash_collected',lower(booking_row.status),lower(booking_row.status),'driver',target_driver_id::text,'Outstanding in-car balance confirmed paid');
  return true;
end $$;
revoke all on function public.mark_driver_cash_booking_paid(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.mark_driver_cash_booking_paid(uuid,uuid,uuid) to service_role;

create or replace function public.complete_driver_booking_with_payment_confirmation(
  target_company_id uuid,
  target_driver_id uuid,
  target_booking_id uuid,
  payment_confirmation text default null
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  booking_row public.bookings%rowtype;
  previous_status text;
  choice text:=lower(trim(coalesce(payment_confirmation,'')));
  method text;
  payment_type_value text;
  payment_state text;
  paid_before numeric;
  fare_total numeric;
  outstanding numeric;
  cash_eligible boolean;
  account_booking boolean;
begin
  perform pg_advisory_xact_lock(hashtextextended(target_company_id::text||':'||target_driver_id::text,0));
  select * into booking_row from public.bookings
  where id=target_booking_id and company_id=target_company_id and driver_id=target_driver_id for update;
  if not found then raise exception 'Assigned job not found'; end if;
  previous_status:=lower(coalesce(booking_row.status,''));
  if previous_status='completed' then
    return jsonb_build_object('booking_id',booking_row.id,'status','completed','payment_status',booking_row.payment_status,'idempotent',true);
  end if;
  if previous_status<>'passenger_onboard' then raise exception 'Invalid job transition: % to completed',previous_status; end if;

  method:=regexp_replace(lower(trim(coalesce(booking_row.payment_method,''))),'[^a-z0-9]+','_','g');
  payment_type_value:=regexp_replace(lower(trim(coalesce(booking_row.payment_type,''))),'[^a-z0-9]+','_','g');
  payment_state:=lower(trim(coalesce(booking_row.payment_status,'')));
  paid_before:=greatest(0,coalesce(booking_row.amount_paid,0));
  fare_total:=greatest(0,coalesce(booking_row.price,booking_row.job_price,0),paid_before+greatest(0,coalesce(booking_row.balance_due,0)));
  outstanding:=greatest(0,fare_total-paid_before);
  cash_eligible:=method in ('cash','pay_in_car','pay_by_cash') or payment_type_value='pay_in_car'
    or (payment_type_value='deposit' and payment_state='deposit_paid');
  account_booking:=booking_row.account_customer_id is not null or method in ('account','invoice','account_invoice','pay_by_invoice')
    or payment_type_value in ('account','invoice');

  if payment_state='paid' or outstanding<=0 then
    null;
  elsif account_booking then
    if choice<>'' then raise exception 'Payment confirmation is not valid for an account or invoice booking'; end if;
  elsif cash_eligible then
    if choice not in ('paid','unpaid') then raise exception 'The driver must confirm whether the customer paid'; end if;
    if choice='paid' then
      if not public.mark_driver_cash_booking_paid(target_company_id,target_driver_id,target_booking_id) then raise exception 'Unable to record the driver cash payment'; end if;
    else
      insert into public.driver_job_events(company_id,booking_id,driver_id,event_type,from_status,to_status,actor_type,actor_id,reason)
        values(target_company_id,target_booking_id,target_driver_id,'driver_payment_not_received',previous_status,previous_status,'driver',target_driver_id::text,'Driver confirmed customer had not paid at drop-off');
    end if;
  else
    raise exception 'Payment state is unsupported or ambiguous; contact the office before completing this job';
  end if;

  update public.bookings set status='completed',completed_at=now()
  where id=target_booking_id and company_id=target_company_id and driver_id=target_driver_id
  returning * into booking_row;
  insert into public.driver_job_events(company_id,booking_id,driver_id,event_type,from_status,to_status,actor_type,actor_id)
    values(target_company_id,target_booking_id,target_driver_id,'status_changed',previous_status,'completed','driver',target_driver_id::text);
  return jsonb_build_object('booking_id',booking_row.id,'status','completed','payment_status',booking_row.payment_status,'idempotent',false);
end $$;
revoke all on function public.complete_driver_booking_with_payment_confirmation(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.complete_driver_booking_with_payment_confirmation(uuid,uuid,uuid,text) to service_role;

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
  if next_status not in ('accepted','on_way','arrived','passenger_onboard','completed','cancelled','no_show') then raise exception 'Invalid admin job status'; end if;
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
    arrived_at=case when next_status='arrived' then now() else arrived_at end,
    passenger_onboard_at=case when next_status='passenger_onboard' then now() else passenger_onboard_at end,
    completed_at=case when next_status='completed' then now() else completed_at end,
    cancelled_at=case when next_status='cancelled' then now() else cancelled_at end,
    no_show_at=case when next_status='no_show' then now() else no_show_at end
  where id=target_booking_id and company_id=target_company_id;
  insert into public.driver_job_events(company_id,booking_id,driver_id,event_type,from_status,to_status,actor_type,actor_id,reason)
    values(target_company_id,target_booking_id,booking_row.driver_id,
      case when next_status='arrived' then 'driver_arrived' when reason_text is null then 'admin_status_changed' else 'admin_override' end,
      previous_status,next_status,'admin',auth.uid()::text,reason_text);
  return true;
end $$;
revoke all on function public.admin_transition_booking(uuid,uuid,text,text) from public,anon;
grant execute on function public.admin_transition_booking(uuid,uuid,text,text) to authenticated;

-- Arrived bookings remain protected from ordinary detail edits while allowing
-- legitimate workflow, cancellation and payment fields to change.
create or replace function public.protect_arrived_booking_details()
returns trigger language plpgsql set search_path=public as $$
declare
  sensitive_key text;
  sensitive_keys text[]:=array[
    'customer_id','customer_name','customer_email','customer_phone','phone','email',
    'pickup','pickup_name','pickup_address','pickup_postcode','pickup_place_id','pickup_lat','pickup_lng',
    'destination','dropoff_name','dropoff_address','dropoff_postcode','dropoff_place_id','dropoff_lat','dropoff_lng',
    'journey_date','journey_time','return_journey','return_date','return_time',
    'passengers','suitcases','hand_luggage','flight_number','airport','notes',
    'vehicle_tier','vehicle_type','price','job_price','driver_id','driver_amount',
    'payment_method','payment_type','account_customer_id','account_po_reference',
    'route_distance_miles','route_duration_minutes','pricing_method'
  ];
begin
  if lower(coalesce(old.status,''))='arrived' then
    foreach sensitive_key in array sensitive_keys loop
      if (to_jsonb(new)->sensitive_key) is distinct from (to_jsonb(old)->sensitive_key) then
        raise exception 'Arrived bookings are locked to protect driver workflow and payment history';
      end if;
    end loop;
  end if;
  return new;
end $$;
drop trigger if exists protect_arrived_booking_details_trigger on public.bookings;
create trigger protect_arrived_booking_details_trigger before update on public.bookings
for each row execute function public.protect_arrived_booking_details();

notify pgrst,'reload schema';
commit;
