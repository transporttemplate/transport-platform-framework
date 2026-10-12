const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");
const migration = read("supabase/migrations/202610120001_release_4_smart_availability.sql");
const publicFunction = read("supabase/functions/public-booking-create/index.ts");
const adminUi = read("js/availability.js");
const adminBooking = read("js/bookings.js");
const calendar = read("js/calendar.js");

test("manual availability is tenant-owned, audited and protected by RLS", () => {
  assert.match(migration, /availability_blocks[\s\S]*company_id uuid not null/);
  assert.match(migration, /enable row level security/);
  assert.match(migration, /user_can_access_company\(company_id\)/);
  assert.match(migration, /availability_block_audit/);
  assert.doesNotMatch(migration, /grant execute on function public\.check_booking_availability[^;]+authenticated/);
});

test("half-open overlap logic covers partial, overnight and multi-day intervals", () => {
  assert.match(migration, /occurrence_start < requested_end and occurrence_end > requested_start/);
  assert.doesNotMatch(migration, /occurrence_start <= requested_end/);
  assert.match(migration, /check \(ends_at > starts_at\)/);
});

test("recurrence is expanded in company local time for DST safety", () => {
  assert.match(migration, /at time zone coalesce\(s\.timezone,'Europe\/London'\)/);
  assert.match(migration, /make_interval\(days=>b\.recurrence_interval\)/);
  assert.match(migration, /make_interval\(weeks=>b\.recurrence_interval\)/);
});

test("public bookings validate outbound and return using route duration twice", () => {
  const calls = publicFunction.match(/requireAvailable\(companyId,/g) || [];
  assert.ok(calls.length >= 4, "expected preflight and final checks for both journeys");
  assert.match(publicFunction, /if \(returnAt\) await requireAvailable/);
  assert.match(publicFunction, /route\.minutes/);
  assert.match(publicFunction, /Sorry, we're fully booked/);
});

test("database trigger serialises simultaneous requests and rejects stale availability", () => {
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /create trigger enforce_booking_availability_trigger/);
  assert.match(migration, /FULLY_BOOKED/);
  assert.match(migration, /tg_op='UPDATE'[\s\S]*new\.journey_date is not distinct from old\.journey_date/);
  assert.doesNotMatch(migration, /update of journey_date,journey_time,route_duration_minutes,company_id,status/);
});

test("automatic capacity rejection is off by default", () => {
  assert.match(migration, /automatic_capacity_enforced boolean not null default false/);
  assert.doesNotMatch(migration, /automatic_capacity_enforced boolean not null default true/);
});

test("admin overrides are explicit, authorised and audited", () => {
  assert.match(adminBooking, /FULLY BOOKED CONFLICT/);
  assert.match(adminBooking, /availability_override_reason/);
  assert.match(migration, /actor is null or not public\.user_can_access_company\(new\.company_id\)/);
  assert.match(migration, /availability_override_audit/);
});

test("availability UI supports required block forms and driver leave warnings", () => {
  for (const feature of ["availabilityWholeDay", "availabilityRecurrence", "availabilityRecurrenceUntil", "data-edit-block", "data-delete-block", "addDriverLeave"]) {
    assert.match(adminUi, new RegExp(feature));
  }
  assert.match(adminUi, /conflicts with .*assigned booking/);
});

test("calendar includes fully booked and driver leave layers", () => {
  assert.match(calendar, /availability_blocks/);
  assert.match(calendar, /driver_unavailability/);
  assert.match(calendar, /Fully booked/);
  assert.match(calendar, /Driver leave/);
});

test("release 2 email and driver navigation implementations are untouched by Release 4", () => {
  assert.doesNotMatch(migration, /email_deliveries|email_scheduler|google.*api.*key/i);
  assert.doesNotMatch(publicFunction, /automatic_capacity_enforced\) throw/);
});
