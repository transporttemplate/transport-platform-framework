-- Audited, service-only repair path for a missing historical linked return.
-- The function is additive and performs no repair until explicitly invoked.

begin;

create table if not exists public.historical_booking_repairs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  outbound_booking_id uuid not null,
  return_booking_id uuid not null,
  root_booking_reference text not null,
  reason text not null,
  previous_outbound jsonb not null,
  repaired_outbound jsonb not null,
  created_return jsonb not null,
  created_at timestamptz not null default now(),
  unique(company_id, root_booking_reference)
);

alter table public.historical_booking_repairs enable row level security;
revoke all on public.historical_booking_repairs from public, anon, authenticated;
grant select, insert on public.historical_booking_repairs to service_role;

create or replace function public.repair_missing_historical_return(
  target_company_id uuid,
  target_outbound_id uuid,
  target_root_reference text,
  expected_combined_fare numeric,
  repair_reason text
) returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  outbound public.bookings%rowtype;
  repaired_outbound public.bookings%rowtype;
  return_row public.bookings%rowtype;
  existing_return public.bookings%rowtype;
  outbound_fare numeric;
  return_fare numeric;
  payment_count integer;
  related_count integer;
  item public.booking_stops%rowtype;
begin
  if coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Service role required' using errcode='42501';
  end if;
  if expected_combined_fare is null or expected_combined_fare <= 0 then raise exception 'Expected combined fare is required'; end if;
  if nullif(trim(repair_reason),'') is null then raise exception 'Repair reason is required'; end if;

  perform pg_advisory_xact_lock(hashtextextended(target_company_id::text||':'||target_root_reference,0));
  select * into outbound from public.bookings
    where company_id=target_company_id and id=target_outbound_id and booking_reference=target_root_reference
    for update;
  if not found then raise exception 'Authorised outbound booking was not found'; end if;

  select count(*) into related_count from public.bookings
    where company_id=target_company_id and regexp_replace(booking_reference,'-R$','')=target_root_reference;
  select * into existing_return from public.bookings
    where company_id=target_company_id and booking_reference=target_root_reference||'-R';
  if existing_return.id is not null then
    if related_count=2
       and outbound.price+existing_return.price=expected_combined_fare
       and outbound.balance_due+existing_return.balance_due=expected_combined_fare
       and outbound.amount_paid+existing_return.amount_paid=0 then
      return jsonb_build_object('outbound_id',outbound.id,'return_id',existing_return.id,'idempotent',true);
    end if;
    raise exception 'A conflicting historical return already exists';
  end if;
  if related_count<>1 then raise exception 'Unexpected linked booking count: %',related_count; end if;
  if lower(coalesce(outbound.status,outbound.booking_status,'')) in ('cancelled','canceled') then raise exception 'Outbound booking is cancelled'; end if;
  if outbound.return_journey is not true or outbound.return_date is null or outbound.return_time is null then raise exception 'Return metadata is missing'; end if;
  if outbound.price is distinct from expected_combined_fare or outbound.journey_fare is not null then raise exception 'Combined fare attribution has changed'; end if;
  if lower(coalesce(outbound.payment_status,''))<>'unpaid' or coalesce(outbound.amount_paid,0)<>0 then raise exception 'Booking payment state has changed'; end if;
  if lower(coalesce(outbound.payment_method,''))<>'cash' then raise exception 'Expected cash payment method'; end if;
  select count(*) into payment_count from public.payments where company_id=target_company_id and booking_id=outbound.id;
  if payment_count<>0 then raise exception 'Payment records now exist for this booking'; end if;

  outbound_fare:=ceil(expected_combined_fare*100/2)/100;
  return_fare:=expected_combined_fare-outbound_fare;
  return_row:=outbound;
  return_row.id:=gen_random_uuid();
  return_row.booking_reference:=target_root_reference||'-R';
  return_row.pickup:=outbound.destination;
  return_row.destination:=outbound.pickup;
  return_row.pickup_address:=outbound.dropoff_address;
  return_row.pickup_name:=outbound.dropoff_name;
  return_row.pickup_postcode:=outbound.dropoff_postcode;
  return_row.pickup_place_id:=outbound.dropoff_place_id;
  return_row.pickup_lat:=outbound.dropoff_lat;
  return_row.pickup_lng:=outbound.dropoff_lng;
  return_row.pickup_country:=outbound.dropoff_country;
  return_row.pickup_address_line1:=outbound.dropoff_address_line1;
  return_row.pickup_address_line2:=outbound.dropoff_address_line2;
  return_row.pickup_building_name:=outbound.dropoff_building_name;
  return_row.dropoff_address:=outbound.pickup_address;
  return_row.dropoff_name:=outbound.pickup_name;
  return_row.dropoff_postcode:=outbound.pickup_postcode;
  return_row.dropoff_place_id:=outbound.pickup_place_id;
  return_row.dropoff_lat:=outbound.pickup_lat;
  return_row.dropoff_lng:=outbound.pickup_lng;
  return_row.dropoff_country:=outbound.pickup_country;
  return_row.dropoff_address_line1:=outbound.pickup_address_line1;
  return_row.dropoff_address_line2:=outbound.pickup_address_line2;
  return_row.dropoff_building_name:=outbound.pickup_building_name;
  return_row.journey_date:=outbound.return_date;
  return_row.journey_time:=outbound.return_time;
  return_row.return_journey:=false;
  return_row.return_date:=null;
  return_row.return_time:=null;
  return_row.journey_type:='return';
  return_row.price:=return_fare;
  return_row.journey_fare:=return_fare;
  return_row.payment_type:='linked_return';
  return_row.amount_paid:=0;
  return_row.balance_due:=0;
  return_row.paid_at:=null;
  return_row.driver_id:=null;
  return_row.driver_amount:=null;
  return_row.vehicle_id:=null;
  return_row.dispatched_at:=null;
  return_row.accepted_at:=null;
  return_row.on_way_at:=null;
  return_row.arrived_at:=null;
  return_row.passenger_onboard_at:=null;
  return_row.completed_at:=null;
  return_row.no_show_at:=null;
  return_row.no_show_by:=null;
  return_row.cancelled_at:=null;
  return_row.cancelled_by:=null;
  return_row.cancellation_reason:=null;
  return_row.status:='waiting';
  return_row.booking_status:='Pending';
  return_row.booking_source:='historical_return_repair';
  return_row.created_at:=now();
  return_row.created_by:=null;
  return_row.google_calendar_event_id:=null;
  return_row.google_calendar_synced_at:=null;
  return_row.google_calendar_sync_error:=null;
  return_row.creation_idempotency_key:=null;
  return_row.edit_version:=0;

  update public.bookings set
    price=outbound_fare,
    journey_fare=outbound_fare,
    payment_type='pay_in_car',
    amount_paid=0,
    balance_due=expected_combined_fare,
    edit_version=coalesce(edit_version,0)+1
  where company_id=target_company_id and id=target_outbound_id
  returning * into repaired_outbound;

  insert into public.bookings select return_row.*;

  for item in select * from public.booking_stops
    where company_id=target_company_id and booking_id=target_outbound_id order by stop_order desc
  loop
    item.id:=gen_random_uuid();
    item.booking_id:=return_row.id;
    item.stop_order:=(select count(*)+1 from public.booking_stops where company_id=target_company_id and booking_id=return_row.id);
    item.created_at:=now();
    insert into public.booking_stops select item.*;
  end loop;

  insert into public.historical_booking_repairs(
    company_id,outbound_booking_id,return_booking_id,root_booking_reference,reason,
    previous_outbound,repaired_outbound,created_return
  ) values (
    target_company_id,outbound.id,return_row.id,target_root_reference,trim(repair_reason),
    to_jsonb(outbound),to_jsonb(repaired_outbound),to_jsonb(return_row)
  );

  return jsonb_build_object('outbound_id',outbound.id,'return_id',return_row.id,'idempotent',false);
end $$;

revoke all on function public.repair_missing_historical_return(uuid,uuid,text,numeric,text) from public,anon,authenticated;
grant execute on function public.repair_missing_historical_return(uuid,uuid,text,numeric,text) to service_role;

notify pgrst,'reload schema';
commit;
