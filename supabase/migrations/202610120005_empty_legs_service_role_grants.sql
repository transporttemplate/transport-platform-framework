-- Release 5 production fix: permit the authorised Empty Legs Edge Function to
-- access its tables through the service-role client. RLS and authenticated
-- company policies remain unchanged.

begin;

grant select, insert, update on table
  public.empty_leg_listings,
  public.empty_leg_requests,
  public.empty_leg_audit
to service_role;

notify pgrst, 'reload schema';

commit;
