-- Restore public-safe company settings reads and tenant-scope service areas.
-- Existing unscoped service areas are assigned automatically only when the
-- database contains exactly one company. Otherwise this migration aborts.

begin;

alter table public.service_areas add column if not exists company_id uuid;

do $$
declare
  company_count integer;
  only_company_id uuid;
begin
  if exists (select 1 from public.service_areas where company_id is null) then
    select count(*) into company_count from public.companies;
    select id into only_company_id from public.companies order by id limit 1;
    if company_count <> 1 then
      raise exception 'Cannot safely assign existing service areas: expected exactly one company, found %', company_count;
    end if;
    update public.service_areas set company_id = only_company_id where company_id is null;
  end if;
end $$;

alter table public.service_areas alter column company_id set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'service_areas_company_id_fkey'
      and conrelid = 'public.service_areas'::regclass
  ) then
    alter table public.service_areas
      add constraint service_areas_company_id_fkey
      foreign key (company_id) references public.companies(id) on delete cascade;
  end if;
end $$;

create index if not exists service_areas_company_active_idx
  on public.service_areas(company_id, active, sort_order, area_name);

alter table public.service_areas enable row level security;
alter table public.settings enable row level security;

revoke all on table public.service_areas from anon;
grant select (id, company_id, area_name, postcode_prefix, radius_miles, active, sort_order)
  on public.service_areas to anon;

revoke all on table public.settings from anon;
grant select (
  company_id, companyname, tradingname, companyphone, companyemail,
  companyaddress, companylogo, currencysymbol, allowairportoutsidearea,
  primarycolour, secondarycolour, accentcolour, buttoncolour,
  buttontextcolour, businessstatus, holidayfrom, holidayfromtime,
  holidayto, holidaytotime, websitenotice, acceptadvancebookings,
  bookwhileclosed, closedmessage, timezone, airportpricing,
  distancecalculator, maxadvancedays, minimumnotice, googlemapsapi,
  minimumfare, firstmile, mileband1, mileband2, mileband3, mileband4,
  mileband5, mileband6, bookingfee, returndiscount
) on public.settings to anon;

grant select, insert, update, delete on table public.service_areas to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='service_areas' and policyname='public_active_service_areas') then
    create policy public_active_service_areas on public.service_areas
      for select to anon using (active = true and company_id is not null);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='service_areas' and policyname='public_active_service_areas_restrictive') then
    create policy public_active_service_areas_restrictive on public.service_areas
      as restrictive for select to anon using (active = true and company_id is not null);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='service_areas' and policyname='admin_company_service_areas') then
    create policy admin_company_service_areas on public.service_areas
      for all to authenticated
      using (public.user_can_access_company(company_id))
      with check (public.user_can_access_company(company_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='service_areas' and policyname='admin_company_service_areas_restrictive') then
    create policy admin_company_service_areas_restrictive on public.service_areas
      as restrictive for all to authenticated
      using (public.user_can_access_company(company_id))
      with check (public.user_can_access_company(company_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='settings' and policyname='public_company_settings') then
    create policy public_company_settings on public.settings
      for select to anon using (company_id is not null);
  end if;
end $$;

notify pgrst, 'reload schema';

commit;
