-- Tenant-safe, atomic Admin booking amendments with optimistic locking and audit history.
begin;

alter table public.bookings add column if not exists edit_version bigint not null default 0;

create table if not exists public.admin_booking_audit (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  booking_id uuid not null,
  booking_reference text not null,
  admin_user_id uuid not null references auth.users(id),
  changed_fields text[] not null,
  previous_values jsonb not null,
  new_values jsonb not null,
  price_override_reason text,
  created_at timestamptz not null default now(),
  foreign key (booking_id, company_id) references public.bookings(id, company_id) on delete cascade
);
create index if not exists admin_booking_audit_booking_idx on public.admin_booking_audit(company_id, booking_id, created_at desc);
alter table public.admin_booking_audit enable row level security;
revoke all on public.admin_booking_audit from public, anon;
grant select on public.admin_booking_audit to authenticated;
drop policy if exists admin_booking_audit_company_select on public.admin_booking_audit;
create policy admin_booking_audit_company_select on public.admin_booking_audit for select to authenticated
using (public.user_can_access_company(company_id));

create or replace function public.admin_edit_booking(
  target_company_id uuid,
  target_booking_id uuid,
  expected_edit_version bigint,
  requested_changes jsonb,
  requested_stops jsonb default '[]'::jsonb,
  override_reason text default null
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  old_row public.bookings%rowtype;
  new_row public.bookings%rowtype;
  old_values jsonb;
  new_values jsonb;
  old_stops jsonb;
  new_stops jsonb;
  changed text[];
  new_driver uuid;
  journey_start timestamp;
  journey_end timestamp;
  stop jsonb;
  stop_number integer:=0;
  protected_status text;
begin
  if auth.uid() is null or not public.user_can_access_company(target_company_id) then
    raise exception 'Admin company access required' using errcode='42501';
  end if;
  if requested_changes is null or jsonb_typeof(requested_changes)<>'object' then raise exception 'Invalid booking changes'; end if;
  if requested_stops is null or jsonb_typeof(requested_stops)<>'array' then raise exception 'Invalid booking stops'; end if;

  select * into old_row from public.bookings where id=target_booking_id and company_id=target_company_id for update;
  if not found then raise exception 'Booking not found for this company' using errcode='P0002'; end if;
  if old_row.edit_version<>coalesce(expected_edit_version,0) then raise exception 'Booking edit conflict: reload the latest booking'; end if;
  protected_status:=lower(coalesce(old_row.status,old_row.booking_status,''));
  if protected_status in ('accepted','on_way','passenger_onboard','completed','cancelled','canceled','no_show') then
    raise exception 'Active or completed bookings are locked to protect driver workflow and payment history';
  end if;

  if nullif(trim(requested_changes->>'customer_name'),'') is null then raise exception 'Customer name is required'; end if;
  if nullif(trim(requested_changes->>'pickup_address'),'') is null or nullif(trim(requested_changes->>'dropoff_address'),'') is null then raise exception 'Pickup and destination are required'; end if;
  if (requested_changes->>'journey_date')::date is null or (requested_changes->>'journey_time')::time is null then raise exception 'Journey date and time are required'; end if;
  if coalesce((requested_changes->>'passengers')::integer,0) not between 1 and 52 then raise exception 'Passengers must be between 1 and 52'; end if;
  if coalesce((requested_changes->>'suitcases')::integer,0) not between 0 and 100 or coalesce((requested_changes->>'hand_luggage')::integer,0) not between 0 and 100 then raise exception 'Invalid luggage quantity'; end if;
  if coalesce((requested_changes->>'price')::numeric,-1)<0 then raise exception 'Price must not be negative'; end if;
  if requested_changes->>'driver_amount' is not null and (requested_changes->>'driver_amount')::numeric<0 then raise exception 'Driver amount must not be negative'; end if;
  if (requested_changes->>'price')::numeric is distinct from old_row.price and nullif(trim(override_reason),'') is null then raise exception 'A fare-change reason is required'; end if;
  if coalesce((requested_changes->>'return_journey')::boolean,false) and (nullif(requested_changes->>'return_date','') is null or nullif(requested_changes->>'return_time','') is null) then raise exception 'Return date and time are required'; end if;

  new_driver:=nullif(requested_changes->>'driver_id','')::uuid;
  journey_start:=(requested_changes->>'journey_date')::date+(requested_changes->>'journey_time')::time;
  journey_end:=journey_start+make_interval(mins=>greatest(30,coalesce((requested_changes->>'route_duration_minutes')::integer,60)));
  if new_driver is not null then
    if not exists(select 1 from public.drivers where id=new_driver and company_id=target_company_id and lower(coalesce(status,'active')) not in ('inactive','disabled')) then raise exception 'Driver is not available to this company'; end if;
    if exists(select 1 from public.driver_unavailability where company_id=target_company_id and driver_id=new_driver and active=true and from_datetime<journey_end and to_datetime>journey_start) then raise exception 'Driver is unavailable for this journey'; end if;
    if exists(select 1 from public.bookings b where b.company_id=target_company_id and b.driver_id=new_driver and b.id<>target_booking_id and lower(coalesce(b.status,b.booking_status,'')) not in ('completed','cancelled','canceled','no_show') and (b.journey_date+b.journey_time::time)<journey_end and (b.journey_date+b.journey_time::time+make_interval(mins=>greatest(30,coalesce(b.route_duration_minutes,60))))>journey_start) then raise exception 'Driver already has an overlapping booking'; end if;
  end if;

  select coalesce(jsonb_agg(to_jsonb(s)-'id'-'company_id'-'booking_id'-'created_at' order by s.stop_order),'[]'::jsonb) into old_stops from public.booking_stops s where s.booking_id=target_booking_id and s.company_id=target_company_id;
  old_values:=jsonb_build_object('customer_name',old_row.customer_name,'customer_email',old_row.customer_email,'customer_phone',old_row.customer_phone,'pickup_address',old_row.pickup_address,'pickup_name',old_row.pickup_name,'pickup_place_id',old_row.pickup_place_id,'dropoff_address',old_row.dropoff_address,'dropoff_name',old_row.dropoff_name,'dropoff_place_id',old_row.dropoff_place_id,'journey_date',old_row.journey_date,'journey_time',old_row.journey_time,'return_journey',old_row.return_journey,'return_date',old_row.return_date,'return_time',old_row.return_time,'passengers',old_row.passengers,'suitcases',old_row.suitcases,'hand_luggage',old_row.hand_luggage,'flight_number',old_row.flight_number,'notes',old_row.notes,'price',old_row.price,'driver_id',old_row.driver_id,'driver_amount',old_row.driver_amount,'payment_method',old_row.payment_method,'account_customer_id',old_row.account_customer_id,'account_po_reference',old_row.account_po_reference,'route_distance_miles',old_row.route_distance_miles,'route_duration_minutes',old_row.route_duration_minutes,'pricing_method',old_row.pricing_method,'stops',old_stops);

  update public.bookings set
    customer_name=trim(requested_changes->>'customer_name'), customer_email=nullif(trim(requested_changes->>'customer_email'),''), customer_phone=nullif(trim(requested_changes->>'customer_phone'),''),
    pickup_address=trim(requested_changes->>'pickup_address'), pickup_name=nullif(trim(requested_changes->>'pickup_name'),''), pickup_postcode=nullif(requested_changes->>'pickup_postcode',''), pickup_place_id=nullif(requested_changes->>'pickup_place_id',''), pickup_lat=nullif(requested_changes->>'pickup_lat','')::numeric, pickup_lng=nullif(requested_changes->>'pickup_lng','')::numeric,
    dropoff_address=trim(requested_changes->>'dropoff_address'), dropoff_name=nullif(trim(requested_changes->>'dropoff_name'),''), dropoff_postcode=nullif(requested_changes->>'dropoff_postcode',''), dropoff_place_id=nullif(requested_changes->>'dropoff_place_id',''), dropoff_lat=nullif(requested_changes->>'dropoff_lat','')::numeric, dropoff_lng=nullif(requested_changes->>'dropoff_lng','')::numeric,
    journey_date=(requested_changes->>'journey_date')::date, journey_time=(requested_changes->>'journey_time')::time,
    return_journey=coalesce((requested_changes->>'return_journey')::boolean,false), return_date=case when coalesce((requested_changes->>'return_journey')::boolean,false) then (requested_changes->>'return_date')::date else null end, return_time=case when coalesce((requested_changes->>'return_journey')::boolean,false) then (requested_changes->>'return_time')::time else null end,
    passengers=(requested_changes->>'passengers')::integer, suitcases=coalesce((requested_changes->>'suitcases')::integer,0), hand_luggage=coalesce((requested_changes->>'hand_luggage')::integer,0), flight_number=nullif(trim(requested_changes->>'flight_number'),''), notes=nullif(trim(requested_changes->>'notes'),''),
    price=(requested_changes->>'price')::numeric, driver_id=new_driver, driver_amount=nullif(requested_changes->>'driver_amount','')::numeric,
    dispatched_at=case when old_row.driver_id is distinct from new_driver then case when new_driver is null then null else now() end else old_row.dispatched_at end,
    status=case when old_row.driver_id is distinct from new_driver then
      case
        when new_driver is null and lower(coalesce(old_row.status,''))='assigned' then 'waiting'
        when new_driver is not null and lower(coalesce(old_row.status,'')) in ('','pending','waiting') then 'assigned'
        else old_row.status
      end
      else old_row.status end,
    payment_method=case when requested_changes->>'payment_method' in ('cash','card','account') then requested_changes->>'payment_method' else old_row.payment_method end,
    account_customer_id=case when requested_changes->>'payment_method'='account' then nullif(requested_changes->>'account_customer_id','')::uuid else null end,
    account_po_reference=case when requested_changes->>'payment_method'='account' then nullif(trim(requested_changes->>'account_po_reference'),'') else null end,
    route_distance_miles=nullif(requested_changes->>'route_distance_miles','')::numeric, route_duration_minutes=nullif(requested_changes->>'route_duration_minutes','')::integer, pricing_method=nullif(trim(requested_changes->>'pricing_method'),''), edit_version=old_row.edit_version+1
  where id=target_booking_id and company_id=target_company_id returning * into new_row;

  delete from public.booking_stops where booking_id=target_booking_id and company_id=target_company_id;
  for stop in select value from jsonb_array_elements(requested_stops) loop
    stop_number:=stop_number+1;
    if nullif(trim(stop->>'formatted_address'),'') is null then raise exception 'A stop address is required'; end if;
    insert into public.booking_stops(company_id,booking_id,stop_order,label,address_name,formatted_address,postcode,latitude,longitude,place_id)
    values(target_company_id,target_booking_id,stop_number,coalesce(nullif(trim(stop->>'label'),''),'Via'),nullif(trim(stop->>'address_name'),''),trim(stop->>'formatted_address'),nullif(stop->>'postcode',''),nullif(stop->>'latitude','')::numeric,nullif(stop->>'longitude','')::numeric,nullif(stop->>'place_id',''));
  end loop;

  select coalesce(jsonb_agg(to_jsonb(s)-'id'-'company_id'-'booking_id'-'created_at' order by s.stop_order),'[]'::jsonb) into new_stops from public.booking_stops s where s.booking_id=target_booking_id and s.company_id=target_company_id;
  new_values:=jsonb_build_object('customer_name',new_row.customer_name,'customer_email',new_row.customer_email,'customer_phone',new_row.customer_phone,'pickup_address',new_row.pickup_address,'pickup_name',new_row.pickup_name,'pickup_place_id',new_row.pickup_place_id,'dropoff_address',new_row.dropoff_address,'dropoff_name',new_row.dropoff_name,'dropoff_place_id',new_row.dropoff_place_id,'journey_date',new_row.journey_date,'journey_time',new_row.journey_time,'return_journey',new_row.return_journey,'return_date',new_row.return_date,'return_time',new_row.return_time,'passengers',new_row.passengers,'suitcases',new_row.suitcases,'hand_luggage',new_row.hand_luggage,'flight_number',new_row.flight_number,'notes',new_row.notes,'price',new_row.price,'driver_id',new_row.driver_id,'driver_amount',new_row.driver_amount,'payment_method',new_row.payment_method,'account_customer_id',new_row.account_customer_id,'account_po_reference',new_row.account_po_reference,'route_distance_miles',new_row.route_distance_miles,'route_duration_minutes',new_row.route_duration_minutes,'pricing_method',new_row.pricing_method,'stops',new_stops);
  select array_agg(key order by key) into changed from jsonb_each(old_values) where value is distinct from new_values->key;
  changed:=coalesce(changed,array[]::text[]);
  insert into public.admin_booking_audit(company_id,booking_id,booking_reference,admin_user_id,changed_fields,previous_values,new_values,price_override_reason)
  values(target_company_id,target_booking_id,old_row.booking_reference,auth.uid(),changed,old_values,new_values,nullif(trim(override_reason),''));
  return jsonb_build_object('id',new_row.id,'booking_reference',new_row.booking_reference,'edit_version',new_row.edit_version,'changed_fields',changed);
end $$;

revoke all on function public.admin_edit_booking(uuid,uuid,bigint,jsonb,jsonb,text) from public,anon;
grant execute on function public.admin_edit_booking(uuid,uuid,bigint,jsonb,jsonb,text) to authenticated;

commit;
notify pgrst,'reload schema';
