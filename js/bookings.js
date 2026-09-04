const bookingsDb = getSupabase();

let allBookings = [];
let allDrivers = [];
let currentTab = "bookings";
let adminCompanyId = null;
let adminViaCounter = 0;

let dispatchMap = null;
let driverMarkers = [];
let liveTimer = null;

document.addEventListener("DOMContentLoaded", async () => {
    try {
        const context = await window.getAdminCompanyContext();
        adminCompanyId = context.companyId;

        setActiveDateRange();
        bindBookingEvents();

        await Promise.all([
            loadDrivers(),
            loadBookings()
        ]);

        await initialiseDispatchMap();
        startLiveRefresh();

    } catch (error) {
        console.error("Bookings startup error:", error);
    }
});


function bindBookingEvents() {

    document.getElementById("addAdminVia")?.addEventListener("click", () => addAdminViaStop());

    document
        .getElementById("adminBookingForm")
        ?.addEventListener("submit", createAdminBooking);

    document
        .getElementById("refreshBookings")
        ?.addEventListener("click", async () => {
            await Promise.all([
                loadDrivers(),
                loadBookings()
            ]);

            refreshDriverMarkers();
        });

    document
        .getElementById("dateFrom")
        ?.addEventListener("change", renderBookings);

    document
        .getElementById("dateTo")
        ?.addEventListener("change", renderBookings);

    document
        .getElementById("searchBookings")
        ?.addEventListener("input", renderBookings);

    document
        .getElementById("statusFilter")
        ?.addEventListener("change", renderBookings);

    document
        .getElementById("focusNewBooking")
        ?.addEventListener("click", () => {
            document
                .getElementById("customerName")
                ?.focus();

            document
                .getElementById("newBookingPanel")
                ?.scrollIntoView({
                    behavior: "smooth"
                });
        });

    document
        .querySelectorAll(".booking-tabs button")
        .forEach(button => {

            button.addEventListener("click", () => {

                document
                    .querySelectorAll(".booking-tabs button")
                    .forEach(item =>
                        item.classList.remove("active")
                    );

                button.classList.add("active");

                currentTab =
                    button.dataset.status;

                if (currentTab === "history") {
                    setHistoryDateRange();
                } else {
                    setActiveDateRange();
                }

                updateStatusFilterForTab();
                renderBookings();
            });
        });

    document
        .getElementById("closeBookingViewButton")
        ?.addEventListener(
            "click",
            closeBookingView
        );

    document.getElementById("resendBookingConfirmation")?.addEventListener("click", resendBookingConfirmation);

    document
        .getElementById("bookingViewBackdrop")
        ?.addEventListener(
            "click",
            event => {
                if (
                    event.target.id ===
                    "bookingViewBackdrop"
                ) {
                    closeBookingView();
                }
            }
        );

    updateStatusFilterForTab();
}


function setActiveDateRange() {

    const today =
        new Date();

    const future =
        new Date(today);

    future.setDate(
        future.getDate() + 14
    );

    const from =
        localDateKey(today);

    const to =
        localDateKey(future);

    const dateFrom =
        document.getElementById("dateFrom");

    const dateTo =
        document.getElementById("dateTo");

    const journeyDate =
        document.getElementById("journeyDate");

    if (dateFrom) {
        dateFrom.value = from;
    }

    if (dateTo) {
        dateTo.value = to;
    }

    if (
        journeyDate &&
        !journeyDate.value
    ) {
        journeyDate.value = from;
    }
}


function setHistoryDateRange() {

    const today =
        new Date();

    const past =
        new Date(today);

    past.setDate(
        past.getDate() - 30
    );

    const dateFrom =
        document.getElementById("dateFrom");

    const dateTo =
        document.getElementById("dateTo");

    if (dateFrom) {
        dateFrom.value =
            localDateKey(past);
    }

    if (dateTo) {
        dateTo.value =
            localDateKey(today);
    }
}


function updateStatusFilterForTab() {

    const select =
        document.getElementById("statusFilter");

    if (!select) return;

    select.value = "";

    if (currentTab === "bookings") {

        select.innerHTML = `
            <option value="">All active statuses</option>
            <option value="waiting">Waiting</option>
            <option value="on_way">On Way</option>
            <option value="passenger_onboard">Passenger Onboard</option>
        `;

    } else if (currentTab === "booked") {

        select.innerHTML = `
            <option value="">All booked statuses</option>
            <option value="booked">Booked</option>
            <option value="assigned">Assigned</option>
            <option value="accepted">Accepted</option>
        `;

    } else {

        select.innerHTML = `
            <option value="">All history</option>
            <option value="completed">Completed</option>
            <option value="cancelled">Cancelled</option>
        `;
    }
}


async function loadDrivers() {

    const { data, error } =
        await bookingsDb
            .from("drivers")
            .select(`
                id,
                company_id,
                driver_number,
                full_name,
                vehicle,
                status,
                online,
                latitude,
                longitude,
                location_updated_at
            `)
            .eq(
                "company_id",
                adminCompanyId
            )
            .order(
                "driver_number",
                {
                    ascending: true
                }
            );

    if (error) {

        console.error(
            "Unable to load drivers:",
            error
        );

        return;
    }

    allDrivers =
        data || [];

    populateDriverDropdown();
}


function populateDriverDropdown() {

    const select =
        document.getElementById("driverSelect");

    if (!select) return;

    select.innerHTML =
        '<option value="">Unassigned</option>';

    allDrivers.forEach(driver => {

        const option =
            document.createElement("option");

        option.value =
            driver.id;

        option.textContent =
            `${driver.driver_number || "-"} — ${driver.full_name || "Driver"}${driver.online ? " • ONLINE" : ""}`;

        select.appendChild(option);
    });
}


async function loadBookings() {

    const body =
        document.getElementById("bookingsBody");

    if (body) {

        body.innerHTML =
            '<tr><td colspan="12" class="empty-row">Loading bookings…</td></tr>';
    }

    const { data, error } =
        await bookingsDb
            .from("bookings")
            .select("*")
            .eq(
                "company_id",
                adminCompanyId
            )
            .order(
                "journey_date",
                {
                    ascending: true
                }
            )
            .order(
                "journey_time",
                {
                    ascending: true
                }
            );

    if (error) {

        console.error(
            "Unable to load bookings:",
            error
        );

        if (body) {

            body.innerHTML =
                `<tr><td colspan="12" class="empty-row">
                    ${escapeHtml(error.message)}
                </td></tr>`;
        }

        return;
    }

    const { data: stops, error: stopsError } = await bookingsDb
        .from("booking_stops")
        .select("*")
        .eq("company_id", adminCompanyId)
        .order("stop_order", { ascending: true });

    if (stopsError) console.error("Unable to load booking stops:", stopsError);
    allBookings = (data || []).map(booking => ({
        ...booking,
        via_stops: (stops || []).filter(stop => String(stop.booking_id) === String(booking.id))
    }));

    updateCounts();
    renderBookings();
}


function bookingStatus(booking) {

    return String(
        booking.status ||
        booking.booking_status ||
        "waiting"
    )
        .trim()
        .toLowerCase()
        .replaceAll(
            " ",
            "_"
        );
}


function matchesTab(booking) {

    const status =
        bookingStatus(booking);

    if (currentTab === "history") {

        return [
            "completed",
            "cancelled",
            "canceled"
        ].includes(status);
    }

    if (currentTab === "booked") {

        return [
            "booked",
            "assigned",
            "accepted"
        ].includes(status);
    }

    /*
       BOOKINGS =
       work that still needs attention / is in progress.
       Assigned/accepted jobs live in Booked until the
       driver starts travelling.
    */

    return [
        "waiting",
        "pending",
        "dispatched",
        "on_way",
        "passenger_onboard"
    ].includes(status);
}


function renderBookings() {

    const from =
        document
            .getElementById("dateFrom")
            ?.value || "";

    const to =
        document
            .getElementById("dateTo")
            ?.value || "";

    const search =
        document
            .getElementById("searchBookings")
            ?.value
            .trim()
            .toLowerCase() || "";

    const statusFilter =
        document
            .getElementById("statusFilter")
            ?.value || "";

    const rows =
        allBookings.filter(booking => {

            if (
                from &&
                booking.journey_date &&
                booking.journey_date < from
            ) {
                return false;
            }

            if (
                to &&
                booking.journey_date &&
                booking.journey_date > to
            ) {
                return false;
            }

            if (
                !matchesTab(booking)
            ) {
                return false;
            }

            if (
                statusFilter &&
                bookingStatus(booking) !==
                statusFilter
            ) {
                return false;
            }

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
                    booking.phone,
                    booking.email,
                    booking.customer_email,
                    booking.flight_number,
                    booking.notes
                ]
                    .filter(Boolean)
                    .join(" ")
                    .toLowerCase();

                if (
                    !haystack.includes(search)
                ) {
                    return false;
                }
            }

            return true;
        });

    const body =
        document.getElementById("bookingsBody");

    if (!body) return;

    if (!rows.length) {

        body.innerHTML =
            '<tr><td colspan="12" class="empty-row">No bookings found for this view.</td></tr>';

        return;
    }

    body.innerHTML =
        rows
            .map(booking =>
                bookingRowHtml(booking)
            )
            .join("");

    body
        .querySelectorAll(
            ".booking-driver-select"
        )
        .forEach(select => {

            select.addEventListener(
                "change",
                () =>
                    assignBookingDriver(
                        select.dataset.bookingId,
                        select.value || null
                    )
            );
        });

    body
        .querySelectorAll(
            "[data-view-booking]"
        )
        .forEach(button => {

            button.addEventListener(
                "click",
                () => {
                    openBookingView(
                        button.dataset.viewBooking
                    );
                }
            );
        });
}


function bookingRowHtml(booking) {

    const status =
        bookingStatus(booking);

    const isHistory =
        currentTab === "history";

    const driverOptions = [
        '<option value="">Unassigned</option>',

        ...allDrivers.map(driver => {

            const selected =
                String(driver.id) ===
                String(booking.driver_id || "")
                ? " selected"
                : "";

            const online =
                driver.online
                    ? " • ONLINE"
                    : "";

            return `
                <option
                    value="${escapeHtml(driver.id)}"
                    ${selected}
                >
                    ${escapeHtml(
                        `${driver.driver_number || "-"} — ${driver.full_name || "Driver"}${online}`
                    )}
                </option>
            `;
        })
    ].join("");

    const driverCell =
        isHistory
            ? escapeHtml(
                driverDisplayName(
                    booking.driver_id
                )
            )
            : `
                <select
                    class="booking-driver-select"
                    data-booking-id="${escapeHtml(booking.id)}"
                >
                    ${driverOptions}
                </select>
            `;

    const actionButtons = `
        <button
            type="button"
            data-view-booking="${escapeHtml(booking.id)}"
        >
            View
        </button>

        ${
            isHistory
                ? ""
                : `
                    <button
                        type="button"
                        onclick="cycleBookingStatus(
                            '${booking.id}',
                            '${status}'
                        )"
                    >
                        Update
                    </button>
                `
        }

        ${
            [
                "completed",
                "cancelled",
                "canceled"
            ].includes(status)
                ? ""
                : `
                    <button
                        type="button"
                        onclick="cancelBooking('${booking.id}')"
                        style="background:#dc2626;color:white;"
                    >
                        Cancel
                    </button>
                `
        }
    `;

    return `
        <tr>

            <td>
                ${escapeHtml(
                    booking.journey_date || ""
                )}
            </td>

            <td>
                ${escapeHtml(
                    formatTime(
                        booking.journey_time
                    )
                )}
            </td>

            <td>
                ${escapeHtml(
                    booking.booking_reference ||
                    shortId(booking.id)
                )}
            </td>

            <td>
                ${escapeHtml(
                    booking.customer_name ||
                    booking.full_name ||
                    "-"
                )}
            </td>

            <td>
                ${escapeHtml(
                    booking.pickup_address ||
                    booking.pickup ||
                    "-"
                )}
            </td>

            <td>
                ${escapeHtml(
                    booking.dropoff_address ||
                    booking.destination ||
                    "-"
                )}
            </td>

            <td>
                ${driverCell}
            </td>

            <td>
                ${money(
                    booking.price ??
                    booking.job_price
                )}
            </td>

            <td>
                ${escapeHtml(
                    booking.payment_method ||
                    booking.payment_status ||
                    "-"
                )}
            </td>

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
                        prettyStatus(status)
                    )}
                </span>
            </td>

            <td>
                <div
                    style="
                        display:flex;
                        gap:6px;
                        flex-wrap:wrap;
                    "
                >
                    ${actionButtons}
                </div>
            </td>

        </tr>
    `;
}


async function assignBookingDriver(
    bookingId,
    driverId
) {

    const booking =
        allBookings.find(
            row =>
                String(row.id) ===
                String(bookingId)
        );

    if (!booking) return;

    const update = {

        driver_id:
            driverId,

        status:
            driverId
                ? "assigned"
                : "waiting",

        dispatched_at:
            driverId
                ? new Date().toISOString()
                : null
    };

    const { error } =
        await bookingsDb
            .from("bookings")
            .update(update)
            .eq(
                "id",
                bookingId
            )
            .eq(
                "company_id",
                adminCompanyId
            );

    if (error) {

        alert(
            "Unable to assign driver: " +
            error.message
        );

        await loadBookings();

        return;
    }

    await requestGoogleCalendarSync(bookingId);

    await loadBookings();
}


async function createAdminBooking(event) {

    event.preventDefault();

    const message =
        document.getElementById(
            "bookingMessage"
        );

    if (message) {
        message.textContent =
            "Saving…";
    }

    const driverId =
        document
            .getElementById("driverSelect")
            ?.value || null;

    const selectedStatus =
        document
            .getElementById("bookingStatus")
            ?.value || "waiting";

    const customerName = document.getElementById("customerName")?.value.trim() || "";
    const customerEmail = document.getElementById("customerEmail")?.value.trim() || null;
    const customerPhone = document.getElementById("customerPhone")?.value.trim() || null;
    const [customerResult, referenceResult] = await Promise.all([
        bookingsDb.rpc("find_or_create_admin_customer", {
            target_company_id: adminCompanyId,
            customer_name: customerName,
            customer_email: customerEmail,
            customer_phone: customerPhone
        }),
        bookingsDb.rpc("next_admin_booking_reference", { target_company_id: adminCompanyId })
    ]);

    if (customerResult.error || referenceResult.error) {
        if (message) message.textContent = "Could not link customer/reference: " + (customerResult.error?.message || referenceResult.error?.message);
        return;
    }

    const payload = {

        id: crypto.randomUUID(),

        company_id:
            adminCompanyId,

        booking_reference: referenceResult.data,

        customer_id: customerResult.data,

        customer_name:
            customerName,

        customer_email:
            customerEmail,

        customer_phone:
            customerPhone,

        pickup_address:
            document
                .getElementById("pickupAddress")
                ?.value
                .trim() || "",

        pickup_name: document.getElementById("pickupName")?.value.trim() || null,
        pickup_postcode: document.getElementById("pickupPostcode")?.value.trim() || null,
        pickup_place_id: document.getElementById("pickupAddress")?.dataset.placeId || null,
        pickup_lat: document.getElementById("pickupAddress")?.dataset.lat ? Number(document.getElementById("pickupAddress").dataset.lat) : null,
        pickup_lng: document.getElementById("pickupAddress")?.dataset.lng ? Number(document.getElementById("pickupAddress").dataset.lng) : null,

        dropoff_address:
            document
                .getElementById("dropoffAddress")
                ?.value
                .trim() || "",

        dropoff_name: document.getElementById("dropoffName")?.value.trim() || null,
        dropoff_postcode: document.getElementById("dropoffPostcode")?.value.trim() || null,
        dropoff_place_id: document.getElementById("dropoffAddress")?.dataset.placeId || null,
        dropoff_lat: document.getElementById("dropoffAddress")?.dataset.lat ? Number(document.getElementById("dropoffAddress").dataset.lat) : null,
        dropoff_lng: document.getElementById("dropoffAddress")?.dataset.lng ? Number(document.getElementById("dropoffAddress").dataset.lng) : null,

        journey_date:
            document
                .getElementById("journeyDate")
                ?.value || null,

        journey_time:
            document
                .getElementById("journeyTime")
                ?.value || null,

        passengers:
            Number(
                document
                    .getElementById("passengers")
                    ?.value || 1
            ),

        job_price:
            document
                .getElementById("jobPrice")
                ?.value === ""
                ? null
                : Number(
                    document
                        .getElementById("jobPrice")
                        ?.value
                ),

        payment_method:
            document
                .getElementById("paymentMethod")
                ?.value || "cash",

        driver_id:
            driverId,

        status:
            driverId &&
            selectedStatus === "waiting"
                ? "assigned"
                : selectedStatus,

        notes:
            document
                .getElementById("notes")
                ?.value
                .trim() || null,

        booking_source:
            "admin"
    };

    if (driverId) {

        payload.dispatched_at =
            new Date().toISOString();
    }

    const { error } =
        await bookingsDb
            .from("bookings")
            .insert(payload);

    if (error) {

        if (message) {

            message.textContent =
                "Could not save: " +
                error.message;
        }

        return;
    }

    const viaStops = collectAdminViaStops();
    if (viaStops.length) {
        const { error: stopError } = await bookingsDb.from("booking_stops").insert(
            viaStops.map(stop => ({ ...stop, company_id: adminCompanyId, booking_id: payload.id }))
        );
        if (stopError) {
            if (message) message.textContent = "Booking saved, but via stops could not be saved: " + stopError.message;
            return;
        }
    }

    await requestGoogleCalendarSync(payload.id);

    await requestBookingConfirmation(payload.id, false);

    if (message) {

        message.textContent =
            "Booking saved.";
    }

    event.target.reset();
    document.getElementById("adminViaStops").innerHTML = "";

    setActiveDateRange();

    populateDriverDropdown();

    await loadBookings();
}


async function cancelBooking(id) {

    if (
        !confirm(
            "Cancel this booking?"
        )
    ) {
        return;
    }

    const { error } =
        await bookingsDb
            .from("bookings")
            .update({
                status:
                    "cancelled",

                booking_status:
                    "cancelled",

                cancelled_at:
                    new Date()
                        .toISOString()
            })
            .eq(
                "id",
                id
            )
            .eq(
                "company_id",
                adminCompanyId
            );

    if (error) {

        alert(error.message);

        return;
    }

    await requestGoogleCalendarSync(id);

    await loadBookings();
}


async function cycleBookingStatus(
    id,
    current
) {

    const sequence = [
        "waiting",
        "assigned",
        "accepted",
        "on_way",
        "passenger_onboard",
        "completed"
    ];

    const index =
        sequence.indexOf(current);

    const next =
        index >= 0
            ? (
                sequence[index + 1] ||
                "completed"
            )
            : "waiting";

    const update = {
        status: next
    };

    const now =
        new Date().toISOString();

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

    const { error } =
        await bookingsDb
            .from("bookings")
            .update(update)
            .eq(
                "id",
                id
            )
            .eq(
                "company_id",
                adminCompanyId
            );

    if (error) {

        alert(error.message);

        return;
    }

    await requestGoogleCalendarSync(id);

    await loadBookings();
}


/* =========================================================
   FULL BOOKING VIEW
   ========================================================= */

function openBookingView(id) {

    const booking =
        allBookings.find(
            row =>
                String(row.id) ===
                String(id)
        );

    if (!booking) return;

    const resendButton = document.getElementById("resendBookingConfirmation");
    if (resendButton) resendButton.dataset.bookingId = booking.id;

    const status =
        bookingStatus(booking);

    setText(
        "viewBookingTitle",
        booking.booking_reference ||
        shortId(booking.id)
    );

    setText(
        "viewBookingSubtitle",
        `${prettyStatus(status)} • ${booking.journey_date || ""} ${formatTime(booking.journey_time)}`
    );

    setText(
        "viewReference",
        booking.booking_reference ||
        shortId(booking.id)
    );

    setText(
        "viewStatus",
        prettyStatus(status)
    );

    setText(
        "viewDate",
        formatDate(
            booking.journey_date
        )
    );

    setText(
        "viewTime",
        formatTime(
            booking.journey_time
        ) || "-"
    );

    setText(
        "viewSource",
        booking.booking_source ||
        "website"
    );

    setText(
        "viewDriver",
        driverDisplayName(
            booking.driver_id
        )
    );

    setText(
        "viewCustomerName",
        booking.customer_name ||
        booking.full_name ||
        "-"
    );

    setText(
        "viewCustomerPhone",
        booking.customer_phone ||
        booking.phone ||
        "-"
    );

    setText(
        "viewCustomerEmail",
        booking.customer_email ||
        booking.email ||
        "-"
    );

    setText(
        "viewPickup",
        booking.pickup_address ||
        booking.pickup ||
        "-"
    );

    setText(
        "viewDestination",
        booking.dropoff_address ||
        booking.destination ||
        "-"
    );

    setText("viewViaStops", (booking.via_stops || []).map(stop => `${stop.stop_order}. ${stop.formatted_address}`).join("\n") || "-");

    setText(
        "viewJourneyType",
        prettyLabel(
            booking.journey_type ||
            "-"
        )
    );

    setText(
        "viewAirport",
        booking.airport ||
        "-"
    );

    setText(
        "viewFlightNumber",
        booking.flight_number ||
        "-"
    );

    setText(
        "viewPassengers",
        booking.passengers ??
        "-"
    );

    setText(
        "viewSuitcases",
        booking.suitcases ??
        "-"
    );

    setText(
        "viewHandLuggage",
        booking.hand_luggage ??
        "-"
    );

    setText(
        "viewPrice",
        money(
            booking.price ??
            booking.job_price
        )
    );

    setText(
        "viewPayment",
        booking.payment_method ||
        booking.payment_status ||
        "-"
    );

    setText(
        "viewDistance",
        booking.route_distance_miles != null
            ? `${Number(booking.route_distance_miles).toFixed(1)} miles`
            : "-"
    );

    setText(
        "viewDuration",
        booking.route_duration_minutes != null
            ? formatMinutes(
                Number(
                    booking.route_duration_minutes
                )
            )
            : "-"
    );

    setText(
        "viewPricingMethod",
        booking.pricing_method ||
        "-"
    );

    setText(
        "viewNotes",
        booking.notes ||
        "-"
    );

    setText(
        "viewDispatchedAt",
        formatDateTime(
            booking.dispatched_at
        )
    );

    setText(
        "viewOnWayAt",
        formatDateTime(
            booking.on_way_at
        )
    );

    setText(
        "viewPobAt",
        formatDateTime(
            booking.passenger_onboard_at
        )
    );

    setText(
        "viewCompletedAt",
        formatDateTime(
            booking.completed_at
        )
    );

    setText(
        "viewCancelledAt",
        formatDateTime(
            booking.cancelled_at
        )
    );

    renderLinkedBooking(
        booking
    );

    document
        .getElementById(
            "bookingViewBackdrop"
        )
        ?.classList.add(
            "open"
        );
}

async function resendBookingConfirmation() {
    const id = document.getElementById("resendBookingConfirmation")?.dataset.bookingId;
    if (!id) return;
    await requestBookingConfirmation(id, true);
}

async function requestBookingConfirmation(bookingId, notify) {
    const { data, error } = await bookingsDb.functions.invoke("send-booking-email", { body: { company_id: adminCompanyId, booking_id: bookingId, template_key: "booking_confirmation" } });
    if (error || !data?.ok) {
        console.error("Booking email:", error || data?.error);
        if (notify) alert(data?.error || error?.message || "Unable to send confirmation.");
        return;
    }
    if (notify) alert("Confirmation email sent.");
}

async function requestGoogleCalendarSync(bookingId) {
    const { data, error } = await bookingsDb.functions.invoke("google-calendar-sync", {
        body: { company_id: adminCompanyId, booking_id: bookingId }
    });

    if (error || !data?.ok) {
        console.error("Google Calendar sync failed", {
            company_id: adminCompanyId,
            booking_id: bookingId,
            stage: data?.stage,
            error: data?.error || error?.message || "Unknown Edge Function error"
        });
        return false;
    }

    console.info("Google Calendar sync completed", data);
    return true;
}


function closeBookingView() {

    document
        .getElementById(
            "bookingViewBackdrop"
        )
        ?.classList.remove(
            "open"
        );
}


function renderLinkedBooking(booking) {

    const area =
        document.getElementById(
            "linkedBookingArea"
        );

    if (!area) return;

    const root =
        referenceRoot(
            booking.booking_reference
        );

    if (!root) {

        area.innerHTML =
            '<div class="empty-row">No linked outbound / return journey.</div>';

        return;
    }

    const linked =
        allBookings.filter(row => {

            if (
                String(row.id) ===
                String(booking.id)
            ) {
                return false;
            }

            return (
                referenceRoot(
                    row.booking_reference
                ) === root
            );
        });

    if (!linked.length) {

        area.innerHTML =
            '<div class="empty-row">No linked outbound / return journey.</div>';

        return;
    }

    area.innerHTML =
        linked
            .map(row => `
                <div class="linked-job">

                    <div>
                        <strong>
                            ${escapeHtml(
                                row.booking_reference ||
                                shortId(row.id)
                            )}
                        </strong>

                        <span>
                            ${escapeHtml(
                                `${formatDate(row.journey_date)} ${formatTime(row.journey_time)} • ${prettyStatus(bookingStatus(row))}`
                            )}
                        </span>

                        <span>
                            ${escapeHtml(
                                `${row.pickup_address || row.pickup || "-"} → ${row.dropoff_address || row.destination || "-"}`
                            )}
                        </span>
                    </div>

                    <button
                        type="button"
                        data-linked-booking="${escapeHtml(row.id)}"
                    >
                        View
                    </button>

                </div>
            `)
            .join("");

    area
        .querySelectorAll(
            "[data-linked-booking]"
        )
        .forEach(button => {

            button.addEventListener(
                "click",
                () => {
                    openBookingView(
                        button.dataset.linkedBooking
                    );
                }
            );
        });
}


function referenceRoot(reference) {

    const value =
        String(reference || "")
            .trim();

    if (!value) return "";

    return value.endsWith("-R")
        ? value.slice(0, -2)
        : value;
}


/* =========================================================
   COUNTS
   ========================================================= */

function updateCounts() {

    setCount(
        "countBookings",
        allBookings.filter(booking => {

            const status =
                bookingStatus(booking);

            return [
                "waiting",
                "pending",
                "dispatched",
                "on_way",
                "passenger_onboard"
            ].includes(status);
        }).length
    );

    setCount(
        "countBooked",
        allBookings.filter(booking => {

            const status =
                bookingStatus(booking);

            return [
                "booked",
                "assigned",
                "accepted"
            ].includes(status);
        }).length
    );

    setCount(
        "countHistory",
        allBookings.filter(booking => {

            const status =
                bookingStatus(booking);

            return [
                "completed",
                "cancelled",
                "canceled"
            ].includes(status);
        }).length
    );
}


function setCount(
    id,
    value
) {

    const element =
        document.getElementById(id);

    if (element) {

        element.textContent =
            value;
    }
}


/* =========================================================
   GOOGLE MAP / AUTOCOMPLETE
   ========================================================= */

async function initialiseDispatchMap() {

    const message =
        document.getElementById(
            "mapMessage"
        );

    try {

        const { data, error } =
            await bookingsDb
                .from("settings")
                .select(
                    "googlemapsapi"
                )
                .eq(
                    "company_id",
                    adminCompanyId
                )
                .maybeSingle();

        if (error) {
            throw error;
        }

        if (
            !data?.googlemapsapi
        ) {

            if (message) {

                message.textContent =
                    "Google Maps API key not found.";
            }

            return;
        }

        await loadGoogleMaps(
            data.googlemapsapi
        );

        setupAdminAutocomplete(
            "pickupAddress"
        );

        setupAdminAutocomplete(
            "dropoffAddress"
        );

        dispatchMap =
            new google.maps.Map(
                document.getElementById(
                    "dispatchMap"
                ),
                {
                    center: {
                        lat: 51.445,
                        lng: -3.235
                    },

                    zoom: 10,

                    mapTypeControl:
                        true,

                    streetViewControl:
                        false,

                    fullscreenControl:
                        true
                }
            );

        refreshDriverMarkers();

        if (message) {

            message.textContent =
                "Online drivers with GPS positions appear automatically.";
        }

    } catch (error) {

        console.error(
            "Map error:",
            error
        );

        if (message) {

            message.textContent =
                "Unable to load Google Map: " +
                error.message;
        }
    }
}


function loadGoogleMaps(apiKey) {

    if (
        window.google
            ?.maps
            ?.places
            ?.Autocomplete
    ) {
        return Promise.resolve();
    }

    return new Promise(
        (
            resolve,
            reject
        ) => {

            const callbackName =
                "__bookingsGoogleMapsLoaded";

            window[callbackName] =
                () => {

                    resolve();

                    delete window[
                        callbackName
                    ];
                };

            const script =
                document.createElement(
                    "script"
                );

            script.src =
                "https://maps.googleapis.com/maps/api/js" +
                "?key=" +
                encodeURIComponent(
                    apiKey
                ) +
                "&libraries=places" +
                "&loading=async" +
                "&callback=" +
                callbackName;

            script.async =
                true;

            script.onerror =
                () =>
                    reject(
                        new Error(
                            "Google Maps JavaScript API failed to load."
                        )
                    );

            document
                .head
                .appendChild(
                    script
                );
        }
    );
}


function setupAdminAutocomplete(id) {

    const input =
        document.getElementById(id);

    if (!input) return;

    const autocomplete =
        new google.maps.places.Autocomplete(
            input,
            {
                componentRestrictions: {
                    country: "gb"
                },

                fields: [
                    "formatted_address",
                    "geometry",
                    "name",
                    "place_id",
                    "address_components"
                ]
            }
        );

    autocomplete.addListener(
        "place_changed",
        () => {

            const place =
                autocomplete.getPlace();

            if (
                !place
                    ?.geometry
                    ?.location
            ) {
                return;
            }

            input.value =
                place.formatted_address ||
                place.name ||
                "";

            input.dataset.lat =
                place.geometry.location.lat();

            input.dataset.lng =
                place.geometry.location.lng();
            input.dataset.placeId = place.place_id || "";
            const postcode = (place.address_components || []).find(component => component.types.includes("postal_code"))?.long_name || "";
            const postcodeInput = document.getElementById(id === "pickupAddress" ? "pickupPostcode" : "dropoffPostcode");
            if (postcodeInput && postcode) postcodeInput.value = postcode;
        }
    );
}

function addAdminViaStop() {
    adminViaCounter += 1;
    const row = document.createElement("div");
    row.className = "admin-via-row";
    row.innerHTML = `<input class="admin-via-address" placeholder="Via stop ${adminViaCounter}" autocomplete="off"><button type="button">Remove</button>`;
    row.querySelector("button").onclick = () => row.remove();
    document.getElementById("adminViaStops").appendChild(row);
    if (window.google?.maps?.places) {
        const input = row.querySelector("input");
        const autocomplete = new google.maps.places.Autocomplete(input, { componentRestrictions: { country: "gb" }, fields: ["formatted_address", "geometry", "place_id", "address_components"] });
        autocomplete.addListener("place_changed", () => { const place = autocomplete.getPlace(); if (!place?.geometry?.location) return; input.value = place.formatted_address || ""; input.dataset.lat = place.geometry.location.lat(); input.dataset.lng = place.geometry.location.lng(); input.dataset.placeId = place.place_id || ""; input.dataset.postcode = (place.address_components || []).find(c => c.types.includes("postal_code"))?.long_name || ""; });
    }
}

function collectAdminViaStops() {
    return [...document.querySelectorAll("#adminViaStops .admin-via-address")].map((input, index) => ({ stop_order: index + 1, label: "Via", formatted_address: input.value.trim(), postcode: input.dataset.postcode || null, latitude: input.dataset.lat ? Number(input.dataset.lat) : null, longitude: input.dataset.lng ? Number(input.dataset.lng) : null, place_id: input.dataset.placeId || null })).filter(stop => stop.formatted_address);
}


function refreshDriverMarkers() {

    if (
        !dispatchMap ||
        !window.google
    ) {
        return;
    }

    driverMarkers.forEach(
        marker =>
            marker.setMap(null)
    );

    driverMarkers = [];

    allDrivers
        .filter(driver =>

            driver.online === true &&

            Number.isFinite(
                Number(
                    driver.latitude
                )
            ) &&

            Number.isFinite(
                Number(
                    driver.longitude
                )
            )
        )
        .forEach(driver => {

            const number =
                String(
                    driver.driver_number ||
                    "DRV"
                );

            const marker =
                new google.maps.Marker({

                    position: {
                        lat:
                            Number(
                                driver.latitude
                            ),

                        lng:
                            Number(
                                driver.longitude
                            )
                    },

                    map:
                        dispatchMap,

                    title:
                        `${number} ${driver.full_name || "Driver"}`,

                    label: {
                        text:
                            number,

                        color:
                            "#ffffff",

                        fontWeight:
                            "700"
                    }
                });

            const info =
                new google.maps.InfoWindow({

                    content:
                        `<strong>${escapeHtml(number)} — ${escapeHtml(driver.full_name || "Driver")}</strong><br>${escapeHtml(driver.vehicle || "")}`
                });

            marker.addListener(
                "click",
                () =>
                    info.open({
                        anchor:
                            marker,

                        map:
                            dispatchMap
                    })
            );

            driverMarkers.push(
                marker
            );
        });
}


/* =========================================================
   LIVE REFRESH
   ========================================================= */

function startLiveRefresh() {

    liveTimer =
        setInterval(
            async () => {

                await Promise.all([
                    loadDrivers(),
                    loadBookings()
                ]);

                refreshDriverMarkers();

            },
            10000
        );
}


window.addEventListener(
    "beforeunload",
    () => {

        if (liveTimer) {

            clearInterval(
                liveTimer
            );
        }
    }
);


/* =========================================================
   HELPERS
   ========================================================= */

function driverDisplayName(id) {

    if (!id) {
        return "Unassigned";
    }

    const driver =
        allDrivers.find(
            row =>
                String(row.id) ===
                String(id)
        );

    if (!driver) {
        return "Driver";
    }

    return `${driver.driver_number || "-"} — ${driver.full_name || "Driver"}`;
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
        ? String(time)
            .slice(0, 5)
        : "";
}


function formatDate(value) {

    if (!value) {
        return "-";
    }

    const parts =
        String(value)
            .split("-");

    return parts.length === 3
        ? `${parts[2]}/${parts[1]}/${parts[0]}`
        : value;
}


function formatDateTime(value) {

    if (!value) {
        return "-";
    }

    const date =
        new Date(value);

    if (
        Number.isNaN(
            date.getTime()
        )
    ) {
        return value;
    }

    return date.toLocaleString(
        "en-GB",
        {
            day:
                "2-digit",

            month:
                "2-digit",

            year:
                "numeric",

            hour:
                "2-digit",

            minute:
                "2-digit",

            hour12:
                false
        }
    );
}


function formatMinutes(minutes) {

    if (
        !Number.isFinite(minutes)
    ) {
        return "-";
    }

    const hours =
        Math.floor(
            minutes / 60
        );

    const remainder =
        Math.round(
            minutes % 60
        );

    if (hours) {

        return remainder
            ? `${hours} hr ${remainder} min`
            : `${hours} hr`;
    }

    return `${remainder} min`;
}


function money(value) {

    return (
        value === null ||
        value === undefined ||
        value === ""
    )
        ? "-"
        : "£" +
            Number(value)
                .toFixed(2);
}


function prettyStatus(status) {

    return String(
        status || ""
    )
        .replaceAll(
            "_",
            " "
        )
        .replace(
            /\b\w/g,
            letter =>
                letter.toUpperCase()
        );
}


function prettyLabel(value) {

    if (
        value === null ||
        value === undefined ||
        value === ""
    ) {
        return "-";
    }

    return String(value)
        .replaceAll(
            "_",
            " "
        )
        .replace(
            /\b\w/g,
            letter =>
                letter.toUpperCase()
        );
}


function localDateKey(date) {

    return (
        date.getFullYear() +
        "-" +
        String(
            date.getMonth() + 1
        ).padStart(
            2,
            "0"
        ) +
        "-" +
        String(
            date.getDate()
        ).padStart(
            2,
            "0"
        )
    );
}


function setText(
    id,
    value
) {

    const element =
        document.getElementById(id);

    if (element) {

        element.textContent =
            value ?? "-";
    }
}


function escapeHtml(value) {

    return String(
        value ?? ""
    )
        .replaceAll(
            "&",
            "&amp;"
        )
        .replaceAll(
            "<",
            "&lt;"
        )
        .replaceAll(
            ">",
            "&gt;"
        )
        .replaceAll(
            '"',
            "&quot;"
        )
        .replaceAll(
            "'",
            "&#039;"
        );
}
