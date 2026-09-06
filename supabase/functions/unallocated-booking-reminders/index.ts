import { adminClient, cors, json } from "../_shared/email.ts";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const token = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") || "";
  if (!serviceKey || !constantTimeEqual(token, serviceKey)) return json({ ok: false, error: "Forbidden" }, 403);

  try {
    const db = adminClient();
    const { data: settingsRows, error: settingsError } = await db.from("settings")
      .select("company_id,timezone,emailnotifications,unallocated_reminder_emails,unallocated_reminder_minutes")
      .eq("unallocated_reminder_emails", true);
    if (settingsError) throw settingsError;
    const base = Deno.env.get("SUPABASE_URL") || "";
    const results: Array<Record<string, unknown>> = [];

    for (const settings of settingsRows || []) {
      if (settings.emailnotifications === false) continue;
      const thresholds = normalThresholds(settings.unallocated_reminder_minutes);
      const today = localDate(new Date(), settings.timezone || "Europe/London");
      const horizon = addDays(today, Math.ceil(Math.max(...thresholds) / 1440) + 1);
      const { data: bookings, error } = await db.from("bookings")
        .select("id,company_id,journey_date,journey_time,driver_id,status")
        .eq("company_id", settings.company_id)
        .is("driver_id", null)
        .gte("journey_date", today)
        .lte("journey_date", horizon);
      if (error) throw error;
      for (const booking of bookings || []) {
        if (["cancelled", "canceled", "completed"].includes(String(booking.status || "").toLowerCase())) continue;
        const journey = zonedDateTime(booking.journey_date, booking.journey_time, settings.timezone || "Europe/London");
        const minutesUntil = (journey.getTime() - Date.now()) / 60000;
        if (minutesUntil <= 0) continue;
        for (const threshold of thresholds) {
          if (minutesUntil > threshold) continue;
          const response = await fetch(`${base}/functions/v1/send-booking-email`, {
            method: "POST",
            headers: { "Content-Type": "application/json", apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
            body: JSON.stringify({ company_id: settings.company_id, booking_id: booking.id, event: "unallocated_reminder", threshold_minutes: threshold, event_id: `unallocated:${threshold}` }),
          });
          results.push({ company_id: settings.company_id, booking_id: booking.id, threshold, status: response.status });
        }
      }
    }
    return json({ ok: true, checked_companies: settingsRows?.length || 0, reminders: results });
  } catch (error) {
    console.error("unallocated-booking-reminders", error instanceof Error ? error.message : error);
    return json({ ok: false, error: "Reminder processing failed" }, 500);
  }
});

function normalThresholds(value: unknown) {
  const values = Array.isArray(value) ? value : [2880, 1440];
  return [...new Set(values.map(Number).filter(item => Number.isInteger(item) && item > 0 && item <= 10080))].sort((a, b) => b - a);
}
function localDate(date: Date, timezone: string) { const parts = new Intl.DateTimeFormat("en-CA", { timeZone: validZone(timezone), year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date); const get = (type: string) => parts.find(part => part.type === type)?.value; return `${get("year")}-${get("month")}-${get("day")}`; }
function addDays(date: string, days: number) { const value = new Date(`${date}T12:00:00Z`); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10); }
function zonedDateTime(date: string, time: string, timezone: string) { const candidate = new Date(`${date}T${String(time || "00:00").slice(0, 8)}Z`); const formatter = new Intl.DateTimeFormat("en-GB", { timeZone: validZone(timezone), year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }); const parts = formatter.formatToParts(candidate); const get = (type: string) => Number(parts.find(part => part.type === type)?.value); const represented = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")); return new Date(candidate.getTime() + (candidate.getTime() - represented)); }
function validZone(value: string) { try { new Intl.DateTimeFormat("en", { timeZone: value }); return value; } catch { return "Europe/London"; } }
function constantTimeEqual(a: string, b: string) { if (a.length !== b.length) return false; let result = 0; for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i); return result === 0; }
