-- Release 5: company-scoped Empty Legs listings and admin-confirmed requests.
-- Additive only. Existing bookings, customers, payments and drivers are untouched.

begin;

alter table public.settings add column if not exists empty_legs_enabled boolean not null default false;
alter table public.settings add column if not exists empty_legs_public_enabled boolean not null default false;
alter table public.settings add column if not exists empty_legs_turnaround_minutes integer not null default 30 check (empty_legs_turnaround_minutes between 0 and 360);
alter table public.settings add column if not exists empty_legs_cutoff_minutes integer not null default 120 check (empty_legs_cutoff_minutes between 0 and 10080);
alter table public.settings add column if not exists empty_legs_window_minutes integer not null default 120 check (empty_legs_window_minutes between 15 and 720);
alter table public.settings add column if not exists empty_legs_discount_percent numeric(5,2) check (empty_legs_discount_percent is null or empty_legs_discount_percent between 0 and 90);
alter table public.settings add column if not exists empty_legs_public_phone text;
alter table public.settings add column if not exists empty_legs_public_email text;
alter table public.settings add column if not exists empty_leg_request_emails boolean not null default true;
alter table public.settings add column if not exists empty_leg_customer_response_emails boolean not null default true;

create table if not exists public.empty_leg_listings (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  source_booking_id uuid,
  confirmed_booking_id uuid,
  origin text not null,
  origin_postcode text,
  origin_place_id text,
  origin_lat numeric,
  origin_lng numeric,
  destination text not null,
  destination_postcode text,
  destination_place_id text,
  destination_lat numeric,
  destination_lng numeric,
  departure_date date not null,
  earliest_time time not null,
  latest_time time not null,
  passenger_capacity integer not null check (passenger_capacity between 1 and 52),
  suitcase_capacity integer not null default 0 check (suitcase_capacity between 0 and 100),
  hand_luggage_capacity integer not null default 0 check (hand_luggage_capacity between 0 and 100),
  vehicle_type text not null,
  driver_id uuid,
  normal_fare numeric(10,2) not null check (normal_fare >= 0),
  empty_leg_fare numeric(10,2) not null check (empty_leg_fare >= 0),
  notes text,
  public_visible boolean not null default false,
  status text not null default 'draft' check (status in ('draft','active','confirmed','expired','cancelled')),
  expires_at timestamptz not null,
  request_cutoff_at timestamptz not null,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(id,company_id),
  foreign key(source_booking_id,company_id) references public.bookings(id,company_id),
  foreign key(driver_id,company_id) references public.drivers(id,company_id),
  check (latest_time >= earliest_time),
  check (empty_leg_fare <= normal_fare or normal_fare=0)
);

create table if not exists public.empty_leg_requests (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  listing_id uuid not null,
  customer_name text not null,
  customer_email text not null,
  customer_phone text not null,
  passengers integer not null check (passengers between 1 and 52),
  suitcases integer not null default 0 check (suitcases between 0 and 100),
  hand_luggage integer not null default 0 check (hand_luggage between 0 and 100),
  pickup_clarification text,
  dropoff_clarification text,
  customer_notes text,
  internal_notes text,
  status text not null default 'new' check(status in ('new','under_review','accepted','declined','expired','cancelled')),
  idempotency_key text not null,
  booking_id uuid,
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(company_id,idempotency_key),
  unique(id,company_id),
  foreign key(listing_id,company_id) references public.empty_leg_listings(id,company_id),
  foreign key(booking_id,company_id) references public.bookings(id,company_id)
);

create table if not exists public.empty_leg_audit (
  id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id) on delete cascade,
  listing_id uuid, request_id uuid, actor_type text not null, actor_id text, action text not null,
  details jsonb not null default '{}'::jsonb, created_at timestamptz not null default now()
);

alter table public.bookings add column if not exists source_empty_leg_id uuid;
do $$ begin
  if not exists(select 1 from pg_constraint where conrelid='public.bookings'::regclass and conname='bookings_source_empty_leg_company_fk') then
    alter table public.bookings add constraint bookings_source_empty_leg_company_fk foreign key(source_empty_leg_id,company_id) references public.empty_leg_listings(id,company_id);
  end if;
  if not exists(select 1 from pg_constraint where conrelid='public.empty_leg_listings'::regclass and conname='empty_leg_confirmed_booking_company_fk') then
    alter table public.empty_leg_listings add constraint empty_leg_confirmed_booking_company_fk foreign key(confirmed_booking_id,company_id) references public.bookings(id,company_id);
  end if;
end $$;
create index if not exists empty_leg_listings_company_status_date_idx on public.empty_leg_listings(company_id,status,departure_date,earliest_time);
create index if not exists empty_leg_requests_company_status_created_idx on public.empty_leg_requests(company_id,status,created_at desc);
create index if not exists empty_leg_audit_company_listing_idx on public.empty_leg_audit(company_id,listing_id,created_at desc);
create unique index if not exists bookings_source_empty_leg_unique on public.bookings(company_id,source_empty_leg_id) where source_empty_leg_id is not null;

alter table public.empty_leg_listings enable row level security;
alter table public.empty_leg_requests enable row level security;
alter table public.empty_leg_audit enable row level security;
revoke all on public.empty_leg_listings,public.empty_leg_requests,public.empty_leg_audit from public,anon;
grant select,insert,update on public.empty_leg_listings,public.empty_leg_requests to authenticated;
grant select on public.empty_leg_audit to authenticated;
create policy empty_leg_listings_admin on public.empty_leg_listings for all to authenticated using(public.user_can_access_company(company_id)) with check(public.user_can_access_company(company_id));
create policy empty_leg_requests_admin on public.empty_leg_requests for all to authenticated using(public.user_can_access_company(company_id)) with check(public.user_can_access_company(company_id));
create policy empty_leg_audit_admin on public.empty_leg_audit for select to authenticated using(public.user_can_access_company(company_id));

create or replace function public.accept_empty_leg_request(target_company_id uuid,target_request_id uuid,target_admin_id uuid,target_status text,target_notes text default null)
returns public.empty_leg_requests language plpgsql security definer set search_path=public as $$
declare r public.empty_leg_requests%rowtype; l public.empty_leg_listings%rowtype; next_status text:=lower(target_status);
begin
  if next_status not in ('under_review','accepted','declined','cancelled') then raise exception 'Invalid request status'; end if;
  select * into r from public.empty_leg_requests where id=target_request_id and company_id=target_company_id for update;
  if not found then raise exception 'Request not found'; end if;
  select * into l from public.empty_leg_listings where id=r.listing_id and company_id=target_company_id for update;
  if next_status='accepted' then
    if r.status='accepted' then return r; end if;
    if r.status not in ('new','under_review') then raise exception 'Request cannot be accepted'; end if;
    if l.status<>'active' or not l.public_visible or now()>=least(l.expires_at,l.request_cutoff_at) then raise exception 'Listing is no longer available'; end if;
    if r.passengers>l.passenger_capacity or r.suitcases>l.suitcase_capacity or r.hand_luggage>l.hand_luggage_capacity then raise exception 'Request exceeds listing capacity'; end if;
    if exists(select 1 from public.empty_leg_requests x where x.company_id=target_company_id and x.listing_id=l.id and x.status='accepted' and x.id<>r.id) then raise exception 'Another request has already been accepted'; end if;
  end if;
  update public.empty_leg_requests set status=next_status,internal_notes=coalesce(nullif(trim(target_notes),''),internal_notes),reviewed_by=target_admin_id,reviewed_at=now(),updated_at=now() where id=r.id returning * into r;
  insert into public.empty_leg_audit(company_id,listing_id,request_id,actor_type,actor_id,action) values(target_company_id,l.id,r.id,'admin',target_admin_id::text,'request_'||next_status);
  return r;
end $$;
revoke all on function public.accept_empty_leg_request(uuid,uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.accept_empty_leg_request(uuid,uuid,uuid,text,text) to service_role;

create or replace function public.convert_empty_leg_request(target_company_id uuid,target_request_id uuid,target_admin_id uuid)
returns uuid language plpgsql security definer set search_path=public as $$
declare r public.empty_leg_requests%rowtype; l public.empty_leg_listings%rowtype; new_id uuid:=gen_random_uuid(); ref text; start_at timestamptz; end_at timestamptz;
begin
  select * into r from public.empty_leg_requests where id=target_request_id and company_id=target_company_id for update;
  if not found then raise exception 'Request not found'; end if;
  select * into l from public.empty_leg_listings where id=r.listing_id and company_id=target_company_id for update;
  if r.booking_id is not null then return r.booking_id; end if;
  if r.status<>'accepted' or l.status<>'active' then raise exception 'Only an accepted available request can be converted'; end if;
  if now()>=least(l.expires_at,l.request_cutoff_at) then raise exception 'Listing has expired'; end if;
  start_at:=(l.departure_date+l.earliest_time) at time zone coalesce((select timezone from public.settings where company_id=target_company_id),'Europe/London');
  end_at:=(l.departure_date+l.latest_time) at time zone coalesce((select timezone from public.settings where company_id=target_company_id),'Europe/London') + interval '2 hours';
  if exists(select 1 from public.availability_blocks a where a.company_id=target_company_id and a.active and a.starts_at<end_at and a.ends_at>start_at) then raise exception 'FULLY_BOOKED: listing overlaps an unavailable period'; end if;
  if l.driver_id is not null and (exists(select 1 from public.driver_unavailability u where u.company_id=target_company_id and u.driver_id=l.driver_id and u.active and u.from_datetime<end_at and u.to_datetime>start_at) or exists(select 1 from public.bookings b where b.company_id=target_company_id and b.driver_id=l.driver_id and lower(coalesce(b.status,'')) in ('assigned','accepted','on_way','arrived','passenger_onboard') and ((b.journey_date+b.journey_time) at time zone coalesce((select timezone from public.settings where company_id=target_company_id),'Europe/London'))<end_at and (((b.journey_date+b.journey_time) at time zone coalesce((select timezone from public.settings where company_id=target_company_id),'Europe/London'))+make_interval(mins=>greatest(60,coalesce(b.route_duration_minutes,60))::integer))>start_at)) then raise exception 'Assigned driver is not available'; end if;
  ref:='EL-'||to_char(now(),'YYYYMMDD')||'-'||upper(substr(replace(new_id::text,'-',''),1,8));
  insert into public.bookings(id,company_id,booking_reference,customer_name,customer_email,customer_phone,pickup_address,pickup_postcode,pickup_place_id,pickup_lat,pickup_lng,dropoff_address,dropoff_postcode,dropoff_place_id,dropoff_lat,dropoff_lng,journey_date,journey_time,passengers,suitcases,hand_luggage,vehicle_type,price,payment_method,payment_status,driver_id,status,notes,booking_source,source_empty_leg_id,dispatched_at)
  values(new_id,target_company_id,ref,r.customer_name,r.customer_email,r.customer_phone,l.origin,l.origin_postcode,l.origin_place_id,l.origin_lat,l.origin_lng,l.destination,l.destination_postcode,l.destination_place_id,l.destination_lat,l.destination_lng,l.departure_date,l.earliest_time,r.passengers,r.suitcases,r.hand_luggage,l.vehicle_type,l.empty_leg_fare,'Pay in Car','unpaid',l.driver_id,case when l.driver_id is null then 'waiting' else 'assigned' end,concat_ws(E'\n',r.pickup_clarification,r.dropoff_clarification,r.customer_notes), 'empty_leg',l.id,case when l.driver_id is null then null else now() end);
  update public.empty_leg_requests set booking_id=new_id,updated_at=now() where id=r.id;
  update public.empty_leg_listings set confirmed_booking_id=new_id,status='confirmed',public_visible=false,updated_at=now() where id=l.id;
  update public.empty_leg_requests set status='declined',updated_at=now() where company_id=target_company_id and listing_id=l.id and id<>r.id and status in ('new','under_review');
  insert into public.empty_leg_audit(company_id,listing_id,request_id,actor_type,actor_id,action,details) values(target_company_id,l.id,r.id,'admin',target_admin_id::text,'booking_converted',jsonb_build_object('booking_id',new_id));
  return new_id;
end $$;
revoke all on function public.convert_empty_leg_request(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.convert_empty_leg_request(uuid,uuid,uuid) to service_role;

insert into public.email_templates(company_id,template_key,subject,body,active)
select c.id,x.k,x.s,x.b,true from public.companies c cross join (values
('office_empty_leg_request','EMPTY LEG REQUEST — {{route}}','A new Empty Leg request has been received.\n\nCustomer: {{customer_name}}\nPhone: {{customer_phone}}\nRoute: {{route}}\nDeparture: {{departure_window}}\nFare: {{fare}}'),
('customer_empty_leg_accepted','Empty Leg request accepted','Hello {{customer_name}},\n\nYour Empty Leg request for {{route}} has been accepted. The company will contact you to complete the booking.'),
('customer_empty_leg_declined','Empty Leg request update','Hello {{customer_name}},\n\nUnfortunately your Empty Leg request for {{route}} could not be accepted.')) x(k,s,b)
on conflict(company_id,template_key) do nothing;

notify pgrst,'reload schema';
commit;
