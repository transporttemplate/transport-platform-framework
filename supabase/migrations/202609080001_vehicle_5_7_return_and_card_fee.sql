-- Additive follow-up for the separate 5-7 tier and optional card booking fee.
begin;
alter table public.settings add column if not exists allowvehicle_5_7 boolean;
alter table public.settings add column if not exists vehicleuplift_5_7_percent numeric;
alter table public.settings add column if not exists enablecardbookingfee boolean not null default false;
alter table public.settings add column if not exists cardbookingfeepercent numeric;
alter table public.bookings add column if not exists journey_fare numeric;
alter table public.bookings add column if not exists card_booking_fee_percent numeric;
alter table public.bookings add column if not exists card_booking_fee_amount numeric;
alter table public.bookings drop constraint if exists bookings_vehicle_tier_valid;
alter table public.bookings add constraint bookings_vehicle_tier_valid check (vehicle_tier is null or vehicle_tier in ('standard','5_7','5_8','9_16','17_23','24_52'));
do $$ begin
  if not exists(select 1 from pg_constraint where conname='settings_vehicle_5_7_uplift_valid' and conrelid='public.settings'::regclass) then alter table public.settings add constraint settings_vehicle_5_7_uplift_valid check (vehicleuplift_5_7_percent is null or vehicleuplift_5_7_percent between 0 and 500); end if;
  if not exists(select 1 from pg_constraint where conname='settings_card_booking_fee_valid' and conrelid='public.settings'::regclass) then alter table public.settings add constraint settings_card_booking_fee_valid check (cardbookingfeepercent is null or cardbookingfeepercent between 0 and 100); end if;
  if not exists(select 1 from pg_constraint where conname='bookings_card_booking_fee_valid' and conrelid='public.bookings'::regclass) then alter table public.bookings add constraint bookings_card_booking_fee_valid check ((journey_fare is null or journey_fare >= 0) and (card_booking_fee_percent is null or card_booking_fee_percent between 0 and 100) and (card_booking_fee_amount is null or card_booking_fee_amount >= 0)); end if;
end $$;
grant select (allowvehicle_5_7,vehicleuplift_5_7_percent,enablecardbookingfee,cardbookingfeepercent) on public.settings to anon;
grant select (journey_fare,card_booking_fee_percent,card_booking_fee_amount) on public.bookings to authenticated;
commit;
notify pgrst, 'reload schema';
