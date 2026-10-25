const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const read = path => fs.readFileSync(path, 'utf8');

test('Booking Rules exposes two independent company switches', () => {
  const html=read('settings-booking.html'),js=read('js/settings.js');
  assert.match(html,/Show Wheelchair Requirements/);
  assert.match(html,/Show Accessibility Requirements/);
  assert.match(js,/showWheelchairRequirements:\s*"show_wheelchair_requirements"/);
  assert.match(js,/showAccessibilityRequirements:\s*"show_accessibility_requirements"/);
});

test('new and future companies default both fields off with explicit grants',()=>{
  const sql=read('supabase/migrations/202610250002_release911_configurable_booking_fields.sql');
  assert.match(sql,/show_wheelchair_requirements boolean not null default false/);
  assert.match(sql,/show_accessibility_requirements boolean not null default false/);
  assert.match(sql,/grant select \(show_wheelchair_requirements,show_accessibility_requirements\)[^;]+to anon/s);
  assert.match(sql,/grant update \(show_wheelchair_requirements,show_accessibility_requirements\)[^;]+to authenticated/s);
  assert.doesNotMatch(sql,/update public\.bookings|delete from public\.bookings/i);
});

test('Admin fields collapse when disabled but saved requirements remain reviewable',()=>{
  const html=read('bookings.html'),js=read('js/bookings.js');
  assert.match(html,/booking-rule-field\[hidden\]\{display:none!important\}/);
  assert.match(js,/bookingFieldRules\s*=\s*\{ wheelchair: false, accessibility: false \}/);
  assert.match(js,/bookingFieldRules\.wheelchair\|\|hasWheelchair/);
  assert.match(js,/bookingFieldRules\.accessibility\|\|hasAccessibility/);
  assert.match(js,/applyAdminBookingFieldRules\(booking\)/);
  assert.match(js,/viewWheelchair/);
  assert.match(js,/viewAccessibility/);
});

test('public fields use the resolved company settings and submit no disabled data',()=>{
  const html=read('booking.html'),js=read('js/booking.js'),edge=read('supabase/functions/public-booking-create/index.ts');
  assert.match(html,/publicWheelchairRequirementsField[^>]+hidden/);
  assert.match(html,/publicAccessibilityRequirementsField[^>]+hidden/);
  assert.match(js,/pricingSettings\.show_wheelchair_requirements===true/);
  assert.match(js,/pricingSettings\.show_accessibility_requirements===true/);
  assert.match(edge,/bool\(settings\.show_wheelchair_requirements\) \? bool\(booking\.wheelchair_required\) : false/);
  assert.match(edge,/bool\(settings\.show_accessibility_requirements\)[^\n]+: null/);
  assert.doesNotMatch(edge,/show_wheelchair_requirements.*respond|show_accessibility_requirements.*respond/);
});

test('Driver Portal keeps existing authorised requirement information',()=>{
  const js=read('js/driver.js');
  assert.match(js,/job\.wheelchair_required/);
  assert.match(js,/job\.accessibility_requirements/);
});
