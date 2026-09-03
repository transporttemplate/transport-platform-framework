const customersDb = getSupabase();

let customersCompanyId = null;
let customerRows = [];
let customerBookings = [];
let customerInvoices = [];
let customerCurrency = "£";
let invoicesAvailable = false;

document.addEventListener("DOMContentLoaded", async () => {
    try {
        const context = await window.getAdminCompanyContext();
        customersCompanyId = context.companyId;
        bindCustomerEvents();
        await loadCustomersPage();
    } catch (error) {
        console.error("Customers startup error:", error);
        renderCustomerError("Unable to load the signed-in company.");
    }
});

function bindCustomerEvents() {
    document.getElementById("refreshCustomers")?.addEventListener("click", loadCustomersPage);
    ["customerNameSearch", "customerPhoneSearch", "customerEmailSearch"].forEach(id => document.getElementById(id)?.addEventListener("input", renderCustomers));
    document.getElementById("customerTypeFilter")?.addEventListener("change", renderCustomers);
    document.getElementById("closeCustomerDetail")?.addEventListener("click", closeCustomerDetails);
    document.getElementById("customerDetailBackdrop")?.addEventListener("click", event => {
        if (event.target.id === "customerDetailBackdrop") closeCustomerDetails();
    });
}

async function loadCustomersPage() {
    if (!customersCompanyId) return;
    document.getElementById("customersTableBody").innerHTML = '<tr><td colspan="7" class="customer-empty">Loading customers…</td></tr>';

    const [customersResult, bookingsResult, settingsResult] = await Promise.all([
        customersDb.from("customers").select("*").eq("company_id", customersCompanyId).order("full_name", { ascending: true }),
        customersDb.from("bookings").select("*").eq("company_id", customersCompanyId).order("journey_date", { ascending: false }).order("journey_time", { ascending: false }),
        customersDb.from("settings").select("company_id,currencysymbol").eq("company_id", customersCompanyId).maybeSingle()
    ]);

    const primaryError = customersResult.error || bookingsResult.error || settingsResult.error;
    if (primaryError) {
        console.error("Customers load error:", primaryError);
        renderCustomerError(primaryError.message);
        return;
    }

    customerRows = customersResult.data || [];
    customerBookings = bookingsResult.data || [];
    customerCurrency = settingsResult.data?.currencysymbol || "£";

    const invoiceResult = await customersDb.from("invoices").select("id,company_id,customer_id,customer_name,customer_email,invoice_number,issue_date,due_date,status,total,paid_total").eq("company_id", customersCompanyId).order("issue_date", { ascending: false });
    if (invoiceResult.error) {
        invoicesAvailable = false;
        customerInvoices = [];
        console.info("Invoice data is not available for Customers yet:", invoiceResult.error.message);
    } else {
        invoicesAvailable = true;
        customerInvoices = invoiceResult.data || [];
    }

    renderCustomerStats();
    renderCustomers();
}

function renderCustomerStats() {
    const now = new Date();
    const monthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const monthlyCount = customerBookings.filter(booking => String(booking.journey_date || "").startsWith(monthPrefix)).length;
    const regularCount = customerRows.filter(customer => bookingsForCustomer(customer).length >= 3).length;
    const outstanding = invoicesAvailable
        ? customerInvoices.filter(invoice => !["paid", "cancelled"].includes(normalise(invoice.status))).reduce((sum, invoice) => sum + outstandingInvoiceAmount(invoice), 0)
        : customerBookings.filter(booking => normalise(booking.payment_status) !== "paid" && isAccountPayment(booking.payment_method)).reduce((sum, booking) => sum + bookingFare(booking), 0);

    setText("totalCustomers", customerRows.length);
    setText("regularCustomers", regularCount);
    setText("monthlyBookings", monthlyCount);
    setText("outstandingBalance", money(outstanding));
}

function renderCustomers() {
    const nameSearch = searchValue("customerNameSearch");
    const phoneSearch = searchValue("customerPhoneSearch");
    const emailSearch = searchValue("customerEmailSearch");
    const typeFilter = document.getElementById("customerTypeFilter")?.value || "";

    const filtered = customerRows.filter(customer => {
        const bookings = bookingsForCustomer(customer);
        if (nameSearch && !customerName(customer).toLowerCase().includes(nameSearch)) return false;
        if (phoneSearch && !customerPhone(customer).toLowerCase().includes(phoneSearch)) return false;
        if (emailSearch && !customerEmail(customer).toLowerCase().includes(emailSearch)) return false;
        if (typeFilter === "regular" && bookings.length < 3) return false;
        if (typeFilter === "new" && bookings.length >= 3) return false;
        if (typeFilter === "account" && !isAccountCustomer(customer, bookings)) return false;
        return true;
    });

    const body = document.getElementById("customersTableBody");
    if (!filtered.length) {
        body.innerHTML = '<tr><td colspan="7" class="customer-empty">No customers match these filters.</td></tr>';
        return;
    }

    body.innerHTML = filtered.map(customer => {
        const bookings = bookingsForCustomer(customer);
        const completed = bookings.filter(booking => normalise(booking.status) === "completed");
        const totalSpent = completed.reduce((sum, booking) => sum + bookingFare(booking), 0);
        const lastJourney = bookings[0];
        return `<tr><td>${escapeCustomerHtml(customerName(customer))}</td><td>${escapeCustomerHtml(customerPhone(customer) || "-")}</td><td>${escapeCustomerHtml(customerEmail(customer) || "-")}</td><td>${bookings.length}</td><td>${money(totalSpent)}</td><td>${escapeCustomerHtml(lastJourney ? `${formatCustomerDate(lastJourney.journey_date)} — ${bookingDestination(lastJourney)}` : "-")}</td><td><button type="button" data-view-customer="${escapeCustomerHtml(customer.id)}">View</button></td></tr>`;
    }).join("");

    body.querySelectorAll("[data-view-customer]").forEach(button => button.addEventListener("click", () => openCustomerDetails(button.dataset.viewCustomer)));
}

function openCustomerDetails(customerId) {
    const customer = customerRows.find(row => String(row.id) === String(customerId));
    if (!customer) return;
    const bookings = bookingsForCustomer(customer);
    const invoices = invoicesForCustomer(customer);
    const outstanding = invoicesAvailable
        ? invoices.filter(invoice => !["paid", "cancelled"].includes(normalise(invoice.status))).reduce((sum, invoice) => sum + outstandingInvoiceAmount(invoice), 0)
        : bookings.filter(booking => normalise(booking.payment_status) !== "paid" && isAccountPayment(booking.payment_method)).reduce((sum, booking) => sum + bookingFare(booking), 0);

    setText("customerDetailName", customerName(customer));
    setText("customerDetailSubtitle", `${bookings.length} booking${bookings.length === 1 ? "" : "s"} • ${money(outstanding)} outstanding`);
    document.getElementById("customerContactDetails").innerHTML = [
        detailItem("Phone", customerPhone(customer) || "-"),
        detailItem("Email", customerEmail(customer) || "-"),
        detailItem("Company / Account", customer.company_name || customer.account_name || customer.business_name || "-"),
        detailItem("Account Reference", customer.account_reference || customer.customer_reference || "-"),
        detailItem("Billing Address", customer.billing_address || customer.address || "-"),
        detailItem("Payment Terms", customer.payment_terms != null ? `${customer.payment_terms} days` : "Company default"),
        detailItem("Account Status", customer.account_status || customer.customer_type || (isAccountCustomer(customer, bookings) ? "Account customer" : "Standard customer")),
        detailItem("Outstanding", money(outstanding))
    ].join("");

    document.getElementById("customerBookingHistory").innerHTML = bookings.length ? bookings.map(booking => `<tr><td>${escapeCustomerHtml(formatCustomerDate(booking.journey_date))} ${escapeCustomerHtml(formatCustomerTime(booking.journey_time))}</td><td>${escapeCustomerHtml(booking.booking_reference || shortCustomerId(booking.id))}</td><td>${escapeCustomerHtml(`${bookingPickup(booking)} → ${bookingDestination(booking)}`)}</td><td>${escapeCustomerHtml(prettyCustomerStatus(booking.status))}</td><td>${escapeCustomerHtml(booking.payment_status || booking.payment_method || "-")}</td><td>${money(bookingFare(booking))}</td></tr>`).join("") : emptyCustomerRow(6, "No booking history.");

    document.getElementById("customerInvoiceSummary").textContent = invoicesAvailable ? `${invoices.length} invoice(s), ${money(outstanding)} outstanding.` : "Invoice data is not available; outstanding account bookings are shown instead.";
    document.getElementById("customerInvoiceHistory").innerHTML = invoicesAvailable && invoices.length ? invoices.map(invoice => `<tr><td>${escapeCustomerHtml(invoice.invoice_number)}</td><td>${escapeCustomerHtml(formatCustomerDate(invoice.issue_date))}</td><td>${escapeCustomerHtml(formatCustomerDate(invoice.due_date))}</td><td>${escapeCustomerHtml(prettyCustomerStatus(invoice.status))}</td><td>${money(invoice.total)}</td><td>${money(outstandingInvoiceAmount(invoice))}</td></tr>`).join("") : emptyCustomerRow(6, invoicesAvailable ? "No invoices for this customer." : "Invoice data unavailable.");
    document.getElementById("customerDetailBackdrop").classList.add("open");
}

function closeCustomerDetails() { document.getElementById("customerDetailBackdrop")?.classList.remove("open"); }
function bookingsForCustomer(customer) { const id = String(customer.id); const email = normaliseEmail(customerEmail(customer)); const phone = normalisePhone(customerPhone(customer)); return customerBookings.filter(booking => String(booking.customer_id || "") === id || (!booking.customer_id && ((email && normaliseEmail(booking.customer_email || booking.email) === email) || (phone && normalisePhone(booking.customer_phone || booking.phone) === phone)))); }
function invoicesForCustomer(customer) { const email = normaliseEmail(customerEmail(customer)); return customerInvoices.filter(invoice => String(invoice.customer_id || "") === String(customer.id) || (!invoice.customer_id && email && normaliseEmail(invoice.customer_email) === email)); }
function customerName(customer) { return customer.full_name || customer.customer_name || customer.name || [customer.first_name, customer.last_name].filter(Boolean).join(" ") || "Unnamed customer"; }
function customerPhone(customer) { return String(customer.phone || customer.mobile || customer.telephone || ""); }
function customerEmail(customer) { return String(customer.email || customer.customer_email || ""); }
function bookingFare(booking) { return Number(booking.price ?? booking.job_price ?? 0) || 0; }
function outstandingInvoiceAmount(invoice) { return Math.max(0, Number(invoice.total || 0) - Number(invoice.paid_total || 0)); }
function bookingPickup(booking) { return booking.pickup_address || booking.pickup || "-"; }
function bookingDestination(booking) { return booking.dropoff_address || booking.destination || "-"; }
function isAccountPayment(value) { const method = normalise(value); return method.includes("account") || method.includes("invoice"); }
function isAccountCustomer(customer, bookings) { return Boolean(customer.is_account || customer.account_customer || customer.company_name || customer.account_name || normalise(customer.customer_type).includes("business") || bookings.some(booking => isAccountPayment(booking.payment_method))); }
function normalise(value) { return String(value || "").trim().toLowerCase().replaceAll(" ", "_"); }
function normaliseEmail(value) { return String(value || "").trim().toLowerCase(); }
function normalisePhone(value) { return String(value || "").replace(/\D/g, ""); }
function searchValue(id) { return document.getElementById(id)?.value.trim().toLowerCase() || ""; }
function formatCustomerDate(value) { if (!value) return "-"; const parts = String(value).split("-"); return parts.length === 3 ? `${parts[2]}/${parts[1]}/${parts[0]}` : value; }
function formatCustomerTime(value) { return value ? String(value).slice(0, 5) : ""; }
function prettyCustomerStatus(value) { return String(value || "-").replaceAll("_", " ").replace(/\b\w/g, letter => letter.toUpperCase()); }
function shortCustomerId(value) { return value ? String(value).slice(0, 8).toUpperCase() : "-"; }
function money(value) { return `${customerCurrency}${Number(value || 0).toFixed(2)}`; }
function detailItem(label, value) { return `<div class="customer-detail-item"><small>${escapeCustomerHtml(label)}</small><strong>${escapeCustomerHtml(value)}</strong></div>`; }
function emptyCustomerRow(columns, message) { return `<tr><td colspan="${columns}" class="customer-empty">${escapeCustomerHtml(message)}</td></tr>`; }
function renderCustomerError(message) { const body = document.getElementById("customersTableBody"); if (body) body.innerHTML = emptyCustomerRow(7, message); }
function setText(id, value) { const element = document.getElementById(id); if (element) element.textContent = value; }
function escapeCustomerHtml(value) { return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;"); }
