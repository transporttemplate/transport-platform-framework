import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};
const respond = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: cors });
const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

type Row = Record<string, any>;

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (request.method !== "POST") return respond({ ok: false, error: "Method not allowed" }, 405);

  try {
    const body = await request.json();
    const companyCode = clean(body.company_code);
    const booking = body.booking as Row;
    const stops = Array.isArray(body.stops) ? body.stops : [];
    if (!companyCode || !booking) throw new ApiError(400, "company_code and booking are required");

    // A public caller supplies only the public company code. The trusted UUID is
    // resolved here and is the only company_id used by subsequent reads/writes.
    const { data: company, error: companyError } = await db
      .from("companies")
      .select("id,company_code,company_status,trial_expires_at,trial_grace_expires_at")
      .eq("company_code", companyCode)
      .maybeSingle();
    if (companyError) throw companyError;
    if (!company) throw new ApiError(404, "Company not found");
    const companyId = String(company.id);
    enforceCompanyLifecycle(company);

    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    const subject = await hash(`${ip}|${companyId}`);
    const { data: allowed, error: limitError } = await db.rpc("consume_security_rate_limit", {
      target_company_id: companyId,
      target_action: "public_booking",
      target_subject_hash: subject,
      maximum_attempts: 10,
      window_seconds: 900,
    });
    if (limitError) throw limitError;
    if (!allowed) throw new ApiError(429, "Too many booking attempts. Try again later.");

    const [{ data: settings, error: settingsError }, { data: areas, error: areasError }] = await Promise.all([
      db.from("settings").select([
        "company_id", "businessstatus", "holidayfrom", "holidayfromtime", "holidayto", "holidaytotime",
        "acceptadvancebookings", "bookwhileclosed", "timezone", "maxadvancedays", "minimumnotice",
        "returnbookings", "multiplestops", "allowcash", "enablecash", "allowcard", "enablestripe", "allowaccounts", "enableaccounts",
        "airportpricing", "distancecalculator", "allowairportoutsidearea", "minimumfare", "firstmile",
        "mileband1", "mileband2", "mileband3", "mileband4", "mileband5", "mileband6", "bookingfee", "airportviasurcharge",
        "allowvehicle_standard", "allowvehicle_executive_car", "allowvehicle_5_8", "allowvehicle_9_16", "allowvehicle_17_23", "allowvehicle_24_52",
        "vehicleuplift_executive_car_percent", "vehicleuplift_5_8_percent", "vehicleuplift_9_16_percent", "vehicleuplift_17_23_percent", "vehicleuplift_24_52_percent",
        "allowvehicle_5_7", "vehicleuplift_5_7_percent", "enablecardbookingfee", "cardbookingfeepercent",
        "allowvehicle_executive_5_7", "vehicleuplift_executive_5_7_percent",
        "returndiscount", "requiredeposit", "airportdepositrequired", "depositpercent", "stripepublishablekey",
      ].join(",")).eq("company_id", companyId).maybeSingle(),
      db.from("service_areas").select("id,company_id,postcode_prefix,radius_miles,active")
        .eq("company_id", companyId).eq("active", true),
    ]);
    if (settingsError) throw settingsError;
    if (areasError) throw areasError;
    if (!settings) throw new ApiError(503, "Company booking settings are unavailable");

    if (clean(body.action) === "validate_account") {
      if (!bool(settings.allowaccounts) && !bool(settings.enableaccounts)) {
        throw new ApiError(400, "Account payment is not enabled");
      }
      const account = await resolvePublicAccount(companyId, booking);
      return respond({ ok: true, valid: true, business_name: account.business_name });
    }

    validateBasicBooking(booking, stops, settings);
    const timezone = validTimeZone(settings.timezone) ? String(settings.timezone) : "Europe/London";
    const outboundAt = zonedDateTime(booking.journey_date, booking.journey_time, timezone);
    validateBookingTime(outboundAt, settings, timezone);

    const isReturn = bool(booking.return_journey);
    let returnAt: Date | null = null;
    if (isReturn) {
      returnAt = zonedDateTime(booking.return_date, booking.return_time, timezone);
      if (returnAt <= outboundAt) throw new ApiError(400, "Return journey must be after the outbound journey");
      validateBookingTime(returnAt, settings, timezone);
    }

    const mode = canonicalJourneyType(booking.journey_type);
    if (mode === "airport" && !bool(settings.airportpricing)) {
      throw new ApiError(400, "Airport fixed-price bookings are not enabled");
    }
    if (mode === "distance" && !bool(settings.distancecalculator)) {
      throw new ApiError(400, "Distance bookings are not enabled");
    }
    const paymentMethod = validatePayment(booking.payment_method, settings);
    if (String(company.company_status || "active") === "trial" && ["Card", "Deposit"].includes(paymentMethod)) {
      throw new ApiError(403, "Online card and deposit payments are not available during the trial");
    }
    const account = paymentMethod === "Account"
      ? await resolvePublicAccount(companyId, booking)
      : null;

    let airport: Row | null = null;
    if (mode === "airport") {
      const airportName = clean(booking.airport);
      if (!airportName) throw new ApiError(400, "A valid airport is required");
      let { data, error } = await db.from("airports")
        .select("id,company_id,name,code,active,price_1_4_oneway,price_1_4_return,price_5_7_oneway,price_5_7_return,deposit_percent")
        .eq("company_id", companyId).eq("active", true).eq("name", airportName)
        .maybeSingle();
      if (error) throw error;
      if (!data) {
        const byCode = await db.from("airports")
          .select("id,company_id,name,code,active,price_1_4_oneway,price_1_4_return,price_5_7_oneway,price_5_7_return,deposit_percent")
          .eq("company_id", companyId).eq("active", true).eq("code", airportName)
          .maybeSingle();
        if (byCode.error) throw byCode.error;
        data = byCode.data;
      }
      if (!data) throw new ApiError(400, "The selected airport is not available");
      airport = data;
      const airportLabel = String(airport.name || "").trim().toLowerCase();
      const pickupLabel = String(booking.pickup_address || "").trim().toLowerCase();
      const dropoffLabel = String(booking.dropoff_address || "").trim().toLowerCase();
      if (pickupLabel !== airportLabel && dropoffLabel !== airportLabel) {
        throw new ApiError(400, "The selected airport must be one endpoint of the journey");
      }
    }

    const routeKey = routeApiKeyForCompany(String(company.company_code), String(company.company_status || "active"));
    if (!routeKey) throw new ApiError(503, "Route pricing is not configured for this company.");
    const route = await authoritativeRoute(booking, stops, airport, routeKey);

    if (mode === "airport" && !bool(settings.allowairportoutsidearea)) {
      enforceAirportServiceArea(booking, airport!, areas || [], route);
    }

    const vehicleTier = validateVehicleTier(booking.vehicle_tier || booking.vehicle_type, integer(booking.passengers), settings);
    const pricing = calculatePrice({ settings, airport, mode, vehicleTier, miles: route.miles, isReturn, viaCount: route.stops.length });
    const cardFeePercent = paymentMethod === "Card" && bool(settings.enablecardbookingfee) ? Math.min(100, Math.max(0, number(settings.cardbookingfeepercent))) : 0;
    const cardFeeAmount = round2(pricing.total * cardFeePercent / 100);
    const authoritativeTotal = round2(pricing.total + cardFeeAmount);
    const journeyPrices = splitPrice(pricing.total, isReturn);
    const prices = splitPrice(authoritativeTotal, isReturn);
    const onlinePayment=paymentMethod==="Card"||paymentMethod==="Deposit";
    const airportPickup=mode==="airport" && String(booking.pickup_address||"").trim().toLowerCase()===String(airport?.name||"").trim().toLowerCase();
    if(airportPickup && bool(settings.airportdepositrequired) && paymentMethod==="Pay in Car") throw new ApiError(400,"Online payment is required for this airport pickup");
    const depositRequired=bool(settings.requiredeposit)||(airportPickup&&bool(settings.airportdepositrequired));
    if(depositRequired&&paymentMethod==="Pay in Car") throw new ApiError(400,"Online payment is required for this journey");
    if(paymentMethod==="Deposit"&&!depositRequired) throw new ApiError(400,"Deposit payment is not enabled for this journey");
    const depositPercent=Math.min(100,Math.max(0,number(airportPickup?airport?.deposit_percent:settings.depositpercent)||number(settings.depositpercent)));
    if(paymentMethod==="Deposit"&&depositPercent<=0) throw new ApiError(503,"Deposit percentage is not configured");
    const amountDue=paymentMethod==="Deposit"?round2(authoritativeTotal*depositPercent/100):onlinePayment?authoritativeTotal:0;
    const stripeSecret=onlinePayment?stripeSecretForCompany(String(company.company_code)):null;
    const stripePublishableKey=onlinePayment?clean(settings.stripepublishablekey):null;
    if(onlinePayment&&!bool(settings.enablestripe)) throw new ApiError(503,"Stripe payments are not enabled for this company");
    if(onlinePayment){
      const secretMode=stripeCredentialMode(stripeSecret,"sk");
      const publishableMode=stripeCredentialMode(stripePublishableKey,"pk");
      if(!secretMode||!publishableMode) throw new ApiError(503,"Stripe credentials are not configured for this company");
      if(secretMode!==publishableMode) throw new ApiError(503,"Stripe publishable and secret keys are configured for different modes.");
    }

    const name = clean(booking.customer_name);
    const email = clean(booking.email);
    const phone = clean(booking.phone);
    if (!name || (!email && !phone)) throw new ApiError(400, "Customer name and phone or email are required");

    const customerResult = await db.rpc("find_or_create_public_customer", {
      target_company_id: companyId,
      customer_name: name,
      customer_email: email,
      customer_phone: phone,
    });
    if (customerResult.error) throw customerResult.error;
    const customerId = customerResult.data;

    const refResult = await db.rpc("next_company_booking_reference", { target_company_id: companyId });
    if (refResult.error) throw refResult.error;
    const reference = refResult.data;
    const id = crypto.randomUUID();
    const record = bookingPayload(booking, {
      id,
      company_id: companyId,
      customer_id: customerId,
      booking_reference: reference,
      status: "Waiting",
      payment_method: paymentMethod,
      payment_status: onlinePayment?"pending_payment":"unpaid",
      payment_type: paymentMethod==="Deposit"?"deposit":paymentMethod==="Card"?"full":"pay_in_car",
      amount_paid: 0,
      balance_due: authoritativeTotal,
      price: prices.outbound,
      journey_fare: journeyPrices.outbound,
      card_booking_fee_percent: cardFeePercent,
      card_booking_fee_amount: round2(prices.outbound - journeyPrices.outbound),
      route_distance_miles: route.miles,
      route_duration_minutes: route.minutes,
      pricing_method: pricing.method,
      vehicle_tier: vehicleTier,
      vehicle_type: vehicleTier === "standard" ? "car" : vehicleTier === "5_7" ? "mpv" : vehicleTier,
      account_customer_id: account?.id || null,
      account_po_reference: account ? clean(booking.account_po_reference) : null,
      booking_source: "website",
      pickup_address: route.origin.formattedAddress,
      pickup_postcode: route.origin.postcode,
      pickup_place_id: route.origin.placeId,
      pickup_lat: route.origin.latitude,
      pickup_lng: route.origin.longitude,
      dropoff_address: route.destination.formattedAddress,
      dropoff_postcode: route.destination.postcode,
      dropoff_place_id: route.destination.placeId,
      dropoff_lat: route.destination.latitude,
      dropoff_lng: route.destination.longitude,
    });
    const rows = [record];
    if (isReturn) {
      rows.push({
        ...record,
        id: crypto.randomUUID(),
        booking_reference: `${reference}-R`,
        pickup_address: record.dropoff_address,
        dropoff_address: record.pickup_address,
        pickup_name: record.dropoff_name,
        pickup_postcode: record.dropoff_postcode,
        pickup_place_id: record.dropoff_place_id,
        pickup_lat: record.dropoff_lat,
        pickup_lng: record.dropoff_lng,
        dropoff_name: record.pickup_name,
        dropoff_postcode: record.pickup_postcode,
        dropoff_place_id: record.pickup_place_id,
        dropoff_lat: record.pickup_lat,
        dropoff_lng: record.pickup_lng,
        journey_date: booking.return_date,
        journey_time: booking.return_time,
        return_journey: false,
        return_date: null,
        return_time: null,
        price: prices.return,
        journey_fare: journeyPrices.return,
        card_booking_fee_amount: round2((prices.return || 0) - (journeyPrices.return || 0)),
        journey_type: "return",
        payment_type: "linked_return",
        amount_paid: 0,
        balance_due: 0,
      });
    }

    const inserted = await db.from("bookings").insert(rows).select("id,booking_reference,price");
    if (inserted.error) throw inserted.error;
    const stopRows = rows.flatMap((row, index) => {
      const ordered = index === 0 ? route.stops : [...route.stops].reverse();
      return ordered.map((stop: Row, stopIndex: number) => ({
        company_id: companyId,
        booking_id: row.id,
        stop_order: stopIndex + 1,
        label: clean(stop.label) || "Via",
        address_name: clean(stop.address_name),
        formatted_address: clean(stop.formattedAddress),
        postcode: clean(stop.postcode),
        latitude: numberOrNull(stop.latitude),
        longitude: numberOrNull(stop.longitude),
        place_id: clean(stop.placeId),
      }));
    }).filter((stop: Row) => stop.formatted_address);
    if (stopRows.length) {
      const stopResult = await db.from("booking_stops").insert(stopRows);
      if (stopResult.error) throw stopResult.error;
    }

    let stripe:Row|null=null;
    if(onlinePayment){
      const primaryBooking=inserted.data?.[0];
      const intent=await createStripeIntent(stripeSecret!,amountDue,companyId,String(primaryBooking.id),String(reference),paymentMethod);
      const paymentInsert=await db.from("payments").insert({company_id:companyId,booking_id:primaryBooking.id,amount:amountDue,method:"stripe",status:"pending",reference:intent.id});
      if(paymentInsert.error) throw paymentInsert.error;
      stripe={client_secret:intent.client_secret,publishable_key:stripePublishableKey,amount_due:amountDue,balance_due:round2(authoritativeTotal-amountDue),payment_type:paymentMethod==="Deposit"?"deposit":"full"};
    }

    if (String(company.company_status || "active") !== "trial") {
      await notifyBookingEmail(companyId, String(inserted.data?.[0]?.id || id), "new_booking");
    }

    return respond({
      ok: true,
      customer_id: customerId,
      reference,
      bookings: inserted.data,
      authoritative_price: authoritativeTotal,
      journey_fare: pricing.total,
      card_booking_fee_percent: cardFeePercent,
      card_booking_fee_amount: cardFeeAmount,
      return_pricing: pricing.returnPricing,
      pricing_method: pricing.method,
      stripe,
      account: account ? { business_name: account.business_name, account_code: account.account_code } : null,
    });
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 500;
    const message = error instanceof Error ? error.message : "Unexpected error";
    console.error("public-booking-create", { status, error: message });
    return respond({ ok: false, error: status === 500 ? "Unable to create booking" : message }, status);
  }
});

function validateBasicBooking(booking: Row, stops: Row[], settings: Row) {
  if (!clean(booking.pickup_address) || !clean(booking.dropoff_address)) throw new ApiError(400, "Pickup and destination are required");
  const passengers = integer(booking.passengers);
  if (passengers < 1 || passengers > 52) throw new ApiError(400, "Passengers must be between 1 and 52");
  if (bool(booking.return_journey) && !bool(settings.returnbookings)) throw new ApiError(400, "Return bookings are not enabled");
  if (stops.length && !bool(settings.multiplestops)) throw new ApiError(400, "Multiple stops are not enabled");
  if (stops.length > 8) throw new ApiError(400, "Too many intermediate stops");
}

function validateBookingTime(journey: Date, settings: Row, timezone: string) {
  const now = new Date();
  const minimum = Math.max(0, number(settings.minimumnotice)) * 60_000;
  const maximum = Math.max(0, number(settings.maxadvancedays, 365)) * 86_400_000;
  if (journey.getTime() < now.getTime() + minimum) throw new ApiError(400, "Journey does not meet the minimum notice period");
  if (journey.getTime() > now.getTime() + maximum) throw new ApiError(400, "Journey is beyond the maximum advance booking period");

  const status = canonicalStatus(settings.businessstatus);
  if (status === "open") return;
  const starts = settings.holidayfrom ? zonedDateTime(settings.holidayfrom, settings.holidayfromtime || "00:00:00", timezone) : null;
  const ends = settings.holidayto ? zonedDateTime(settings.holidayto, settings.holidaytotime || "23:59:59", timezone) : null;
  const active = (!starts || now >= starts) && (!ends || now < ends);
  const journeyInsideClosure = (!starts || journey >= starts) && (!ends || journey <= ends);
  if (journeyInsideClosure) throw new ApiError(400, "Journey must be outside the configured closure period");
  if (active) {
    if (!bool(settings.acceptadvancebookings) && !bool(settings.bookwhileclosed)) throw new ApiError(403, "Online booking is currently closed");
    if (!ends) throw new ApiError(403, "Online booking is closed and no reopening time is configured");
    if (journey <= ends) throw new ApiError(400, "Journey must be strictly after the reopening time");
  }
}

function validatePayment(value: unknown, settings: Row) {
  const method = String(value || "").trim().toLowerCase();
  if (["account", "invoice", "on account"].includes(method)) {
    if (!bool(settings.allowaccounts) && !bool(settings.enableaccounts)) throw new ApiError(400, "Account payment is not enabled");
    return "Account";
  }
  if (["pay now", "card", "card / prepaid", "prepaid", "paid"].includes(method)) {
    if (!bool(settings.allowcard) && !bool(settings.enablestripe)) throw new ApiError(400, "Card payment is not enabled");
    return "Card";
  }
  if(method==="deposit"){
    if (!bool(settings.allowcard) && !bool(settings.enablestripe)) throw new ApiError(400, "Card payment is not enabled");
    return "Deposit";
  }
  if (!["pay in car", "cash", "pay by cash"].includes(method)) throw new ApiError(400, "Invalid payment method");
  if (!bool(settings.allowcash) && !bool(settings.enablecash)) throw new ApiError(400, "Cash payment is not enabled");
  return "Pay in Car";
}

async function createStripeIntent(secret:string,amount:number,companyId:string,bookingId:string,reference:string,paymentMethod:string){
  const minor=Math.round(amount*100);
  if(minor<50) throw new ApiError(400,"Payment amount is too small");
  const form=new URLSearchParams();
  form.set("amount",String(minor)); form.set("currency","gbp"); form.append("payment_method_types[]","card");
  form.set("metadata[company_id]",companyId); form.set("metadata[booking_id]",bookingId); form.set("metadata[booking_reference]",reference); form.set("metadata[payment_type]",paymentMethod.toLowerCase());
  const response=await fetch("https://api.stripe.com/v1/payment_intents",{method:"POST",headers:{Authorization:`Bearer ${secret}`,"Content-Type":"application/x-www-form-urlencoded"},body:form});
  const result=await response.json();
  if(!response.ok||!result?.client_secret) throw new ApiError(502,"Unable to start Stripe payment");
  return result;
}

async function notifyBookingEmail(companyId:string,bookingId:string,event:string){
  const base=clean(Deno.env.get("SUPABASE_URL"));
  const serviceKey=clean(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
  if(!base||!serviceKey)return;
  try{
    const response=await fetch(`${base}/functions/v1/send-booking-email`,{method:"POST",headers:{"Content-Type":"application/json",apikey:serviceKey,Authorization:`Bearer ${serviceKey}`},body:JSON.stringify({company_id:companyId,booking_id:bookingId,event})});
    const result=await response.json().catch(()=>({ok:false,error:"Invalid email function response"}));
    if(!response.ok||!result?.ok)console.error("Booking email notification failed",{status:response.status,error:result?.error||result?.skipped||"Email was not accepted"});
    else if(!result.sent)console.info("Booking email notification not sent",{reason:result.skipped||"duplicate"});
  }catch(error){console.error("Booking email notification failed",error instanceof Error?error.message:error);}
}

async function resolvePublicAccount(companyId: string, booking: Row) {
  const code = String(booking.account_code || "").trim().toUpperCase();
  const verification = String(booking.account_verification || "").trim().toLowerCase();
  if (!code || !verification) throw new ApiError(400, "Account details are invalid or unavailable");
  const { data, error } = await db.from("account_customers")
    .select("id,company_id,account_code,business_name,contact_email,billing_email,billing_postcode,po_required,default_po_reference,status")
    .eq("company_id", companyId).eq("account_code", code).maybeSingle();
  if (error) throw error;
  const emailMatch = verification.includes("@") && [data?.contact_email, data?.billing_email]
    .some((value) => String(value || "").trim().toLowerCase() === verification);
  const postcodeMatch = !verification.includes("@") && normalPostcode(data?.billing_postcode) === normalPostcode(verification);
  if (!data || data.status !== "active" || (!emailMatch && !postcodeMatch)) {
    throw new ApiError(400, "Account details are invalid or unavailable");
  }
  const poReference = clean(booking.account_po_reference) || clean(data.default_po_reference);
  if (data.po_required && !poReference) throw new ApiError(400, "A PO/reference is required for this account");
  booking.account_po_reference = poReference;
  return data;
}

async function authoritativeRoute(booking: Row, stops: Row[], airport: Row | null, apiKey: string) {
  const airportLabel = String(airport?.name || "").trim().toLowerCase();
  const pickupIsAirport = airport && String(booking.pickup_address || "").trim().toLowerCase() === airportLabel;
  const dropoffIsAirport = airport && String(booking.dropoff_address || "").trim().toLowerCase() === airportLabel;
  const [origin, destination, ...canonicalStops] = await Promise.all([
    verifiedLocation(null, pickupIsAirport ? `${airport!.name}, UK` : booking.pickup_address, apiKey, pickupIsAirport ? null : booking.pickup_place_id),
    verifiedLocation(null, dropoffIsAirport ? `${airport!.name}, UK` : booking.dropoff_address, apiKey, dropoffIsAirport ? null : booking.dropoff_place_id),
    ...stops.map((stop) => verifiedLocation(stop, stop.formatted_address, apiKey, stop.place_id)),
  ]);
  const intermediates = canonicalStops.map((stop) => ({ placeId: stop.placeId }));
  const response = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": "routes.distanceMeters,routes.duration",
    },
    body: JSON.stringify({
      origin: { placeId: origin.placeId },
      destination: { placeId: destination.placeId },
      intermediates,
      travelMode: "DRIVE",
      routingPreference: "TRAFFIC_UNAWARE",
    }),
  });
  if (!response.ok) {
    console.error("public-booking-create route verification failed", { status: response.status });
    throw new ApiError(503, "Unable to verify the journey route");
  }
  const result = await response.json();
  const route = result.routes?.[0];
  const metres = Number(route?.distanceMeters);
  const seconds = Number(String(route?.duration || "").replace(/s$/, ""));
  if (!Number.isFinite(metres) || metres <= 0 || !Number.isFinite(seconds)) throw new ApiError(400, "No valid driving route was found");
  return {
    miles: round2(metres / 1609.344),
    minutes: Math.max(1, Math.round(seconds / 60)),
    origin,
    destination,
    stops: canonicalStops,
  };
}

function enforceAirportServiceArea(booking: Row, airport: Row, areas: Row[], route: Row) {
  const prefixes = areas.map((area) => normalPostcode(area.postcode_prefix)).filter(Boolean);
  if (!prefixes.length) throw new ApiError(503, "Airport service areas are not configured");
  const airportName = String(airport.name || "").trim().toLowerCase();
  const pickupIsAirport = String(booking.pickup_address || "").trim().toLowerCase() === airportName;
  const postcode = normalPostcode(pickupIsAirport ? route.destination.postcode : route.origin.postcode);
  if (!postcode || !prefixes.some((prefix) => postcode.startsWith(prefix))) {
    throw new ApiError(400, "This airport journey is outside the configured service area");
  }
}

async function verifiedLocation(source: Row | null, address: unknown, apiKey: string, placeId: unknown) {
  const params = new URLSearchParams({ key: apiKey });
  if (clean(placeId)) params.set("place_id", String(placeId));
  else {
    params.set("address", String(address || ""));
    params.set("components", "country:GB");
  }
  const response = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?${params}`);
  if (!response.ok) throw new ApiError(503, "Unable to verify a journey address");
  const result = await response.json();
  const location = result.results?.[0];
  if (!location?.place_id || !location?.geometry?.location) throw new ApiError(400, "A journey address could not be verified");
  const component = location.address_components?.find((item: Row) => item.types?.includes("postal_code"));
  return {
    label: clean(source?.label) || "Via",
    address_name: clean(source?.address_name),
    formattedAddress: String(location.formatted_address || address || ""),
    postcode: String(component?.long_name || ""),
    placeId: String(location.place_id),
    latitude: Number(location.geometry.location.lat),
    longitude: Number(location.geometry.location.lng),
  };
}

function validateVehicleTier(value: unknown, passengers: number, settings: Row) {
  const aliases: Record<string, string> = { car: "standard", mpv: "5_7", standard: "standard", executive_car: "executive_car", "5_7": "5_7", executive_5_7: "executive_5_7", "5_8": "5_8", "9_16": "9_16", "17_23": "17_23", "24_52": "24_52" };
  const tier = aliases[String(value || "").toLowerCase()];
  const rules: Record<string, { capacity: number; setting: string; legacyDefault: boolean }> = {
    standard: { capacity: 4, setting: "allowvehicle_standard", legacyDefault: true },
    executive_car: { capacity: 4, setting: "allowvehicle_executive_car", legacyDefault: false },
    "5_7": { capacity: 7, setting: "allowvehicle_5_7", legacyDefault: true },
    executive_5_7: { capacity: 7, setting: "allowvehicle_executive_5_7", legacyDefault: false },
    "5_8": { capacity: 8, setting: "allowvehicle_5_8", legacyDefault: false },
    "9_16": { capacity: 16, setting: "allowvehicle_9_16", legacyDefault: false },
    "17_23": { capacity: 23, setting: "allowvehicle_17_23", legacyDefault: false },
    "24_52": { capacity: 52, setting: "allowvehicle_24_52", legacyDefault: false },
  };
  const rule = rules[tier];
  if (!rule) throw new ApiError(400, "A valid vehicle tier is required");
  const configured = settings[rule.setting];
  if (!(configured == null ? rule.legacyDefault : bool(configured))) throw new ApiError(400, "The selected vehicle tier is not available");
  if (passengers > rule.capacity) throw new ApiError(400, "The selected vehicle cannot carry this passenger group");
  return tier;
}

function vehicleUplift(tier: string, settings: Row) {
  if (tier === "standard") return 0;
  if (tier === "5_7") return Math.max(0, settings.vehicleuplift_5_7_percent == null ? number(settings.bookingfee) : number(settings.vehicleuplift_5_7_percent));
  if (tier === "5_8") return Math.max(0, number(settings.vehicleuplift_5_8_percent));
  return Math.max(0, number(settings[`vehicleuplift_${tier}_percent`]));
}

function calculatePrice(input: { settings: Row; airport: Row | null; mode: string; vehicleTier: string; miles: number; isReturn: boolean; viaCount: number }) {
  const { settings, airport, mode, vehicleTier, miles, isReturn, viaCount } = input;
  const uplift = vehicleUplift(vehicleTier, settings);
  if (mode === "airport") {
    const trip = isReturn ? "return" : "oneway";
    const size = ["5_7", "executive_5_7", "5_8"].includes(vehicleTier) ? "5_7" : "1_4";
    const configured = number(airport?.[`price_${size}_${trip}`], NaN);
    if (!Number.isFinite(configured) || configured <= 0) throw new ApiError(400, "No fixed price is configured for this airport journey");
    const viaSurcharge = Math.max(0, number(settings.airportviasurcharge));
    const tierPrice = ["standard", "5_7"].includes(vehicleTier) ? configured : configured * (1 + uplift / 100);
    const total = round2(tierPrice + Math.max(0, viaCount) * viaSurcharge);
    return { total, method: "Airport fixed price", returnPricing: { is_return: isReturn, gross: total, discount_percent: 0, discount_amount: 0, final_total: total } };
  }

  if (!Number.isFinite(miles) || miles <= 0) throw new ApiError(400, "A valid route distance is required");
  const rates = [1, 2, 3, 4, 5, 6].map((index) => Math.max(0, number(settings[`mileband${index}`])));
  const firstMile = Math.max(0, number(settings.firstmile));
  if (firstMile <= 0 && !rates.some((rate) => rate > 0)) throw new ApiError(503, "Distance pricing is not configured");
  const ends = [10, 30, 80, 150, 500, 1000];
  let total = firstMile;
  let remaining = Math.max(0, miles - 1);
  let start = 1;
  for (let index = 0; index < ends.length && remaining > 0; index += 1) {
    const inBand = Math.min(remaining, ends[index] - start);
    total += inBand * rates[index];
    remaining -= inBand;
    start = ends[index];
  }
  if (remaining > 0) total += remaining * rates[5];
  const oneWay = Math.max(Math.max(0, number(settings.minimumfare)), total) * (1 + uplift / 100);
  const gross = isReturn ? oneWay * 2 : oneWay;
  const discountPercent = isReturn ? Math.min(100, Math.max(0, number(settings.returndiscount))) : 0;
  const finalTotal = floorHalf(gross * (1 - discountPercent / 100));
  return { total: finalTotal, method: "Distance price", returnPricing: { is_return: isReturn, outbound_base: round2(oneWay), gross: round2(gross), discount_percent: discountPercent, discount_amount: round2(gross - finalTotal), final_total: finalTotal } };
}

function splitPrice(total: number, isReturn: boolean) {
  const pennies = Math.round(total * 100);
  if (!isReturn) return { outbound: pennies / 100, return: null };
  const outboundPennies = Math.ceil(pennies / 2);
  return { outbound: outboundPennies / 100, return: (pennies - outboundPennies) / 100 };
}

function bookingPayload(booking: Row, fixed: Row) {
  const allowed = [
    "customer_name", "pickup_address", "pickup_name", "pickup_postcode", "pickup_place_id", "pickup_lat", "pickup_lng",
    "dropoff_address", "dropoff_name", "dropoff_postcode", "dropoff_place_id", "dropoff_lat", "dropoff_lng", "airport",
    "flight_number", "journey_type", "journey_date", "journey_time", "return_journey", "return_date", "return_time",
    "phone", "email", "passengers", "suitcases", "hand_luggage", "vehicle_type", "vehicle_tier", "notes",
  ];
  const output: Row = {};
  for (const key of allowed) output[key] = booking[key] ?? null;
  return { ...output, ...fixed };
}

function zonedDateTime(dateValue: unknown, timeValue: unknown, timezone: string) {
  const date = String(dateValue || "");
  const time = String(timeValue || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}(:\d{2})?$/.test(time)) throw new ApiError(400, "A valid journey date and time are required");
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute, second = 0] = time.split(":").map(Number);
  const target = Date.UTC(year, month - 1, day, hour, minute, second);
  let guess = target;
  for (let attempts = 0; attempts < 3; attempts += 1) {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date(guess));
    const values = Object.fromEntries(parts.map((part) => [part.type, Number(part.value)]));
    const represented = Date.UTC(values.year, values.month - 1, values.day, values.hour, values.minute, values.second);
    guess += target - represented;
  }
  const result = new Date(guess);
  if (Number.isNaN(result.getTime())) throw new ApiError(400, "Invalid journey date and time");
  return result;
}

function validTimeZone(value: unknown) {
  try { new Intl.DateTimeFormat("en", { timeZone: String(value || "") }); return Boolean(value); } catch { return false; }
}
function canonicalJourneyType(value: unknown) { return String(value || "").toLowerCase() === "airport" ? "airport" : "distance"; }
function canonicalStatus(value: unknown) {
  const status = String(value || "open").toLowerCase();
  return /closed|holiday|emergency/.test(status) ? "closed" : "open";
}
function normalPostcode(value: unknown) { return String(value || "").toUpperCase().replace(/\s+/g, ""); }
function bool(value: unknown) { return value === true || value === "true" || value === 1 || value === "1"; }
function integer(value: unknown) { const parsed = Number(value); return Number.isInteger(parsed) ? parsed : -1; }
function number(value: unknown, fallback = 0) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : fallback; }
function stripeSecretForCompany(companyCode: string) {
  const secret = companyCode === "0002"
    ? Deno.env.get("STRIPE_SECRET_KEY_0002")
    : companyCode === "0003"
    ? Deno.env.get("STRIPE_SECRET_KEY_0003")
    : null;
  return clean(secret);
}
function stripeCredentialMode(value: unknown, keyType: "pk" | "sk") {
  const key = String(value || "").trim();
  if (key.startsWith(`${keyType}_test_`)) return "test";
  if (key.startsWith(`${keyType}_live_`)) return "live";
  return null;
}
function enforceCompanyLifecycle(company: Row) {
  const status = String(company.company_status || "active").toLowerCase();
  if (["suspended", "cancelled"].includes(status)) {
    throw new ApiError(403, "Online booking is unavailable for this company");
  }
  if (status !== "trial") return;
  const expiresAt = Date.parse(String(company.trial_expires_at || ""));
  if (!Number.isFinite(expiresAt)) throw new ApiError(503, "This trial account is not configured correctly");
  if (Date.now() >= expiresAt) {
    throw new ApiError(403, "This trial has ended. Contact us to activate the full account");
  }
}
function routeApiKeyForCompany(companyCode: string, companyStatus: string) {
  const safeCode = /^\d{4}$/.test(companyCode) ? companyCode : "";
  const companySecret = safeCode ? Deno.env.get(`GOOGLE_ROUTES_API_KEY_${safeCode}`) : null;
  if (clean(companySecret)) return clean(companySecret);

  const mayUsePlatformFallback = companyStatus.toLowerCase() === "trial" || safeCode === "0001";
  return mayUsePlatformFallback ? clean(Deno.env.get("GOOGLE_ROUTES_API_KEY")) : null;
}

function clean(value: unknown) { return String(value ?? "").trim() || null; }
function numberOrNull(value: unknown) { const parsed = Number(value); return value === "" || value == null || !Number.isFinite(parsed) ? null : parsed; }
function round2(value: number) { return Math.round(value * 100) / 100; }
function floorHalf(value: number) { return Math.floor(value * 2) / 2; }
async function hash(value: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
