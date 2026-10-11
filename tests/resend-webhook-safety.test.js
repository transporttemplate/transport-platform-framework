const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const webhook = fs.readFileSync('supabase/functions/resend-webhook/index.ts', 'utf8');
const migration = fs.readFileSync('supabase/migrations/202610110004_resend_webhook_safety.sql', 'utf8');

const events = ['email.sent','email.delivered','email.bounced','email.failed','email.complained','email.delivery_delayed','email.suppressed'];

test('all seven selected Resend events are accepted and constrained', () => {
  for (const event of events) { assert.ok(webhook.includes(`"${event}"`)); assert.ok(migration.includes(`'${event}'`)); }
  assert.match(migration, /'suppressed','cancelled'/);
});

test('raw body and all Svix signature fields are verified before JSON parsing', () => {
  const raw = webhook.indexOf('request.text()'), verified = webhook.indexOf('await verify('), parsed = webhook.indexOf('JSON.parse(raw)');
  assert.ok(raw >= 0 && verified > raw && parsed > verified);
  for (const header of ['svix-id','svix-timestamp','svix-signature']) assert.ok(webhook.includes(header));
  assert.match(webhook, /Math\.abs\(Date\.now\(\) \/ 1000 - Number\(timestamp\)\) > 300/);
  assert.match(webhook, /crypto\.subtle\.sign\("HMAC"/);
  assert.match(webhook, /if \(a\.length !== b\.length\) return false/);
});

test('invalid signatures cannot reach the database RPC', () => {
  assert.ok(webhook.indexOf('return json({ ok: false, error: "Invalid signature" }, 401)') < webhook.indexOf('.rpc("process_resend_webhook_event"'));
});

test('webhook identity is unique and concurrent replays are idempotent', () => {
  assert.match(migration, /event_id text not null unique/);
  assert.match(migration, /on conflict\(event_id\) do nothing returning id into event_row_id/);
  assert.match(migration, /for update/);
  assert.match(migration, /'duplicate'::text,false/);
});

test('recording and state changes occur in one database transaction', () => {
  assert.match(migration, /create or replace function public\.process_resend_webhook_event/);
  assert.match(migration, /insert into public\.email_webhook_events/);
  assert.match(migration, /update public\.email_messages set/);
  assert.match(migration, /update public\.email_webhook_events set applied=should_apply/);
  assert.doesNotMatch(webhook, /\.from\("email_messages"\)\.update/);
});

test('older and lower-progress events cannot regress terminal outcomes', () => {
  assert.match(migration, /target\.state in \('delivered','bounced','failed','complained','suppressed'\) and incoming_state in \('accepted','delayed'\)/);
  assert.match(migration, /p_provider_created_at < target\.provider_event_at/);
  assert.match(migration, /p_provider_created_at = target\.provider_event_at and incoming_priority <= current_priority/);
});

test('conflicting terminal events use provider time then explicit precedence', () => {
  for (const pair of ["'delivered' then 30","'failed' then 40","'suppressed' then 50","'bounced' then 60","'complained' then 70"]) assert.ok(migration.includes(pair));
  assert.match(migration, /provider_event_at=p_provider_created_at/);
});

test('company isolation derives only from the provider message record', () => {
  assert.match(migration, /where provider_message_id=p_provider_message_id for update/);
  assert.match(migration, /target\.id,target\.company_id/);
  assert.doesNotMatch(webhook, /company_id|p_company/i);
  assert.doesNotMatch(migration, /p_company_id/);
});

test('ledger is service-only and stores no message body or recipient address', () => {
  assert.match(migration, /revoke all on public\.email_webhook_events from public, anon, authenticated/);
  assert.match(migration, /grant select, insert, update on public\.email_webhook_events to service_role/);
  assert.doesNotMatch(migration, /recipient|subject|body|payload json/i);
});

test('suppression and failure reasons are sanitised and bounded', () => {
  assert.match(webhook, /data\?\.suppressed\?\.message/);
  assert.match(webhook, /replace\(\/\[\\r\\n<>\]\/g, " "\).*slice\(0, 500\)/);
  assert.match(migration, /regexp_replace\(coalesce\(p_reason,''\),'\[\\r\\n\]\+'/);
});
