-- Proposed only: do not apply until reviewed and approved.
-- Adds reusable hostname-to-company resolution without changing company data.

begin;

create table if not exists public.company_domains (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  hostname text not null,
  is_primary boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint company_domains_hostname_format check (
    hostname = lower(trim(hostname))
    and hostname !~ '[:/]'
    and hostname ~ '^[a-z0-9.-]+$'
  )
);

create unique index if not exists company_domains_hostname_unique
  on public.company_domains (lower(hostname));

create unique index if not exists company_domains_one_primary_per_company
  on public.company_domains (company_id)
  where is_primary is true and active is true;

create index if not exists company_domains_company_idx
  on public.company_domains (company_id, active);

alter table public.company_domains enable row level security;

revoke all on table public.company_domains from public, anon, authenticated;
grant select (company_id, hostname, is_primary, active)
  on table public.company_domains to anon, authenticated;

drop policy if exists public_active_company_domains on public.company_domains;
drop policy if exists authenticated_company_domains on public.company_domains;

create policy public_active_company_domains
on public.company_domains
for select
to anon
using (active is true);

create policy authenticated_company_domains
on public.company_domains
for select
to authenticated
using (public.user_can_access_company(company_id));

commit;

notify pgrst, 'reload schema';
