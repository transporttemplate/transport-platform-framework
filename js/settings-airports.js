const airportDb = getSupabase();
let airportSettingsCompanyId = null;

document.addEventListener("DOMContentLoaded", async () => {
    try {
        const context = await window.getAdminCompanyContext();
        airportSettingsCompanyId = context.companyId;

        bindAirportSettingsEvents();
        await Promise.all([loadAirports(), loadServiceAreas()]);
    } catch (error) {
        console.error("Airports and areas startup error:", error);
        renderAirportError("Unable to identify the signed-in company.");
    }
});

function bindAirportSettingsEvents() {
    document.getElementById("addAirport")?.addEventListener("click", () => addAirportRow());
    document.getElementById("saveAirports")?.addEventListener("click", saveAirports);
    document.getElementById("addArea")?.addEventListener("click", () => addServiceAreaRow());
    document.getElementById("saveAreas")?.addEventListener("click", saveServiceAreas);
}

async function loadAirports() {
    const table = document.getElementById("airportTable");
    if (!table || !airportSettingsCompanyId) return;

    table.innerHTML = '<tr><td colspan="10">Loading airports...</td></tr>';

    const { data, error } = await airportDb
        .from("airports")
        .select("id,company_id,name,code,active,price_1_4_oneway,price_1_4_return,price_5_7_oneway,price_5_7_return,deposit_percent,sort_order")
        .eq("company_id", airportSettingsCompanyId)
        .order("sort_order", { ascending: true })
        .order("name", { ascending: true });

    if (error) {
        console.error("Unable to load airports:", error);
        table.innerHTML = `<tr><td colspan="10">Unable to load airports: ${escapeHtml(error.message)}</td></tr>`;
        return;
    }

    table.innerHTML = "";
    if (!data?.length) return addAirportRow();
    data.forEach(airport => addAirportRow(airport));
}

function addAirportRow(airport = {}) {
    const table = document.getElementById("airportTable");
    if (!table) return;

    const row = document.createElement("tr");
    row.dataset.id = airport.id ?? "";
    row.innerHTML = `
        <td><input class="airport-active" type="checkbox" ${airport.active !== false ? "checked" : ""}></td>
        <td><input class="airport-name" type="text" value="${escapeAttribute(airport.name ?? "")}" placeholder="Airport name"></td>
        <td><input class="airport-code" type="text" value="${escapeAttribute(airport.code ?? "")}" placeholder="Code"></td>
        <td><input class="airport-1-4-oneway" type="number" min="0" step="0.01" value="${numberValue(airport.price_1_4_oneway)}"></td>
        <td><input class="airport-1-4-return" type="number" min="0" step="0.01" value="${numberValue(airport.price_1_4_return)}"></td>
        <td><input class="airport-5-7-oneway" type="number" min="0" step="0.01" value="${numberValue(airport.price_5_7_oneway)}"></td>
        <td><input class="airport-5-7-return" type="number" min="0" step="0.01" value="${numberValue(airport.price_5_7_return)}"></td>
        <td><input class="airport-deposit" type="number" min="0" max="100" step="0.01" value="${numberValue(airport.deposit_percent)}"></td>
        <td><input class="airport-sort" type="number" step="1" value="${integerValue(airport.sort_order)}"></td>
        <td><button class="delete-airport" type="button">Delete</button></td>
    `;
    row.querySelector(".delete-airport").addEventListener("click", () => deleteAirportRow(row));
    table.appendChild(row);
}

async function saveAirports() {
    if (!airportSettingsCompanyId) return alert("Unable to identify company.");

    const rows = Array.from(document.querySelectorAll("#airportTable tr"));
    if (!rows.length) return alert("There are no airports to save.");

    for (const row of rows) {
        const name = row.querySelector(".airport-name")?.value.trim() ?? "";
        const code = row.querySelector(".airport-code")?.value.trim().toUpperCase() ?? "";
        if (!name) return alert("Every airport must have a name.");

        const payload = {
            company_id: airportSettingsCompanyId,
            name,
            code: code || null,
            active: row.querySelector(".airport-active")?.checked ?? true,
            price_1_4_oneway: numberOrNull(row.querySelector(".airport-1-4-oneway")?.value),
            price_1_4_return: numberOrNull(row.querySelector(".airport-1-4-return")?.value),
            price_5_7_oneway: numberOrNull(row.querySelector(".airport-5-7-oneway")?.value),
            price_5_7_return: numberOrNull(row.querySelector(".airport-5-7-return")?.value),
            deposit_percent: numberOrNull(row.querySelector(".airport-deposit")?.value),
            sort_order: integerOrZero(row.querySelector(".airport-sort")?.value)
        };

        const existingId = row.dataset.id;
        const result = existingId
            ? await airportDb.from("airports").update(payload).eq("id", existingId).eq("company_id", airportSettingsCompanyId).select("id").maybeSingle()
            : await airportDb.from("airports").insert(payload).select("id").single();

        if (result.error || !result.data) {
            console.error("Unable to save airport:", result.error);
            alert(`Unable to save ${name}: ${result.error?.message || "Record was not available for this company."}`);
            return;
        }
        row.dataset.id = result.data.id;
    }

    alert("Airport prices saved successfully.");
    await loadAirports();
}

async function deleteAirportRow(row) {
    if (!airportSettingsCompanyId) return alert("Unable to identify company.");
    const name = row.querySelector(".airport-name")?.value.trim() || "this airport";
    if (!confirm(`Delete ${name}?`)) return;

    if (row.dataset.id) {
        const { error } = await airportDb
            .from("airports")
            .delete()
            .eq("id", row.dataset.id)
            .eq("company_id", airportSettingsCompanyId);
        if (error) {
            console.error("Unable to delete airport:", error);
            return alert(error.message);
        }
    }

    row.remove();
    if (!document.querySelectorAll("#airportTable tr").length) addAirportRow();
}

async function loadServiceAreas() {
    const table = document.getElementById("serviceAreaTable");
    if (!table || !airportSettingsCompanyId) return;

    table.innerHTML = '<tr><td colspan="6">Loading service areas...</td></tr>';
    const { data, error } = await airportDb
        .from("service_areas")
        .select("id,company_id,area_name,postcode_prefix,radius_miles,active,sort_order")
        .eq("company_id", airportSettingsCompanyId)
        .order("sort_order", { ascending: true })
        .order("area_name", { ascending: true });

    if (error) {
        console.error("Unable to load service areas:", error);
        table.innerHTML = `<tr><td colspan="6">Unable to load service areas: ${escapeHtml(error.message)}</td></tr>`;
        return;
    }

    table.innerHTML = "";
    if (!data?.length) return addServiceAreaRow();
    data.forEach(area => addServiceAreaRow(area));
}

function addServiceAreaRow(area = {}) {
    const table = document.getElementById("serviceAreaTable");
    if (!table) return;

    const row = document.createElement("tr");
    row.dataset.id = area.id ?? "";
    row.innerHTML = `
        <td><input class="area-active" type="checkbox" ${area.active !== false ? "checked" : ""}></td>
        <td><input class="area-name" type="text" value="${escapeAttribute(area.area_name ?? "")}" placeholder="Service area"></td>
        <td><input class="area-postcode" type="text" value="${escapeAttribute(area.postcode_prefix ?? "")}" placeholder="Postcode"></td>
        <td><input class="area-radius" type="number" min="0" step="0.1" value="${numberValue(area.radius_miles)}"></td>
        <td><input class="area-sort" type="number" step="1" value="${integerValue(area.sort_order)}"></td>
        <td><button class="delete-area" type="button">Delete</button></td>
    `;
    row.querySelector(".delete-area").addEventListener("click", () => deleteServiceAreaRow(row));
    table.appendChild(row);
}

async function saveServiceAreas() {
    if (!airportSettingsCompanyId) return alert("Unable to identify company.");

    const rows = Array.from(document.querySelectorAll("#serviceAreaTable tr"));
    if (!rows.length) return alert("There are no service areas to save.");

    for (const row of rows) {
        const areaName = row.querySelector(".area-name")?.value.trim() ?? "";
        if (!areaName) return alert("Every service area must have an area name.");

        const payload = {
            company_id: airportSettingsCompanyId,
            area_name: areaName,
            postcode_prefix: row.querySelector(".area-postcode")?.value.trim().toUpperCase() || null,
            radius_miles: numberOrNull(row.querySelector(".area-radius")?.value),
            active: row.querySelector(".area-active")?.checked ?? true,
            sort_order: integerOrZero(row.querySelector(".area-sort")?.value),
            updated_at: new Date().toISOString()
        };

        const existingId = row.dataset.id;
        const result = existingId
            ? await airportDb.from("service_areas").update(payload).eq("id", existingId).eq("company_id", airportSettingsCompanyId).select("id").maybeSingle()
            : await airportDb.from("service_areas").insert(payload).select("id").single();

        if (result.error || !result.data) {
            console.error("Unable to save service area:", result.error);
            alert(`Unable to save ${areaName}: ${result.error?.message || "Record was not available for this company."}`);
            return;
        }
        row.dataset.id = result.data.id;
    }

    alert("Service areas saved successfully.");
    await loadServiceAreas();
}

async function deleteServiceAreaRow(row) {
    if (!airportSettingsCompanyId) return alert("Unable to identify company.");
    const areaName = row.querySelector(".area-name")?.value.trim() || "this area";
    if (!confirm(`Delete ${areaName}?`)) return;

    if (row.dataset.id) {
        const { error } = await airportDb
            .from("service_areas")
            .delete()
            .eq("id", row.dataset.id)
            .eq("company_id", airportSettingsCompanyId);
        if (error) {
            console.error("Unable to delete service area:", error);
            return alert(error.message);
        }
    }

    row.remove();
    if (!document.querySelectorAll("#serviceAreaTable tr").length) addServiceAreaRow();
}

function renderAirportError(message) {
    const airportTable = document.getElementById("airportTable");
    const areaTable = document.getElementById("serviceAreaTable");
    if (airportTable) airportTable.innerHTML = `<tr><td colspan="10">${escapeHtml(message)}</td></tr>`;
    if (areaTable) areaTable.innerHTML = `<tr><td colspan="6">${escapeHtml(message)}</td></tr>`;
}

function numberOrNull(value) {
    if (value === undefined || value === null || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function integerOrZero(value) {
    const number = Number.parseInt(value, 10);
    return Number.isFinite(number) ? number : 0;
}

function numberValue(value) {
    return value === undefined || value === null ? "" : value;
}

function integerValue(value) {
    return value === undefined || value === null ? 0 : value;
}

function escapeHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

function escapeAttribute(value) {
    return escapeHtml(value);
}
