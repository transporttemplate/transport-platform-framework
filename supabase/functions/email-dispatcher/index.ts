import { adminClient, brandedEmail, deliverEmail, EmailDeliveryUncertainError, escapeHtml, formatCompanyLocalDateTime, json, render, textToHtml } from "../_shared/email.ts";

type Row = Record<string, any>;
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const dispatcherKey = Deno.env.get("EMAIL_DISPATCHER_SECRET") || "";
const automationEnabled = Deno.env.get("EMAIL_AUTOMATION_ENABLED") === "true";
const activationTime = Date.parse(Deno.env.get("EMAIL_AUTOMATION_NOT_BEFORE") || "");
const maxLatenessMinutes = boundedNumber(Deno.env.get("EMAIL_REMINDER_MAX_LATENESS_MINUTES"), 10, 5, 60);

Deno.serve(async request => {
  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
  const token = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") || "";
  const authorised = (dispatcherKey && equal(token, dispatcherKey)) || (serviceKey && equal(token, serviceKey));
  if (!authorised) return json({ ok: false, error: "Forbidden" }, 403);
  if (!automationEnabled || !Number.isFinite(activationTime)) return json({ ok: false, dispatch_enabled: false, error: "Email automation is disabled" }, 503);

  const db = adminClient();
  const run = await db.from("email_dispatch_runs").insert({ state: "running" }).select("id").single();
  if (run.error || !run.data) return json({ ok: false, error: "Email dispatcher monitoring is unavailable" }, 503);
  const runId = run.data.id;
  try {
    const scheduled = await scheduleDue(db);
    const quota = await providerUsage();
    if (!quota.ok) {
      await finishRun(db, runId, "failed", { scheduled_count: scheduled, error_code: "provider_usage_unavailable" });
      return json({ ok: false, scheduled, dispatch_enabled: false, error: "Provider usage could not be verified" }, 503);
    }
    const allowance = safeAllowance(quota.data);
    if (allowance.remaining < 1) {
      await finishRun(db, runId, "quota_paused", { scheduled_count: scheduled, error_code: allowance.reason });
      return json({ ok: true, scheduled, claimed: 0, dispatch_enabled: false, quota_warning: true });
    }
    const { data: messages, error } = await db.rpc("claim_due_email_messages", { batch_size: Math.min(50, allowance.remaining) });
    if (error) throw error;
    const results = [];
    for (const message of messages || []) results.push(await deliverQueued(db, message));
    const totals = countResults(results);
    await finishRun(db, runId, "succeeded", {
      scheduled_count: scheduled, claimed_count: messages?.length || 0,
      accepted_count: totals.accepted, retry_count: totals.retry_scheduled,
      failed_count: totals.failed, uncertain_count: totals.uncertain,
      metadata: { quota_daily_ratio: allowance.dailyRatio, quota_monthly_ratio: allowance.monthlyRatio },
    });
    return json({ ok: true, scheduled, claimed: messages?.length || 0, ...totals, quota_warning: allowance.warning });
  } catch (error) {
    console.error("email-dispatcher", error instanceof Error ? error.message : error);
    await finishRun(db, runId, "failed", { error_code: "dispatcher_failure" });
    return json({ ok: false, error: "Email dispatcher failed" }, 500);
  }
});

async function scheduleDue(db: any) {
  const [{ data: companies, error: companyError }, { data: settings, error: settingsError }] = await Promise.all([
    db.from("companies").select("id,company_status").eq("company_status", "active"),
    db.from("settings").select("company_id,timezone,emailnotifications,office_booking_reminder_emails,driver_booking_reminder_emails,unallocated_reminder_emails,unallocated_48h_emails,unallocated_24h_emails,driver_document_expiry_emails,office_notification_email,officeemail,companyemail"),
  ]);
  if (companyError || settingsError) throw companyError || settingsError;
  const active = new Set((companies || []).map((row: Row) => row.id));
  let count = 0;
  for (const config of settings || []) {
    if (!active.has(config.company_id) || config.emailnotifications === false) continue;
    const zone = validZone(config.timezone);
    const today = localDate(new Date(), zone), horizon = addDays(today, 3);
    const { data: bookings, error } = await db.from("bookings").select("id,company_id,journey_date,journey_time,driver_id,status,booking_status").eq("company_id", config.company_id).gte("journey_date", today).lte("journey_date", horizon);
    if (error) throw error;
    const office = firstEmail(config.office_notification_email, config.officeemail, config.companyemail);
    for (const booking of bookings || []) {
      const status = String(booking.status || booking.booking_status || "").toLowerCase();
      if (["completed", "cancelled", "canceled", "no_show"].includes(status)) continue;
      const journey = zonedDateTime(booking.journey_date, booking.journey_time, zone);
      const minutes = (journey.getTime() - Date.now()) / 60000;
      if (minutes <= 0) continue;
      const stamp = journey.toISOString();
      if (office && config.office_booking_reminder_emails && inWindow(minutes, 1440)) count += await queue(db, config.company_id, "office_booking_reminder", "office", office, "office_booking_reminder_24h", `booking:${booking.id}:office:24h:${stamp}:to:${office}`, { booking_id: booking.id, scheduled_for: new Date(journey.getTime() - 86400000).toISOString(), priority: 80 });
      if (booking.driver_id && config.driver_booking_reminder_emails && inWindow(minutes, 720)) {
        const { data: driver } = await db.from("drivers").select("id,email").eq("company_id", config.company_id).eq("id", booking.driver_id).maybeSingle();
        if (driver?.email) count += await queue(db, config.company_id, "driver_booking_reminder", "driver", driver.email, "driver_booking_reminder_12h", `booking:${booking.id}:driver:12h:${driver.id}:${stamp}`, { booking_id: booking.id, scheduled_for: new Date(journey.getTime() - 43200000).toISOString(), priority: 85 });
      }
      if (!booking.driver_id && office && config.unallocated_reminder_emails !== false) {
        if (config.unallocated_48h_emails !== false && inWindow(minutes, 2880)) count += await queue(db, config.company_id, "unassigned_48h", "office", office, "office_unallocated_48h", `booking:${booking.id}:unassigned:48h:${stamp}:to:${office}`, { booking_id: booking.id, scheduled_for: new Date(journey.getTime() - 172800000).toISOString(), priority: 90 });
        if (config.unallocated_24h_emails !== false && inWindow(minutes, 1440)) count += await queue(db, config.company_id, "unassigned_24h", "office", office, "office_unallocated_24h", `booking:${booking.id}:unassigned:24h:${stamp}:to:${office}`, { booking_id: booking.id, scheduled_for: new Date(journey.getTime() - 86400000).toISOString(), priority: 95 });
      }
    }
    if (office && config.driver_document_expiry_emails) {
      const target = addDays(today, 3);
      const { data: documents, error } = await db.from("driver_documents").select("id,company_id,driver_id,expiry_date,status").eq("company_id", config.company_id).eq("status", "active").eq("expiry_date", target);
      if (error) throw error;
      for (const document of documents || []) count += await queue(db, config.company_id, "driver_document_expiry", "office", office, "office_driver_document_expiry", `driver-document:${document.id}:expiry:3d:${document.expiry_date}:to:${office}`, { driver_document_id: document.id, scheduled_for: new Date().toISOString(), priority: 75 });
    }
  }
  return count;
}

async function queue(db: any, companyId: string, category: string, type: string, recipient: string, template: string, key: string, extra: Row) {
  const scheduledAt = Date.parse(extra.scheduled_for);
  if (!Number.isFinite(scheduledAt) || scheduledAt < activationTime) return 0;
  const { data, error } = await db.from("email_messages").upsert({ company_id: companyId, category, recipient_type: type, recipient: recipient.trim().toLowerCase(), template_key: template, idempotency_key: key, ...extra, next_attempt_at: extra.scheduled_for }, { onConflict: "company_id,idempotency_key", ignoreDuplicates: true }).select("id");
  if (error) throw error;
  return data?.length || 0;
}

async function deliverQueued(db: any, message: Row) {
  const attempt = message.attempt_count;
  const inserted = await db.from("email_attempts").upsert({ company_id: message.company_id, message_id: message.id, attempt_number: attempt, state: "started" }, { onConflict: "message_id,attempt_number", ignoreDuplicates: true });
  if (inserted.error) throw inserted.error;
  try {
    const payload = message.booking_id ? await bookingPayload(db, message) : await documentPayload(db, message);
    if (!payload) throw new PermanentError("Related record is no longer eligible");
    const providerId = await deliverEmail(message.recipient, payload.subject, payload.text, { html: payload.html, replyTo: payload.replyTo, senderEmail: payload.senderEmail, senderName: payload.senderName, idempotencyKey: `reminder/${message.id}` });
    await completeAttempt(db, message, attempt, "accepted", "accepted", providerId, null, null);
    return { id: message.id, status: "accepted" };
  } catch (error) {
    const text = String(error instanceof Error ? error.message : "Delivery failed").slice(0, 500);
    const permanent = error instanceof PermanentError || /invalid|suppression|not found|no longer eligible|invalid[_ ]idempotent/i.test(text);
    const ambiguous = error instanceof EmailDeliveryUncertainError;
    if (ambiguous) {
      await completeAttempt(db, message, attempt, "uncertain", "uncertain", null, text, null);
      return { id: message.id, status: "uncertain" };
    }
    const final = permanent || attempt >= 4;
    const delay = [0, 5, 30, 120][attempt] || 120;
    const next = new Date(Date.now() + delay * 60000).toISOString();
    await completeAttempt(db, message, attempt, permanent ? "permanent_failure" : "failed", "failed", null, text, final ? null : next);
    return { id: message.id, status: final ? "failed" : "retry_scheduled" };
  }
}

async function completeAttempt(db: any, message: Row, attempt: number, attemptState: string, messageState: string, providerId: string | null, error: string | null, next: string | null) {
  const result = await db.rpc("complete_email_attempt", { p_message_id: message.id, p_company_id: message.company_id, p_attempt_number: attempt, p_attempt_state: attemptState, p_message_state: messageState, p_provider_message_id: providerId, p_error_message: error, p_next_attempt_at: next });
  if (result.error) throw result.error;
}

async function bookingPayload(db: any, message: Row) {
  const [{ data: booking }, { data: settings }, { data: company }, { data: stops }] = await Promise.all([
    db.from("bookings").select("*").eq("company_id", message.company_id).eq("id", message.booking_id).maybeSingle(),
    db.from("settings").select("*").eq("company_id", message.company_id).maybeSingle(),
    db.from("companies").select("name,trading_name,company_status").eq("id", message.company_id).maybeSingle(),
    db.from("booking_stops").select("address_name,formatted_address,stop_order").eq("company_id", message.company_id).eq("booking_id", message.booking_id).order("stop_order"),
  ]);
  if (!booking || !settings || company?.company_status !== "active" || !reminderAllowed(settings, message.category)) return null;
  if (["completed", "cancelled", "canceled", "no_show"].includes(String(booking.status || booking.booking_status || "").toLowerCase())) return null;
  const journey = zonedDateTime(booking.journey_date, booking.journey_time, validZone(settings.timezone));
  if (journey.getTime() <= Date.now()) return null;
  if (message.category.startsWith("unassigned") && booking.driver_id) return null;
  let driver = null;
  if (booking.driver_id) driver = (await db.from("drivers").select("id,full_name,email").eq("company_id", message.company_id).eq("id", booking.driver_id).maybeSingle()).data;
  if (message.recipient_type === "driver" && (!driver || String(driver.email || "").toLowerCase() !== String(message.recipient).toLowerCase())) return null;
  if (message.recipient_type === "office" && firstEmail(settings.office_notification_email, settings.officeemail, settings.companyemail) !== String(message.recipient).toLowerCase()) return null;
  return compose(message, settings, bookingValues(booking, settings, company || {}, stops || [], driver), booking, stops || []);
}

async function documentPayload(db: any, message: Row) {
  const [{ data: document }, { data: settings }, { data: company }] = await Promise.all([
    db.from("driver_documents").select("id,driver_id,document_type,document_label,expiry_date,status").eq("company_id", message.company_id).eq("id", message.driver_document_id).maybeSingle(),
    db.from("settings").select("*").eq("company_id", message.company_id).maybeSingle(),
    db.from("companies").select("company_status").eq("id", message.company_id).maybeSingle(),
  ]);
  if (!document || document.status !== "active" || !settings || company?.company_status !== "active" || !reminderAllowed(settings, message.category)) return null;
  if (firstEmail(settings.office_notification_email, settings.officeemail, settings.companyemail) !== String(message.recipient).toLowerCase()) return null;
  if (document.expiry_date !== addDays(localDate(new Date(), validZone(settings.timezone)), 3)) return null;
  const { data: driver } = await db.from("drivers").select("full_name").eq("company_id", message.company_id).eq("id", document.driver_id).maybeSingle();
  return compose(message, settings, { company_name: settings.tradingname || settings.companyname || "Transport Company", driver_name: driver?.full_name || "Driver", document_type: document.document_type === "other" ? (document.document_label || "Other") : document.document_type.replaceAll("_", " "), document_expiry_date: document.expiry_date, days_remaining: 3 }, null, []);
}

function reminderAllowed(settings: Row, category: string) {
  if (settings.emailnotifications === false) return false;
  if (category === "office_booking_reminder") return settings.office_booking_reminder_emails === true;
  if (category === "driver_booking_reminder") return settings.driver_booking_reminder_emails === true;
  if (category === "unassigned_48h") return settings.unallocated_reminder_emails !== false && settings.unallocated_48h_emails !== false;
  if (category === "unassigned_24h") return settings.unallocated_reminder_emails !== false && settings.unallocated_24h_emails !== false;
  if (category === "driver_document_expiry") return settings.driver_document_expiry_emails === true;
  return false;
}

async function compose(message: Row, settings: Row, values: Row, booking: Row | null, stops: Row[]) {
  const { data: template } = await adminClient().from("email_templates").select("subject,body,active").eq("company_id", message.company_id).eq("template_key", message.template_key).maybeSingle();
  if (template?.active === false) throw new PermanentError("Template disabled");
  const defaults: Row = {
    office_booking_reminder_24h: ["UPCOMING BOOKING — {{booking_reference}} (24 hours)", "Booking {{booking_reference}} is due in approximately 24 hours.\n\nCustomer: {{customer_name}}\nPhone: {{customer_phone}}\n{{journey_summary}}\n\nDriver: {{driver_name}}\nNotes: {{notes}}"],
    driver_booking_reminder_12h: ["Job reminder — {{booking_reference}} (12 hours)", "Hello {{driver_name}},\n\n{{journey_summary}}\n\nDriver amount: {{driver_amount}}\nNotes: {{notes}}"],
    office_unallocated_48h: ["DRIVER NOT ALLOCATED — {{booking_reference}} (48 hours)", "Booking {{booking_reference}} is due within 48 hours and still has no driver.\n\n{{journey_summary}}"],
    office_unallocated_24h: ["URGENT: DRIVER NOT ALLOCATED — {{booking_reference}} (24 hours)", "Booking {{booking_reference}} is due within 24 hours and still has no driver.\n\n{{journey_summary}}"],
    office_driver_document_expiry: ["DRIVER DOCUMENT EXPIRY — {{driver_name}}", "Driver: {{driver_name}}\nDocument: {{document_type}}\nExpiry/recheck date: {{document_expiry_date}}\nDays remaining: {{days_remaining}}"],
  };
  const fallback = defaults[message.template_key] || [message.category, "Notification from {{company_name}}"];
  const safeValues = message.recipient_type === "driver" ? { ...values, price: "", amount_paid: "", balance_due: "", payment_method: "", payment_status: "", payment_summary: "" } : values;
  const subject = render(template?.subject || fallback[0], safeValues);
  const text = render(template?.body || fallback[1], safeValues).replace(/\n{3,}/g, "\n\n").trim();
  let details = "";
  if (booking) {
    const when = formatCompanyLocalDateTime(booking.journey_date, booking.journey_time, settings.timezone);
    details = `<div style="margin:20px 0"><strong>${escapeHtml(booking.booking_reference)}</strong><br>${escapeHtml(when.dateTime)}<br>${escapeHtml([booking.pickup_name, booking.pickup_address].filter(Boolean).join(", "))}<br>→ ${escapeHtml([booking.dropoff_name, booking.dropoff_address].filter(Boolean).join(", "))}</div>`;
  }
  return { subject, text, html: brandedEmail(settings, `<div>${textToHtml(text)}</div>${details}`), replyTo: firstEmail(settings.email_reply_to, settings.office_notification_email, settings.officeemail, settings.companyemail), senderEmail: firstEmail(settings.email_reply_to, settings.office_notification_email, settings.officeemail, settings.companyemail), senderName: settings.email_sender_name || settings.tradingname || settings.companyname };
}

function bookingValues(b: Row, s: Row, c: Row, stops: Row[], driver: Row | null) {
  const money = (v: any) => `${s.currencysymbol || "£"}${Number(v || 0).toFixed(2)}`;
  const when = formatCompanyLocalDateTime(b.journey_date, b.journey_time, s.timezone), pickup = [b.pickup_name, b.pickup_address].filter(Boolean).join(", "), dropoff = [b.dropoff_name, b.dropoff_address].filter(Boolean).join(", ");
  return { company_name: s.tradingname || c.trading_name || s.companyname || c.name || "Transport Company", booking_reference: b.booking_reference || b.id, journey_date: when.date, journey_time: when.time, journey_datetime: when.dateTime, pickup_address: pickup, dropoff_address: dropoff, journey_summary: `${when.dateTime}\n${[pickup, ...stops.map(x => [x.address_name, x.formatted_address].filter(Boolean).join(", ")), dropoff].join(" → ")}`, customer_name: b.customer_name || "Customer", customer_phone: b.customer_phone || b.phone || "—", driver_name: driver?.full_name || "Unassigned", driver_assignment_status: driver ? "Assigned" : "Unassigned", driver_amount: money(b.driver_amount == null ? (b.price ?? b.job_price) : b.driver_amount), notes: b.notes || "—" };
}

async function providerUsage() {
  const key = Deno.env.get("RESEND_USAGE_API_KEY") || Deno.env.get("EMAIL_PROVIDER_API_KEY");
  if (!key) return { ok: false };
  try { const response = await fetch("https://api.resend.com/usage", { headers: { Authorization: `Bearer ${key}` } }); return { ok: response.ok, data: await response.json() }; }
  catch { return { ok: false }; }
}

function safeAllowance(data: Row) {
  const daily = quotaWindow(data?.emails?.daily), monthly = quotaWindow(data?.emails?.monthly);
  if (!daily.known || !monthly.known) return { remaining: 0, warning: true, reason: "provider_limits_unavailable", dailyRatio: null, monthlyRatio: null };
  const remaining = Math.max(0, Math.floor(Math.min(daily.safeRemaining, monthly.safeRemaining)));
  return { remaining, warning: daily.ratio >= .9 || monthly.ratio >= .9, reason: remaining < 1 ? "provider_allowance_reached" : null, dailyRatio: daily.ratio, monthlyRatio: monthly.ratio };
}
function quotaWindow(value: Row) { const used = Number(value?.used), limit = Number(value?.limit); if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return { known: false, ratio: null, safeRemaining: 0 }; return { known: true, ratio: used / limit, safeRemaining: limit * .95 - used }; }
async function finishRun(db: any, id: string, state: string, values: Row) { const { error } = await db.from("email_dispatch_runs").update({ state, completed_at: new Date().toISOString(), ...values }).eq("id", id); if (error) console.error("email-dispatcher monitoring update failed", error.message); }
function countResults(results: Row[]) { return results.reduce((totals, item) => { if (item.status in totals) totals[item.status] += 1; return totals; }, { accepted: 0, retry_scheduled: 0, failed: 0, uncertain: 0 }); }
function inWindow(minutes: number, threshold: number) { return minutes <= threshold && minutes > threshold - maxLatenessMinutes; }
function firstEmail(...values: any[]) { return values.map(v => String(v || "").trim().toLowerCase()).find(v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) || null; }
function validZone(v: any) { try { new Intl.DateTimeFormat("en", { timeZone: String(v || "") }); return String(v); } catch { return "Europe/London"; } }
function localDate(d: Date, z: string) { const p = new Intl.DateTimeFormat("en-CA", { timeZone: z, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d), g = (t: string) => p.find(x => x.type === t)?.value; return `${g("year")}-${g("month")}-${g("day")}`; }
function addDays(d: string, n: number) { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
function zonedDateTime(date: string, time: string, zone: string) { const c = new Date(`${date}T${String(time || "00:00").slice(0, 8)}Z`), f = new Intl.DateTimeFormat("en-GB", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }), p = f.formatToParts(c), g = (t: string) => Number(p.find(x => x.type === t)?.value), represented = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second")); return new Date(c.getTime() + (c.getTime() - represented)); }
function equal(a: string, b: string) { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }
function boundedNumber(value: unknown, fallback: number, min: number, max: number) { const number = Number(value); return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback; }
class PermanentError extends Error {}
