import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Content-Type":"application/json"};
const reply = (body: unknown, status=200) => new Response(JSON.stringify(body), {status, headers:cors});
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const encoder = new TextEncoder();

Deno.serve(async request => {
  if (request.method === "OPTIONS") return new Response("ok", {headers:cors});
  if (request.method !== "POST") return reply({ok:false,error:"Method not allowed"},405);
  try {
    const body = await request.json();
    const action = String(body.action || "");
    if (action === "login") return await login(request, body);
    if (action === "admin_save_driver") return await adminSaveDriver(request, body);

    const session = await requireDriverSession(String(body.session_token || ""));
    if (action === "refresh") return await refresh(session);
    if (action === "set_online") return await setOnline(session, Boolean(body.online));
    if (action === "gps") return await saveGps(session, body);
    if (action === "job_status") return await setJobStatus(session, body);
    if (action === "create_unavailability") return await createUnavailability(session, body);
    if (action === "end_unavailability") return await endUnavailability(session);
    if (action === "logout") return await logout(session);
    return reply({ok:false,error:"Unknown action"},400);
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 500;
    const message = error instanceof Error ? error.message : "Unexpected error";
    console.error("driver-portal", {status, error:message});
    return reply({ok:false,error:message},status);
  }
});

class ApiError extends Error { constructor(public status:number, message:string){super(message);} }
type DriverSession = {id:string;company_id:string;driver_id:string;token_hash:string};

async function login(request:Request, body:Record<string,unknown>) {
  const companyCode=String(body.company_code||"").trim();
  const driverNumber=String(body.driver_number||"").trim();
  const pin=String(body.pin||"").trim();
  if(!companyCode||!driverNumber||!pin||pin.length>32) throw new ApiError(400,"Company ID, driver number and PIN are required");
  const {data:company,error:companyError}=await db.from("companies").select("id,company_code,name,trading_name").eq("company_code",companyCode).maybeSingle();
  if(companyError) throw companyError;
  if(!company) throw new ApiError(401,"Driver number or PIN is incorrect");
  const subject=await sha256(`${request.headers.get("x-forwarded-for")||"unknown"}|${driverNumber.toLowerCase()}`);
  const {data:allowed,error:limitError}=await db.rpc("consume_security_rate_limit",{target_company_id:company.id,target_action:"driver_login",target_subject_hash:subject,maximum_attempts:5,window_seconds:900});
  if(limitError) throw limitError;
  if(!allowed) throw new ApiError(429,"Too many login attempts. Try again later.");
  const token=toHex(crypto.getRandomValues(new Uint8Array(32)));
  const tokenHash=await sha256(token);
  const expiresAt=new Date(Date.now()+12*60*60*1000).toISOString();
  const {data:matched,error:verifyError}=await db.rpc("verify_driver_pin",{target_company_id:company.id,target_driver_number:driverNumber,supplied_pin:pin,new_token_hash:tokenHash,session_expires_at:expiresAt});
  if(verifyError) throw verifyError;
  if(!matched?.length) throw new ApiError(401,"Driver number or PIN is incorrect");
  await db.rpc("clear_security_rate_limit",{target_company_id:company.id,target_action:"driver_login",target_subject_hash:subject});
  const {data:driver,error:driverError}=await safeDriver(company.id,matched[0].driver_id);
  if(driverError||!driver) throw driverError||new Error("Driver not found");
  return reply({ok:true,session_token:token,expires_at:expiresAt,company,driver});
}

async function adminSaveDriver(request:Request, body:Record<string,unknown>) {
  const authHeader=request.headers.get("authorization")||"";
  const userDb=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_ANON_KEY")!,{global:{headers:{Authorization:authHeader}}});
  const {data:{user}}=await userDb.auth.getUser();
  if(!user) throw new ApiError(401,"Admin login required");
  const companyId=String(body.company_id||"");
  const {data:membership}=await db.from("company_users").select("company_id").eq("user_id",user.id).eq("company_id",companyId).maybeSingle();
  if(!membership) throw new ApiError(403,"You cannot manage drivers for this company");
  const input=(body.driver||{}) as Record<string,unknown>;
  const driverId=String(body.driver_id||"")||null;
  const pin=String(body.pin||"").trim();
  if(!String(input.full_name||"").trim()||!String(input.driver_number||"").trim()) throw new ApiError(400,"Driver name and number are required");
  if(!driverId&&!pin) throw new ApiError(400,"A PIN is required for a new driver");
  if(pin&&(pin.length<4||pin.length>12||!/^[0-9]+$/.test(pin))) throw new ApiError(400,"PIN must be 4 to 12 digits");
  const payload:Record<string,unknown>={company_id:companyId,full_name:String(input.full_name).trim(),driver_number:String(input.driver_number).trim(),phone:clean(input.phone),email:clean(input.email),vehicle:clean(input.vehicle),licence_number:clean(input.licence_number),licence_expiry:clean(input.licence_expiry),status:String(input.status||"available"),online:Boolean(input.online),pay_type:String(input.pay_type||"commission"),commission_percent:numberOrNull(input.commission_percent),fixed_job_amount:numberOrNull(input.fixed_job_amount)};
  if(pin){const {data:hash,error}=await db.rpc("hash_driver_pin",{supplied_pin:pin});if(error)throw error;payload.pin_hash=hash;payload.pin=null;}
  let query=driverId?db.from("drivers").update(payload).eq("company_id",companyId).eq("id",driverId):db.from("drivers").insert(payload);
  const {error}=await query;if(error)throw error;
  return reply({ok:true});
}

async function requireDriverSession(token:string):Promise<DriverSession>{
  if(!token) throw new ApiError(401,"Driver session required");
  const tokenHash=await sha256(token);
  const {data,error}=await db.from("driver_sessions").select("id,company_id,driver_id,token_hash").eq("token_hash",tokenHash).is("revoked_at",null).gt("expires_at",new Date().toISOString()).maybeSingle();
  if(error)throw error;if(!data)throw new ApiError(401,"Driver session expired");
  await db.from("driver_sessions").update({last_seen_at:new Date().toISOString()}).eq("id",data.id);
  return data;
}

async function refresh(s:DriverSession){
  const [driverResult,companyResult,settingsResult,jobsResult,unavailableResult]=await Promise.all([
    safeDriver(s.company_id,s.driver_id),
    db.from("companies").select("id,company_code,name,trading_name").eq("id",s.company_id).maybeSingle(),
    db.from("settings").select("company_id,drivercommission,currencysymbol,driverreject").eq("company_id",s.company_id).maybeSingle(),
    db.from("bookings").select("*").eq("company_id",s.company_id).eq("driver_id",s.driver_id).order("journey_date").order("journey_time"),
    db.from("driver_unavailability").select("*").eq("company_id",s.company_id).eq("driver_id",s.driver_id).order("from_datetime",{ascending:false})
  ]);
  for(const result of [driverResult,companyResult,settingsResult,jobsResult,unavailableResult]) if(result.error)throw result.error;
  const jobs=jobsResult.data||[];const ids=jobs.map(j=>j.id);let stops:Record<string,unknown>[]=[];
  if(ids.length){const r=await db.from("booking_stops").select("*").eq("company_id",s.company_id).in("booking_id",ids).order("stop_order");if(r.error)throw r.error;stops=r.data||[];}
  return reply({ok:true,driver:driverResult.data,company:companyResult.data,settings:settingsResult.data,jobs:jobs.map(j=>({...j,via_stops:stops.filter(x=>x.booking_id===j.id)})),unavailability:unavailableResult.data||[]});
}

async function setOnline(s:DriverSession,online:boolean){const {error}=await db.from("drivers").update({online}).eq("company_id",s.company_id).eq("id",s.driver_id);if(error)throw error;return reply({ok:true,online});}
async function saveGps(s:DriverSession,b:Record<string,unknown>){const lat=Number(b.latitude),lng=Number(b.longitude);if(!Number.isFinite(lat)||!Number.isFinite(lng)||Math.abs(lat)>90||Math.abs(lng)>180)throw new ApiError(400,"Invalid location");const {error}=await db.from("drivers").update({latitude:lat,longitude:lng,location_updated_at:new Date().toISOString()}).eq("company_id",s.company_id).eq("id",s.driver_id).eq("online",true);if(error)throw error;return reply({ok:true});}
async function setJobStatus(s:DriverSession,b:Record<string,unknown>){const id=String(b.booking_id||"");const status=String(b.status||"").toLowerCase();const allowed=["accepted","on_way","passenger_onboard","completed","declined"];if(!id||!allowed.includes(status))throw new ApiError(400,"Invalid job status");const update:Record<string,unknown>=status==="declined"?{status:"waiting",driver_id:null,dispatched_at:null}:{status};if(status==="on_way")update.on_way_at=new Date().toISOString();if(status==="passenger_onboard")update.passenger_onboard_at=new Date().toISOString();if(status==="completed")update.completed_at=new Date().toISOString();const {data,error}=await db.from("bookings").update(update).eq("company_id",s.company_id).eq("driver_id",s.driver_id).eq("id",id).select("id").maybeSingle();if(error)throw error;if(!data)throw new ApiError(404,"Assigned job not found");return reply({ok:true});}
async function createUnavailability(s:DriverSession,b:Record<string,unknown>){const from=new Date(String(b.from_datetime||"")),to=new Date(String(b.to_datetime||""));if(isNaN(from.valueOf())||isNaN(to.valueOf())||to<=from)throw new ApiError(400,"Invalid unavailable period");const {error}=await db.from("driver_unavailability").insert({company_id:s.company_id,driver_id:s.driver_id,from_datetime:from.toISOString(),to_datetime:to.toISOString(),reason:clean(b.reason),active:true});if(error)throw error;await db.from("drivers").update({online:false}).eq("company_id",s.company_id).eq("id",s.driver_id);return reply({ok:true});}
async function endUnavailability(s:DriverSession){const now=new Date().toISOString();const {error}=await db.from("driver_unavailability").update({active:false,to_datetime:now}).eq("company_id",s.company_id).eq("driver_id",s.driver_id).eq("active",true);if(error)throw error;return reply({ok:true});}
async function logout(s:DriverSession){await db.from("drivers").update({online:false}).eq("company_id",s.company_id).eq("id",s.driver_id);await db.from("driver_sessions").update({revoked_at:new Date().toISOString()}).eq("id",s.id);return reply({ok:true});}
function safeDriver(companyId:string,driverId:string){return db.from("drivers").select("id,company_id,driver_number,full_name,phone,email,vehicle,licence_number,licence_expiry,status,online,latitude,longitude,location_updated_at,pay_type,commission_percent,fixed_job_amount").eq("company_id",companyId).eq("id",driverId).maybeSingle();}
const clean=(v:unknown)=>String(v??"").trim()||null;
const numberOrNull=(v:unknown)=>v===""||v==null?null:Number(v);
async function sha256(value:string){return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256",encoder.encode(value))));}
function toHex(bytes:Uint8Array){return [...bytes].map(x=>x.toString(16).padStart(2,"0")).join("");}
