const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = file => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const html = read("bookings.html");
const primary = read("js/bookings.js");
const secondary = read("js/all-bookings.js");
const migration = read("supabase/migrations/202610110001_admin_edit_booking.sql");
const correction = read("supabase/migrations/202610180001_status_aware_booking_corrections.sql");

test("the compact Admin form provides a responsive create/edit experience", () => {
  assert.match(html, /id="bookingFormTitle"/);
  assert.match(html, /id="saveBookingButton"[^>]*>Save Job/);
  assert.match(html, /id="cancelBookingEdit"/);
  assert.match(html, /id="priceOverrideReason"/);
  assert.match(html, /id="paidFareWarning"/);
  assert.match(html, /id="returnJourney"/);
  assert.match(primary, /Save Changes/);
  assert.match(primary, /beforeunload/);
  assert.match(secondary, /bookings\.html\?edit=/);
});

test("normal edits preserve identity and update customer, journey and route fields", () => {
  assert.match(primary, /rpc\("admin_edit_booking"/);
  assert.match(primary, /customer_name:/);
  assert.match(primary, /pickup_place_id:/);
  assert.match(primary, /dropoff_place_id:/);
  assert.match(primary, /route_distance_miles:/);
  assert.match(primary, /requested_stops:collectAdminViaStops/);
  assert.doesNotMatch(migration, /delete from public\.bookings/i);
  assert.doesNotMatch(migration, /booking_reference\s*=/i);
  assert.doesNotMatch(migration, /payment_status\s*=/i);
});

test("server edit RPC enforces tenant ownership, roles and concurrent-edit safety", () => {
  assert.match(migration, /auth\.uid\(\) is null or not public\.user_can_access_company\(target_company_id\)/);
  assert.match(migration, /where id=target_booking_id and company_id=target_company_id for update/);
  assert.match(migration, /old_row\.edit_version<>coalesce\(expected_edit_version,0\)/);
  assert.match(migration, /Booking edit conflict/);
  assert.match(migration, /security definer set search_path=public/);
  assert.match(migration, /revoke all on function public\.admin_edit_booking[\s\S]*from public,anon/);
});

test("paid, active and completed booking protections are status-aware", () => {
  assert.match(primary, /Changing the fare will not charge or refund the customer/);
  assert.doesNotMatch(primary, /This booking is active or closed/);
  assert.match(correction, /Completed or closed journey history cannot change route, schedule, stops or driver/);
  assert.match(correction, /assigned driver cannot be replaced after passenger pickup/);
  assert.match(correction, /separate financial correction workflow/);
  assert.doesNotMatch(migration, /amount_paid\s*=/i);
  assert.doesNotMatch(migration, /paid_at\s*=/i);
});

test("fare overrides, driver reassignment and audit history are protected", () => {
  assert.match(html, /Manual fare override reason/);
  assert.match(migration, /A fare-change reason is required/);
  assert.match(migration, /Driver already has an overlapping booking/);
  assert.match(migration, /Driver is unavailable for this journey/);
  assert.match(migration, /insert into public\.admin_booking_audit/);
  assert.match(migration, /admin_user_id/);
  assert.match(migration, /previous_values/);
  assert.match(migration, /new_values/);
});

test("invalid passenger, luggage, return and address values are rejected server-side", () => {
  assert.match(migration, /Passengers must be between 1 and 52/);
  assert.match(migration, /Invalid luggage quantity/);
  assert.match(migration, /Return date and time are required/);
  assert.match(migration, /Pickup and destination are required/);
});
