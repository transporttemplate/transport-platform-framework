-- Edge Functions use the service-role client. RLS remains enabled for
-- authenticated browser access; anon and tenant grants are unchanged.
begin;
revoke all on public.driver_documents, public.email_messages, public.email_attempts from service_role;
grant select, insert, update, delete on public.driver_documents, public.email_messages, public.email_attempts to service_role;
notify pgrst,'reload schema';
commit;
