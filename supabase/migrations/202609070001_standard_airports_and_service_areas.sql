-- Standard company airport catalogue and confirmed fixed-price service areas.
--
-- This migration is data-only and idempotent:
--   * company UUIDs are resolved from company_code;
--   * existing airport fare/deposit values are never updated;
--   * missing airport fares are left NULL by omitting them from INSERT;
--   * no service areas are invented for template company 0001 or company 0003;
--   * existing template service-area rows are retained but made inactive so
--     the reusable template does not advertise a misleading geography.

begin;

do $$
declare
  target_company record;
  airport_seed record;
  existing_airport_id public.airports.id%TYPE;
begin
  for target_company in
    select id, company_code
    from public.companies
    where company_code in ('0001', '0002', '0003')
  loop
    -- Deal with Southampton Port first. Company 0001 currently has a cruise
    -- terminal stored under SOU; moving that existing row preserves its fares
    -- and frees SOU for Southampton Airport.
    select id
      into existing_airport_id
    from public.airports
    where company_id = target_company.id
      and (
        upper(coalesce(code, '')) = 'SOU_PORT'
        or (
          lower(coalesce(name, '')) like '%southampton%'
          and lower(coalesce(name, '')) ~ '(port|cruise|terminal)'
        )
      )
    order by
      case when upper(coalesce(code, '')) = 'SOU_PORT' then 0 else 1 end,
      id
    limit 1;

    if existing_airport_id is null then
      insert into public.airports (
        company_id, name, code, active, sort_order
      ) values (
        target_company.id, 'Southampton Cruise Port', 'SOU_PORT', true, 10
      );
    else
      update public.airports
      set name = 'Southampton Cruise Port',
          code = 'SOU_PORT',
          active = true,
          sort_order = 10
      where id = existing_airport_id
        and company_id = target_company.id;
    end if;

    for airport_seed in
      select *
      from (values
        ('CWL'::text, 'Cardiff Airport'::text, 1),
        ('BRS'::text, 'Bristol Airport'::text, 2),
        ('LHR'::text, 'London Heathrow Airport'::text, 3),
        ('LGW'::text, 'London Gatwick Airport'::text, 4),
        ('LTN'::text, 'London Luton Airport'::text, 5),
        ('MAN'::text, 'Manchester Airport'::text, 6),
        ('BHX'::text, 'Birmingham Airport'::text, 7),
        ('STN'::text, 'London Stansted Airport'::text, 8),
        ('SOU'::text, 'Southampton Airport'::text, 9)
      ) as seed(code, name, sort_order)
    loop
      existing_airport_id := null;

      select id
        into existing_airport_id
      from public.airports
      where company_id = target_company.id
        and upper(coalesce(code, '')) = airport_seed.code
      order by id
      limit 1;

      if existing_airport_id is null then
        insert into public.airports (
          company_id, name, code, active, sort_order
        ) values (
          target_company.id,
          airport_seed.name,
          airport_seed.code,
          true,
          airport_seed.sort_order
        );
      else
        update public.airports
        set name = airport_seed.name,
            code = airport_seed.code,
            active = true,
            sort_order = airport_seed.sort_order
        where id = existing_airport_id
          and company_id = target_company.id;
      end if;
    end loop;
  end loop;
end $$;

-- Company 0001 is a reusable template/test site, not an operating geography.
-- Preserve its existing rows for reference but exclude them from public fixed-
-- price coverage by making them inactive.
update public.service_areas
set active = false,
    updated_at = now()
where company_id = (
  select id from public.companies where company_code = '0001'
)
and active is true;

-- Matt / company 0002: normalize the two confirmed Barry/Vale postcode
-- prefixes. radius_miles is NULL because the production booking function uses
-- postcode_prefix only and has no defined radius origin/calculation.
do $$
declare
  matt_company_id public.companies.id%TYPE;
  area_seed record;
  existing_area_id public.service_areas.id%TYPE;
begin
  select id into matt_company_id
  from public.companies
  where company_code = '0002';

  if matt_company_id is not null then
    for area_seed in
      select *
      from (values
        ('CF62'::text, 'Barry / Vale (CF62)'::text, 1),
        ('CF63'::text, 'Barry / Vale (CF63)'::text, 2)
      ) as seed(postcode_prefix, area_name, sort_order)
    loop
      existing_area_id := null;

      select id
        into existing_area_id
      from public.service_areas
      where company_id = matt_company_id
        and upper(regexp_replace(coalesce(postcode_prefix, ''), '\s+', '', 'g')) = area_seed.postcode_prefix
      order by id
      limit 1;

      if existing_area_id is null then
        insert into public.service_areas (
          company_id, area_name, postcode_prefix, radius_miles,
          active, sort_order, updated_at
        ) values (
          matt_company_id, area_seed.area_name, area_seed.postcode_prefix,
          null, true, area_seed.sort_order, now()
        );
      else
        update public.service_areas
        set area_name = area_seed.area_name,
            postcode_prefix = area_seed.postcode_prefix,
            radius_miles = null,
            active = true,
            sort_order = area_seed.sort_order,
            updated_at = now()
        where id = existing_area_id
          and company_id = matt_company_id;
      end if;
    end loop;
  end if;
end $$;

commit;
