import { adminClient, brandedEmail, cors, deliverEmail, escapeHtml, json, logDelivery, productionEmailAllowed, render, requireCompanyAdmin } from "../_shared/email.ts";

Deno.serve(async request => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { company_id, invoice_id } = await request.json();
    if (!await requireCompanyAdmin(request, company_id)) return json({ ok: false, error: "Forbidden" }, 403);
    if (!await productionEmailAllowed(company_id)) return json({ ok: true, sent: false, skipped: "Production email is not available during the trial" });
    const db = adminClient();
    const [invoiceResult, itemsResult, templateResult, settingsResult] = await Promise.all([
      db.from("invoices").select("*").eq("company_id", company_id).eq("id", invoice_id).maybeSingle(),
      db.from("invoice_items").select("description,quantity,unit_price,line_total").eq("company_id", company_id).eq("invoice_id", invoice_id).order("sort_order"),
      db.from("email_templates").select("subject,body").eq("company_id", company_id).eq("template_key", "invoice_sent").maybeSingle(),
      db.from("settings").select("companyname,tradingname,companylogo,companyphone,companyemail,companywebsite,primarycolour,currencysymbol,bankaccountname,banksortcode,bankaccountnumber,bankpaymentreferenceinstruction,showbankdetailsoninvoices").eq("company_id", company_id).maybeSingle()
    ]);
    if (invoiceResult.error || itemsResult.error || settingsResult.error) throw invoiceResult.error || itemsResult.error || settingsResult.error;
    const invoice = invoiceResult.data;
    const settings = settingsResult.data || {};
    if (!invoice?.customer_email) return json({ ok: false, error: "Invoice or recipient not found" }, 404);
    const company = settings.tradingname || settings.companyname || "Transport Company";
    const currency = settings.currencysymbol || "£";
    const money = (value: unknown) => `${currency}${Number(value || 0).toFixed(2)}`;
    const values = { company_name: company, customer_name: invoice.customer_name, invoice_number: invoice.invoice_number };
    const subject = render(templateResult.data?.subject || "Invoice {{invoice_number}}", values);
    const intro = render(templateResult.data?.body || "Please find invoice {{invoice_number}} from {{company_name}}.", values);
    const rows = (itemsResult.data || []).map(item => `<tr><td style="border-bottom:1px solid #e2e8f0">${escapeHtml(item.description)}</td><td style="text-align:right;border-bottom:1px solid #e2e8f0">${escapeHtml(item.quantity)}</td><td style="text-align:right;border-bottom:1px solid #e2e8f0">${escapeHtml(money(item.line_total))}</td></tr>`).join("");
    const bankComplete = [settings.bankaccountname, settings.banksortcode, settings.bankaccountnumber].every(value => String(value || "").trim());
    const bankDetails = settings.showbankdetailsoninvoices && bankComplete
      ? `<div style="margin-top:22px;padding:16px;border-left:4px solid #0f766e;background:#f8fafc"><strong>PAYMENT DETAILS — Bank transfer</strong><br>Account name: ${escapeHtml(settings.bankaccountname)}<br>Sort code: ${escapeHtml(settings.banksortcode)}<br>Account number: ${escapeHtml(settings.bankaccountnumber)}<br>Reference: <strong>${escapeHtml(invoice.invoice_number)}</strong>${settings.bankpaymentreferenceinstruction ? `<br><small>${escapeHtml(settings.bankpaymentreferenceinstruction)}</small>` : ""}</div>`
      : "";
    const html = brandedEmail(settings, `<p>${escapeHtml(intro)}</p><h2>Invoice ${escapeHtml(invoice.invoice_number)}</h2><p>Issue: ${escapeHtml(invoice.issue_date)} · Due: ${escapeHtml(invoice.due_date)} · Status: ${escapeHtml(invoice.status)}</p><table width="100%" cellpadding="8" cellspacing="0"><tr><th align="left">Description</th><th align="right">Qty</th><th align="right">Total</th></tr>${rows}</table><h2 style="text-align:right">Grand total: ${escapeHtml(money(invoice.total))}</h2>${bankDetails}`);
    await logDelivery(company_id, "invoice_sent", invoice.customer_email, { invoice_id, subject }, () => deliverEmail(invoice.customer_email, subject, intro, { html, replyTo: settings.companyemail, senderName: company }));
    await db.from("invoices").update({ status: "sent", sent_at: new Date().toISOString() }).eq("id", invoice_id).eq("company_id", company_id);
    return json({ ok: true, sent: true });
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : "Unexpected error" }, 500);
  }
});
