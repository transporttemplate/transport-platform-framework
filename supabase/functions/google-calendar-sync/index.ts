import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json"
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: corsHeaders });

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);
const adminRoles = new Set(["admin", "owner"]);

Deno.serve(async request => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  let companyId = "";
  let bookingId = "";
  let verifyOnly = false;
  let existingOnly = false;
  let permanentDeletionCleanup = false;

  try {
    const body = await request.json();
    companyId = String(body.company_id || "");
    bookingId = String(body.booking_id || "");
    verifyOnly = body.verify_only === true;
    existingOnly = body.existing_only === true;
    permanentDeletionCleanup = body.permanent_deletion_cleanup === true;

    if (!companyId || !bookingId) {
      return json({ ok: false, stage: "request", error: "company_id and booking_id are required" }, 400);
    }

    if (!await authorisedForCompany(request, companyId)) {
      return json({ ok: false, stage: "authorization", error: "Admin company access required" }, 403);
    }
    if (permanentDeletionCleanup && !await authorisedForPermanentDeletion(request, companyId)) {
      return json({ ok: false, stage: "authorization", error: "Explicit permanent deletion permission is required" }, 403);
    }

    console.log("Google Calendar sync started", { company_id: companyId, booking_id: bookingId });

    const [bookingResult, settingsResult, stopsResult, companyResult] = await Promise.all([
      db.from("bookings").select("*").eq("company_id", companyId).eq("id", bookingId).maybeSingle(),
      db.from("settings").select("googlecalendarid,timezone").eq("company_id", companyId).maybeSingle(),
      db.from("booking_stops").select("stop_order,address_name,formatted_address").eq("company_id", companyId).eq("booking_id", bookingId).order("stop_order"),
      db.from("companies").select("company_code").eq("id", companyId).maybeSingle()
    ]);

    if (bookingResult.error) throw stageError("booking_lookup", bookingResult.error.message);
    if (settingsResult.error) throw stageError("settings_lookup", settingsResult.error.message);
    if (companyResult.error) throw stageError("company_lookup", companyResult.error.message);
    if (stopsResult.error) console.warn("Google Calendar stops lookup failed", { company_id: companyId, booking_id: bookingId, error: stopsResult.error.message });

    const booking = bookingResult.data;
    const settings = settingsResult.data;
    if (!booking) return json({ ok: false, stage: "booking_lookup", error: "Booking not found for this company" }, 404);

    const calendarId = String(settings?.googlecalendarid || "").trim();
    if (!calendarId) {
      await saveSyncError(companyId, bookingId, "No settings.googlecalendarid is configured for this company.");
      return json({ ok: false, stage: "calendar_settings", error: "No Google Calendar ID is configured for this company" }, 400);
    }

    console.log("Google Calendar configuration found", { company_id: companyId, booking_id: bookingId, calendar_id: calendarId });

    const accessToken = await getGoogleAccessToken();
    const linkedEvent = booking.google_calendar_event_id
      ? await getLinkedGoogleEvent(calendarId, String(booking.google_calendar_event_id), accessToken, companyId, bookingId, String(booking.booking_reference || ""))
      : null;
    if (verifyOnly) {
      return json({
        ok: true,
        action: "verified",
        linked: Boolean(linkedEvent),
        event_id: linkedEvent?.id || null,
        calendar_id: calendarId,
        reason: booking.google_calendar_event_id ? undefined : "Booking has no linked Google event"
      });
    }
    const cancelled = ["cancelled", "canceled"].includes(normaliseStatus(booking.status || booking.booking_status));

    if (cancelled || permanentDeletionCleanup) {
      if (!booking.google_calendar_event_id) {
        await saveSyncSuccess(companyId, bookingId, null);
        return json({ ok: true, action: "cancel", skipped: true, reason: "Booking has no linked Google event" });
      }

      if (!linkedEvent) {
        await saveSyncSuccess(companyId, bookingId, null);
        return json({ ok: true, action: "cancel", skipped: true, reason: "Linked Google event no longer exists" });
      }
      const deleteResponse = await googleRequest(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(booking.google_calendar_event_id)}`,
        accessToken,
        { method: "DELETE" },
        "event_delete"
      );

      if (deleteResponse.status !== 204 && deleteResponse.status !== 404) {
        throw await googleResponseError("event_delete", deleteResponse, calendarId);
      }

      await saveSyncSuccess(companyId, bookingId, null);
      console.log("Google Calendar event removed", { company_id: companyId, booking_id: bookingId, calendar_id: calendarId });
      return json({ ok: true, action: "cancel", google_status: deleteResponse.status });
    }

    if (!booking.journey_date || !booking.journey_time) {
      throw stageError("event_build", "Booking journey date and time are required");
    }

    if (existingOnly && (!booking.google_calendar_event_id || !linkedEvent)) {
      return json({ ok: true, action: "update", skipped: true, reason: "No identity-verified linked Google event" });
    }

    const driver = booking.driver_id
      ? (await db.from("drivers").select("full_name,driver_number").eq("company_id", companyId).eq("id", booking.driver_id).maybeSingle()).data
      : null;
    const event = buildEvent(
      booking,
      stopsResult.data || [],
      driver,
      settings?.timezone || "Europe/London",
      String(companyResult.data?.company_code || "") === "0003"
    );
    let googleEvent;
    let action;

    if (booking.google_calendar_event_id && linkedEvent) {
      const updateResponse = await googleRequest(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(booking.google_calendar_event_id)}`,
        accessToken,
        { method: "PATCH", body: JSON.stringify(event) },
        "event_update"
      );

      if (updateResponse.status === 404) {
        if (existingOnly) {
          return json({ ok: true, action: "update", skipped: true, reason: "Linked Google event disappeared before update" });
        }
        googleEvent = await createGoogleEvent(calendarId, accessToken, event);
        action = "recreated";
      } else {
        if (!updateResponse.ok) throw await googleResponseError("event_update", updateResponse, calendarId);
        googleEvent = await updateResponse.json();
        action = "updated";
      }
    } else {
      googleEvent = await createGoogleEvent(calendarId, accessToken, event);
      action = "created";
    }

    await saveSyncSuccess(companyId, bookingId, googleEvent.id);
    console.log("Google Calendar sync completed", { company_id: companyId, booking_id: bookingId, calendar_id: calendarId, event_id: googleEvent.id, action });

    return json({ ok: true, action, event_id: googleEvent.id, calendar_id: calendarId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stage = typeof error === "object" && error && "stage" in error ? String(error.stage) : "unknown";
    console.error("Google Calendar sync failed", { company_id: companyId, booking_id: bookingId, stage, error: message });
    if (companyId && bookingId) await saveSyncError(companyId, bookingId, `${stage}: ${message}`);
    return json({ ok: false, stage, error: message }, 500);
  }
});

async function authorisedForCompany(request: Request, companyId: string) {
  const token = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") || "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (token && serviceKey && constantTimeEqual(token, serviceKey)) return true;
  if (!token) return false;

  const userDb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: `Bearer ${token}` } } }
  );
  const { data: { user }, error: userError } = await userDb.auth.getUser();
  if (userError || !user) return false;
  const { data: membership, error: membershipError } = await db.from("company_users")
    .select("role")
    .eq("user_id", user.id)
    .eq("company_id", companyId)
    .maybeSingle();
  return !membershipError && adminRoles.has(String(membership?.role || "").trim().toLowerCase());
}

async function authorisedForPermanentDeletion(request: Request, companyId: string) {
  const token = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") || "";
  if (!token) return false;
  const userDb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: `Bearer ${token}` } } });
  const { data: { user }, error } = await userDb.auth.getUser();
  if (error || !user) return false;
  const membership = await db.from("company_users").select("role,can_permanently_delete_bookings").eq("company_id", companyId).eq("user_id", user.id).maybeSingle();
  return !membership.error && adminRoles.has(String(membership.data?.role || "").toLowerCase()) && membership.data?.can_permanently_delete_bookings === true;
}

function constantTimeEqual(left: string, right: string) {
  if (left.length !== right.length || !left.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function buildEvent(booking: Record<string, unknown>, stops: Array<Record<string, unknown>>, driver: Record<string, unknown> | null, timezone: string, jeffReminder: boolean) {
  const start = `${booking.journey_date}T${String(booking.journey_time).slice(0, 5)}:00`;
  const durationMinutes = Math.max(1, Number(booking.route_duration_minutes) || 60);
  const endDate = new Date(`${start}Z`);
  endDate.setUTCMinutes(endDate.getUTCMinutes() + durationMinutes);
  const end = endDate.toISOString().slice(0, 19);
  const pickupTitle = conciseLocation(booking.pickup_name, booking.pickup_address);
  const dropoffTitle = conciseLocation(booking.dropoff_name, booking.dropoff_address);
  const pickupAddress = locationDetail(booking, "pickup");
  const dropoffAddress = locationDetail(booking, "dropoff");
  const notes = calendarSafeNotes(booking.notes);
  const paymentMethod = displayValue(booking.payment_method || booking.payment_type);
  const fare = money(booking.journey_fare ?? booking.price);
  const paid = money(booking.amount_paid);
  const balance = money(booking.balance_due);
  const contact = [booking.customer_phone || booking.phone, booking.customer_email || booking.email].filter(Boolean).join(" · ");

  return {
    summary: `${pickupTitle} → ${dropoffTitle}`,
    location: booking.pickup_address || "",
    description: [
      `Booking: ${booking.booking_reference || ""}`,
      `Customer: ${booking.customer_name || booking.full_name || ""}`,
      contact ? `Contact: ${contact}` : "",
      `Pickup time: ${formatLocalDateTime(booking.journey_date, booking.journey_time, timezone)}`,
      `Pickup: ${pickupAddress}`,
      `Destination: ${dropoffAddress}`,
      ...stops.map((stop, index) => `Stop ${index + 1}: ${locationText(stop.address_name, stop.formatted_address)}`),
      `Passengers: ${booking.passengers ?? 0}`,
      `Luggage: ${booking.suitcases ?? 0} suitcases · ${booking.hand_luggage ?? booking.luggage ?? 0} hand luggage`,
      booking.flight_number ? `Flight: ${booking.flight_number}` : "",
      driver ? `Driver: ${driver.driver_number ? `${driver.driver_number} — ` : ""}${driver.full_name || "Assigned"}` : "Driver: Unassigned",
      `Status: ${displayValue(booking.status || booking.booking_status)}`,
      paymentMethod ? `Payment method: ${paymentMethod}` : "",
      fare ? `Journey fare: ${fare}` : "",
      paid ? `Amount paid: ${paid}` : "",
      balance ? `Outstanding balance: ${balance}` : "",
      notes ? `Notes: ${notes}` : ""
    ].filter(Boolean).join("\n"),
    start: { dateTime: start, timeZone: timezone },
    end: { dateTime: end, timeZone: timezone },
    ...(jeffReminder ? { reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 720 }] } } : {}),
    extendedProperties: { private: { company_id: String(booking.company_id), booking_id: String(booking.id) } }
  };
}

function conciseLocation(name: unknown, address: unknown) {
  const preferred = String(name || "").trim();
  const full = String(address || "").trim();
  const combined = `${preferred} ${full}`;
  const airport = conciseAirport(combined);
  if (airport) return airport;
  const locality = addressLocality(full);
  const recognisableBusiness = preferred && /\b(airport|station|hotel|hospital|school|university|centre|center|arena|stadium|hall|inn|restaurant|pub|club)\b/i.test(preferred);
  const value = recognisableBusiness ? preferred : locality || preferred || full.split(",")[0].trim() || "Location";
  return value.length > 42 ? `${value.slice(0, 39).trim()}…` : titleCase(value);
}

function conciseAirport(value: string) {
  const text = value.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
  const lhrPair = text.match(/\b(?:LHR|(?:London\s+)?Heathrow)(?:\s+Airport)?\s+Terminals?\s*([1-5])\s*(?:&|and|\/)\s*([1-5])/i);
  if (lhrPair) return `Heathrow T${lhrPair[1]}/${lhrPair[2]}`;
  const lhr = text.match(/\bLHR(?:\s*[-,]?\s*(?:Terminal|T)\s*([1-5]))?/i);
  if (lhr) return `Heathrow${lhr[1] ? ` T${lhr[1]}` : " Airport"}`;
  const heathrow = text.match(/\b(?:London\s+)?Heathrow(?:\s+Airport)?(?:\s*[-,]?\s*(?:Terminal|T)\s*([1-5]))?/i);
  if (heathrow) return `Heathrow${heathrow[1] ? ` T${heathrow[1]}` : " Airport"}`;
  const gatwick = text.match(/\b(?:London\s+)?Gatwick(?:\s+Airport)?(?:\s*[-,]?\s*(North|South)(?:\s+Terminal)?|\s+Terminal\s+(North|South))?/i);
  if (gatwick) return `Gatwick${gatwick[1] || gatwick[2] ? ` ${titleCase(gatwick[1] || gatwick[2])}` : " Airport"}`;
  const named = text.match(/\b([A-Za-z][A-Za-z' -]{1,30}?)\s+Airport\b/i);
  return named ? `${titleCase(named[1].trim())} Airport` : "";
}

function addressLocality(address: string) {
  const withoutCountry = address.replace(/,?\s*(?:United Kingdom|UK)\s*$/i, "").trim();
  const pieces = withoutCountry.split(",").map(value => value.trim()).filter(Boolean);
  if (!pieces.length) return "";
  return pieces[pieces.length - 1]
    .replace(/\b(?:GIR ?0AA|[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/ig, "")
    .trim();
}

function titleCase(value: string) {
  return value.replace(/\b\w/g, letter => letter.toUpperCase());
}

function locationText(name: unknown, address: unknown) {
  const preferred = String(name || "").trim();
  const full = String(address || "").trim();
  if (!preferred) return full;
  if (!full || full.toLowerCase().includes(preferred.toLowerCase())) return full || preferred;
  return `${preferred} — ${full}`;
}

function locationDetail(booking: Record<string, unknown>, prefix: "pickup" | "dropoff") {
  const base = locationText(booking[`${prefix}_name`], booking[`${prefix}_address`]);
  const property = [booking[`${prefix}_building_name`], booking[`${prefix}_address_line1`], booking[`${prefix}_address_line2`]]
    .map(value => String(value || "").trim()).filter(value => value && !base.toLowerCase().includes(value.toLowerCase()));
  return [base, ...property].filter(Boolean).join(" · ");
}

function calendarSafeNotes(value: unknown) {
  const notes = String(value || "").trim();
  if (!notes || /(^|\b)(internal|private|office[ -]?only)(\b|:)/i.test(notes)) return "";
  return notes;
}

function displayValue(value: unknown) {
  return String(value || "").trim().replaceAll("_", " ").replace(/\b\w/g, letter => letter.toUpperCase());
}

function money(value: unknown) {
  if (value === null || value === undefined || value === "") return "";
  const amount = Number(value);
  return Number.isFinite(amount) ? `£${amount.toFixed(2)}` : "";
}

function formatLocalDateTime(date: unknown, time: unknown, timezone: string) {
  const rawDate = String(date || "");
  const rawTime = String(time || "").slice(0, 5);
  const [year, month, day] = rawDate.split("-").map(Number);
  if (!year || !month || !day || !rawTime) return `${rawDate} ${rawTime}`.trim();
  const midday = new Date(Date.UTC(year, month - 1, day, 12));
  const dateLabel = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "2-digit", month: "short", year: "numeric", timeZone: timezone }).format(midday);
  return `${dateLabel} at ${rawTime} (${timezone})`;
}

async function getLinkedGoogleEvent(calendarId: string, eventId: string, accessToken: string, companyId: string, bookingId: string, bookingReference: string) {
  const response = await googleRequest(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    accessToken,
    { method: "GET" },
    "event_identity"
  );
  if (response.status === 404) return null;
  if (!response.ok) throw await googleResponseError("event_identity", response, calendarId);
  const event = await response.json();
  const privateProperties = event?.extendedProperties?.private || {};
  if (String(privateProperties.company_id || "") !== companyId || String(privateProperties.booking_id || "") !== bookingId) {
    throw stageError("event_identity", "Stored Google event is not owned by this Transport booking");
  }
  const searchable = `${event.summary || ""}\n${event.description || ""}`;
  if (!bookingReference || !searchable.includes(bookingReference)) {
    throw stageError("event_identity", "Stored Google event does not match this booking reference");
  }
  return event;
}

async function createGoogleEvent(calendarId: string, accessToken: string, event: Record<string, unknown>) {
  const response = await googleRequest(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
    accessToken,
    { method: "POST", body: JSON.stringify(event) },
    "event_create"
  );
  if (!response.ok) throw await googleResponseError("event_create", response, calendarId);
  return await response.json();
}

async function googleRequest(url: string, accessToken: string, init: RequestInit, stage: string) {
  console.log("Google Calendar API request", { stage, method: init.method, url: url.replace(/\/events\/[^/?]+$/, "/events/[event-id]") });
  return await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", ...(init.headers || {}) }
  });
}

async function googleResponseError(stage: string, response: Response, calendarId: string) {
  const responseText = (await response.text()).slice(0, 2000);
  return stageError(stage, `Google Calendar API returned ${response.status} for calendar ${calendarId}: ${responseText}`);
}

async function getGoogleAccessToken() {
  const email = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_EMAIL");
  const privateKey = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY")?.replaceAll("\\n", "\n");
  if (!email || !privateKey) throw stageError("google_credentials", "GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY must be configured");

  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64Url(JSON.stringify({
    iss: email,
    scope: "https://www.googleapis.com/auth/calendar.events",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600
  }));
  const unsignedToken = `${header}.${claims}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemBytes(privateKey),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsignedToken));
  const assertion = `${unsignedToken}.${base64UrlBytes(new Uint8Array(signature))}`;
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion })
  });
  const result = await response.json();
  if (!response.ok || !result.access_token) throw stageError("google_token", `Google OAuth returned ${response.status}: ${JSON.stringify(result).slice(0, 2000)}`);
  return result.access_token;
}

function pemBytes(pem: string) {
  const base64 = pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
  return Uint8Array.from(atob(base64), character => character.charCodeAt(0));
}

function base64Url(value: string) {
  return base64UrlBytes(new TextEncoder().encode(value));
}

function base64UrlBytes(value: Uint8Array) {
  let binary = "";
  value.forEach(byte => binary += String.fromCharCode(byte));
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function normaliseStatus(value: unknown) {
  return String(value || "").trim().toLowerCase();
}

function stageError(stage: string, message: string) {
  const error = new Error(message) as Error & { stage: string };
  error.stage = stage;
  return error;
}

async function saveSyncSuccess(companyId: string, bookingId: string, eventId: string | null) {
  const { error } = await db.from("bookings").update({
    google_calendar_event_id: eventId,
    google_calendar_synced_at: new Date().toISOString(),
    google_calendar_sync_error: null
  }).eq("company_id", companyId).eq("id", bookingId);
  if (error) throw stageError("sync_status_save", error.message);
}

async function saveSyncError(companyId: string, bookingId: string, message: string) {
  const { error } = await db.from("bookings").update({
    google_calendar_sync_error: message.slice(0, 2000)
  }).eq("company_id", companyId).eq("id", bookingId);
  if (error) console.error("Could not save Google Calendar sync error", { company_id: companyId, booking_id: bookingId, error: error.message });
}
