import { adminClient, brandedEmail, cors, deliverEmail, escapeHtml, json, logDelivery, productionEmailAllowed, requireCompanyAdmin } from "../_shared/email.ts";

Deno.serve(async request => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { company_id, receipt_id } = await request.json();
    if (!await requireCompanyAdmin(request, company_id)) return json({ ok: false, error: "Forbidden" }, 403);
    if (!await productionEmailAllowed(company_id)) return json({ ok: true, sent: false, skipped: "Production email is not available during the trial" });
    const db = adminClient();
    const [receiptResult, settingsResult] = await Promise.all([
      db.from("receipts").select("*").eq("company_id", company_id).eq("id", receipt_id).maybeSingle(),
      db.from("settings").select("companyname,tradingname,companylogo,companyaddress,companyphone,companyemail,companywebsite,primarycolour,currencysymbol").eq("company_id", company_id).maybeSingle()
    ]);
    if (receiptResult.error) throw receiptResult.error;
    if (settingsResult.error) throw settingsResult.error;
    const receipt = receiptResult.data;
    const settings = settingsResult.data || {};
    if (!receipt?.customer_email) return json({ ok: false, error: "Receipt or customer email not found" }, 404);
    const companyName = settings.tradingname || settings.companyname || "Transport Company";
    const money = `${settings.currencysymbol || "£"}${Number(receipt.amount || 0).toFixed(2)}`;
    const subject = `Receipt ${receipt.receipt_number} from ${companyName}`;
    const content = `<h2 style="margin:0 0 16px">Payment receipt</h2><p>Hello ${escapeHtml(receipt.customer_name || "Customer")},</p><p>Thank you. This confirms payment for booking <strong>${escapeHtml(receipt.booking_reference)}</strong>.</p><table role="presentation" width="100%" cellspacing="0" cellpadding="8" style="border-collapse:collapse"><tr><td>Receipt</td><td><strong>${escapeHtml(receipt.receipt_number)}</strong></td></tr><tr><td>Amount paid</td><td><strong>${escapeHtml(money)}</strong></td></tr><tr><td>Payment method</td><td>${escapeHtml(receipt.payment_method || "Other")}</td></tr><tr><td>Paid</td><td>${escapeHtml(new Date(receipt.paid_at).toLocaleString("en-GB"))}</td></tr><tr><td>Journey</td><td>${escapeHtml(receipt.pickup_address || "")} → ${escapeHtml(receipt.dropoff_address || "")}</td></tr></table>`;
    const html = brandedEmail(settings, content);
    const text = `Receipt ${receipt.receipt_number}\nBooking: ${receipt.booking_reference}\nAmount paid: ${money}\nPayment method: ${receipt.payment_method || "Other"}`;
    await logDelivery(company_id, "receipt", receipt.customer_email, { receipt_id, subject }, () => deliverEmail(receipt.customer_email, subject, text, { html, replyTo: settings.companyemail, senderName: companyName }));
    return json({ ok: true, sent: true });
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : "Unexpected error" }, 500);
  }
});
