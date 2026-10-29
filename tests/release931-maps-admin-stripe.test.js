const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const read=file=>fs.readFileSync(file,"utf8");
const maps=read("js/address-autocomplete.js"),theme=read("css/admin-premium.css"),compact=read("css/booking-compact.css"),menu=read("js/booking-action-menu.js"),admin=read("js/admin.js"),auth=read("js/auth.js"),edge=read("supabase/functions/admin-stripe-payment-link/index.ts"),webhook=read("supabase/functions/stripe-webhook/index.ts"),migration=read("supabase/migrations/202610290001_release931_admin_payment_links.sql"),integrations=read("settings-integrations.html");

test("Maps uses only the selected company's key and reports restriction failures",()=>{
  assert.match(maps,/return ownKey/);
  assert.doesNotMatch(maps,/company_code=eq\.0001|platformSettings|platformCompany/);
  assert.match(maps,/gm_authFailure/);
  assert.match(maps,/referrer restrictions/);
  assert.match(maps,/importLibrary\("places"\)/);
  assert.match(maps,/15000/);
  assert.match(integrations,/testGoogleMaps/);
  assert.match(integrations,/js\/address-autocomplete\.js/);
});

test("premium Admin canvas is light grayscale with a charcoal sidebar",()=>{
  assert.match(theme,/--premium-bg:#f3f4f6/);
  assert.match(theme,/--sidebar:#202225/);
  assert.match(theme,/\.sidebar\{[^}]*background:#202225!important/);
  assert.match(theme,/\.topbar\{[^}]*background:#fff!important/);
  assert.match(theme,/\.card\{[^}]*background:#fff!important/);
  assert.match(theme,/@media\(max-width:760px\)/);
  assert.ok(admin.indexOf('link[href="css/admin-premium.css"]')<admin.indexOf('document.addEventListener("DOMContentLoaded"'));
  assert.match(theme,/\.bookings-page \.dispatch-panel[^}]*background:#fff!important/);
  assert.match(theme,/\.sms-admin[^}]*background:var\(--premium-bg\)!important/);
  assert.doesNotMatch(theme,/filter:\s*grayscale/);
});

test("Admin company context honours a branded hostname without weakening explicit switching",()=>{
  assert.match(auth,/requestedAdminCompanyCode\(\) \|\| await loginCompanyCode\(\)/);
  assert.match(auth,/\.from\("company_domains"\)/);
  assert.match(auth,/memberships\.find\(item => String\(item\.companies\.company_code\)/);
  assert.match(auth,/Requested admin company is not accessible/);
});

test("address fields and Places predictions have non-overlapping responsive presentation",()=>{
  assert.match(theme,/\.admin-location-group>\*\{min-width:0\}/);
  assert.match(theme,/\.admin-location-group input[^}]*text-overflow:ellipsis/);
  assert.match(theme,/\.pac-item[^}]*white-space:normal!important/);
  assert.match(theme,/\.admin-location-group\{grid-template-columns:minmax\(0,1fr\)!important\}/);
});

test("booking rows are sharper and retain payment and account semantics",()=>{
  assert.match(compact,/height:46px/);
  for(const colour of ["#102a22","#2b171d","#2b2514","#221b35","#132443"])assert.ok(compact.includes(colour));
  assert.match(compact,/var\(--account-colour/);
  assert.match(compact,/@media\(max-width:900px\)/);
  assert.match(compact,/@media\(max-width:520px\)/);
});

test("existing Actions menus offer test-only deposit and full payment links",()=>{
  assert.match(menu,/Send 20% Deposit Link/);
  assert.match(menu,/Send Full Payment Link/);
  assert.match(menu,/admin-stripe-payment-link/);
  assert.match(menu,/payment_kind:paymentKind/);
  assert.match(menu,/Stripe TEST MODE/);
  assert.match(menu,/sms_admin/);
});

test("payment-link endpoint is authenticated tenant-scoped test-only and duplicate-safe",()=>{
  assert.match(edge,/db\.auth\.getUser\(token\)/);
  assert.match(edge,/payments\.record/);
  assert.match(edge,/\.eq\("company_id",companyId\)\.eq\("id",bookingId\)/);
  assert.match(edge,/pk_test_/);
  assert.match(edge,/sk_test_/);
  assert.doesNotMatch(edge,/sk_live_|pk_live_/);
  assert.match(edge,/Idempotency-Key/);
  assert.match(edge,/admin-link-/);
  assert.match(edge,/round2\(balance\*\.20\)/);
  assert.match(edge,/payment_intent_data\[metadata\]/);
  assert.match(edge,/status:"pending"/);
  assert.match(edge,/admin_payment_links/);
  assert.match(migration,/where status='pending'/);
  assert.match(migration,/revoke all on public\.admin_payment_links from public,anon,authenticated/);
  assert.match(edge,/test_mode:true/);
});

test("webhook accumulates partial payments and covers configured company webhooks",()=>{
  assert.match(webhook,/previouslyPaid \+ paid/);
  for(const code of ["0001","0002","0003","0004"])assert.match(webhook,new RegExp(`STRIPE_WEBHOOK_SECRET_${code}`));
  assert.match(webhook,/Payment amount mismatch/);
  assert.match(webhook,/Payment metadata mismatch/);
  assert.match(webhook,/duplicate: true/);
});
