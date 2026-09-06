const db = getSupabase();

async function loadDashboard() {
    const upcomingBody = document.getElementById("upcomingBookings");
    try {
        const { companyId } = await window.getAdminCompanyContext();
        const today = new Date().toISOString().split("T")[0];

        const [todayResult, upcomingResult, settingsResult, driversResult] = await Promise.all([
            db.from("bookings").select("id,company_id,price,job_price,status").eq("company_id", companyId).eq("journey_date", today),
            db.from("bookings").select("id,company_id,booking_reference,journey_date,journey_time,customer_name,pickup_address,dropoff_address,status").eq("company_id", companyId).gte("journey_date", today).order("journey_date", { ascending: true }).order("journey_time", { ascending: true }).limit(10),
            db.from("settings").select("company_id,currencysymbol,googlemapsapi").eq("company_id", companyId).maybeSingle(),
            db.from("drivers").select("id,company_id,driver_number,full_name,status,online,latitude,longitude,location_updated_at").eq("company_id", companyId)
        ]);

        const { data: bookings, error: bookingsError } = todayResult;
        const { data: upcoming, error: upcomingError } = upcomingResult;
        const { data: settings, error: settingsError } = settingsResult;
        const { data: drivers, error: driversError } = driversResult;

        if (bookingsError || upcomingError || settingsError || driversError) throw bookingsError || upcomingError || settingsError || driversError;
        if (!settings || String(settings.company_id) !== String(companyId)) throw new Error("Company dashboard settings are unavailable.");

        renderUpcomingBookings(upcoming || []);

        const todayBookings = document.getElementById("todayBookings");
        if (todayBookings) todayBookings.textContent = bookings?.length || 0;

        let revenue = 0;
        (bookings || []).forEach(job => {
            revenue += Number(job.price ?? job.job_price ?? 0);
        });

        const todayRevenue = document.getElementById("todayRevenue");
        if (todayRevenue) todayRevenue.textContent = (settings?.currencysymbol || "£") + revenue.toFixed(2);

        const driversOnline = document.getElementById("driversOnline");
        if (driversOnline) {
            driversOnline.textContent =
                (drivers || []).filter(d => d.online === true).length;
        }

        const waiting = (bookings || []).filter(job =>
            ["waiting", "assigned"].includes(
                String(job.status || "").toLowerCase()
            )
        ).length;

        const jobsWaiting = document.getElementById("jobsWaiting");
        if (jobsWaiting) jobsWaiting.textContent = waiting;

        await initialiseDashboardMap(settings.googlemapsapi, drivers || []);

    } catch (error) {
        console.error("Dashboard load failed", { message: error?.message || "Unknown dashboard error" });
        if (upcomingBody) upcomingBody.innerHTML = '<tr><td colspan="4" class="dashboard-table-message">Upcoming bookings could not be loaded. Please refresh and try again.</td></tr>';
        showDashboardMapMessage("Google Maps could not be loaded for this company.");
    }
}

function renderUpcomingBookings(bookings) {
    const body = document.getElementById("upcomingBookings");
    if (!body) return;
    if (!bookings.length) {
        body.innerHTML = '<tr><td colspan="4" class="dashboard-table-message">No upcoming bookings.</td></tr>';
        return;
    }
    body.innerHTML = bookings.map(booking => `<tr>
        <td><strong>${escapeDashboard(formatDashboardDate(booking.journey_date))}</strong><br><small>${escapeDashboard(String(booking.journey_time || "").slice(0, 5) || "—")}</small></td>
        <td>${escapeDashboard(booking.customer_name || "—")}</td>
        <td class="dashboard-journey">${escapeDashboard(booking.pickup_address || "—")} → ${escapeDashboard(booking.dropoff_address || "—")}</td>
        <td>${escapeDashboard(booking.status || "—")}</td>
    </tr>`).join("");
}

async function initialiseDashboardMap(apiKey, drivers) {
    const key = String(apiKey || "").trim();
    if (!key) return showDashboardMapMessage("Google Maps is not configured for this company.");
    const mapElement = document.getElementById("dashboardMap");
    if (!mapElement || !window.TransportAddressAutocomplete) return showDashboardMapMessage("Google Maps could not be loaded for this company.");
    let authenticationFailed = false;
    const previousAuthFailure = window.gm_authFailure;
    window.gm_authFailure = () => {
        authenticationFailed = true;
        showDashboardMapMessage("Google Maps is not configured for this company.");
        if (typeof previousAuthFailure === "function") previousAuthFailure();
    };
    try {
        await window.TransportAddressAutocomplete.loadGoogleMaps(key);
        if (authenticationFailed) return;
        const located = drivers.filter(driver => Number.isFinite(Number(driver.latitude)) && Number.isFinite(Number(driver.longitude)));
        const centre = located.length ? { lat: Number(located[0].latitude), lng: Number(located[0].longitude) } : { lat: 51.4816, lng: -3.1791 };
        const map = new google.maps.Map(mapElement, { center: centre, zoom: located.length ? 10 : 7, mapTypeControl: false, streetViewControl: false });
        const bounds = new google.maps.LatLngBounds();
        located.forEach(driver => {
            const position = { lat: Number(driver.latitude), lng: Number(driver.longitude) };
            new google.maps.Marker({ map, position, title: driver.full_name || `Driver ${driver.driver_number || ""}` });
            bounds.extend(position);
        });
        if (located.length > 1) map.fitBounds(bounds);
        mapElement.hidden = false;
        const message = document.getElementById("dashboardMapMessage");
        if (message) message.hidden = true;
    } catch (error) {
        console.error("Dashboard Google Maps load failed", { message: error?.message || "Google Maps load error" });
        showDashboardMapMessage("Google Maps is not configured for this company.");
    }
}

function showDashboardMapMessage(message) {
    const map = document.getElementById("dashboardMap");
    const status = document.getElementById("dashboardMapMessage");
    if (map) map.hidden = true;
    if (status) { status.hidden = false; status.textContent = message; }
}

function formatDashboardDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return value || "—";
    const [year, month, day] = value.split("-").map(Number);
    return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short" }).format(new Date(Date.UTC(year, month - 1, day)));
}

function escapeDashboard(value) {
    return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

document.addEventListener("DOMContentLoaded", loadDashboard);
