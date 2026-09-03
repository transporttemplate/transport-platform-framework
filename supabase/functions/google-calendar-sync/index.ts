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

Deno.serve(async request => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  let companyId = "";
  let bookingId = "";

  try {
    const body = await request.json();
    companyId = String(body.company_id || "");
    bookingId = String(body.booking_id || "");

    if (!companyId || !bookingId) {
      return json({ ok: false, stage: "request", error: "company_id and booking_id are required" }, 400);
    }

    console.log("Google Calendar sync started", { company_id: companyId, booking_id: bookingId });

    const [bookingResult, settingsResult, stopsResult] = await Promise.all([
      db.from("bookings").select("*").eq("company_id", companyId).eq("id", bookingId).maybeSingle(),
      db.from("settings").select("googlecalendarid,timezone").eq("company_id", companyId).maybeSingle(),
      db.from("booking_stops").select("stop_order,formatted_address").eq("company_id", companyId).eq("booking_id", bookingId).order("stop_order")
    ]);

    if (bookingResult.error) throw stageError("booking_lookup", bookingResult.error.message);
    if (settingsResult.error) throw stageError("settings_lookup", settingsResult.error.message);
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
    const cancelled = ["cancelled", "canceled"].includes(normaliseStatus(booking.status || booking.booking_status));

    if (cancelled) {
      if (!booking.google_calendar_event_id) {
        await saveSyncSuccess(companyId, bookingId, null);
        return json({ ok: true, action: "cancel", skipped: true, reason: "Booking has no linked Google event" });
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

    const event = buildEvent(booking, stopsResult.data || [], settings?.timezone || "Europe/London");
    let googleEvent;
    let action;

    if (booking.google_calendar_event_id) {
      const updateResponse = await googleRequest(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(booking.google_calendar_event_id)}`,
        accessToken,
        { method: "PATCH", body: JSON.stringify(event) },
        "event_update"
      );

      if (updateResponse.status === 404) {
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

function buildEvent(booking: Record<string, unknown>, stops: Array<Record<string, unknown>>, timezone: string) {
  const start = `${booking.journey_date}T${String(booking.journey_time).slice(0, 5)}:00`;
  const durationMinutes = Math.max(1, Number(booking.route_duration_minutes) || 60);
  const endDate = new Date(`${start}Z`);
  endDate.setUTCMinutes(endDate.getUTCMinutes() + durationMinutes);
  const end = endDate.toISOString().slice(0, 19);
  const route = [
    booking.pickup_address,
    ...stops.map(stop => stop.formatted_address),
    booking.dropoff_address
  ].filter(Boolean).join(" → ");

  return {
    summary: `${booking.booking_reference || "Booking"} — ${booking.customer_name || booking.full_name || "Customer"}`,
    location: booking.pickup_address || "",
    description: [
      `Route: ${route}`,
      `Status: ${booking.status || booking.booking_status || ""}`,
      `Passengers: ${booking.passengers ?? ""}`,
      `Phone: ${booking.customer_phone || booking.phone || ""}`,
      booking.flight_number ? `Flight: ${booking.flight_number}` : "",
      booking.notes ? `Notes: ${booking.notes}` : ""
    ].filter(Boolean).join("\n"),
    start: { dateTime: start, timeZone: timezone },
    end: { dateTime: end, timeZone: timezone },
    extendedProperties: { private: { company_id: String(booking.company_id), booking_id: String(booking.id) } }
  };
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
