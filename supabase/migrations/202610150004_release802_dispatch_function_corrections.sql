-- Release 8.0.2 reviewed function corrections: atomic return legs and unambiguous event key.
begin;
create or replace function public.accept_external_dispatch_offer(target_offer uuid,target_company uuid,target_actor uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare o public.external_dispatch_offers%rowtype;p jsonb;ret jsonb;rows jsonb;ref text;bid uuid:=gen_random_uuid();rid uuid:=gen_random_uuid();result jsonb;
begin
 if auth.role()<>'service_role' then raise exception 'Service role required';end if;
 select * into o from external_dispatch_offers where id=target_offer for update;if not found or o.receiving_company_id<>target_company then raise exception 'Offer not found';end if;
 if o.receiving_booking_id is not null and o.status in('accepted','active','completed') then return jsonb_build_object('offer_id',o.id,'booking_id',o.receiving_booking_id,'status',o.status,'duplicate',true);end if;
 if o.status not in('offered','viewed') or o.expires_at<=now() then raise exception 'Offer cannot be accepted';end if;
 p:=o.booking_payload;ret:=p->'return_journey';ref:=public.next_company_booking_reference(o.receiving_company_id);
 rows:=jsonb_build_array(jsonb_build_object('id',bid,'booking_reference',ref,'customer_name',p->>'customer_name','customer_phone',p->>'customer_phone','customer_email',nullif(p->>'customer_email',''),'journey_date',p->>'journey_date','journey_time',p->>'journey_time','pickup_address',p->>'pickup_address','dropoff_address',p->>'dropoff_address','passengers',greatest(1,least(80,coalesce((p->>'passengers')::integer,1))),'luggage',p->>'luggage','flight_number',p->>'flight_number','vehicle_type',p->>'vehicle_type','notes',p->>'notes','status','waiting','booking_status','waiting','booking_source','external_dispatch','price',case when o.payment_responsibility='receiver_collects' then o.customer_fare else 0 end,'amount_paid',0,'balance_due',case when o.payment_responsibility='receiver_collects' then o.customer_fare else 0 end,'payment_status','unpaid','payment_type',case when o.payment_responsibility='receiver_collects' then 'integration' else 'account' end,'driver_amount',0,'creation_idempotency_key','dispatch_'||o.id));
 if ret is not null and jsonb_typeof(ret)='object' then
   if coalesce(ret->>'journey_date','')!~'^\d{4}-\d{2}-\d{2}$' or coalesce(ret->>'journey_time','')!~'^\d{2}:\d{2}' then raise exception 'Valid return journey date and time are required';end if;
   rows:=rows||jsonb_build_array(jsonb_build_object('id',rid,'booking_reference',ref||'-R','customer_name',p->>'customer_name','customer_phone',p->>'customer_phone','customer_email',nullif(p->>'customer_email',''),'journey_date',ret->>'journey_date','journey_time',ret->>'journey_time','pickup_address',p->>'dropoff_address','dropoff_address',p->>'pickup_address','passengers',greatest(1,least(80,coalesce((p->>'passengers')::integer,1))),'luggage',p->>'luggage','flight_number',ret->>'flight_number','vehicle_type',p->>'vehicle_type','notes',p->>'notes','status','waiting','booking_status','waiting','booking_source','external_dispatch','price',0,'amount_paid',0,'balance_due',0,'payment_status','unpaid','payment_type',case when o.payment_responsibility='receiver_collects' then 'integration' else 'account' end,'driver_amount',0,'creation_idempotency_key','dispatch_'||o.id||'_return'));
 end if;
 result:=public.create_booking_bundle(o.receiving_company_id,rows,coalesce(p->'stops','[]'::jsonb),null,'dispatch_'||replace(o.id::text,'-',''));
 update external_dispatch_offers set status='accepted',receiving_booking_id=bid,receiving_booking_reference=ref,accepted_at=clock_timestamp(),updated_at=clock_timestamp() where id=o.id;
 insert into external_dispatch_journey_events(offer_id,receiving_company_id,event_type,booking_reference,status,event_timestamp,idempotency_key) values(o.id,o.receiving_company_id,'offer.accepted',ref,'accepted',clock_timestamp(),'dispatch:'||o.id||':accepted') on conflict do nothing;
 return jsonb_build_object('offer_id',o.id,'booking_id',bid,'booking_reference',ref,'return_booking_id',case when ret is not null then rid else null end,'status','accepted','duplicate',false);
end $$;
create or replace function public.capture_external_dispatch_journey() returns trigger language plpgsql security definer set search_path=public as $$
declare o public.external_dispatch_offers%rowtype;kind text;stamp timestamptz:=clock_timestamp();event_id uuid;dispatch_key text;
begin
 select * into o from external_dispatch_offers where receiving_booking_id=new.id;if not found then return new;end if;
 if new.driver_id is distinct from old.driver_id and new.driver_id is not null then kind:='driver.assigned';elsif new.status is distinct from old.status then kind:='journey.'||lower(new.status);else return new;end if;
 dispatch_key:='dispatch:'||o.id||':'||kind||':'||coalesce(new.driver_id::text,'none')||':'||coalesce(new.vehicle_id::text,'none')||':'||extract(epoch from stamp)::bigint;
 insert into external_dispatch_journey_events(offer_id,receiving_company_id,event_type,booking_reference,status,driver_id,vehicle_id,event_timestamp,idempotency_key) values(o.id,new.company_id,kind,new.booking_reference,lower(coalesce(new.status,'')),new.driver_id,new.vehicle_id,stamp,dispatch_key) returning id into event_id;
 update external_dispatch_offers set status=case when lower(new.status)='completed' then 'completed' when lower(new.status) in('on_way','arrived','passenger_onboard') then 'active' else status end,completed_at=case when lower(new.status)='completed' then stamp else completed_at end,updated_at=stamp where id=o.id;
 insert into outbound_webhook_events(company_id,event_type,aggregate_type,aggregate_id,event_key,payload) values(new.company_id,'dispatch.journey.updated','external_dispatch_offer',o.id,dispatch_key,jsonb_build_object('event_id',event_id,'offer_id',o.id,'external_booking_reference',o.external_booking_reference,'booking_reference',new.booking_reference,'status',new.status,'event_timestamp',stamp)) on conflict do nothing;
 insert into outbound_webhook_deliveries(company_id,endpoint_id,event_id) select new.company_id,e.id,w.id from outbound_webhook_endpoints e join outbound_webhook_events w on w.company_id=new.company_id and w.event_key=dispatch_key where e.integration_id=o.integration_id and e.status='active' and 'dispatch.journey.updated'=any(e.event_types) on conflict do nothing;
 return new;
end $$;
notify pgrst,'reload schema';commit;
