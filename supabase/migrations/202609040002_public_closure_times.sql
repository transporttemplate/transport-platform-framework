-- Additive support for precise company closure windows.
begin;

alter table public.settings add column if not exists holidayfromtime time;
alter table public.settings add column if not exists holidaytotime time;

notify pgrst, 'reload schema';

commit;
