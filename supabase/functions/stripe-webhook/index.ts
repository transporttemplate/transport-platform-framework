import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const db=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{"Content-Type":"application/json"}});

Deno.serve(async request=>{
  if(request.method!=="POST") return json({ok:false},405);
  const secret=Deno.env.get("STRIPE_WEBHOOK_SECRET")||"";
  const signature=request.headers.get("stripe-signature")||"";
  const body=await request.text();
  if(!secret || !await validStripeSignature(body,signature,secret)) return json({ok:false,error:"Invalid signature"},400);
  const event=JSON.parse(body);
  const intent=event?.data?.object;
  if(!intent?.id || !String(event.type||"").startsWith("payment_intent.")) return json({ok:true,ignored:true});

  const {data:payment,error}=await db.from("payments").select("id,company_id,booking_id,amount,status").eq("reference",intent.id).eq("method","stripe").maybeSingle();
  if(error) return json({ok:false},500);
  if(!payment) return json({ok:true,ignored:true});

  if(event.type==="payment_intent.succeeded"){
    if(payment.status==="paid") return json({ok:true,duplicate:true});
    const {data:booking}=await db.from("bookings").select("id,company_id,booking_reference,price,balance_due,payment_type").eq("id",payment.booking_id).eq("company_id",payment.company_id).maybeSingle();
    if(!booking) return json({ok:false,error:"Booking not found"},404);
    const paid=Number(payment.amount||0);
    const balance=Math.max(0,Number(booking.balance_due||0)-paid);
    const paymentStatus=balance>0?"deposit_paid":"paid";
    const paidAt=new Date().toISOString();
    const paymentUpdate=await db.from("payments").update({status:"paid",paid_at:paidAt}).eq("id",payment.id).eq("company_id",payment.company_id).neq("status","paid");
    if(paymentUpdate.error) return json({ok:false},500);
    const bookingUpdate=await db.from("bookings").update({payment_status:paymentStatus,amount_paid:paid,balance_due:balance,paid_at:paidAt}).eq("id",booking.id).eq("company_id",payment.company_id);
    if(bookingUpdate.error) return json({ok:false},500);
    const linked=await db.from("bookings").update({payment_status:paymentStatus,paid_at:paidAt}).eq("company_id",payment.company_id).eq("booking_reference",`${booking.booking_reference}-R`).eq("payment_type","linked_return").select("id");
    await notifyPaidBooking(payment.company_id,[booking.id,...(linked.data||[]).map((row:any)=>row.id)],booking.id,intent.id);
  }else if(["payment_intent.payment_failed","payment_intent.canceled"].includes(event.type)){
    await db.from("payments").update({status:"failed"}).eq("id",payment.id).eq("company_id",payment.company_id).neq("status","paid");
    await db.from("bookings").update({payment_status:event.type.endsWith("canceled")?"payment_cancelled":"payment_failed"}).eq("id",payment.booking_id).eq("company_id",payment.company_id).neq("payment_status","paid");
  }
  return json({ok:true});
});

async function notifyPaidBooking(companyId:string,bookingIds:string[],emailBookingId:string,paymentIntentId:string){
  const base=Deno.env.get("SUPABASE_URL")||""; const serviceKey=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"";
  const headers={"Content-Type":"application/json",apikey:serviceKey,Authorization:`Bearer ${serviceKey}`};
  const requests=bookingIds.map(bookingId=>fetch(`${base}/functions/v1/google-calendar-sync`,{method:"POST",headers,body:JSON.stringify({company_id:companyId,booking_id:bookingId})}));
  requests.push(fetch(`${base}/functions/v1/send-booking-email`,{method:"POST",headers,body:JSON.stringify({company_id:companyId,booking_id:emailBookingId,event:"payment_received",event_id:`stripe:${paymentIntentId}`})}));
  const results=await Promise.allSettled(requests);
  for(const result of results){
    if(result.status==="rejected") console.error("Post-payment notification failed",result.reason);
    else if(!result.value.ok) console.error("Post-payment notification returned",result.value.status);
  }
}

async function validStripeSignature(payload:string,header:string,secret:string){
  const parts=Object.fromEntries(header.split(",").map(item=>item.split("=",2)));
  const timestamp=parts.t; const expected=parts.v1;
  if(!timestamp||!expected||Math.abs(Date.now()/1000-Number(timestamp))>300) return false;
  const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  const digest=await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(`${timestamp}.${payload}`));
  const actual=[...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,"0")).join("");
  if(actual.length!==expected.length) return false;
  let different=0; for(let index=0;index<actual.length;index++) different|=actual.charCodeAt(index)^expected.charCodeAt(index);
  return different===0;
}
