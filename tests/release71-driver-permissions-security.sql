create function pg_temp.assert(ok boolean,label text) returns void language plpgsql as $$begin if ok is distinct from true then raise exception 'ASSERT: %',label;end if;end$$;
do $$begin
 perform pg_temp.assert(has_column_privilege('authenticated','public.drivers','id','SELECT'),'existing safe driver column remains readable');
 perform pg_temp.assert(has_column_privilege('authenticated','public.drivers','driver_expenses_enabled','SELECT'),'expenses flag readable to authenticated Admin query');
 perform pg_temp.assert(has_column_privilege('authenticated','public.drivers','driver_accounts_enabled','SELECT'),'legacy flag readable during compatibility period');
 perform pg_temp.assert(not has_table_privilege('authenticated','public.drivers','UPDATE'),'browser cannot update drivers directly');
 perform pg_temp.assert(not has_table_privilege('anon','public.drivers','SELECT'),'anonymous driver read denied');
 perform pg_temp.assert((select relrowsecurity from pg_class where oid='public.drivers'::regclass),'driver RLS remains enabled');
 perform pg_temp.assert((select count(*)=2 from pg_policies where schemaname='public' and tablename='drivers' and 'authenticated'=any(roles)),'tenant policies remain present');
end$$;
select 'release 7.1 driver permission security transaction passed; no records created' as result;
