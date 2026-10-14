begin;

-- Edge Functions use service_role and require explicit privileges on tables
-- created after the original Driver Portal service grants.
grant select,insert,update,delete on public.driver_messages to service_role;
grant select,insert,update,delete on public.driver_gps_points to service_role;
grant usage,select on sequence public.driver_gps_points_id_seq to service_role;

-- Keep browser access to drivers restricted to the established safe columns.
-- New Release 7.3 fields are returned only by the authenticated, company-scoped
-- Driver Portal Admin API rather than widening table or column grants.
revoke select(active,licence_authority,customer_phone_sharing,public_contact_phone,portal_theme,portal_text_size) on public.drivers from authenticated;

notify pgrst,'reload schema';
commit;
