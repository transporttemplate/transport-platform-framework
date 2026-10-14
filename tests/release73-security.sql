create function pg_temp.assert(ok boolean,label text) returns void language plpgsql as $$begin if ok is distinct from true then raise exception 'ASSERT: %',label;end if;end$$;
do $$declare c uuid;begin
 select id into c from public.companies where company_code='0001';
 perform pg_temp.assert((select relrowsecurity from pg_class where oid='public.driver_messages'::regclass),'messages RLS');
 perform pg_temp.assert((select relrowsecurity from pg_class where oid='public.driver_gps_points'::regclass),'GPS RLS');
 perform pg_temp.assert(not has_table_privilege('authenticated','public.driver_bank_accounts','SELECT'),'bank details denied');
 perform pg_temp.assert((select not can_permanently_delete_bookings from public.company_users where company_id=c limit 1),'deletion permission defaults off');
 perform pg_temp.assert((select driver_expenses_enabled from public.drivers where company_id=(select id from public.companies where company_code='0003') and driver_number='301' and lower(full_name)='jeff bailey'),'Jeff 301 expenses retained');
end$$;
select 'release 7.3 rollback security transaction passed; no production records changed' as result;
