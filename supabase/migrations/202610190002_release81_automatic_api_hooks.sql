begin;

alter table public.outbound_webhook_endpoints drop constraint if exists outbound_webhook_endpoints_event_types_check;
alter table public.outbound_webhook_endpoints add constraint outbound_webhook_endpoints_event_types_check check(event_types <@ array['booking.created','booking.offered','booking.viewed','booking.accepted','booking.declined','booking.returned','driver.assigned','driver.on_way','driver.arrived','passenger.on_board','booking.completed','booking.cancelled','booking.no_show','driver.position_updated','gps.position','booking.updated','dispatch.offer.accepted','dispatch.offer.declined','dispatch.journey.updated']::text[]);

alter table public.outbound_webhook_deliveries drop constraint if exists outbound_webhook_deliveries_state_check;
alter table public.outbound_webhook_deliveries add constraint outbound_webhook_deliveries_state_check check(state in('pending','processing','delivered','retry','failed','dead_letter','cancelled'));
alter table public.outbound_webhook_deliveries add column if not exists dead_lettered_at timestamptz;
alter table public.outbound_webhook_deliveries add column if not exists last_attempt_at timestamptz;

create table if not exists public.outbound_webhook_delivery_attempts(
 id bigint generated always as identity primary key,
 company_id uuid not null references public.companies(id),
 delivery_id uuid not null references public.outbound_webhook_deliveries(id) on delete cascade,
 attempt_number integer not null check(attempt_number between 1 and 8),
 request_id uuid not null default gen_random_uuid(),
 started_at timestamptz not null default now(),finished_at timestamptz,
 outcome text not null default 'started' check(outcome in('started','delivered','retry','failed','dead_letter','cancelled')),
 response_status integer,error_code text,duration_ms integer,
 unique(delivery_id,attempt_number)
);
create index if not exists outbound_webhook_attempts_recent on public.outbound_webhook_delivery_attempts(company_id,started_at desc);
alter table public.outbound_webhook_delivery_attempts enable row level security;
revoke all on public.outbound_webhook_delivery_attempts from public,anon,authenticated;
grant all on public.outbound_webhook_delivery_attempts to service_role;

create or replace function public.manual_retry_outbound_webhook(target_delivery_id uuid,target_actor uuid)
returns boolean language plpgsql security definer set search_path=public as $$
declare d outbound_webhook_deliveries%rowtype;
begin
 if auth.role()<>'service_role' then raise exception 'Service role required';end if;
 select * into d from outbound_webhook_deliveries where id=target_delivery_id for update;if not found then raise exception 'Delivery not found';end if;
 if d.state not in('failed','dead_letter','cancelled') then raise exception 'Only terminal deliveries can be retried manually';end if;
 if d.attempt_count>=8 then raise exception 'Maximum delivery attempts reached';end if;
 update outbound_webhook_deliveries set state='retry',next_attempt_at=now(),claimed_at=null,response_status=null,error_code=null,dead_lettered_at=null,last_error=null where id=d.id;
 insert into integration_activity(company_id,integration_id,integration_kind,action,outcome,actor_id,details) select d.company_id,e.integration_id,'outgoing_webhook','manual_retry','queued',target_actor,jsonb_build_object('delivery_id',d.id) from outbound_webhook_endpoints e where e.id=d.endpoint_id;
 return true;
end$$;
revoke all on function public.manual_retry_outbound_webhook(uuid,uuid) from public,anon,authenticated;
grant execute on function public.manual_retry_outbound_webhook(uuid,uuid) to service_role;

create or replace function public.release81_queue_external_event(o public.external_dispatch_offers,event_name text,event_stamp timestamptz,event_key text,event_payload jsonb)
returns void language plpgsql security definer set search_path=public as $$
declare webhook_event_id uuid;
begin
 insert into outbound_webhook_events(company_id,event_type,aggregate_type,aggregate_id,event_key,payload,created_at)
 values(o.receiving_company_id,event_name,'external_dispatch_offer',o.id,event_key,event_payload,event_stamp)
 on conflict(company_id,event_key) do update set payload=excluded.payload returning id into webhook_event_id;
 insert into outbound_webhook_deliveries(company_id,endpoint_id,event_id)
 select o.receiving_company_id,e.id,webhook_event_id from outbound_webhook_endpoints e
 where e.integration_id=o.integration_id and e.company_id=o.receiving_company_id and e.status='active' and event_name=any(e.event_types) on conflict do nothing;
end$$;

create or replace function public.capture_external_offer_lifecycle() returns trigger language plpgsql security definer set search_path=public as $$
declare event_name text;stamp timestamptz;event_key text;
begin
 if tg_op='INSERT' then event_name:='booking.offered';stamp:=coalesce(new.offered_at,new.created_at,clock_timestamp());
 elsif new.status is not distinct from old.status then return new;
 else event_name:=case new.status when 'viewed' then 'booking.viewed' when 'accepted' then 'booking.accepted' when 'declined' then 'booking.declined' when 'returned' then 'booking.returned' when 'completed' then 'booking.completed' when 'cancelled' then 'booking.cancelled' else null end;
 stamp:=case new.status when 'viewed' then new.viewed_at when 'accepted' then new.accepted_at when 'declined' then new.declined_at when 'returned' then new.returned_at when 'completed' then new.completed_at else new.updated_at end;
 end if;
 if event_name is null then return new;end if;stamp:=coalesce(stamp,clock_timestamp());event_key:='release81:'||new.id||':'||event_name;
 perform release81_queue_external_event(new,event_name,stamp,event_key,jsonb_build_object('offer_id',new.id,'external_booking_reference',new.external_booking_reference,'booking_reference',new.receiving_booking_reference,'status',new.status,'event_timestamp',stamp,'return_reason',new.return_reason,'reallocation_required',new.reallocation_required));
 insert into external_dispatch_journey_events(offer_id,receiving_company_id,event_type,booking_reference,status,event_timestamp,idempotency_key) values(new.id,new.receiving_company_id,event_name,coalesce(new.receiving_booking_reference,new.external_booking_reference),new.status,stamp,event_key) on conflict(idempotency_key) do nothing;
 return new;
end$$;
drop trigger if exists release81_external_offer_lifecycle on public.external_dispatch_offers;
create trigger release81_external_offer_lifecycle after insert or update of status on public.external_dispatch_offers for each row execute function public.capture_external_offer_lifecycle();

create or replace function public.capture_external_dispatch_journey() returns trigger language plpgsql security definer set search_path=public as $$
declare o external_dispatch_offers%rowtype;event_name text;stamp timestamptz;event_key text;driver_data jsonb;vehicle_data jsonb;timeline_id uuid;
begin
 select * into o from external_dispatch_offers where receiving_booking_id=new.id;if not found then return new;end if;
 if new.driver_id is distinct from old.driver_id and new.driver_id is not null then event_name:='driver.assigned';stamp:=coalesce(new.dispatched_at,clock_timestamp());
 elsif new.status is distinct from old.status then event_name:=case lower(new.status) when 'on_way' then 'driver.on_way' when 'arrived' then 'driver.arrived' when 'passenger_onboard' then 'passenger.on_board' when 'completed' then 'booking.completed' when 'cancelled' then 'booking.cancelled' when 'canceled' then 'booking.cancelled' when 'no_show' then 'booking.no_show' else null end;stamp:=case lower(new.status) when 'on_way' then new.on_way_at when 'arrived' then new.arrived_at when 'passenger_onboard' then new.passenger_onboard_at when 'completed' then new.completed_at when 'cancelled' then new.cancelled_at when 'canceled' then new.cancelled_at when 'no_show' then new.no_show_at else null end;
 else return new;end if;
 if event_name is null then return new;end if;stamp:=coalesce(stamp,clock_timestamp());event_key:='release81:'||o.id||':'||event_name||':'||extract(epoch from stamp)::bigint;
 select jsonb_build_object('name',d.full_name,'reference',d.driver_number,'phone',case when d.provider_phone_sharing then d.public_contact_phone else null end) into driver_data from drivers d where d.id=new.driver_id and d.company_id=new.company_id;
 select jsonb_build_object('registration',v.registration,'make',v.make,'model',v.model,'colour',v.colour,'passenger_capacity',v.passenger_seats,'vehicle_type',v.vehicle_type) into vehicle_data from vehicles v where v.id=new.vehicle_id and v.company_id=new.company_id;
 insert into external_dispatch_journey_events(offer_id,receiving_company_id,event_type,booking_reference,status,driver_id,vehicle_id,event_timestamp,idempotency_key) values(o.id,new.company_id,event_name,new.booking_reference,lower(coalesce(new.status,'')),new.driver_id,new.vehicle_id,stamp,event_key) on conflict(idempotency_key) do nothing returning id into timeline_id;
 perform release81_queue_external_event(o,event_name,stamp,event_key,jsonb_build_object('event_id',timeline_id,'offer_id',o.id,'external_booking_reference',o.external_booking_reference,'booking_reference',new.booking_reference,'status',new.status,'event_timestamp',stamp,'driver',driver_data,'vehicle',vehicle_data,'pickup_at',new.arrived_at,'passenger_on_board_at',new.passenger_onboard_at,'completed_at',new.completed_at));
 update external_dispatch_offers set status=case when lower(new.status)='completed' then 'completed' when lower(new.status) in('on_way','arrived','passenger_onboard') then 'active' when lower(new.status) in('cancelled','canceled') then 'cancelled' else status end,completed_at=case when lower(new.status)='completed' then stamp else completed_at end,updated_at=stamp where id=o.id;
 return new;
end$$;

create or replace function public.capture_external_driver_position() returns trigger language plpgsql security definer set search_path=public as $$
declare o external_dispatch_offers%rowtype;event_key text;event_stamp timestamptz:=coalesce(new.recorded_at,clock_timestamp());
begin
 select o.* into o from external_dispatch_offers o where o.receiving_booking_id=new.booking_id and o.receiving_company_id=new.company_id and o.status in('accepted','active') limit 1;if not found then return new;end if;
 event_key:='release81:'||o.id||':driver.position_updated:'||new.id;
 insert into outbound_webhook_events(company_id,event_type,aggregate_type,aggregate_id,event_key,payload,created_at) select new.company_id,'driver.position_updated','external_dispatch_offer',o.id,event_key,jsonb_build_object('offer_id',o.id,'external_booking_reference',o.external_booking_reference,'booking_reference',(select booking_reference from bookings where id=new.booking_id),'event_timestamp',event_stamp,'position',jsonb_build_object('latitude',new.latitude,'longitude',new.longitude,'accuracy_metres',new.accuracy_metres)),event_stamp where exists(select 1 from outbound_webhook_endpoints e where e.integration_id=o.integration_id and e.status='active' and e.gps_authorised and 'driver.position_updated'=any(e.event_types)) on conflict do nothing;
 insert into outbound_webhook_deliveries(company_id,endpoint_id,event_id) select new.company_id,e.id,w.id from outbound_webhook_endpoints e join outbound_webhook_events w on w.company_id=new.company_id and w.event_key=event_key where e.integration_id=o.integration_id and e.status='active' and e.gps_authorised and 'driver.position_updated'=any(e.event_types) on conflict do nothing;
 return new;
end$$;
drop trigger if exists release81_external_driver_position on public.driver_gps_points;
create trigger release81_external_driver_position after insert on public.driver_gps_points for each row execute function public.capture_external_driver_position();

revoke all on function public.release81_queue_external_event(public.external_dispatch_offers,text,timestamptz,text,jsonb),public.capture_external_offer_lifecycle(),public.capture_external_dispatch_journey(),public.capture_external_driver_position() from public,anon,authenticated;
notify pgrst,'reload schema';
commit;
