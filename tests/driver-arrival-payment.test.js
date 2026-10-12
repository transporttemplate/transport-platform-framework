const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = file => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const migration = read("supabase/migrations/202610120002_driver_arrival_payment_confirmation.sql");
const edge = read("supabase/functions/driver-portal/index.ts");
const driver = read("js/driver.js");
const html = read("driver.html");
const css = read("css/driver.css");

test("Arrived is a protected tenant-scoped and idempotent server transition", () => {
  assert.match(migration, /add column if not exists arrived_at timestamptz/i);
  assert.match(migration, /previous_status='on_way' and next_status='arrived'/i);
  assert.match(migration, /previous_status='arrived' and next_status='passenger_onboard'/i);
  assert.match(migration, /if previous_status=next_status then duplicate_request:=true/i);
  assert.match(migration, /where id=target_booking_id and company_id=target_company_id and driver_id=target_driver_id\s+for update/i);
  assert.match(migration, /case when next_status='arrived' then 'driver_arrived'/i);
  assert.match(migration, /bookings_one_active_job_per_driver[\s\S]*'on_way','arrived','passenger_onboard'/i);
  assert.match(migration, /protect_arrived_booking_details_trigger/i);
});

test("generic status API cannot bypass mandatory completion payment handling", () => {
  assert.match(edge, /action === "completion_payment_status"/);
  assert.match(edge, /action === "complete_job"/);
  assert.match(edge, /\["accepted","on_way","arrived","passenger_onboard","declined"\]\.includes\(status\)/);
  assert.doesNotMatch(edge, /\["accepted","on_way","arrived","passenger_onboard","completed","declined"\]/);
  assert.match(edge, /rpc\("complete_driver_booking_with_payment_confirmation"/);
  assert.match(edge, /target_company_id:s\.company_id,target_driver_id:s\.driver_id,target_booking_id:id/);
});

test("payment decision is based on authoritative booking data and blocks ambiguity", () => {
  assert.match(edge, /\.eq\("id",id\)\.eq\("company_id",s\.company_id\)\.eq\("driver_id",s\.driver_id\)/);
  assert.match(edge, /status!=="passenger_onboard"/);
  assert.match(edge, /paymentState==="paid"\|\|outstanding<=0/);
  assert.match(edge, /else if\(accountBooking\)\{mode="complete_without_payment"/);
  assert.match(edge, /else if\(cashEligible\)\{mode="confirm_cash"/);
  assert.match(edge, /mode="blocked"/);
  assert.match(edge, /paymentType==="deposit"&&paymentState==="deposit_paid"/);
});

test("YES records only the authoritative outstanding amount and completion is atomic", () => {
  assert.match(migration, /paid_amount:=greatest\(0,fare_total-paid_before\)/i);
  assert.match(migration, /amount_paid=paid_before\+paid_amount,balance_due=0/i);
  assert.match(migration, /'driver-cash:'\|\|target_booking_id/i);
  assert.match(migration, /if not public\.mark_driver_cash_booking_paid\(target_company_id,target_driver_id,target_booking_id\)/i);
  assert.match(migration, /update public\.bookings set status='completed',completed_at=now\(\)/i);
  assert.match(migration, /driver_cash_collected/i);
  assert.match(migration, /security definer set search_path=public/i);
  assert.match(migration, /revoke all on function public\.complete_driver_booking_with_payment_confirmation[\s\S]*grant execute[\s\S]*to service_role/i);
});

test("NO preserves payment state, records an audit event and still completes", () => {
  const noBranch = migration.match(/if choice='paid' then([\s\S]*?)end if;\s*else\s*raise exception 'Payment state is unsupported/i)?.[1] || "";
  assert.match(noBranch, /driver_payment_not_received/i);
  assert.doesNotMatch(noBranch, /payment_status='paid'/i);
  assert.match(noBranch, /Driver confirmed customer had not paid at drop-off/i);
  assert.match(migration, /update public\.bookings set status='completed'/i);
});

test("the payment prompt is mandatory, prominent and cancel performs no write", () => {
  for (const text of ["Has the customer paid?", "YES — CUSTOMER PAID", "NO — CUSTOMER HAS NOT PAID", "CANCEL"]) {
    assert.match(html, new RegExp(text));
  }
  for (const field of ["paymentConfirmReference", "paymentConfirmFare", "paymentConfirmPaidAmount", "paymentConfirmOutstanding", "paymentConfirmMethod"]) {
    assert.match(html, new RegExp(`id="${field}"`));
  }
  assert.match(driver, /paymentConfirmation = await askPaymentConfirmation\(summary\)/);
  assert.match(driver, /if \(paymentConfirmation === "cancel"\) return;[\s\S]*driverPortalRequest\("complete_job"/);
  assert.match(driver, /pendingJobActions\.has\(actionKey\)/);
  assert.match(css, /payment-confirmation-summary \.outstanding[^{]*\{[^}]*background:#422006/);
  assert.match(css, /@media\(max-width:390px\)/);
  assert.match(css, /payment-confirmation-actions \.btn\{min-height:50px/);
});

test("existing Customer Paid remains a single protected action using the same server payment RPC", () => {
  assert.equal((html.match(/id="markPaidButton"/g) || []).length, 1);
  assert.match(driver, /driverPortalRequest\("mark_cash_paid"/);
  assert.match(edge, /action === "mark_cash_paid"/);
  assert.match(edge, /rpc\("mark_driver_cash_booking_paid"/);
  assert.equal((migration.match(/create or replace function public\.mark_driver_cash_booking_paid/g) || []).length, 1);
});

test("payment and arrival additions do not add SMS, client-supplied amounts or broad booking writes", () => {
  assert.doesNotMatch(`${edge}\n${driver}\n${migration}`, /send[-_ ]?sms|twilio/i);
  assert.doesNotMatch(edge, /b\.(amount|fare|company_id|driver_id)/);
  assert.doesNotMatch(migration, /delete\s+from\s+public\.(bookings|payments|driver_job_events)/i);
  assert.doesNotMatch(migration, /truncate\s+/i);
  assert.doesNotMatch(migration, /drop\s+table/i);
});
