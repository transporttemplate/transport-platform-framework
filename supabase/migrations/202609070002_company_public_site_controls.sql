-- Additive company-scoped public website controls.

begin;

alter table public.settings add column if not exists contactheroimage text;

alter table public.settings add column if not exists publicbackgroundcolour text default '#0b0b0b';
alter table public.settings add column if not exists publiccardcolour text default '#1a1a1a';
alter table public.settings add column if not exists publicheadercolour text default '#111111';
alter table public.settings add column if not exists publictextcolour text default '#ffffff';
alter table public.settings add column if not exists publicmutedcolour text default '#bdbdbd';
alter table public.settings add column if not exists publicfootercolour text default '#080808';

alter table public.settings add column if not exists mon24hours boolean not null default false;
alter table public.settings add column if not exists tue24hours boolean not null default false;
alter table public.settings add column if not exists wed24hours boolean not null default false;
alter table public.settings add column if not exists thu24hours boolean not null default false;
alter table public.settings add column if not exists fri24hours boolean not null default false;
alter table public.settings add column if not exists sat24hours boolean not null default false;
alter table public.settings add column if not exists sun24hours boolean not null default false;

grant select (
  contactheroimage,
  publicbackgroundcolour, publiccardcolour, publicheadercolour,
  publictextcolour, publicmutedcolour, publicfootercolour,
  monopen, monclose, monenabled, mon24hours,
  tueopen, tueclose, tueenabled, tue24hours,
  wedopen, wedclose, wedenabled, wed24hours,
  thuopen, thuclose, thuenabled, thu24hours,
  friopen, friclose, frienabled, fri24hours,
  satopen, satclose, satenabled, sat24hours,
  sunopen, sunclose, sunenabled, sun24hours
) on table public.settings to anon;

create table if not exists public.fleet_items (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  active boolean not null default true,
  title text not null,
  description text,
  image_url text,
  sort_order integer not null default 0,
  passenger_capacity integer,
  luggage_capacity integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fleet_items_title_not_blank check (length(btrim(title)) > 0),
  constraint fleet_items_passenger_capacity_nonnegative check (passenger_capacity is null or passenger_capacity >= 0),
  constraint fleet_items_luggage_capacity_nonnegative check (luggage_capacity is null or luggage_capacity >= 0)
);

create index if not exists fleet_items_company_active_sort_idx
  on public.fleet_items(company_id, active, sort_order, title);

alter table public.fleet_items enable row level security;

revoke all on table public.fleet_items from public, anon, authenticated;
grant select (
  id, company_id, active, title, description, image_url,
  sort_order, passenger_capacity, luggage_capacity
) on table public.fleet_items to anon;
grant select, insert, update, delete on table public.fleet_items to authenticated;

drop policy if exists public_active_fleet_items on public.fleet_items;
drop policy if exists admin_company_fleet_items on public.fleet_items;

create policy public_active_fleet_items
on public.fleet_items for select to anon
using (active is true and company_id is not null);

create policy admin_company_fleet_items
on public.fleet_items for all to authenticated
using (public.user_can_access_company(company_id))
with check (public.user_can_access_company(company_id));

commit;

notify pgrst, 'reload schema';
