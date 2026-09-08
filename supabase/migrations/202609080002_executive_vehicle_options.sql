-- Additive executive vehicle availability and pricing options.
begin;

alter table public.settings add column if not exists allowvehicle_executive_car boolean not null default false;
alter table public.settings add column if not exists allowvehicle_executive_5_7 boolean not null default false;
alter table public.settings add column if not exists vehicleuplift_executive_car_percent numeric;
alter table public.settings add column if not exists vehicleuplift_executive_5_7_percent numeric;

do $$ begin
  if not exists(select 1 from pg_constraint where conname='settings_executive_vehicle_uplifts_valid' and conrelid='public.settings'::regclass) then
    alter table public.settings add constraint settings_executive_vehicle_uplifts_valid check (
      (vehicleuplift_executive_car_percent is null or vehicleuplift_executive_car_percent between 0 and 500)
      and (vehicleuplift_executive_5_7_percent is null or vehicleuplift_executive_5_7_percent between 0 and 500)
    );
  end if;
end $$;

alter table public.bookings drop constraint if exists bookings_vehicle_tier_valid;
alter table public.bookings add constraint bookings_vehicle_tier_valid check (
  vehicle_tier is null or vehicle_tier in (
    'standard','executive_car','5_7','executive_5_7','5_8','9_16','17_23','24_52'
  )
);

grant select (
  allowvehicle_executive_car,
  allowvehicle_executive_5_7,
  vehicleuplift_executive_car_percent,
  vehicleuplift_executive_5_7_percent
) on public.settings to anon;

commit;
notify pgrst, 'reload schema';
