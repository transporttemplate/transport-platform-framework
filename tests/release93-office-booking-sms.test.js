const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const migration=fs.readFileSync('supabase/migrations/202610270001_fix_office_new_booking_sms.sql','utf8');
const engine=migration;
const gateway=fs.readFileSync('android-gateway/src/uk/co/transportplatform/gateway/GatewayService.java','utf8');

test('office new-booking SMS is a built-in office rule using the shared channel',()=>{
 assert.match(migration,/Office new booking','booking_created','office','office_new_booking'/);
 assert.match(engine,/when 'booking_created' then case r\.recipient_type when 'office' then 'office_new_booking' else 'customer_booking_confirmation' end/);
 assert.match(engine,/when 'office' then s\.office_phone/);
 assert.match(engine,/public\.sms_channel\(c,pref\)/);
});

test('company 0003 existing SMS choice enables only its missing office rule',()=>{
 assert.match(migration,/c\.company_code='0003'/);
 assert.match(migration,/notification_channels->'office_new_booking' \? 'sms'/);
 assert.match(migration,/insert into public\.sms_automation_rules[\s\S]*false,'00:00','00:00'/);
 assert.doesNotMatch(migration,/update public\.sms_settings set[^;]*sending_enabled/i);
 assert.doesNotMatch(migration,/update public\.(bookings|payments|sms_gateway_devices)/i);
});

test('office destination and gateway SIM remain independent configuration',()=>{
 assert.match(engine,/s\.office_phone/);
 assert.match(gateway,/getInt\("sim",-1\)/);
 assert.match(gateway,/getSmsManagerForSubscriptionId\(sim\)/);
 assert.doesNotMatch(gateway,/office_phone/);
});

test('office SMS uses existing E.164 normalization and idempotent event-rule key',()=>{
 const base=fs.readFileSync('supabase/migrations/202610120008_release6_sms_gateway.sql','utf8');
 assert.match(base,/if p like '00%' then p:='\+'\|\|substr\(p,3\);elsif p like '0%' then p:='\+44'\|\|substr\(p,2\)/);
 assert.match(base,/on conflict\(company_id,idempotency_key\) do nothing/);
 assert.match(engine,/'auto:'\|\|e\.id\|\|':'\|\|r\.id/);
});
