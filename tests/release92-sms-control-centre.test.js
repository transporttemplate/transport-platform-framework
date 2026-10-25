const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const sql=fs.readFileSync('supabase/migrations/202610250003_release92_sms_control_centre.sql','utf8');
const html=fs.readFileSync('sms-admin.html','utf8'),js=fs.readFileSync('js/sms-admin.js','utf8');
const handler=fs.readFileSync('supabase/functions/sms-gateway/handler.ts','utf8');

test('master control is self-service, confirmed, audited and cancels stale work',()=>{
 assert.match(html,/Master SMS System/);assert.match(js,/ENABLE SMS/);
 assert.match(sql,/action='master'/);assert.match(sql,/master_changed/);
 assert.match(sql,/state='cancelled',error_code='MASTER_DISABLED'/);
 assert.match(sql,/Gateway readiness checks have not passed/);
});
test('controlled test mode is isolated short lived and required before activation',()=>{const testSql=fs.readFileSync('supabase/migrations/202610250005_release92_controlled_sms_test.sql','utf8');assert.match(html,/runSmsTest/);assert.match(js,/smsRpc\("test"/);assert.match(testSql,/TEST_MODE_ISOLATION/);assert.match(testSql,/10 minutes/);assert.match(testSql,/controlled test send and receive before activation/);assert.match(testSql,/idempotency_key like 'test:%'/);});
test('all tenants and future tenants remain off by default',()=>{
 assert.match(sql,/update public\.sms_settings set sending_enabled=false/);
 assert.match(sql,/values\(c,false,false\)/);assert.match(sql,/t\.body,false,t\.marketing/);
 assert.doesNotMatch(sql,/set sending_enabled=true[^,]/i);
});
test('scheduler is installed, idempotent and only runs enabled companies',()=>{
 assert.match(sql,/sms_scheduler_tick/);assert.match(sql,/release92-sms-automation/);
 assert.match(sql,/where enabled and sending_enabled/);assert.match(sql,/state='expired'/);
 assert.match(sql,/public\.sms_run_automations/);
});
test('new automation catalogue includes changed, allocated and external office alerts',()=>{
 for(const key of ['booking_changed','driver_allocated','external_booking_created']){assert.ok(sql.includes(`'${key}'`));assert.ok(js.includes(key));}
 assert.match(sql,/booking_source.*external_dispatch/);assert.match(sql,/recipient_type.*office/s);
});
test('gateway routing, telemetry, limits and credentials remain server-side',()=>{
 assert.match(sql,/credential_hash=token_hash and revoked_at is null/);
 assert.match(sql,/daily_send_limit/);assert.match(sql,/monthly_send_limit/);
 assert.match(handler,/selected_sim/);assert.match(handler,/gateway_running/);
 assert.doesNotMatch(js,/credential_hash|gateway_pin_hash|x-gateway-token/);
});
test('templates use an explicit safe variable allow-list',()=>{
 for(const key of ['vehicle_registration','secure_tracking_link','provider_name','admin_link'])assert.ok(sql.includes(`'${key}'`));
 assert.match(sql,/Unsupported template variable/);assert.doesNotMatch(sql,/private_notes.*allowed|api_secret.*allowed/);
});
test('manual sends fail closed while master is off and marketing protections remain',()=>{
 assert.match(sql,/action='reply'.*sending_enabled/s);assert.match(sql,/manual replies are blocked/);
 const base=fs.readFileSync('supabase/migrations/202610120008_release6_sms_gateway.sql','utf8');
 assert.match(base,/sms_opt_outs/);assert.match(base,/sms_consents/);assert.match(base,/Inbound STOP/);
});
test('Data API access remains explicit and tenant-admin scoped',()=>{
 assert.match(sql,/revoke all on function public\.sms_admin_release6/);
 assert.match(sql,/grant execute on function public\.sms_admin\(uuid,text,jsonb\) to authenticated/);
 assert.match(sql,/public\.sms_is_admin\(c\)/);assert.doesNotMatch(sql,/grant all on .* to anon/i);
});
