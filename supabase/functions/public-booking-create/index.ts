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
      .select("id,company_code")
      .eq("company_code", companyCode)
      .maybeSingle();
    if (companyError) throw companyError;
    if (!company) throw new ApiError(404, "Company not found");
    const companyId = String(company.id);

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
        "returnbookings", "multiplestops", "allowcash", "enablecash", "allowcard", "enablestripe",
        "airportpricing", "distancecalculator", "allowairportoutsidearea", "minimumfare", "firstmile",
        "mileband1", "mileband2", "mileband3", "mileband4", "mileband5", "mileband6", "bookingfee",
        "returndiscount", "googleroutesapi",
      ].join(",")).eq("company_id", companyId).maybeSingle(),
      db.from("service_areas").select("id,company_id,postcode_prefix,radius_miles,active")
        .eq("company_id", companyId).eq("active", true),
    ]);
    if (settingsError) throw settingsError;
    if (areasError) throw areasError;
    if (!settings) throw new ApiError(503, "Company booking settings are unavailable");

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

    let airport: Row | null = null;
    if (mode === "airport") {
      const airportName = clean(booking.airport);
      if (!airportName) throw new ApiError(400, "A valid airport is required");
      let { data, error } = await db.from("airports")
        .select("id,company_id,name,code,active,price_1_4_oneway,price_1_4_return,price_5_7_oneway,price_5_7_return")
        .eq("company_id", companyId).eq("active", true).eq("name", airportName)
        .maybeSingle();
      if (error) throw error;
      if (!data) {
        const byCode = await db.from("airports")
          .select("id,company_id,name,code,active,price_1_4_oneway,price_1_4_return,price_5_7_oneway,price_5_7_return")
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

    const routeKey = clean(Deno.env.get("GOOGLE_ROUTES_API_KEY")) || clean(settings.googleroutesapi);
    if (!routeKey) throw new ApiError(503, "Online route verification is not configured");
    const route = await authoritativeRoute(booking, stops, airport, routeKey);

    if (mode === "airport" && !bool(settings.allowairportoutsidearea)) {
      enforceAirportServiceArea(booking, airport!, areas || [], route);
    }

    const pricing = calculatePrice({ settings, airport, mode, passengers: integer(booking.passengers), miles: route.miles, isReturn });
    const prices = splitPrice(pricing.total, isReturn);

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
      payment_status: "unpaid",
      price: prices.outbound,
      route_distance_miles: route.miles,
      route_duration_minutes: route.minutes,
      pricing_method: pricing.method,
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
        journey_type: "return",
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

    return respond({
      ok: true,
      customer_id: customerId,
      reference,
      bookings: inserted.data,
      authoritative_price: pricing.total,
      pricing_method: pricing.method,
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
  if (passengers < 1 || passengers > 7) throw new ApiError(400, "Passengers must be between 1 and 7");
  const vehicle = String(booking.vehicle_type || "").toLowerCase();
  if (!['car', 'mpv'].includes(vehicle)) throw new ApiError(400, "A valid vehicle type is required");
  if (passengers > 4 && vehicle !== "mpv") throw new ApiError(400, "An MPV is required for more than four passengers");
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
  if (["account", "invoice", "on account"].includes(method)) throw new ApiError(400, "Account payment is not available for public bookings");
  if (["pay now", "card", "card / prepaid", "prepaid", "paid"].includes(method)) {
    if (!bool(settings.allowcard) && !bool(settings.enablestripe)) throw new ApiError(400, "Card payment is not enabled");
    throw new ApiError(503, "Card payment is not available online yet. Please choose Pay in Car or contact us.");
  }
  if (!["pay in car", "cash", "pay by cash"].includes(method)) throw new ApiError(400, "Invalid payment method");
  if (!bool(settings.allowcash) && !bool(settings.enablecash)) throw new ApiError(400, "Cash payment is not enabled");
  return "Pay in Car";
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

function calculatePrice(input: { settings: Row; airport: Row | null; mode: string; passengers: number; miles: number; isReturn: boolean }) {
  const { settings, airport, mode, passengers, miles, isReturn } = input;
  const uplift = passengers >= 5 ? Math.max(0, number(settings.bookingfee)) : 0;
  if (mode === "airport") {
    const size = passengers >= 5 ? "5_7" : "1_4";
    const trip = isReturn ? "return" : "oneway";
    const configured = number(airport?.[`price_${size}_${trip}`], NaN);
    if (!Number.isFinite(configured) || configured <= 0) throw new ApiError(400, "No fixed price is configured for this airport journey");
    return { total: round2(configured * (1 + uplift / 100)), method: "Airport fixed price" };
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
  total *= 1 + uplift / 100;
  total = Math.max(Math.max(0, number(settings.minimumfare)), total);
  if (isReturn) total *= 2 * (1 - Math.min(100, Math.max(0, number(settings.returndiscount))) / 100);
  return { total: floorHalf(total), method: "Distance price" };
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
    "phone", "email", "passengers", "suitcases", "hand_luggage", "vehicle_type", "notes",
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
function clean(value: unknown) { return String(value ?? "").trim() || null; }
function numberOrNull(value: unknown) { const parsed = Number(value); return value === "" || value == null || !Number.isFinite(parsed) ? null : parsed; }
function round2(value: number) { return Math.round(value * 100) / 100; }
function floorHalf(value: number) { return Math.floor(value * 2) / 2; }
async function hash(value: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
