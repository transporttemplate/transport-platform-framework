import { adminClient, json } from "../_shared/email.ts";

const supportedEvents = new Set([
  "email.sent", "email.delivered", "email.bounced", "email.failed",
  "email.complained", "email.delivery_delayed", "email.suppressed",
]);

Deno.serve(async request => {
  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
  const raw = await request.text();
  const secret = Deno.env.get("RESEND_WEBHOOK_SIGNING_SECRET") || "";
  if (!secret) return json({ ok: false, error: "Webhook is not configured" }, 503);
  const eventId = request.headers.get("svix-id") || "";
  const timestamp = request.headers.get("svix-timestamp") || "";
  const signature = request.headers.get("svix-signature") || "";
  if (!await verify(raw, eventId, timestamp, signature, secret)) return json({ ok: false, error: "Invalid signature" }, 401);

  let event: Record<string, any>;
  try { event = JSON.parse(raw); } catch { return json({ ok: false, error: "Invalid payload" }, 400); }
  const eventType = String(event.type || "");
  if (!supportedEvents.has(eventType)) return json({ ok: true, ignored: true });
  const providerId = String(event?.data?.email_id || event?.data?.id || "").trim();
  const providerCreatedAt = validTimestamp(event.created_at || event?.data?.created_at);
  if (!providerId || !providerCreatedAt) return json({ ok: false, error: "Invalid payload" }, 400);

  const { data, error } = await adminClient().rpc("process_resend_webhook_event", {
    p_event_id: eventId,
    p_provider_message_id: providerId,
    p_event_type: eventType,
    p_provider_created_at: providerCreatedAt,
    p_reason: eventReason(eventType, event.data),
  });
  if (error) {
    console.error("resend-webhook", { code: error.code || "unknown", event_type: eventType });
    return json({ ok: false, error: "Webhook processing failed" }, 500);
  }
  const result = Array.isArray(data) ? data[0] : data;
  return json({ ok: true, result: result?.processing_result || "unmatched", applied: result?.applied === true });
});

function eventReason(type: string, data: Record<string, any> = {}) {
  const value = type === "email.suppressed" ? data?.suppressed?.message
    : type === "email.bounced" ? data?.bounce?.message
    : data?.failed?.reason || data?.reason;
  return String(value || "").replace(/[\r\n<>]/g, " ").trim().slice(0, 500) || null;
}
function validTimestamp(value: unknown) {
  const date = new Date(String(value || ""));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
async function verify(body: string, id: string, timestamp: string, header: string, secret: string) {
  if (!id || !timestamp || !header || !/^\d+$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  try {
    const rawSecret = secret.startsWith("whsec_") ? secret.slice(6) : secret;
    const keyBytes = Uint8Array.from(atob(rawSecret), character => character.charCodeAt(0));
    const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`));
    const actual = btoa(String.fromCharCode(...new Uint8Array(digest)));
    return header.split(" ").some(part => equal(actual, part.replace(/^v1,/, "")));
  } catch { return false; }
}
function equal(a: string, b: string) { if (a.length !== b.length) return false; let result = 0; for (let index = 0; index < a.length; index += 1) result |= a.charCodeAt(index) ^ b.charCodeAt(index); return result === 0; }
