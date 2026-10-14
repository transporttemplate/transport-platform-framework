const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs");
const read=file=>fs.readFileSync(file,"utf8");
const sql=read("supabase/migrations/202610140003_release74_sms_cancellation_deletion.sql");
const menu=read("js/booking-action-menu.js"),calendar=read("supabase/functions/google-calendar-sync/index.ts");

test("professional SMS defaults preserve identifiers and customised company bodies",()=>{
  assert.match(sql,/where t\.template_key=v\.template_key and t\.body=v\.previous_body/);
  for(const key of ["customer_confirmation","customer_pickup_reminder","driver_on_route","driver_arrived","booking_cancelled","driver_assignment"])assert.match(sql,new RegExp(`'${key}'`));
  assert.doesNotMatch(sql,/sms_provision_company\([^\n]+true/);
});
test("On Way vehicle and contact privacy are resolved server-side and tenant scoped",()=>{
  for(const value of [/b\.vehicle_id/,/public\.vehicles where company_id=c/,/driver_phone_sharing_allowed/,/customer_phone_sharing/,/public_contact_phone/,/driver_contact_line/,/vehicle_details/])assert.match(sql,value);
  assert.doesNotMatch(sql,/jsonb_build_object\([^;]+driver_phone',d->>'phone'/s);
  assert.match(sql,/regexp_replace\(body1,E'\\n\{3,\}'/);
});
test("cancellation is locked atomic scoped and preserves financial data",()=>{
  for(const value of [/cancel_booking_jobs/,/for update/,/cancel_scope not in\('single','both'\)/,/admin_booking_audit/,/payment_status/,/amount_paid/,/idempotent/])assert.match(sql,value);
  assert.doesNotMatch(sql,/delete from public\.(payments|invoice|receipts)/i);
  assert.match(menu,/Cancel both/);assert.match(menu,/financial history will be preserved/i);assert.match(menu,/button\.disabled=true/);
});
test("deletion permission is owner-managed off-by-default and never mass granted",()=>{
  assert.match(sql,/lower\(role\)='owner'/);assert.match(sql,/set_booking_deletion_permission/);
  assert.doesNotMatch(sql,/update public\.company_users set can_permanently_delete_bookings=true/i);
  assert.match(read("settings-system.html"),/deletion-permissions\.js/);
});
test("permanent deletion retains real password reauthentication and recoverable calendar cleanup",()=>{
  assert.match(menu,/signInWithPassword/);assert.match(menu,/permanent_deletion_cleanup:true/);assert.match(menu,/exact-reference|Type \$\{escapeMenu/i);
  assert.match(calendar,/authorisedForPermanentDeletion/);assert.match(calendar,/can_permanently_delete_bookings/);assert.match(calendar,/cancelled \|\| permanentDeletionCleanup/);
});
test("Release 7.4 migration does not enable sending delete bookings or grant permissions",()=>{
  assert.doesNotMatch(sql,/sending_enabled\s*=\s*true/i);assert.doesNotMatch(sql,/delete from public\.bookings/i);assert.doesNotMatch(sql,/company_code='0005'|company_code in\([^)]*0005/i);
});
