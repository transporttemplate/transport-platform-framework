begin;

alter table public.drivers add column if not exists driver_expenses_enabled boolean not null default false;
update public.drivers set driver_expenses_enabled=true where driver_accounts_enabled=true and driver_expenses_enabled=false;

-- Drivers remains column-restricted. The new flags are safe Admin controls;
-- tenant visibility is still enforced by the existing restrictive RLS policy.
grant select(driver_accounts_enabled,driver_expenses_enabled) on public.drivers to authenticated;

notify pgrst,'reload schema';
commit;
