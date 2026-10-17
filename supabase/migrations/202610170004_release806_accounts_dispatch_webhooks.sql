-- Release 8.0.6: tenant-owned account management, verified source attribution,
-- provider event mapping and return-to-provider. Additive; no historic finance is rewritten.
begin;

alter table public.account_customers
 add column if not exists category text not null default 'private_business',
 add column if not exists relationship text not null default 'customer',
 add column if not exists account_colour text not null default '#64748b',
 add column if not exists company_registration text,
 add column if not exists vat_number text,
 add column if not exists invoice_frequency text not null default 'monthly',
 add column if not exists invoice_preferences jsonb not null default '{}',
 add column if not exists booking_rules jsonb not null default '{}',
 add column if not exists default_payment_method text not null default 'on_account',
 add column if not exists supplier_payment_terms text not null default 'on_account',
 add column if not exists archived_at timestamptz;

alter table public.account_customers drop constraint if exists account_customers_category_check;
alter table public.account_customers add constraint account_customers_category_check check(category in('external_dispatch_provider','taxi_company','corporate_customer','school','council','nhs_healthcare','hotel','travel_agency','private_business','other'));
alter table public.account_customers drop constraint if exists account_customers_relationship_check;
alter table public.account_customers add constraint account_customers_relationship_check check(relationship in('customer','supplier','both'));
alter table public.account_customers drop constraint if exists account_customers_colour_check;
alter table public.account_customers add constraint account_customers_colour_check check(account_colour~'^#[0-9A-Fa-f]{6}$');
alter table public.account_customers drop constraint if exists account_customers_status_check;
alter table public.account_customers add constraint account_customers_status_check check(status in('active','suspended','archived','closed'));
alter table public.account_customers drop constraint if exists account_customers_default_payment_check;
alter table public.account_customers add constraint account_customers_default_payment_check check(default_payment_method in('cash','card','prepaid','on_account','invoice_later','other'));
alter table public.account_customers drop constraint if exists account_customers_supplier_terms_check;
alter table public.account_customers add constraint account_customers_supplier_terms_check check(supplier_payment_terms in('on_account','direct','receiver_retains','other'));

create table if not exists public.account_contacts(
 id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id), account_customer_id uuid not null,
 name text not null check(length(trim(name)) between 1 and 160), role text, email text, phone text,
 is_primary boolean not null default false, billing_contact boolean not null default false,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 foreign key(account_customer_id,company_id) references public.account_customers(id,company_id) on delete restrict
);
create index if not exists account_contacts_company_account on public.account_contacts(company_id,account_customer_id);

alter table public.api_integrations add column if not exists account_customer_id uuid;
alter table public.external_integrations add column if not exists account_customer_id uuid;
do $$begin
 if not exists(select 1 from pg_constraint where conname='api_integrations_account_company_fk') then alter table public.api_integrations add constraint api_integrations_account_company_fk foreign key(account_customer_id,company_id) references public.account_customers(id,company_id);end if;
 if not exists(select 1 from pg_constraint where conname='external_integrations_account_company_fk') then alter table public.external_integrations add constraint external_integrations_account_company_fk foreign key(account_customer_id,company_id) references public.account_customers(id,company_id);end if;
end$$;

alter table public.bookings
 add column if not exists source_channel text,
 add column if not exists source_account_name text,
 add column if not exists source_account_colour text,
 add column if not exists external_provider_reference text,
 add column if not exists original_booking_reference text;
alter table public.bookings drop constraint if exists bookings_source_channel_check;
alter table public.bookings add constraint bookings_source_channel_check check(source_channel is null or source_channel in('website','passenger_app','phone_office','corporate_account','external_api','internal_job_exchange','manual_admin','other'));

alter table public.external_dispatch_offers
 add column if not exists account_customer_id uuid,
 add column if not exists returned_at timestamptz,
 add column if not exists return_reason text,
 add column if not exists return_actor_id uuid references auth.users(id),
 add column if not exists reallocation_required boolean not null default false;
alter table public.external_dispatch_offers drop constraint if exists external_dispatch_offers_account_company_fk;
alter table public.external_dispatch_offers add constraint external_dispatch_offers_account_company_fk foreign key(account_customer_id,receiving_company_id) references public.account_customers(id,company_id);
alter table public.external_dispatch_offers drop constraint if exists external_dispatch_offers_status_check;
alter table public.external_dispatch_offers add constraint external_dispatch_offers_status_check check(status in('offered','viewed','accepted','declined','returned','expired','withdrawn','active','completed','cancelled'));

alter table public.outbound_webhook_endpoints
 add column if not exists account_customer_id uuid,
 add column if not exists event_mapping jsonb not null default '{}',
 add column if not exists payload_schema_key text,
 add column if not exists gps_authorised boolean not null default false;
alter table public.outbound_webhook_endpoints drop constraint if exists outbound_webhook_endpoints_account_company_fk;
alter table public.outbound_webhook_endpoints add constraint outbound_webhook_endpoints_account_company_fk foreign key(account_customer_id,company_id) references public.account_customers(id,company_id);
alter table public.outbound_webhook_endpoints drop constraint if exists outbound_webhook_endpoints_event_types_check;
alter table public.outbound_webhook_endpoints add constraint outbound_webhook_endpoints_event_types_check check(event_types <@ array['booking.created','booking.accepted','booking.declined','booking.returned','driver.assigned','driver.on_way','driver.arrived','passenger.on_board','booking.completed','booking.cancelled','booking.no_show','gps.position','booking.updated','dispatch.offer.accepted','dispatch.offer.declined','dispatch.journey.updated']::text[]);

create table if not exists public.account_activity(
 id bigint generated always as identity primary key, company_id uuid not null references public.companies(id), account_customer_id uuid not null,
 actor_id uuid references auth.users(id), action text not null, details jsonb not null default '{}', created_at timestamptz not null default now(),
 foreign key(account_customer_id,company_id) references public.account_customers(id,company_id)
);
create index if not exists account_activity_recent on public.account_activity(company_id,account_customer_id,created_at desc);

-- Credential identity, never provider-supplied names, is authoritative.
create or replace function public.release806_attribute_external_offer() returns trigger language plpgsql security definer set search_path=public as $$
declare mapped uuid; account_name text; colour text;
begin
 select i.account_customer_id into mapped from api_integrations i where i.id=new.integration_id and i.company_id=new.receiving_company_id;
 if mapped is null then raise exception 'This authenticated integration is not associated with an account';end if;
 select business_name,account_colour into account_name,colour from account_customers where id=mapped and company_id=new.receiving_company_id and status='active';
 if not found then raise exception 'The integration account is unavailable or inactive';end if;
 new.account_customer_id:=mapped;
 new.booking_payload:=new.booking_payload||jsonb_build_object('verified_source_account_id',mapped,'verified_source_account_name',account_name,'verified_source_account_colour',colour);
 return new;
end$$;
drop trigger if exists release806_attribute_external_offer on public.external_dispatch_offers;
create trigger release806_attribute_external_offer before insert on public.external_dispatch_offers for each row execute function public.release806_attribute_external_offer();

create or replace function public.release806_attribute_external_booking() returns trigger language plpgsql security definer set search_path=public as $$
declare o external_dispatch_offers%rowtype;a account_customers%rowtype;
begin
 if new.booking_source<>'external_dispatch' or new.creation_idempotency_key not like 'dispatch_%' then return new;end if;
 select * into o from external_dispatch_offers where receiving_company_id=new.company_id and ('dispatch_'||id::text=new.creation_idempotency_key or 'dispatch_'||id::text||'_return'=new.creation_idempotency_key) limit 1;
 if not found or o.account_customer_id is null then raise exception 'Verified external dispatch account mapping is required';end if;
 select * into a from account_customers where id=o.account_customer_id and company_id=new.company_id;
 new.account_customer_id:=a.id;new.source_channel:='external_api';new.source_account_name:=a.business_name;new.source_account_colour:=a.account_colour;
 new.external_provider_reference:=o.external_booking_reference;new.original_booking_reference:=o.external_booking_reference;
 new.payment_method:=case a.default_payment_method when 'on_account' then 'account' when 'invoice_later' then 'invoice' else a.default_payment_method end;
 return new;
end$$;
drop trigger if exists release806_attribute_external_booking on public.bookings;
create trigger release806_attribute_external_booking before insert on public.bookings for each row execute function public.release806_attribute_external_booking();

create or replace function public.return_external_dispatch_to_provider(target_offer uuid,target_company uuid,target_actor uuid,target_reason text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare o external_dispatch_offers%rowtype;b bookings%rowtype;stamp timestamptz:=clock_timestamp(); event_id uuid;event_key text;
begin
 if auth.role()<>'service_role' then raise exception 'Service role required';end if;
 if length(trim(coalesce(target_reason,'')))<3 then raise exception 'A return reason is required';end if;
 select * into o from external_dispatch_offers where id=target_offer and receiving_company_id=target_company for update;
 if not found or o.status not in('accepted','active') or o.receiving_booking_id is null then raise exception 'Accepted external offer not found';end if;
 select * into b from bookings where id=o.receiving_booking_id and company_id=target_company for update;
 if not found then raise exception 'Receiving booking not found';end if;
 if lower(coalesce(b.status,b.booking_status,'')) in('passenger_onboard','pob','completed','dropped_off') or b.passenger_onboard_at is not null then raise exception 'Passenger pickup requires the incident and handover process';end if;
 update bookings set status='returned_to_provider',booking_status='returned_to_provider',driver_id=null,vehicle_id=null where id=b.id and company_id=target_company;
 update external_dispatch_offers set status='returned',returned_at=stamp,return_reason=left(trim(target_reason),500),return_actor_id=target_actor,reallocation_required=true,updated_at=stamp where id=o.id;
 event_key:='dispatch:'||o.id||':returned';
 insert into external_dispatch_journey_events(offer_id,receiving_company_id,event_type,booking_reference,status,event_timestamp,idempotency_key) values(o.id,target_company,'booking.returned',b.booking_reference,'returned',stamp,event_key) on conflict(idempotency_key) do nothing returning id into event_id;
 insert into outbound_webhook_events(company_id,event_type,aggregate_type,aggregate_id,event_key,payload) values(target_company,'booking.returned','external_dispatch_offer',o.id,event_key,jsonb_build_object('offer_id',o.id,'external_booking_reference',o.external_booking_reference,'booking_reference',b.booking_reference,'status','returned','reason',left(trim(target_reason),500),'event_timestamp',stamp,'reallocation_required',true)) on conflict(company_id,event_key) do nothing;
 insert into outbound_webhook_deliveries(company_id,endpoint_id,event_id) select target_company,e.id,w.id from outbound_webhook_endpoints e join outbound_webhook_events w on w.company_id=target_company and w.event_key=event_key where e.integration_id=o.integration_id and e.status='active' and 'booking.returned'=any(e.event_types) on conflict(endpoint_id,event_id) do nothing;
 return jsonb_build_object('offer_id',o.id,'booking_id',b.id,'status','returned','reallocation_required',true,'returned_at',stamp);
end$$;

alter table public.account_contacts enable row level security;
alter table public.account_activity enable row level security;
revoke all on public.account_contacts,public.account_activity from public,anon;
grant select,insert,update on public.account_contacts to authenticated;
grant select on public.account_activity to authenticated;
create policy account_contacts_company_select on public.account_contacts for select to authenticated using(public.user_can_access_company(company_id));
create policy account_contacts_company_insert on public.account_contacts for insert to authenticated with check(public.user_can_access_company(company_id));
create policy account_contacts_company_update on public.account_contacts for update to authenticated using(public.user_can_access_company(company_id)) with check(public.user_can_access_company(company_id));
create policy account_activity_company_select on public.account_activity for select to authenticated using(public.user_can_access_company(company_id));
revoke all on function public.release806_attribute_external_offer(),public.release806_attribute_external_booking(),public.return_external_dispatch_to_provider(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.return_external_dispatch_to_provider(uuid,uuid,uuid,text) to service_role;

commit;
notify pgrst,'reload schema';
