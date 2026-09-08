const portalDb = getSupabase();
let portalCompany = null;
let portalSettings = {};
let portalBookings = [];
let portalView = "upcoming";

document.addEventListener("DOMContentLoaded", async () => {
    const publicData = await loadPublicCompanyData();
    portalCompany = publicData?.company || null;
    portalSettings = publicData?.settings || {};
    if (!portalCompany) return redirectToLogin();
    applyAccountBranding(publicData);

    const { data: { session } } = await portalDb.auth.getSession();
    if (!session) return redirectToLogin();

    document.getElementById("customerLogout").addEventListener("click", async () => {
        await portalDb.auth.signOut();
        redirectToLogin();
    });
    document.querySelectorAll("[data-booking-view]").forEach(button => button.addEventListener("click", () => setView(button.dataset.bookingView)));
    document.getElementById("closeCustomerBooking").addEventListener("click", () => document.getElementById("customerBookingDialog").close());
    document.getElementById("customerProfileForm").addEventListener("submit", saveProfile);

    try {
        await Promise.all([loadBookings(), loadProfile()]);
    } catch (error) {
        showMessage(await friendlyAccountError(error), "error");
    }
});

async function requestPortal(action, extra = {}) {
    const { data, error } = await portalDb.functions.invoke("customer-portal", {
        body: { action, company_code: portalCompany.company_code, ...extra }
    });
    if (error || !data?.ok) {
        const failure = error || new Error(data?.error || "Customer portal request failed");
        failure.portalMessage = data?.error;
        throw failure;
    }
    return data;
}

async function loadBookings() {
    portalBookings = (await requestPortal("list")).bookings || [];
    renderBookings();
}

async function loadProfile() {
    const customer = (await requestPortal("profile")).customer || {};
    document.getElementById("profileName").value = customer.full_name || "";
    document.getElementById("profilePhone").value = customer.phone || "";
    document.getElementById("profileEmail").value = customer.email || "";
}

function setView(view) {
    portalView = view;
    document.querySelectorAll("[data-booking-view]").forEach(button => button.classList.toggle("active", button.dataset.bookingView === view));
    document.getElementById("customerProfile").hidden = view !== "details";
    document.getElementById("customerBookingList").hidden = view === "details";
    clearMessage();
    renderBookings();
}

function renderBookings() {
    if (portalView === "details") return;
    const today = new Date().toISOString().slice(0, 10);
    const isCancelled = booking => ["cancelled", "canceled", "no_show"].includes(normalise(booking.status));
    const rows = portalBookings.filter(booking => {
        if (portalView === "cancelled") return isCancelled(booking);
        if (portalView === "upcoming") return !isCancelled(booking) && normalise(booking.status) !== "completed" && booking.journey_date >= today;
        return normalise(booking.status) === "completed" || (!isCancelled(booking) && booking.journey_date < today);
    });
    document.getElementById("customerBookingList").innerHTML = rows.length
        ? rows.map(bookingCard).join("")
        : '<div class="portal-card portal-empty">No bookings in this view.</div>';
    document.querySelectorAll("[data-view-customer-booking]").forEach(button => button.addEventListener("click", () => openBooking(button.dataset.viewCustomerBooking)));
}

function bookingCard(booking) {
    return `<article class="booking-card">
        <header><strong class="booking-reference">${escapeHtml(booking.booking_reference)}</strong><span class="portal-status">${escapeHtml(pretty(booking.status))}</span></header>
        <dl>
            <div><dt>Date</dt><dd>${escapeHtml(booking.journey_date)}</dd></div>
            <div><dt>Time</dt><dd>${escapeHtml(String(booking.journey_time || "").slice(0, 5))}</dd></div>
            <div class="booking-wide-field"><dt>Pickup</dt><dd>${escapeHtml(booking.pickup_address)}</dd></div>
            <div class="booking-wide-field"><dt>Destination</dt><dd>${escapeHtml(booking.dropoff_address)}</dd></div>
            <div><dt>Vehicle</dt><dd>${escapeHtml(vehicleName(booking))}</dd></div>
            <div><dt>Price</dt><dd>${money(booking.price)}</dd></div>
            <div><dt>Payment</dt><dd class="payment-status">${escapeHtml(pretty(booking.payment_status))}</dd></div>
        </dl>
        <div class="booking-actions"><button data-view-customer-booking="${escapeHtml(booking.id)}">View Booking</button></div>
    </article>`;
}

function openBooking(id) {
    const booking = portalBookings.find(row => String(row.id) === String(id));
    if (!booking) return;
    const stops = (booking.booking_stops || []).sort((a, b) => a.stop_order - b.stop_order).map(stop => stop.formatted_address).join(" → ") || "None";
    const section = (title, fields) => `<section class="booking-detail-section"><h3>${title}</h3><div class="booking-detail-grid">${fields.map(detailItem).join("")}</div></section>`;
    const changes = changeable(booking) ? `<section class="customer-change-panel">
        <h3>Permitted Changes</h3>
        <form id="customerChangeForm" class="portal-form">
            <div class="customer-change-fields">
                <div><label for="changeJourneyDate">Date</label><input id="changeJourneyDate" name="journey_date" type="date" value="${escapeHtml(booking.journey_date)}"></div>
                <div><label for="changeJourneyTime">Time</label><input id="changeJourneyTime" name="journey_time" type="time" value="${escapeHtml(String(booking.journey_time || "").slice(0, 5))}"></div>
                <div><label for="changePassengers">Passengers</label><input id="changePassengers" name="passengers" type="number" min="1" value="${escapeHtml(booking.passengers)}"></div>
            </div>
            <small class="portal-info-panel">For route, vehicle, return or paid-booking changes, contact the company.</small>
            <div class="customer-change-actions"><button type="submit">Save Changes</button><button id="customerCancelBooking" class="danger-button" type="button">Cancel Booking</button></div>
        </form>
    </section>` : '<div class="portal-info-panel">This booking can no longer be changed online. Please contact the company if you need help.</div>';

    document.getElementById("customerBookingDetail").innerHTML = `<h2 class="booking-detail-title">${escapeHtml(booking.booking_reference)}</h2>
        ${section("Journey", [["Date / time", `${booking.journey_date} ${String(booking.journey_time || "").slice(0, 5)}`], ["Pickup", booking.pickup_address], ["Via points", stops], ["Destination", booking.dropoff_address], ["Flight", booking.flight_number || "—"]])}
        ${section("Passengers & Luggage", [["Passengers", booking.passengers], ["Luggage", `${booking.suitcases || 0} suitcases, ${booking.hand_luggage || 0} hand luggage`]])}
        ${section("Vehicle", [["Vehicle class", vehicleName(booking)]])}
        ${section("Payment", [["Price", money(booking.price)], ["Method", pretty(booking.payment_method)], ["Payment status", pretty(booking.payment_status)]])}
        ${section("Status", [["Booking status", pretty(booking.status)]])}${changes}`;
    document.getElementById("customerChangeForm")?.addEventListener("submit", event => saveBooking(event, booking));
    document.getElementById("customerCancelBooking")?.addEventListener("click", () => cancelBooking(booking));
    document.getElementById("customerBookingDialog").showModal();
}

function detailItem([label, value]) {
    return `<div class="booking-detail-item"><small>${escapeHtml(label)}</small><strong>${escapeHtml(value)}</strong></div>`;
}

async function saveBooking(event, booking) {
    event.preventDefault();
    try {
        await requestPortal("update_booking", { booking_id: booking.id, changes: Object.fromEntries(new FormData(event.target)) });
        showMessage("Booking updated.", "success");
        document.getElementById("customerBookingDialog").close();
        await loadBookings();
    } catch (error) { showMessage(await friendlyAccountError(error), "error"); }
}

async function cancelBooking(booking) {
    const reason = prompt("Cancellation reason (optional):", "");
    if (reason === null) return;
    try {
        const result = await requestPortal("cancel_booking", { booking_id: booking.id, reason });
        showMessage(result.message, "success");
        document.getElementById("customerBookingDialog").close();
        await loadBookings();
    } catch (error) { showMessage(await friendlyAccountError(error), "error"); }
}

async function saveProfile(event) {
    event.preventDefault();
    try {
        await requestPortal("update_profile", { name: document.getElementById("profileName").value, phone: document.getElementById("profilePhone").value });
        showMessage("Details saved.", "success");
    } catch (error) { showMessage(await friendlyAccountError(error), "error"); }
}

function applyAccountBranding({ company, settings = {} }) {
    const name = settings.tradingname || company.trading_name || settings.companyname || company.name;
    document.getElementById("portalCompanyName").textContent = name;
    document.title = `My Bookings | ${name}`;
    const root = document.documentElement.style;
    const accent = settings.primarycolour || settings.accentcolour || settings.buttoncolour;
    if (accent) root.setProperty("--portal-accent", accent);
    if (settings.buttontextcolour) root.setProperty("--portal-accent-contrast", settings.buttontextcolour);
    if (settings.publicbackgroundcolour) root.setProperty("--portal-bg", settings.publicbackgroundcolour);
    if (settings.publiccardcolour) root.setProperty("--portal-card", settings.publiccardcolour);
    const logo = document.getElementById("portalCompanyLogo"), fallback = document.getElementById("portalCompanyLogoFallback");
    fallback.textContent = name.split(/\s+/).slice(0, 2).map(word => word[0]).join("").toUpperCase();
    if (settings.companylogo) try { const url = new URL(settings.companylogo, location.href); if (/^https?:$/.test(url.protocol)) { logo.alt = `${name} logo`; logo.onload = () => { logo.hidden = false; fallback.hidden = true; }; logo.src = url.href; } } catch {}
}

async function friendlyAccountError(error) {
    let text = error?.portalMessage || "";
    if (!text && error?.context?.json) try { text = (await error.context.json())?.error || ""; } catch {}
    text ||= error?.message || "Unable to complete this request.";
    if (/No customer account is linked/i.test(text)) return "Your account is not linked to this transport company. Use the secure account link from your booking confirmation.";
    if (/invalid or expired/i.test(text)) return "This booking link is invalid or has expired. Please contact the company for help.";
    if (/Customer login required|JWT|authorization/i.test(text)) return "Your session has expired. Please sign in again.";
    return text;
}

function redirectToLogin() {
    const url = new URL("customer-login.html", location.origin + "/");
    const code = portalCompany?.company_code || new URLSearchParams(location.search).get("company");
    if (code) url.searchParams.set("company", code);
    location.replace(url.href);
}
function changeable(booking) { return normalise(booking.payment_status) !== "paid" && !["accepted", "on_way", "passenger_onboard", "completed", "cancelled", "no_show"].includes(normalise(booking.status)); }
function vehicleName(booking) { return ({ standard:"Car", car:"Car", executive_car:"Executive Car", "5_7":"5–7 Seater", mpv:"5–7 Seater", executive_5_7:"Executive 5–7 Seater", "5_8":"5–8 Seater", "9_16":"9–16 Seater", "17_23":"17–23 Seater", "24_52":"24–52 Seater" })[booking.vehicle_tier || booking.vehicle_type] || pretty(booking.vehicle_tier || booking.vehicle_type); }
function money(value) { return `${portalSettings.currencysymbol || "£"}${Number(value || 0).toFixed(2)}`; }
function normalise(value) { return String(value || "").trim().toLowerCase().replaceAll(" ", "_"); }
function pretty(value) { return String(value || "—").replaceAll("_", " ").replace(/\b\w/g, character => character.toUpperCase()); }
function showMessage(value, kind = "info") { const target = document.getElementById("portalMessage"); target.textContent = value; target.dataset.kind = kind; target.hidden = !value; }
function clearMessage() { showMessage(""); }
function escapeHtml(value) { return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"); }
