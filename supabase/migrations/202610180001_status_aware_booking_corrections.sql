-- Status-aware, tenant-safe administrator booking corrections.
begin;

alter table public.admin_booking_audit add column if not exists change_reason text;

create or replace function public.admin_edit_booking(
  target_company_id uuid,target_booking_id uuid,expected_edit_version bigint,
  requested_changes jsonb,requested_stops jsonb default '[]'::jsonb,override_reason text default null
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
 old_row bookings%rowtype;new_row bookings%rowtype;old_values jsonb;new_values jsonb;old_stops jsonb;new_stops jsonb;
 old_stop_addresses jsonb;new_stop_addresses jsonb;changed text[];new_driver uuid;journey_start timestamp;journey_end timestamp;
 stop jsonb;stop_number integer:=0;state text;terminal boolean;after_pickup boolean;financial_locked boolean;fare_changed boolean;
 driver_changed boolean;operational_changed boolean;fare_result jsonb;audit_id uuid;
begin
 if not public.release73_admin(target_company_id) then raise exception 'Only a company Owner or Administrator can correct bookings' using errcode='42501';end if;
 if requested_changes is null or jsonb_typeof(requested_changes)<>'object' then raise exception 'Invalid booking changes';end if;
 if requested_stops is null or jsonb_typeof(requested_stops)<>'array' then raise exception 'Invalid booking stops';end if;
 if length(trim(coalesce(override_reason,'')))<5 then raise exception 'A meaningful correction reason is required';end if;
 select * into old_row from bookings where id=target_booking_id and company_id=target_company_id for update;
 if not found then raise exception 'Booking not found for this company' using errcode='P0002';end if;
 if old_row.edit_version<>coalesce(expected_edit_version,0) then raise exception 'Booking edit conflict: reload the latest booking';end if;
 state:=lower(coalesce(old_row.status,old_row.booking_status,''));terminal:=state in('completed','cancelled','canceled','no_show','archived');
 after_pickup:=state in('passenger_onboard','completed') or old_row.passenger_onboard_at is not null;
 financial_locked:=coalesce(old_row.amount_paid,0)>0 or old_row.invoice_id is not null or exists(select 1 from invoice_items i where i.company_id=target_company_id and i.booking_id=target_booking_id);
 if nullif(trim(requested_changes->>'customer_name'),'') is null then raise exception 'Customer name is required';end if;
 if nullif(trim(requested_changes->>'pickup_address'),'') is null or nullif(trim(requested_changes->>'dropoff_address'),'') is null then raise exception 'Pickup and destination are required';end if;
 if coalesce((requested_changes->>'passengers')::integer,0) not between 1 and 52 then raise exception 'Passengers must be between 1 and 52';end if;
 if coalesce((requested_changes->>'suitcases')::integer,0) not between 0 and 100 or coalesce((requested_changes->>'hand_luggage')::integer,0) not between 0 and 100 then raise exception 'Invalid luggage quantity';end if;
 if coalesce((requested_changes->>'price')::numeric,-1)<0 then raise exception 'Price must not be negative';end if;
 new_driver:=nullif(requested_changes->>'driver_id','')::uuid;driver_changed:=new_driver is distinct from old_row.driver_id;
 fare_changed:=round((requested_changes->>'price')::numeric,2) is distinct from round(coalesce(old_row.price,old_row.job_price,0)::numeric,2);
 select coalesce(jsonb_agg(to_jsonb(s)-'id'-'company_id'-'booking_id'-'created_at' order by s.stop_order),'[]'::jsonb),coalesce(jsonb_agg(to_jsonb(s.formatted_address) order by s.stop_order),'[]'::jsonb) into old_stops,old_stop_addresses from booking_stops s where s.booking_id=target_booking_id and s.company_id=target_company_id;
 select coalesce(jsonb_agg(to_jsonb(value->>'formatted_address')),'[]'::jsonb) into new_stop_addresses from jsonb_array_elements(requested_stops);
 if terminal and (
   trim(requested_changes->>'pickup_address') is distinct from old_row.pickup_address or trim(requested_changes->>'dropoff_address') is distinct from old_row.dropoff_address or
   (requested_changes->>'journey_date')::date is distinct from old_row.journey_date or (requested_changes->>'journey_time')::time is distinct from old_row.journey_time or
   new_stop_addresses is distinct from old_stop_addresses or driver_changed or coalesce((requested_changes->>'return_journey')::boolean,false) is distinct from coalesce(old_row.return_journey,false) or
   nullif(requested_changes->>'return_date','')::date is distinct from old_row.return_date or nullif(requested_changes->>'return_time','')::time is distinct from old_row.return_time
 ) then raise exception 'Completed or closed journey history cannot change route, schedule, stops or driver; passenger details, notes and audited fare corrections remain available';end if;
 if after_pickup and driver_changed then raise exception 'The assigned driver cannot be replaced after passenger pickup';end if;
 if after_pickup and trim(requested_changes->>'pickup_address') is distinct from old_row.pickup_address then raise exception 'The historical pickup cannot be changed after passenger pickup';end if;
 if requested_changes->>'driver_amount' is not null and nullif(requested_changes->>'driver_amount','')::numeric is distinct from old_row.driver_amount then raise exception 'Driver earnings cannot be changed in a booking correction; use the authorised driver payment workflow';end if;
 if (case when lower(coalesce(old_row.payment_method,'')) like '%account%' or lower(coalesce(old_row.payment_method,'')) like '%invoice%' then 'account' when lower(coalesce(old_row.payment_method,'')) like '%card%' or lower(coalesce(old_row.payment_method,'')) like '%prepaid%' or lower(coalesce(old_row.payment_method,'')) like '%pay now%' then 'card' else 'cash' end) is distinct from requested_changes->>'payment_method' or nullif(requested_changes->>'account_customer_id','')::uuid is distinct from old_row.account_customer_id or nullif(trim(requested_changes->>'account_po_reference'),'') is distinct from old_row.account_po_reference then raise exception 'Payment method, account association and PO changes require the separate financial correction workflow';end if;
 if coalesce((requested_changes->>'return_journey')::boolean,false) and (nullif(requested_changes->>'return_date','') is null or nullif(requested_changes->>'return_time','') is null) then raise exception 'Return date and time are required';end if;
 journey_start:=(requested_changes->>'journey_date')::date+(requested_changes->>'journey_time')::time;journey_end:=journey_start+make_interval(mins=>greatest(30,coalesce((requested_changes->>'route_duration_minutes')::integer,60)));
 if new_driver is not null and driver_changed then
  if not exists(select 1 from drivers where id=new_driver and company_id=target_company_id and lower(coalesce(status,'active')) not in('inactive','disabled')) then raise exception 'Driver is not available to this company';end if;
  if exists(select 1 from driver_unavailability where company_id=target_company_id and driver_id=new_driver and active=true and from_datetime<journey_end and to_datetime>journey_start) then raise exception 'Driver is unavailable for this journey';end if;
  if exists(select 1 from bookings b where b.company_id=target_company_id and b.driver_id=new_driver and b.id<>target_booking_id and lower(coalesce(b.status,b.booking_status,'')) not in('completed','cancelled','canceled','no_show') and (b.journey_date+b.journey_time::time)<journey_end and (b.journey_date+b.journey_time::time+make_interval(mins=>greatest(30,coalesce(b.route_duration_minutes,60))))>journey_start) then raise exception 'Driver already has an overlapping booking';end if;
 end if;
 old_values:=jsonb_build_object('customer_name',old_row.customer_name,'customer_email',old_row.customer_email,'customer_phone',old_row.customer_phone,'pickup_address',old_row.pickup_address,'dropoff_address',old_row.dropoff_address,'journey_date',old_row.journey_date,'journey_time',old_row.journey_time,'passengers',old_row.passengers,'suitcases',old_row.suitcases,'hand_luggage',old_row.hand_luggage,'flight_number',old_row.flight_number,'notes',old_row.notes,'price',coalesce(old_row.price,old_row.job_price),'driver_id',old_row.driver_id,'driver_amount',old_row.driver_amount,'payment_method',old_row.payment_method,'account_customer_id',old_row.account_customer_id,'account_po_reference',old_row.account_po_reference,'stops',old_stops);
 perform set_config('app.admin_booking_correction','true',true);
 update bookings set
  customer_name=trim(requested_changes->>'customer_name'),customer_email=nullif(trim(requested_changes->>'customer_email'),''),customer_phone=nullif(trim(requested_changes->>'customer_phone'),''),
  pickup_address=trim(requested_changes->>'pickup_address'),pickup_name=nullif(trim(requested_changes->>'pickup_name'),''),pickup_postcode=nullif(requested_changes->>'pickup_postcode',''),pickup_place_id=nullif(requested_changes->>'pickup_place_id',''),pickup_lat=nullif(requested_changes->>'pickup_lat','')::numeric,pickup_lng=nullif(requested_changes->>'pickup_lng','')::numeric,
  dropoff_address=trim(requested_changes->>'dropoff_address'),dropoff_name=nullif(trim(requested_changes->>'dropoff_name'),''),dropoff_postcode=nullif(requested_changes->>'dropoff_postcode',''),dropoff_place_id=nullif(requested_changes->>'dropoff_place_id',''),dropoff_lat=nullif(requested_changes->>'dropoff_lat','')::numeric,dropoff_lng=nullif(requested_changes->>'dropoff_lng','')::numeric,
  journey_date=(requested_changes->>'journey_date')::date,journey_time=(requested_changes->>'journey_time')::time,
  return_journey=coalesce((requested_changes->>'return_journey')::boolean,false),return_date=case when coalesce((requested_changes->>'return_journey')::boolean,false) then (requested_changes->>'return_date')::date else null end,return_time=case when coalesce((requested_changes->>'return_journey')::boolean,false) then (requested_changes->>'return_time')::time else null end,
  passengers=(requested_changes->>'passengers')::integer,suitcases=coalesce((requested_changes->>'suitcases')::integer,0),hand_luggage=coalesce((requested_changes->>'hand_luggage')::integer,0),flight_number=nullif(trim(requested_changes->>'flight_number'),''),notes=nullif(trim(requested_changes->>'notes'),''),
  driver_id=new_driver,dispatched_at=case when driver_changed then case when new_driver is null then null else now() end else old_row.dispatched_at end,
  status=case when driver_changed and new_driver is null and state='assigned' then 'waiting' when driver_changed and new_driver is not null and state in('','pending','waiting') then 'assigned' else old_row.status end,
  route_distance_miles=nullif(requested_changes->>'route_distance_miles','')::numeric,route_duration_minutes=nullif(requested_changes->>'route_duration_minutes','')::integer,pricing_method=nullif(trim(requested_changes->>'pricing_method'),''),edit_version=old_row.edit_version+1
 where id=target_booking_id and company_id=target_company_id returning * into new_row;
 delete from booking_stops where booking_id=target_booking_id and company_id=target_company_id;
 for stop in select value from jsonb_array_elements(requested_stops) loop stop_number:=stop_number+1;if nullif(trim(stop->>'formatted_address'),'') is null then raise exception 'A stop address is required';end if;insert into booking_stops(company_id,booking_id,stop_order,label,address_name,formatted_address,postcode,latitude,longitude,place_id) values(target_company_id,target_booking_id,stop_number,coalesce(nullif(trim(stop->>'label'),''),'Via'),nullif(trim(stop->>'address_name'),''),trim(stop->>'formatted_address'),nullif(stop->>'postcode',''),nullif(stop->>'latitude','')::numeric,nullif(stop->>'longitude','')::numeric,nullif(stop->>'place_id',''));end loop;
 if fare_changed then fare_result:=public.adjust_booking_fare(target_company_id,target_booking_id,(requested_changes->>'price')::numeric,override_reason);end if;
 select * into new_row from bookings where id=target_booking_id and company_id=target_company_id;
 select coalesce(jsonb_agg(to_jsonb(s)-'id'-'company_id'-'booking_id'-'created_at' order by s.stop_order),'[]'::jsonb) into new_stops from booking_stops s where s.booking_id=target_booking_id and s.company_id=target_company_id;
 new_values:=jsonb_build_object('customer_name',new_row.customer_name,'customer_email',new_row.customer_email,'customer_phone',new_row.customer_phone,'pickup_address',new_row.pickup_address,'dropoff_address',new_row.dropoff_address,'journey_date',new_row.journey_date,'journey_time',new_row.journey_time,'passengers',new_row.passengers,'suitcases',new_row.suitcases,'hand_luggage',new_row.hand_luggage,'flight_number',new_row.flight_number,'notes',new_row.notes,'price',coalesce(new_row.price,new_row.job_price),'driver_id',new_row.driver_id,'driver_amount',new_row.driver_amount,'payment_method',new_row.payment_method,'account_customer_id',new_row.account_customer_id,'account_po_reference',new_row.account_po_reference,'stops',new_stops);
 select array_agg(key order by key) into changed from jsonb_each(old_values) where value is distinct from new_values->key;changed:=coalesce(changed,array[]::text[]);
 if coalesce(array_length(changed,1),0)=0 then raise exception 'No booking changes were supplied';end if;
 operational_changed:=changed&&array['pickup_address','dropoff_address','journey_date','journey_time','passengers','suitcases','hand_luggage','flight_number','notes','driver_id','stops']::text[];
 insert into admin_booking_audit(company_id,booking_id,booking_reference,admin_user_id,changed_fields,previous_values,new_values,price_override_reason,change_reason) values(target_company_id,target_booking_id,old_row.booking_reference,auth.uid(),changed,old_values,new_values,case when fare_changed then trim(override_reason) end,trim(override_reason)) returning id into audit_id;
 return jsonb_build_object('id',new_row.id,'booking_reference',new_row.booking_reference,'edit_version',new_row.edit_version,'changed_fields',changed,'audit_id',audit_id,'notification_required',operational_changed and new_row.driver_id is not null and state in('accepted','on_way','arrived','passenger_onboard'),'driver_changed',driver_changed,'document_resolution_required',coalesce((fare_result->>'document_resolution_required')::boolean,false));
end$$;

revoke all on function public.admin_edit_booking(uuid,uuid,bigint,jsonb,jsonb,text) from public,anon;
grant execute on function public.admin_edit_booking(uuid,uuid,bigint,jsonb,jsonb,text) to authenticated;

create or replace function public.capture_outbound_booking_webhook() returns trigger language plpgsql security definer set search_path='' as $$
declare kind text;key1 text;
begin
 if coalesce(current_setting('app.admin_booking_correction',true),'')='true' then return new;end if;
 if tg_op='INSERT' then kind:='booking.created';key1:=new.id||':created';
 elsif new.status is distinct from old.status then kind:=case lower(new.status) when 'cancelled' then 'booking.cancelled' when 'canceled' then 'booking.cancelled' when 'arrived' then 'driver.arrived' when 'completed' then 'booking.completed' end;key1:=new.id||':'||coalesce(kind,'booking.updated')||':'||new.edit_version;
 elsif new.driver_id is distinct from old.driver_id and new.driver_id is not null then kind:='driver.assigned';key1:=new.id||':driver.assigned:'||new.driver_id;
 else kind:='booking.updated';key1:=new.id||':updated:'||new.edit_version;end if;kind:=coalesce(kind,'booking.updated');
 insert into public.outbound_webhook_events(company_id,event_type,aggregate_type,aggregate_id,event_key,payload) values(new.company_id,kind,'booking',new.id,key1,jsonb_build_object('booking_id',new.id,'booking_reference',new.booking_reference,'status',new.status,'driver_id',new.driver_id,'updated_at',now())) on conflict do nothing;
 insert into public.outbound_webhook_deliveries(company_id,endpoint_id,event_id) select new.company_id,e.id,w.id from public.outbound_webhook_endpoints e join public.outbound_webhook_events w on w.company_id=new.company_id and w.event_key=key1 where e.company_id=new.company_id and e.status='active' and kind=any(e.event_types) on conflict do nothing;return new;
exception when others then return new;end$$;

create or replace function public.capture_external_dispatch_journey() returns trigger language plpgsql security definer set search_path=public as $$
declare o external_dispatch_offers%rowtype;kind text;stamp timestamptz:=clock_timestamp();event_id uuid;dispatch_key text;
begin
 if coalesce(current_setting('app.admin_booking_correction',true),'')='true' then return new;end if;
 select * into o from external_dispatch_offers where receiving_booking_id=new.id;if not found then return new;end if;
 if new.driver_id is distinct from old.driver_id and new.driver_id is not null then kind:='driver.assigned';elsif new.status is distinct from old.status then kind:='journey.'||lower(new.status);else return new;end if;
 dispatch_key:='dispatch:'||o.id||':'||kind||':'||coalesce(new.driver_id::text,'none')||':'||coalesce(new.vehicle_id::text,'none')||':'||extract(epoch from stamp)::bigint;
 insert into external_dispatch_journey_events(offer_id,receiving_company_id,event_type,booking_reference,status,driver_id,vehicle_id,event_timestamp,idempotency_key) values(o.id,new.company_id,kind,new.booking_reference,lower(coalesce(new.status,'')),new.driver_id,new.vehicle_id,stamp,dispatch_key) returning id into event_id;
 update external_dispatch_offers set status=case when lower(new.status)='completed' then 'completed' when lower(new.status) in('on_way','arrived','passenger_onboard') then 'active' else status end,completed_at=case when lower(new.status)='completed' then stamp else completed_at end,updated_at=stamp where id=o.id;
 insert into outbound_webhook_events(company_id,event_type,aggregate_type,aggregate_id,event_key,payload) values(new.company_id,'dispatch.journey.updated','external_dispatch_offer',o.id,dispatch_key,jsonb_build_object('event_id',event_id,'offer_id',o.id,'external_booking_reference',o.external_booking_reference,'booking_reference',new.booking_reference,'status',new.status,'event_timestamp',stamp)) on conflict do nothing;
 insert into outbound_webhook_deliveries(company_id,endpoint_id,event_id) select new.company_id,e.id,w.id from outbound_webhook_endpoints e join outbound_webhook_events w on w.company_id=new.company_id and w.event_key=dispatch_key where e.integration_id=o.integration_id and e.status='active' and 'dispatch.journey.updated'=any(e.event_types) on conflict do nothing;return new;
end$$;

commit;
notify pgrst,'reload schema';
