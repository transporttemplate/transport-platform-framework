-- Release 9.2: self-service SMS control centre and durable scheduler.
begin;

alter table public.sms_settings
  add column if not exists daily_send_limit integer not null default 250 check (daily_send_limit between 1 and 5000),
  add column if not exists monthly_send_limit integer not null default 5000 check (monthly_send_limit between 1 and 100000),
  add column if not exists master_enabled_at timestamptz,
  add column if not exists master_enabled_by uuid,
  add column if not exists activation_reason text;
alter table public.sms_gateway_devices
  add column if not exists selected_sim text,
  add column if not exists gateway_running boolean not null default false,
  add column if not exists last_successful_send_at timestamptz,
  add column if not exists last_received_at timestamptz;
alter table public.sms_automation_rules
  add column if not exists expiry_minutes integer not null default 60 check (expiry_minutes between 5 and 10080);

-- The platform release gate is installed, but every tenant master remains OFF.
-- This makes later activation an authenticated company decision, not a deployment.
update public.sms_release_control set live_sending_enabled=true where id=true;
update public.sms_settings set sending_enabled=false,master_enabled_at=null,master_enabled_by=null;
update public.sms_messages set state='cancelled',error_code='MASTER_DISABLED_DEPLOYMENT'
where state in('queued','claimed');

create or replace function public.sms_provision_company(c uuid,refresh_catalogue boolean default false)
returns void language plpgsql security definer set search_path='' as $$
begin
 insert into public.sms_settings(company_id,enabled,sending_enabled) values(c,false,false) on conflict(company_id) do nothing;
 insert into public.sms_templates(company_id,template_key,name,body,enabled,marketing)
 select c,t.template_key,t.name,t.body,false,t.marketing from public.sms_default_templates() t
 on conflict(company_id,template_key) do update set
  name=case when refresh_catalogue then excluded.name else sms_templates.name end,
  body=case when refresh_catalogue then excluded.body else sms_templates.body end,
  marketing=case when excluded.template_key='review_request' then true else sms_templates.marketing end,
  updated_at=case when refresh_catalogue then now() else sms_templates.updated_at end;
 insert into public.sms_automation_rules(company_id,name,trigger_key,recipient_type,conditions,delay_minutes,template_id,enabled,sending_start,sending_end)
 select c,r.rule_name,r.trigger_key,r.recipient_type,'{}'::jsonb,r.delay_minutes,t.id,false,'00:00','00:00'
 from public.sms_default_rules() r join public.sms_templates t on t.company_id=c and t.template_key=r.template_key
 on conflict(company_id,trigger_key,recipient_type,md5(conditions::text)) do nothing;
 update public.settings set notification_channels=public.sms_default_channels(notification_channels) where company_id=c;
end $$;

-- Complete the requested catalogue without changing an existing company's choices.
insert into public.sms_templates(company_id,template_key,name,body,enabled,marketing)
select c.id,v.k,v.n,v.b,false,false from public.companies c cross join (values
 ('driver_allocated_customer','Driver allocated (customer)',E'{{company_name}}\n\nDriver allocated for {{booking_reference}}: {{driver_name}}, vehicle {{vehicle_registration}}.'),
 ('booking_changed','Booking changed',E'{{company_name}}\n\nBooking {{booking_reference}} has changed. Pickup is now {{pickup_date}} at {{pickup_time}} from {{pickup_address}}.'),
 ('external_booking_office','External API booking office alert',E'{{company_name}}\n\nNew {{provider_name}} booking {{booking_reference}}. Pickup {{pickup_time}}, {{pickup_address}} to {{destination_address}}. {{admin_link}}')
) v(k,n,b) on conflict(company_id,template_key) do nothing;

insert into public.sms_automation_rules(company_id,name,trigger_key,recipient_type,conditions,delay_minutes,template_id,enabled)
select t.company_id,v.n,v.k,v.r,v.cond,0,t.id,false from public.sms_templates t join (values
 ('driver_allocated','Driver allocated customer notification','customer','driver_allocated_customer','{}'::jsonb),
 ('booking_changed','Booking changed customer notification','customer','booking_changed','{}'::jsonb),
 ('external_booking_created','New external API booking office alert','office','external_booking_office','{}'::jsonb)
) v(k,n,r,tk,cond) on t.template_key=v.tk
on conflict(company_id,trigger_key,recipient_type,md5(conditions::text)) do nothing;

-- Capture changes separately from status transitions and identify external
-- bookings without activating any external provider connection.
create or replace function public.sms_booking_event() returns trigger language plpgsql security definer set search_path='' as $$
declare k text;begin
 if tg_op='INSERT' then
  k:=case when lower(coalesce(new.booking_source,'')) in('api','external','external_api','external_dispatch') then 'external_booking_created' else 'booking_created' end;
 elsif new.status is distinct from old.status then
  k:=case lower(new.status) when 'confirmed' then 'booking_confirmed' when 'on_way' then 'driver_on_route' when 'arrived' then 'driver_arrived' when 'passenger_onboard' then 'passenger_on_board' when 'completed' then 'booking_completed' when 'cancelled' then 'booking_cancelled' when 'canceled' then 'booking_cancelled' end;
 elsif row(new.journey_date,new.journey_time,new.pickup_address,new.dropoff_address) is distinct from row(old.journey_date,old.journey_time,old.pickup_address,old.dropoff_address) then k:='booking_changed';
 end if;
 if k is not null then insert into public.sms_automation_events(company_id,event_key,trigger_key,booking_id) values(new.company_id,new.id||':'||k||':'||extract(epoch from now())::bigint,k,new.id) on conflict do nothing;end if;
 if (tg_op='INSERT' and new.driver_id is not null) or (tg_op='UPDATE' and new.driver_id is distinct from old.driver_id and new.driver_id is not null) then
  insert into public.sms_automation_events(company_id,event_key,trigger_key,booking_id,driver_id) values(new.company_id,new.id||':driver_assigned:'||new.driver_id,'driver_assigned',new.id,new.driver_id) on conflict do nothing;
  insert into public.sms_automation_events(company_id,event_key,trigger_key,booking_id,driver_id) values(new.company_id,new.id||':driver_allocated:'||new.driver_id,'driver_allocated',new.id,new.driver_id) on conflict do nothing;
 end if;
 return new;
exception when others then insert into public.sms_gateway_audit(company_id,action,details) values(new.company_id,'automation_capture_error',jsonb_build_object('code',sqlstate));return new;
end $$;

update public.settings set notification_channels=notification_channels||jsonb_build_object(
 'booking_changed','["sms"]'::jsonb,'driver_allocated','["sms"]'::jsonb,'external_booking_created','["sms"]'::jsonb
);

-- Preserve the original RPC implementation behind a wrapper that adds Release
-- 9.2 activation controls without exposing credential-bearing tables.
alter function public.sms_admin(uuid,text,jsonb) rename to sms_admin_release6;
revoke all on function public.sms_admin_release6(uuid,text,jsonb) from public,anon,authenticated;

create function public.sms_admin(target_company_id uuid,action text,payload jsonb default '{}')
returns jsonb language plpgsql security definer set search_path='' as $$
declare c uuid:=target_company_id;base jsonb;dev record;ready jsonb;missing text[]:='{}';old_state boolean;new_state boolean;reason text;id1 uuid;val text;
begin
 if not public.sms_is_admin(c) then raise exception 'Authenticated company Admin required' using errcode='42501';end if;
 if action='snapshot' then
  base:=public.sms_admin_release6(c,action,payload);
  select * into dev from public.sms_gateway_devices where company_id=c and revoked_at is null order by created_at desc limit 1;
  if dev.id is null then missing:=array_append(missing,'Pair an Android gateway');end if;
  if dev.id is not null and (dev.last_heartbeat_at is null or dev.last_heartbeat_at<now()-interval '3 minutes') then missing:=array_append(missing,'Bring the gateway online');end if;
  if dev.id is not null and not coalesce((dev.permission_state->>'send_sms')::boolean,false) then missing:=array_append(missing,'Grant Android SMS sending permission');end if;
  if dev.id is not null and not coalesce((dev.permission_state->>'receive_sms')::boolean,false) then missing:=array_append(missing,'Grant Android SMS receiving permission');end if;
  if dev.id is not null and coalesce(dev.sim_status,'') not ilike '%state 5%' then missing:=array_append(missing,'Select a ready SIM');end if;
  if dev.id is not null and not coalesce(dev.gateway_running,true) then missing:=array_append(missing,'Start the gateway service');end if;
  if not exists(select 1 from public.sms_automation_rules where company_id=c and enabled) then missing:=array_append(missing,'Enable at least one automation rule (manual replies remain available)');end if;
  ready:=jsonb_build_object('ready',cardinality(missing)=0,'missing',to_jsonb(missing),'test_send_seen',coalesce(dev.sent_total,0)>0,'test_receive_seen',coalesce(dev.received_total,0)>0);
  base:=jsonb_set(base,'{devices}',coalesce((select jsonb_agg(jsonb_build_object('id',d.id,'device_name',d.device_name,'apk_version',d.apk_version,'revoked_at',d.revoked_at,'last_heartbeat_at',d.last_heartbeat_at,'sim_status',d.sim_status,'selected_sim',d.selected_sim,'gateway_running',d.gateway_running,'permission_state',d.permission_state,'network_status',d.network_status,'sent_total',d.sent_total,'received_total',d.received_total,'last_successful_send_at',d.last_successful_send_at,'last_received_at',d.last_received_at)) from public.sms_gateway_devices d where d.company_id=c),'[]'::jsonb));
  return base||jsonb_build_object('readiness',ready,'limits',(select jsonb_build_object('daily',daily_send_limit,'monthly',monthly_send_limit) from public.sms_settings where company_id=c));
 elsif action='master' then
  new_state:=coalesce((payload->>'enabled')::boolean,false);reason:=left(trim(coalesce(payload->>'reason','')),500);
  select coalesce(sending_enabled,false) into old_state from public.sms_settings where company_id=c for update;
  if new_state then
   if payload->>'confirmation'<>'ENABLE SMS' then raise exception 'Type ENABLE SMS to confirm activation';end if;
   select * into dev from public.sms_gateway_devices where company_id=c and revoked_at is null order by created_at desc limit 1;
   if dev.id is null or dev.last_heartbeat_at<now()-interval '3 minutes' or not coalesce((dev.permission_state->>'send_sms')::boolean,false) or not coalesce((dev.permission_state->>'receive_sms')::boolean,false) or coalesce(dev.sim_status,'') not ilike '%state 5%' then raise exception 'Gateway readiness checks have not passed';end if;
   if not exists(select 1 from public.sms_automation_rules where company_id=c and enabled) and not coalesce((payload->>'manual_only')::boolean,false) then raise exception 'Enable a rule or explicitly choose manual-only operation';end if;
   update public.sms_settings set enabled=true,sending_enabled=true,master_enabled_at=now(),master_enabled_by=auth.uid(),activation_reason=nullif(reason,''),updated_at=now() where company_id=c;
  else
   update public.sms_settings set sending_enabled=false,updated_at=now() where company_id=c;
   update public.sms_messages set state='cancelled',error_code='MASTER_DISABLED' where company_id=c and state in('queued','claimed');
  end if;
  insert into public.sms_gateway_audit(company_id,actor_id,action,details) values(c,auth.uid(),'master_changed',jsonb_build_object('previous',old_state,'new',new_state,'confirmed',payload->>'confirmation','reason',reason));
  return jsonb_build_object('ok',true,'enabled',new_state);
 elsif action='reply' and not coalesce((select sending_enabled from public.sms_settings where company_id=c),false) then
  raise exception 'Master SMS is OFF; manual replies are blocked';
 elsif action='template' then
  if length(trim(coalesce(payload->>'name',''))) not between 1 and 120 or length(trim(coalesce(payload->>'body',''))) not between 1 and 3500 then raise exception 'Template name/body required';end if;
  for val in select m[1] from regexp_matches(payload->>'body','\{\{([^}]+)\}\}','g') m loop
   if val not in('company_name','booking_reference','customer_name','pickup_date','pickup_time','pickup_address','destination_address','driver_name','driver_phone','vehicle_registration','vehicle_details','driver_contact_line','secure_tracking_link','google_review_link','provider_name','admin_link','document_label','expiry_date') then raise exception 'Unsupported template variable: %',val;end if;
  end loop;
  id1:=coalesce(nullif(payload->>'id','')::uuid,gen_random_uuid());
  if exists(select 1 from public.sms_templates where id=id1 and company_id<>c) then raise exception 'Template not found' using errcode='42501';end if;
  insert into public.sms_templates(id,company_id,template_key,name,body,enabled,marketing) values(id1,c,'custom:'||id1,payload->>'name',payload->>'body',coalesce((payload->>'enabled')::boolean,false),coalesce((payload->>'marketing')::boolean,false)) on conflict(id) do update set name=excluded.name,body=excluded.body,enabled=excluded.enabled,marketing=case when sms_templates.template_key='review_request' then true else excluded.marketing end,updated_at=now() where sms_templates.company_id=c;
  insert into public.sms_gateway_audit(company_id,actor_id,action,details) values(c,auth.uid(),'admin:template',jsonb_build_object('id',id1));return jsonb_build_object('ok',true,'id',id1);
 elsif action='rule' and payload->>'trigger_key' in('booking_changed','driver_allocated','external_booking_created') then
  if length(trim(coalesce(payload->>'name',''))) not between 1 and 120 or not exists(select 1 from public.sms_templates where id=(payload->>'template_id')::uuid and company_id=c) then raise exception 'Valid company rule and template required';end if;
  if payload->>'recipient_type' not in('customer','driver','office') then raise exception 'Invalid recipient';end if;
  id1:=coalesce(nullif(payload->>'id','')::uuid,gen_random_uuid());
  insert into public.sms_automation_rules(id,company_id,name,trigger_key,recipient_type,conditions,delay_minutes,template_id,enabled,sending_start,sending_end,expiry_minutes) values(id1,c,payload->>'name',payload->>'trigger_key',payload->>'recipient_type',coalesce(payload->'conditions','{}'),greatest(0,least(10080,coalesce((payload->>'delay_minutes')::int,0))),(payload->>'template_id')::uuid,coalesce((payload->>'enabled')::boolean,false),coalesce(nullif(payload->>'sending_start','')::time,'00:00'),coalesce(nullif(payload->>'sending_end','')::time,'00:00'),greatest(5,least(10080,coalesce((payload->>'expiry_minutes')::int,60)))) on conflict(id) do update set name=excluded.name,recipient_type=excluded.recipient_type,conditions=excluded.conditions,delay_minutes=excluded.delay_minutes,template_id=excluded.template_id,enabled=excluded.enabled,sending_start=excluded.sending_start,sending_end=excluded.sending_end,expiry_minutes=excluded.expiry_minutes,updated_at=now() where sms_automation_rules.company_id=c;
  insert into public.sms_gateway_audit(company_id,actor_id,action,details) values(c,auth.uid(),'admin:rule',jsonb_build_object('id',id1));return jsonb_build_object('ok',true,'id',id1);
 elsif action='limits' then
  update public.sms_settings set daily_send_limit=greatest(1,least(5000,(payload->>'daily')::integer)),monthly_send_limit=greatest(1,least(100000,(payload->>'monthly')::integer)),updated_at=now() where company_id=c;
  insert into public.sms_gateway_audit(company_id,actor_id,action,details) values(c,auth.uid(),'limits_changed',payload);
  return jsonb_build_object('ok',true);
 end if;
 return public.sms_admin_release6(c,action,payload);
end $$;
revoke all on function public.sms_admin(uuid,text,jsonb) from public,anon;
grant execute on function public.sms_admin(uuid,text,jsonb) to authenticated;

-- Rate limits are revalidated at the final claim boundary.
alter function public.sms_gateway(text,jsonb,text) rename to sms_gateway_release6;
revoke all on function public.sms_gateway_release6(text,jsonb,text) from public,anon,authenticated;
create function public.sms_gateway(action text,payload jsonb,token_hash text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare d public.sms_gateway_devices;s public.sms_settings;r jsonb;
begin
 if auth.role() is distinct from 'service_role' then raise exception 'Service role required' using errcode='42501';end if;
 if action<>'pair' then select * into d from public.sms_gateway_devices where credential_hash=token_hash and revoked_at is null;end if;
 if action='claim' and d.id is not null then
  select * into s from public.sms_settings where company_id=d.company_id;
  if (select count(*) from public.sms_messages where company_id=d.company_id and sent_at>=(now() at time zone 'Europe/London')::date at time zone 'Europe/London')>=s.daily_send_limit
   or (select count(*) from public.sms_messages where company_id=d.company_id and sent_at>=date_trunc('month',now() at time zone 'Europe/London') at time zone 'Europe/London')>=s.monthly_send_limit then
    return jsonb_build_object('ok',true,'messages','[]'::jsonb,'sending_enabled',false,'limit_reached',true);
  end if;
 end if;
 r:=public.sms_gateway_release6(action,payload,token_hash);
 if d.id is not null and action='heartbeat' then update public.sms_gateway_devices set selected_sim=left(payload->>'selected_sim',100),gateway_running=coalesce((payload->>'gateway_running')::boolean,true) where id=d.id;end if;
 if d.id is not null and action='inbound' and coalesce(r->>'ok','false')='true' then update public.sms_gateway_devices set last_received_at=now() where id=d.id;end if;
 if d.id is not null and action='status' and payload->>'state' in('sent','delivered') and coalesce(r->>'ok','false')='true' then update public.sms_gateway_devices set last_successful_send_at=now() where id=d.id;end if;
 return r;
end $$;
revoke all on function public.sms_gateway(text,jsonb,text) from public,anon,authenticated;
grant execute on function public.sms_gateway(text,jsonb,text) to service_role;

-- Durable, idempotent database scheduler. No paid external scheduler required.
create or replace function public.sms_scheduler_tick() returns void language plpgsql security definer set search_path='' as $$
declare x record;begin
 update public.sms_messages set state='expired',error_code=coalesce(error_code,'EXPIRED') where state in('queued','claimed') and expires_at<=now();
 for x in select company_id from public.sms_settings where enabled and sending_enabled loop perform public.sms_run_automations(x.company_id);end loop;
end $$;
revoke all on function public.sms_scheduler_tick() from public,anon,authenticated;
do $$begin
 if exists(select 1 from pg_extension where extname='pg_cron') then
  perform cron.unschedule(jobid) from cron.job where jobname='release92-sms-automation';
  perform cron.schedule('release92-sms-automation','* * * * *','select public.sms_scheduler_tick()');
 end if;
end$$;

notify pgrst,'reload schema';
commit;
