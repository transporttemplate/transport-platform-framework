-- Stage 1B security cut-over. Additive data model only; no tables/rows are removed.
-- Deploy driver-portal and public-booking-create before applying this migration.

create extension if not exists pgcrypto;

alter table public.drivers add column if not exists pin_hash text;
alter table public.drivers alter column pin drop not null;

-- Transitional backfill. Plaintext remains temporarily for rollback, but browser
-- grants below prevent it being read. Null it in a later approved cleanup.
update public.drivers set pin_hash = crypt(pin::text, gen_salt('bf', 10))
where pin_hash is null and nullif(trim(pin::text), '') is not null;

create table if not exists public.driver_sessions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  driver_id uuid not null,
  token_hash text not null unique,
  expires_at timestamptz not null,
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (driver_id, company_id) references public.drivers(id, company_id) on delete cascade
);
create table if not exists public.security_rate_limits (
  company_id uuid not null references public.companies(id) on delete cascade,
  action text not null,
  subject_hash text not null,
  window_started_at timestamptz not null default now(),
  attempt_count integer not null default 0,
  blocked_until timestamptz,
  primary key (company_id, action, subject_hash)
);
create table if not exists public.company_counters (
  company_id uuid primary key references public.companies(id) on delete cascade,
  next_booking_number bigint not null default 1 check (next_booking_number > 0),
  updated_at timestamptz not null default now()
);
create table if not exists public.driver_unavailability (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  driver_id uuid not null,
  from_datetime timestamptz not null,
  to_datetime timestamptz not null,
  reason text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  foreign key (driver_id, company_id) references public.drivers(id, company_id) on delete cascade
);

create index if not exists driver_sessions_company_driver_idx on public.driver_sessions(company_id, driver_id, expires_at);
create index if not exists driver_sessions_expiry_idx on public.driver_sessions(expires_at) where revoked_at is null;
create index if not exists security_rate_limits_blocked_idx on public.security_rate_limits(company_id, action, blocked_until);
create index if not exists driver_unavailability_company_driver_idx on public.driver_unavailability(company_id, driver_id, from_datetime);
create index if not exists customers_company_phone_lookup_idx on public.customers(company_id, phone);
create index if not exists customers_company_email_lookup_idx on public.customers(company_id, lower(email));
create index if not exists bookings_company_reference_lookup_idx on public.bookings(company_id, booking_reference);

alter table public.driver_sessions enable row level security;
alter table public.security_rate_limits enable row level security;
alter table public.company_counters enable row level security;
alter table public.drivers enable row level security;
alter table public.customers enable row level security;
alter table public.bookings enable row level security;
alter table public.driver_unavailability enable row level security;

create or replace function public.consume_security_rate_limit(target_company_id uuid, target_action text, target_subject_hash text, maximum_attempts integer default 5, window_seconds integer default 900)
returns boolean language plpgsql security definer set search_path = public as $$
declare r public.security_rate_limits%rowtype; span interval := make_interval(secs => greatest(window_seconds, 60));
begin
  insert into public.security_rate_limits(company_id, action, subject_hash, attempt_count)
  values (target_company_id, target_action, target_subject_hash, 0) on conflict do nothing;
  select * into r from public.security_rate_limits where company_id=target_company_id and action=target_action and subject_hash=target_subject_hash for update;
  if r.blocked_until is not null and r.blocked_until > now() then return false; end if;
  if r.window_started_at + span <= now() then
    update public.security_rate_limits set window_started_at=now(), attempt_count=1, blocked_until=null
    where company_id=target_company_id and action=target_action and subject_hash=target_subject_hash;
    return true;
  end if;
  if r.attempt_count >= maximum_attempts then
    update public.security_rate_limits set blocked_until=r.window_started_at+span
    where company_id=target_company_id and action=target_action and subject_hash=target_subject_hash;
    return false;
  end if;
  update public.security_rate_limits set attempt_count=attempt_count+1
  where company_id=target_company_id and action=target_action and subject_hash=target_subject_hash;
  return true;
end $$;

create or replace function public.clear_security_rate_limit(target_company_id uuid, target_action text, target_subject_hash text)
returns void language sql security definer set search_path = public as $$
  update public.security_rate_limits set attempt_count=0, blocked_until=null, window_started_at=now()
  where company_id=target_company_id and action=target_action and subject_hash=target_subject_hash;
$$;

create or replace function public.verify_driver_pin(target_company_id uuid, target_driver_number text, supplied_pin text, new_token_hash text, session_expires_at timestamptz)
returns table(driver_id uuid, company_id uuid) language plpgsql security definer set search_path = public as $$
declare d public.drivers%rowtype;
begin
  select * into d from public.drivers
  where drivers.company_id=target_company_id and driver_number::text=trim(target_driver_number)
    and lower(coalesce(status,'active')) not in ('inactive','disabled') limit 1;
  if d.id is null or d.pin_hash is null or crypt(supplied_pin,d.pin_hash)<>d.pin_hash then return; end if;
  insert into public.driver_sessions(company_id,driver_id,token_hash,expires_at)
  values(target_company_id,d.id,new_token_hash,session_expires_at);
  return query select d.id,d.company_id;
end $$;

create or replace function public.hash_driver_pin(supplied_pin text)
returns text language sql security definer set search_path=public as $$ select crypt(supplied_pin,gen_salt('bf',10)); $$;

create or replace function public.next_company_booking_reference(target_company_id uuid)
returns text language plpgsql security definer set search_path=public as $$
declare n bigint; p text; candidate text;
begin
  if not exists(select 1 from public.companies where id=target_company_id) then raise exception 'Company not found'; end if;
  select coalesce(nullif(regexp_replace(bookingprefix,'[^A-Za-z0-9_-]','','g'),''),'BK') into p
  from public.settings where company_id=target_company_id limit 1;
  p:=coalesce(p,'BK');
  loop
    insert into public.company_counters(company_id,next_booking_number) values(target_company_id,2)
    on conflict(company_id) do update set next_booking_number=company_counters.next_booking_number+1,updated_at=now()
    returning next_booking_number-1 into n;
    candidate:=p||to_char(current_date,'YYYYMMDD')||'-'||lpad(n::text,4,'0');
    exit when not exists(select 1 from public.bookings where company_id=target_company_id and booking_reference=candidate);
  end loop;
  return candidate;
end $$;

create or replace function public.next_admin_booking_reference(target_company_id uuid)
returns text language plpgsql security definer set search_path=public as $$
begin
  if not public.user_can_access_company(target_company_id) then raise exception 'Forbidden'; end if;
  return public.next_company_booking_reference(target_company_id);
end $$;

create or replace function public.find_or_create_admin_customer(target_company_id uuid, customer_name text, customer_email text, customer_phone text)
returns uuid language plpgsql security definer set search_path=public as $$
declare customer_uuid uuid;
begin
  if not public.user_can_access_company(target_company_id) then raise exception 'Forbidden'; end if;
  select id into customer_uuid from public.customers where company_id=target_company_id and (
    (nullif(trim(customer_phone),'') is not null and regexp_replace(coalesce(phone,''),'\D','','g')=regexp_replace(customer_phone,'\D','','g')) or
    (nullif(trim(customer_email),'') is not null and lower(coalesce(email,''))=lower(trim(customer_email))))
  order by created_at limit 1;
  if customer_uuid is null then
    insert into public.customers(company_id,full_name,email,phone)
    values(target_company_id,nullif(trim(customer_name),''),nullif(trim(customer_email),''),nullif(trim(customer_phone),'')) returning id into customer_uuid;
  end if;
  return customer_uuid;
end $$;

create or replace function public.find_or_create_public_customer(target_company_id uuid, customer_name text, customer_email text, customer_phone text)
returns uuid language plpgsql security definer set search_path=public as $$
declare customer_uuid uuid;
begin
  select id into customer_uuid from public.customers where company_id=target_company_id and (
    (nullif(trim(customer_phone),'') is not null and regexp_replace(coalesce(phone,''),'\D','','g')=regexp_replace(customer_phone,'\D','','g')) or
    (nullif(trim(customer_email),'') is not null and lower(coalesce(email,''))=lower(trim(customer_email))))
  order by created_at limit 1;
  if customer_uuid is null then
    insert into public.customers(company_id,full_name,email,phone)
    values(target_company_id,nullif(trim(customer_name),''),nullif(trim(customer_email),''),nullif(trim(customer_phone),'')) returning id into customer_uuid;
  end if;
  return customer_uuid;
end $$;

revoke all on function public.consume_security_rate_limit(uuid,text,text,integer,integer) from public,anon,authenticated;
revoke all on function public.clear_security_rate_limit(uuid,text,text) from public,anon,authenticated;
revoke all on function public.verify_driver_pin(uuid,text,text,text,timestamptz) from public,anon,authenticated;
revoke all on function public.hash_driver_pin(text) from public,anon,authenticated;
revoke all on function public.next_company_booking_reference(uuid) from public,anon,authenticated;
grant execute on function public.consume_security_rate_limit(uuid,text,text,integer,integer) to service_role;
grant execute on function public.clear_security_rate_limit(uuid,text,text) to service_role;
grant execute on function public.verify_driver_pin(uuid,text,text,text,timestamptz) to service_role;
grant execute on function public.hash_driver_pin(text) to service_role;
grant execute on function public.next_company_booking_reference(uuid) to service_role;
revoke all on function public.find_or_create_public_customer(uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.find_or_create_public_customer(uuid,text,text,text) to service_role;
revoke all on function public.next_admin_booking_reference(uuid) from public,anon;
revoke all on function public.find_or_create_admin_customer(uuid,text,text,text) from public,anon;
grant execute on function public.next_admin_booking_reference(uuid) to authenticated;
grant execute on function public.find_or_create_admin_customer(uuid,text,text,text) to authenticated;
revoke all on function public.get_driver_booking_stops(uuid,uuid,text) from public,anon,authenticated;

revoke all on table public.drivers,public.customers,public.bookings,public.booking_stops,public.driver_unavailability from anon;
revoke all on table public.drivers from authenticated;
grant select(id,company_id,driver_number,full_name,phone,email,vehicle,licence_number,licence_expiry,status,online,latitude,longitude,location_updated_at,pay_type,commission_percent,fixed_job_amount) on public.drivers to authenticated;
grant select,insert,update,delete on public.customers,public.bookings,public.booking_stops,public.driver_unavailability to authenticated;

-- Restrictive policies are ANDed with older permissive policies, preventing a
-- legacy broad policy from bypassing tenant membership checks.
do $$
declare t text;
begin
  foreach t in array array['customers','bookings','booking_stops','driver_unavailability'] loop
    if not exists(select 1 from pg_policies where schemaname='public' and tablename=t and policyname='stage1b_admin_permissive') then
      execute format('create policy stage1b_admin_permissive on public.%I for all to authenticated using (public.user_can_access_company(company_id)) with check (public.user_can_access_company(company_id))',t);
    end if;
    if not exists(select 1 from pg_policies where schemaname='public' and tablename=t and policyname='stage1b_admin_restrictive') then
      execute format('create policy stage1b_admin_restrictive on public.%I as restrictive for all to authenticated using (public.user_can_access_company(company_id)) with check (public.user_can_access_company(company_id))',t);
    end if;
  end loop;
  if not exists(select 1 from pg_policies where schemaname='public' and tablename='drivers' and policyname='stage1b_admin_permissive') then
    create policy stage1b_admin_permissive on public.drivers for select to authenticated using(public.user_can_access_company(company_id));
  end if;
  if not exists(select 1 from pg_policies where schemaname='public' and tablename='drivers' and policyname='stage1b_admin_restrictive') then
    create policy stage1b_admin_restrictive on public.drivers as restrictive for select to authenticated using(public.user_can_access_company(company_id));
  end if;
end $$;

notify pgrst,'reload schema';
