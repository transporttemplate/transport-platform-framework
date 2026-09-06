const bookingsDb = getSupabase();

let allBookings = [];
let allDrivers = [];
let allAccountCustomers = [];
let currentTab = "bookings";
let adminCompanyId = null;
let adminStopCounters = { pickup: 0, dropoff: 0 };

let dispatchMap = null;
let driverMarkers = [];
let liveTimer = null;
let adminBookingFormDirty = false;
let liveRefreshRunning = false;
let quoteSettings = {};
let quoteAirports = [];
let quoteDirectionsService = null;
let quoteDirectionsRenderer = null;
let quoteTimer = null;
let customerPriceManual = false;
let settingCustomerPrice = false;
let lastRouteQuote = null;

document.addEventListener("DOMContentLoaded", async () => {
    try {
        const context = await window.getAdminCompanyContext();
        adminCompanyId = context.companyId;

        setActiveDateRange();
        bindBookingEvents();

        await Promise.all([
            loadDrivers(),
            loadBookings(),
            loadQuotePricing(),
            loadAccountCustomers()
        ]);

        await initialiseDispatchMap();
        startLiveRefresh();

    } catch (error) {
        console.error("Bookings startup error:", error);
    }
});


function bindBookingEvents() {

    const adminForm = document.getElementById("adminBookingForm");
    adminForm?.addEventListener("input", () => { adminBookingFormDirty = true; });
    adminForm?.addEventListener("change", () => { adminBookingFormDirty = true; });

    document.getElementById("addAdminPickup")?.addEventListener("click", () => addAdminStop("pickup"));
    document.getElementById("addAdminDropoff")?.addEventListener("click", () => addAdminStop("dropoff"));
    document.getElementById("saveBookingDriverAmount")?.addEventListener("click", saveBookingDriverAmount);
    document.getElementById("recalculateQuote")?.addEventListener("click", () => calculateRouteQuote(true));
    document.getElementById("paymentMethod")?.addEventListener("change", updateAdminAccountSelector);
    document.getElementById("editPaymentMethod")?.addEventListener("change", updateEditAccountSelector);

    document.getElementById("passengers")?.addEventListener("change", () => calculateRouteQuote(false));
    document.getElementById("jobPrice")?.addEventListener("input", () => {
        if (!settingCustomerPrice) customerPriceManual = true;
    });

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
    document.getElementById("saveBookingPaymentMethod")?.addEventListener("click", saveBookingPaymentMethod);

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

async function loadAccountCustomers() {
    const { data, error } = await bookingsDb.from("account_customers")
        .select("id,company_id,account_code,business_name,status,po_required,default_po_reference")
        .eq("company_id", adminCompanyId).order("business_name");
    if (error) { console.error("Unable to load account customers:", error); return; }
    allAccountCustomers = data || [];
    for (const id of ["accountCustomerSelect", "editAccountCustomer"]) {
        const select = document.getElementById(id);
        if (!select) continue;
        const choices = id === "accountCustomerSelect"
            ? allAccountCustomers.filter(account => account.status === "active")
            : allAccountCustomers;
        select.innerHTML = '<option value="">Select account customer</option>' + choices.map(account => `<option value="${escapeHtml(account.id)}">${escapeHtml(account.account_code)} — ${escapeHtml(account.business_name)}${account.status === "active" ? "" : ` (${escapeHtml(account.status)})`}</option>`).join("");
    }
    updateAdminAccountSelector();
    if (allBookings.length) renderBookings();
}

function updateAdminAccountSelector() {
    const select = document.getElementById("accountCustomerSelect");
    if (select) { select.hidden = canonicalPaymentMethod(document.getElementById("paymentMethod")?.value) !== "account"; select.required = !select.hidden; }
    const po = document.getElementById("accountPoReference");
    if (po) po.hidden = select?.hidden !== false;
}
function updateEditAccountSelector() {
    const select = document.getElementById("editAccountCustomer");
    if (select) { select.hidden = canonicalPaymentMethod(document.getElementById("editPaymentMethod")?.value) !== "account"; select.required = !select.hidden; }
    const po = document.getElementById("editAccountPoReference");
    if (po) po.hidden = select?.hidden !== false;
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

async function loadQuotePricing() {
    const [settingsResult, airportsResult] = await Promise.all([
        bookingsDb.from("settings")
            .select("company_id,airportpricing,distancecalculator,minimumfare,firstmile,mileband1,mileband2,mileband3,mileband4,mileband5,mileband6,bookingfee,airportviasurcharge,currencysymbol")
            .eq("company_id", adminCompanyId)
            .maybeSingle(),
        bookingsDb.from("airports")
            .select("id,company_id,name,code,active,price_1_4_oneway,price_5_7_oneway")
            .eq("company_id", adminCompanyId)
            .eq("active", true)
            .order("sort_order", { ascending: true })
    ]);
    if (settingsResult.error) console.error("Unable to load quote settings:", settingsResult.error);
    if (airportsResult.error) console.error("Unable to load airport prices:", airportsResult.error);
    quoteSettings = settingsResult.data || {};
    quoteAirports = airportsResult.data || [];
}


async function loadBookings() {

    const body =
        document.getElementById("bookingsBody");

    if (body) {

        body.innerHTML =
            '<tr><td colspan="13" class="empty-row">Loading bookings…</td></tr>';
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
                `<tr><td colspan="13" class="empty-row">
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
            '<tr><td colspan="13" class="empty-row">No bookings found for this view.</td></tr>';

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
    const paymentClass = bookingPaymentClass(booking);

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
        <tr class="${paymentClass}">

            <td data-label="Date">
                ${escapeHtml(
                    booking.journey_date || ""
                )}
            </td>

            <td data-label="Time">
                ${escapeHtml(
                    formatTime(
                        booking.journey_time
                    )
                )}
            </td>

            <td data-label="Reference">
                ${escapeHtml(
                    booking.booking_reference ||
                    shortId(booking.id)
                )}
            </td>

            <td data-label="Customer">
                ${escapeHtml(
                    booking.customer_name ||
                    booking.full_name ||
                    "-"
                )}
                ${booking.account_customer_id ? `<br><small>${escapeHtml(accountBookingLabel(booking))}</small>` : ""}
            </td>

            <td data-label="Pickup">
                ${escapeHtml(
                    booking.pickup_address ||
                    booking.pickup ||
                    "-"
                )}
            </td>

            <td data-label="Destination">
                ${escapeHtml(
                    booking.dropoff_address ||
                    booking.destination ||
                    "-"
                )}
            </td>

            <td data-label="Driver">
                ${driverCell}
            </td>

            <td data-label="Price">
                ${money(
                    booking.price ??
                    booking.job_price
                )}
            </td>

            <td data-label="Driver Amount">
                ${booking.driver_amount == null ? "—" : money(booking.driver_amount)}
            </td>

            <td data-label="Payment">
                ${escapeHtml(
                    booking.payment_method ||
                    booking.payment_status ||
                    "-"
                )}
            </td>

            <td data-label="Source">
                <span class="source-pill">
                    ${escapeHtml(
                        booking.booking_source ||
                        "website"
                    )}
                </span>
            </td>

            <td data-label="Status">
                <span class="status-pill">
                    ${escapeHtml(
                        prettyStatus(status)
                    )}
                </span>
            </td>

            <td data-label="Actions">
                <div class="booking-actions">
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

    const previousDriverId = booking.driver_id || null;
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

    if (driverId && ["account", "card"].includes(canonicalPaymentMethod(booking.payment_method))) {
        const entered = prompt(
            "Driver Amount (£) for this account/prepaid job. This is the driver-visible commission base.",
            booking.driver_amount == null ? "" : Number(booking.driver_amount).toFixed(2)
        );
        if (entered === null) {
            renderBookings();
            return;
        }
        if (entered.trim() === "" || !Number.isFinite(Number(entered)) || Number(entered) < 0) {
            alert("Enter a valid Driver Amount before assigning this account/prepaid job.");
            renderBookings();
            return;
        }
        update.driver_amount = Number(entered);
    }

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

    await requestBookingEmailEvent(bookingId, "driver_assignment", { previous_driver_id: previousDriverId, event_id: `assignment:${Date.now()}` });

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

    const newPaymentMethod = document.getElementById("paymentMethod")?.value || "cash";
    const selectedAccountId = document.getElementById("accountCustomerSelect")?.value || null;
    if (canonicalPaymentMethod(newPaymentMethod) === "account" && !selectedAccountId) {
        if (message) message.textContent = "Select an account customer.";
        return;
    }
    const selectedAccount = allAccountCustomers.find(row => row.id === selectedAccountId);
    if (selectedAccount?.po_required && !document.getElementById("accountPoReference")?.value.trim() && !selectedAccount.default_po_reference) {
        if (message) message.textContent = "This account requires a PO/reference.";
        return;
    }
    const newDriverAmountValue = document.getElementById("driverAmount")?.value ?? "";
    if (driverId && ["account", "card"].includes(canonicalPaymentMethod(newPaymentMethod)) && newDriverAmountValue === "") {
        if (message) message.textContent = "Enter a Driver Amount before assigning an account/prepaid job.";
        document.getElementById("driverAmount")?.focus();
        return;
    }

    const customerName = document.getElementById("customerName")?.value.trim() || "";
    const customerEmail = document.getElementById("customerEmail")?.value.trim() || null;
    const customerPhone = document.getElementById("customerPhone")?.value.trim() || null;
    const pickupAddress = window.TransportAddressAutocomplete.metadata("pickupAddress");
    const dropoffAddress = window.TransportAddressAutocomplete.metadata("dropoffAddress");
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
        pickup_postcode: pickupAddress.postcode,
        pickup_place_id: pickupAddress.placeId,
        pickup_lat: pickupAddress.latitude,
        pickup_lng: pickupAddress.longitude,

        dropoff_address:
            document
                .getElementById("dropoffAddress")
                ?.value
                .trim() || "",

        dropoff_name: document.getElementById("dropoffName")?.value.trim() || null,
        dropoff_postcode: dropoffAddress.postcode,
        dropoff_place_id: dropoffAddress.placeId,
        dropoff_lat: dropoffAddress.latitude,
        dropoff_lng: dropoffAddress.longitude,

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

        price:
            document
                .getElementById("jobPrice")
                ?.value === ""
                ? null
                : Number(
                    document
                        .getElementById("jobPrice")
                        ?.value
                ),

        driver_amount:
            document.getElementById("driverAmount")?.value === ""
                ? null
                : Number(document.getElementById("driverAmount")?.value),

        payment_method: newPaymentMethod,
        payment_status: canonicalPaymentMethod(newPaymentMethod) === "account" ? "unpaid" : "unpaid",
        account_customer_id: canonicalPaymentMethod(newPaymentMethod) === "account" ? selectedAccountId : null,
        account_po_reference: canonicalPaymentMethod(newPaymentMethod) === "account" ? (document.getElementById("accountPoReference")?.value.trim() || selectedAccount?.default_po_reference || null) : null,

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

    if (lastRouteQuote) {
        payload.route_distance_miles = Number(lastRouteQuote.miles.toFixed(3));
        payload.route_duration_minutes = Math.round(lastRouteQuote.minutes);
        payload.pricing_method = lastRouteQuote.method;
    }

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

    await requestBookingEmailEvent(payload.id, "new_booking");

    if (message) {

        message.textContent =
            "Booking saved.";
    }

    event.target.reset();
    adminBookingFormDirty = false;
    customerPriceManual = false;
    clearRouteQuote();
    document.getElementById("adminPickupStops").innerHTML = "";
    document.getElementById("adminDropoffStops").innerHTML = "";
    adminStopCounters = { pickup: 0, dropoff: 0 };

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

    await requestBookingEmailEvent(id, "booking_cancelled");

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

async function openBookingView(id) {

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
        bookingAddressDisplay(booking.pickup_name, booking.pickup_address || booking.pickup)
    );

    setText(
        "viewDestination",
        bookingAddressDisplay(booking.dropoff_name, booking.dropoff_address || booking.destination)
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

    setText("viewDriverAmount", booking.driver_amount == null ? "Not set — existing fare behavior" : money(booking.driver_amount));
    const driverAmountInput = document.getElementById("editDriverAmount");
    if (driverAmountInput) driverAmountInput.value = booking.driver_amount == null ? "" : booking.driver_amount;
    const driverAmountSave = document.getElementById("saveBookingDriverAmount");
    if (driverAmountSave) driverAmountSave.dataset.bookingId = booking.id;

    setText(
        "viewPayment",
        booking.payment_method ||
        booking.payment_status ||
        "-"
    );
    setText("viewPaymentStatus",prettyStatus(booking.payment_status||"unpaid"));
    setText("viewAmountPaid",money(Number(booking.amount_paid||0)));
    setText("viewBalanceDue",money(Number(booking.balance_due??booking.price??booking.job_price??0)));
    setText("viewStripeReference","—");
    const paymentResult=await bookingsDb.from("payments").select("reference").eq("company_id",adminCompanyId).eq("booking_id",booking.id).eq("method","stripe").order("created_at",{ascending:false}).limit(1).maybeSingle();
    if(!paymentResult.error&&paymentResult.data?.reference) setText("viewStripeReference",paymentResult.data.reference);
    setText("viewAccount", booking.account_customer_id ? accountBookingLabel(booking) : "—");

    const paymentSelect = document.getElementById("editPaymentMethod");
    if (paymentSelect) paymentSelect.value = canonicalPaymentMethod(booking.payment_method);
    const accountSelect = document.getElementById("editAccountCustomer");
    if (accountSelect) accountSelect.value = booking.account_customer_id || "";
    const accountPo = document.getElementById("editAccountPoReference");
    if (accountPo) accountPo.value = booking.account_po_reference || "";
    updateEditAccountSelector();
    const paymentSave = document.getElementById("saveBookingPaymentMethod");
    if (paymentSave) paymentSave.dataset.bookingId = booking.id;

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

async function saveBookingPaymentMethod() {
    const button = document.getElementById("saveBookingPaymentMethod");
    const bookingId = button?.dataset.bookingId;
    const paymentMethod = document.getElementById("editPaymentMethod")?.value;
    if (!bookingId || !["cash", "card", "account"].includes(paymentMethod)) return;

    const booking = allBookings.find(row => String(row.id) === String(bookingId));
    const selectedAccountId = document.getElementById("editAccountCustomer")?.value || null;
    if (paymentMethod === "account" && !selectedAccountId) return alert("Select an account customer.");
    const selectedAccount = allAccountCustomers.find(row => row.id === selectedAccountId);
    if (paymentMethod === "account" && selectedAccount?.po_required && !document.getElementById("editAccountPoReference")?.value.trim() && !selectedAccount.default_po_reference) return alert("This account requires a PO/reference.");
    const update = { payment_method: paymentMethod, account_customer_id: paymentMethod === "account" ? selectedAccountId : null, account_po_reference: paymentMethod === "account" ? (document.getElementById("editAccountPoReference")?.value.trim() || selectedAccount?.default_po_reference || null) : null };
    if (booking?.driver_id && ["account", "card"].includes(paymentMethod) && booking.driver_amount == null) {
        const entered = prompt("Driver Amount (£) for this assigned account/prepaid job:", "");
        if (entered === null) return;
        if (entered.trim() === "" || !Number.isFinite(Number(entered)) || Number(entered) < 0) return alert("Enter a valid Driver Amount.");
        update.driver_amount = Number(entered);
    }
    if (button) button.disabled = true;
    const { data, error } = await bookingsDb
        .from("bookings")
        .update(update)
        .eq("id", bookingId)
        .eq("company_id", adminCompanyId)
        .select("id,company_id,payment_method,booking_source,driver_amount,account_customer_id")
        .maybeSingle();
    if (button) button.disabled = false;

    if (error || !data || String(data.company_id) !== String(adminCompanyId)) {
        return alert(error?.message || "No matching company booking was updated.");
    }

    await requestBookingEmailEvent(bookingId, "booking_changed", { event_id: `payment-method:${Date.now()}` });
    await loadBookings();
    openBookingView(bookingId);
}

async function saveBookingDriverAmount() {
    const button = document.getElementById("saveBookingDriverAmount");
    const bookingId = button?.dataset.bookingId;
    const raw = document.getElementById("editDriverAmount")?.value ?? "";
    if (!bookingId) return;
    if (raw !== "" && (!Number.isFinite(Number(raw)) || Number(raw) < 0)) return alert("Enter a valid Driver Amount.");
    const booking = allBookings.find(row => String(row.id) === String(bookingId));
    if (raw === "" && booking?.driver_amount != null && !confirm("Clear the Driver Amount and restore the existing fare behavior?")) return;
    button.disabled = true;
    const { data, error } = await bookingsDb.from("bookings")
        .update({ driver_amount: raw === "" ? null : Number(raw) })
        .eq("id", bookingId)
        .eq("company_id", adminCompanyId)
        .select("id,company_id,driver_amount")
        .maybeSingle();
    button.disabled = false;
    if (error || !data || String(data.company_id) !== String(adminCompanyId)) return alert(error?.message || "No matching company booking was updated.");
    await loadBookings();
    openBookingView(bookingId);
}

async function requestBookingConfirmation(bookingId, notify) {
    const { data, error } = await bookingsDb.functions.invoke("send-booking-email", { body: { company_id: adminCompanyId, booking_id: bookingId, event: "new_booking", audience: "customer", resend: true } });
    if (error || !data?.ok) {
        console.error("Booking email:", error || data?.error);
        if (notify) alert(data?.error || error?.message || "Unable to send confirmation.");
        return;
    }
    if (notify) alert("Confirmation email sent.");
}

async function requestBookingEmailEvent(bookingId, event, details = {}) {
    const { data, error } = await bookingsDb.functions.invoke("send-booking-email", {
        body: { company_id: adminCompanyId, booking_id: bookingId, event, ...details }
    });
    if (error || !data?.ok) console.error("Booking email event failed", event, error || data?.error);
    return Boolean(!error && data?.ok);
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

        await window.TransportAddressAutocomplete.loadGoogleMaps(
            data.googlemapsapi
        );

        setupAdminAutocomplete(
            "pickupAddress"
        );

        setupAdminAutocomplete(
            "dropoffAddress"
        );

        document.querySelectorAll(".admin-stop-row .admin-stop-address").forEach(input => {
            window.TransportAddressAutocomplete.attach(input,{onSelect:()=>calculateRouteQuote(false),onInput:scheduleRouteQuote});
        });

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

        quoteDirectionsService = new google.maps.DirectionsService();
        quoteDirectionsRenderer = new google.maps.DirectionsRenderer({ map: dispatchMap, suppressMarkers: false });

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


function setupAdminAutocomplete(id) {
    window.TransportAddressAutocomplete.attach(id,{
        placeholder:"Search address, postcode or place",
        onSelect:()=>calculateRouteQuote(false),
        onInput:scheduleRouteQuote
    });
}

function addAdminStop(kind) {
    adminStopCounters[kind] += 1;
    const row = document.createElement("div");
    row.className = "admin-stop-row";
    row.dataset.stopKind = kind;
    row.innerHTML = `<label>${kind === "pickup" ? "Additional Pickup" : "Additional Drop-off"} ${adminStopCounters[kind]}</label><input class="admin-stop-address" placeholder="Search address, postcode or place" autocomplete="off"><button type="button">Remove</button>`;
    row.querySelector("button").onclick = () => { row.remove(); relabelAdminStops(kind); calculateRouteQuote(false); };
    document.getElementById(kind === "pickup" ? "adminPickupStops" : "adminDropoffStops").appendChild(row);
    relabelAdminStops(kind);
    if (window.google?.maps?.places) {
        const input = row.querySelector("input");
        window.TransportAddressAutocomplete.attach(input,{onSelect:()=>calculateRouteQuote(false),onInput:scheduleRouteQuote});
    }
}

function relabelAdminStops(kind) {
    const container = document.getElementById(kind === "pickup" ? "adminPickupStops" : "adminDropoffStops");
    container?.querySelectorAll(".admin-stop-row").forEach((row,index) => {
        const label=row.querySelector("label");
        if(label) label.textContent=`${kind === "pickup" ? "Additional Pickup" : "Additional Drop-off"} ${index+1}`;
    });
}

function collectAdminViaStops() {
    const inputs = [...document.querySelectorAll("#adminPickupStops .admin-stop-address"), ...document.querySelectorAll("#adminDropoffStops .admin-stop-address")];
    return inputs.map((input, index) => { const address=window.TransportAddressAutocomplete.metadata(input); const kind=input.closest(".admin-stop-row")?.dataset.stopKind; return { stop_order: index + 1, label: kind === "pickup" ? "Additional Pickup" : "Additional Drop-off", formatted_address: address.formattedAddress, postcode: address.postcode, latitude: address.latitude, longitude: address.longitude, place_id: address.placeId }; }).filter(stop => stop.formatted_address);
}

function scheduleRouteQuote() {
    clearTimeout(quoteTimer);
    quoteTimer = setTimeout(() => calculateRouteQuote(false), 650);
}

async function calculateRouteQuote(forcePrice) {
    const origin = document.getElementById("pickupAddress")?.value.trim();
    const destination = document.getElementById("dropoffAddress")?.value.trim();
    if (!origin || !destination || !quoteDirectionsService || !quoteDirectionsRenderer) {
        if (!origin || !destination) clearRouteQuote();
        return;
    }
    try {
        const result = await quoteDirectionsService.route({
            origin,
            destination,
            waypoints: collectAdminViaStops().map(stop => ({ location: stop.formatted_address, stopover: true })),
            travelMode: google.maps.TravelMode.DRIVING
        });
        quoteDirectionsRenderer.setDirections(result);
        const legs = result.routes?.[0]?.legs || [];
        const miles = legs.reduce((sum, leg) => sum + Number(leg.distance?.value || 0), 0) / 1609.344;
        const minutes = legs.reduce((sum, leg) => sum + Number(leg.duration?.value || 0), 0) / 60;
        const quote = estimateAdminFare(miles, origin, destination);
        lastRouteQuote = { miles, minutes, fare: quote.fare, method: quote.method };
        setText("quoteDistance", `${miles.toFixed(1)} miles`);
        setText("quoteDuration", formatMinutes(minutes));
        setText("quoteFare", quote.fare == null ? "Pricing unavailable" : `${money(quote.fare)} · ${quote.method}`);
        if (quote.fare != null && (forcePrice || !customerPriceManual)) {
            settingCustomerPrice = true;
            document.getElementById("jobPrice").value = quote.fare.toFixed(2);
            settingCustomerPrice = false;
            customerPriceManual = false;
        }
    } catch (error) {
        console.error("Admin route quote failed:", error);
        setText("quoteDistance", "Route unavailable");
        setText("quoteDuration", "—");
        setText("quoteFare", "—");
    }
}

function estimateAdminFare(miles, origin, destination) {
    const passengers = Number(document.getElementById("passengers")?.value || 1);
    const text = `${origin} ${destination}`.toLowerCase();
    const airport = quoteSettings.airportpricing === true
        ? quoteAirports.find(item => [item.name, item.code].filter(Boolean).some(value => text.includes(String(value).toLowerCase())))
        : null;
    if (airport) {
        const base = Number(passengers >= 5 ? airport.price_5_7_oneway : airport.price_1_4_oneway);
        const viaTotal = collectAdminViaStops().length * Math.max(0, settingNumber("airportviasurcharge"));
        if (Number.isFinite(base)) return { fare: Math.round((base + settingNumber("bookingfee") + viaTotal) * 100) / 100, method: "Airport fixed" };
    }
    if (quoteSettings.distancecalculator !== true) return { fare: null, method: "Pricing disabled" };
    const rates = [1,2,3,4,5,6].map(index => settingNumber(`mileband${index}`));
    if (!(settingNumber("firstmile") > 0 || rates.some(rate => rate > 0))) return { fare: null, method: "Pricing unavailable" };
    const ends = [10,30,80,150,500,1000];
    let total = settingNumber("firstmile");
    let remaining = Math.max(0, miles - 1);
    let start = 1;
    for (let index = 0; index < ends.length && remaining > 0; index += 1) {
        const amount = Math.min(remaining, ends[index] - start);
        total += amount * rates[index];
        remaining -= amount;
        start = ends[index];
    }
    if (remaining > 0) total += remaining * rates[5];
    if (passengers >= 5 && passengers <= 7) total += total * (settingNumber("bookingfee") / 100);
    total = Math.floor(Math.max(settingNumber("minimumfare"), total) * 2) / 2;
    return { fare: total, method: "Distance price" };
}

function settingNumber(key) {
    const value = Number(quoteSettings?.[key]);
    return Number.isFinite(value) ? value : 0;
}

function clearRouteQuote() {
    lastRouteQuote = null;
    if (quoteDirectionsRenderer) quoteDirectionsRenderer.set("directions", null);
    setText("quoteDistance", "—");
    setText("quoteDuration", "—");
    setText("quoteFare", "—");
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
    if (liveTimer) clearInterval(liveTimer);
    liveTimer = setInterval(runGuardedLiveRefresh, 60000);
    document.addEventListener("visibilitychange", () => {
        if (!document.hidden) runGuardedLiveRefresh();
    });
}

async function runGuardedLiveRefresh() {
    const bookingEditorOpen = document.getElementById("bookingViewBackdrop")?.classList.contains("open");
    if (document.hidden || adminBookingFormDirty || bookingEditorOpen || liveRefreshRunning) return;
    liveRefreshRunning = true;
    try {
        await Promise.all([loadDrivers(), loadBookings()]);
        refreshDriverMarkers();
    } finally {
        liveRefreshRunning = false;
    }
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

function canonicalPaymentMethod(value) {
    const method = String(value || "").trim().toLowerCase();
    if (method.includes("account") || method.includes("invoice")) return "account";
    if (method.includes("card") || method.includes("prepaid") || method.includes("pay now")) return "card";
    return "cash";
}

function accountBookingLabel(booking) {
    const account = allAccountCustomers.find(row => String(row.id) === String(booking.account_customer_id));
    return account ? `${account.account_code} — ${account.business_name}` : "Account customer";
}

function bookingAddressDisplay(detail,address) {
    return [detail,address].map(value => String(value || "").trim()).filter(Boolean).join("\n") || "-";
}

function bookingPaymentClass(booking) {
    if (String(booking?.payment_status || "").trim().toLowerCase() === "paid") return "payment-card";
    const method = canonicalPaymentMethod(booking?.payment_method);
    if (method === "account") return "payment-account";
    if (method === "card") return "payment-card";
    return "payment-cash";
}

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
