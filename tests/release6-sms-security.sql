-- Run ONLY appended to the uncommitted migration, followed by ROLLBACK.
-- Fixed synthetic IDs do not identify any live company/person.
create function pg_temp.assert(ok boolean,label text) returns void language plpgsql as $$begin if ok is distinct from true then raise exception 'ASSERT: %',label;end if;end$$;
insert into public.companies(id,name,company_code) values('60000000-0000-0000-0000-000000000001','Release6 isolated A','9901'),('60000000-0000-0000-0000-000000000002','Release6 isolated B','9902');
insert into public.company_users(company_id,user_id,role) select '60000000-0000-0000-0000-000000000001',user_id,'admin' from public.company_users limit 1;
select set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',(select user_id from public.company_users where company_id='60000000-0000-0000-0000-000000000001'))::text,true);
set local role authenticated;
do $$begin
 perform pg_temp.assert((public.sms_admin('60000000-0000-0000-0000-000000000001','snapshot')->>'ok')::boolean,'same-company Admin');
 begin perform public.sms_admin('60000000-0000-0000-0000-000000000002','snapshot');raise exception 'Cross-company RPC allowed';exception when insufficient_privilege then null;end;
 begin update public.sms_gateway_devices set last_heartbeat_at=now();raise exception 'Forged heartbeat allowed';exception when insufficient_privilege then null;end;
 begin update public.sms_messages set state='sent';raise exception 'Forged status allowed';exception when insufficient_privilege then null;end;
 begin perform gateway_pin_hash from public.sms_settings;raise exception 'PIN readable';exception when insufficient_privilege then null;end;
 begin perform credential_hash from public.sms_gateway_devices;raise exception 'Credential readable';exception when insufficient_privilege then null;end;
 begin perform public.sms_gateway('claim','{}',repeat('a',64));raise exception 'Device RPC callable';exception when insufficient_privilege then null;end;
 perform public.sms_admin('60000000-0000-0000-0000-000000000001','settings','{"enabled":true,"sending_enabled":true,"channels":{"driver_arrived":["sms"]},"quiet_start":"00:00","quiet_end":"00:00"}');
 perform pg_temp.assert(not (public.sms_admin('60000000-0000-0000-0000-000000000001','snapshot')->'settings'->>'sending_enabled')::boolean,'Admin cannot enable live sending');
 perform public.sms_admin('60000000-0000-0000-0000-000000000001','pin','{"pin":"91827364"}');
end$$;
reset role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
set local role service_role;
do $$declare r jsonb;i int;dev uuid;mid uuid;conv uuid;begin
 for i in 1..5 loop r:=public.sms_gateway('pair','{"company_code":"9902","pin":"111111","device_fingerprint":"test-device-00000002","credential_hash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}',null);perform pg_temp.assert((r->>'status')::int=401,'invalid PIN rejected');end loop;
 r:=public.sms_gateway('pair','{"company_code":"9902","pin":"111111","device_fingerprint":"test-device-00000002","credential_hash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}',null);perform pg_temp.assert((r->>'status')::int=429,'rate limit persists');
 r:=public.sms_gateway('pair','{"company_code":"9901","pin":"91827364","device_fingerprint":"test-device-00000001","credential_hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","device_name":"Mock"}',null);perform pg_temp.assert((r->>'ok')::boolean,'valid pairing');dev:=(r->>'device_id')::uuid;
 r:=public.sms_gateway('heartbeat','{"send_sms":true,"receive_sms":true}',repeat('a',64));perform pg_temp.assert((r->>'ok')::boolean,'heartbeat');
 perform public.sms_gateway('inbound','{"phone_e164":"+447700900001","body":"Hello","idempotency_key":"inbound-test-0000001"}',repeat('a',64));
 perform public.sms_gateway('inbound','{"phone_e164":"+447700900001","body":"Hello","idempotency_key":"inbound-test-0000001"}',repeat('a',64));
 perform pg_temp.assert((select count(*)=1 from public.sms_messages where company_id='60000000-0000-0000-0000-000000000001'),'inbound dedupe');
 perform pg_temp.assert((select unread_count=1 from public.sms_conversations where company_id='60000000-0000-0000-0000-000000000001'),'unread replay safe');
 select id into conv from public.sms_conversations where company_id='60000000-0000-0000-0000-000000000001';
 -- Use synthetic queue records solely inside this rollback test.
 insert into public.sms_messages(company_id,conversation_id,direction,phone_e164,body,state,idempotency_key,expires_at) values('60000000-0000-0000-0000-000000000001',conv,'outbound','+447700900001','Mock only','queued','test-queue',now()+interval '1 hour') returning id into mid;
 r:=public.sms_gateway('claim','{}',repeat('a',64));perform pg_temp.assert(jsonb_array_length(r->'messages')=0,'global gate closed');
 update public.sms_release_control set live_sending_enabled=true;update public.sms_settings set sending_enabled=true where company_id='60000000-0000-0000-0000-000000000001';
 r:=public.sms_gateway('claim','{}',repeat('a',64));perform pg_temp.assert(jsonb_array_length(r->'messages')=1,'claim isolated queue');
 r:=public.sms_gateway('status',jsonb_build_object('message_id',mid,'attempt',1,'state','sent'),repeat('a',64));perform pg_temp.assert((r->>'status')::int=409,'status before prepare rejected');
 r:=public.sms_gateway('prepare',jsonb_build_object('message_id',mid,'attempt',1),repeat('a',64));perform pg_temp.assert((r->>'may_send')::boolean,'prepare allowed');
 r:=public.sms_gateway('prepare',jsonb_build_object('message_id',mid,'attempt',1),repeat('a',64));perform pg_temp.assert((r->>'status')::int=409,'duplicate prepare denied');
 update public.sms_messages set claim_expires_at=now()-interval '1 hour' where id=mid;
 r:=public.sms_gateway('claim','{}',repeat('a',64));perform pg_temp.assert(jsonb_array_length(r->'messages')=0,'uncertain never requeued');
 perform public.sms_gateway('status',jsonb_build_object('message_id',mid,'attempt',1,'state','delivered'),repeat('a',64));
 perform public.sms_gateway('status',jsonb_build_object('message_id',mid,'attempt',1,'state','sent'),repeat('a',64));
 perform pg_temp.assert((select state='delivered' from public.sms_messages where id=mid),'out-of-order receipt monotonic');
 perform pg_temp.assert((select sent_total=1 from public.sms_gateway_devices where id=dev),'delivery counter once');
 perform public.sms_gateway('inbound','{"phone_e164":"+447700900001","body":"STOP","idempotency_key":"inbound-test-stop001"}',repeat('a',64));
 perform pg_temp.assert(exists(select 1 from public.sms_opt_outs where company_id='60000000-0000-0000-0000-000000000001'),'STOP opt-out');
 perform public.sms_gateway('unpair','{}',repeat('a',64));
 r:=public.sms_gateway('heartbeat','{}',repeat('a',64));perform pg_temp.assert((r->>'status')::int=401,'revoked device rejected');
end$$;
reset role;
select 'release6 security transaction passed; all synthetic data rolled back' as result;
