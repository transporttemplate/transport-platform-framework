create function pg_temp.assert(ok boolean,label text) returns void language plpgsql as $$begin if ok is distinct from true then raise exception 'ASSERT: %',label;end if;end$$;
insert into public.companies(id,name,company_code) values('70000000-0000-0000-0000-000000000001','Release 7 rollback company','9971');
insert into public.drivers(id,company_id,driver_number,full_name,status,driver_accounts_enabled) values
('70000000-0000-0000-0000-000000000011','70000000-0000-0000-0000-000000000001','R7A','Release Seven A','available',true),
('70000000-0000-0000-0000-000000000012','70000000-0000-0000-0000-000000000001','R7B','Release Seven B','available',false);
do $$declare c uuid:='70000000-0000-0000-0000-000000000001';d uuid:='70000000-0000-0000-0000-000000000011';r uuid;begin
 perform pg_temp.assert((select driver_accounts_enabled from public.drivers where id=d),'explicit enable retained');
 perform pg_temp.assert(not (select driver_accounts_enabled from public.drivers where id='70000000-0000-0000-0000-000000000012'),'default/disabled retained');
 insert into public.driver_expense_rules(company_id,driver_id,category,description,amount,frequency,start_date) values(c,d,'insurance','Test monthly',250.00,'monthly','2026-04-06') returning id into r;
 insert into public.driver_expenses(company_id,driver_id,rule_id,expense_date,category,description,amount,occurrence_key) values(c,d,r,'2026-04-06','insurance','Test monthly',250.00,r||':2026-04-06');
 begin insert into public.driver_expenses(company_id,driver_id,rule_id,expense_date,category,description,amount,occurrence_key) values(c,d,r,'2026-04-06','insurance','Duplicate',250.00,r||':2026-04-06');raise exception 'duplicate occurrence allowed';exception when unique_violation then null;end;
 perform pg_temp.assert((select count(*)=1 from public.driver_expenses where company_id=c),'one occurrence only');
 perform pg_temp.assert((select relrowsecurity from pg_class where oid='public.driver_expenses'::regclass),'expense RLS active');
 perform pg_temp.assert(not has_table_privilege('authenticated','public.driver_expenses','INSERT'),'browser cannot forge expenses');
 perform pg_temp.assert(not has_table_privilege('authenticated','public.driver_finance_audit','UPDATE'),'audit update denied');
end$$;
select 'release 7 driver accounts security transaction passed; all synthetic data rolled back' as result;
