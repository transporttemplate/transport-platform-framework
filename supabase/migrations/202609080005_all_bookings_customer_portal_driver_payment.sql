-- Customer portal membership, secure guest-booking claims and audit support.
begin;

create table if not exists public.customer_users (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  customer_id uuid not null,
  created_at timestamptz not null default now(),
  unique(auth_user_id, company_id),
  unique(company_id, customer_id),
  foreign key(customer_id, company_id) references public.customers(id, company_id) on delete cascade
);

create table if not exists public.booking_claim_tokens (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  booking_id uuid not null,
  email_normalized text not null,
  token_hash text not null unique,
  expires_at timestamptz not null,
  claimed_at timestamptz,
  claimed_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  foreign key(booking_id, company_id) references public.bookings(id, company_id) on delete cascade
);

create table if not exists public.customer_booking_audit (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  booking_id uuid not null,
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  action text not null check(action in ('claim','change','cancel')),
  changes jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key(booking_id, company_id) references public.bookings(id, company_id) on delete cascade
);

create index if not exists customer_users_auth_company_idx on public.customer_users(auth_user_id,company_id);
create index if not exists booking_claim_tokens_booking_idx on public.booking_claim_tokens(company_id,booking_id);
create index if not exists customer_booking_audit_booking_idx on public.customer_booking_audit(company_id,booking_id,created_at desc);
create unique index if not exists payments_driver_cash_reference_unique on public.payments(reference) where method='driver_cash' and reference is not null;

do $$ begin
  if not exists(select 1 from pg_constraint where conname='bookings_driver_company_fk' and conrelid='public.bookings'::regclass) then
    alter table public.bookings add constraint bookings_driver_company_fk foreign key(driver_id,company_id) references public.drivers(id,company_id) not valid;
  end if;
end $$;

create or replace function public.mark_driver_cash_booking_paid(target_company_id uuid,target_driver_id uuid,target_booking_id uuid)
returns boolean language plpgsql security definer set search_path=public as $$
declare booking_row public.bookings%rowtype; paid_time timestamptz:=now(); paid_amount numeric;
begin
  select * into booking_row from public.bookings where id=target_booking_id and company_id=target_company_id and driver_id=target_driver_id for update;
  if not found then return false; end if;
  if lower(coalesce(booking_row.payment_method,'')) not in ('cash','pay in car','pay by cash') then raise exception 'Only Pay in Car cash bookings can be marked paid'; end if;
  if lower(coalesce(booking_row.status,'')) not in ('accepted','on_way','passenger_onboard','completed') then raise exception 'Payment cannot be recorded at this stage'; end if;
  if lower(coalesce(booking_row.payment_status,''))='paid' then return true; end if;
  paid_amount:=greatest(0,coalesce(booking_row.price,0));
  update public.bookings set payment_status='paid',paid_at=paid_time,amount_paid=paid_amount,balance_due=0 where id=target_booking_id and company_id=target_company_id and driver_id=target_driver_id;
  insert into public.payments(company_id,booking_id,amount,method,status,reference,paid_at) values(target_company_id,target_booking_id,paid_amount,'driver_cash','paid','driver-cash:'||target_booking_id,paid_time) on conflict do nothing;
  return true;
end $$;
revoke all on function public.mark_driver_cash_booking_paid(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.mark_driver_cash_booking_paid(uuid,uuid,uuid) to service_role;

create or replace function public.admin_update_booking_driver(target_company_id uuid,target_booking_id uuid,target_driver_id uuid,target_driver_amount numeric)
returns boolean language plpgsql security definer set search_path=public as $$
declare booking_row public.bookings%rowtype; driver_changed boolean;
begin
  if not exists(select 1 from public.company_users where user_id=auth.uid() and company_id=target_company_id) then raise exception 'Admin company access required'; end if;
  if target_driver_amount is not null and target_driver_amount<0 then raise exception 'Driver amount must not be negative'; end if;
  select * into booking_row from public.bookings where id=target_booking_id and company_id=target_company_id for update;
  if not found then return false; end if;
  driver_changed:=booking_row.driver_id is distinct from target_driver_id;
  if target_driver_id is not null then
    if not exists(select 1 from public.drivers where id=target_driver_id and company_id=target_company_id) then raise exception 'Driver is not available to this company'; end if;
    if driver_changed and exists(select 1 from public.driver_unavailability where driver_id=target_driver_id and company_id=target_company_id and active=true and from_datetime<=now() and to_datetime>=now()) then raise exception 'Driver is currently unavailable'; end if;
  end if;
  update public.bookings set
    driver_id=target_driver_id,
    driver_amount=target_driver_amount,
    dispatched_at=case when driver_changed then case when target_driver_id is null then null else now() end else dispatched_at end,
    status=case when driver_changed and lower(coalesce(status,'')) not in ('accepted','on_way','passenger_onboard','completed','cancelled','canceled','no_show') then case when target_driver_id is null then 'waiting' else 'assigned' end else status end
  where id=target_booking_id and company_id=target_company_id;
  return true;
end $$;
revoke all on function public.admin_update_booking_driver(uuid,uuid,uuid,numeric) from public,anon;
grant execute on function public.admin_update_booking_driver(uuid,uuid,uuid,numeric) to authenticated;

alter table public.customer_users enable row level security;
alter table public.booking_claim_tokens enable row level security;
alter table public.customer_booking_audit enable row level security;

drop policy if exists customer_users_own_or_company_admin_select on public.customer_users;
create policy customer_users_own_or_company_admin_select on public.customer_users for select to authenticated using (
  auth_user_id=auth.uid() or exists(select 1 from public.company_users cu where cu.user_id=auth.uid() and cu.company_id=customer_users.company_id)
);

revoke all on public.customer_users,public.booking_claim_tokens,public.customer_booking_audit from anon;
revoke all on public.customer_users,public.booking_claim_tokens,public.customer_booking_audit from authenticated;
grant select on public.customer_users to authenticated;
grant select,insert,update,delete on public.customer_users,public.booking_claim_tokens,public.customer_booking_audit to service_role;

commit;
notify pgrst, 'reload schema';
