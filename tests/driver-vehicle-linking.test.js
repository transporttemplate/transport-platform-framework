const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const read=file=>fs.readFileSync(file,"utf8");
const migration=read("supabase/migrations/202610190001_driver_vehicle_linking.sql");
const admin=read("js/drivers.js");
const adminHtml=read("drivers.html");
const portal=read("supabase/functions/driver-portal/index.ts");
const portalJs=read("js/driver.js");
const api=read("supabase/functions/api-v1/index.ts");

test("ownership, defaults and eligibility use one tenant-scoped relationship table",()=>{
  assert.match(migration,/create table if not exists public\.driver_vehicle_links/);
  for(const type of ["owner","default","eligible"])assert.match(migration,new RegExp(`'${type}'`));
  assert.match(migration,/foreign key\(driver_id,company_id\)/);
  assert.match(migration,/foreign key\(vehicle_id,company_id\)/);
  assert.match(migration,/one_default_vehicle_per_driver/);
  assert.match(migration,/one_owner_per_vehicle/);
  assert.doesNotMatch(migration,/Jeff|Bailey|HV71YXF|0003/i);
});

test("current and temporary assignments retain history and reject overlaps",()=>{
  assert.match(migration,/assignment_type in \('current','temporary','shift'\)/);
  assert.match(migration,/driver_vehicle_assignments_driver_no_overlap/);
  assert.match(migration,/driver_vehicle_assignments_vehicle_no_overlap/);
  assert.match(migration,/tstzrange\(effective_from,coalesce\(effective_to,'infinity'/);
  assert.match(migration,/effective_to=now_at/);
});

test("private vehicles require explicit authorisation and unavailable vehicles are blocked",()=>{
  assert.match(migration,/Another driver owns this vehicle and explicit authorisation is required/);
  assert.match(migration,/Driver is not authorised to use this privately owned vehicle/);
  assert.match(migration,/operational_status='available'/);
  assert.match(migration,/Vehicle already has an overlapping booking/);
});

test("booking allocation records the current or default actual vehicle without rewriting history",()=>{
  assert.match(migration,/create or replace function public\.booking_vehicle_guard/);
  assert.match(migration,/driver_vehicle_assignments/);
  assert.match(migration,/link_type='default'/);
  assert.match(migration,/new\.vehicle_id:=candidate/);
  assert.doesNotMatch(migration,/update bookings set vehicle_id/i);
});

test("admin supports linking from driver and vehicle screens",()=>{
  for(const id of ["driverOwnedVehiclesInput","driverDefaultVehicleInput","driverCurrentVehicleInput","driverEligibleVehiclesInput","vehicleOwnershipType","vehicleOwnerDriver","vehicleCurrentDriver","vehicleOperationalStatus","vehicleNotes"])assert.match(adminHtml,new RegExp(id));
  assert.match(admin,/set_driver_vehicle_relationships/);
  assert.match(admin,/save_vehicle_relationships/);
  assert.match(admin,/loadDriverVehicleRelationships/);
});

test("driver portal displays and audits authorised shift vehicle selection",()=>{
  assert.match(portal,/action === "select_vehicle"/);
  assert.match(portal,/select_driver_shift_vehicle/);
  assert.match(migration,/select_driver_shift_vehicle/);
  assert.match(migration,/Finish the current journey before changing vehicle/);
  assert.match(portalJs,/renderDriverVehicle/);
  assert.match(portalJs,/selectShiftVehicle/);
});

test("external dispatch projects actual booking vehicle and preserves phone consent",()=>{
  assert.match(api,/b\.data\.vehicle_id\?db\.from\("vehicles"\)/);
  assert.match(api,/make,model,colour,registration,passenger_seats/);
  assert.match(api,/provider_phone_sharing\?d\.data\.public_contact_phone:null/);
});

test("migration is additive and does not touch financial or historical journey values",()=>{
  assert.doesNotMatch(migration,/delete from public\.(drivers|vehicles|bookings|payments|invoices)/i);
  assert.doesNotMatch(migration,/update public\.(payments|invoices|receipts)/i);
  assert.doesNotMatch(migration,/completed_at|amount_paid|commission|invoice/i);
});
