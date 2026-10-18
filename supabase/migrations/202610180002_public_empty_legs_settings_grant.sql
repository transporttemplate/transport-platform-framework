-- Restore the two public-safe Empty Legs visibility flags to the anonymous
-- website settings projection. RLS continues to govern tenant row access.

begin;

alter table public.settings enable row level security;

grant select (
  empty_legs_enabled,
  empty_legs_public_enabled
) on table public.settings to anon;

notify pgrst, 'reload schema';

commit;
