const bookingsDb = getSupabase();

let allBookings = [];
let allDrivers = [];
let currentTab = "dispatch";

let dispatchMap = null;
let driverMarkers = [];

document.addEventListener("DOMContentLoaded", async () => {
    setDefaultDates();
    bindBookingEvents();

    await Promise.all([
        loadDrivers(),
        loadBookings()
    ]);

    await initialiseDispatchMap();
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

    document.querySelectorAll(".dispatch-tabs button").forEach((button) => {
        button.addEventListener("click", () => {

            document.querySelectorAll(".dispatch-tabs button")
                .forEach((item) => item.classList.remove("active"));

            button.classList.add("active");
            currentTab = button.dataset.status;

            renderBookings();
        });
    });
}


function setDefaultDates() {

    const today = new Date();

    const from = today.toISOString().slice(0, 10);

    const future = new Date(today);
    future.setDate(future.getDate() + 14);

    document.getElementById("dateFrom").value = from;
    document.getElementById("dateTo").value = future.toISOString().slice(0, 10);

    document.getElementById("journeyDate").value = from;
}


async function loadDrivers() {

    const { data, error } = await bookingsDb
        .from("drivers")
        .select(`
            id,
            driver_number,
            full_name,
            vehicle,
            status,
            online,
            latitude,
            longitude,
            location_updated_at
        `)
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

    allDrivers.forEach((driver) => {

        const option = document.createElement("option");

        option.value = driver.id;

        const driverNumber = driver.driver_number || "No No.";
        const driverName = driver.full_name || "Unnamed Driver";

        option.textContent = `${driverNumber} — ${driverName}`;

        select.appendChild(option);
    });
}


async function loadBookings() {

    const body = document.getElementById("bookingsBody");

    body.innerHTML =
        '<tr><td colspan="12" class="empty-row">Loading bookings…</td></tr>';

    const { data, error } = await bookingsDb
        .from("bookings")
        .select("*")
        .order("journey_date", { ascending: true })
        .order("journey_time", { ascending: true });

    if (error) {

        console.error("Unable to load bookings:", error);

        body.innerHTML =
            `<tr><td colspan="12" class="empty-row">
                Unable to load bookings: ${escapeHtml(error.message)}
            </td></tr>`;

        return;
    }

    allBookings = data || [];

    updateCounts();
    renderBookings();
}


function bookingStatus(booking) {

    return String(
        booking.status ||
        booking.booking_status ||
        "waiting"
    ).toLowerCase();
}


function matchesTab(booking) {

    const status = bookingStatus(booking);

    if (currentTab === "all") return true;

    if (currentTab === "completed") {
        return status === "completed";
    }

    if (currentTab === "cancelled") {
        return ["cancelled", "canceled"].includes(status);
    }

    if (currentTab === "booked") {
        return ["booked", "assigned"].includes(status);
    }

    if (currentTab === "prebooked") {

        const today = new Date().toISOString().slice(0, 10);

        return (
            booking.journey_date > today &&
            !["completed", "cancelled", "canceled"].includes(status)
        );
    }

    return [
        "waiting",
        "assigned",
        "on_way",
        "passenger_onboard",
        "dispatched"
    ].includes(status);
}


function renderBookings() {

    const from = document.getElementById("dateFrom").value;
    const to = document.getElementById("dateTo").value;

    const search =
        document.getElementById("searchBookings")
            .value
            .trim()
            .toLowerCase();

    const statusFilter =
        document.getElementById("statusFilter").value;

    const rows = allBookings.filter((booking) => {

        if (
            from &&
            booking.journey_date &&
            booking.journey_date < from
        ) return false;

        if (
            to &&
            booking.journey_date &&
            booking.journey_date > to
        ) return false;

        if (!matchesTab(booking)) return false;

        if (
            statusFilter &&
            bookingStatus(booking) !== statusFilter
        ) return false;

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
            ]
                .filter(Boolean)
                .join(" ")
                .toLowerCase();

            if (!haystack.includes(search)) return false;
        }

        return true;
    });


    const body = document.getElementById("bookingsBody");

    if (!rows.length) {

        body.innerHTML =
            '<tr><td colspan="12" class="empty-row">No bookings found for this view.</td></tr>';

        return;
    }


    body.innerHTML = rows.map((booking) => {

        const driver = findDriver(booking.driver_id);

        const driverText = driver
            ? `${driver.driver_number || "-"} — ${driver.full_name || "Driver"}`
            : "Unassigned";

        return `
            <tr>
                <td>${escapeHtml(booking.journey_date || "")}</td>

                <td>${escapeHtml(formatTime(booking.journey_time))}</td>

                <td>${escapeHtml(
                    booking.booking_reference ||
                    shortId(booking.id)
                )}</td>

                <td>${escapeHtml(
                    booking.customer_name ||
                    booking.full_name ||
                    "-"
                )}</td>

                <td>${escapeHtml(
                    booking.pickup_address ||
                    booking.pickup ||
                    "-"
                )}</td>

                <td>${escapeHtml(
                    booking.dropoff_address ||
                    booking.destination ||
                    "-"
                )}</td>

                <td>${escapeHtml(driverText)}</td>

                <td>${money(
                    booking.job_price ??
                    booking.price
                )}</td>

                <td>${escapeHtml(
                    booking.payment_method ||
                    booking.payment_status ||
                    "-"
                )}</td>

                <td>
                    <span class="source-pill">
                        ${escapeHtml(
                            booking.booking_source ||
                            "website"
                        )}
                    </span>
                </td>

                <td>
                    <span class="status-pill">
                        ${escapeHtml(
                            prettyStatus(
                                bookingStatus(booking)
                            )
                        )}
                    </span>
                </td>

                <td>
                    <div style="display:flex;gap:6px;flex-wrap:wrap;">
                        <button
                            type="button"
                            onclick="cycleBookingStatus(
                                '${booking.id}',
                                '${bookingStatus(booking)}'
                            )">
                            Update
                        </button>

                        ${
                            ["completed","cancelled","canceled"].includes(bookingStatus(booking))
                            ? ""
                            : `
                                <button
                                    type="button"
                                    onclick="cancelBooking('${booking.id}')"
                                    style="background:#dc2626;color:white;">
                                    Cancel
                                </button>
                            `
                        }
                    </div>
                </td>
            </tr>
        `;
    }).join("");
}


async function createAdminBooking(event) {

    event.preventDefault();

    const message =
        document.getElementById("bookingMessage");

    message.textContent = "Saving…";

    const driverId =
        document.getElementById("driverSelect").value || null;

    const selectedStatus =
        document.getElementById("bookingStatus").value;

    const payload = {

        booking_reference: makeReference(),

        customer_name:
            document.getElementById("customerName").value.trim(),

        customer_email:
            document.getElementById("customerEmail").value.trim() || null,

        customer_phone:
            document.getElementById("customerPhone").value.trim() || null,

        pickup_address:
            document.getElementById("pickupAddress").value.trim(),

        dropoff_address:
            document.getElementById("dropoffAddress").value.trim(),

        journey_date:
            document.getElementById("journeyDate").value,

        journey_time:
            document.getElementById("journeyTime").value,

        passengers:
            Number(
                document.getElementById("passengers").value || 1
            ),

        job_price:
            document.getElementById("jobPrice").value === ""
                ? null
                : Number(
                    document.getElementById("jobPrice").value
                ),

        payment_method:
            document.getElementById("paymentMethod").value,

        driver_id: driverId,

        status:
            driverId && selectedStatus === "waiting"
                ? "assigned"
                : selectedStatus,

        notes:
            document.getElementById("notes").value.trim() || null,

        booking_source: "admin"
    };


    if (driverId) {
        payload.dispatched_at = new Date().toISOString();
    }


    const { error } = await bookingsDb
        .from("bookings")
        .insert(payload);


    if (error) {

        console.error(error);

        message.textContent =
            "Could not save: " + error.message;

        return;
    }


    message.textContent = "Booking saved.";

    event.target.reset();

    setDefaultDates();
    populateDriverDropdown();

    await loadBookings();
}



async function cancelBooking(id) {

    const confirmed = confirm(
        "Cancel this booking? This will move it to the Cancelled section."
    );

    if (!confirmed) return;

    const now = new Date().toISOString();

    const { error } = await bookingsDb
        .from("bookings")
        .update({
            status: "cancelled",
            booking_status: "cancelled",
            cancelled_at: now
        })
        .eq("id", id);

    if (error) {
        console.error("Unable to cancel booking:", error);
        alert(error.message);
        return;
    }

    await loadBookings();
}

async function cycleBookingStatus(id, current) {

    const sequence = [
        "waiting",
        "assigned",
        "on_way",
        "passenger_onboard",
        "completed"
    ];

    let next =
        sequence[sequence.indexOf(current) + 1] ||
        "completed";

    const update = {
        status: next
    };

    const now = new Date().toISOString();

    if (next === "assigned") {
        update.dispatched_at = now;
    }

    if (next === "on_way") {
        update.on_way_at = now;
    }

    if (next === "passenger_onboard") {
        update.passenger_onboard_at = now;
    }

    if (next === "completed") {
        update.completed_at = now;
    }


    const { error } = await bookingsDb
        .from("bookings")
        .update(update)
        .eq("id", id);


    if (error) {

        alert(error.message);

        return;
    }


    await loadBookings();
}


function updateCounts() {

    const today =
        new Date().toISOString().slice(0, 10);

    const status =
        (booking) => bookingStatus(booking);

    document.getElementById("countAll").textContent =
        allBookings.length;

    document.getElementById("countCompleted").textContent =
        allBookings.filter(
            (booking) => status(booking) === "completed"
        ).length;

    document.getElementById("countCancelled").textContent =
        allBookings.filter(
            (booking) =>
                ["cancelled", "canceled"].includes(
                    status(booking)
                )
        ).length;

    document.getElementById("countBooked").textContent =
        allBookings.filter(
            (booking) =>
                ["booked", "assigned"].includes(
                    status(booking)
                )
        ).length;

    document.getElementById("countPrebooked").textContent =
        allBookings.filter(
            (booking) =>
                booking.journey_date > today &&
                !["completed", "cancelled", "canceled"].includes(
                    status(booking)
                )
        ).length;

    document.getElementById("countDispatch").textContent =
        allBookings.filter(
            (booking) =>
                [
                    "waiting",
                    "assigned",
                    "on_way",
                    "passenger_onboard",
                    "dispatched"
                ].includes(status(booking))
        ).length;
}


/* =========================================================
   GOOGLE MAP
   ========================================================= */

async function initialiseDispatchMap() {

    const message =
        document.getElementById("mapMessage");

    try {

        const { data, error } = await bookingsDb
            .from("settings")
            .select("googlemapsapi")
            .limit(1)
            .maybeSingle();


        if (error) throw error;


        const apiKey = data?.googlemapsapi;


        if (!apiKey) {

            message.textContent =
                "Google Maps API key not found. Add it in Settings → Integrations.";

            return;
        }


        await loadGoogleMaps(apiKey);


        const { Map } =
            await google.maps.importLibrary("maps");


        dispatchMap = new Map(
            document.getElementById("dispatchMap"),
            {
                center: {
                    lat: 51.445,
                    lng: -3.235
                },

                zoom: 10,

                mapTypeControl: true,
                streetViewControl: false,

                fullscreenControl: true
            }
        );


        const bounds =
            new google.maps.LatLngBounds();


        /* Barry */
        bounds.extend({
            lat: 51.3998,
            lng: -3.2849
        });


        /* Cardiff */
        bounds.extend({
            lat: 51.4816,
            lng: -3.1791
        });


        dispatchMap.fitBounds(bounds, 55);

        refreshDriverMarkers();


        message.textContent =
            "Map centred on Barry and Cardiff. Online drivers with saved GPS positions appear automatically.";

    } catch (error) {

        console.error("Map error:", error);

        message.textContent =
            "Unable to load Google Map: " + error.message;
    }
}


function loadGoogleMaps(apiKey) {

    if (
        window.google &&
        window.google.maps &&
        window.google.maps.importLibrary
    ) {
        return Promise.resolve();
    }


    return new Promise((resolve, reject) => {

        const callbackName =
            "__dispatchGoogleMapsLoaded";


        window[callbackName] = () => {

            resolve();

            delete window[callbackName];
        };


        const script =
            document.createElement("script");


        script.src =
            "https://maps.googleapis.com/maps/api/js" +
            "?key=" + encodeURIComponent(apiKey) +
            "&loading=async" +
            "&callback=" + callbackName;


        script.async = true;


        script.onerror = () => {
            reject(
                new Error(
                    "Google Maps JavaScript API failed to load."
                )
            );
        };


        document.head.appendChild(script);
    });
}


function refreshDriverMarkers() {

    if (!dispatchMap || !window.google) return;


    driverMarkers.forEach((marker) => {
        marker.setMap(null);
    });


    driverMarkers = [];


    const onlineDrivers =
        allDrivers.filter((driver) => {

            const lat =
                Number(driver.latitude);

            const lng =
                Number(driver.longitude);

            return (
                driver.online === true &&
                Number.isFinite(lat) &&
                Number.isFinite(lng)
            );
        });


    onlineDrivers.forEach((driver) => {

        const marker =
            new google.maps.Marker({

                position: {
                    lat: Number(driver.latitude),
                    lng: Number(driver.longitude)
                },

                map: dispatchMap,

                title:
                    `${driver.driver_number || ""} ${driver.full_name || "Driver"}`
            });


        const info =
            new google.maps.InfoWindow({

                content: `
                    <strong>
                        ${escapeHtml(
                            driver.driver_number || ""
                        )}
                        ${escapeHtml(
                            driver.full_name || "Driver"
                        )}
                    </strong>
                    <br>
                    ${escapeHtml(
                        driver.vehicle || ""
                    )}
                    <br>
                    Status:
                    ${escapeHtml(
                        driver.status || "Unknown"
                    )}
                `
            });


        marker.addListener("click", () => {
            info.open({
                anchor: marker,
                map: dispatchMap
            });
        });


        driverMarkers.push(marker);
    });
}


/* =========================================================
   HELPERS
   ========================================================= */

function findDriver(id) {

    if (!id) return null;

    return allDrivers.find(
        (driver) => driver.id === id
    ) || null;
}


function makeReference() {

    return "ADM-" +
        Date.now()
            .toString()
            .slice(-8);
}


function shortId(id) {

    return id
        ? String(id)
            .slice(0, 8)
            .toUpperCase()
        : "-";
}


function formatTime(time) {

    return time
        ? String(time).slice(0, 5)
        : "";
}


function money(value) {

    return (
        value === null ||
        value === undefined ||
        value === ""
    )
        ? "-"
        : "£" + Number(value).toFixed(2);
}


function prettyStatus(status) {

    return status
        .replaceAll("_", " ")
        .replace(
            /\b\w/g,
            (letter) => letter.toUpperCase()
        );
}


function escapeHtml(value) {

    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}
