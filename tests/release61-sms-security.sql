create function pg_temp.assert(ok boolean,label text) returns void language plpgsql as $$begin if ok is distinct from true then raise exception 'ASSERT: %',label;end if;end$$;
insert into public.companies(id,name,company_code) values('61000000-0000-0000-0000-000000000001','Release 6.1 rollback company','9911');
insert into public.settings(company_id) values('61000000-0000-0000-0000-000000000001');
do $$declare c uuid:='61000000-0000-0000-0000-000000000001';t uuid;begin
 perform pg_temp.assert((select count(*)=13 from public.sms_templates where company_id=c and enabled),'13 enabled templates');
 perform pg_temp.assert((select count(*)=15 from public.sms_automation_rules where company_id=c and enabled),'15 enabled rules');
 perform pg_temp.assert((select not sending_enabled from public.sms_settings where company_id=c),'new company sending disabled');
 perform pg_temp.assert((select notification_channels->'customer_booking_confirmation'='["email","sms"]'::jsonb from public.settings where company_id=c),'email and SMS channel');
 perform pg_temp.assert((select bool_and(marketing=(template_key='review_request')) from public.sms_templates where company_id=c),'marketing classification');
 select id into t from public.sms_templates where company_id=c and template_key='customer_confirmation';
 begin insert into public.sms_automation_rules(company_id,name,trigger_key,recipient_type,template_id,enabled) values(c,'duplicate','booking_created','customer',t,true);raise exception 'duplicate allowed';exception when unique_violation then null;end;
 perform pg_temp.assert(not exists(select 1 from public.sms_messages where company_id=c),'provisioning queued no history');
end$$;
select 'release 6.1 catalogue security transaction passed; all synthetic data rolled back' as result;
