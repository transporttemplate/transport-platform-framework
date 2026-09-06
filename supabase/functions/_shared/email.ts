import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Content-Type": "application/json" };
export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: cors });
export const adminClient = () => createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

export async function requireCompanyAdmin(req: Request, companyId: string) {
  const token = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (!token) return false;
  const db = adminClient();
  const { data: user } = await db.auth.getUser(token);
  if (!user.user) return false;
  const { data } = await db.from("company_users").select("company_id").eq("user_id", user.user.id).eq("company_id", companyId).maybeSingle();
  return Boolean(data);
}

export async function requireInternalOrCompanyAdmin(req: Request, companyId: string) {
  const token = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") || "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (token && serviceKey && constantTimeEqual(token, serviceKey)) return true;
  return requireCompanyAdmin(req, companyId);
}

export function render(template: string, values: Record<string, unknown>) {
  return Object.entries(values).reduce((text, [key, value]) => text.replaceAll(`{{${key}}}`, String(value ?? "")), template);
}

export function formatCompanyLocalDateTime(dateValue: unknown, timeValue: unknown, timezoneValue: unknown) {
  const date = String(dateValue || "").trim();
  const time = String(timeValue || "").trim();
  const shortTime = /^\d{2}:\d{2}/.test(time) ? time.slice(0, 5) : time;
  const fallback = { date, time: shortTime, dateTime: [date, shortTime].filter(Boolean).join(" at ") };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}(:\d{2})?$/.test(time)) return fallback;

  const timezone = validTimeZone(timezoneValue) ? String(timezoneValue) : "Europe/London";
  const instant = companyLocalInstant(date, time, timezone);
  if (!instant) return fallback;
  const dateFormatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone, weekday: "long", day: "numeric", month: "long", year: "numeric",
  });
  const timeFormatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  const formattedDate = dateFormatter.format(instant).replace(/^([^,]+),/, "$1");
  const formattedTime = timeFormatter.format(instant);
  return { date: formattedDate, time: formattedTime, dateTime: `${formattedDate} at ${formattedTime}` };
}

export type EmailOptions = { html?: string; replyTo?: string; senderName?: string };

export async function deliverEmail(to: string, subject: string, text: string, options: EmailOptions = {}) {
  const apiKey = Deno.env.get("EMAIL_PROVIDER_API_KEY");
  const configuredFrom = Deno.env.get("EMAIL_FROM_ADDRESS");
  const endpoint = Deno.env.get("EMAIL_PROVIDER_URL") || "https://api.resend.com/emails";
  if (!apiKey || !configuredFrom) throw new Error("EMAIL_PROVIDER_API_KEY and EMAIL_FROM_ADDRESS must be configured.");
  const from = options.senderName && !configuredFrom.includes("<")
    ? `${safeHeader(options.senderName)} <${configuredFrom}>`
    : configuredFrom;
  const payload: Record<string, unknown> = { from, to: [to], subject, text, html: options.html };
  const requestedReplyTo = emailAddress(options.replyTo);
  const senderReplyTo = emailAddress(configuredFrom);
  const replyTo = requestedReplyTo || senderReplyTo;
  const replyToResolution = requestedReplyTo
    ? "company_valid"
    : options.replyTo
      ? senderReplyTo ? "sender_fallback" : "omitted_invalid"
      : senderReplyTo ? "sender_fallback" : "omitted";
  if (replyTo) payload.reply_to = replyTo;
  console.info("Submitting email to provider", {
    provider: providerName(endpoint),
    recipient_count: 1,
    reply_to: replyToResolution,
  });
  const response = await fetch(endpoint, { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  console.info("Email provider responded", { provider: providerName(endpoint), status: response.status });
  const responseText = await response.text();
  let result: Record<string, unknown> = {};
  try { result = responseText ? JSON.parse(responseText) : {}; } catch { /* handled below */ }
  if (!response.ok) {
    const providerMessage = safeProviderMessage(result.message || result.error || responseText);
    console.error("Email provider rejected request", { status: response.status, error: providerMessage });
    throw new Error(providerMessage || `Email provider rejected the request (${response.status}).`);
  }
  const providerId = String(result.id || "").trim();
  if (!providerId) {
    console.error("Email provider returned success without a message id", { status: response.status });
    throw new Error("Email provider did not confirm message acceptance.");
  }
  return providerId;
}

export async function logDelivery(companyId: string, templateKey: string, recipient: string, links: Record<string, unknown>, task: () => Promise<string | null>) {
  const db = adminClient();
  const fullRecord = { company_id: companyId, template_key: templateKey, recipient, status: "queued", ...links };
  let insert = await db.from("email_deliveries").insert(fullRecord).select("id").single();
  if (isMissingEmailAuditColumn(insert.error)) {
    const { recipient_type: _recipientType, event_key: _eventKey, retry_count: _retryCount, metadata: _metadata, ...legacyRecord } = fullRecord as Record<string, unknown>;
    console.warn("Email audit schema is on the legacy version; using compatible delivery logging.");
    insert = await db.from("email_deliveries").insert(legacyRecord).select("id").single();
  }
  if (insert.error?.code === "23505") return "duplicate";
  if (insert.error || !insert.data) throw insert.error || new Error("Email delivery log could not be created.");
  try { const providerId = await task(); await db.from("email_deliveries").update({ status: "sent", sent_at: new Date().toISOString(), provider_message_id: providerId }).eq("id", insert.data.id).eq("company_id", companyId); return providerId; }
  catch (error) { await db.from("email_deliveries").update({ status: "failed", error_message: error instanceof Error ? error.message : "Delivery failed" }).eq("id", insert.data.id).eq("company_id", companyId); throw error; }
}

export function brandedEmail(settings: Record<string, unknown>, contentHtml: string) {
  const company = escapeHtml(settings.tradingname || settings.companyname || "Transport Company");
  const logo = safeUrl(settings.companylogo);
  const accent = safeColour(settings.primarycolour) || "#14b8a6";
  const contact = [settings.companyphone, settings.companyemail, settings.companywebsite].filter(Boolean).map(escapeHtml).join(" · ");
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta charset="utf-8"></head><body style="margin:0;background:#f1f5f9;font-family:Arial,sans-serif;color:#172033"><div style="display:none;max-height:0;overflow:hidden">${company} booking notification</div><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f1f5f9"><tr><td style="padding:24px 10px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;margin:auto;background:#fff;border-radius:14px;overflow:hidden"><tr><td style="height:7px;background:${accent}"></td></tr><tr><td style="padding:26px 24px;text-align:center">${logo ? `<img src="${logo}" alt="${company}" style="max-width:180px;max-height:72px;width:auto;height:auto">` : `<div style="font-size:22px;font-weight:800">${company}</div>`}</td></tr><tr><td style="padding:0 24px 28px;line-height:1.55">${contentHtml}</td></tr><tr><td style="padding:18px 24px;background:#f8fafc;text-align:center;color:#64748b;font-size:13px">${company}${contact ? `<br>${contact}` : ""}</td></tr></table></td></tr></table></body></html>`;
}

export function textToHtml(text: string) {
  return escapeHtml(text).replaceAll("\n", "<br>");
}

export function escapeHtml(value: unknown) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function safeColour(value: unknown) { const colour = String(value || ""); return /^#[0-9a-f]{6}$/i.test(colour) ? colour : ""; }
function safeUrl(value: unknown) { const url = String(value || ""); return /^https:\/\//i.test(url) ? escapeHtml(url) : ""; }
function safeHeader(value: unknown) { return String(value || "").replace(/[\r\n<>]/g, "").trim(); }
function companyLocalInstant(date: string, time: string, timezone: string) {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute, second = 0] = time.split(":").map(Number);
  const target = Date.UTC(year, month - 1, day, hour, minute, second);
  let guess = target;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date(guess));
    const values = Object.fromEntries(parts.filter(part => part.type !== "literal").map(part => [part.type, Number(part.value)]));
    const represented = Date.UTC(values.year, values.month - 1, values.day, values.hour, values.minute, values.second);
    guess += target - represented;
  }
  const result = new Date(guess);
  return Number.isNaN(result.getTime()) ? null : result;
}
function validTimeZone(value: unknown) { try { new Intl.DateTimeFormat("en-GB", { timeZone: String(value || "") }); return Boolean(value); } catch { return false; } }
function emailAddress(value: unknown) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const displayAddress = raw.match(/^[^<>]*<\s*([^<>]+)\s*>$/);
  const candidate = (displayAddress?.[1] || raw).trim();
  return /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/i.test(candidate)
    ? candidate
    : "";
}
function safeProviderMessage(value: unknown) { return String(value || "").replace(/[\r\n]/g, " ").slice(0, 500); }
function providerName(endpoint: string) { try { return new URL(endpoint).hostname; } catch { return "configured-provider"; } }
function isMissingEmailAuditColumn(error: any) { return Boolean(error && (["PGRST204", "42703"].includes(String(error.code)) || /column.*(recipient_type|event_key|retry_count|metadata)/i.test(String(error.message || "")))); }
function constantTimeEqual(a: string, b: string) { if (a.length !== b.length) return false; let result = 0; for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i); return result === 0; }
