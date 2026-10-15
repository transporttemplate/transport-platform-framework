-- Release 8.0.2: dormant external dispatch, tracking and driver privacy controls.
begin;

alter table public.api_integrations add column if not exists integration_type text not null default 'general' check(integration_type in('general','external_dispatch'));
alter table public.api_integrations add column if not exists partner_company_id uuid references public.companies(id);
alter table public.api_integrations drop constraint if exists api_integrations_scopes_check;
alter table public.api_integrations add constraint api_integrations_scopes_check check(scopes <@ array['bookings:read','bookings:create','bookings.status:write','drivers.availability:read','vehicles:read','webhooks:manage','dispatch.offers:write','dispatch.offers:read','dispatch.tracking:read']::text[]);
alter table public.outbound_webhook_endpoints drop constraint if exists outbound_webhook_endpoints_event_types_check;
alter table public.outbound_webhook_endpoints add constraint outbound_webhook_endpoints_event_types_check check(event_types <@ array['booking.created','booking.updated','booking.cancelled','driver.assigned','driver.arrived','booking.completed','dispatch.offer.accepted','dispatch.offer.declined','dispatch.journey.updated']::text[]);

create table public.external_dispatch_offers(
 id uuid primary key default gen_random_uuid(), integration_id uuid not null references public.api_integrations(id),
 originating_company_id uuid not null references public.companies(id), receiving_company_id uuid not null references public.companies(id),
 external_request_id text not null check(length(external_request_id) between 16 and 100), external_booking_reference text not null,
 receiving_booking_id uuid references public.bookings(id), receiving_booking_reference text,
 status text not null default 'offered' check(status in('offered','viewed','accepted','declined','expired','withdrawn','active','completed','cancelled')),
 booking_payload jsonb not null, payment_responsibility text not null check(payment_responsibility in('sender_collects','receiver_collects','sender_account')),
 customer_fare numeric(12,2) not null default 0 check(customer_fare>=0), customer_payment_status text not null default 'unpaid' check(customer_payment_status in('unpaid','partial','paid','not_applicable')),
 supplier_payment numeric(12,2) not null default 0 check(supplier_payment>=0), supplier_settlement_status text not null default 'unpaid' check(supplier_settlement_status in('unpaid','partial','paid','disputed','not_applicable')),
 offered_at timestamptz not null default now(), expires_at timestamptz not null, viewed_at timestamptz, accepted_at timestamptz, declined_at timestamptz, completed_at timestamptz,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(integration_id,external_request_id), check(originating_company_id<>receiving_company_id)
);
create index external_dispatch_receiver_recent on public.external_dispatch_offers(receiving_company_id,created_at desc,id desc);
create index external_dispatch_origin_recent on public.external_dispatch_offers(originating_company_id,created_at desc,id desc);

create table public.external_dispatch_journey_events(
 id uuid primary key default gen_random_uuid(), offer_id uuid not null references public.external_dispatch_offers(id) on delete cascade,
 receiving_company_id uuid not null references public.companies(id), event_type text not null, booking_reference text not null,
 status text not null, driver_id uuid, vehicle_id uuid, event_timestamp timestamptz not null default clock_timestamp(),
 idempotency_key text not null unique, created_at timestamptz not null default now()
);
create index external_dispatch_timeline on public.external_dispatch_journey_events(offer_id,event_timestamp,id);

create table public.booking_tracking_tokens(
 id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id), booking_id uuid not null references public.bookings(id) on delete cascade,
 offer_id uuid references public.external_dispatch_offers(id) on delete cascade, token_hash text not null unique check(token_hash~'^[a-f0-9]{64}$'),
 expires_at timestamptz not null, revoked_at timestamptz, created_at timestamptz not null default now(), last_accessed_at timestamptz,
 check(expires_at>created_at)
);

create table public.driver_privacy_notices(
 company_id uuid primary key references public.companies(id) on delete cascade, version integer not null default 1 check(version>0),
 notice_text text not null check(length(notice_text)>=300), privacy_contact text not null check(length(trim(privacy_contact))>=3),
 updated_by uuid references auth.users(id), updated_at timestamptz not null default now()
);
create table public.driver_privacy_acknowledgements(
 company_id uuid not null references public.companies(id), driver_id uuid not null, notice_version integer not null,
 acknowledged_at timestamptz not null default now(), session_id uuid, metadata jsonb not null default '{}',
 primary key(company_id,driver_id,notice_version), foreign key(driver_id,company_id) references public.drivers(id,company_id)
);
create table public.driver_privacy_audit(
 id bigint generated always as identity primary key, company_id uuid not null references public.companies(id), driver_id uuid not null,
 action text not null, details jsonb not null default '{}', created_at timestamptz not null default now(),
 foreign key(driver_id,company_id) references public.drivers(id,company_id)
);
alter table public.drivers add column if not exists provider_phone_sharing boolean not null default false;
alter table public.drivers add column if not exists passenger_phone_sharing boolean not null default false;
update public.drivers set passenger_phone_sharing=coalesce(customer_phone_sharing,false) where passenger_phone_sharing=false;

insert into public.driver_privacy_notices(company_id,notice_text,privacy_contact)
select c.id,'Your company shares your driver name and number, assigned vehicle details, booking-specific journey statuses and authoritative timestamps with authorised booking providers only when needed to fulfil an assigned journey. Optional phone sharing with providers and passengers is controlled separately by you and is off by default. Work-related GPS may be recorded only while you are online and actively completing an assigned journey. Tracking starts for an active journey and stops after its permitted period. Records are retained according to company settings and may be accessed only by authorised company staff, the assigned booking provider, and support personnel with a legitimate operational need. You can change optional sharing choices in Driver Portal Settings at any time. Contact the company privacy contact for access, correction, retention, or privacy questions.',coalesce(nullif(c.email,''),nullif(c.phone,''),'Company office')
from public.companies c on conflict do nothing;

insert into public.sms_templates(company_id,template_key,name,body,enabled,marketing)
select c.id,'customer_driver_tracking','Customer driver tracking','{{company_name}}\n\nYour driver {{driver_name}} is on the way.\n\nVehicle: {{vehicle_colour}} {{vehicle_make}} {{vehicle_model}}\nRegistration: {{vehicle_registration}}\n\nTrack your driver:\n{{tracking_url}}\n\n{{driver_contact_line}}',false,false
from public.companies c on conflict(company_id,template_key) do nothing;

alter table public.job_exchange_offers add column if not exists payment_responsibility text not null default 'sender_collects' check(payment_responsibility in('sender_collects','receiver_collects','sender_account'));
alter table public.job_exchange_offers add column if not exists supplier_settlement_status text not null default 'unpaid' check(supplier_settlement_status in('unpaid','partial','paid','disputed','not_applicable'));

create or replace function public.release802_enforce_payment_truth() returns trigger language plpgsql set search_path=public as $$
begin
 if lower(coalesce(new.booking_source,'')) in('job_exchange','external_dispatch') and coalesce(new.amount_paid,0)=0 then
   new.payment_status:='unpaid';new.paid_at:=null;
 end if;
 if lower(coalesce(new.booking_source,''))='job_exchange' then new.driver_amount:=0;end if;
 return new;
end $$;
create trigger release802_payment_truth before insert or update of payment_status,amount_paid,booking_source on public.bookings for each row execute function public.release802_enforce_payment_truth();

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
 return jsonb_build_object('offer_id',o.id,'booking_id',bid,'booking_reference',ref,'status','accepted','duplicate',false);
end $$;

create or replace function public.capture_external_dispatch_journey() returns trigger language plpgsql security definer set search_path=public as $$
declare o public.external_dispatch_offers%rowtype;kind text;stamp timestamptz:=clock_timestamp();event_id uuid;dispatch_key text;
begin
 select * into o from external_dispatch_offers where receiving_booking_id=new.id;if not found then return new;end if;
 if tg_op='UPDATE' and new.driver_id is distinct from old.driver_id and new.driver_id is not null then kind:='driver.assigned';
 elsif tg_op='UPDATE' and new.status is distinct from old.status then kind:='journey.'||lower(new.status);
 else return new;end if;
 dispatch_key:='dispatch:'||o.id||':'||kind||':'||coalesce(new.driver_id::text,'none')||':'||coalesce(new.vehicle_id::text,'none')||':'||extract(epoch from stamp)::bigint;
 insert into external_dispatch_journey_events(offer_id,receiving_company_id,event_type,booking_reference,status,driver_id,vehicle_id,event_timestamp,idempotency_key) values(o.id,new.company_id,kind,new.booking_reference,lower(coalesce(new.status,'')),new.driver_id,new.vehicle_id,stamp,dispatch_key) returning id into event_id;
 update external_dispatch_offers set status=case when lower(new.status)='completed' then 'completed' when lower(new.status) in('on_way','arrived','passenger_onboard') then 'active' else status end,completed_at=case when lower(new.status)='completed' then stamp else completed_at end,updated_at=stamp where id=o.id;
 insert into outbound_webhook_events(company_id,event_type,aggregate_type,aggregate_id,event_key,payload) values(new.company_id,'dispatch.journey.updated','external_dispatch_offer',o.id,dispatch_key,jsonb_build_object('event_id',event_id,'offer_id',o.id,'external_booking_reference',o.external_booking_reference,'booking_reference',new.booking_reference,'status',new.status,'event_timestamp',stamp)) on conflict do nothing;
 insert into outbound_webhook_deliveries(company_id,endpoint_id,event_id) select new.company_id,e.id,w.id from outbound_webhook_endpoints e join outbound_webhook_events w on w.company_id=new.company_id and w.event_key=dispatch_key where e.integration_id=o.integration_id and e.status='active' and 'dispatch.journey.updated'=any(e.event_types) on conflict do nothing;
 return new;
end $$;
create trigger release802_dispatch_journey after update of status,driver_id,vehicle_id on public.bookings for each row execute function public.capture_external_dispatch_journey();

do $$declare t text;begin foreach t in array array['external_dispatch_offers','external_dispatch_journey_events','booking_tracking_tokens','driver_privacy_notices','driver_privacy_acknowledgements','driver_privacy_audit'] loop execute format('alter table public.%I enable row level security',t);execute format('revoke all on public.%I from public,anon,authenticated',t);execute format('grant all on public.%I to service_role',t);end loop;end$$;
revoke all on function public.accept_external_dispatch_offer(uuid,uuid,uuid),public.capture_external_dispatch_journey() from public,anon,authenticated;
grant execute on function public.accept_external_dispatch_offer(uuid,uuid,uuid) to service_role;
notify pgrst,'reload schema';commit;
