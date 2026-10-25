const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const read = path => fs.readFileSync(path, 'utf8');

test('booking form stores structured passenger and airport requirements', () => {
  const html = read('bookings.html');
  const js = read('js/bookings.js');
  for (const id of ['wheelchairRequired','accessibilityRequirements','specialInstructions','airportInformation']) {
    assert.match(html, new RegExp(`id="${id}"`));
    assert.match(js, new RegExp(id));
  }
  assert.match(js, /wheelchair_required:/);
  assert.match(js, /accessibility_requirements:/);
  assert.match(js, /special_instructions:/);
  assert.match(js, /airport_information:/);
});

test('passenger requirements are audited and tenant scoped', () => {
  const sql = read('supabase/migrations/202610250001_release91_admin_bookings.sql');
  assert.match(sql, /release73_admin\(target_company_id\)/);
  assert.match(sql, /where id=target_booking_id and company_id=target_company_id/);
  assert.match(sql, /insert into admin_booking_audit/);
  assert.match(sql, /revoke all on function public\.admin_update_booking_requirements[^;]+from public,anon,authenticated/s);
  assert.match(sql, /grant execute on function public\.admin_update_booking_requirements[^;]+to authenticated/s);
});

test('admin booking surfaces use company-filtered realtime updates', () => {
  for (const path of ['js/bookings.js','js/all-bookings.js']) {
    const js = read(path);
    assert.match(js, /table:"bookings",filter:`company_id=eq\.\$\{adminCompanyId\}`/);
    assert.match(js, /table:"booking_stops",filter:`company_id=eq\.\$\{adminCompanyId\}`/);
    assert.match(js, /removeChannel\(bookingsRealtimeChannel\)/);
  }
});

test('driver portal shows authorised operational requirements without financial changes', () => {
  const js = read('js/driver.js');
  assert.match(js, /Wheelchair required/);
  assert.match(js, /job\.accessibility_requirements/);
  assert.match(js, /job\.special_instructions/);
  assert.match(js, /job\.airport_information/);
  const migration = read('supabase/migrations/202610250001_release91_admin_bookings.sql');
  assert.doesNotMatch(migration, /commission_percent\s*=|payment_status\s*=|amount_paid\s*=|driver_amount\s*=/i);
});

test('responsive passenger requirements collapse for phone layouts', () => {
  const html = read('bookings.html');
  assert.match(html, /\.passenger-requirements-grid\{display:grid;grid-template-columns:\.75fr 1\.25fr 1\.25fr/);
  assert.match(html, /@media\(max-width:700px\)\{\.passenger-requirements-grid\{grid-template-columns:1fr\}\}/);
});
