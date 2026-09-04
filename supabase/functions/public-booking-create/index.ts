import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Content-Type":"application/json"};
const respond=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:cors});
const db=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

Deno.serve(async request=>{
  if(request.method==="OPTIONS")return new Response("ok",{headers:cors});
  if(request.method!=="POST")return respond({ok:false,error:"Method not allowed"},405);
  try{
    const body=await request.json();const companyId=String(body.company_id||"");const booking=body.booking as Record<string,unknown>;const stops=Array.isArray(body.stops)?body.stops:[];
    if(!companyId||!booking) return respond({ok:false,error:"company_id and booking are required"},400);
    const {data:company}=await db.from("companies").select("id").eq("id",companyId).maybeSingle();if(!company)return respond({ok:false,error:"Company not found"},404);
    const ip=request.headers.get("x-forwarded-for")||"unknown";const subject=await hash(`${ip}|${companyId}`);
    const {data:allowed,error:limitError}=await db.rpc("consume_security_rate_limit",{target_company_id:companyId,target_action:"public_booking",target_subject_hash:subject,maximum_attempts:10,window_seconds:900});if(limitError)throw limitError;if(!allowed)return respond({ok:false,error:"Too many booking attempts. Try again later."},429);
    const name=clean(booking.customer_name),email=clean(booking.email),phone=clean(booking.phone);if(!name||(!email&&!phone))return respond({ok:false,error:"Customer name and phone or email are required"},400);
    const customerResult=await db.rpc("find_or_create_public_customer",{target_company_id:companyId,customer_name:name,customer_email:email,customer_phone:phone});if(customerResult.error)throw customerResult.error;const customerId=customerResult.data;
    const refResult=await db.rpc("next_company_booking_reference",{target_company_id:companyId});if(refResult.error)throw refResult.error;const reference=refResult.data;
    const id=crypto.randomUUID();const record=bookingPayload(booking,{id,company_id:companyId,customer_id:customerId,booking_reference:reference,status:"Waiting"});
    const rows=[record];
    if(Boolean(booking.return_journey)&&clean(booking.return_date)&&clean(booking.return_time))rows.push({...record,id:crypto.randomUUID(),booking_reference:`${reference}-R`,pickup_address:record.dropoff_address,dropoff_address:record.pickup_address,pickup_name:record.dropoff_name,pickup_postcode:record.dropoff_postcode,pickup_place_id:record.dropoff_place_id,pickup_lat:record.dropoff_lat,pickup_lng:record.dropoff_lng,dropoff_name:record.pickup_name,dropoff_postcode:record.pickup_postcode,dropoff_place_id:record.pickup_place_id,dropoff_lat:record.pickup_lat,dropoff_lng:record.pickup_lng,journey_date:booking.return_date,journey_time:booking.return_time,return_journey:false,return_date:null,return_time:null,price:0,journey_type:"return"});
    const inserted=await db.from("bookings").insert(rows).select("id,booking_reference");if(inserted.error)throw inserted.error;
    const stopRows=rows.flatMap((r,index)=>{const ordered=index===0?stops:[...stops].reverse();return ordered.map((s:any,i:number)=>({company_id:companyId,booking_id:r.id,stop_order:i+1,label:clean(s.label)||"Via",address_name:clean(s.address_name),formatted_address:clean(s.formatted_address),postcode:clean(s.postcode),latitude:numberOrNull(s.latitude),longitude:numberOrNull(s.longitude),place_id:clean(s.place_id)}));}).filter((s:any)=>s.formatted_address);
    if(stopRows.length){const stopResult=await db.from("booking_stops").insert(stopRows);if(stopResult.error)throw stopResult.error;}
    return respond({ok:true,customer_id:customerId,reference,bookings:inserted.data});
  }catch(error){const message=error instanceof Error?error.message:"Unexpected error";console.error("public-booking-create",{error:message});return respond({ok:false,error:message},500);}
});

function bookingPayload(b:Record<string,unknown>,fixed:Record<string,unknown>){const allowed=["customer_name","pickup_address","pickup_name","pickup_postcode","pickup_place_id","pickup_lat","pickup_lng","dropoff_address","dropoff_name","dropoff_postcode","dropoff_place_id","dropoff_lat","dropoff_lng","airport","flight_number","journey_type","journey_date","journey_time","return_journey","return_date","return_time","phone","email","passengers","suitcases","hand_luggage","vehicle_type","notes","payment_method","price","route_distance_miles","route_duration_minutes","pricing_method"];const out:Record<string,unknown>={...fixed};for(const key of allowed)out[key]=b[key]??null;return out;}
const clean=(v:unknown)=>String(v??"").trim()||null;
const numberOrNull=(v:unknown)=>v===""||v==null?null:Number(v);
async function hash(value:string){const bytes=new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value)));return [...bytes].map(x=>x.toString(16).padStart(2,"0")).join("");}
