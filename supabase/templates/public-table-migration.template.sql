-- Copy this block into every migration that creates a public-schema table.
-- Replace example_records and choose only the role/operations the feature uses.

begin;

create table public.example_records (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.example_records enable row level security;

-- A new table is private until its intended Data API surface is stated.
revoke all on table public.example_records
  from public, anon, authenticated, service_role;

-- Server workflow example. Do not use GRANT ALL.
grant select, insert, update on table public.example_records to service_role;

-- Add authenticated grants only when browser code directly uses the table.
-- grant select, insert on table public.example_records to authenticated;

-- Add an anonymous grant only for an intentionally public projection. Prefer
-- column-level SELECT, and always pair it with a restrictive anon RLS policy.
-- grant select (id, company_id) on table public.example_records to anon;

create policy example_records_tenant_select
on public.example_records
for select to authenticated
using (public.user_can_access_company(company_id));

-- Identity/serial sequences need separate privileges when INSERT is granted.
-- grant usage, select on sequence public.example_records_id_seq to service_role;

notify pgrst, 'reload schema';

commit;
