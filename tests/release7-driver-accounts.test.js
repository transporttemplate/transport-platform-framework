const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const root=path.join(__dirname,"..");
const migration=fs.readFileSync(path.join(root,"supabase/migrations/202610130002_release7_driver_accounts.sql"),"utf8");
const edge=fs.readFileSync(path.join(root,"supabase/functions/driver-portal/index.ts"),"utf8");
const driver=fs.readFileSync(path.join(root,"js/driver.js"),"utf8");
const html=fs.readFileSync(path.join(root,"driver.html"),"utf8");

test("navigation reuses map, marker and route while coalescing camera updates",()=>{assert.match(driver,/if \(!navigationMap\)/);assert.match(driver,/if \(!navigationRouteLine\)/);assert.match(driver,/navigationRouteLine\.setPath\(path\)/);assert.match(driver,/navigationCameraFrame = requestAnimationFrame/);assert.doesNotMatch(driver,/navigationMap\.panBy/);assert.match(driver,/addListenerOnce\(navigationMap, "idle"/);});
test("Driver Accounts defaults off and protected tables use decimal money",()=>{assert.match(migration,/driver_accounts_enabled boolean not null default false/);assert.match(migration,/amount numeric\(12,2\)/);for(const table of ["driver_expense_rules","driver_expenses","driver_income_adjustments","driver_finance_audit"])assert.match(migration,new RegExp(`alter table public\\.${table} enable row level security`));});
test("driver ownership and enabled permission are enforced server-side",()=>{assert.match(edge,/async function requireAccounts/);assert.match(edge,/if\(!data\?\.driver_expenses_enabled\)throw new ApiError\(403/);assert.match(edge,/eq\("company_id",s\.company_id\)\.eq\("driver_id",s\.driver_id\)/);assert.match(edge,/Admin or Owner access is required/);});
test("customer fare is not substituted for missing driver earnings",()=>{assert.match(edge,/const visibleAmount=driver_amount\?\?null/);assert.doesNotMatch(edge,/visibleAmount=driver_amount==null\?\(price/);});
test("expense recurrence is separate and duplicate-safe",()=>{assert.match(migration,/create table if not exists public\.driver_expense_rules/);assert.match(migration,/unique\(company_id,driver_id,occurrence_key\)/);assert.match(edge,/occurrenceKey=`\$\{rule\.id\}:\$\{date\}`/);});
test("financial reports expose explicit UK-ready ranges and exports",()=>{assert.match(html,/accountsFrom/);assert.match(html,/accountsTo/);assert.match(html,/Print \/ PDF/);assert.match(driver,/exportAccountsCsv/);assert.match(edge,/Payment receipt dates may be unavailable/);});
test("Expenses navigation is hidden until the server-provided permission is enabled",()=>{assert.match(html,/id="driverExpensesNav" class="hidden"/);assert.match(driver,/driver_expenses_enabled !== true/);});
