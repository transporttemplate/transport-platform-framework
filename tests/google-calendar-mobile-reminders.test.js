import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const calendar = fs.readFileSync("supabase/functions/google-calendar-sync/index.ts", "utf8");

test("mobile title keeps route first and uses concise airport labels", () => {
  assert.match(calendar, /summary: `\$\{pickupTitle\} → \$\{dropoffTitle\}`/);
  assert.match(calendar, /LHR[\s\S]+Heathrow/);
  assert.match(calendar, /Heathrow T\$\{lhrPair\[1\]\}\/\$\{lhrPair\[2\]\}/);
  assert.match(calendar, /Heathrow\$\{heathrow\[1\] \? ` T/);
  assert.match(calendar, /Gatwick/);
  assert.match(calendar, /named = text\.match[^\n]+Airport/);
  assert.match(calendar, /addressLocality\(full\)/);
  assert.match(calendar, /recognisableBusiness/);
  assert.match(calendar, /value\.length > 42/);
});

test("full addresses and booking reference remain in the description", () => {
  assert.match(calendar, /`Booking: \$\{booking\.booking_reference/);
  assert.match(calendar, /`Pickup: \$\{pickupAddress\}`/);
  assert.match(calendar, /`Destination: \$\{dropoffAddress\}`/);
  assert.match(calendar, /location: booking\.pickup_address/);
});

test("Jeff reminder is an exact 12-hour popup override", () => {
  assert.match(calendar, /reminders: \{ useDefault: false, overrides: \[\{ method: "popup", minutes: 720 \}\] \}/);
  assert.match(calendar, /company_code \|\| ""\) === "0003"/);
  assert.match(calendar, /\.\.\.\(jeffReminder \?/);
});

test("other companies retain their existing reminder behavior", () => {
  assert.doesNotMatch(calendar, /company_code[^\n]+(?:0001|0002|0004)/);
  assert.match(calendar, /jeffReminder \? \{ reminders:[^\n]+\} : \{\}/);
});

test("existing-only backfill cannot create a missing event", () => {
  const guard = calendar.indexOf("if (existingOnly && (!booking.google_calendar_event_id || !linkedEvent))");
  const create = calendar.indexOf("googleEvent = await createGoogleEvent", guard);
  assert.ok(guard > -1 && create > guard);
  assert.match(calendar, /No identity-verified linked Google event/);
  assert.match(calendar, /Linked Google event disappeared before update/);
});

test("event ownership includes company, booking and booking reference", () => {
  assert.match(calendar, /privateProperties\.company_id/);
  assert.match(calendar, /privateProperties\.booking_id/);
  assert.match(calendar, /searchable\.includes\(bookingReference\)/);
  assert.match(calendar, /Stored Google event does not match this booking reference/);
});

test("event updates preserve IDs and cancellations retain the protected delete path", () => {
  assert.match(calendar, /method: "PATCH"/);
  assert.match(calendar, /method: "DELETE"/);
  assert.match(calendar, /if \(booking\.google_calendar_event_id && linkedEvent\)/);
  assert.match(calendar, /action = "updated"/);
});
