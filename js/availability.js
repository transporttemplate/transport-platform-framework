const availabilityDb = getSupabase();

let availabilityCompanyId = null;
let availabilityDrivers = [];
let availabilityBookings = [];
let availabilityPeriods = [];

const ACTIVE_JOB_STATUSES = ["assigned", "accepted", "on_way", "passenger_onboard"];
const BREAK_STATUSES = ["break", "on break", "on_break"];
const UNAVAILABLE_STATUSES = ["unavailable", "holiday", "off", "off duty", "off_duty"];

document.addEventListener("DOMContentLoaded", async () => {
    try {
        const context = await window.getAdminCompanyContext();
        availabilityCompanyId = context.companyId;
        document.getElementById("refreshAvailability")?.addEventListener("click", loadAvailability);
        await loadAvailability();
    } catch (error) {
        console.error("Availability startup error:", error);
        renderAvailabilityError("Unable to identify the admin company.");
    }
});

async function loadAvailability() {
    if (!availabilityCompanyId) return;

    const refreshButton = document.getElementById("refreshAvailability");
    if (refreshButton) refreshButton.disabled = true;
    setRowsMessage("Loading drivers…");

    const [driversResult, bookingsResult, periodsResult] = await Promise.all([
        availabilityDb
            .from("drivers")
            .select("id,company_id,driver_number,full_name,vehicle,status,online,latitude,longitude,location_updated_at")
            .eq("company_id", availabilityCompanyId)
            .order("driver_number", { ascending: true })
            .order("full_name", { ascending: true }),
        availabilityDb
            .from("bookings")
            .select("id,company_id,driver_id,booking_reference,status,pickup_address,dropoff_address,journey_date,journey_time")
            .eq("company_id", availabilityCompanyId)
            .in("status", ACTIVE_JOB_STATUSES)
            .order("journey_date", { ascending: true })
            .order("journey_time", { ascending: true }),
        availabilityDb
            .from("driver_unavailability")
            .select("id,company_id,driver_id,from_datetime,to_datetime,reason,active")
            .eq("company_id", availabilityCompanyId)
            .eq("active", true)
    ]);

    if (refreshButton) refreshButton.disabled = false;

    if (driversResult.error) {
        console.error("Availability driver load error:", driversResult.error);
        renderAvailabilityError(driversResult.error.message);
        return;
    }

    availabilityDrivers = driversResult.data || [];

    if (bookingsResult.error) {
        console.error("Availability booking load error:", bookingsResult.error);
        availabilityBookings = [];
    } else {
        availabilityBookings = bookingsResult.data || [];
    }

    if (periodsResult.error) {
        console.warn("Driver unavailability is not available:", periodsResult.error.message);
        availabilityPeriods = [];
    } else {
        availabilityPeriods = periodsResult.data || [];
    }

    renderAvailability();
}

function renderAvailability() {
    const rows = availabilityDrivers.map(driver => {
        const currentJob = findCurrentJob(driver.id);
        const state = driverState(driver, currentJob);
        return { driver, currentJob, state };
    });

    setText("availableCount", rows.filter(row => row.state.key === "available").length);
    setText("onJobCount", rows.filter(row => row.state.key === "on-job").length);
    setText("onBreakCount", rows.filter(row => row.state.key === "on-break").length);
    setText("offlineCount", rows.filter(row => row.state.key === "offline").length);
    setText("unavailableCount", rows.filter(row => row.state.key === "unavailable").length);

    const body = document.getElementById("availabilityRows");
    if (!body) return;

    if (!rows.length) {
        body.innerHTML = '<tr><td colspan="5">No drivers found for this company</td></tr>';
    } else {
        body.innerHTML = rows.map(({ driver, currentJob, state }) => `
            <tr>
                <td><strong>${escapeAvailabilityHtml(driver.full_name || "Unnamed driver")}</strong><br><small>${escapeAvailabilityHtml(driver.driver_number || "No driver number")}</small></td>
                <td>${escapeAvailabilityHtml(driver.vehicle || "—")}</td>
                <td><span class="availability-status ${state.key}"><span class="availability-dot"></span>${escapeAvailabilityHtml(state.label)}</span></td>
                <td>${currentJobHtml(currentJob)}</td>
                <td>${escapeAvailabilityHtml(formatLocationUpdated(driver.location_updated_at))}</td>
            </tr>
        `).join("");
    }

    setText("availabilityUpdated", `Last refreshed ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`);
}

function driverState(driver, currentJob) {
    const status = normaliseAvailabilityStatus(driver.status);

    if (isCurrentlyUnavailable(driver.id) || UNAVAILABLE_STATUSES.includes(status)) {
        return { key: "unavailable", label: "Unavailable / Holiday" };
    }

    if (currentJob || status === "on job" || status === "on_job") {
        return { key: "on-job", label: currentJob ? prettyAvailabilityStatus(currentJob.status) : "On Job" };
    }

    if (BREAK_STATUSES.includes(status)) {
        return { key: "on-break", label: "On Break" };
    }

    if (driver.online) {
        return { key: "available", label: "Available / Online" };
    }

    return { key: "offline", label: "Offline" };
}

function findCurrentJob(driverId) {
    return availabilityBookings.find(booking => String(booking.driver_id) === String(driverId)) || null;
}

function isCurrentlyUnavailable(driverId) {
    const now = Date.now();
    return availabilityPeriods.some(period => {
        if (String(period.driver_id) !== String(driverId) || period.active === false) return false;
        const from = new Date(period.from_datetime).getTime();
        const to = new Date(period.to_datetime).getTime();
        return Number.isFinite(from) && Number.isFinite(to) && from <= now && to >= now;
    });
}

function currentJobHtml(job) {
    if (!job) return "—";
    const reference = job.booking_reference || job.id;
    const route = [job.pickup_address, job.dropoff_address].filter(Boolean).join(" → ");
    return `<strong>${escapeAvailabilityHtml(reference)}</strong>${route ? `<br><small>${escapeAvailabilityHtml(route)}</small>` : ""}`;
}

function formatLocationUpdated(value) {
    if (!value) return "Never";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "Unknown";
    return date.toLocaleString([], { dateStyle: "short", timeStyle: "short" });
}

function prettyAvailabilityStatus(value) {
    const status = normaliseAvailabilityStatus(value);
    const labels = {
        assigned: "Assigned",
        accepted: "Accepted",
        on_way: "On Way",
        passenger_onboard: "Passenger Onboard"
    };
    return labels[status] || value || "On Job";
}

function normaliseAvailabilityStatus(value) {
    return String(value || "").trim().toLowerCase();
}

function setRowsMessage(message) {
    const body = document.getElementById("availabilityRows");
    if (body) body.innerHTML = `<tr><td colspan="5">${escapeAvailabilityHtml(message)}</td></tr>`;
}

function renderAvailabilityError(message) {
    setRowsMessage(`Unable to load driver availability: ${message}`);
    setText("availabilityUpdated", "Availability could not be loaded.");
}

function setText(id, value) {
    const element = document.getElementById(id);
    if (element) element.textContent = value;
}

function escapeAvailabilityHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}
