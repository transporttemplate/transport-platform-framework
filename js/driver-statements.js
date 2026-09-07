const statementDb = getSupabase();
let statementCompanyId = null;
let statementDrivers = [];
let statementSettings = {};
let calculatedItems = [];
let currentStatement = null;
let savedStatements = [];
let statementCompany = {};

document.addEventListener("DOMContentLoaded", async () => {
    try {
        const context = await window.getAdminCompanyContext();
        statementCompanyId = context.companyId;
        statementCompany = context.company || {};
        defaults();
        document.getElementById("calculateStatement").onclick = calculateStatement;
        document.getElementById("finaliseStatement").onclick = finaliseStatement;
        document.getElementById("markStatementPaid").onclick = markPaid;
        document.getElementById("emailStatement").onclick = emailStatement;
        await loadBase();
    } catch (error) {
        console.error("Driver statements startup error:", error);
        setDriverOptions([], "Unable to load drivers for this company");
    }
});

async function loadBase() {
    const [driversResult, settingsResult, statementsResult] = await Promise.all([
        statementDb.from("drivers")
            .select("id,company_id,full_name,driver_number,email,status,online,pay_type,commission_percent,fixed_job_amount")
            .eq("company_id", statementCompanyId)
            .order("driver_number", { ascending: true })
            .order("full_name", { ascending: true }),
        statementDb.from("settings")
            .select("company_id,drivercommission,currencysymbol,statementprefix,companyname,tradingname,companylogo,companyaddress,companyphone,companyemail,primarycolour")
            .eq("company_id", statementCompanyId)
            .maybeSingle(),
        statementDb.from("driver_statements")
            .select("*")
            .eq("company_id", statementCompanyId)
            .order("created_at", { ascending: false })
    ]);

    if (driversResult.error) {
        console.error("Driver load error:", driversResult.error);
        setDriverOptions([], "Unable to load drivers for this company");
    } else {
        statementDrivers = driversResult.data || [];
        setDriverOptions(statementDrivers);
    }
    if (settingsResult.error) console.error("Statement settings load error:", settingsResult.error);
    else statementSettings = settingsResult.data || {};
    if (statementsResult.error) {
        console.error("Saved statements load error:", statementsResult.error);
        savedStatements = [];
        renderSaved(statementsResult.error.message);
    } else {
        savedStatements = statementsResult.data || [];
        renderSaved();
    }
}

function setDriverOptions(drivers, errorMessage = "") {
    const select = document.getElementById("statementDriver");
    if (!select) return;
    if (errorMessage) {
        select.innerHTML = `<option value="">${esc(errorMessage)}</option>`;
        select.disabled = true;
        return;
    }
    select.disabled = false;
    if (!drivers.length) {
        select.innerHTML = '<option value="">No drivers found for this company</option>';
        return;
    }
    select.innerHTML = '<option value="">Select driver</option>' + drivers.map(driver => {
        const number = driver.driver_number || "No number";
        const name = driver.full_name || "Unnamed driver";
        return `<option value="${esc(driver.id)}">${esc(number)} — ${esc(name)}</option>`;
    }).join("");
}

async function calculateStatement() {
    const driver = selectedDriver();
    if (!driver) return alert("Select a driver.");
    const from = document.getElementById("statementFrom").value;
    const to = document.getElementById("statementTo").value;
    const { data, error } = await statementDb.from("bookings")
        .select("id,company_id,booking_reference,journey_date,journey_time,pickup_address,dropoff_address,price,job_price,driver_amount")
        .eq("company_id", statementCompanyId)
        .eq("driver_id", driver.id)
        .eq("status", "completed")
        .gte("journey_date", from)
        .lte("journey_date", to)
        .order("journey_date");
    if (error) return alert(error.message);

    calculatedItems = (data || []).map(job => statementItemFromBooking(job, driver));
    currentStatement = null;
    renderCalculation();
}

function statementItemFromBooking(job, driver) {
    const legacyFare = Number(job.price ?? job.job_price ?? 0) || 0;
    const commissionBase = job.driver_amount == null ? legacyFare : Number(job.driver_amount);
    const fixedPay = driver.pay_type === "fixed";
    const rate = fixedPay ? 0 : Number(driver.commission_percent ?? statementSettings.drivercommission ?? 0);
    const driverDue = roundMoney(fixedPay
        ? Number(driver.fixed_job_amount || 0)
        : commissionBase - (commissionBase * rate / 100));
    const commission = roundMoney(Math.max(commissionBase - driverDue, 0));
    return { job, commissionBase, rate, commission, driverDue, fixedPay };
}

function renderCalculation() {
    const driverAmount = sum("commissionBase");
    const commission = sum("commission");
    const driverDue = sum("driverDue");
    const driver = selectedDriver() || {};
    const companyName = statementSettings.tradingname || statementSettings.companyname || statementCompany.trading_name || statementCompany.name || "Company";
    const logo = safeImage(statementSettings.companylogo);
    const number = currentStatement?.statement_number || "Draft statement";
    document.title = currentStatement ? `${clean(number)}_${clean(driver.full_name)}.pdf` : "Driver statement";
    document.getElementById("statementDocument").style.setProperty("--document-accent", safeColour(statementSettings.primarycolour));
    document.getElementById("statementSummary").innerHTML = `<header class="document-brand"><div>${logo ? `<img src="${esc(logo)}" alt="${esc(companyName)} logo">` : `<div class="document-logo-fallback">${esc(companyName)}</div>`}<p>${nl(esc(statementSettings.companyaddress || ""))}<br>${esc(statementSettings.companyphone || "")}<br>${esc(statementSettings.companyemail || "")}</p></div><div class="document-title"><h1>REMITTANCE</h1><strong>${esc(number)}</strong><p>${esc(document.getElementById("statementFrom").value)} – ${esc(document.getElementById("statementTo").value)}</p><span class="document-status">${esc(currentStatement?.status || "draft")}</span></div></header><section class="document-meta"><div><h3>Driver</h3><strong>${esc(driver.full_name || "")}</strong><p>Driver number: ${esc(driver.driver_number || "—")}</p></div><div><h3>Totals</h3><p>Driver amount: ${money(driverAmount)}<br>Commission: ${money(commission)}<br><strong>Driver due: ${money(driverDue)}</strong>${currentStatement?.paid_at ? `<br>Paid: ${new Date(currentStatement.paid_at).toLocaleString("en-GB")}` : ""}</p></div></section>`;
    document.getElementById("statementItems").innerHTML = calculatedItems.length
        ? calculatedItems.map(item => `
            <tr>
                <td>${esc(item.job.journey_date)}</td>
                <td>${esc(String(item.job.journey_time || "").slice(0,5) || "—")}</td>
                <td>${esc(item.job.booking_reference || item.job.id)}</td>
                <td class="route-cell">${esc(item.job.pickup_address || "—")} → ${esc(item.job.dropoff_address || "—")}</td>
                <td>${money(item.job.price ?? item.job.job_price ?? item.commissionBase)}</td>
                <td>${money(item.commissionBase)}</td>
                <td>${item.fixedPay ? "Fixed" : `${esc(item.rate)}%`}</td>
                <td>${money(item.commission)}</td>
                <td>${money(item.driverDue)}</td>
            </tr>
        `).join("")
        : '<tr><td colspan="9">No completed jobs.</td></tr>';
}

async function finaliseStatement() {
    if (currentStatement) return alert("This statement is already saved.");
    if (!calculatedItems.length) return alert("Calculate a statement with jobs first.");
    const driver = selectedDriver();
    const from = document.getElementById("statementFrom").value;
    const to = document.getElementById("statementTo").value;
    const prefix = String(statementSettings.statementprefix || "STM").replace(/[^a-z0-9_-]/gi, "") || "STM";
    const number = `${prefix}-${new Date().getFullYear()}-${String(savedStatements.length + 1).padStart(4, "0")}`;
    const payload = {
        company_id: statementCompanyId,
        driver_id: driver.id,
        statement_number: number,
        period_start: from,
        period_end: to,
        status: "finalised",
        gross_total: sum("commissionBase"),
        driver_total: sum("driverDue"),
        company_total: sum("commission"),
        finalised_at: new Date().toISOString(),
        file_name: `${clean(number)}_${clean(driver.full_name)}.pdf`
    };
    const { data, error } = await statementDb.from("driver_statements").insert(payload).select("*").single();
    if (error) return alert(error.message);
    const items = calculatedItems.map(item => ({
        company_id: statementCompanyId,
        statement_id: data.id,
        booking_id: item.job.id,
        gross_fare: item.commissionBase,
        commission_percent: item.rate,
        driver_amount: item.driverDue,
        company_amount: item.commission,
        booking_reference: item.job.booking_reference || null,
        job_date: item.job.journey_date || null,
        job_time: item.job.journey_time || null,
        pickup_address: item.job.pickup_address || null,
        dropoff_address: item.job.dropoff_address || null
    }));
    const result = await statementDb.from("driver_statement_items").insert(items);
    if (result.error) return alert(result.error.message);
    currentStatement = data;
    await loadBase();
    renderCalculation();
}

async function markPaid() {
    if (!currentStatement) return alert("Finalise or open a statement first.");
    const { error } = await statementDb.from("driver_statements")
        .update({ status: "paid", paid_at: new Date().toISOString() })
        .eq("id", currentStatement.id)
        .eq("company_id", statementCompanyId);
    if (error) return alert(error.message);
    currentStatement.status = "paid";
    renderCalculation();
    await loadBase();
}

async function emailStatement() {
    if (!currentStatement) return alert("Finalise the statement first.");
    const { data, error } = await statementDb.functions.invoke("send-driver-statement-email", {
        body: { company_id: statementCompanyId, statement_id: currentStatement.id }
    });
    if (error || !data?.ok) return alert(data?.error || error?.message || "Unable to send.");
    alert("Remittance email sent.");
}

function renderSaved(errorMessage = "") {
    document.getElementById("savedStatements").innerHTML = errorMessage
        ? `<tr><td colspan="6">Unable to load saved statements: ${esc(errorMessage)}</td></tr>`
        : savedStatements.map(statement => `
            <tr>
                <td>${esc(statement.statement_number)}</td>
                <td>${esc(statementDrivers.find(driver => driver.id === statement.driver_id)?.full_name || statement.driver_id)}</td>
                <td>${esc(statement.period_start)} – ${esc(statement.period_end)}</td>
                <td>${money(statement.driver_total)}</td>
                <td>${esc(statement.status)}</td>
                <td><button data-open-statement="${esc(statement.id)}">Open</button></td>
            </tr>
        `).join("") || '<tr><td colspan="6">No saved statements.</td></tr>';
    document.querySelectorAll("[data-open-statement]").forEach(button => {
        button.onclick = () => openStatement(button.dataset.openStatement);
    });
}

async function openStatement(id) {
    currentStatement = savedStatements.find(statement => statement.id === id);
    if (!currentStatement) return alert("The saved statement could not be found. Refresh and try again.");
    document.getElementById("statementDriver").value = currentStatement.driver_id;
    document.getElementById("statementFrom").value = currentStatement.period_start;
    document.getElementById("statementTo").value = currentStatement.period_end;
    const { data, error } = await statementDb.from("driver_statement_items")
        .select("gross_fare,commission_percent,driver_amount,company_amount,booking_reference,job_date,job_time,pickup_address,dropoff_address,bookings(booking_reference,journey_date,journey_time,pickup_address,dropoff_address)")
        .eq("company_id", statementCompanyId)
        .eq("statement_id", id);
    if (error) return alert(error.message);
    const driver = selectedDriver();
    calculatedItems = (data || []).map(item => {
        const booking = Array.isArray(item.bookings) ? item.bookings[0] : item.bookings;
        const commissionBase = Number(item.gross_fare || 0);
        const driverDue = Number(item.driver_amount || 0);
        return {
            job: {
                booking_reference: item.booking_reference || booking?.booking_reference,
                journey_date: item.job_date || booking?.journey_date,
                journey_time: item.job_time || booking?.journey_time,
                pickup_address: item.pickup_address || booking?.pickup_address,
                dropoff_address: item.dropoff_address || booking?.dropoff_address,
                price: item.gross_fare
            },
            commissionBase,
            rate: Number(item.commission_percent || 0),
            commission: roundMoney(Math.max(commissionBase - driverDue, 0)),
            driverDue,
            fixedPay: driver?.pay_type === "fixed"
        };
    });
    renderCalculation();
}

function selectedDriver() {
    return statementDrivers.find(driver => driver.id === document.getElementById("statementDriver").value);
}
function sum(key) {
    return calculatedItems.reduce((total, item) => total + Number(item[key] || 0), 0);
}
function money(value) {
    return `${statementSettings.currencysymbol || "£"}${Number(value || 0).toFixed(2)}`;
}
function roundMoney(value) {
    return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}
function defaults() {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    document.getElementById("statementFrom").value = start.toISOString().slice(0, 10);
    document.getElementById("statementTo").value = now.toISOString().slice(0, 10);
}
function clean(value) { return String(value || "document").normalize("NFKD").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 80) || "document"; }
function safeColour(value) { return /^#[0-9a-f]{6}$/i.test(String(value || "")) ? value : "#0f766e"; }
function safeImage(value) { try { const url = new URL(String(value || ""), location.href); return ["https:", "http:"].includes(url.protocol) ? url.href : ""; } catch { return ""; } }
function nl(value) { return String(value).replaceAll("\n", "<br>"); }
function esc(value) {
    return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
