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
    if (action === "admin_accounts_report") return await adminAccountsReport(request, body);
    if (action === "admin_message_driver") return await adminMessageDriver(request, body);
    if (action === "admin_list_drivers") return await adminListDrivers(request, body);
    if (action === "admin_message_inbox") return await adminMessageInbox(request, body);
    if (action === "admin_read_driver_messages") return await adminReadDriverMessages(request, body);
    if (action === "admin_get_privacy") return await adminGetPrivacy(request, body);
    if (action === "admin_save_privacy") return await adminSavePrivacy(request, body);

    const session = await requireDriverSession(String(body.session_token || ""));
    if (action === "refresh") return await refresh(session);
    if (action === "set_online") return await setOnline(session, Boolean(body.online));
    if (action === "gps") return await saveGps(session, body);
    if (action === "navigation_route") return await navigationRoute(session, body);
    if (action === "completion_payment_status") return await completionPaymentStatus(session, body);
    if (action === "complete_job") return await completeJob(session, body);
    if (action === "job_status") return await setJobStatus(session, body);
    if (action === "mark_cash_paid") return await markCashPaid(session, body);
    if (action === "create_unavailability") return await createUnavailability(session, body);
    if (action === "end_unavailability") return await endUnavailability(session);
    if (action === "accounts_snapshot") return await accountsSnapshot(session, body);
    if (action === "save_expense") return await saveExpense(session, body);
    if (action === "delete_expense") return await deleteExpense(session, body);
    if (action === "messages") return await driverMessages(session);
    if (action === "send_message") return await sendDriverMessage(session, body);
    if (action === "read_messages") return await readDriverMessages(session);
    if (action === "save_preferences") return await saveDriverPreferences(session, body);
    if (action === "acknowledge_privacy") return await acknowledgePrivacy(session, body);
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
  const {data:membership}=await db.from("company_users").select("company_id,role").eq("user_id",user.id).eq("company_id",companyId).maybeSingle();
  if(!membership) throw new ApiError(403,"You cannot manage drivers for this company");
  if(!["admin","owner"].includes(normal(membership.role))) throw new ApiError(403,"Admin or Owner access is required");
  const input=(body.driver||{}) as Record<string,unknown>;
  const driverId=String(body.driver_id||"")||null;
  const pin=String(body.pin||"").trim();
  if(!String(input.full_name||"").trim()||!String(input.driver_number||"").trim()) throw new ApiError(400,"Driver name and number are required");
  if(!driverId&&!pin) throw new ApiError(400,"A PIN is required for a new driver");
  if(pin&&(pin.length<4||pin.length>12||!/^[0-9]+$/.test(pin))) throw new ApiError(400,"PIN must be 4 to 12 digits");
  const expensesEnabled=input.driver_expenses_enabled===true||input.driver_accounts_enabled===true;
  const payload:Record<string,unknown>={company_id:companyId,full_name:String(input.full_name).trim(),driver_number:String(input.driver_number).trim(),phone:clean(input.phone),email:clean(input.email),vehicle:clean(input.vehicle),licence_number:clean(input.licence_number),licence_expiry:clean(input.licence_expiry),licence_authority:clean(input.licence_authority),active:input.active!==false,status:String(input.status||"available"),online:Boolean(input.online),pay_type:String(input.pay_type||"commission"),commission_percent:numberOrNull(input.commission_percent),fixed_job_amount:numberOrNull(input.fixed_job_amount),driver_accounts_enabled:expensesEnabled,driver_expenses_enabled:expensesEnabled,customer_phone_sharing:input.customer_phone_sharing===true,public_contact_phone:input.customer_phone_sharing===true?clean(input.public_contact_phone):null};
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
  const [driverResult,companyResult,settingsResult,jobsResult,unavailableResult,privacyResult]=await Promise.all([
    safeDriver(s.company_id,s.driver_id),
    db.from("companies").select("id,company_code,name,trading_name,company_status").eq("id",s.company_id).maybeSingle(),
    db.from("settings").select("company_id,drivercommission,currencysymbol,driverreject,timezone,primarycolour,buttoncolour,companylogo,googlemapsapi,driver_integrated_navigation").eq("company_id",s.company_id).maybeSingle(),
    db.from("bookings").select([
      "id","company_id","driver_id","booking_reference","journey_date","journey_time","status",
      "pickup_name","pickup_address","dropoff_name","dropoff_address","airport","flight_number",
      "passengers","suitcases","hand_luggage","vehicle_tier","vehicle_type","customer_name","phone",
      "notes","payment_method","payment_type","payment_status","amount_paid","balance_due","price","job_price",
      "account_customer_id","driver_amount","dispatched_at","accepted_at","on_way_at","arrived_at","passenger_onboard_at","completed_at",
      "cancelled_at","cancellation_reason","no_show_at","route_duration_minutes"
    ].join(",")).eq("company_id",s.company_id).eq("driver_id",s.driver_id).or(`status.not.in.(completed,cancelled,canceled,no_show),journey_date.gte.${historyCutoff}`).order("journey_date").order("journey_time"),
    db.from("driver_unavailability").select("id,company_id,driver_id,from_datetime,to_datetime,reason,active,created_at").eq("company_id",s.company_id).eq("driver_id",s.driver_id).order("from_datetime",{ascending:false}),
    db.from("driver_privacy_notices").select("version,notice_text,privacy_contact,updated_at").eq("company_id",s.company_id).maybeSingle()
  ]);
  for(const result of [driverResult,companyResult,settingsResult,jobsResult,unavailableResult,privacyResult]) if(result.error)throw result.error;
  const jobs=jobsResult.data||[];const ids=jobs.map(j=>j.id);let stops:Record<string,unknown>[]=[];
  if(ids.length){const r=await db.from("booking_stops").select("booking_id,stop_order,label,address_name,formatted_address,postcode").eq("company_id",s.company_id).in("booking_id",ids).order("stop_order");if(r.error)throw r.error;stops=r.data||[];}
  const timezone=String(settingsResult.data?.timezone||"Europe/London");
  const driverJobs=jobs.map(j=>{
    const {price,job_price,driver_amount,account_customer_id,account_po_reference,...safeJob}=j;
    const visibleAmount=driver_amount??null;
    const method=normal(j.payment_method),paymentType=normal(j.payment_type),paymentState=normal(j.payment_status);
    const cashEligible=["cash","pay_in_car","pay_by_cash"].includes(method)||paymentType==="pay_in_car"||(paymentType==="deposit"&&paymentState==="deposit_paid");
    const fare=Math.max(0,Number(price??job_price??0),Number(j.amount_paid||0)+Math.max(0,Number(j.balance_due||0)));
    const cashCollectionAmount=cashEligible?Math.max(0,fare-Math.max(0,Number(j.amount_paid||0))):null;
    return {...safeJob,price:visibleAmount,driver_amount:driver_amount??null,cash_collection_amount:cashCollectionAmount,operational_available_at:activationAt(j.journey_date,j.journey_time,timezone),via_stops:stops.filter(x=>x.booking_id===j.id)};
  });
  const {googlemapsapi,driver_integrated_navigation,...safeSettings}=settingsResult.data||{};
  const navigationEnabled=driver_integrated_navigation===true;
  const {count:unread}=await db.from("driver_messages").select("id",{count:"exact",head:true}).eq("company_id",s.company_id).eq("driver_id",s.driver_id).eq("sender_type","admin").is("read_at",null);
  const acknowledgement=privacyResult.data?await db.from("driver_privacy_acknowledgements").select("acknowledged_at").eq("company_id",s.company_id).eq("driver_id",s.driver_id).eq("notice_version",privacyResult.data.version).maybeSingle():{data:null};
  return reply({ok:true,driver:driverResult.data,company:companyResult.data,settings:{...safeSettings,driver_integrated_navigation:navigationEnabled},privacy:privacyResult.data?{...privacyResult.data,acknowledged_at:acknowledgement.data?.acknowledged_at||null}:null,navigation:{enabled:navigationEnabled,browser_maps_key:navigationEnabled?clean(googlemapsapi):null},jobs:driverJobs,unavailability:unavailableResult.data||[],unread_messages:unread||0,server_time:new Date().toISOString()});
}

async function setOnline(s:DriverSession,online:boolean){const {error}=await db.from("drivers").update({online}).eq("company_id",s.company_id).eq("id",s.driver_id);if(error)throw error;return reply({ok:true,online});}
async function saveGps(s:DriverSession,b:Record<string,unknown>){const lat=Number(b.latitude),lng=Number(b.longitude),accuracy=Number(b.accuracy),speed=Number(b.speed),recordedAt=new Date().toISOString();if(!Number.isFinite(lat)||!Number.isFinite(lng)||Math.abs(lat)>90||Math.abs(lng)>180)throw new ApiError(400,"Invalid location");const {error}=await db.from("drivers").update({latitude:lat,longitude:lng,location_updated_at:recordedAt}).eq("company_id",s.company_id).eq("id",s.driver_id).eq("online",true);if(error)throw error;const bookingId=clean(b.booking_id);if(bookingId){const [{data:settings},{data:booking}]=await Promise.all([db.from("settings").select("driver_gps_history_enabled,driver_gps_retention_days").eq("company_id",s.company_id).maybeSingle(),db.from("bookings").select("id,status").eq("company_id",s.company_id).eq("driver_id",s.driver_id).eq("id",bookingId).maybeSingle()]);if(settings?.driver_gps_history_enabled===true&&booking&&["on_way","arrived","passenger_onboard"].includes(normal(booking.status))&&(!Number.isFinite(accuracy)||accuracy<=250)){const {data:last}=await db.from("driver_gps_points").select("recorded_at").eq("company_id",s.company_id).eq("driver_id",s.driver_id).eq("booking_id",booking.id).order("recorded_at",{ascending:false}).limit(1).maybeSingle();if(!last||Date.now()-Date.parse(last.recorded_at)>=30000)await db.from("driver_gps_points").insert({company_id:s.company_id,driver_id:s.driver_id,booking_id:booking.id,recorded_at:recordedAt,latitude:lat,longitude:lng,accuracy_metres:Number.isFinite(accuracy)?accuracy:null,speed_mps:Number.isFinite(speed)&&speed>=0?speed:null,journey_state:normal(booking.status)});}}return reply({ok:true});}

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
  if(!["accepted","on_way","arrived","passenger_onboard"].includes(status))throw new ApiError(409,"This job is not available for navigation");
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
  if(!id||!["accepted","on_way","arrived","passenger_onboard","declined"].includes(status))throw new ApiError(400,"Invalid job status");
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
async function completionPaymentStatus(s:DriverSession,b:Record<string,unknown>){
  const id=String(b.booking_id||"");if(!id)throw new ApiError(400,"Booking is required");
  const {data:booking,error}=await db.from("bookings")
    .select("id,company_id,driver_id,booking_reference,status,payment_method,payment_type,payment_status,amount_paid,balance_due,price,job_price,account_customer_id")
    .eq("id",id).eq("company_id",s.company_id).eq("driver_id",s.driver_id).maybeSingle();
  if(error)throw error;if(!booking)throw new ApiError(404,"Assigned job not found");
  const status=normal(booking.status);if(status!=="passenger_onboard")throw new ApiError(409,"Passengers must be on board before completing this job");
  const method=normal(booking.payment_method),paymentType=normal(booking.payment_type),paymentState=normal(booking.payment_status);
  const amountPaid=Math.max(0,Number(booking.amount_paid||0));
  const fare=Math.max(0,Number(booking.price??booking.job_price??0),amountPaid+Math.max(0,Number(booking.balance_due||0)));
  const outstanding=Math.max(0,fare-amountPaid);
  const cashEligible=["cash","pay_in_car","pay_by_cash"].includes(method)||paymentType==="pay_in_car"||(paymentType==="deposit"&&paymentState==="deposit_paid");
  const accountBooking=Boolean(booking.account_customer_id)||["account","invoice","account_invoice","pay_by_invoice"].includes(method)||["account","invoice"].includes(paymentType);
  let mode="blocked",reason="Payment state is unsupported or ambiguous. Contact the office before completing this job.";
  if(paymentState==="paid"||outstanding<=0){mode="complete_without_payment";reason=outstanding<=0&&paymentState!=="paid"?"zero_balance":"already_paid";}
  else if(accountBooking){mode="complete_without_payment";reason="account";}
  else if(cashEligible){mode="confirm_cash";reason="cash_outstanding";}
  return reply({ok:true,payment:{mode,reason,booking_reference:String(booking.booking_reference||id.slice(0,8)),fare,amount_paid:amountPaid,outstanding,payment_method:String(booking.payment_method||"Unknown"),payment_status:String(booking.payment_status||"unpaid")}});
}
async function completeJob(s:DriverSession,b:Record<string,unknown>){
  const id=String(b.booking_id||"");if(!id)throw new ApiError(400,"Booking is required");
  const raw=String(b.payment_confirmation||"").trim().toLowerCase();
  const confirmation=raw||null;
  if(confirmation&&!['paid','unpaid'].includes(confirmation))throw new ApiError(400,"Invalid payment confirmation");
  const {data,error}=await db.rpc("complete_driver_booking_with_payment_confirmation",{target_company_id:s.company_id,target_driver_id:s.driver_id,target_booking_id:id,payment_confirmation:confirmation});
  if(error){
    if(/Assigned job not found/i.test(error.message))throw new ApiError(404,"Assigned job not found");
    if(/must confirm|unsupported|ambiguous|account or invoice|Invalid job transition/i.test(error.message))throw new ApiError(409,error.message);
    throw error;
  }
  if(!data)throw new ApiError(404,"Assigned job not found");
  return reply({ok:true,result:data,server_time:new Date().toISOString()});
}
async function markCashPaid(s:DriverSession,b:Record<string,unknown>){const id=String(b.booking_id||"");if(!id)throw new ApiError(400,"Booking is required");const {data,error}=await db.rpc("mark_driver_cash_booking_paid",{target_company_id:s.company_id,target_driver_id:s.driver_id,target_booking_id:id});if(error){if(/eligible outstanding in-car balance/i.test(error.message))throw new ApiError(403,error.message);if(/stage/i.test(error.message))throw new ApiError(400,error.message);throw error}if(!data)throw new ApiError(404,"Assigned job not found");return reply({ok:true});}
async function createUnavailability(s:DriverSession,b:Record<string,unknown>){const from=new Date(String(b.from_datetime||"")),to=new Date(String(b.to_datetime||""));if(isNaN(from.valueOf())||isNaN(to.valueOf())||to<=from)throw new ApiError(400,"Invalid unavailable period");const {error}=await db.from("driver_unavailability").insert({company_id:s.company_id,driver_id:s.driver_id,from_datetime:from.toISOString(),to_datetime:to.toISOString(),reason:clean(b.reason),active:true});if(error)throw error;await db.from("drivers").update({online:false}).eq("company_id",s.company_id).eq("id",s.driver_id);return reply({ok:true});}
async function endUnavailability(s:DriverSession){const now=new Date().toISOString();const {error}=await db.from("driver_unavailability").update({active:false,to_datetime:now}).eq("company_id",s.company_id).eq("driver_id",s.driver_id).eq("active",true);if(error)throw error;return reply({ok:true});}
async function logout(s:DriverSession){await db.from("drivers").update({online:false}).eq("company_id",s.company_id).eq("id",s.driver_id);await db.from("driver_sessions").update({revoked_at:new Date().toISOString()}).eq("id",s.id);return reply({ok:true});}

async function requireAccounts(s:DriverSession){
  const {data,error}=await db.from("drivers").select("driver_expenses_enabled").eq("company_id",s.company_id).eq("id",s.driver_id).maybeSingle();
  if(error)throw error;if(!data?.driver_expenses_enabled)throw new ApiError(403,"Driver Expenses is not enabled");
}
function reportDates(b:Record<string,unknown>){const today=new Date().toISOString().slice(0,10),from=String(b.from||`${today.slice(0,4)}-01-01`),to=String(b.to||today);if(!/^\d{4}-\d{2}-\d{2}$/.test(from)||!/^\d{4}-\d{2}-\d{2}$/.test(to)||from>to)throw new ApiError(400,"Invalid report date range");return {from,to};}
const expenseCategories=new Set(["fuel","ev_charging","tyres","servicing","repairs","insurance","parking","tolls","taxi_plating","taxi_badge_licensing","mot","vehicle_tax","vehicle_cleaning","phone","equipment","vehicle_finance_lease","accountancy","other_business_expenses"]);
async function accountsData(companyId:string,driverId:string,b:Record<string,unknown>){
  const {from,to}=reportDates(b);
  const rulesResult=await db.from("driver_expense_rules").select("id,category,description,amount,frequency,supplier,notes,payment_method,start_date,end_date,business_use_percent,accounting_treatment,active").eq("company_id",companyId).eq("driver_id",driverId).order("start_date",{ascending:false});
  if(rulesResult.error)throw rulesResult.error;
  await materialiseExpenseOccurrences(companyId,driverId,rulesResult.data||[],from,to);
  const [expensesResult,jobsResult,adjustmentsResult]=await Promise.all([
    db.from("driver_expenses").select("id,expense_date,category,description,amount,supplier,notes,payment_method,receipt_path,business_use_percent,accounting_treatment,rule_id,skipped,created_at").eq("company_id",companyId).eq("driver_id",driverId).gte("expense_date",from).lte("expense_date",to).order("expense_date",{ascending:false}),
    db.from("bookings").select("id,booking_reference,journey_date,completed_at,driver_amount,payment_method,payment_type,payment_status,amount_paid,balance_due,price,job_price,account_customer_id").eq("company_id",companyId).eq("driver_id",driverId).eq("status","completed").gte("journey_date",from).lte("journey_date",to).order("journey_date",{ascending:false}),
    db.from("driver_income_adjustments").select("id,effective_date,amount,adjustment_type,reason,created_at").eq("company_id",companyId).eq("driver_id",driverId).gte("effective_date",from).lte("effective_date",to)
  ]);
  for(const result of [expensesResult,rulesResult,jobsResult,adjustmentsResult])if(result.error)throw result.error;
  const expenses=(expensesResult.data||[]).filter(x=>!x.skipped),jobs=(jobsResult.data||[]).map(j=>{
    const earnings=j.driver_amount==null?null:Number(j.driver_amount),method=normal(j.payment_method),type=normal(j.payment_type),status=normal(j.payment_status);
    const cash=["cash","pay_in_car","pay_by_cash"].includes(method)||type==="pay_in_car";
    return {id:j.id,booking_reference:j.booking_reference,journey_date:j.journey_date,completed_at:j.completed_at,driver_earnings:earnings,payment_method:j.payment_method,payment_status:j.payment_status,cash_collected:cash&&status==="paid"?Number(j.amount_paid||0):0,outstanding:status==="paid"?0:(earnings||0)};
  });
  const adjustments=adjustmentsResult.data||[];
  const totalEarnings=jobs.reduce((n,j)=>n+(j.driver_earnings||0),0)+adjustments.reduce((n,a)=>n+Number(a.amount||0),0);
  const totalExpenses=expenses.reduce((n,e)=>n+Number(e.amount||0)*Number(e.business_use_percent||0)/100,0);
  return {from,to,jobs,expenses,rules:rulesResult.data||[],adjustments,summary:{total_earnings:roundMoney(totalEarnings),total_expenses:roundMoney(totalExpenses),estimated_profit:roundMoney(totalEarnings-totalExpenses),outstanding_earnings:roundMoney(jobs.reduce((n,j)=>n+j.outstanding,0)),cash_collected:roundMoney(jobs.reduce((n,j)=>n+j.cash_collected,0))},disclaimer:"Management and tax-preparation records only; not a certified tax return. Payment receipt dates may be unavailable, so earnings and receipts are shown separately."};
}
async function materialiseExpenseOccurrences(companyId:string,driverId:string,rules:Record<string,unknown>[],from:string,to:string){
  const today=new Date().toISOString().slice(0,10),last=to<today?to:today,rows:Record<string,unknown>[]=[];
  for(const rule of rules){if(rule.active===false||rule.frequency==="one_off")continue;let cursor=new Date(`${rule.start_date}T12:00:00Z`),end=new Date(`${String(rule.end_date||last)}T12:00:00Z`),limit=new Date(`${last}T12:00:00Z`);if(end>limit)end=limit;let guard=0;while(cursor<=end&&guard++<3700){const date=cursor.toISOString().slice(0,10);if(date>=from)rows.push({company_id:companyId,driver_id:driverId,rule_id:rule.id,expense_date:date,category:rule.category,description:rule.description,amount:rule.amount,supplier:rule.supplier,notes:rule.notes,payment_method:rule.payment_method,business_use_percent:rule.business_use_percent,accounting_treatment:rule.accounting_treatment,occurrence_key:`${rule.id}:${date}`});cursor=nextOccurrence(cursor,String(rule.frequency));}}
  if(rows.length){const {error}=await db.from("driver_expenses").upsert(rows,{onConflict:"company_id,driver_id,occurrence_key",ignoreDuplicates:true});if(error)throw error;}
}
function nextOccurrence(date:Date,frequency:string){const next=new Date(date);if(frequency==="daily")next.setUTCDate(next.getUTCDate()+1);else if(frequency==="weekly")next.setUTCDate(next.getUTCDate()+7);else if(frequency==="monthly")next.setUTCMonth(next.getUTCMonth()+1);else if(frequency==="quarterly")next.setUTCMonth(next.getUTCMonth()+3);else next.setUTCFullYear(next.getUTCFullYear()+1);return next;}
async function accountsSnapshot(s:DriverSession,b:Record<string,unknown>){await requireAccounts(s);return reply({ok:true,...await accountsData(s.company_id,s.driver_id,b)});}
async function saveExpense(s:DriverSession,b:Record<string,unknown>){
  await requireAccounts(s);const input=(b.expense||{}) as Record<string,unknown>,id=clean(input.id),category=normal(input.category),date=String(input.expense_date||""),amount=Number(input.amount),frequency=normal(input.frequency||"one_off");
  if(!expenseCategories.has(category)||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!clean(input.description)||!Number.isFinite(amount)||amount<0)throw new ApiError(400,"Valid date, category, description and amount are required");
  if(!["one_off","daily","weekly","monthly","quarterly","yearly"].includes(frequency))throw new ApiError(400,"Invalid expense frequency");
  const common={company_id:s.company_id,driver_id:s.driver_id,category,description:clean(input.description),amount:roundMoney(amount),supplier:clean(input.supplier),notes:clean(input.notes),payment_method:clean(input.payment_method),business_use_percent:Math.max(0,Math.min(100,Number(input.business_use_percent??100))),accounting_treatment:["expense","capital","mixed_use","review"].includes(normal(input.accounting_treatment))?normal(input.accounting_treatment):"review",updated_at:new Date().toISOString()};
  let expenseId=id;
  if(frequency!=="one_off"&&!id){const {data:rule,error}=await db.from("driver_expense_rules").insert({...common,frequency,start_date:date,end_date:clean(input.end_date)}).select("id").single();if(error)throw error;const occurrenceKey=`${rule.id}:${date}`;const {data:expense,error:expenseError}=await db.from("driver_expenses").insert({...common,rule_id:rule.id,expense_date:date,occurrence_key:occurrenceKey}).select("id").single();if(expenseError)throw expenseError;expenseId=expense.id;}
  else {const query=id?db.from("driver_expenses").update({...common,expense_date:date}).eq("company_id",s.company_id).eq("driver_id",s.driver_id).eq("id",id):db.from("driver_expenses").insert({...common,expense_date:date});const {data,error}=await query.select("id").single();if(error)throw error;expenseId=data.id;}
  const receipt=input.receipt as Record<string,unknown>|undefined;
  if(receipt?.data_base64){const mime=String(receipt.mime_type||""),extensions:Record<string,string>={"image/jpeg":"jpg","image/png":"png","image/webp":"webp","application/pdf":"pdf"};if(!extensions[mime])throw new ApiError(400,"Unsupported receipt type");let bytes:Uint8Array;try{const decoded=atob(String(receipt.data_base64));bytes=Uint8Array.from(decoded,c=>c.charCodeAt(0));}catch{throw new ApiError(400,"Invalid receipt data");}if(bytes.length>3145728)throw new ApiError(400,"Receipt must be 3 MB or smaller");const path=`${s.company_id}/${s.driver_id}/${expenseId}/${crypto.randomUUID()}.${extensions[mime]}`;const {error:uploadError}=await db.storage.from("driver-expense-receipts").upload(path,bytes,{contentType:mime,upsert:false});if(uploadError)throw uploadError;const {error:pathError}=await db.from("driver_expenses").update({receipt_path:path}).eq("company_id",s.company_id).eq("driver_id",s.driver_id).eq("id",expenseId);if(pathError)throw pathError;}
  await db.from("driver_finance_audit").insert({company_id:s.company_id,driver_id:s.driver_id,actor_type:"driver",actor_id:s.driver_id,action:id?"expense_updated":"expense_created",entity_type:"expense",entity_id:expenseId,details:{amount:roundMoney(amount),category}});
  return reply({ok:true,id:expenseId});
}
async function deleteExpense(s:DriverSession,b:Record<string,unknown>){await requireAccounts(s);const id=String(b.expense_id||"");if(!id)throw new ApiError(400,"Expense is required");const {data:existing,error:findError}=await db.from("driver_expenses").select("id,rule_id").eq("company_id",s.company_id).eq("driver_id",s.driver_id).eq("id",id).maybeSingle();if(findError)throw findError;if(!existing)throw new ApiError(404,"Expense not found");const query=existing.rule_id?db.from("driver_expenses").update({skipped:true,updated_at:new Date().toISOString()}):db.from("driver_expenses").delete();const {error}=await query.eq("company_id",s.company_id).eq("driver_id",s.driver_id).eq("id",id);if(error)throw error;await db.from("driver_finance_audit").insert({company_id:s.company_id,driver_id:s.driver_id,actor_type:"driver",actor_id:s.driver_id,action:existing.rule_id?"expense_occurrence_skipped":"expense_deleted",entity_type:"expense",entity_id:id});return reply({ok:true});}
async function adminIdentity(request:Request,companyId:string){const authHeader=request.headers.get("authorization")||"";const userDb=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_ANON_KEY")!,{global:{headers:{Authorization:authHeader}}});const {data:{user}}=await userDb.auth.getUser();if(!user)throw new ApiError(401,"Admin login required");const {data:m}=await db.from("company_users").select("role").eq("user_id",user.id).eq("company_id",companyId).maybeSingle();if(!m||!["admin","owner"].includes(normal(m.role)))throw new ApiError(403,"Admin or Owner access is required");return user;}
async function adminAccountsReport(request:Request,input:Record<string,unknown>){const companyId=String(input.company_id||""),driverId=String(input.driver_id||"");await adminIdentity(request,companyId);const {data:driver,error}=await db.from("drivers").select("id,full_name,driver_expenses_enabled").eq("company_id",companyId).eq("id",driverId).maybeSingle();if(error)throw error;if(!driver)throw new ApiError(404,"Driver not found");if(!driver.driver_expenses_enabled)throw new ApiError(403,"Driver Expenses is not enabled");return reply({ok:true,driver,...await accountsData(companyId,driverId,input)});}
async function adminListDrivers(request:Request,input:Record<string,unknown>){const companyId=String(input.company_id||"");await adminIdentity(request,companyId);const {data,error}=await db.from("drivers").select("id,company_id,driver_number,full_name,phone,email,vehicle,licence_number,licence_expiry,licence_authority,active,status,online,latitude,longitude,location_updated_at,pay_type,commission_percent,fixed_job_amount,driver_expenses_enabled,customer_phone_sharing,public_contact_phone").eq("company_id",companyId).order("full_name");if(error)throw error;return reply({ok:true,drivers:data||[]});}
async function adminMessageDriver(request:Request,input:Record<string,unknown>){const companyId=String(input.company_id||""),driverId=String(input.driver_id||""),body=String(input.message||"").trim(),clientKey=String(input.client_key||"");const user=await adminIdentity(request,companyId);if(!driverId||!body||body.length>1000||!clientKey)throw new ApiError(400,"Driver, message and client key are required");const {data:driver}=await db.from("drivers").select("id").eq("company_id",companyId).eq("id",driverId).maybeSingle();if(!driver)throw new ApiError(404,"Driver not found");const {error}=await db.from("driver_messages").insert({company_id:companyId,driver_id:driverId,booking_id:clean(input.booking_id),sender_type:"admin",sender_user_id:user.id,body,client_key:clientKey,delivered_at:new Date().toISOString()});if(error&&error.code!=="23505")throw error;return reply({ok:true});}
async function adminMessageInbox(request:Request,input:Record<string,unknown>){const companyId=String(input.company_id||""),driverId=clean(input.driver_id);await adminIdentity(request,companyId);const [{data:drivers,error:driverError},{data:messages,error:messageError}]=await Promise.all([db.from("drivers").select("id,driver_number,full_name").eq("company_id",companyId).order("full_name"),db.from("driver_messages").select("id,driver_id,booking_id,sender_type,body,created_at,delivered_at,read_at").eq("company_id",companyId).order("created_at",{ascending:true}).limit(1000)]);if(driverError)throw driverError;if(messageError)throw messageError;return reply({ok:true,drivers:drivers||[],messages:(messages||[]).filter(row=>!driverId||row.driver_id===driverId)});}
async function adminReadDriverMessages(request:Request,input:Record<string,unknown>){const companyId=String(input.company_id||""),driverId=String(input.driver_id||"");await adminIdentity(request,companyId);if(!driverId)throw new ApiError(400,"Driver is required");const {error}=await db.from("driver_messages").update({read_at:new Date().toISOString()}).eq("company_id",companyId).eq("driver_id",driverId).eq("sender_type","driver").is("read_at",null);if(error)throw error;return reply({ok:true});}
async function adminGetPrivacy(request:Request,input:Record<string,unknown>){const companyId=String(input.company_id||"");await adminIdentity(request,companyId);const result=await db.from("driver_privacy_notices").select("version,notice_text,privacy_contact,updated_at").eq("company_id",companyId).single();if(result.error)throw result.error;return reply({ok:true,notice:result.data})}
async function adminSavePrivacy(request:Request,input:Record<string,unknown>){const companyId=String(input.company_id||""),user=await adminIdentity(request,companyId),notice=String(input.notice_text||"").trim(),contact=String(input.privacy_contact||"").trim();if(notice.length<300||contact.length<3)throw new ApiError(400,"The notice must retain essential transparency information and a privacy contact");const current=await db.from("driver_privacy_notices").select("version,notice_text,privacy_contact").eq("company_id",companyId).single();if(current.error)throw current.error;const changed=current.data.notice_text!==notice||current.data.privacy_contact!==contact,version=changed?Number(current.data.version)+1:Number(current.data.version);const saved=await db.from("driver_privacy_notices").update({version,notice_text:notice,privacy_contact:contact,updated_by:user.id,updated_at:new Date().toISOString()}).eq("company_id",companyId);if(saved.error)throw saved.error;return reply({ok:true,version,reacknowledgement_required:changed})}
async function driverMessages(s:DriverSession){const {data,error}=await db.from("driver_messages").select("id,booking_id,sender_type,body,created_at,delivered_at,read_at").eq("company_id",s.company_id).eq("driver_id",s.driver_id).order("created_at",{ascending:true}).limit(250);if(error)throw error;return reply({ok:true,messages:data||[]});}
async function sendDriverMessage(s:DriverSession,input:Record<string,unknown>){const body=String(input.message||"").trim(),clientKey=String(input.client_key||"");if(!body||body.length>1000||!clientKey)throw new ApiError(400,"Message and client key are required");const {error}=await db.from("driver_messages").insert({company_id:s.company_id,driver_id:s.driver_id,booking_id:clean(input.booking_id),sender_type:"driver",body,client_key:clientKey,delivered_at:new Date().toISOString()});if(error&&error.code!=="23505")throw error;return reply({ok:true});}
async function readDriverMessages(s:DriverSession){const {error}=await db.from("driver_messages").update({read_at:new Date().toISOString()}).eq("company_id",s.company_id).eq("driver_id",s.driver_id).eq("sender_type","admin").is("read_at",null);if(error)throw error;return reply({ok:true});}
async function saveDriverPreferences(s:DriverSession,input:Record<string,unknown>){const theme=normal(input.theme),textSize=normal(input.text_size);if(!["dark","light","device"].includes(theme)||!["normal","large","extra_large"].includes(textSize))throw new ApiError(400,"Invalid appearance preference");const {data:settings}=await db.from("settings").select("driver_phone_sharing_allowed").eq("company_id",s.company_id).maybeSingle();const provider=input.provider_phone_sharing===true&&settings?.driver_phone_sharing_allowed===true,passenger=input.passenger_phone_sharing===true&&settings?.driver_phone_sharing_allowed===true,phone=provider||passenger?clean(input.public_contact_phone):null;const current=await db.from("drivers").select("provider_phone_sharing,passenger_phone_sharing").eq("company_id",s.company_id).eq("id",s.driver_id).single();const {error}=await db.from("drivers").update({portal_theme:theme,portal_text_size:textSize,provider_phone_sharing:provider,passenger_phone_sharing:passenger,customer_phone_sharing:passenger,public_contact_phone:phone}).eq("company_id",s.company_id).eq("id",s.driver_id);if(error)throw error;if(current.data?.provider_phone_sharing!==provider||current.data?.passenger_phone_sharing!==passenger)await db.from("driver_privacy_audit").insert({company_id:s.company_id,driver_id:s.driver_id,action:'phone_sharing_changed',details:{provider,passenger}});return reply({ok:true,provider_phone_sharing:provider,passenger_phone_sharing:passenger});}
async function acknowledgePrivacy(s:DriverSession,input:Record<string,unknown>){const version=Number(input.notice_version);const notice=await db.from("driver_privacy_notices").select("version").eq("company_id",s.company_id).single();if(!notice.data||version!==notice.data.version||input.acknowledged!==true)throw new ApiError(409,"Current privacy notice acknowledgement required");await db.from("driver_privacy_acknowledgements").upsert({company_id:s.company_id,driver_id:s.driver_id,notice_version:version,session_id:s.id,metadata:{source:'driver_portal'}},{onConflict:'company_id,driver_id,notice_version'});await db.from("driver_privacy_audit").insert({company_id:s.company_id,driver_id:s.driver_id,action:'notice_acknowledged',details:{version}});return reply({ok:true,notice_version:version,acknowledged_at:new Date().toISOString()})}
function roundMoney(value:number){return Math.round((value+Number.EPSILON)*100)/100;}
function safeDriver(companyId:string,driverId:string){return db.from("drivers").select("id,company_id,driver_number,full_name,phone,email,vehicle,licence_number,licence_expiry,status,online,latitude,longitude,location_updated_at,pay_type,commission_percent,fixed_job_amount,driver_expenses_enabled,portal_theme,portal_text_size,customer_phone_sharing,provider_phone_sharing,passenger_phone_sharing,public_contact_phone").eq("company_id",companyId).eq("id",driverId).maybeSingle();}
const clean=(v:unknown)=>String(v??"").trim()||null;
const normal=(v:unknown)=>String(v??"").trim().toLowerCase().replace(/[^a-z0-9]+/g,"_").replace(/^_+|_+$/g,"");
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
