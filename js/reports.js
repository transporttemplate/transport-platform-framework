const reportsDb = getSupabase();
let reportsCompanyId = null;
let reportRows = [];
let reportDrivers = [];
let reportCurrency = "£";

document.addEventListener("DOMContentLoaded", async () => {
    try {
        const context = await window.getAdminCompanyContext();
        reportsCompanyId = context.companyId;
        setReportDates();
        document.getElementById("refreshReport")?.addEventListener("click", loadReport);
        document.getElementById("exportReport")?.addEventListener("click", exportReport);
        await loadReport();
    } catch (error) {
        console.error("Reports startup error:", error);
        showReportError("Unable to load the signed-in company.");
    }
});

async function loadReport() {
    const from = document.getElementById("reportFrom").value;
    const to = document.getElementById("reportTo").value;
    const [bookingsResult, driversResult, settingsResult] = await Promise.all([
        reportsDb.from("bookings").select("id,company_id,booking_reference,customer_id,customer_name,driver_id,journey_date,journey_type,airport,status,price,job_price").eq("company_id", reportsCompanyId).gte("journey_date", from).lte("journey_date", to),
        reportsDb.from("drivers").select("id,company_id,driver_number,full_name").eq("company_id", reportsCompanyId),
        reportsDb.from("settings").select("company_id,currencysymbol").eq("company_id", reportsCompanyId).maybeSingle()
    ]);
    const error = bookingsResult.error || driversResult.error || settingsResult.error;
    if (error) return showReportError(error.message);
    reportRows = bookingsResult.data || [];
    reportDrivers = driversResult.data || [];
    reportCurrency = settingsResult.data?.currencysymbol || "£";
    renderReport();
}

function renderReport() {
    const completed = reportRows.filter(row => normalReportStatus(row.status) === "completed");
    const revenue = completed.reduce((sum, row) => sum + reportFare(row), 0);
    const airportCount = reportRows.filter(row => Boolean(row.airport) || normalReportStatus(row.journey_type).includes("airport")).length;
    setReportText("reportRevenue", reportMoney(revenue));
    setReportText("reportBookings", reportRows.length);
    setReportText("reportCompleted", completed.length);
    setReportText("reportJourneySplit", `${airportCount} / ${reportRows.length - airportCount}`);

    const driverStats = reportDrivers.map(driver => {
        const jobs = completed.filter(row => String(row.driver_id) === String(driver.id));
        return { name: driver.full_name || driver.driver_number || "Unnamed driver", jobs: jobs.length, revenue: jobs.reduce((sum, row) => sum + reportFare(row), 0) };
    }).filter(row => row.jobs).sort((a, b) => b.revenue - a.revenue).slice(0, 10);
    document.getElementById("reportDrivers").innerHTML = driverStats.length ? driverStats.map(row => `<tr><td>${reportEsc(row.name)}</td><td>${row.jobs}</td><td>${reportMoney(row.revenue)}</td></tr>`).join("") : reportEmpty(3);

    const customers = new Map();
    completed.forEach(row => {
        const key = row.customer_id || row.customer_name || "Unknown customer";
        const current = customers.get(key) || { name: row.customer_name || "Unknown customer", bookings: 0, spend: 0 };
        current.bookings += 1;
        current.spend += reportFare(row);
        customers.set(key, current);
    });
    const customerStats = [...customers.values()].sort((a, b) => b.spend - a.spend).slice(0, 10);
    document.getElementById("reportCustomers").innerHTML = customerStats.length ? customerStats.map(row => `<tr><td>${reportEsc(row.name)}</td><td>${row.bookings}</td><td>${reportMoney(row.spend)}</td></tr>`).join("") : reportEmpty(3);
}

function exportReport() {
    const lines = [["Date", "Reference", "Customer", "Driver", "Type", "Status", "Fare"], ...reportRows.map(row => [row.journey_date, row.booking_reference, row.customer_name, reportDriverName(row.driver_id), row.airport ? "Airport" : row.journey_type, row.status, reportFare(row)])];
    const blob = new Blob([lines.map(row => row.map(reportCsv).join(",")).join("\n")], { type: "text/csv" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `report-${document.getElementById("reportFrom").value}-${document.getElementById("reportTo").value}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
}

function setReportDates() { const now = new Date(); const start = new Date(now.getFullYear(), now.getMonth(), 1); document.getElementById("reportFrom").value = reportDate(start); document.getElementById("reportTo").value = reportDate(now); }
function reportDate(date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; }
function reportFare(row) { return Number(row.price ?? row.job_price ?? 0) || 0; }
function reportDriverName(id) { return reportDrivers.find(driver => String(driver.id) === String(id))?.full_name || "Unassigned"; }
function normalReportStatus(value) { return String(value || "").trim().toLowerCase().replaceAll(" ", "_"); }
function reportMoney(value) { return `${reportCurrency}${Number(value || 0).toFixed(2)}`; }
function reportCsv(value) { return `"${String(value ?? "").replaceAll('"', '""')}"`; }
function reportEsc(value) { return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;"); }
function reportEmpty(columns) { return `<tr><td colspan="${columns}">No matching data.</td></tr>`; }
function setReportText(id, value) { const element = document.getElementById(id); if (element) element.textContent = value; }
function showReportError(message) { console.error("Reports:", message); document.getElementById("reportDrivers").innerHTML = `<tr><td colspan="3">${reportEsc(message)}</td></tr>`; document.getElementById("reportCustomers").innerHTML = reportEmpty(3); }
