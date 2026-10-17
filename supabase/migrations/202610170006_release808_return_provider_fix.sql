-- Release 8.0.8: narrowly-authorised external return transition and clear validation.
begin;

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
  return_offer text := coalesce(current_setting('app.external_dispatch_return_offer',true),'');
  authorised_external_return boolean := false;
begin
  if old_status = new_status then return new; end if;
  new.booking_status:=new.status;

  if new_status='returned_to_provider'
     and auth.role()='service_role'
     and return_offer ~* '^[0-9a-f-]{36}$'
     and old_status in ('','pending','waiting','assigned','accepted','on_way','arrived')
     and new.passenger_onboard_at is null
     and new.driver_id is null
     and new.vehicle_id is null then
    select exists(
      select 1 from public.external_dispatch_offers o
      where o.id=return_offer::uuid
        and o.receiving_booking_id=new.id
        and o.receiving_company_id=new.company_id
        and o.status in ('accepted','active')
    ) into authorised_external_return;
  end if;

  if new.driver_id is not null then
    perform pg_advisory_xact_lock(hashtextextended(new.company_id::text||':'||new.driver_id::text,0));
  end if;

  if not authorised_external_return and not (
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

create or replace function public.return_external_dispatch_to_provider(target_offer uuid,target_company uuid,target_actor uuid,target_reason text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare o external_dispatch_offers%rowtype;b bookings%rowtype;stamp timestamptz:=clock_timestamp();webhook_key text;voided numeric(12,2);requires_resolution boolean;
begin
 if auth.role()<>'service_role' then raise exception 'Service role required';end if;
 if length(trim(coalesce(target_reason,'')))<3 then raise exception 'A return reason is required';end if;
 select * into o from external_dispatch_offers where id=target_offer and receiving_company_id=target_company for update;
 if not found then raise exception 'External offer not found for this company';end if;
 if o.status='returned' then raise exception 'This external offer has already been returned';end if;
 if o.status not in('accepted','active') or o.receiving_booking_id is null then raise exception 'Only an accepted external offer can be returned';end if;
 select * into b from bookings where id=o.receiving_booking_id and company_id=target_company for update;
 if not found then raise exception 'Receiving booking not found';end if;
 if lower(coalesce(b.status,b.booking_status,'')) in('passenger_onboard','pob','completed','dropped_off') or b.passenger_onboard_at is not null then raise exception 'This booking cannot be returned after passenger pickup; use the incident and handover process';end if;
 requires_resolution:=coalesce(o.supplier_amount_paid,0)>0;
 voided:=case when requires_resolution then 0 else greatest(coalesce(o.supplier_payment,0)-coalesce(o.supplier_amount_paid,0),0) end;
 perform set_config('app.external_dispatch_return_offer',o.id::text,true);
 update bookings set status='returned_to_provider',booking_status='returned_to_provider',driver_id=null,vehicle_id=null where id=b.id and company_id=target_company;
 update external_dispatch_offers set status='returned',returned_at=stamp,return_reason=left(trim(target_reason),500),return_actor_id=target_actor,reallocation_required=true,
  supplier_obligation_voided=voided,supplier_obligation_voided_at=case when voided>0 then stamp else null end,
  supplier_settlement_status=case when voided>0 then 'not_applicable' when requires_resolution then 'disputed' else supplier_settlement_status end,
  financial_resolution_required=requires_resolution,updated_at=stamp where id=o.id;
 insert into external_dispatch_financial_events(offer_id,originating_company_id,receiving_company_id,event_type,amount,reason,actor_id)
 values(o.id,o.originating_company_id,o.receiving_company_id,case when requires_resolution then 'financial_resolution_required' else 'supplier_obligation_voided' end,case when requires_resolution then coalesce(o.supplier_amount_paid,0) else voided end,left(trim(target_reason),500),target_actor);
 webhook_key:='dispatch:'||o.id||':returned';
 insert into external_dispatch_journey_events(offer_id,receiving_company_id,event_type,booking_reference,status,event_timestamp,idempotency_key) values(o.id,target_company,'booking.returned',b.booking_reference,'returned',stamp,webhook_key) on conflict(idempotency_key) do nothing;
 insert into outbound_webhook_events(company_id,event_type,aggregate_type,aggregate_id,event_key,payload) values(target_company,'booking.returned','external_dispatch_offer',o.id,webhook_key,jsonb_build_object('offer_id',o.id,'external_booking_reference',o.external_booking_reference,'booking_reference',b.booking_reference,'status','returned','reason',left(trim(target_reason),500),'event_timestamp',stamp,'reallocation_required',true,'financial_resolution_required',requires_resolution,'supplier_obligation_voided',voided)) on conflict(company_id,event_key) do nothing;
 insert into outbound_webhook_deliveries(company_id,endpoint_id,event_id) select target_company,e.id,w.id from outbound_webhook_endpoints e join outbound_webhook_events w on w.company_id=target_company and w.event_key=webhook_key where e.integration_id=o.integration_id and e.status='active' and 'booking.returned'=any(e.event_types) on conflict(endpoint_id,event_id) do nothing;
 return jsonb_build_object('offer_id',o.id,'booking_id',b.id,'status','returned','message','Booking returned to the provider for deliberate reallocation','reallocation_required',true,'returned_at',stamp,'supplier_obligation_voided',voided,'financial_resolution_required',requires_resolution);
end$$;

revoke all on function public.return_external_dispatch_to_provider(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.return_external_dispatch_to_provider(uuid,uuid,uuid,text) to service_role;

commit;
notify pgrst,'reload schema';
