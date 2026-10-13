begin;

alter table public.drivers add column if not exists driver_accounts_enabled boolean not null default false;

create table if not exists public.driver_expense_rules (
  id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id) on delete cascade,
  driver_id uuid not null references public.drivers(id) on delete cascade, category text not null,
  description text not null, amount numeric(12,2) not null check(amount >= 0), frequency text not null default 'one_off'
    check(frequency in ('one_off','daily','weekly','monthly','quarterly','yearly')),
  supplier text, notes text, payment_method text, start_date date not null, end_date date,
  business_use_percent numeric(5,2) not null default 100 check(business_use_percent between 0 and 100),
  accounting_treatment text not null default 'review' check(accounting_treatment in ('expense','capital','mixed_use','review')),
  active boolean not null default true, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check(end_date is null or end_date >= start_date), unique(id,company_id,driver_id)
);

create table if not exists public.driver_expenses (
  id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id) on delete cascade,
  driver_id uuid not null references public.drivers(id) on delete cascade, rule_id uuid,
  expense_date date not null, category text not null, description text not null,
  amount numeric(12,2) not null check(amount >= 0), supplier text, notes text, payment_method text,
  receipt_path text, business_use_percent numeric(5,2) not null default 100 check(business_use_percent between 0 and 100),
  accounting_treatment text not null default 'review' check(accounting_treatment in ('expense','capital','mixed_use','review')),
  occurrence_key text, skipped boolean not null default false, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  foreign key(rule_id) references public.driver_expense_rules(id) on delete set null,
  unique(company_id,driver_id,occurrence_key), unique(id,company_id,driver_id)
);

create table if not exists public.driver_income_adjustments (
  id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id) on delete cascade,
  driver_id uuid not null references public.drivers(id) on delete cascade, effective_date date not null,
  amount numeric(12,2) not null, adjustment_type text not null check(adjustment_type in ('adjustment','refund')),
  reason text not null, created_by uuid not null references auth.users(id), created_at timestamptz not null default now(),
  unique(id,company_id,driver_id)
);

create table if not exists public.driver_finance_audit (
  id bigint generated always as identity primary key, company_id uuid not null references public.companies(id) on delete cascade,
  driver_id uuid not null references public.drivers(id) on delete cascade, actor_type text not null check(actor_type in ('driver','admin','system')),
  actor_id text not null, action text not null, entity_type text not null, entity_id text, details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists driver_expenses_owner_date_idx on public.driver_expenses(company_id,driver_id,expense_date desc);
create index if not exists driver_expense_rules_owner_idx on public.driver_expense_rules(company_id,driver_id,active);
create index if not exists driver_income_adjustments_owner_date_idx on public.driver_income_adjustments(company_id,driver_id,effective_date desc);
create index if not exists driver_finance_audit_owner_idx on public.driver_finance_audit(company_id,driver_id,created_at desc);

alter table public.driver_expense_rules enable row level security;
alter table public.driver_expenses enable row level security;
alter table public.driver_income_adjustments enable row level security;
alter table public.driver_finance_audit enable row level security;
revoke all on public.driver_expense_rules,public.driver_expenses,public.driver_income_adjustments,public.driver_finance_audit from public,anon,authenticated;
grant all on public.driver_expense_rules,public.driver_expenses,public.driver_income_adjustments,public.driver_finance_audit to service_role;
grant usage,select on sequence public.driver_finance_audit_id_seq to service_role;

create or replace function public.driver_accounts_admin(c uuid) returns boolean language sql stable security definer set search_path=public as $$
 select auth.uid() is not null and exists(select 1 from public.company_users u where u.company_id=c and u.user_id=auth.uid() and lower(u.role) in ('admin','owner'))
$$;
revoke all on function public.driver_accounts_admin(uuid) from public,anon;
grant execute on function public.driver_accounts_admin(uuid) to authenticated,service_role;

create policy driver_expense_rules_admin_select on public.driver_expense_rules for select to authenticated using(public.driver_accounts_admin(company_id));
create policy driver_expenses_admin_select on public.driver_expenses for select to authenticated using(public.driver_accounts_admin(company_id));
create policy driver_adjustments_admin_select on public.driver_income_adjustments for select to authenticated using(public.driver_accounts_admin(company_id));
create policy driver_finance_audit_admin_select on public.driver_finance_audit for select to authenticated using(public.driver_accounts_admin(company_id));

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('driver-expense-receipts','driver-expense-receipts',false,3145728,array['image/jpeg','image/png','image/webp','application/pdf'])
on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;

revoke all on function public.driver_accounts_admin(uuid) from public;
notify pgrst,'reload schema';
commit;
