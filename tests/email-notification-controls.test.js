const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const read = file => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const sender = read("supabase/functions/send-booking-email/index.ts");
const dispatcher = read("supabase/functions/email-dispatcher/index.ts");
const legacyReminder = read("supabase/functions/unallocated-booking-reminders/index.ts");
const migration = read("supabase/migrations/202610120003_email_notification_channels.sql");
const ui = read("settings-email.html");

test("all twelve company email controls remain present in the Email Settings UI", () => {
  for (const id of [
    "emailNotifications", "customerBookingEmails", "officeNewBookingEmails", "driverAssignmentEmails",
    "bookingChangeEmails", "cancellationEmails", "paymentConfirmationEmails", "officeBookingReminderEmails",
    "driverBookingReminderEmails", "unallocated48hEmails", "unallocated24hEmails", "driverDocumentExpiryEmails",
  ]) assert.match(ui, new RegExp(`id="${id}"`));
});

test("transactional event checkboxes are enforced before provider delivery", () => {
  const mappings = {
    customer_booking_confirmation: "customer_booking_emails",
    office_new_booking: "office_new_booking_emails",
    driver_assignment: "driver_assignment_emails",
    booking_changes: "booking_change_emails",
    cancellations: "cancellation_emails",
    payment_confirmation: "payment_confirmation_emails",
  };
  for (const [key, column] of Object.entries(mappings)) {
    assert.match(sender, new RegExp(`emailPreferenceEnabled\\(settings, "${key}", settings\\.${column}`));
  }
  assert.match(sender, /if \(settings\.emailnotifications === false\)[\s\S]*return json\(\{ ok: true, sent: false/);
  assert.match(sender, /if \(!recipients\.length\)[\s\S]*return json\(\{ ok: true, sent: false/);
});

test("reminder controls are checked both when queued and immediately before delivery", () => {
  for (const key of ["office_booking_reminder_24h", "driver_booking_reminder_12h", "unassigned_48h", "unassigned_24h", "driver_document_expiry"]) {
    assert.match(dispatcher, new RegExp(`emailPreferenceEnabled\\([^,]+, "${key}"`));
  }
  assert.match(dispatcher, /!reminderAllowed\(settings, message\.category\)/);
  assert.match(dispatcher, /if \(settings\.emailnotifications === false\) return false/);
});

test("legacy unallocated reminders cannot bypass independent 48h and 24h preferences", () => {
  assert.match(legacyReminder, /unallocated_48h_emails,unallocated_24h_emails/);
  assert.match(legacyReminder, /"unassigned_24h", settings\.unallocated_24h_emails !== false/);
  assert.match(legacyReminder, /"unassigned_48h", settings\.unallocated_48h_emails !== false/);
  assert.match(sender, /threshold <= 1440[\s\S]*unallocated_24h_emails[\s\S]*unallocated_48h_emails/);
});

test("channel overrides support email only, SMS only, both and neither without enabling SMS delivery", () => {
  assert.match(migration, /notification_channels jsonb not null default '\{\}'::jsonb/);
  assert.match(migration, /Missing keys preserve legacy email boolean behaviour; SMS delivery is not implemented/);
  assert.match(sender, /Array\.isArray\(configured\) \? configured\.includes\("email"\) : legacyEnabled/);
  assert.doesNotMatch(`${sender}\n${dispatcher}\n${legacyReminder}`, /send[-_ ]?sms|android.*gateway/i);
});

test("channel resolution preserves legacy values and suppresses SMS-only email", () => {
  const source = sender.match(/function emailPreferenceEnabled\(settings: Row, key: string, legacyEnabled: boolean\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(source);
  const runnable = source.replace(/: Row|: string|: boolean/g, "");
  const context = {};
  vm.runInNewContext(`${runnable}; result = [
    emailPreferenceEnabled({}, "driver_booking_reminder_12h", true),
    emailPreferenceEnabled({}, "driver_booking_reminder_12h", false),
    emailPreferenceEnabled({notification_channels:{driver_booking_reminder_12h:["email"]}}, "driver_booking_reminder_12h", false),
    emailPreferenceEnabled({notification_channels:{driver_booking_reminder_12h:["sms"]}}, "driver_booking_reminder_12h", true),
    emailPreferenceEnabled({notification_channels:{driver_booking_reminder_12h:["email","sms"]}}, "driver_booking_reminder_12h", false),
    emailPreferenceEnabled({notification_channels:{driver_booking_reminder_12h:[]}}, "driver_booking_reminder_12h", true)
  ];`, context);
  assert.deepEqual(Array.from(context.result), [true, false, true, false, true, false]);
});

test("company isolation, privacy and deduplication remain server-side", () => {
  assert.match(sender, /\.eq\("company_id", companyId\)\.eq\("id", bookingId\)/);
  assert.match(sender, /\.eq\("company_id", companyId\)\.in\("id", driverIds\)/);
  assert.match(sender, /recipient\.type === "driver"[\s\S]*price: ""[\s\S]*payment_summary: ""/);
  assert.match(dispatcher, /\.eq\("company_id", config\.company_id\)/);
  assert.match(dispatcher, /onConflict: "company_id,idempotency_key", ignoreDuplicates: true/);
  assert.match(dispatcher, /const quota = await providerUsage\(\)/);
});

test("the automatic scheduler remains fail-closed", () => {
  assert.match(dispatcher, /EMAIL_AUTOMATION_ENABLED/);
  assert.match(dispatcher, /if \(!automationEnabled \|\| !Number\.isFinite\(activationTime\)\)/);
});
