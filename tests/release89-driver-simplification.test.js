const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");
const html = read("driver.html");
const js = read("js/driver.js");
const css = read("css/driver.css");
const edge = read("supabase/functions/driver-portal/index.ts");

test("home is a genuinely minimalist branded surface", () => {
  const home = html.slice(html.indexOf('id="view-home"'), html.indexOf('id="view-jobs"'));
  assert.match(home, /homeAvailableButton/);
  assert.match(home, /homeBusyButton/);
  assert.match(home, /homeCompanyLogo/);
  for (const label of ["Bookings", "Messages", "Earnings", "More"]) assert.match(home, new RegExp(`>${label}<`));
  assert.doesNotMatch(home, /Today.s earnings|Jobs today|Zones|Base|Bids|Panic/i);
  assert.match(css, /\.home-brand-stage/);
  assert.match(css, /\.viewing-driver-home \.app-header,.viewing-driver-home \.bottom-nav\{display:none\}/);
  assert.match(css, /\.viewing-driver-home[^}]*background:#070b13/);
});

test("company logo is supplied by the authenticated tenant and fails safely", () => {
  assert.match(edge, /settings"\)\.select\("company_id,[^"]*companylogo/);
  assert.match(edge, /\.eq\("company_id",s\.company_id\)/);
  assert.match(js, /\^https:\\\/\\\//);
  assert.match(js, /homeImage\.onerror/);
  assert.match(js, /homeCompanyFallback/);
});

test("availability uses only the authoritative online state", () => {
  for (const reason of ["Short break", "Long break / Engaged", "Hired"]) assert.match(html, new RegExp(`data-busy-reason="${reason.replace(" / ", " \/ ")}"`));
  assert.match(js, /driverPortalRequest\("set_online", \{ online: goingOnline \}\)/);
  assert.doesNotMatch(js, /driverPortalRequest\("complete_job"[^]*data-busy-reason/);
  assert.match(js, /driverUnavailable[\s\S]{0,100}Use I'm Back first/);
  assert.match(edge, /async function setOnline[\s\S]{0,180}\.eq\("company_id",s\.company_id\)\.eq\("id",s\.driver_id\)/);
  assert.match(js, /event\.key === "Escape"/);
});

test("bookings provide the four simplified sections and preserve workflow actions", () => {
  for (const tab of ["upcoming", "next_day", "my_jobs", "completed"]) assert.match(html, new RegExp(`data-booking-tab="${tab}"`));
  assert.match(js, /simplifiedBookingRow/);
  assert.match(js, /data-job-action="accepted"/);
  assert.match(js, /data-job-action="declined"/);
  assert.match(js, /data-job-action="on_way"/);
  assert.match(js, /companyDateKey/);
  assert.match(html, /arrivedButton/);
  assert.match(html, /pobButton/);
  assert.match(html, /dropOffButton/);
  assert.match(html, /paymentConfirmationModal/);
  assert.match(html, /id="operationalJourney" class="operational-journey hidden"/);
});

test("completed rows and details expose driver earnings rather than customer fare", () => {
  assert.match(js, /job\?\.driver_amount != null/);
  assert.match(js, /money\(driverEarning\(job\)\)/);
  assert.match(js, /setText\("currentFare", money\(driverEarning\(currentJob\)\)\)/);
  assert.match(js, /setText\("detailFare", money\(driverEarning\(job\)\)\)/);
  assert.match(html, /Driver earnings/);
  assert.match(edge, /const visibleAmount=driver_amount\?\?null/);
  assert.match(edge, /price:visibleAmount,driver_amount:driver_amount\?\?null/);
});

test("side menu contains only implemented driver tools", () => {
  const menu = html.slice(html.indexOf('id="driverSideMenu"'), html.indexOf('<main class="app-main">'));
  for (const label of ["Home", "Bookings", "Earnings", "Messages", "Availability", "Vehicle", "Expenses", "Settings", "Devices / GPS", "Help", "Log Off"]) assert.match(menu, new RegExp(label.replace(" / ", " \\/ ")));
  assert.doesNotMatch(menu, /Zones|Base|Bids|Panic/);
  assert.match(menu, /menuVehicleRegistration/);
});

test("mobile layout respects safe areas and avoids horizontal expansion", () => {
  assert.match(html, /viewport-fit=cover/);
  assert.match(css, /env\(safe-area-inset-top\)/);
  assert.match(css, /env\(safe-area-inset-bottom\)/);
  assert.match(css, /@media\(max-width:520px\)/);
  assert.match(css, /minmax\(0,1fr\)/);
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)/);
});
