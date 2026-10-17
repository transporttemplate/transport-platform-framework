const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const read=p=>fs.readFileSync(p,'utf8'),sql=read('supabase/migrations/202610170006_release808_return_provider_fix.sql'),edge=read('supabase/functions/job-exchange/index.ts'),ui=read('js/job-exchange.js'),css=read('css/job-exchange.css'),page=read('job-exchange.html');

test('external returns are transaction-scoped, service-only and tied to the receiving offer',()=>{
 assert.match(sql,/auth\.role\(\)='service_role'/);
 assert.match(sql,/app\.external_dispatch_return_offer/);
 assert.match(sql,/receiving_booking_id=new\.id/);
 assert.match(sql,/receiving_company_id=new\.company_id/);
 assert.match(sql,/o\.status in \('accepted','active'\)/);
 assert.match(sql,/new\.passenger_onboard_at is null/);
 assert.match(sql,/new\.driver_id is null/);
 assert.match(sql,/new\.vehicle_id is null/);
});

test('return preserves history while voiding only the unpaid supplier obligation',()=>{
 assert.match(sql,/greatest\(coalesce\(o\.supplier_payment,0\)-coalesce\(o\.supplier_amount_paid,0\),0\)/);
 assert.match(sql,/external_dispatch_financial_events/);
 assert.match(sql,/supplier_obligation_voided/);
 assert.match(sql,/status='returned_to_provider'/);
 assert.match(sql,/reallocation_required=true/);
 assert.match(sql,/event_type,amount,reason,actor_id/);
 assert.match(sql,/'booking\.returned'/);
 assert.match(sql,/webhook_key/);
 assert.doesNotMatch(sql,/declare[^;]*event_key text/);
 assert.doesNotMatch(sql,/delete\s+from/i);
});

test('invalid, duplicate and post-pickup returns provide safe specific explanations',()=>{
 for(const phrase of ['already been returned','Only an accepted external offer','after passenger pickup','External offer not found'])assert.match(sql,new RegExp(phrase));
 assert.match(edge,/already been returned/);
 assert.match(edge,/after passenger pickup/);
});

test('booking details are read-only and available throughout exchange views',()=>{
 assert.match(page,/bookingDetailsDialog/);
 assert.match(page,/job-exchange\.js\?v=8\.0\.8/);
 assert.match(ui,/data-view-external/);
 assert.match(ui,/data-view-offer/);
 assert.match(ui,/Opening this panel is read-only/);
 assert.doesNotMatch(ui,/data-external-action="view"/);
 assert.doesNotMatch(ui,/data-offer-action="view"/);
 for(const label of ['Passengers','Luggage','Notes','Payment arrangement','Originating provider','Supplier amount','Current status'])assert.match(ui,new RegExp(label));
});

test('route cards provide high contrast wrapping and responsive directional layout',()=>{
 for(const token of ['exchange-stop','exchange-address','exchange-direction','exchange-source','exchange-finance'])assert.match(css,new RegExp(token));
 assert.match(css,/overflow-wrap:anywhere/);
 assert.match(css,/color:#fff/);
 assert.match(css,/@media\(max-width:600px\)/);
 assert.match(css,/grid-template-columns:1fr/);
 assert.match(ui,/Pickup/);
 assert.match(ui,/Destination/);
});
