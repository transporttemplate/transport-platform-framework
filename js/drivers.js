const driversDb = getSupabase();

let currentCompanyId = null;
let allDrivers = [];
let selectedDriver = null;

document.addEventListener("DOMContentLoaded", async () => {
    bindDriverManagementUI();
    currentCompanyId = await resolveCurrentCompanyId();

    if (!currentCompanyId) {
        renderDriverError("No company is currently selected/logged in.");
        return;
    }

    await loadDrivers();
});

function bindDriverManagementUI() {
    document.getElementById("addDriverButton")?.addEventListener("click", () => openDriverForm());

    document.getElementById("closeDriverModalButton")?.addEventListener("click", closeDriverForm);
    document.getElementById("cancelDriverButton")?.addEventListener("click", closeDriverForm);
    document.getElementById("driverModalBackdrop")?.addEventListener("click", event => {
        if (event.target.id === "driverModalBackdrop") closeDriverForm();
    });

    document.getElementById("driverForm")?.addEventListener("submit", saveDriver);

    document.getElementById("closeViewDriverButton")?.addEventListener("click", closeViewDriver);
    document.getElementById("closeViewDriverBottomButton")?.addEventListener("click", closeViewDriver);
    document.getElementById("viewDriverBackdrop")?.addEventListener("click", event => {
        if (event.target.id === "viewDriverBackdrop") closeViewDriver();
    });

    document.getElementById("editDriverButton")?.addEventListener("click", () => {
        if (!selectedDriver) return;
        closeViewDriver();
        openDriverForm(selectedDriver);
    });

    document.getElementById("driverNameSearch")?.addEventListener("input", renderDrivers);
    document.getElementById("driverPhoneSearch")?.addEventListener("input", renderDrivers);
    document.getElementById("driverStatusFilter")?.addEventListener("change", renderDrivers);
    document.getElementById("driverVehicleFilter")?.addEventListener("change", renderDrivers);
}

async function resolveCurrentCompanyId() {
    const candidates = [
        localStorage.getItem("company_id"),
        localStorage.getItem("companyId"),
        sessionStorage.getItem("company_id"),
        sessionStorage.getItem("companyId")
    ].filter(Boolean);

    if (candidates.length) return candidates[0];

    try {
        const authKeys = ["currentCompany", "company", "loggedInCompany", "adminCompany"];
        for (const key of authKeys) {
            const raw = localStorage.getItem(key) || sessionStorage.getItem(key);
            if (!raw) continue;

            try {
                const obj = JSON.parse(raw);
                if (obj?.id) return obj.id;
                if (obj?.company_id) return obj.company_id;
            } catch (_) {}
        }

        const { data, error } = await driversDb
            .from("companies")
            .select("id")
            .limit(1)
            .maybeSingle();

        if (!error && data?.id) return data.id;
    } catch (error) {
        console.error("Company resolution error:", error);
    }

    return null;
}

async function loadDrivers() {
    const body = document.getElementById("driversTableBody");
    if (body) body.innerHTML = '<tr><td colspan="8" class="muted">Loading drivers...</td></tr>';

    const { data, error } = await driversDb
        .from("drivers")
        .select("*")
        .eq("company_id", currentCompanyId)
        .order("full_name", { ascending: true });

    if (error) {
        console.error("Driver load error:", error);
        renderDriverError(error.message);
        return;
    }

    allDrivers = data || [];
    buildVehicleFilter();
    updateDriverStats();
    renderDrivers();
}

function renderDrivers() {
    const body = document.getElementById("driversTableBody");
    if (!body) return;

    const nameSearch = (document.getElementById("driverNameSearch")?.value || "").trim().toLowerCase();
    const phoneSearch = (document.getElementById("driverPhoneSearch")?.value || "").trim().toLowerCase();
    const statusFilter = (document.getElementById("driverStatusFilter")?.value || "").trim().toLowerCase();
    const vehicleFilter = (document.getElementById("driverVehicleFilter")?.value || "").trim().toLowerCase();

    const filtered = allDrivers.filter(driver => {
        const name = String(driver.full_name || "").toLowerCase();
        const phone = String(driver.phone || "").toLowerCase();
        const vehicle = String(driver.vehicle || "").toLowerCase();
        const displayStatus = getDisplayStatus(driver).toLowerCase();

        if (nameSearch && !name.includes(nameSearch)) return false;
        if (phoneSearch && !phone.includes(phoneSearch)) return false;
        if (statusFilter && displayStatus !== statusFilter) return false;
        if (vehicleFilter && vehicle !== vehicleFilter) return false;

        return true;
    });

    if (!filtered.length) {
        body.innerHTML = '<tr><td colspan="8" class="muted">No drivers found.</td></tr>';
        return;
    }

    body.innerHTML = filtered.map(driver => `
        <tr>
            <td>${escapeHtml(driver.full_name || "Unnamed")}</td>
            <td>${escapeHtml(driver.driver_number || "-")}</td>
            <td>${statusHtml(driver)}</td>
            <td>${escapeHtml(driver.vehicle || "-")}</td>
            <td>${Number(driver.today_jobs || 0)}</td>
            <td>${escapeHtml(driver.phone || "-")}</td>
            <td>${escapeHtml(licenceText(driver))}</td>
            <td>
                <button type="button" data-view-driver="${escapeHtml(driver.id)}">View</button>
            </td>
        </tr>
    `).join("");

    body.querySelectorAll("[data-view-driver]").forEach(button => {
        button.addEventListener("click", () => {
            const driver = allDrivers.find(row => String(row.id) === String(button.dataset.viewDriver));
            if (driver) openViewDriver(driver);
        });
    });
}

function buildVehicleFilter() {
    const select = document.getElementById("driverVehicleFilter");
    if (!select) return;

    const current = select.value;
    const vehicles = [...new Set(
        allDrivers
            .map(driver => String(driver.vehicle || "").trim())
            .filter(Boolean)
    )].sort((a, b) => a.localeCompare(b));

    select.innerHTML = '<option value="">All Vehicles</option>' +
        vehicles.map(vehicle => `<option value="${escapeHtml(vehicle)}">${escapeHtml(vehicle)}</option>`).join("");

    if ([...select.options].some(option => option.value === current)) {
        select.value = current;
    }
}

function updateDriverStats() {
    const total = allDrivers.length;
    const online = allDrivers.filter(driver => Boolean(driver.online)).length;
    const onJob = allDrivers.filter(driver => getDisplayStatus(driver).toLowerCase() === "on job").length;
    const offline = allDrivers.filter(driver => !driver.online && getDisplayStatus(driver).toLowerCase() !== "on job").length;

    setText("statTotalDrivers", total);
    setText("statOnlineDrivers", online);
    setText("statOnJobDrivers", onJob);
    setText("statOfflineDrivers", offline);
}

function openDriverForm(driver = null) {
    const isEdit = Boolean(driver);

    setText("driverModalTitle", isEdit ? "Edit Driver" : "Add Driver");

    document.getElementById("driverId").value = driver?.id || "";
    document.getElementById("driverFullName").value = driver?.full_name || "";
    document.getElementById("driverNumberInput").value = driver?.driver_number || "";
    document.getElementById("driverPinInput").value = driver?.pin || "";
    document.getElementById("driverPhoneInput").value = driver?.phone || "";
    document.getElementById("driverEmailInput").value = driver?.email || "";
    document.getElementById("driverVehicleInput").value = driver?.vehicle || "";
    document.getElementById("driverLicenceInput").value = driver?.licence_number || "";
    document.getElementById("driverLicenceExpiryInput").value = driver?.licence_expiry || "";
    document.getElementById("driverStatusInput").value = driver?.status || "available";
    document.getElementById("driverOnlineInput").value = String(Boolean(driver?.online));

    document.getElementById("driverModalBackdrop")?.classList.add("open");
}

function closeDriverForm() {
    document.getElementById("driverModalBackdrop")?.classList.remove("open");
    document.getElementById("driverForm")?.reset();
    document.getElementById("driverId").value = "";
}

async function saveDriver(event) {
    event.preventDefault();

    const id = document.getElementById("driverId").value.trim();

    const payload = {
        company_id: currentCompanyId,
        full_name: document.getElementById("driverFullName").value.trim(),
        driver_number: document.getElementById("driverNumberInput").value.trim(),
        pin: document.getElementById("driverPinInput").value.trim(),
        phone: document.getElementById("driverPhoneInput").value.trim() || null,
        email: document.getElementById("driverEmailInput").value.trim() || null,
        vehicle: document.getElementById("driverVehicleInput").value.trim() || null,
        licence_number: document.getElementById("driverLicenceInput").value.trim() || null,
        licence_expiry: document.getElementById("driverLicenceExpiryInput").value || null,
        status: document.getElementById("driverStatusInput").value,
        online: document.getElementById("driverOnlineInput").value === "true"
    };

    if (!payload.full_name || !payload.driver_number || !payload.pin) {
        alert("Full Name, Driver Number and PIN are required.");
        return;
    }

    const duplicateNumber = allDrivers.find(driver =>
        String(driver.driver_number || "").trim() === payload.driver_number &&
        String(driver.id) !== String(id)
    );

    if (duplicateNumber) {
        alert("That driver number is already in use.");
        return;
    }

    let result;

    if (id) {
        result = await driversDb
            .from("drivers")
            .update(payload)
            .eq("id", id)
            .eq("company_id", currentCompanyId);
    } else {
        result = await driversDb
            .from("drivers")
            .insert(payload);
    }

    if (result.error) {
        console.error("Save driver error:", result.error);
        alert(`Unable to save driver.\n\n${result.error.message}`);
        return;
    }

    closeDriverForm();
    await loadDrivers();
}

function openViewDriver(driver) {
    selectedDriver = driver;

    const content = document.getElementById("driverViewContent");
    if (!content) return;

    content.innerHTML = [
        viewItem("Full Name", driver.full_name || "-"),
        viewItem("Driver Number", driver.driver_number || "-"),
        viewItem("PIN", driver.pin || "-"),
        viewItem("Phone", driver.phone || "-"),
        viewItem("Email", driver.email || "-"),
        viewItem("Vehicle", driver.vehicle || "-"),
        viewItem("Status", getDisplayStatus(driver)),
        viewItem("Online", driver.online ? "Yes" : "No"),
        viewItem("Licence Number", driver.licence_number || "-"),
        viewItem("Licence Expiry", driver.licence_expiry || "-"),
        viewItem("Company ID", driver.company_id || "-"),
        viewItem("Driver ID", driver.id || "-")
    ].join("");

    document.getElementById("viewDriverBackdrop")?.classList.add("open");
}

function closeViewDriver() {
    document.getElementById("viewDriverBackdrop")?.classList.remove("open");
}

function getDisplayStatus(driver) {
    const status = String(driver.status || "").trim().toLowerCase();

    if (status === "on job" || status === "on_job" || status === "busy") return "On Job";
    if (Boolean(driver.online)) return "Online";
    return "Offline";
}

function statusHtml(driver) {
    const status = getDisplayStatus(driver);

    if (status === "Online") {
        return '<span><span class="status-dot status-online"></span>Online</span>';
    }

    if (status === "On Job") {
        return '<span><span class="status-dot status-onjob"></span>On Job</span>';
    }

    return '<span><span class="status-dot status-offline"></span>Offline</span>';
}

function licenceText(driver) {
    if (!driver.licence_expiry) return driver.licence_number ? "Valid" : "-";

    const expiry = new Date(`${driver.licence_expiry}T00:00:00`);
    const now = new Date();
    now.setHours(0, 0, 0, 0);

    const diffDays = Math.ceil((expiry - now) / 86400000);

    if (diffDays < 0) return "Expired";
    if (diffDays <= 30) return "Expires Soon";
    return "Valid";
}

function viewItem(label, value) {
    return `
        <div class="driver-view-item">
            <small>${escapeHtml(label)}</small>
            <strong>${escapeHtml(value)}</strong>
        </div>
    `;
}

function renderDriverError(message) {
    const body = document.getElementById("driversTableBody");
    if (body) {
        body.innerHTML = `<tr><td colspan="8" style="color:#b91c1c;">${escapeHtml(message)}</td></tr>`;
    }
}

function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
}

function escapeHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}
