-- Driver Portal reads these tables with the service role. Writes remain behind
-- the audited tenant-scoped RPCs installed by the vehicle-linking release.
grant select on table public.driver_vehicle_links to service_role;
grant select on table public.driver_vehicle_assignments to service_role;
