document.addEventListener("DOMContentLoaded", async () => {
    try {
        const context = await window.getAdminCompanyContext();
        const invoiceId = new URLSearchParams(location.search).get("id");
        if (!invoiceId) return;
        const bankDb = getSupabase();
        const [invoiceResult, settingsResult] = await Promise.all([
            bankDb.from("invoices").select("id,invoice_number").eq("company_id", context.companyId).eq("id", invoiceId).maybeSingle(),
            bankDb.from("settings").select("company_id,bankaccountname,banksortcode,bankaccountnumber,bankpaymentreferenceinstruction,showbankdetailsoninvoices").eq("company_id", context.companyId).maybeSingle()
        ]);
        if (invoiceResult.error || settingsResult.error) throw invoiceResult.error || settingsResult.error;
        const invoice = invoiceResult.data;
        const settings = settingsResult.data;
        if (!invoice || !settings?.showbankdetailsoninvoices) return;
        if (![settings.bankaccountname, settings.banksortcode, settings.bankaccountnumber].every(value => String(value || "").trim())) {
            console.warn("Invoice bank details are enabled but incomplete; the customer document section was hidden.");
            return;
        }
        const section = document.createElement("section");
        section.className = "document-payment-details";
        section.innerHTML = `<h3>PAYMENT DETAILS</h3><strong>Bank transfer</strong><dl><div><dt>Account name</dt><dd>${bankEsc(settings.bankaccountname)}</dd></div><div><dt>Sort code</dt><dd>${bankEsc(settings.banksortcode)}</dd></div><div><dt>Account number</dt><dd>${bankEsc(settings.bankaccountnumber)}</dd></div><div><dt>Reference</dt><dd>${bankEsc(invoice.invoice_number)}</dd></div></dl>${settings.bankpaymentreferenceinstruction ? `<p>${bankEsc(settings.bankpaymentreferenceinstruction)}</p>` : ""}`;
        const target = document.getElementById("invoiceDocument");
        const insert = () => { const footer = target.querySelector(".document-footer"); if (!footer || target.querySelector(".document-payment-details")) return Boolean(footer); footer.before(section); return true; };
        if (!insert()) { const observer = new MutationObserver(() => { if (insert()) observer.disconnect(); }); observer.observe(target, { childList: true, subtree: true }); }
    } catch (error) {
        console.error("Unable to load company invoice bank details.", error);
    }
});
function bankEsc(value) { return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"); }
