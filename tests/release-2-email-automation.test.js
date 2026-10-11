const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const read = path => fs.readFileSync(path, 'utf8');
const driverEmail = read('supabase/functions/send-booking-email/index.ts');
const dispatcher = read('supabase/functions/email-dispatcher/index.ts');
const webhook = read('supabase/functions/resend-webhook/index.ts');
const usage = read('supabase/functions/email-usage/index.ts');
const migration = read('supabase/migrations/202610110002_email_automation.sql');
const settings = read('js/settings-email.js');

test('driver emails expose one driver amount with customer financial fields blank', () => {
  assert.match(driverEmail, /driver_amount:\s*money\(booking\.driver_amount == null \? total : booking\.driver_amount\)/);
  assert.match(driverEmail, /price: "", amount_paid: "", balance_due: "", payment_method: "", payment_status: "", payment_summary: ""/);
  assert.match(driverEmail, /const financialHtml = recipient\.type === "driver" \? "" : paymentHtml/);
});

test('all five company reminder controls are persisted with safe defaults', () => {
  for (const column of ['office_booking_reminder_emails','driver_booking_reminder_emails','unallocated_48h_emails','unallocated_24h_emails','driver_document_expiry_emails']) {
    assert.ok(settings.includes(column));
    assert.ok(migration.includes(column));
  }
  assert.match(migration, /office_booking_reminder_emails boolean not null default false/);
  assert.match(migration, /driver_booking_reminder_emails boolean not null default false/);
  assert.match(migration, /driver_document_expiry_emails boolean not null default false/);
});

test('dispatcher implements 24h office, 12h driver and 48h plus 24h unassigned windows', () => {
  assert.match(dispatcher, /minutes<=1440/);
  assert.match(dispatcher, /minutes<=720/);
  assert.match(dispatcher, /minutes<=2880/);
  assert.match(dispatcher, /office_booking_reminder_24h/);
  assert.match(dispatcher, /driver_booking_reminder_12h/);
});

test('dispatcher suppresses cancelled, completed, no-show and past-pickup reminders', () => {
  assert.match(dispatcher, /"completed","cancelled","canceled","no_show"/);
  assert.match(dispatcher, /journey\.getTime\(\)<=Date\.now\(\)/);
});

test('reassignment and unassigned state are revalidated at delivery time', () => {
  assert.match(dispatcher, /message\.category\.startsWith\("unassigned"\)&&booking\.driver_id/);
  assert.match(dispatcher, /message\.recipient_type==="driver"&&\(!driver/);
});

test('document alerts are office-only and exactly three calendar days ahead', () => {
  assert.match(dispatcher, /const target=addDays\(today,3\)/);
  assert.match(dispatcher, /"driver_document_expiry","office"/);
  assert.match(migration, /dbs_recheck/);
});

test('timezone conversion is explicit and defaults safely to Europe London', () => {
  assert.match(dispatcher, /Intl\.DateTimeFormat/);
  assert.match(dispatcher, /return"Europe\/London"/);
  assert.match(dispatcher, /represented=Date\.UTC/);
});

test('queue identity is stable and atomically unique per company', () => {
  assert.match(migration, /unique \(company_id, idempotency_key\)/);
  assert.match(dispatcher, /onConflict:"company_id,idempotency_key",ignoreDuplicates:true/);
  assert.match(migration, /for update skip locked/);
});

test('overlapping claims recover safely and remain bounded', () => {
  assert.match(migration, /claimed_at < now\(\)-interval '10 minutes'/);
  assert.match(migration, /least\(batch_size,100\)/);
  assert.match(migration, /attempt_count < m\.max_attempts/);
});

test('retry schedule is 5 minutes, 30 minutes and 2 hours with four attempts maximum', () => {
  assert.match(dispatcher, /\[0,5,30,120\]\[attempt\]/);
  assert.match(migration, /max_attempts integer not null default 4/);
});

test('webhook verifies signed raw payload and resolves tenancy only by provider id', () => {
  assert.match(webhook, /request\.text\(\)/);
  assert.match(webhook, /svix-signature/);
  assert.match(webhook, /crypto\.subtle\.sign/);
  assert.match(webhook, /\.eq\("provider_message_id",providerId\)/);
  assert.doesNotMatch(webhook, /company_id.*event/);
});

test('quota is fetched server-side and dispatch halts at 95 percent', () => {
  assert.match(dispatcher, /https:\/\/api\.resend\.com\/usage/);
  assert.match(dispatcher, /ratio>=\.95/);
  assert.doesNotMatch(read('js/email-usage.js'), /EMAIL_PROVIDER_API_KEY/);
});

test('tenant RLS and aggregate-only platform reporting are explicit', () => {
  assert.match(migration, /user_can_access_company\(company_id\)/);
  assert.match(usage, /platformAggregate/);
  assert.doesNotMatch(usage, /function platformAggregate[\s\S]*recipient:/);
});

test('template backfill is non-overwriting and future tenants are provisioned', () => {
  assert.match(migration, /on conflict\(company_id,template_key\) do nothing/);
  assert.match(migration, /provision_company_email_templates_after_insert/);
});

test('retention cleanup is available but is not scheduled', () => {
  assert.match(migration, /delete_expired_email_telemetry/);
  assert.match(migration, /interval '12 months'/);
  assert.doesNotMatch(migration, /cron\.schedule/);
});
