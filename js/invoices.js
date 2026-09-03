const invoicesDb = getSupabase();
let invoiceCompanyId = null;
let invoices = [];
let eligible = [];
let invoiceStops = [];
let invoiceSettings = {};

document.addEventListener("DOMContentLoaded", async () => {
    const context = await getAdminCompanyContext();
    invoiceCompanyId = context.companyId;
    document.getElementById("showInvoiceForm").onclick = () => document.getElementById("invoiceFormCard").hidden = false;
    document.getElementById("addInvoiceItem").onclick = addManualItem;
    document.getElementById("saveInvoice").onclick = createInvoice;
    document.getElementById("invoiceStatus").onchange = renderInvoices;
    document.getElementById("invoiceSearch").oninput = renderInvoices;
    await loadInvoicePage();
});

async function loadInvoicePage() {
    const [invoiceResult, bookingResult, stopResult, settingsResult] = await Promise.all([
        invoicesDb.from("invoices").select("*").eq("company_id", invoiceCompanyId).order("created_at", { ascending: false }),
        invoicesDb.from("bookings").select("id,company_id,booking_reference,customer_id,customer_name,customer_email,email,journey_date,pickup_address,dropoff_address,price,job_price,payment_status,invoice_id").eq("company_id", invoiceCompanyId).ilike("status", "completed").is("invoice_id", null).order("journey_date", { ascending: false }),
        invoicesDb.from("booking_stops").select("booking_id,company_id,formatted_address,stop_order").eq("company_id", invoiceCompanyId).order("stop_order"),
        invoicesDb.from("settings").select("company_id,invoiceprefix,paymentterms,vatrate,currencysymbol").eq("company_id", invoiceCompanyId).maybeSingle()
    ]);
    const error = invoiceResult.error || bookingResult.error || stopResult.error || settingsResult.error;
    if (error) return alert(error.message);
    invoices = invoiceResult.data || [];
    eligible = bookingResult.data || [];
    invoiceStops = stopResult.data || [];
    invoiceSettings = settingsResult.data || {};
    const due = new Date(); due.setDate(due.getDate() + Number(invoiceSettings.paymentterms || 30));
    document.getElementById("invoiceDueDate").value = due.toISOString().slice(0, 10);
    document.getElementById("invoiceTaxRate").value = Number(invoiceSettings.vatrate || 0);
    document.getElementById("eligibleBookings").innerHTML = eligible.map(job => `<label><input type="checkbox" data-invoice-booking="${esc(job.id)}" style="width:auto"> ${esc(job.booking_reference || job.id)} — ${esc(job.customer_name || "Customer")} — ${money(fare(job))}</label>`).join("") || "No uninvoiced completed jobs available.";
    renderInvoices();
}

function addManualItem() {
    const row = document.createElement("div"); row.className = "grid-2 manual-item";
    row.innerHTML = '<input class="item-description" placeholder="Description"><input class="item-price" type="number" min="0" step="0.01" placeholder="Amount">';
    document.getElementById("manualItems").appendChild(row);
}

async function createInvoice() {
    const name = document.getElementById("invoiceCustomerName").value.trim();
    if (!name) return alert("Customer name is required.");
    const chosen = [...document.querySelectorAll("[data-invoice-booking]:checked")].map(el => eligible.find(job => job.id === el.dataset.invoiceBooking)).filter(Boolean);
    const manual = [...document.querySelectorAll(".manual-item")].map(row => ({ description: row.querySelector(".item-description").value.trim(), amount: Number(row.querySelector(".item-price").value || 0) })).filter(item => item.description);
    if (!chosen.length && !manual.length) return alert("Select a booking or add a line item.");
    const number = await nextInvoiceNumber(); if (!number) return;
    const taxRate = Number(document.getElementById("invoiceTaxRate").value || 0);
    const subtotal = chosen.reduce((sum, job) => sum + fare(job), 0) + manual.reduce((sum, item) => sum + item.amount, 0);
    const taxTotal = subtotal * taxRate / 100;
    const payload = { company_id: invoiceCompanyId, invoice_number: number, status: "draft", issue_date: new Date().toISOString().slice(0, 10), due_date: document.getElementById("invoiceDueDate").value, customer_id: chosen[0]?.customer_id || null, customer_name: name, customer_email: document.getElementById("invoiceCustomerEmail").value.trim() || null, billing_address: document.getElementById("invoiceBillingAddress").value.trim() || null, subtotal, tax_rate: taxRate, tax_total: taxTotal, total: subtotal + taxTotal };
    const { data: invoice, error } = await invoicesDb.from("invoices").insert(payload).select("id").single();
    if (error) return alert(error.message);
    const items = chosen.map((job, index) => ({ company_id: invoiceCompanyId, invoice_id: invoice.id, booking_id: job.id, description: routeDescription(job), quantity: 1, unit_price: fare(job), line_total: fare(job), sort_order: index }));
    manual.forEach((item, index) => items.push({ company_id: invoiceCompanyId, invoice_id: invoice.id, description: item.description, quantity: 1, unit_price: item.amount, line_total: item.amount, sort_order: chosen.length + index }));
    const itemResult = await invoicesDb.from("invoice_items").insert(items);
    if (itemResult.error) return alert(itemResult.error.message);
    window.location.href = `invoice.html?id=${encodeURIComponent(invoice.id)}`;
}

function routeDescription(job) { const vias = invoiceStops.filter(stop => stop.booking_id === job.id).map(stop => stop.formatted_address); return `${job.booking_reference || "Job"}: ${[job.pickup_address, ...vias, job.dropoff_address].filter(Boolean).join(" → ")}`; }
async function nextInvoiceNumber() { const prefix = String(invoiceSettings.invoiceprefix || "INV").replace(/[^a-z0-9_-]/gi, "") || "INV"; const { count, error } = await invoicesDb.from("invoices").select("id", { count: "exact", head: true }).eq("company_id", invoiceCompanyId); if (error) { alert(error.message); return null; } return `${prefix}-${new Date().getFullYear()}-${String((count || 0) + 1).padStart(4, "0")}`; }
function renderInvoices() { const status = document.getElementById("invoiceStatus").value, q = document.getElementById("invoiceSearch").value.toLowerCase(); const rows = invoices.filter(i => (!status || i.status === status) && (!q || `${i.invoice_number} ${i.customer_name}`.toLowerCase().includes(q))); document.getElementById("invoiceRows").innerHTML = rows.map(i => `<tr><td>${esc(i.invoice_number)}</td><td>${esc(i.customer_name)}</td><td>${esc(i.issue_date)}</td><td>${esc(i.due_date)}</td><td>${money(i.total)}</td><td>${esc(i.status)}</td><td><a href="invoice.html?id=${encodeURIComponent(i.id)}">View</a></td></tr>`).join("") || '<tr><td colspan="7">No invoices found.</td></tr>'; }
function fare(job) { return Number(job.price ?? job.job_price ?? 0) || 0; }
function money(value) { return `${invoiceSettings.currencysymbol || "£"}${Number(value || 0).toFixed(2)}`; }
function esc(value) { return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"); }
