-- Allow only the server-side service role to validate and revoke driver sessions.
-- RLS remains enabled and no browser role receives access.

begin;

grant select on table public.companies, public.settings, public.company_users to service_role;
grant select, insert, update on table public.drivers to service_role;
grant select, update on table public.bookings to service_role;
grant select on table public.booking_stops to service_role;
grant select, insert, update on table public.driver_unavailability to service_role;
grant select, update, delete on table public.driver_sessions to service_role;

commit;
