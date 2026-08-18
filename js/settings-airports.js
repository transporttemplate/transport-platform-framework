const airportDb = getSupabase();

document.addEventListener("DOMContentLoaded", () => {
    loadAirports();
    loadServiceAreas();

    const addAirportButton = document.getElementById("addAirport");
    const saveAirportsButton = document.getElementById("saveAirports");
    const addAreaButton = document.getElementById("addArea");
    const saveAreasButton = document.getElementById("saveAreas");

    if (addAirportButton) {
        addAirportButton.addEventListener("click", () => addAirportRow());
    }

    if (saveAirportsButton) {
        saveAirportsButton.addEventListener("click", saveAirports);
    }

    if (addAreaButton) {
        addAreaButton.addEventListener("click", () => addServiceAreaRow());
    }

    if (saveAreasButton) {
        saveAreasButton.addEventListener("click", saveServiceAreas);
    }
});


async function loadAirports() {
    const table = document.getElementById("airportTable");
    if (!table) return;

    table.innerHTML = '<tr><td colspan="10">Loading airports...</td></tr>';

    const { data, error } = await airportDb
        .from("airports")
        .select(`
            id,
            name,
            code,
            active,
            price_1_4_oneway,
            price_1_4_return,
            price_5_7_oneway,
            price_5_7_return,
            deposit_percent,
            sort_order
        `)
        .order("sort_order", { ascending: true })
        .order("name", { ascending: true });

    if (error) {
        console.error("Unable to load airports:", error);
        table.innerHTML = `<tr><td colspan="10">Unable to load airports: ${escapeHtml(error.message)}</td></tr>`;
        return;
    }

    table.innerHTML = "";

    if (!data || data.length === 0) {
        addAirportRow();
        return;
    }

    data.forEach((airport) => addAirportRow(airport));
}


function addAirportRow(airport = {}) {
    const table = document.getElementById("airportTable");
    if (!table) return;

    const row = document.createElement("tr");

    row.dataset.id = airport.id ?? "";

    row.innerHTML = `
        <td>
            <input class="airport-active" type="checkbox" ${airport.active !== false ? "checked" : ""}>
        </td>

        <td>
            <input class="airport-name" type="text" value="${escapeAttribute(airport.name ?? "")}" placeholder="Bristol Airport">
        </td>

        <td>
            <input class="airport-code" type="text" value="${escapeAttribute(airport.code ?? "")}" placeholder="BRS">
        </td>

        <td>
            <input class="airport-1-4-oneway" type="number" min="0" step="0.01" value="${numberValue(airport.price_1_4_oneway)}">
        </td>

        <td>
            <input class="airport-1-4-return" type="number" min="0" step="0.01" value="${numberValue(airport.price_1_4_return)}">
        </td>

        <td>
            <input class="airport-5-7-oneway" type="number" min="0" step="0.01" value="${numberValue(airport.price_5_7_oneway)}">
        </td>

        <td>
            <input class="airport-5-7-return" type="number" min="0" step="0.01" value="${numberValue(airport.price_5_7_return)}">
        </td>

        <td>
            <input class="airport-deposit" type="number" min="0" max="100" step="0.01" value="${numberValue(airport.deposit_percent)}">
        </td>

        <td>
            <input class="airport-sort" type="number" step="1" value="${integerValue(airport.sort_order)}">
        </td>

        <td>
            <button class="delete-airport" type="button">Delete</button>
        </td>
    `;

    row.querySelector(".delete-airport").addEventListener("click", async () => {
        await deleteAirportRow(row);
    });

    table.appendChild(row);
}


async function saveAirports() {
    const rows = Array.from(document.querySelectorAll("#airportTable tr"));

    if (rows.length === 0) {
        alert("There are no airports to save.");
        return;
    }

    for (const row of rows) {
        const name = row.querySelector(".airport-name")?.value.trim() ?? "";
        const code = row.querySelector(".airport-code")?.value.trim().toUpperCase() ?? "";

        if (!name) {
            alert("Every airport must have a name.");
            return;
        }

        const payload = {
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

        let result;

        if (existingId) {
            result = await airportDb
                .from("airports")
                .update(payload)
                .eq("id", existingId)
                .select("id")
                .single();
        } else {
            result = await airportDb
                .from("airports")
                .insert(payload)
                .select("id")
                .single();
        }

        if (result.error) {
            console.error("Unable to save airport:", result.error);
            alert(`Unable to save ${name}: ${result.error.message}`);
            return;
        }

        row.dataset.id = result.data.id;
    }

    alert("Airport prices saved successfully.");
    await loadAirports();
}


async function deleteAirportRow(row) {
    const name = row.querySelector(".airport-name")?.value.trim() || "this airport";

    if (!confirm(`Delete ${name}?`)) return;

    const id = row.dataset.id;

    if (id) {
        const { error } = await airportDb
            .from("airports")
            .delete()
            .eq("id", id);

        if (error) {
            console.error("Unable to delete airport:", error);
            alert(error.message);
            return;
        }
    }

    row.remove();

    if (document.querySelectorAll("#airportTable tr").length === 0) {
        addAirportRow();
    }
}


async function loadServiceAreas() {
    const table = document.getElementById("serviceAreaTable");
    if (!table) return;

    table.innerHTML = '<tr><td colspan="6">Loading service areas...</td></tr>';

    const { data, error } = await airportDb
        .from("service_areas")
        .select(`
            id,
            area_name,
            postcode_prefix,
            radius_miles,
            active,
            sort_order
        `)
        .order("sort_order", { ascending: true })
        .order("area_name", { ascending: true });

    if (error) {
        console.error("Unable to load service areas:", error);
        table.innerHTML = `<tr><td colspan="6">Unable to load service areas: ${escapeHtml(error.message)}</td></tr>`;
        return;
    }

    table.innerHTML = "";

    if (!data || data.length === 0) {
        addServiceAreaRow();
        return;
    }

    data.forEach((area) => addServiceAreaRow(area));
}


function addServiceAreaRow(area = {}) {
    const table = document.getElementById("serviceAreaTable");
    if (!table) return;

    const row = document.createElement("tr");

    row.dataset.id = area.id ?? "";

    row.innerHTML = `
        <td>
            <input class="area-active" type="checkbox" ${area.active !== false ? "checked" : ""}>
        </td>

        <td>
            <input class="area-name" type="text" value="${escapeAttribute(area.area_name ?? "")}" placeholder="Barry">
        </td>

        <td>
            <input class="area-postcode" type="text" value="${escapeAttribute(area.postcode_prefix ?? "")}" placeholder="CF62">
        </td>

        <td>
            <input class="area-radius" type="number" min="0" step="0.1" value="${numberValue(area.radius_miles)}">
        </td>

        <td>
            <input class="area-sort" type="number" step="1" value="${integerValue(area.sort_order)}">
        </td>

        <td>
            <button class="delete-area" type="button">Delete</button>
        </td>
    `;

    row.querySelector(".delete-area").addEventListener("click", async () => {
        await deleteServiceAreaRow(row);
    });

    table.appendChild(row);
}


async function saveServiceAreas() {
    const rows = Array.from(document.querySelectorAll("#serviceAreaTable tr"));

    if (rows.length === 0) {
        alert("There are no service areas to save.");
        return;
    }

    for (const row of rows) {
        const areaName = row.querySelector(".area-name")?.value.trim() ?? "";

        if (!areaName) {
            alert("Every service area must have an area name.");
            return;
        }

        const payload = {
            area_name: areaName,
            postcode_prefix: row.querySelector(".area-postcode")?.value.trim().toUpperCase() || null,
            radius_miles: numberOrNull(row.querySelector(".area-radius")?.value),
            active: row.querySelector(".area-active")?.checked ?? true,
            sort_order: integerOrZero(row.querySelector(".area-sort")?.value),
            updated_at: new Date().toISOString()
        };

        const existingId = row.dataset.id;

        let result;

        if (existingId) {
            result = await airportDb
                .from("service_areas")
                .update(payload)
                .eq("id", existingId)
                .select("id")
                .single();
        } else {
            result = await airportDb
                .from("service_areas")
                .insert(payload)
                .select("id")
                .single();
        }

        if (result.error) {
            console.error("Unable to save service area:", result.error);
            alert(`Unable to save ${areaName}: ${result.error.message}`);
            return;
        }

        row.dataset.id = result.data.id;
    }

    alert("Service areas saved successfully.");
    await loadServiceAreas();
}


async function deleteServiceAreaRow(row) {
    const areaName = row.querySelector(".area-name")?.value.trim() || "this area";

    if (!confirm(`Delete ${areaName}?`)) return;

    const id = row.dataset.id;

    if (id) {
        const { error } = await airportDb
            .from("service_areas")
            .delete()
            .eq("id", id);

        if (error) {
            console.error("Unable to delete service area:", error);
            alert(error.message);
            return;
        }
    }

    row.remove();

    if (document.querySelectorAll("#serviceAreaTable tr").length === 0) {
        addServiceAreaRow();
    }
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
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}


function escapeAttribute(value) {
    return escapeHtml(value);
}
