const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const read=p=>fs.readFileSync(p,'utf8'),sql=read('supabase/migrations/202610180001_status_aware_booking_corrections.sql'),ui=read('js/bookings.js'),html=read('bookings.html'),menu=read('js/booking-action-menu.js');

test('blanket active and closed booking locks are removed from the UI and replacement RPC',()=>{
 assert.doesNotMatch(ui,/This booking is active or closed/);
 assert.doesNotMatch(sql,/Active or completed bookings are locked/);
 assert.match(ui,/beginBookingEdit/);
 assert.match(sql,/state in\('completed','cancelled','canceled','no_show','archived'\)/);
});

test('only tenant Owners and Administrators can correct bookings',()=>{
 assert.match(sql,/release73_admin\(target_company_id\)/);
 assert.match(sql,/where id=target_booking_id and company_id=target_company_id for update/);
 assert.match(sql,/Only a company Owner or Administrator/);
 assert.match(sql,/security definer set search_path=public/);
 assert.match(sql,/revoke all on function public\.admin_edit_booking[\s\S]*from public,anon/);
});

test('active corrections preserve progress and notify the assigned driver only',()=>{
 const editFunction=sql.split('create or replace function public.capture_outbound_booking_webhook')[0];
 assert.doesNotMatch(editFunction,/accepted_at\s*=|on_way_at\s*=|arrived_at\s*=|passenger_onboard_at\s*=|completed_at\s*=/i);
 assert.match(sql,/notification_required/);
 assert.match(ui,/event,audience:"driver"/);
 assert.match(ui,/event_id:data\.audit_id/);
 assert.match(ui,/previous_driver_id:previousDriver/);
 assert.match(sql,/assigned driver cannot be replaced after passenger pickup/);
});

test('completed history, GPS, identity and external links are preserved',()=>{
 assert.match(sql,/Completed or closed journey history cannot change route, schedule, stops or driver/);
 for(const field of ['booking_reference','driver_gps_points','external_provider_reference','original_booking_reference','creation_idempotency_key'])assert.doesNotMatch(sql,new RegExp(`update bookings set[\\s\\S]*${field}\\s*=`,`i`));
 assert.doesNotMatch(sql,/delete from (?:public\.)?bookings/i);
});

test('fare changes reuse immutable adjustments and never rewrite protected finance',()=>{
 assert.match(sql,/adjust_booking_fare\(target_company_id,target_booking_id/);
 assert.match(sql,/document_resolution_required/);
 assert.match(sql,/Driver earnings cannot be changed/);
 assert.match(sql,/Payment method, account association and PO changes require the separate financial correction workflow/);
 for(const table of ['payments','invoices','receipts'])assert.doesNotMatch(sql,new RegExp(`(?:update|delete from|insert into) (?:public\\.)?${table}`,'i'));
});

test('sensitive corrections require immutable before and after audit data',()=>{
 assert.match(html,/bookingCorrectionReason/);
 assert.match(sql,/meaningful correction reason is required/);
 assert.match(sql,/previous_values,new_values,price_override_reason,change_reason/);
 assert.match(sql,/auth\.uid\(\)/);
 assert.match(menu,/change_reason/);
});

test('normal corrections suppress external provider updates and customer confirmations',()=>{
 assert.match(sql,/app\.admin_booking_correction/);
 assert.match(sql,/capture_outbound_booking_webhook/);
 assert.match(sql,/capture_external_dispatch_journey/);
 assert.doesNotMatch(ui,/event:"new_booking"[\s\S]{0,200}saveAdminBookingEdit/);
 assert.match(ui,/audience:"driver"/);
});
