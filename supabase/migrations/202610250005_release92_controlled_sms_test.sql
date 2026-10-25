-- Release 9.2 controlled test mode: one explicit short-lived message may pass
-- while Master SMS remains OFF. All other queued work is cancelled first.
begin;
alter table public.sms_settings add column if not exists test_mode_until timestamptz,add column if not exists test_phone text;

alter function public.sms_admin(uuid,text,jsonb) rename to sms_admin_release92_core;
revoke all on function public.sms_admin_release92_core(uuid,text,jsonb) from public,anon,authenticated;
create function public.sms_admin(target_company_id uuid,action text,payload jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare c uuid:=target_company_id;r jsonb;p text;conv uuid;mid uuid;d public.sms_gateway_devices;
begin
 if not public.sms_is_admin(c) then raise exception 'Authenticated company Admin required' using errcode='42501';end if;
 if action='snapshot' then
  r:=public.sms_admin_release92_core(c,action,payload);
  if not coalesce((r#>>'{readiness,test_send_seen}')::boolean,false) then r:=jsonb_set(r,'{readiness,missing}',(r#>'{readiness,missing}')||'"Complete a controlled test send"'::jsonb);end if;
  if not coalesce((r#>>'{readiness,test_receive_seen}')::boolean,false) then r:=jsonb_set(r,'{readiness,missing}',(r#>'{readiness,missing}')||'"Receive a controlled test reply"'::jsonb);end if;
  r:=jsonb_set(r,'{readiness,ready}',to_jsonb(jsonb_array_length(r#>'{readiness,missing}')=0));return r;
 elsif action='test' then
  select * into d from public.sms_gateway_devices where company_id=c and revoked_at is null and last_heartbeat_at>=now()-interval '3 minutes' order by created_at desc limit 1;
  if d.id is null or not coalesce((d.permission_state->>'send_sms')::boolean,false) then raise exception 'An online gateway with SMS permission is required';end if;
  p:=public.sms_phone(payload->>'phone');if p is null then raise exception 'Enter a valid controlled test phone';end if;
  update public.sms_messages set state='cancelled',error_code='TEST_MODE_ISOLATION' where company_id=c and state in('queued','claimed');
  insert into public.sms_conversations(company_id,phone_e164,display_name,contact_type) values(c,p,'Controlled test recipient','test') on conflict(company_id,phone_e164) do nothing;
  select id into conv from public.sms_conversations where company_id=c and phone_e164=p;
  insert into public.sms_messages(company_id,conversation_id,direction,phone_e164,body,state,idempotency_key,not_before,expires_at,max_attempts)
  values(c,conv,'outbound',p,'SMS gateway test. Please reply TEST to confirm two-way messaging.','queued','test:'||gen_random_uuid(),now(),now()+interval '10 minutes',1) returning id into mid;
  update public.sms_settings set test_mode_until=now()+interval '10 minutes',test_phone=p where company_id=c;
  insert into public.sms_gateway_audit(company_id,device_id,actor_id,action,details) values(c,d.id,auth.uid(),'controlled_test_queued',jsonb_build_object('message_id',mid));
  return jsonb_build_object('ok',true,'id',mid,'expires_in_minutes',10);
 elsif action='master' and coalesce((payload->>'enabled')::boolean,false) then
  select * into d from public.sms_gateway_devices where company_id=c and revoked_at is null order by created_at desc limit 1;
  if coalesce(d.sent_total,0)=0 or coalesce(d.received_total,0)=0 then raise exception 'Complete a controlled test send and receive before activation';end if;
 end if;
 return public.sms_admin_release92_core(c,action,payload);
end $$;
revoke all on function public.sms_admin(uuid,text,jsonb) from public,anon;
grant execute on function public.sms_admin(uuid,text,jsonb) to authenticated;

alter function public.sms_gateway(text,jsonb,text) rename to sms_gateway_release92_core;
revoke all on function public.sms_gateway_release92_core(text,jsonb,text) from public,anon,authenticated;
create function public.sms_gateway(action text,payload jsonb,token_hash text default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare d public.sms_gateway_devices;s public.sms_settings;r jsonb;test_allowed boolean:=false;
begin
 if auth.role() is distinct from 'service_role' then raise exception 'Service role required' using errcode='42501';end if;
 if action in('claim','prepare') then
  select * into d from public.sms_gateway_devices where credential_hash=token_hash and revoked_at is null;
  select * into s from public.sms_settings where company_id=d.company_id for update;
  test_allowed:=not coalesce(s.sending_enabled,false) and s.test_mode_until>now();
  if test_allowed then
   update public.sms_settings set enabled=true,sending_enabled=true where company_id=d.company_id;
   r:=public.sms_gateway_release92_core(action,payload,token_hash);
   update public.sms_settings set enabled=s.enabled,sending_enabled=s.sending_enabled where company_id=d.company_id;
   if action='claim' and coalesce(r->'messages','[]'::jsonb)<> '[]'::jsonb and coalesce(r#>>'{messages,0,id}','') not in(select id::text from public.sms_messages where company_id=d.company_id and idempotency_key like 'test:%') then raise exception 'Controlled test isolation failed';end if;
   return r;
  end if;
 end if;
 return public.sms_gateway_release92_core(action,payload,token_hash);
exception when others then
 if d.company_id is not null and test_allowed then update public.sms_settings set enabled=s.enabled,sending_enabled=s.sending_enabled where company_id=d.company_id;end if;raise;
end $$;
revoke all on function public.sms_gateway(text,jsonb,text) from public,anon,authenticated;
grant execute on function public.sms_gateway(text,jsonb,text) to service_role;
notify pgrst,'reload schema';
commit;
