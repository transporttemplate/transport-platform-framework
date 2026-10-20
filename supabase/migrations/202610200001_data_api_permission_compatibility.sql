-- Supabase Data API compatibility for the 30 October 2026 grant change.
--
-- New public-schema tables must declare grants explicitly. This migration does
-- not rewrite established production grants; it removes one obsolete anonymous
-- table grant from the private membership table discovered by the live audit.
-- RLS remains enabled and unchanged because object grants and RLS are separate.

begin;

revoke all on table public.company_users from public, anon;

notify pgrst, 'reload schema';

commit;
