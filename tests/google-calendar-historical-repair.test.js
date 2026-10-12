import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const calendar = fs.readFileSync("supabase/functions/google-calendar-sync/index.ts", "utf8");
const repair = fs.readFileSync("supabase/migrations/202610120007_historical_return_repair.sql", "utf8");

test("calendar title prioritises concise pickup and destination without customer name or booking reference", () => {
  assert.match(calendar, /summary: `\$\{pickupTitle\} → \$\{dropoffTitle\}`/);
  assert.match(calendar, /conciseLocation\(booking\.pickup_name, booking\.pickup_address\)/);
  assert.match(calendar, /conciseLocation\(booking\.dropoff_name, booking\.dropoff_address\)/);
  assert.doesNotMatch(calendar, /summary:[^\n]+customer_name/);
  assert.doesNotMatch(calendar, /summary:[^\n]+booking_reference/);
  assert.match(calendar, /`Booking: \$\{booking\.booking_reference/);
});

test("calendar description contains operational booking details and omits marked private notes", () => {
  for (const label of ["Booking:", "Customer:", "Contact:", "Pickup time:", "Pickup:", "Destination:", "Passengers:", "Luggage:", "Driver:", "Status:", "Payment method:", "Journey fare:", "Amount paid:", "Outstanding balance:"]) {
    assert.ok(calendar.includes(label), `missing ${label}`);
  }
  assert.match(calendar, /booking\.pickup_building_name|booking\[`\$\{prefix\}_building_name`\]/);
  assert.match(calendar, /internal\|private\|office\[ -\]\?only/i);
  assert.match(calendar, /timeZone: timezone/);
});

test("stored Google events are identity checked and reused", () => {
  assert.match(calendar, /getLinkedGoogleEvent/);
  assert.match(calendar, /extendedProperties\?\.private/);
  assert.match(calendar, /Stored Google event is not owned by this Transport booking/);
  assert.match(calendar, /method: "PATCH"/);
  assert.match(calendar, /verify_only/);
});

test("cancelled bookings only delete an identity-verified linked event", () => {
  const identity = calendar.indexOf("const linkedEvent");
  const cancelled = calendar.indexOf("const cancelled");
  const deletion = calendar.indexOf('method: "DELETE"');
  assert.ok(identity > -1 && cancelled > identity && deletion > cancelled);
  assert.match(calendar, /if \(!linkedEvent\)[\s\S]+Linked Google event no longer exists/);
});

test("historical repair is locked, tenant scoped, audited and service-only", () => {
  assert.match(repair, /pg_advisory_xact_lock/);
  assert.match(repair, /company_id=target_company_id/);
  assert.match(repair, /coalesce\(auth\.role\(\),''\) <> 'service_role'/);
  assert.match(repair, /revoke all on function public\.repair_missing_historical_return[^;]+public,anon,authenticated/);
  assert.match(repair, /historical_booking_repairs/);
  assert.match(repair, /unique\(company_id, root_booking_reference\)/);
});

test("historical repair preserves identity, combined fare, unpaid balance and driver rules", () => {
  assert.match(repair, /where company_id=target_company_id and id=target_outbound_id/);
  assert.match(repair, /outbound_fare:=ceil\(expected_combined_fare\*100\/2\)\/100/);
  assert.match(repair, /return_fare:=expected_combined_fare-outbound_fare/);
  assert.match(repair, /balance_due=expected_combined_fare/);
  assert.match(repair, /return_row\.balance_due:=0/);
  assert.match(repair, /return_row\.amount_paid:=0/);
  assert.match(repair, /return_row\.driver_id:=null/);
  assert.match(repair, /return_row\.booking_reference:=target_root_reference\|\|'-R'/);
  assert.match(repair, /Payment records now exist for this booking/);
});

test("historical return reverses full place metadata and prevents duplicates", () => {
  for (const suffix of ["address", "name", "postcode", "place_id", "lat", "lng", "country", "address_line1", "address_line2", "building_name"]) {
    assert.ok(repair.includes(`return_row.pickup_${suffix}:=outbound.dropoff_${suffix}`));
    assert.ok(repair.includes(`return_row.dropoff_${suffix}:=outbound.pickup_${suffix}`));
  }
  assert.match(repair, /A conflicting historical return already exists/);
  assert.match(repair, /related_count<>1/);
  assert.match(repair, /return_row\.journey_date:=outbound\.return_date/);
  assert.match(repair, /return_row\.journey_time:=outbound\.return_time/);
});
