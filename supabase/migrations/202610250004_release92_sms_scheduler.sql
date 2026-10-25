-- Release 9.2 scheduler installation. Supabase pg_cron is internal and incurs
-- no separate external scheduler account or customer-message activation.
begin;
create extension if not exists pg_cron with schema cron;
select cron.unschedule(jobid) from cron.job where jobname='release92-sms-automation';
select cron.schedule('release92-sms-automation','* * * * *','select public.sms_scheduler_tick()');
commit;
