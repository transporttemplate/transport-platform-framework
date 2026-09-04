const statementDb = getSupabase();
let statementCompanyId = null;
let statementDrivers = [];
let statementSettings = {};
let calculatedItems = [];
let currentStatement = null;
let savedStatements = [];

document.addEventListener("DOMContentLoaded", async () => {
    try {
        const context = await window.getAdminCompanyContext();
        statementCompanyId = context.companyId;
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
            .select("company_id,drivercommission,currencysymbol")
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
        .select("id,company_id,booking_reference,journey_date,price,job_price,driver_amount")
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
    document.getElementById("statementSummary").innerHTML = `
        <h3>${esc(selectedDriver()?.full_name || "")}</h3>
        <p>Driver Amount: ${money(driverAmount)} | Commission: ${money(commission)} | Driver Due: ${money(driverDue)}${currentStatement ? ` | Status: ${esc(currentStatement.status)}` : ""}</p>
    `;
    document.getElementById("statementItems").innerHTML = calculatedItems.length
        ? calculatedItems.map(item => `
            <tr>
                <td>${esc(item.job.journey_date)}</td>
                <td>${esc(item.job.booking_reference || item.job.id)}</td>
                <td>${money(item.commissionBase)}</td>
                <td>${item.fixedPay ? "Fixed" : `${esc(item.rate)}%`}</td>
                <td>${money(item.commission)}</td>
                <td>${money(item.driverDue)}</td>
            </tr>
        `).join("")
        : '<tr><td colspan="6">No completed jobs.</td></tr>';
}

async function finaliseStatement() {
    if (currentStatement) return alert("This statement is already saved.");
    if (!calculatedItems.length) return alert("Calculate a statement with jobs first.");
    const driver = selectedDriver();
    const from = document.getElementById("statementFrom").value;
    const to = document.getElementById("statementTo").value;
    const number = `REM-${new Date().getFullYear()}-${String(savedStatements.length + 1).padStart(4, "0")}`;
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
        finalised_at: new Date().toISOString()
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
        company_amount: item.commission
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
    document.getElementById("statementDriver").value = currentStatement.driver_id;
    document.getElementById("statementFrom").value = currentStatement.period_start;
    document.getElementById("statementTo").value = currentStatement.period_end;
    const { data, error } = await statementDb.from("driver_statement_items")
        .select("gross_fare,commission_percent,driver_amount,bookings(booking_reference,journey_date,driver_amount)")
        .eq("company_id", statementCompanyId)
        .eq("statement_id", id);
    if (error) return alert(error.message);
    const driver = selectedDriver();
    calculatedItems = (data || []).map(item => {
        const commissionBase = item.bookings?.driver_amount == null
            ? Number(item.gross_fare || 0)
            : Number(item.bookings.driver_amount);
        const driverDue = Number(item.driver_amount || 0);
        return {
            job: {
                booking_reference: item.bookings?.booking_reference,
                journey_date: item.bookings?.journey_date
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
function esc(value) {
    return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
