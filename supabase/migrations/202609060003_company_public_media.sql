-- Additive company-scoped public image settings. Proposed only; do not apply automatically.

begin;

alter table public.settings add column if not exists homeheroimage text;
alter table public.settings add column if not exists bookingheroimage text;
alter table public.settings add column if not exists fleetimage text;

-- These are public image URLs, not credentials. Existing settings RLS continues
-- to control row visibility and authenticated writes remain company-scoped.
grant select (homeheroimage, bookingheroimage, fleetimage)
on table public.settings
to anon;

commit;

notify pgrst, 'reload schema';
