import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Content-Type":"application/json"};
const reply = (body: unknown, status=200) => new Response(JSON.stringify(body), {status, headers:cors});
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const encoder = new TextEncoder();
const routeCache = new Map<string,{expires:number,value:unknown}>();

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
    if (action === "navigation_route") return await navigationRoute(session, body);
    if (action === "job_status") return await setJobStatus(session, body);
    if (action === "mark_cash_paid") return await markCashPaid(session, body);
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
  const historyCutoff=new Date(Date.now()-180*24*60*60*1000).toISOString().slice(0,10);
  const [driverResult,companyResult,settingsResult,jobsResult,unavailableResult]=await Promise.all([
    safeDriver(s.company_id,s.driver_id),
    db.from("companies").select("id,company_code,name,trading_name,company_status").eq("id",s.company_id).maybeSingle(),
    db.from("settings").select("company_id,drivercommission,currencysymbol,driverreject,timezone,primarycolour,buttoncolour,companylogo,googlemapsapi,driver_integrated_navigation").eq("company_id",s.company_id).maybeSingle(),
    db.from("bookings").select([
      "id","company_id","driver_id","booking_reference","journey_date","journey_time","status",
      "pickup_name","pickup_address","dropoff_name","dropoff_address","airport","flight_number",
      "passengers","suitcases","hand_luggage","vehicle_tier","vehicle_type","customer_name","phone",
      "notes","payment_method","payment_status","amount_paid","balance_due","price","job_price",
      "driver_amount","dispatched_at","accepted_at","on_way_at","passenger_onboard_at","completed_at",
      "cancelled_at","cancellation_reason","no_show_at","route_duration_minutes"
    ].join(",")).eq("company_id",s.company_id).eq("driver_id",s.driver_id).or(`status.not.in.(completed,cancelled,canceled,no_show),journey_date.gte.${historyCutoff}`).order("journey_date").order("journey_time"),
    db.from("driver_unavailability").select("id,company_id,driver_id,from_datetime,to_datetime,reason,active,created_at").eq("company_id",s.company_id).eq("driver_id",s.driver_id).order("from_datetime",{ascending:false})
  ]);
  for(const result of [driverResult,companyResult,settingsResult,jobsResult,unavailableResult]) if(result.error)throw result.error;
  const jobs=jobsResult.data||[];const ids=jobs.map(j=>j.id);let stops:Record<string,unknown>[]=[];
  if(ids.length){const r=await db.from("booking_stops").select("booking_id,stop_order,label,address_name,formatted_address,postcode").eq("company_id",s.company_id).in("booking_id",ids).order("stop_order");if(r.error)throw r.error;stops=r.data||[];}
  const timezone=String(settingsResult.data?.timezone||"Europe/London");
  const driverJobs=jobs.map(j=>{
    const {price,job_price,driver_amount,account_customer_id,account_po_reference,...safeJob}=j;
    const visibleAmount=driver_amount==null?(price??job_price??null):driver_amount;
    const cashCollectionAmount=["cash","pay in car","pay by cash"].includes(String(j.payment_method||"").trim().toLowerCase())?price:null;
    return {...safeJob,price:visibleAmount,driver_amount:driver_amount??null,cash_collection_amount:cashCollectionAmount,operational_available_at:activationAt(j.journey_date,j.journey_time,timezone),via_stops:stops.filter(x=>x.booking_id===j.id)};
  });
  const {googlemapsapi,driver_integrated_navigation,...safeSettings}=settingsResult.data||{};
  const navigationEnabled=driver_integrated_navigation===true;
  return reply({ok:true,driver:driverResult.data,company:companyResult.data,settings:{...safeSettings,driver_integrated_navigation:navigationEnabled},navigation:{enabled:navigationEnabled,browser_maps_key:navigationEnabled?clean(googlemapsapi):null},jobs:driverJobs,unavailability:unavailableResult.data||[],server_time:new Date().toISOString()});
}

async function setOnline(s:DriverSession,online:boolean){const {error}=await db.from("drivers").update({online}).eq("company_id",s.company_id).eq("id",s.driver_id);if(error)throw error;return reply({ok:true,online});}
async function saveGps(s:DriverSession,b:Record<string,unknown>){const lat=Number(b.latitude),lng=Number(b.longitude);if(!Number.isFinite(lat)||!Number.isFinite(lng)||Math.abs(lat)>90||Math.abs(lng)>180)throw new ApiError(400,"Invalid location");const {error}=await db.from("drivers").update({latitude:lat,longitude:lng,location_updated_at:new Date().toISOString()}).eq("company_id",s.company_id).eq("id",s.driver_id).eq("online",true);if(error)throw error;return reply({ok:true});}

async function navigationRoute(s:DriverSession,b:Record<string,unknown>){
  const bookingId=String(b.booking_id||"");
  const latitude=Number(b.latitude),longitude=Number(b.longitude),accuracy=Number(b.accuracy||0);
  if(!bookingId||!validCoordinate(latitude,longitude))throw new ApiError(400,"A valid booking and current location are required");
  if(Number.isFinite(accuracy)&&accuracy>1000)throw new ApiError(400,"Current GPS accuracy is too low");
  const [companyResult,settingsResult,bookingResult]=await Promise.all([
    db.from("companies").select("id,company_code,company_status").eq("id",s.company_id).maybeSingle(),
    db.from("settings").select("driver_integrated_navigation").eq("company_id",s.company_id).maybeSingle(),
    db.from("bookings").select("id,company_id,driver_id,status,pickup_address,pickup_place_id,pickup_lat,pickup_lng,dropoff_address,dropoff_place_id,dropoff_lat,dropoff_lng").eq("id",bookingId).eq("company_id",s.company_id).eq("driver_id",s.driver_id).maybeSingle()
  ]);
  for(const result of [companyResult,settingsResult,bookingResult])if(result.error)throw result.error;
  if(settingsResult.data?.driver_integrated_navigation!==true)throw new ApiError(403,"Integrated navigation is not enabled for this company");
  const booking=bookingResult.data;
  if(!booking)throw new ApiError(404,"Assigned job not found");
  const status=String(booking.status||"").toLowerCase();
  if(!["accepted","on_way","passenger_onboard"].includes(status))throw new ApiError(409,"This job is not available for navigation");
  const subject=await sha256(`${s.driver_id}|${bookingId}`);
  const {data:allowed,error:limitError}=await db.rpc("consume_security_rate_limit",{target_company_id:s.company_id,target_action:"driver_navigation_route",target_subject_hash:subject,maximum_attempts:30,window_seconds:300});
  if(limitError)throw limitError;if(!allowed)throw new ApiError(429,"Navigation is updating too frequently. Continue on the current route and try again shortly.");
  let stops:Record<string,unknown>[]=[];
  if(status==="passenger_onboard"){
    const result=await db.from("booking_stops").select("stop_order,formatted_address,place_id,latitude,longitude").eq("company_id",s.company_id).eq("booking_id",bookingId).order("stop_order");
    if(result.error)throw result.error;stops=result.data||[];
  }
  if(stops.length>10)throw new ApiError(409,"Integrated navigation supports up to 10 intermediate stops. Use Google Maps for this journey.");
  const requestedSkipped=status==="passenger_onboard"?Math.trunc(Number(b.completed_stop_count||0)):0;
  const skippedStops=Number.isFinite(requestedSkipped)?Math.max(0,Math.min(requestedSkipped,stops.length)):0;
  const remainingStops=stops.slice(skippedStops);
  const destination=status==="passenger_onboard"
    ? waypoint(booking.dropoff_place_id,booking.dropoff_lat,booking.dropoff_lng,booking.dropoff_address)
    : waypoint(booking.pickup_place_id,booking.pickup_lat,booking.pickup_lng,booking.pickup_address);
  const intermediates=status==="passenger_onboard"?remainingStops.map(stop=>waypoint(stop.place_id,stop.latitude,stop.longitude,stop.formatted_address)):[];
  const company=companyResult.data;
  const apiKey=routeApiKeyForCompany(String(company?.company_code||""),String(company?.company_status||""));
  if(!apiKey)throw new ApiError(503,"Navigation routing is not configured for this company");
  const roundedOrigin=`${latitude.toFixed(3)},${longitude.toFixed(3)}`;
  const cacheKey=`${s.company_id}|${bookingId}|${status}|${roundedOrigin}|${JSON.stringify([intermediates,destination])}`;
  const cached=routeCache.get(cacheKey);if(cached&&cached.expires>Date.now()){console.info("driver navigation route",{company_code:company?.company_code,target:status==="passenger_onboard"?"dropoff":"pickup",cache_hit:true,outcome:"success"});return reply(cached.value);}
  const response=await fetch("https://routes.googleapis.com/directions/v2:computeRoutes",{
    method:"POST",
    headers:{"Content-Type":"application/json","X-Goog-Api-Key":apiKey,"X-Goog-FieldMask":"routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline,routes.viewport,routes.legs.distanceMeters,routes.legs.duration,routes.legs.steps.distanceMeters,routes.legs.steps.staticDuration,routes.legs.steps.startLocation,routes.legs.steps.endLocation,routes.legs.steps.polyline.encodedPolyline,routes.legs.steps.navigationInstruction"},
    body:JSON.stringify({origin:{location:{latLng:{latitude,longitude}}},destination,intermediates,travelMode:"DRIVE",routingPreference:"TRAFFIC_UNAWARE",polylineQuality:"HIGH_QUALITY",languageCode:"en-GB",units:"IMPERIAL"})
  });
  if(!response.ok){console.error("driver navigation route provider failure",{company_code:company?.company_code,status:response.status});throw new ApiError(503,"Navigation route is temporarily unavailable");}
  const result=await response.json();const route=result.routes?.[0];
  if(!route?.polyline?.encodedPolyline)throw new ApiError(404,"No driving route was found");
  console.info("driver navigation route",{company_code:company?.company_code,target:status==="passenger_onboard"?"dropoff":"pickup",cache_hit:false,outcome:"success"});
  const value={ok:true,booking_id:bookingId,booking_status:status,target:status==="passenger_onboard"?"dropoff":"pickup",skipped_stops:skippedStops,remaining_stops:remainingStops.length,route:normaliseRoute(route),generated_at:new Date().toISOString()};
  routeCache.set(cacheKey,{expires:Date.now()+45000,value});
  if(routeCache.size>250){for(const [key,item] of routeCache){if(item.expires<=Date.now())routeCache.delete(key);}if(routeCache.size>250)routeCache.delete(routeCache.keys().next().value);}
  return reply(value);
}

function normaliseRoute(route:Record<string,unknown>){
  const legs=Array.isArray(route.legs)?route.legs as Record<string,unknown>[]:[];
  const steps=legs.flatMap((leg,legIndex)=>(Array.isArray(leg.steps)?leg.steps:[]).map((raw,stepIndex)=>{
    const step=raw as Record<string,unknown>,instruction=(step.navigationInstruction||{}) as Record<string,unknown>;
    return {leg_index:legIndex,step_index:stepIndex,instruction:clean(instruction.instructions)||"Continue",maneuver:clean(instruction.maneuver)||"MANEUVER_UNSPECIFIED",distance_meters:Number(step.distanceMeters||0),duration_seconds:durationSeconds(step.staticDuration),polyline:String((step.polyline as Record<string,unknown>)?.encodedPolyline||""),start_location:latLng(step.startLocation),end_location:latLng(step.endLocation)};
  }));
  return {distance_meters:Number(route.distanceMeters||0),duration_seconds:durationSeconds(route.duration),polyline:String((route.polyline as Record<string,unknown>)?.encodedPolyline||""),viewport:route.viewport||null,steps};
}
function durationSeconds(value:unknown){const seconds=Number(String(value||"").replace(/s$/, ""));return Number.isFinite(seconds)?Math.max(0,Math.round(seconds)):0;}
function latLng(value:unknown){const point=((value||{}) as Record<string,unknown>).latLng as Record<string,unknown>|undefined;return point?{latitude:Number(point.latitude),longitude:Number(point.longitude)}:null;}
function validCoordinate(lat:number,lng:number){return Number.isFinite(lat)&&Number.isFinite(lng)&&Math.abs(lat)<=90&&Math.abs(lng)<=180;}
function waypoint(placeId:unknown,latValue:unknown,lngValue:unknown,address:unknown){
  const lat=Number(latValue),lng=Number(lngValue);if(validCoordinate(lat,lng))return {location:{latLng:{latitude:lat,longitude:lng}}};
  const place=clean(placeId);if(place)return {placeId:place};
  const text=clean(address);if(text)return {address:text};
  throw new ApiError(409,"This journey address is missing verified navigation coordinates");
}
function routeApiKeyForCompany(companyCode:string,companyStatus:string){const safeCode=/^\d{4}$/.test(companyCode)?companyCode:"";const companySecret=safeCode?Deno.env.get(`GOOGLE_ROUTES_API_KEY_${safeCode}`):null;if(clean(companySecret))return clean(companySecret);const mayUsePlatformFallback=companyStatus.toLowerCase()==="trial"||safeCode==="0001";return mayUsePlatformFallback?clean(Deno.env.get("GOOGLE_ROUTES_API_KEY")):null;}
async function setJobStatus(s:DriverSession,b:Record<string,unknown>){
  const id=String(b.booking_id||"");
  const status=String(b.status||"").toLowerCase();
  if(!id||!["accepted","on_way","passenger_onboard","completed","declined"].includes(status))throw new ApiError(400,"Invalid job status");
  const {data,error}=await db.rpc("transition_driver_booking",{target_company_id:s.company_id,target_driver_id:s.driver_id,target_booking_id:id,requested_status:status});
  if(error){
    if(/Assigned job not found/i.test(error.message))throw new ApiError(404,"Assigned job not found");
    if(/cannot decline/i.test(error.message))throw new ApiError(403,error.message);
    if(/can be started|Invalid job transition|Only an allocated|overlaps another/i.test(error.message))throw new ApiError(409,error.message);
    if(/bookings_one_active_job_per_driver|duplicate key/i.test(error.message))throw new ApiError(409,"Finish the current active job before starting another one.");
    throw error;
  }
  const result=Array.isArray(data)?data[0]:data;
  if(!result)throw new ApiError(404,"Assigned job not found");
  return reply({ok:true,job:result,server_time:new Date().toISOString()});
}
async function markCashPaid(s:DriverSession,b:Record<string,unknown>){const id=String(b.booking_id||"");if(!id)throw new ApiError(400,"Booking is required");const {data,error}=await db.rpc("mark_driver_cash_booking_paid",{target_company_id:s.company_id,target_driver_id:s.driver_id,target_booking_id:id});if(error){if(/Only Pay in Car/i.test(error.message))throw new ApiError(403,error.message);if(/stage/i.test(error.message))throw new ApiError(400,error.message);throw error}if(!data)throw new ApiError(404,"Assigned job not found");return reply({ok:true});}
async function createUnavailability(s:DriverSession,b:Record<string,unknown>){const from=new Date(String(b.from_datetime||"")),to=new Date(String(b.to_datetime||""));if(isNaN(from.valueOf())||isNaN(to.valueOf())||to<=from)throw new ApiError(400,"Invalid unavailable period");const {error}=await db.from("driver_unavailability").insert({company_id:s.company_id,driver_id:s.driver_id,from_datetime:from.toISOString(),to_datetime:to.toISOString(),reason:clean(b.reason),active:true});if(error)throw error;await db.from("drivers").update({online:false}).eq("company_id",s.company_id).eq("id",s.driver_id);return reply({ok:true});}
async function endUnavailability(s:DriverSession){const now=new Date().toISOString();const {error}=await db.from("driver_unavailability").update({active:false,to_datetime:now}).eq("company_id",s.company_id).eq("driver_id",s.driver_id).eq("active",true);if(error)throw error;return reply({ok:true});}
async function logout(s:DriverSession){await db.from("drivers").update({online:false}).eq("company_id",s.company_id).eq("id",s.driver_id);await db.from("driver_sessions").update({revoked_at:new Date().toISOString()}).eq("id",s.id);return reply({ok:true});}
function safeDriver(companyId:string,driverId:string){return db.from("drivers").select("id,company_id,driver_number,full_name,phone,email,vehicle,licence_number,licence_expiry,status,online,latitude,longitude,location_updated_at,pay_type,commission_percent,fixed_job_amount").eq("company_id",companyId).eq("id",driverId).maybeSingle();}
const clean=(v:unknown)=>String(v??"").trim()||null;
const numberOrNull=(v:unknown)=>v===""||v==null?null:Number(v);
function activationAt(dateValue:unknown,timeValue:unknown,timezone:string){
  const date=String(dateValue||""),time=String(timeValue||"");
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!/^\d{2}:\d{2}/.test(time))return null;
  const [year,month,day]=date.split("-").map(Number),[hour,minute,second=0]=time.slice(0,8).split(":").map(Number);
  const target=Date.UTC(year,month-1,day,hour,minute,second);let guess=target;
  try{
    for(let attempts=0;attempts<3;attempts+=1){
      const parts=new Intl.DateTimeFormat("en-GB",{timeZone:timezone,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"}).formatToParts(new Date(guess));
      const values=Object.fromEntries(parts.map(part=>[part.type,Number(part.value)]));
      guess+=target-Date.UTC(values.year,values.month-1,values.day,values.hour,values.minute,values.second);
    }
    return new Date(guess-3.5*60*60*1000).toISOString();
  }catch{return null;}
}
async function sha256(value:string){return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256",encoder.encode(value))));}
function toHex(bytes:Uint8Array){return [...bytes].map(x=>x.toString(16).padStart(2,"0")).join("");}
