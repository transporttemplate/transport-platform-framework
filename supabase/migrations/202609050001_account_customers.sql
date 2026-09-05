-- Private, company-scoped contract/account customers integrated with existing
-- bookings and invoices. Additive only: no existing rows are changed or removed.

begin;

create table if not exists public.account_customers (
  id uuid primary key default extensions.gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  account_code text not null,
  business_name text not null,
  contact_name text,
  contact_phone text,
  contact_email text,
  billing_email text,
  billing_address text,
  billing_postcode text,
  invoice_contact_name text,
  payment_terms_days integer not null default 30 check (payment_terms_days between 0 and 365),
  po_required boolean not null default false,
  default_po_reference text,
  status text not null default 'active' check (status in ('active','suspended','closed')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, company_id),
  check (account_code = upper(trim(account_code)) and account_code <> ''),
  check (business_name = trim(business_name) and business_name <> '')
);

create unique index if not exists account_customers_company_code_unique
  on public.account_customers (company_id, lower(account_code));
create index if not exists account_customers_company_status_name_idx
  on public.account_customers (company_id, status, business_name);

alter table public.bookings add column if not exists account_customer_id uuid;
alter table public.bookings add column if not exists account_po_reference text;
alter table public.invoices add column if not exists account_customer_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'bookings_account_customer_company_fk'
      and conrelid = 'public.bookings'::regclass
  ) then
    alter table public.bookings
      add constraint bookings_account_customer_company_fk
      foreign key (account_customer_id, company_id)
      references public.account_customers(id, company_id);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'invoices_account_customer_company_fk'
      and conrelid = 'public.invoices'::regclass
  ) then
    alter table public.invoices
      add constraint invoices_account_customer_company_fk
      foreign key (account_customer_id, company_id)
      references public.account_customers(id, company_id);
  end if;
end
$$;

create index if not exists bookings_company_account_customer_idx
  on public.bookings (company_id, account_customer_id, payment_status, journey_date);
create index if not exists invoices_company_account_customer_idx
  on public.invoices (company_id, account_customer_id, status, issue_date);

create or replace function public.touch_account_customer_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.account_code := upper(trim(new.account_code));
  new.business_name := trim(new.business_name);
  new.billing_postcode := nullif(upper(regexp_replace(coalesce(new.billing_postcode, ''), '\s+', '', 'g')), '');
  new.contact_email := nullif(lower(trim(coalesce(new.contact_email, ''))), '');
  new.billing_email := nullif(lower(trim(coalesce(new.billing_email, ''))), '');
  new.updated_at := now();
  return new;
end
$$;

revoke all on function public.touch_account_customer_updated_at() from public, anon, authenticated;

do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'account_customers_touch_updated_at'
      and tgrelid = 'public.account_customers'::regclass
  ) then
    create trigger account_customers_touch_updated_at
    before insert or update on public.account_customers
    for each row execute function public.touch_account_customer_updated_at();
  end if;
end
$$;

alter table public.account_customers enable row level security;

revoke all on table public.account_customers from public, anon;
grant select, insert, update on table public.account_customers to authenticated;
grant select on table public.account_customers to service_role;

create policy account_customers_company_select
on public.account_customers for select to authenticated
using (public.user_can_access_company(company_id));

create policy account_customers_company_insert
on public.account_customers for insert to authenticated
with check (public.user_can_access_company(company_id));

create policy account_customers_company_update
on public.account_customers for update to authenticated
using (public.user_can_access_company(company_id))
with check (public.user_can_access_company(company_id));

-- These two booleans are public booking capability flags, not private account
-- data. Account records themselves remain completely unavailable to anon.
grant select (allowaccounts, enableaccounts) on table public.settings to anon;

notify pgrst, 'reload schema';

commit;
