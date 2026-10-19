import {createClient} from "https://esm.sh/@supabase/supabase-js@2";
const db=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const headers={"content-type":"application/json","access-control-allow-origin":"*","access-control-allow-headers":"content-type","access-control-allow-methods":"GET,POST,OPTIONS"};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers});

Deno.serve(async request=>{
  if(request.method==="OPTIONS")return new Response("ok",{headers});
  try{
    const url=new URL(request.url),input=request.method==="POST"?await request.json():{},token=String(input.token||url.searchParams.get("token")||"");
    if(!/^[a-f0-9]{64}$/i.test(token))return json({ok:false,error:"This decision link is invalid."},400);
    const hash=await sha256(token),found=await db.from("external_offer_decision_tokens").select("id,company_id,offer_id,expires_at,used_at,decision").eq("token_hash",hash).maybeSingle();
    if(found.error||!found.data)return json({ok:false,error:"This decision link is invalid."},404);
    const offer=await db.from("external_dispatch_offers").select("id,external_booking_reference,status,booking_payload,supplier_payment,customer_fare,expires_at,receiving_booking_reference").eq("id",found.data.offer_id).eq("receiving_company_id",found.data.company_id).maybeSingle();
    if(!offer.data)return json({ok:false,error:"This booking offer is no longer available."},404);
    const safe={reference:offer.data.external_booking_reference,status:offer.data.status,journey_date:offer.data.booking_payload?.journey_date,journey_time:offer.data.booking_payload?.journey_time,pickup_address:offer.data.booking_payload?.pickup_address,dropoff_address:offer.data.booking_payload?.dropoff_address,passengers:offer.data.booking_payload?.passengers,supplier_payment:offer.data.supplier_payment,customer_fare:offer.data.customer_fare,expires_at:offer.data.expires_at,booking_reference:offer.data.receiving_booking_reference};
    if(request.method==="GET")return json({ok:true,offer:safe,expired:Date.parse(found.data.expires_at)<=Date.now(),used:!!found.data.used_at,decision:found.data.decision});
    const decision=String(input.decision||"");
    if(!["accepted","declined"].includes(decision))return json({ok:false,error:"Choose accept or decline."},400);
    if(found.data.used_at)return json({ok:true,duplicate:true,decision:found.data.decision,offer:safe});
    if(Date.parse(found.data.expires_at)<=Date.now()||!["offered","viewed"].includes(offer.data.status))return json({ok:false,error:"This booking offer has expired or was already decided."},409);
    if(decision==="accepted"){
      const accepted=await db.rpc("accept_external_dispatch_offer",{target_offer:found.data.offer_id,target_company:found.data.company_id,target_actor:null});
      if(accepted.error)throw accepted.error;
    }else{
      const declined=await db.from("external_dispatch_offers").update({status:"declined",declined_at:new Date().toISOString(),updated_at:new Date().toISOString()}).eq("id",found.data.offer_id).eq("receiving_company_id",found.data.company_id).in("status",["offered","viewed"]).select("id").maybeSingle();
      if(declined.error||!declined.data)return json({ok:false,error:"This booking offer was already decided."},409);
    }
    await db.from("external_offer_decision_tokens").update({used_at:new Date().toISOString(),decision}).eq("id",found.data.id).is("used_at",null);
    return json({ok:true,decision});
  }catch(error){console.error("external-offer-decision",error instanceof Error?error.message:error);return json({ok:false,error:"The booking decision could not be completed."},500);}
});
async function sha256(value:string){return [...new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value)))].map(x=>x.toString(16).padStart(2,"0")).join("")}
