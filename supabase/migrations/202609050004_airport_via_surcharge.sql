-- Additive company-specific surcharge for intermediate stops on fixed-price
-- airport bookings. Existing settings rows receive a safe zero default.

begin;

alter table public.settings
  add column if not exists airportviasurcharge numeric not null default 0;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.settings'::regclass
      and conname = 'settings_airportviasurcharge_nonnegative'
  ) then
    alter table public.settings
      add constraint settings_airportviasurcharge_nonnegative
      check (airportviasurcharge >= 0);
  end if;
end
$$;

-- This is public pricing configuration, not a credential. Anonymous clients
-- need only column-level SELECT so they can display an estimate; existing RLS
-- continues to govern which company settings row is visible.
grant select (airportviasurcharge) on table public.settings to anon;

notify pgrst, 'reload schema';

commit;
