-- Additive company-scoped vehicle-capacity availability and pricing tiers.
begin;
alter table public.settings add column if not exists allowvehicle_standard boolean;
alter table public.settings add column if not exists allowvehicle_5_8 boolean;
alter table public.settings add column if not exists allowvehicle_9_16 boolean;
alter table public.settings add column if not exists allowvehicle_17_23 boolean;
alter table public.settings add column if not exists allowvehicle_24_52 boolean;
alter table public.settings add column if not exists vehicleuplift_5_8_percent numeric;
alter table public.settings add column if not exists vehicleuplift_9_16_percent numeric;
alter table public.settings add column if not exists vehicleuplift_17_23_percent numeric;
alter table public.settings add column if not exists vehicleuplift_24_52_percent numeric;
alter table public.bookings add column if not exists vehicle_tier text;
do $$ begin
  if not exists(select 1 from pg_constraint where conname='settings_vehicle_uplifts_valid' and conrelid='public.settings'::regclass) then alter table public.settings add constraint settings_vehicle_uplifts_valid check ((vehicleuplift_5_8_percent is null or vehicleuplift_5_8_percent between 0 and 500) and (vehicleuplift_9_16_percent is null or vehicleuplift_9_16_percent between 0 and 500) and (vehicleuplift_17_23_percent is null or vehicleuplift_17_23_percent between 0 and 500) and (vehicleuplift_24_52_percent is null or vehicleuplift_24_52_percent between 0 and 500)); end if;
  if not exists(select 1 from pg_constraint where conname='bookings_vehicle_tier_valid' and conrelid='public.bookings'::regclass) then alter table public.bookings add constraint bookings_vehicle_tier_valid check (vehicle_tier is null or vehicle_tier in ('standard','5_8','9_16','17_23','24_52')); end if;
end $$;
grant select (allowvehicle_standard,allowvehicle_5_8,allowvehicle_9_16,allowvehicle_17_23,allowvehicle_24_52,vehicleuplift_5_8_percent,vehicleuplift_9_16_percent,vehicleuplift_17_23_percent,vehicleuplift_24_52_percent) on public.settings to anon;
grant select (vehicle_tier) on public.bookings to authenticated;
commit;
notify pgrst, 'reload schema';
