const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const read=path=>fs.readFileSync(path,'utf8');
const portal=read('supabase/functions/driver-portal/index.ts');
const ui=read('js/driver.js');
const html=read('driver.html');
const migration=read('supabase/migrations/202610190006_driver_portal_reliability.sql');

test('vehicle relationship reads are available only to the trusted portal service',()=>{
  assert.match(migration,/grant select on table public\.driver_vehicle_links to service_role/);
  assert.match(migration,/grant select on table public\.driver_vehicle_assignments to service_role/);
  assert.doesNotMatch(migration,/\b(?:anon|authenticated)\b/);
  for(const table of ['driver_vehicle_links','driver_vehicle_assignments'])assert.match(portal,new RegExp(`\\.from\\("${table}"\\).*\\.eq\\("company_id",s\\.company_id\\).*\\.eq\\("driver_id",s\\.driver_id\\)`));
});

test('missing privacy configuration is explicit and cannot crash acknowledgement',()=>{
  assert.match(ui,/currentPrivacyNotice=data\.privacy\?\?null/);
  assert.match(ui,/if\(!currentPrivacyNotice\?\.version\)/);
  assert.match(ui,/Privacy notice not available/);
});

test('failed first load never claims that cached diary data is current',()=>{
  assert.match(ui,/do not rely on cached job details/);
  assert.match(ui,/lastSuccessfulRefresh \?/);
  assert.match(portal,/Driver Portal service could not load/);
});

test('completed diary has mobile filtering and vehicle empty state is truthful',()=>{
  for(const id of ['completedSearch','completedFrom','completedTo'])assert.match(html,new RegExp(id));
  assert.match(ui,/No vehicle linked/);
  assert.match(ui,/authorised office administrator/);
  assert.match(ui,/setInterval\(refreshDriverPortal, 15000\)/);
});
