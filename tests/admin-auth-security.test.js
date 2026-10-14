const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const auth = read('js/auth.js');
const login = read('js/login.js');
const css = read('css/admin.css');
const calendarSync = read('supabase/functions/google-calendar-sync/index.ts');
const publicBooking = read('supabase/functions/public-booking-create/index.ts');
const publicBookingClient = read('js/booking.js');

test('every discovered Admin HTML route loads the shared authentication guard', () => {
  const files = fs.readdirSync(root).filter(file => file.endsWith('.html'));
  const adminPages = files.filter(file => /js\/admin\.js/.test(read(file)));
  assert.ok(adminPages.length >= 25, 'expected the complete Admin route set');
  for (const file of adminPages) {
    const html = read(file);
    assert.match(html, /js\/supabase\.js/, `${file} must initialise Supabase`);
    assert.match(html, /js\/auth\.js/, `${file} must load the shared Admin guard`);
    assert.ok(html.indexOf('js/auth.js') < html.indexOf('js/admin.js'), `${file} must authenticate before Admin startup`);
  }
});

test('protected content stays hidden until server-validated user, role and membership checks pass', () => {
  assert.match(css, /body:not\(\.login-page\):not\(\.admin-authenticated\)\{visibility:hidden\}/);
  assert.match(auth, /adminDb\.auth\.getUser\(\)/);
  assert.match(auth, /ADMIN_ALLOWED_ROLES = new Set\(\["admin", "owner", "office_manager", "office_staff"\]\)/);
  assert.match(auth, /\.from\("company_users"\)/);
  assert.match(auth, /adminMemberships = \(companyUsers \|\| \[\]\)\.filter\(isAdminMembership\)/);
  const initialGuard = auth.slice(auth.indexOf('window.adminCompanyReadyPromise'));
  assert.ok(initialGuard.indexOf('document.body?.classList.add("admin-authenticated")') > initialGuard.indexOf('const adminMemberships'));
});

test('company identity is preserved and wrong-company logins are rejected', () => {
  assert.match(auth, /\.from\("company_domains"\)/);
  assert.match(auth, /adminAuthUrl\("login\.html", companyCode\)/);
  assert.match(login, /resolveLoginCompanyCode\(db\)/);
  assert.match(login, /Your login is not authorised for this company/);
  assert.match(login, /\["admin","owner","office_manager","office_staff"\]/);
});

test('idle logout, warning, multi-tab logout and bfcache revalidation remain enforced', () => {
  assert.match(auth, /ADMIN_IDLE_LIMIT_MS = 30 \* 60 \* 1000/);
  assert.match(auth, /ADMIN_IDLE_WARNING_MS = 2 \* 60 \* 1000/);
  assert.match(auth, /window\.addEventListener\("storage", onStorage\)/);
  assert.match(auth, /window\.addEventListener\("pagehide"/);
  assert.match(auth, /window\.addEventListener\("pageshow", async event/);
  const pageshow = auth.slice(auth.indexOf('window.addEventListener("pageshow"'), auth.indexOf('window.ADMIN_COMPANY_ID = null'));
  assert.match(pageshow, /adminDb\.auth\.getUser\(\)/);
  assert.match(pageshow, /\.from\("company_users"\)/);
  assert.match(pageshow, /isAdminMembership/);
});

test('Google Calendar sync authorises service calls or same-company Admins before booking lookup', () => {
  assert.match(calendarSync, /authorisedForCompany\(request, companyId\)/);
  assert.match(calendarSync, /constantTimeEqual\(token, serviceKey\)/);
  assert.match(calendarSync, /userDb\.auth\.getUser\(\)/);
  assert.match(calendarSync, /\.eq\("company_id", companyId\)/);
  assert.match(calendarSync, /adminRoles\.has/);
  assert.ok(calendarSync.indexOf('authorisedForCompany(request, companyId)') < calendarSync.indexOf('db.from("bookings")'));
});

test('public booking calendar sync is server-to-server and is no longer browser-authorised', () => {
  assert.match(publicBooking, /notifyGoogleCalendar\(companyId/);
  assert.match(publicBooking, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(publicBooking, /functions\/v1\/google-calendar-sync/);
  assert.doesNotMatch(publicBookingClient, /requestPublicGoogleCalendarSync|functions\.invoke\("google-calendar-sync"/);
});

test('privileged RPCs and trial enforcement remain server-side', () => {
  const editMigration = read('supabase/migrations/202610110001_admin_edit_booking.sql');
  const trialMigration = read('supabase/migrations/202609070003_trial_company_0004.sql');
  assert.match(editMigration, /auth\.uid\(\) is null or not public\.user_can_access_company\(target_company_id\)/);
  assert.match(editMigration, /revoke all on function public\.admin_edit_booking[\s\S]*from public,anon/);
  assert.match(trialMigration, /enforce_trial_settings_restrictions/);
});

test('browser code contains no service-role credential', () => {
  for (const file of fs.readdirSync(path.join(root, 'js')).filter(file => file.endsWith('.js'))) {
    assert.doesNotMatch(read(`js/${file}`), /SUPABASE_SERVICE_ROLE_KEY|service_role/i, `${file} exposes privileged credentials`);
  }
});
