const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "availability.html"), "utf8");
const logic = fs.readFileSync(path.join(root, "js/availability.js"), "utf8");

test("Fully Booked header keeps Refresh outside the management form", () => {
  const topbar = html.match(/<div class="topbar">([\s\S]*?)<\/div>\s*<section class="card">/)?.[1] || "";
  assert.match(topbar, /id="refreshAvailability"/);
  assert.doesNotMatch(topbar, /availabilityBlockForm/);
});

test("desktop layout expands the list and gives an open form its own bounded panel", () => {
  assert.match(html, /\.block-layout\{[^}]*grid-template-columns:minmax\(0,1fr\)/);
  assert.match(html, /\.block-layout\.form-open\{[^}]*minmax\(420px,1\.35fr\)[^}]*minmax\(320px,\.8fr\)/);
  assert.match(html, /\.availability-form\{[^}]*border:[^}]*background:#f8fafc/);
  assert.match(logic, /classList\.add\("form-open"\)/);
  assert.match(logic, /classList\.remove\("form-open"\)/);
});

test("responsive breakpoints prevent horizontal overflow at tablet and phone widths", () => {
  assert.match(html, /@media\(max-width:1100px\)/);
  assert.match(html, /@media\(max-width:850px\)/);
  assert.match(html, /@media\(max-width:600px\)/);
  assert.match(html, /grid-template-columns:repeat\(7,minmax\(0,1fr\)\)/);
  assert.match(html, /\.availability-form-grid\{grid-template-columns:1fr\}/);
  assert.match(html, /font-size:16px/);
});

test("existing controls and tenant-scoped availability behavior remain wired", () => {
  for (const id of ["previousAvailabilityMonth","nextAvailabilityMonth","availabilityListView","availabilityCalendarView","availabilityWholeDay","availabilityRecurrence","availabilityRecurrenceUntil","saveAvailabilityBlock"]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(logic, /\.eq\("company_id", availabilityCompanyId\)/);
  assert.match(logic, /automatic_capacity_enforced:false/);
  assert.match(logic, /End must be after start/);
});
