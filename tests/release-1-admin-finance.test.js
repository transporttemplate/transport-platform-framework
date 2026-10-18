const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = file => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const auth = read("js/auth.js");
const settings = read("js/settings.js");
const payments = read("settings-payments.html");
const primary = read("js/bookings.js");
const secondary = read("js/all-bookings.js");
const menu = read("js/booking-action-menu.js");
const finance = read("js/accounts.js");
const css = read("css/admin.css");

test("Admin inactivity logout uses genuine interaction, warning and cross-tab state", () => {
  assert.match(auth, /ADMIN_IDLE_LIMIT_MS = 30 \* 60 \* 1000/);
  assert.match(auth, /ADMIN_IDLE_WARNING_MS = 2 \* 60 \* 1000/);
  for (const event of ["pointerdown", "keydown", "touchstart", "scroll"]) assert.match(auth, new RegExp(`"${event}"`));
  assert.doesNotMatch(auth, /mousemove/);
  assert.match(auth, /Stay Logged In/);
  assert.match(auth, /window\.addEventListener\("storage"/);
  assert.match(auth, /adminIdleCleanup\?\.\(\)/);
  assert.match(auth, /pageshow[\s\S]*startAdminInactivity\(session\)/);
  assert.match(auth, /adminAuthUrl\("login\.html"\)/);
});

test("payment changes show company and mode warnings without accepting secret keys or surcharges", () => {
  for (const heading of ["LIVE PAYMENT CONFIGURATION", "STRIPE API KEY WARNING", "ENABLE STRIPE WARNING", "DISABLE STRIPE WARNING", "CARD SURCHARGE WARNING"]) {
    assert.match(payments, new RegExp(heading));
  }
  assert.match(settings, /\^sk_\(test\|live\)_/);
  assert.match(settings, /window\.ADMIN_COMPANY/);
  assert.match(settings, /Stripe mode: \$\{mode\}/);
  assert.match(settings, /Payment settings changing/);
  assert.match(settings, /Consumer card surcharges are not supported/);
  assert.doesNotMatch(payments, /id="[^\"]*secret[^\"]*"/i);
});

test("commission display distinguishes unassigned, company, driver override and fixed pay", () => {
  assert.match(secondary, /if \(!booking\?\.driver_id\) return `Not applied — default company commission:/);
  assert.match(secondary, /driver\?\.pay_type === "fixed"/);
  assert.match(secondary, /driver\?\.commission_percent \?\? companyRate/);
  assert.match(secondary, /driver_amount \?\? booking\.price \?\? booking\.job_price/);
  assert.match(primary, /commission_percent,[\s\S]{0,80}fixed_job_amount/);
  assert.match(secondary, /commission_percent,[\s\S]{0,80}fixed_job_amount/);
  assert.match(finance, /if \(!driver\) return 0/);
  assert.match(finance, /commission_percent \?\? financeSettings\.drivercommission/);
});

test("booking action menu is tenant-scoped, status-aware and keyboard/touch accessible", () => {
  assert.match(menu, /String\(booking\.company_id\) !== String\(adminCompanyId\)/);
  assert.match(menu, /accepted", "on_way", "arrived", "passenger_onboard", "completed"/);
  assert.match(menu, /contextmenu/);
  assert.match(menu, /data-booking-menu/);
  assert.match(menu, /ArrowDown/);
  assert.match(menu, /Escape/);
  assert.match(menu, /requestBookingConfirmation/);
  assert.match(menu, /cancelBooking/);
  assert.match(menu, /\.eq\("company_id", adminCompanyId\)\.eq\("booking_id", booking\.id\)/);
  assert.match(primary, /data-booking-id=/);
  assert.match(secondary, /data-booking-id=/);
  assert.match(css, /booking-action-menu button\{[^}]*min-height:44px/);
  assert.match(css, /booking-menu-trigger\{[^}]*min-width:44px/);
});

test("Edit Booking uses the protected status-aware correction RPC", () => {
  assert.match(primary, /rpc\("admin_edit_booking"/);
  assert.doesNotMatch(primary, /This booking is active or closed/);
  assert.match(primary, /bookingCorrectionReason/);
  assert.match(primary, /Changing the fare will not charge or refund the customer/);
});
