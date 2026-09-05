-- Apply only after all three conditions are satisfied:
--   1. GOOGLE_ROUTES_API_KEY is configured as an Edge Function secret.
--   2. The server-authoritative public-booking-create function is deployed.
--   3. Normal and multiple-stop public booking tests pass against that function.
--
-- This migration removes only the obsolete anonymous booking-stop path.

begin;

drop policy if exists public_insert_booking_stops on public.booking_stops;

revoke all on table public.booking_stops from public, anon;
revoke all on function public.booking_matches_company(uuid, uuid)
  from public, anon;

-- Preserve the current Admin UI and Edge Function paths explicitly.
grant select, insert on table public.booking_stops to authenticated;
grant select, insert on table public.booking_stops to service_role;

notify pgrst, 'reload schema';

commit;
