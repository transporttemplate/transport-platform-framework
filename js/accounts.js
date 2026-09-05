const accountsDb = getSupabase();
let accountsCompanyId = null;
let financeRows = [];
let financeDrivers = [];
let financeSettings = {};
let financeAccounts = [];

document.addEventListener("DOMContentLoaded", async () => {
    const context = await window.getAdminCompanyContext();
    accountsCompanyId = context.companyId;
    setDefaultDates();
    document.getElementById("refreshFinance")?.addEventListener("click", loadFinance);
    document.getElementById("exportFinance")?.addEventListener("click", exportFinanceCsv);
    const dateGrid = document.getElementById("financeFrom")?.closest(".grid-2");
    if (dateGrid) {
        const label = document.createElement("label");
        label.innerHTML = 'Account customer<select id="financeAccount"><option value="">All accounts</option></select>';
        dateGrid.appendChild(label);
        label.querySelector("select").onchange = renderFinance;
    }
    await loadFinance();
});

async function loadFinance() {
    const from = document.getElementById("financeFrom").value;
    const to = document.getElementById("financeTo").value;
    const [bookingsResult, driversResult, settingsResult, accountsResult] = await Promise.all([
        accountsDb.from("bookings").select("*").eq("company_id", accountsCompanyId).ilike("status", "completed").gte("journey_date", from).lte("journey_date", to).order("journey_date", { ascending: false }),
        accountsDb.from("drivers").select("id,company_id,full_name,commission_percent,pay_type,fixed_job_amount").eq("company_id", accountsCompanyId),
        accountsDb.from("settings").select("company_id,drivercommission,currencysymbol").eq("company_id", accountsCompanyId).maybeSingle(),
        accountsDb.from("account_customers").select("id,company_id,account_code,business_name,status").eq("company_id", accountsCompanyId).order("business_name")
    ]);
    const error = bookingsResult.error || driversResult.error || settingsResult.error || accountsResult.error;
    if (error) return showFinanceError(error);
    financeRows = bookingsResult.data || [];
    financeDrivers = driversResult.data || [];
    financeSettings = settingsResult.data || {};
    financeAccounts = accountsResult.data || [];
    const select = document.getElementById("financeAccount");
    if (select) {
        const current = select.value;
        select.innerHTML = '<option value="">All accounts</option>' + financeAccounts.map(account => `<option value="${esc(account.id)}">${esc(account.account_code)} — ${esc(account.business_name)}</option>`).join("");
        select.value = current;
    }
    renderFinance();
}

function visibleFinanceRows() {
    const accountId = document.getElementById("financeAccount")?.value || "";
    return accountId ? financeRows.filter(job => String(job.account_customer_id || "") === accountId) : financeRows;
}

function renderFinance() {
    const rows = visibleFinanceRows();
    let revenue = 0, paid = 0, driverTotal = 0;
    const split = { cash: 0, card: 0, account: 0 };
    rows.forEach(job => {
        const fare = fareOf(job); revenue += fare;
        if (normal(job.payment_status) === "paid") paid += fare;
        const method = normal(job.payment_method);
        if (method.includes("cash") || method.includes("car")) split.cash += fare;
        else if (method.includes("account") || method.includes("invoice")) split.account += fare;
        else split.card += fare;
        driverTotal += driverPay(job);
    });
    setText("financeRevenue", money(revenue)); setText("financePaid", money(paid)); setText("financeUnpaid", money(revenue - paid));
    setText("financeDriver", money(driverTotal)); setText("financeCompany", money(revenue - driverTotal));
    setText("splitCash", money(split.cash)); setText("splitCard", money(split.card)); setText("splitAccount", money(split.account));
    document.getElementById("completedJobs").innerHTML = rows.length ? rows.map(job => `<tr><td>${esc(job.journey_date)}</td><td>${esc(job.booking_reference || job.id)}</td><td>${esc(job.customer_name || job.full_name || "-")}</td><td>${esc(driverName(job.driver_id))}</td><td>${esc(job.payment_method || "-")}</td><td><select data-payment-job="${esc(job.id)}"><option value="unpaid" ${normal(job.payment_status) !== "paid" ? "selected" : ""}>Unpaid</option><option value="paid" ${normal(job.payment_status) === "paid" ? "selected" : ""}>Paid</option></select></td><td>${money(fareOf(job))}</td></tr>`).join("") : emptyRow(7);
    const unpaid = rows.filter(job => normal(job.payment_status) !== "paid");
    document.getElementById("unpaidJobs").innerHTML = unpaid.length ? unpaid.map(job => `<tr><td>${esc(job.booking_reference || job.id)}</td><td>${esc(job.customer_name || "-")}</td><td>${money(fareOf(job))}</td><td><button data-mark-paid="${esc(job.id)}">Mark paid</button></td></tr>`).join("") : emptyRow(4);
    document.querySelectorAll("[data-payment-job]").forEach(select => select.addEventListener("change", () => updatePayment(select.dataset.paymentJob, select.value)));
    document.querySelectorAll("[data-mark-paid]").forEach(button => button.addEventListener("click", () => updatePayment(button.dataset.markPaid, "paid")));
}

async function updatePayment(id, status) {
    const { error } = await accountsDb.from("bookings").update({ payment_status: status, paid_at: status === "paid" ? new Date().toISOString() : null }).eq("id", id).eq("company_id", accountsCompanyId);
    if (error) return alert(error.message);
    await loadFinance();
}

function driverPay(job) { const driver = financeDrivers.find(row => String(row.id) === String(job.driver_id)); if (!driver) return 0; if (driver.pay_type === "fixed") return Number(driver.fixed_job_amount || 0); const rate = Number(driver.commission_percent ?? financeSettings.drivercommission ?? 0); const commissionBase = job.driver_amount == null ? fareOf(job) : Number(job.driver_amount); return commissionBase - commissionBase * rate / 100; }
function driverName(id) { return financeDrivers.find(row => String(row.id) === String(id))?.full_name || "Unassigned"; }
function fareOf(job) { return Number(job.price ?? job.job_price ?? 0) || 0; }
function money(value) { return `${financeSettings.currencysymbol || "£"}${Number(value || 0).toFixed(2)}`; }
function normal(value) { return String(value || "").trim().toLowerCase(); }
function setDefaultDates() { const now = new Date(); const start = new Date(now.getFullYear(), now.getMonth(), 1); document.getElementById("financeFrom").value = localDate(start); document.getElementById("financeTo").value = localDate(now); }
function localDate(date) { return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`; }
function exportFinanceCsv() { const lines = [["Date","Reference","Customer","Driver","Method","Payment status","Fare"], ...visibleFinanceRows().map(job => [job.journey_date,job.booking_reference,job.customer_name,driverName(job.driver_id),job.payment_method,job.payment_status,fareOf(job)])]; const blob = new Blob([lines.map(row => row.map(csv).join(",")).join("\n")], { type: "text/csv" }); const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = `finance-${document.getElementById("financeFrom").value}-${document.getElementById("financeTo").value}.csv`; link.click(); URL.revokeObjectURL(link.href); }
function csv(value) { return `"${String(value ?? "").replaceAll('"','""')}"`; }
function showFinanceError(error) { console.error(error); alert(`Unable to load finance: ${error.message}`); }
function setText(id,value) { const el=document.getElementById(id); if(el) el.textContent=value; }
function emptyRow(columns) { return `<tr><td colspan="${columns}">No matching jobs.</td></tr>`; }
function esc(value) { return String(value ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;"); }
