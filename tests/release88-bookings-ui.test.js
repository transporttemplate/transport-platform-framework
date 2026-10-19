const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");
const bookings = read("js/bookings.js");
const allBookings = read("js/all-bookings.js");
const menu = read("js/booking-action-menu.js");
const css = read("css/booking-compact.css");

test("driver data is available before booking rows render", () => {
  for (const source of [bookings, allBookings]) {
    const startup = source.slice(source.indexOf('document.addEventListener("DOMContentLoaded"'), source.indexOf("function bindBookingEvents"));
    assert.ok(startup.indexOf("loadDrivers()") < startup.indexOf("loadBookings()"));
    assert.match(source, /Assigned driver unavailable/);
    assert.match(source, /Driver list unavailable — refresh/);
    assert.match(source, /active === false \? "INACTIVE" : driver\.online \? "ONLINE" : "OFFLINE"/);
    assert.match(source, /suggested_vehicle_registration/);
  }
});

test("each booking row exposes one shared Actions trigger", () => {
  for (const source of [bookings, allBookings]) {
    const row = source.slice(source.indexOf("function bookingRowHtml"), source.indexOf("async function assignBookingDriver"));
    assert.equal((row.match(/data-booking-menu=/g) || []).length, 1);
    assert.match(row, /aria-haspopup="menu"/);
    assert.doesNotMatch(row, />View<|>Edit<|>Cancel<|>No Show</);
  }
});

test("Actions menu is viewport-aware and keyboard accessible", () => {
  assert.match(menu, /anchorRect\.bottom \+ rect\.height <= innerHeight/);
  assert.match(menu, /innerWidth - rect\.width - 8/);
  assert.match(menu, /event\.key\s*===\s*"Tab"/);
  assert.match(menu, /event\.key\s*===\s*"Escape"/);
  assert.match(menu, /aria-expanded/);
  for (const label of ["View booking details", "Edit booking", "Assign driver", "Adjust fare", "Message driver", "Message customer", "Resend confirmation email", "View payment history", "View journey / GPS playback", "View booking activity", "Mark No Show", "Cancel booking", "Archive / Void", "Permanently Delete Booking"]) {
    assert.ok(menu.includes(label), `missing action: ${label}`);
  }
  assert.match(menu, /signInWithPassword/);
  assert.match(menu, /booking_permanent_delete_eligibility/);
});

test("compact desktop rows and responsive booking cards are shared", () => {
  assert.match(css, /height:52px/);
  assert.match(css, /@media\(max-width:900px\)/);
  assert.match(css, /@media\(max-width:520px\)/);
  assert.match(css, /grid-template-columns/);
  assert.match(css, /\.compact-route-cell span/);
  assert.match(read("bookings.html"), /css\/booking-compact\.css/);
  assert.match(read("all-bookings.html"), /css\/booking-compact\.css/);
});

test("tenant scoping remains explicit in driver and booking actions", () => {
  for (const source of [bookings, allBookings]) {
    assert.match(source, /\.eq\(\s*"company_id",\s*adminCompanyId\s*\)/);
  }
  assert.match(menu, /String\(booking\.company_id\) !== String\(adminCompanyId\)/);
  assert.match(menu, /target_company_id:adminCompanyId/);
});
