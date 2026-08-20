const bookingsDb = getSupabase();

let allBookings = [];
let allDrivers = [];
let currentTab = "dispatch";
let adminCompanyId = null;

let dispatchMap = null;
let driverMarkers = [];
let liveTimer = null;

document.addEventListener("DOMContentLoaded", async () => {
    try {
        const context = await window.getAdminCompanyContext();
        adminCompanyId = context.companyId;

        setDefaultDates();
        bindBookingEvents();

        await Promise.all([loadDrivers(), loadBookings()]);
        await initialiseDispatchMap();
        startLiveRefresh();
    } catch (error) {
        console.error("Bookings startup error:", error);
    }
});

function bindBookingEvents() {
    document.getElementById("adminBookingForm")?.addEventListener("submit", createAdminBooking);

    document.getElementById("refreshBookings")?.addEventListener("click", async () => {
        await Promise.all([loadDrivers(), loadBookings()]);
        refreshDriverMarkers();
    });

    document.getElementById("dateFrom")?.addEventListener("change", renderBookings);
    document.getElementById("dateTo")?.addEventListener("change", renderBookings);
    document.getElementById("searchBookings")?.addEventListener("input", renderBookings);
    document.getElementById("statusFilter")?.addEventListener("change", renderBookings);

    document.getElementById("focusNewBooking")?.addEventListener("click", () => {
        document.getElementById("customerName")?.focus();
        document.getElementById("newBookingPanel")?.scrollIntoView({ behavior: "smooth" });
    });

    document.querySelectorAll(".dispatch-tabs button").forEach(button => {
        button.addEventListener("click", () => {
            document.querySelectorAll(".dispatch-tabs button")
                .forEach(item => item.classList.remove("active"));
            button.classList.add("active");
            currentTab = button.dataset.status;
            renderBookings();
        });
    });
}

function setDefaultDates() {
    const today = new Date();
    const future = new Date(today);
    future.setDate(future.getDate() + 14);

    const from = today.toISOString().slice(0, 10);
    const to = future.toISOString().slice(0, 10);

    if (document.getElementById("dateFrom")) document.getElementById("dateFrom").value = from;
    if (document.getElementById("dateTo")) document.getElementById("dateTo").value = to;
    if (document.getElementById("journeyDate")) document.getElementById("journeyDate").value = from;
}

async function loadDrivers() {
    const { data, error } = await bookingsDb
        .from("drivers")
        .select("id,company_id,driver_number,full_name,vehicle,status,online,latitude,longitude,location_updated_at")
        .eq("company_id", adminCompanyId)
        .order("driver_number", { ascending: true });

    if (error) {
        console.error("Unable to load drivers:", error);
        return;
    }

    allDrivers = data || [];
    populateDriverDropdown();
}

function populateDriverDropdown() {
    const select = document.getElementById("driverSelect");
    if (!select) return;

    select.innerHTML = '<option value="">Unassigned</option>';

    allDrivers.forEach(driver => {
        const option = document.createElement("option");
        option.value = driver.id;
        option.textContent =
            `${driver.driver_number || "-"} — ${driver.full_name || "Driver"}${driver.online ? " • ONLINE" : ""}`;
        select.appendChild(option);
    });
}

async function loadBookings() {
    const body = document.getElementById("bookingsBody");
    if (body) body.innerHTML =
        '<tr><td colspan="12" class="empty-row">Loading bookings…</td></tr>';

    const { data, error } = await bookingsDb
        .from("bookings")
        .select("*")
        .eq("company_id", adminCompanyId)
        .order("journey_date", { ascending: true })
        .order("journey_time", { ascending: true });

    if (error) {
        console.error("Unable to load bookings:", error);
        if (body) body.innerHTML =
            `<tr><td colspan="12" class="empty-row">${escapeHtml(error.message)}</td></tr>`;
        return;
    }

    allBookings = data || [];
    updateCounts();
    renderBookings();
}

function bookingStatus(booking) {
    return String(booking.status || booking.booking_status || "waiting")
        .trim().toLowerCase().replaceAll(" ", "_");
}

function matchesTab(booking) {
    const status = bookingStatus(booking);

    if (currentTab === "all") return true;
    if (currentTab === "completed") return status === "completed";
    if (currentTab === "cancelled") return ["cancelled", "canceled"].includes(status);
    if (currentTab === "booked") return ["booked", "assigned", "accepted"].includes(status);

    if (currentTab === "prebooked") {
        const today = new Date().toISOString().slice(0, 10);
        return booking.journey_date > today &&
            !["completed", "cancelled", "canceled", "declined"].includes(status);
    }

    return ["waiting", "assigned", "accepted", "on_way", "passenger_onboard", "dispatched"].includes(status);
}

function renderBookings() {
    const from = document.getElementById("dateFrom")?.value || "";
    const to = document.getElementById("dateTo")?.value || "";
    const search = document.getElementById("searchBookings")?.value.trim().toLowerCase() || "";
    const statusFilter = document.getElementById("statusFilter")?.value || "";

    const rows = allBookings.filter(booking => {
        if (from && booking.journey_date && booking.journey_date < from) return false;
        if (to && booking.journey_date && booking.journey_date > to) return false;
        if (!matchesTab(booking)) return false;
        if (statusFilter && bookingStatus(booking) !== statusFilter) return false;

        if (search) {
            const haystack = [
                booking.booking_reference,
                booking.customer_name,
                booking.full_name,
                booking.pickup_address,
                booking.pickup,
                booking.dropoff_address,
                booking.destination,
                booking.customer_phone,
                booking.phone
            ].filter(Boolean).join(" ").toLowerCase();

            if (!haystack.includes(search)) return false;
        }

        return true;
    });

    const body = document.getElementById("bookingsBody");
    if (!body) return;

    if (!rows.length) {
        body.innerHTML =
            '<tr><td colspan="12" class="empty-row">No bookings found for this view.</td></tr>';
        return;
    }

    body.innerHTML = rows.map(booking => {
        const driverOptions = [
            '<option value="">Unassigned</option>',
            ...allDrivers.map(driver => {
                const selected = String(driver.id) === String(booking.driver_id || "") ? " selected" : "";
                const online = driver.online ? " • ONLINE" : "";
                return `<option value="${escapeHtml(driver.id)}"${selected}>${escapeHtml(
                    `${driver.driver_number || "-"} — ${driver.full_name || "Driver"}${online}`
                )}</option>`;
            })
        ].join("");

        return `
            <tr>
                <td>${escapeHtml(booking.journey_date || "")}</td>
                <td>${escapeHtml(formatTime(booking.journey_time))}</td>
                <td>${escapeHtml(booking.booking_reference || shortId(booking.id))}</td>
                <td>${escapeHtml(booking.customer_name || booking.full_name || "-")}</td>
                <td>${escapeHtml(booking.pickup_address || booking.pickup || "-")}</td>
                <td>${escapeHtml(booking.dropoff_address || booking.destination || "-")}</td>
                <td>
                    <select class="booking-driver-select" data-booking-id="${escapeHtml(booking.id)}">
                        ${driverOptions}
                    </select>
                </td>
                <td>${money(booking.price ?? booking.job_price)}</td>
                <td>${escapeHtml(booking.payment_method || booking.payment_status || "-")}</td>
                <td><span class="source-pill">${escapeHtml(booking.booking_source || "website")}</span></td>
                <td><span class="status-pill">${escapeHtml(prettyStatus(bookingStatus(booking)))}</span></td>
                <td>
                    <div style="display:flex;gap:6px;flex-wrap:wrap;">
                        <button type="button" onclick="cycleBookingStatus('${booking.id}','${bookingStatus(booking)}')">Update</button>
                        ${["completed","cancelled","canceled"].includes(bookingStatus(booking))
                            ? ""
                            : `<button type="button" onclick="cancelBooking('${booking.id}')" style="background:#dc2626;color:white;">Cancel</button>`}
                    </div>
                </td>
            </tr>`;
    }).join("");

    body.querySelectorAll(".booking-driver-select").forEach(select => {
        select.addEventListener("change", () =>
            assignBookingDriver(select.dataset.bookingId, select.value || null)
        );
    });
}

async function assignBookingDriver(bookingId, driverId) {
    const booking = allBookings.find(row => String(row.id) === String(bookingId));
    if (!booking) return;

    const update = {
        driver_id: driverId,
        status: driverId ? "assigned" : "waiting",
        dispatched_at: driverId ? new Date().toISOString() : null
    };

    const { error } = await bookingsDb
        .from("bookings")
        .update(update)
        .eq("id", bookingId)
        .eq("company_id", adminCompanyId);

    if (error) {
        alert("Unable to assign driver: " + error.message);
        await loadBookings();
        return;
    }

    await loadBookings();
}

async function createAdminBooking(event) {
    event.preventDefault();

    const message = document.getElementById("bookingMessage");
    if (message) message.textContent = "Saving…";

    const driverId = document.getElementById("driverSelect")?.value || null;
    const selectedStatus = document.getElementById("bookingStatus")?.value || "waiting";

    const payload = {
        company_id: adminCompanyId,
        booking_reference: makeReference(),
        customer_name: document.getElementById("customerName")?.value.trim() || "",
        customer_email: document.getElementById("customerEmail")?.value.trim() || null,
        customer_phone: document.getElementById("customerPhone")?.value.trim() || null,
        pickup_address: document.getElementById("pickupAddress")?.value.trim() || "",
        dropoff_address: document.getElementById("dropoffAddress")?.value.trim() || "",
        journey_date: document.getElementById("journeyDate")?.value || null,
        journey_time: document.getElementById("journeyTime")?.value || null,
        passengers: Number(document.getElementById("passengers")?.value || 1),
        job_price: document.getElementById("jobPrice")?.value === ""
            ? null : Number(document.getElementById("jobPrice")?.value),
        payment_method: document.getElementById("paymentMethod")?.value || "cash",
        driver_id: driverId,
        status: driverId && selectedStatus === "waiting" ? "assigned" : selectedStatus,
        notes: document.getElementById("notes")?.value.trim() || null,
        booking_source: "admin"
    };

    if (driverId) payload.dispatched_at = new Date().toISOString();

    const { error } = await bookingsDb.from("bookings").insert(payload);

    if (error) {
        if (message) message.textContent = "Could not save: " + error.message;
        return;
    }

    if (message) message.textContent = "Booking saved.";
    event.target.reset();
    setDefaultDates();
    populateDriverDropdown();
    await loadBookings();
}

async function cancelBooking(id) {
    if (!confirm("Cancel this booking?")) return;

    const { error } = await bookingsDb
        .from("bookings")
        .update({
            status: "cancelled",
            booking_status: "cancelled",
            cancelled_at: new Date().toISOString()
        })
        .eq("id", id)
        .eq("company_id", adminCompanyId);

    if (error) return alert(error.message);
    await loadBookings();
}

async function cycleBookingStatus(id, current) {
    const sequence = ["waiting", "assigned", "accepted", "on_way", "passenger_onboard", "completed"];
    const next = sequence[sequence.indexOf(current) + 1] || "completed";

    const update = { status: next };
    const now = new Date().toISOString();

    if (next === "assigned") update.dispatched_at = now;
    if (next === "on_way") update.on_way_at = now;
    if (next === "passenger_onboard") update.passenger_onboard_at = now;
    if (next === "completed") update.completed_at = now;

    const { error } = await bookingsDb
        .from("bookings")
        .update(update)
        .eq("id", id)
        .eq("company_id", adminCompanyId);

    if (error) return alert(error.message);
    await loadBookings();
}

function updateCounts() {
    const today = new Date().toISOString().slice(0, 10);
    const status = booking => bookingStatus(booking);

    setCount("countAll", allBookings.length);
    setCount("countCompleted", allBookings.filter(b => status(b) === "completed").length);
    setCount("countCancelled", allBookings.filter(b => ["cancelled", "canceled"].includes(status(b))).length);
    setCount("countBooked", allBookings.filter(b => ["booked", "assigned", "accepted"].includes(status(b))).length);
    setCount("countPrebooked", allBookings.filter(b =>
        b.journey_date > today &&
        !["completed", "cancelled", "canceled", "declined"].includes(status(b))
    ).length);
    setCount("countDispatch", allBookings.filter(b =>
        ["waiting", "assigned", "accepted", "on_way", "passenger_onboard", "dispatched"].includes(status(b))
    ).length);
}

function setCount(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
}

async function initialiseDispatchMap() {
    const message = document.getElementById("mapMessage");

    try {
        const { data, error } = await bookingsDb
            .from("settings")
            .select("googlemapsapi")
            .eq("company_id", adminCompanyId)
            .maybeSingle();

        if (error) throw error;
        if (!data?.googlemapsapi) {
            if (message) message.textContent = "Google Maps API key not found.";
            return;
        }

        await loadGoogleMaps(data.googlemapsapi);
        setupAdminAutocomplete("pickupAddress");
        setupAdminAutocomplete("dropoffAddress");

        dispatchMap = new google.maps.Map(
            document.getElementById("dispatchMap"),
            {
                center: { lat: 51.445, lng: -3.235 },
                zoom: 10,
                mapTypeControl: true,
                streetViewControl: false,
                fullscreenControl: true
            }
        );

        refreshDriverMarkers();

        if (message) {
            message.textContent =
                "Online drivers with GPS positions appear automatically.";
        }
    } catch (error) {
        console.error("Map error:", error);
        if (message) message.textContent = "Unable to load Google Map: " + error.message;
    }
}

function loadGoogleMaps(apiKey) {
    if (window.google?.maps?.places?.Autocomplete) return Promise.resolve();

    return new Promise((resolve, reject) => {
        const callbackName = "__dispatchGoogleMapsLoaded";
        window[callbackName] = () => {
            resolve();
            delete window[callbackName];
        };

        const script = document.createElement("script");
        script.src =
            "https://maps.googleapis.com/maps/api/js" +
            "?key=" + encodeURIComponent(apiKey) +
            "&libraries=places" +
            "&loading=async" +
            "&callback=" + callbackName;
        script.async = true;
        script.onerror = () => reject(new Error("Google Maps JavaScript API failed to load."));
        document.head.appendChild(script);
    });
}

function setupAdminAutocomplete(id) {
    const input = document.getElementById(id);
    if (!input) return;

    const autocomplete = new google.maps.places.Autocomplete(input, {
        componentRestrictions: { country: "gb" },
        fields: ["formatted_address", "geometry", "name"]
    });

    autocomplete.addListener("place_changed", () => {
        const place = autocomplete.getPlace();
        if (!place?.geometry?.location) return;

        input.value = place.formatted_address || place.name || "";
        input.dataset.lat = place.geometry.location.lat();
        input.dataset.lng = place.geometry.location.lng();
    });
}

function refreshDriverMarkers() {
    if (!dispatchMap || !window.google) return;

    driverMarkers.forEach(marker => marker.setMap(null));
    driverMarkers = [];

    allDrivers
        .filter(driver =>
            driver.online === true &&
            Number.isFinite(Number(driver.latitude)) &&
            Number.isFinite(Number(driver.longitude))
        )
        .forEach(driver => {
            const number = String(driver.driver_number || "DRV");

            const marker = new google.maps.Marker({
                position: {
                    lat: Number(driver.latitude),
                    lng: Number(driver.longitude)
                },
                map: dispatchMap,
                title: `${number} ${driver.full_name || "Driver"}`,
                label: {
                    text: number,
                    color: "#ffffff",
                    fontWeight: "700"
                }
            });

            const info = new google.maps.InfoWindow({
                content: `<strong>${escapeHtml(number)} — ${escapeHtml(driver.full_name || "Driver")}</strong><br>${escapeHtml(driver.vehicle || "")}`
            });

            marker.addListener("click", () => info.open({ anchor: marker, map: dispatchMap }));
            driverMarkers.push(marker);
        });
}

function startLiveRefresh() {
    liveTimer = setInterval(async () => {
        await Promise.all([loadDrivers(), loadBookings()]);
        refreshDriverMarkers();
    }, 10000);
}

window.addEventListener("beforeunload", () => {
    if (liveTimer) clearInterval(liveTimer);
});

function makeReference() {
    return "ADM-" + Date.now().toString().slice(-8);
}

function shortId(id) {
    return id ? String(id).slice(0, 8).toUpperCase() : "-";
}

function formatTime(time) {
    return time ? String(time).slice(0, 5) : "";
}

function money(value) {
    return value === null || value === undefined || value === ""
        ? "-"
        : "£" + Number(value).toFixed(2);
}

function prettyStatus(status) {
    return String(status || "")
        .replaceAll("_", " ")
        .replace(/\b\w/g, letter => letter.toUpperCase());
}

function escapeHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}
