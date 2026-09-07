import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const supportedEvents = new Set([
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
  "payment_intent.canceled",
]);

Deno.serve(async request => {
  if (request.method !== "POST") return json({ ok: false }, 405);

  try {
    const signature = request.headers.get("stripe-signature") || "";
    const rawBody = await request.text();
    const verifiedCompanyCode = await companyCodeForValidSignature(rawBody, signature);
    if (!verifiedCompanyCode) return json({ ok: false, error: "Invalid signature" }, 400);

    // The event body is parsed only after one configured company secret has
    // successfully verified the exact raw payload.
    const event = JSON.parse(rawBody);
    if (!supportedEvents.has(String(event?.type || ""))) return json({ ok: true, ignored: true });
    const intent = event?.data?.object;
    if (!intent?.id) return json({ ok: false, error: "Invalid PaymentIntent event" }, 400);

    const { data: company, error: companyError } = await db.from("companies")
      .select("id,company_code")
      .eq("company_code", verifiedCompanyCode)
      .maybeSingle();
    if (companyError) throw companyError;
    if (!company) return json({ ok: false, error: "Webhook company is not configured" }, 503);
    const companyId = String(company.id);

    const { data: payment, error: paymentError } = await db.from("payments")
      .select("id,company_id,booking_id,amount,status")
      .eq("company_id", companyId)
      .eq("reference", String(intent.id))
      .eq("method", "stripe")
      .maybeSingle();
    if (paymentError) throw paymentError;
    if (!payment) return json({ ok: true, ignored: true });

    const { data: booking, error: bookingError } = await db.from("bookings")
      .select("id,company_id,booking_reference,price,balance_due,payment_type")
      .eq("id", payment.booking_id)
      .eq("company_id", companyId)
      .maybeSingle();
    if (bookingError) throw bookingError;
    if (!booking) return json({ ok: false, error: "Booking not found" }, 404);

    if (String(payment.company_id) !== companyId || String(booking.company_id) !== companyId) {
      return json({ ok: false, error: "Payment company mismatch" }, 400);
    }
    if (String(intent.metadata?.company_id || "") !== companyId || String(intent.metadata?.booking_id || "") !== String(booking.id)) {
      return json({ ok: false, error: "Payment metadata mismatch" }, 400);
    }

    if (event.type === "payment_intent.succeeded") {
      const expectedMinorAmount = Math.round(Number(payment.amount || 0) * 100);
      const intentAmount = Number(intent.amount);
      const receivedAmount = Number(intent.amount_received);
      const currency = String(intent.currency || "").toLowerCase();
      if (!Number.isSafeInteger(expectedMinorAmount) || expectedMinorAmount <= 0 || intentAmount !== expectedMinorAmount || receivedAmount !== expectedMinorAmount) {
        return json({ ok: false, error: "Payment amount mismatch" }, 400);
      }
      if (currency !== "gbp") return json({ ok: false, error: "Payment currency mismatch" }, 400);
      if (payment.status === "paid") return json({ ok: true, duplicate: true });

      const paid = Number(payment.amount);
      const balance = Math.max(0, Number(booking.balance_due || 0) - paid);
      const paymentStatus = balance > 0 ? "deposit_paid" : "paid";
      const paidAt = new Date().toISOString();
      const paymentUpdate = await db.from("payments")
        .update({ status: "paid", paid_at: paidAt })
        .eq("id", payment.id)
        .eq("company_id", companyId)
        .neq("status", "paid")
        .select("id")
        .maybeSingle();
      if (paymentUpdate.error) throw paymentUpdate.error;
      if (!paymentUpdate.data) return json({ ok: true, duplicate: true });
      const bookingUpdate = await db.from("bookings")
        .update({ payment_status: paymentStatus, amount_paid: paid, balance_due: balance, paid_at: paidAt })
        .eq("id", booking.id)
        .eq("company_id", companyId);
      if (bookingUpdate.error) throw bookingUpdate.error;
      const linked = await db.from("bookings")
        .update({ payment_status: paymentStatus, paid_at: paidAt })
        .eq("company_id", companyId)
        .eq("booking_reference", `${booking.booking_reference}-R`)
        .eq("payment_type", "linked_return")
        .select("id");
      await notifyPaidBooking(companyId, [booking.id, ...(linked.data || []).map((row: any) => row.id)], booking.id, String(intent.id));
    } else {
      const paymentUpdate = await db.from("payments")
        .update({ status: "failed" })
        .eq("id", payment.id)
        .eq("company_id", companyId)
        .neq("status", "paid")
        .select("id")
        .maybeSingle();
      if (paymentUpdate.error) throw paymentUpdate.error;
      if (!paymentUpdate.data) return json({ ok: true, ignored: true });
      const bookingUpdate = await db.from("bookings")
        .update({ payment_status: event.type === "payment_intent.canceled" ? "payment_cancelled" : "payment_failed" })
        .eq("id", payment.booking_id)
        .eq("company_id", companyId)
        .not("payment_status", "in", "(paid,deposit_paid)");
      if (bookingUpdate.error) throw bookingUpdate.error;
    }
    return json({ ok: true });
  } catch (error) {
    console.error("stripe-webhook failed", { error: error instanceof Error ? error.message : "Unexpected error" });
    return json({ ok: false, error: "Webhook processing failed" }, 500);
  }
});

async function companyCodeForValidSignature(payload: string, signature: string) {
  const candidates = [
    ["0002", Deno.env.get("STRIPE_WEBHOOK_SECRET_0002") || ""],
    ["0003", Deno.env.get("STRIPE_WEBHOOK_SECRET_0003") || ""],
  ] as const;
  for (const [companyCode, secret] of candidates) {
    if (secret && await validStripeSignature(payload, signature, secret)) return companyCode;
  }
  return null;
}

async function notifyPaidBooking(companyId: string, bookingIds: string[], emailBookingId: string, paymentIntentId: string) {
  const base = Deno.env.get("SUPABASE_URL") || "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const headers = { "Content-Type": "application/json", apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
  const requests = bookingIds.map(bookingId => fetch(`${base}/functions/v1/google-calendar-sync`, { method: "POST", headers, body: JSON.stringify({ company_id: companyId, booking_id: bookingId }) }));
  requests.push(fetch(`${base}/functions/v1/send-booking-email`, { method: "POST", headers, body: JSON.stringify({ company_id: companyId, booking_id: emailBookingId, event: "payment_received", event_id: `stripe:${paymentIntentId}` }) }));
  const results = await Promise.allSettled(requests);
  for (const result of results) {
    if (result.status === "rejected") console.error("Post-payment notification failed", result.reason);
    else if (!result.value.ok) console.error("Post-payment notification returned", result.value.status);
  }
}

async function validStripeSignature(payload: string, header: string, secret: string) {
  const timestamp = header.split(",").map(item => item.trim()).find(item => item.startsWith("t="))?.slice(2);
  const expectedSignatures = header.split(",").map(item => item.trim()).filter(item => item.startsWith("v1=")).map(item => item.slice(3));
  if (!timestamp || !expectedSignatures.length || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${payload}`));
  const actual = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  return expectedSignatures.some(expected => constantTimeEqual(actual, expected));
}

function constantTimeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let different = 0;
  for (let index = 0; index < a.length; index += 1) different |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return different === 0;
}
