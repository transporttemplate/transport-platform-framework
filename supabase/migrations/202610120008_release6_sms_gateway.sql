-- Release 6: fail-closed, company-isolated Android SMS gateway.
begin;
create extension if not exists pgcrypto;

create table public.sms_settings(company_id uuid primary key references public.companies(id) on delete cascade,enabled boolean not null default false,sending_enabled boolean not null default false,gateway_pin_hash text,google_review_link text,quiet_start time default '21:00',quiet_end time default '08:00',created_at timestamptz not null default now(),updated_at timestamptz not null default now());
create table public.sms_gateway_devices(id uuid primary key default gen_random_uuid(),company_id uuid not null references public.companies(id) on delete cascade,device_name text not null,device_fingerprint text not null,credential_hash text not null unique,apk_version text,revoked_at timestamptz,last_heartbeat_at timestamptz,sim_number text,sim_status text,permission_state jsonb not null default '{}',network_status text,sent_total bigint not null default 0,received_total bigint not null default 0,created_at timestamptz not null default now(),unique(company_id,device_fingerprint));
create table public.sms_conversations(id uuid primary key default gen_random_uuid(),company_id uuid not null references public.companies(id) on delete cascade,phone_e164 text not null,contact_type text,contact_id uuid,display_name text,unread_count integer not null default 0,last_message_at timestamptz not null default now(),created_at timestamptz not null default now(),unique(company_id,phone_e164));
create table public.sms_messages(id uuid primary key default gen_random_uuid(),company_id uuid not null references public.companies(id) on delete cascade,conversation_id uuid not null references public.sms_conversations(id) on delete cascade,direction text not null check(direction in('inbound','outbound')),phone_e164 text not null,body text not null check(length(body) between 1 and 4000),state text not null check(state in('received','queued','claimed','sent','delivered','failed','uncertain','cancelled','expired')),idempotency_key text not null,booking_id uuid,driver_id uuid,automation_rule_id uuid,claimed_by uuid references public.sms_gateway_devices(id),claimed_at timestamptz,claim_expires_at timestamptz,expires_at timestamptz,attempt_count integer not null default 0,max_attempts integer not null default 4,provider_reference text,error_code text,created_at timestamptz not null default now(),sent_at timestamptz,delivered_at timestamptz,unique(company_id,idempotency_key));
create table public.sms_message_attempts(id uuid primary key default gen_random_uuid(),company_id uuid not null references public.companies(id) on delete cascade,message_id uuid not null references public.sms_messages(id) on delete cascade,device_id uuid not null references public.sms_gateway_devices(id),attempt_number integer not null,outcome text not null,provider_reference text,error_code text,created_at timestamptz not null default now(),unique(message_id,attempt_number));
create table public.sms_delivery_events(id uuid primary key default gen_random_uuid(),company_id uuid not null references public.companies(id) on delete cascade,message_id uuid not null references public.sms_messages(id) on delete cascade,event_type text not null,event_key text not null,created_at timestamptz not null default now(),unique(company_id,event_key));
create table public.sms_opt_outs(company_id uuid not null references public.companies(id) on delete cascade,phone_e164 text not null,reason text,created_at timestamptz not null default now(),primary key(company_id,phone_e164));
create table public.sms_templates(id uuid primary key default gen_random_uuid(),company_id uuid not null references public.companies(id) on delete cascade,template_key text not null,name text not null,body text not null,enabled boolean not null default false,marketing boolean not null default false,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(company_id,template_key));
create table public.sms_automation_rules(id uuid primary key default gen_random_uuid(),company_id uuid not null references public.companies(id) on delete cascade,name text not null,trigger_key text not null,recipient_type text not null check(recipient_type in('customer','driver','office')),conditions jsonb not null default '{}',delay_minutes integer not null default 0 check(delay_minutes between 0 and 10080),template_id uuid references public.sms_templates(id),enabled boolean not null default false,created_at timestamptz not null default now(),updated_at timestamptz not null default now());
create table public.sms_gateway_audit(id uuid primary key default gen_random_uuid(),company_id uuid references public.companies(id) on delete cascade,device_id uuid,actor_id uuid,action text not null,details jsonb not null default '{}',created_at timestamptz not null default now());
create table public.sms_pairing_attempts(fingerprint text primary key,attempt_count integer not null default 0,window_started_at timestamptz not null default now(),blocked_until timestamptz);

-- All state writes go through the two small RPC boundaries below. No browser can
-- write receipts/heartbeats, read hashes, or enable the release-level send gate.
alter table public.sms_settings add column office_phone text;
alter table public.sms_automation_rules add column sending_start time not null default '00:00';
alter table public.sms_automation_rules add column sending_end time not null default '00:00';
alter table public.sms_messages add column not_before timestamptz not null default now();
alter table public.sms_messages add column marketing boolean not null default false;
alter table public.sms_messages add column preference_key text;
alter table public.sms_messages add column booking_snapshot jsonb;
create table public.sms_release_control(id boolean primary key default true check(id),live_sending_enabled boolean not null default false);
insert into public.sms_release_control(id) values(true);
create table public.sms_consents(company_id uuid not null references public.companies(id),phone_e164 text not null,evidence text not null,recorded_by uuid not null,created_at timestamptz not null default now(),primary key(company_id,phone_e164));
create table public.sms_automation_events(id uuid primary key default gen_random_uuid(),company_id uuid not null references public.companies(id),event_key text not null,trigger_key text not null,booking_id uuid,driver_id uuid,created_at timestamptz not null default now(),unique(company_id,event_key));
create index sms_message_queue on public.sms_messages(company_id,state,not_before);
create index sms_message_conversation on public.sms_messages(company_id,conversation_id,created_at);

create function public.sms_is_admin(c uuid) returns boolean language sql stable security definer set search_path='' as $$
 select auth.uid() is not null and exists(select 1 from public.company_users u join public.companies c1 on c1.id=u.company_id where u.company_id=c and u.user_id=auth.uid() and lower(u.role) in('admin','owner') and coalesce(c1.company_status,'active')<>'suspended' and (coalesce(c1.company_status,'active')<>'trial' or c1.trial_expires_at>now()))
$$;
revoke all on function public.sms_is_admin(uuid) from public,anon;
grant execute on function public.sms_is_admin(uuid) to authenticated;
do $$ declare t text; begin
 foreach t in array array['sms_settings','sms_gateway_devices','sms_conversations','sms_messages','sms_message_attempts','sms_delivery_events','sms_opt_outs','sms_templates','sms_automation_rules','sms_gateway_audit','sms_pairing_attempts','sms_release_control','sms_consents','sms_automation_events'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  execute format('grant all on public.%I to service_role',t);
  if t not in('sms_release_control','sms_pairing_attempts') then
   execute format('create policy sms_admin_read on public.%I for select to authenticated using(public.sms_is_admin(company_id))',t);
  end if;
 end loop;
end $$;
-- Readable tables never contain credentials. Settings/devices are available only
-- as explicitly projected JSON from sms_admin; future columns stay private.
grant select on public.sms_conversations,public.sms_messages,public.sms_message_attempts,public.sms_delivery_events,public.sms_opt_outs,public.sms_templates,public.sms_automation_rules,public.sms_gateway_audit,public.sms_consents to authenticated;

create function public.sms_phone(value text) returns text language plpgsql immutable set search_path='' as $$
declare p text:=regexp_replace(coalesce(value,''),'[\s().-]','','g');begin
 if p like '00%' then p:='+'||substr(p,3);elsif p like '0%' then p:='+44'||substr(p,2);end if;
 if p !~ '^\+[1-9][0-9]{7,14}$' then return null;end if;return p;end $$;
create function public.sms_channel(c uuid,k text) returns boolean language sql stable security definer set search_path='' as $$
 select coalesce((select x.notification_channels->k ? 'sms' from public.settings x join public.sms_settings s on s.company_id=x.company_id where x.company_id=c and s.enabled),false)
$$;
create function public.sms_channels(c uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select coalesce((select jsonb_build_object('customer_booking_confirmation',case when customer_booking_emails is not false then '["email"]'::jsonb else '[]'::jsonb end,'office_new_booking',case when office_new_booking_emails is not false then '["email"]'::jsonb else '[]'::jsonb end,'driver_assignment',case when driver_assignment_emails is not false then '["email"]'::jsonb else '[]'::jsonb end,'cancellations',case when cancellation_emails is not false then '["email"]'::jsonb else '[]'::jsonb end,'office_booking_reminder_24h',case when office_booking_reminder_emails then '["email"]'::jsonb else '[]'::jsonb end,'driver_booking_reminder_12h',case when driver_booking_reminder_emails then '["email"]'::jsonb else '[]'::jsonb end,'unassigned_48h',case when unallocated_48h_emails is not false then '["email"]'::jsonb else '[]'::jsonb end,'unassigned_24h',case when unallocated_24h_emails is not false then '["email"]'::jsonb else '[]'::jsonb end,'driver_document_expiry',case when driver_document_expiry_emails then '["email"]'::jsonb else '[]'::jsonb end)||notification_channels from public.settings where company_id=c),'{}'::jsonb)
$$;
create function public.sms_quiet(c uuid) returns boolean language sql stable security definer set search_path='' as $$
 select coalesce((select case when s.quiet_start=s.quiet_end then false when s.quiet_start<s.quiet_end then (now() at time zone coalesce(x.timezone,'Europe/London'))::time>=s.quiet_start and (now() at time zone coalesce(x.timezone,'Europe/London'))::time<s.quiet_end else (now() at time zone coalesce(x.timezone,'Europe/London'))::time>=s.quiet_start or (now() at time zone coalesce(x.timezone,'Europe/London'))::time<s.quiet_end end from public.sms_settings s left join public.settings x on x.company_id=s.company_id where s.company_id=c),true)
$$;
create function public.sms_enqueue(c uuid,p text,b text,k text,booking uuid default null,driver uuid default null,rule uuid default null,due timestamptz default now(),expiry timestamptz default now()+interval '1 day',is_marketing boolean default false,pref text default null) returns uuid language plpgsql security definer set search_path='' as $$
declare conv uuid;mid uuid;begin
 p:=public.sms_phone(p);
 if p is null or length(trim(b)) not between 1 and 4000 then raise exception 'Valid phone and message required';end if;
 if exists(select 1 from public.sms_opt_outs where company_id=c and phone_e164=p) then return null;end if;
 if is_marketing and not exists(select 1 from public.sms_consents where company_id=c and phone_e164=p) then return null;end if;
 insert into public.sms_conversations(company_id,phone_e164) values(c,p) on conflict(company_id,phone_e164) do nothing;
 select id into conv from public.sms_conversations where company_id=c and phone_e164=p;
 insert into public.sms_messages(company_id,conversation_id,direction,phone_e164,body,state,idempotency_key,booking_id,driver_id,automation_rule_id,not_before,expires_at,marketing,preference_key)
 values(c,conv,'outbound',p,b,'queued',k,booking,driver,rule,due,expiry,is_marketing,pref) on conflict(company_id,idempotency_key) do nothing returning id into mid;
 if mid is not null then update public.sms_conversations set last_message_at=now() where id=conv;end if;
 if mid is not null and booking is not null then update public.sms_messages set booking_snapshot=(select jsonb_build_object('journey_date',bk.journey_date,'journey_time',bk.journey_time) from public.bookings bk where bk.company_id=c and bk.id=booking) where id=mid;end if;
 return coalesce(mid,(select id from public.sms_messages where company_id=c and idempotency_key=k));
end $$;

create function public.sms_admin(target_company_id uuid,action text,payload jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare c uuid:=target_company_id;s public.sms_settings;id1 uuid;phone text;result jsonb;row1 record;val text;begin
 if not public.sms_is_admin(c) then raise exception 'Authenticated company Admin required' using errcode='42501';end if;
 if jsonb_typeof(payload)<>'object' then raise exception 'Object required';end if;
 if action='snapshot' then
  select * into s from public.sms_settings where company_id=c;
  return jsonb_build_object('ok',true,'settings',jsonb_build_object('enabled',coalesce(s.enabled,false),'sending_enabled',coalesce(s.sending_enabled,false) and (select live_sending_enabled from public.sms_release_control),'pin_set',s.gateway_pin_hash is not null,'google_review_link',s.google_review_link,'quiet_start',coalesce(s.quiet_start,'21:00'::time),'quiet_end',coalesce(s.quiet_end,'08:00'::time),'office_phone',s.office_phone,'channels',public.sms_channels(c)),
   'devices',coalesce((select jsonb_agg(jsonb_build_object('id',d.id,'device_name',d.device_name,'apk_version',d.apk_version,'revoked_at',d.revoked_at,'last_heartbeat_at',d.last_heartbeat_at,'sim_status',d.sim_status,'permission_state',d.permission_state,'network_status',d.network_status,'sent_total',d.sent_total,'received_total',d.received_total)) from public.sms_gateway_devices d where d.company_id=c),'[]'::jsonb),
   'usage',(select jsonb_build_object('sent_today',count(*) filter(where sent_at>=(now() at time zone 'Europe/London')::date at time zone 'Europe/London'),'sent_month',count(*) filter(where sent_at>=date_trunc('month',now() at time zone 'Europe/London') at time zone 'Europe/London'),'received_today',count(*) filter(where direction='inbound' and created_at>=(now() at time zone 'Europe/London')::date at time zone 'Europe/London'),'pending',count(*) filter(where state in('queued','claimed')),'failed',count(*) filter(where state='failed'),'uncertain',count(*) filter(where state='uncertain'),'total',count(*)) from public.sms_messages where company_id=c));
 elsif action='settings' then
  if nullif(payload->>'google_review_link','') is not null and payload->>'google_review_link' !~ '^https://[^\s]+$' then raise exception 'Review link must use HTTPS';end if;
  phone:=public.sms_phone(payload->>'office_phone');
  if nullif(payload->>'office_phone','') is not null and phone is null then raise exception 'Valid office phone required';end if;
  if jsonb_typeof(coalesce(payload->'channels','{}'))<>'object' then raise exception 'Invalid channels';end if;
  for row1 in select * from jsonb_each(coalesce(payload->'channels','{}')) loop
   if row1.value not in ('[]'::jsonb,'["sms"]'::jsonb,'["email"]'::jsonb,'["email","sms"]'::jsonb,'["sms","email"]'::jsonb) then raise exception 'Channels must be explicitly selected';end if;
  end loop;
  insert into public.sms_settings(company_id,enabled,google_review_link,office_phone,quiet_start,quiet_end) values(c,coalesce((payload->>'enabled')::boolean,false),nullif(payload->>'google_review_link',''),phone,coalesce(nullif(payload->>'quiet_start','')::time,'21:00'),coalesce(nullif(payload->>'quiet_end','')::time,'08:00'))
  on conflict(company_id) do update set enabled=excluded.enabled,google_review_link=excluded.google_review_link,office_phone=excluded.office_phone,quiet_start=excluded.quiet_start,quiet_end=excluded.quiet_end,updated_at=now();
  -- Only an explicit Admin save changes shared channel preferences. Deployment
  -- never updates existing settings. Merge preserves unrelated notification keys.
  update public.settings set notification_channels=notification_channels||coalesce(payload->'channels','{}') where company_id=c;
 elsif action='pin' then
  val:=payload->>'pin';if val is null or val !~ '^[0-9]{6,12}$' then raise exception 'PIN must contain 6 to 12 digits';end if;
  insert into public.sms_settings(company_id,gateway_pin_hash) values(c,extensions.crypt(val,extensions.gen_salt('bf',12))) on conflict(company_id) do update set gateway_pin_hash=excluded.gateway_pin_hash,updated_at=now();
  update public.sms_gateway_devices set revoked_at=now() where company_id=c and revoked_at is null;
 elsif action='revoke' then
  update public.sms_gateway_devices set revoked_at=now() where company_id=c and id=(payload->>'id')::uuid and revoked_at is null;
 elsif action='read' then
  update public.sms_conversations set unread_count=0 where company_id=c and id=(payload->>'id')::uuid;
 elsif action='reply' then
  select phone_e164 into phone from public.sms_conversations where company_id=c and id=(payload->>'conversation_id')::uuid;
  if phone is null or coalesce(payload->>'key','') !~ '^[0-9a-f-]{36}$' then raise exception 'Conversation and retry key required';end if;
  id1:=public.sms_enqueue(c,phone,payload->>'body','admin:'||auth.uid()||':'||(payload->>'key'));
  if id1 is null then raise exception 'Recipient has opted out';end if;
  result:=jsonb_build_object('id',id1);
 elsif action='cancel' then
  update public.sms_messages set state='cancelled' where company_id=c and id=(payload->>'id')::uuid and state='queued';
 elsif action='template' then
  if length(trim(coalesce(payload->>'name',''))) not between 1 and 120 or length(trim(coalesce(payload->>'body',''))) not between 1 and 3500 then raise exception 'Template name/body required';end if;
  -- No private notes, fares or arbitrary row interpolation, including drivers.
  for val in select m[1] from regexp_matches(payload->>'body','\{\{([^}]+)\}\}','g') m loop
   if val not in('company_name','booking_reference','customer_name','pickup_date','pickup_time','pickup_address','destination_address','driver_name','driver_phone','google_review_link','document_label','expiry_date') then raise exception 'Unsupported template variable: %',val;end if;
  end loop;
  id1:=coalesce(nullif(payload->>'id','')::uuid,gen_random_uuid());
  if exists(select 1 from public.sms_templates where id=id1 and company_id<>c) then raise exception 'Template not found' using errcode='42501';end if;
  insert into public.sms_templates(id,company_id,template_key,name,body,enabled,marketing) values(id1,c,'custom:'||id1,payload->>'name',payload->>'body',coalesce((payload->>'enabled')::boolean,false),coalesce((payload->>'marketing')::boolean,false)) on conflict(id) do update set name=excluded.name,body=excluded.body,enabled=excluded.enabled,marketing=case when sms_templates.template_key='review_request' then true else excluded.marketing end,updated_at=now() where sms_templates.company_id=c;
 elsif action='rule' then
  if length(trim(coalesce(payload->>'name',''))) not between 1 and 120 or coalesce(payload->>'trigger_key','') not in('booking_created','booking_confirmed','driver_assigned','driver_on_route','driver_arrived','passenger_on_board','booking_completed','booking_cancelled','pickup_reminder_due','driver_reminder_due','office_reminder_due','office_unassigned_48h','office_unassigned_24h','driver_document_expiry','review_request') then raise exception 'Valid rule name/trigger required';end if;
  if not exists(select 1 from public.sms_templates where id=(payload->>'template_id')::uuid and company_id=c) then raise exception 'Company template required';end if;
  if coalesce(payload->>'recipient_type','') not in('customer','driver','office') then raise exception 'Invalid recipient';end if;
  if jsonb_typeof(coalesce(payload->'conditions','{}'))<>'object' or exists(select 1 from jsonb_object_keys(coalesce(payload->'conditions','{}')) k where k not in('booking_source','payment_method')) then raise exception 'Invalid conditions';end if;
  id1:=coalesce(nullif(payload->>'id','')::uuid,gen_random_uuid());
  if exists(select 1 from public.sms_automation_rules where id=id1 and company_id<>c) then raise exception 'Rule not found' using errcode='42501';end if;
  insert into public.sms_automation_rules(id,company_id,name,trigger_key,recipient_type,conditions,delay_minutes,template_id,enabled) values(id1,c,payload->>'name',payload->>'trigger_key',payload->>'recipient_type',coalesce(payload->'conditions','{}'),coalesce((payload->>'delay_minutes')::int,0),(payload->>'template_id')::uuid,coalesce((payload->>'enabled')::boolean,false)) on conflict(id) do update set name=excluded.name,trigger_key=excluded.trigger_key,recipient_type=excluded.recipient_type,conditions=excluded.conditions,delay_minutes=excluded.delay_minutes,template_id=excluded.template_id,enabled=excluded.enabled,updated_at=now() where sms_automation_rules.company_id=c;
  update public.sms_automation_rules set sending_start=coalesce(nullif(payload->>'sending_start','')::time,'00:00'),sending_end=coalesce(nullif(payload->>'sending_end','')::time,'00:00') where id=id1 and company_id=c;
 elsif action='consent' then
  phone:=public.sms_phone(payload->>'phone');if phone is null then raise exception 'Valid phone required';end if;
  if coalesce((payload->>'allowed')::boolean,false) then
   if length(trim(coalesce(payload->>'evidence','')))<10 then raise exception 'Record specific SMS consent evidence (at least 10 characters)';end if;
   delete from public.sms_opt_outs where company_id=c and phone_e164=phone;
   insert into public.sms_consents(company_id,phone_e164,evidence,recorded_by) values(c,phone,left(payload->>'evidence',1000),auth.uid()) on conflict(company_id,phone_e164) do update set evidence=excluded.evidence,recorded_by=excluded.recorded_by,created_at=now();
  else
   delete from public.sms_consents where company_id=c and phone_e164=phone;
   insert into public.sms_opt_outs(company_id,phone_e164,reason) values(c,phone,'Admin recorded opt-out') on conflict do nothing;
   update public.sms_messages set state='cancelled' where company_id=c and phone_e164=phone and state in('queued','claimed');
  end if;
 else raise exception 'Unknown Admin action';end if;
 insert into public.sms_gateway_audit(company_id,actor_id,action,details) values(c,auth.uid(),'admin:'||action,jsonb_build_object('id',coalesce(id1::text,payload->>'id')));
 return jsonb_build_object('ok',true)||coalesce(result,'{}'::jsonb);
end $$;
revoke all on function public.sms_admin(uuid,text,jsonb) from public,anon;
grant execute on function public.sms_admin(uuid,text,jsonb) to authenticated;

insert into public.sms_templates(company_id,template_key,name,body) select c.id,x.k,x.n,x.b from public.companies c cross join(values('customer_confirmation','Customer booking confirmation','Booking {{booking_reference}} confirmed for {{pickup_date}} at {{pickup_time}}.'),('customer_pickup_reminder','Customer pickup reminder','Reminder from {{company_name}}: pickup at {{pickup_time}} from {{pickup_address}}.'),('driver_assignment','Driver job assignment','Job {{booking_reference}}: {{pickup_address}} to {{destination_address}} at {{pickup_time}}.'),('driver_reminder','Driver journey reminder','Reminder: job {{booking_reference}} starts at {{pickup_time}}.'),('driver_on_route','Driver on route','Your driver is on the way for booking {{booking_reference}}.'),('driver_arrived','Driver arrived/outside','Your driver has arrived and is outside.'),('booking_cancelled','Booking cancellation','Booking {{booking_reference}} has been cancelled.'),('office_unassigned','Office unassigned warning','Booking {{booking_reference}} remains unassigned.'),('driver_document_expiry','Driver document expiry','Driver document recheck is due.'),('review_request','Customer review request','Thank you for travelling with {{company_name}}. We’d appreciate a review: {{google_review_link}}'))x(k,n,b) on conflict do nothing;
update public.sms_templates set marketing=true where template_key='review_request';

-- Booking triggers record only new transitions. They do not update a booking,
-- payment, driver, existing settings, or invoke any email infrastructure.
create function public.sms_booking_event() returns trigger language plpgsql security definer set search_path='' as $$
declare k text;begin
 if tg_op='INSERT' then k:='booking_created';
 elsif new.status is distinct from old.status then
  k:=case lower(new.status) when 'confirmed' then 'booking_confirmed' when 'on_way' then 'driver_on_route' when 'arrived' then 'driver_arrived' when 'passenger_onboard' then 'passenger_on_board' when 'completed' then 'booking_completed' when 'cancelled' then 'booking_cancelled' when 'canceled' then 'booking_cancelled' end;
 end if;
 if k is not null then insert into public.sms_automation_events(company_id,event_key,trigger_key,booking_id) values(new.company_id,new.id||':'||k,k,new.id) on conflict do nothing;end if;
 if (tg_op='INSERT' and new.driver_id is not null) or (tg_op='UPDATE' and new.driver_id is distinct from old.driver_id and new.driver_id is not null) then
  insert into public.sms_automation_events(company_id,event_key,trigger_key,booking_id,driver_id) values(new.company_id,new.id||':driver_assigned:'||new.driver_id,'driver_assigned',new.id,new.driver_id) on conflict do nothing;
 end if;
 return new;
exception when others then
 -- SMS must never prevent a booking/payment transition. No PII in the audit.
 insert into public.sms_gateway_audit(company_id,action,details) values(new.company_id,'automation_capture_error',jsonb_build_object('code',sqlstate));return new;
end $$;
create trigger release6_sms_booking_event after insert or update of status,driver_id on public.bookings for each row execute function public.sms_booking_event();

create function public.sms_run_automations(c uuid) returns void language plpgsql security definer set search_path='' as $$
declare e record;r record;b jsonb;d jsonb;s public.sms_settings;co public.companies;phone text;body1 text;vars jsonb;v record;pref text;marketing1 boolean;due timestamptz;expiry timestamptz;begin
 if not (select live_sending_enabled from public.sms_release_control) then return;end if;
 select * into s from public.sms_settings where company_id=c;if not coalesce(s.enabled and s.sending_enabled,false) then return;end if;
 select * into co from public.companies where id=c;
 -- Five-minute eligibility windows intentionally skip historical reminders.
 insert into public.sms_automation_events(company_id,event_key,trigger_key,booking_id)
 select c,bk.id||':'||x.k||':'||bk.journey_date||':'||bk.journey_time,x.k,bk.id from public.bookings bk cross join(values('pickup_reminder_due',12),('driver_reminder_due',12),('office_reminder_due',24),('office_unassigned_48h',48),('office_unassigned_24h',24)) x(k,h)
 where bk.company_id=c and lower(coalesce(bk.status,'')) not in('completed','cancelled','canceled','no_show') and (x.k not like 'office_unassigned%' or bk.driver_id is null)
 and ((bk.journey_date+bk.journey_time) at time zone coalesce((select timezone from public.settings where company_id=c),'Europe/London')) between now()+make_interval(hours=>x.h)-interval '5 minutes' and now()+make_interval(hours=>x.h)
 on conflict do nothing;
 insert into public.sms_automation_events(company_id,event_key,trigger_key,driver_id)
 select c,'doc:'||dd.id||':'||dd.expiry_date,'driver_document_expiry',dd.driver_id from public.driver_documents dd where dd.company_id=c and dd.expiry_date=(now() at time zone 'Europe/London')::date+7 and lower(coalesce(dd.status,''))<>'archived' on conflict do nothing;
 insert into public.sms_automation_events(company_id,event_key,trigger_key,driver_id)
 select c,'licence:'||dr.id||':'||dr.licence_expiry,'driver_document_expiry',dr.id from public.drivers dr where dr.company_id=c and dr.licence_expiry=(now() at time zone 'Europe/London')::date+7 on conflict do nothing;
 for e in select * from public.sms_automation_events where company_id=c and created_at>now()-interval '5 minutes' loop
  b:='{}';d:='{}';
  if e.booking_id is not null then select to_jsonb(bk) into b from public.bookings bk where bk.company_id=c and bk.id=e.booking_id;end if;
  select jsonb_build_object('id',dr.id,'full_name',dr.full_name,'phone',dr.phone,'licence_expiry',dr.licence_expiry) into d from public.drivers dr where dr.company_id=c and dr.id=coalesce(e.driver_id,nullif(b->>'driver_id','')::uuid);
  if e.trigger_key not in('booking_completed','booking_cancelled') and lower(coalesce(b->>'status','')) in('completed','cancelled','canceled','no_show') then continue;end if;
  for r in select rr.*,t.body,t.marketing from public.sms_automation_rules rr join public.sms_templates t on t.id=rr.template_id and t.company_id=rr.company_id where rr.company_id=c and rr.enabled and t.enabled and (rr.trigger_key=e.trigger_key or (e.trigger_key='booking_completed' and rr.trigger_key='review_request')) loop
   pref:=case r.trigger_key when 'booking_created' then case r.recipient_type when 'office' then 'office_new_booking' else 'customer_booking_confirmation' end when 'booking_confirmed' then 'customer_booking_confirmation' when 'driver_assigned' then 'driver_assignment' when 'pickup_reminder_due' then 'customer_reminder' when 'driver_reminder_due' then 'driver_booking_reminder_12h' when 'office_reminder_due' then 'office_booking_reminder_24h' when 'office_unassigned_48h' then 'unassigned_48h' when 'office_unassigned_24h' then 'unassigned_24h' when 'booking_cancelled' then 'cancellations' else r.trigger_key end;
   if not public.sms_channel(c,pref) then continue;end if;
   if exists(select 1 from jsonb_each_text(r.conditions) cond where coalesce(b->>cond.key,'')<>cond.value) then continue;end if;
   phone:=public.sms_phone(case r.recipient_type when 'driver' then d->>'phone' when 'office' then s.office_phone else coalesce(b->>'customer_phone',b->>'phone') end);
   if phone is null then continue;end if;
   marketing1:=r.marketing or r.trigger_key='review_request';
   if r.trigger_key='review_request' and (r.recipient_type<>'customer' or nullif(s.google_review_link,'') is null) then continue;end if;
   vars:=jsonb_build_object('company_name',coalesce(co.trading_name,co.name),'booking_reference',b->>'booking_reference','customer_name',b->>'customer_name','pickup_date',b->>'journey_date','pickup_time',left(b->>'journey_time',5),'pickup_address',b->>'pickup_address','destination_address',b->>'dropoff_address','driver_name',d->>'full_name','driver_phone',d->>'phone','google_review_link',s.google_review_link,'document_label','Driver document / licence','expiry_date',coalesce(d->>'licence_expiry','Check document register'));
   body1:=r.body;for v in select * from jsonb_each_text(vars) loop body1:=replace(body1,'{{'||v.key||'}}',coalesce(v.value,''));end loop;
   if body1 like '%{{%' then continue;end if;
   if marketing1 then body1:=coalesce(co.trading_name,co.name)||': '||body1||' Reply STOP to opt out.';end if;
   due:=e.created_at+make_interval(mins=>r.delay_minutes);expiry:=due+interval '1 hour';
   if r.trigger_key in('driver_arrived','driver_on_route','passenger_on_board') then expiry:=least(expiry,e.created_at+interval '15 minutes');end if;
   perform public.sms_enqueue(c,phone,body1,'auto:'||e.id||':'||r.id,e.booking_id,nullif(d->>'id','')::uuid,r.id,due,expiry,marketing1,pref);
  end loop;
 end loop;
end $$;

create function public.sms_message_eligible(m public.sms_messages) returns boolean language plpgsql stable security definer set search_path='' as $$
declare r public.sms_automation_rules;b public.bookings;t time;begin
 if m.automation_rule_id is null then return true;end if;
 select * into r from public.sms_automation_rules where id=m.automation_rule_id and company_id=m.company_id and enabled;
 if r.id is null or not exists(select 1 from public.sms_templates where id=r.template_id and company_id=m.company_id and enabled) then return false;end if;
 t:=(now() at time zone coalesce((select timezone from public.settings where company_id=m.company_id),'Europe/London'))::time;
 if r.sending_start<>r.sending_end and not(case when r.sending_start<r.sending_end then t>=r.sending_start and t<r.sending_end else t>=r.sending_start or t<r.sending_end end) then return false;end if;
 if m.booking_id is not null then
  select * into b from public.bookings where id=m.booking_id and company_id=m.company_id;
  if b.id is null or m.booking_snapshot is distinct from jsonb_build_object('journey_date',b.journey_date,'journey_time',b.journey_time) then return false;end if;
  if r.trigger_key in('review_request','booking_completed') then if lower(b.status)<>'completed' then return false;end if;
  elsif r.trigger_key='booking_cancelled' then if lower(b.status) not in('cancelled','canceled') then return false;end if;
  elsif lower(b.status) in('completed','cancelled','canceled','no_show') then return false;end if;
  if r.recipient_type='driver' and b.driver_id is distinct from m.driver_id then return false;end if;
  if r.recipient_type='customer' and public.sms_phone(coalesce(b.customer_phone,b.phone)) is distinct from m.phone_e164 then return false;end if;
  if r.trigger_key like 'office_unassigned%' and b.driver_id is not null then return false;end if;
 end if;
 return true;
end $$;

create function public.sms_gateway(action text,payload jsonb,token_hash text default null) returns jsonb language plpgsql security definer set search_path='' as $$
<<gateway>>
declare c uuid;d public.sms_gateway_devices;s public.sms_settings;m public.sms_messages;p public.sms_pairing_attempts;co public.companies;conv uuid;mid uuid;phone text;k text;count1 int;allowed boolean;res jsonb;begin
 if auth.role() is distinct from 'service_role' then raise exception 'Service role required' using errcode='42501';end if;
 if action='pair' then
  -- Rate limit is company-code based, not a spoofable client IP header. A row
  -- lock makes simultaneous attempts count correctly. Failed auth RETURNS so
  -- increments commit rather than rolling back with a raised exception.
  k:='company:'||(payload->>'company_code');
  insert into public.sms_pairing_attempts(fingerprint) values(k) on conflict do nothing;
  select * into p from public.sms_pairing_attempts where fingerprint=k for update;
  if p.blocked_until>now() then return jsonb_build_object('ok',false,'status',429,'error','Pairing temporarily locked; try again in 30 minutes');end if;
  if p.window_started_at<now()-interval '30 minutes' then p.attempt_count:=0;end if;
  select * into co from public.companies where company_code=payload->>'company_code';c:=co.id;
  select * into s from public.sms_settings where company_id=c for update;
  if c is null or coalesce(co.company_status,'active')='suspended' or (co.company_status='trial' and co.trial_expires_at<=now()) or s.gateway_pin_hash is null or extensions.crypt(payload->>'pin',s.gateway_pin_hash) is distinct from s.gateway_pin_hash then
   count1:=p.attempt_count+1;update public.sms_pairing_attempts set attempt_count=count1,window_started_at=case when p.attempt_count=0 then now() else window_started_at end,blocked_until=case when count1>=5 then now()+interval '30 minutes' else null end where fingerprint=k;
   insert into public.sms_gateway_audit(company_id,action,details) values(c,'pairing_failed',jsonb_build_object('attempt_count',count1));
   return jsonb_build_object('ok',false,'status',401,'error','Invalid company code or PIN');
  end if;
  if coalesce(payload->>'credential_hash','') !~ '^[a-f0-9]{64}$' or length(coalesce(payload->>'device_fingerprint','')) not between 16 and 200 then raise exception 'Invalid device identity';end if;
  -- One active handset per company prevents two SIMs racing the same queue.
  update public.sms_gateway_devices set revoked_at=now() where company_id=c and revoked_at is null;
  insert into public.sms_gateway_devices(company_id,device_name,device_fingerprint,credential_hash,apk_version) values(c,left(coalesce(payload->>'device_name','Android Gateway'),100),payload->>'device_fingerprint',payload->>'credential_hash',left(payload->>'apk_version',30)) on conflict(company_id,device_fingerprint) do update set credential_hash=excluded.credential_hash,device_name=excluded.device_name,revoked_at=null,last_heartbeat_at=null,apk_version=excluded.apk_version returning * into d;
  delete from public.sms_pairing_attempts where fingerprint=k;
  insert into public.sms_gateway_audit(company_id,device_id,action) values(c,d.id,'paired');
  return jsonb_build_object('ok',true,'device_id',d.id,'company',jsonb_build_object('id',c,'code',co.company_code,'name',coalesce(co.trading_name,co.name)),'sending_enabled',false);
 end if;
 select * into d from public.sms_gateway_devices where credential_hash=token_hash and revoked_at is null for update;
 if d.id is null then return jsonb_build_object('ok',false,'status',401,'error','Gateway revoked or credential invalid');end if;c:=d.company_id;
 select * into co from public.companies where id=c;
 if coalesce(co.company_status,'active')='suspended' or (co.company_status='trial' and (co.trial_expires_at is null or co.trial_expires_at<=now())) then return jsonb_build_object('ok',false,'status',403,'error','Company unavailable');end if;
 select * into s from public.sms_settings where company_id=c;
 allowed:=coalesce(s.enabled and s.sending_enabled,false) and (select live_sending_enabled from public.sms_release_control);
 if action='heartbeat' then
  update public.sms_gateway_devices set last_heartbeat_at=now(),sim_status=left(payload->>'sim_status',100),network_status=left(payload->>'network_status',100),permission_state=jsonb_build_object('send_sms',payload->'send_sms'='true'::jsonb,'receive_sms',payload->'receive_sms'='true'::jsonb),apk_version=left(payload->>'apk_version',30) where id=d.id;
  perform public.sms_run_automations(c);
  return jsonb_build_object('ok',true,'sending_enabled',allowed,'sent_total',d.sent_total,'received_total',d.received_total,'pending',(select count(*) from public.sms_messages where company_id=c and state in('queued','claimed')),'company_name',coalesce(co.trading_name,co.name),'company_code',co.company_code);
 elsif action='claim' then
  update public.sms_messages set state='expired' where company_id=c and state in('queued','claimed') and expires_at<=now();
  -- Only a lease that never crossed prepare can be retried. Uncertain sends
  -- are terminal for automatic retry, even after a crash or device revocation.
  update public.sms_messages set state=case when attempt_count>=max_attempts then 'failed' else 'queued' end,claimed_by=null where company_id=c and state='claimed' and claim_expires_at<now();
  if not allowed or public.sms_quiet(c) then return jsonb_build_object('ok',true,'messages','[]'::jsonb,'sending_enabled',false);end if;
  select * into m from public.sms_messages mm where mm.company_id=c and mm.state='queued' and mm.not_before<=now() and mm.expires_at>now() and mm.attempt_count<mm.max_attempts
   and not exists(select 1 from public.sms_opt_outs o where o.company_id=c and o.phone_e164=mm.phone_e164)
   and (not mm.marketing or exists(select 1 from public.sms_consents o where o.company_id=c and o.phone_e164=mm.phone_e164))
   and (mm.preference_key is null or public.sms_channel(c,mm.preference_key))
   and public.sms_message_eligible(mm)
   and (mm.automation_rule_id is null or exists(select 1 from public.sms_automation_rules rr join public.sms_templates t on t.id=rr.template_id and t.company_id=c where rr.company_id=c and rr.id=mm.automation_rule_id and rr.enabled and t.enabled))
   order by mm.created_at for update skip locked limit 1;
  if m.id is null then return jsonb_build_object('ok',true,'messages','[]'::jsonb,'sending_enabled',true);end if;
  update public.sms_messages set state='claimed',claimed_by=d.id,claimed_at=now(),claim_expires_at=now()+interval '2 minutes',attempt_count=attempt_count+1 where id=m.id returning * into m;
  insert into public.sms_message_attempts(company_id,message_id,device_id,attempt_number,outcome) values(c,m.id,d.id,m.attempt_count,'claimed');
  return jsonb_build_object('ok',true,'sending_enabled',true,'messages',jsonb_build_array(jsonb_build_object('id',m.id,'phone_e164',m.phone_e164,'body',m.body,'attempt',m.attempt_count)));
 elsif action in('prepare','status') then
  select * into m from public.sms_messages where company_id=c and id=(payload->>'message_id')::uuid and claimed_by=d.id and attempt_count=(payload->>'attempt')::int for update;
  if m.id is null then return jsonb_build_object('ok',false,'status',409,'error','No matching device lease');end if;
  if action='prepare' then
   if not allowed or public.sms_quiet(c) or not public.sms_message_eligible(m) or m.state<>'claimed' or m.claim_expires_at<=now() or m.expires_at<=now() or exists(select 1 from public.sms_opt_outs where company_id=c and phone_e164=m.phone_e164) or (m.marketing and not exists(select 1 from public.sms_consents where company_id=c and phone_e164=m.phone_e164)) or (m.preference_key is not null and not public.sms_channel(c,m.preference_key)) then return jsonb_build_object('ok',false,'status',409,'error','Send not authorised; do not transmit');end if;
   update public.sms_messages set state='uncertain' where id=m.id;
   update public.sms_message_attempts set outcome='prepared' where message_id=m.id and attempt_number=m.attempt_count;
   return jsonb_build_object('ok',true,'may_send',true);
  end if;
  if coalesce(payload->>'state','') not in('sent','delivered','failed','uncertain') or m.state not in('uncertain','sent','delivered','failed') then return jsonb_build_object('ok',false,'status',409,'error','Invalid delivery transition');end if;
  k:=m.id||':'||m.attempt_count||':'||(payload->>'state');
  insert into public.sms_delivery_events(company_id,message_id,event_type,event_key) values(c,m.id,payload->>'state',k) on conflict do nothing returning id into mid;
  if mid is not null then
   if m.state<>'delivered' and (payload->>'state'='delivered' or m.state='uncertain' or (m.state='sent' and payload->>'state'='sent')) then
    update public.sms_messages set state=payload->>'state',sent_at=case when payload->>'state' in('sent','delivered') then coalesce(sent_at,now()) else sent_at end,delivered_at=case when payload->>'state'='delivered' then coalesce(delivered_at,now()) else delivered_at end,error_code=left(payload->>'error_code',100) where id=m.id;
    if m.sent_at is null and payload->>'state' in('sent','delivered') then update public.sms_gateway_devices set sent_total=sent_total+1 where id=d.id;end if;
   end if;
   update public.sms_message_attempts set outcome=(select state from public.sms_messages where id=m.id),error_code=left(payload->>'error_code',100) where message_id=m.id and attempt_number=m.attempt_count;
  end if;
 elsif action='inbound' then
  phone:=public.sms_phone(payload->>'phone_e164');k:='in:'||d.id||':'||(payload->>'idempotency_key');
  if phone is null or length(trim(coalesce(payload->>'body',''))) not between 1 and 4000 or length(coalesce(payload->>'idempotency_key','')) not between 16 and 200 then raise exception 'Valid inbound SMS required';end if;
  insert into public.sms_conversations(company_id,phone_e164) values(c,phone) on conflict do nothing;
  select id into conv from public.sms_conversations where company_id=c and phone_e164=phone for update;
  insert into public.sms_messages(company_id,conversation_id,direction,phone_e164,body,state,idempotency_key) values(c,conv,'inbound',phone,payload->>'body','received',k) on conflict do nothing returning id into mid;
  if mid is not null then
   update public.sms_conversations set unread_count=unread_count+1,last_message_at=now() where id=conv;
   update public.sms_conversations cc set display_name=dr.full_name,contact_type='driver',contact_id=dr.id from public.drivers dr where cc.id=conv and dr.company_id=c and public.sms_phone(dr.phone)=gateway.phone;
   if not exists(select 1 from public.sms_conversations where id=conv and contact_type='driver') then
    update public.sms_conversations set display_name=(select bk.customer_name from public.bookings bk where bk.company_id=c and public.sms_phone(coalesce(bk.customer_phone,bk.phone))=gateway.phone order by bk.created_at desc limit 1),contact_type='customer' where id=conv;
   end if;
   update public.sms_gateway_devices set received_total=received_total+1 where id=d.id;
   if upper(trim(payload->>'body')) in('STOP','STOP ALL','STOPALL','UNSUBSCRIBE','CANCEL','END','QUIT') then
    insert into public.sms_opt_outs(company_id,phone_e164,reason) values(c,phone,'Inbound STOP') on conflict do nothing;
    delete from public.sms_consents where company_id=c and phone_e164=phone;
    update public.sms_messages set state='cancelled' where company_id=c and phone_e164=phone and state in('queued','claimed');
   end if;
  end if;
 elsif action='unpair' then
  update public.sms_gateway_devices set revoked_at=now() where id=d.id;
  insert into public.sms_gateway_audit(company_id,device_id,action) values(c,d.id,'unpaired');
 else raise exception 'Unknown gateway action';end if;
 return jsonb_build_object('ok',true);
end $$;
revoke all on function public.sms_gateway(text,jsonb,text) from public,anon,authenticated;
grant execute on function public.sms_gateway(text,jsonb,text) to service_role;
revoke all on function public.sms_phone(text),public.sms_channel(uuid,text),public.sms_channels(uuid),public.sms_quiet(uuid),public.sms_enqueue(uuid,text,text,text,uuid,uuid,uuid,timestamptz,timestamptz,boolean,text),public.sms_booking_event(),public.sms_run_automations(uuid),public.sms_message_eligible(public.sms_messages) from public,anon,authenticated;
notify pgrst,'reload schema';commit;
