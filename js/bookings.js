const bookingsDb = getSupabase();

let allBookings = [];
let allDrivers = [];
let allAccountCustomers = [];
let currentTab = "upcoming";
let activeQuickRange = "this_month";
let adminCompanyId = null;
let adminCompany = null;
let adminTimezone = "Europe/London";
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
let editingBooking = null;
let editInitialSnapshot = null;

document.addEventListener("DOMContentLoaded", async () => {
    try {
        const context = await window.getAdminCompanyContext();
        adminCompanyId = context.companyId;
        adminCompany = context.company;
        const timezoneResult=await bookingsDb.from("settings").select("timezone").eq("company_id",adminCompanyId).maybeSingle();
        adminTimezone=timezoneResult.data?.timezone||"Europe/London";
        currentTab = resolveInitialBookingTab();
        applyBookingTabSelection();
        setRangeForTab(currentTab);
        bindBookingEvents();

        await Promise.all([
            loadDrivers(),
            loadBookings(),
            loadQuotePricing(),
            loadAccountCustomers()
        ]);

        await initialiseDispatchMap();
        const requestedEdit = new URLSearchParams(location.search).get("edit");
        if (requestedEdit) beginBookingEdit(requestedEdit);
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
    document.getElementById("editBookingButton")?.addEventListener("click", () => beginBookingEdit(document.getElementById("editBookingButton")?.dataset.bookingId));
    document.getElementById("cancelBookingEdit")?.addEventListener("click", () => cancelBookingEdit(true));
    document.getElementById("returnJourney")?.addEventListener("change", updateReturnFields);

    document.getElementById("passengers")?.addEventListener("change", () => calculateRouteQuote(false));
    document.getElementById("passengers")?.addEventListener("input", clearPassengerValidation);
    document.getElementById("passengers")?.addEventListener("invalid", showPassengerValidation);
    document.getElementById("jobPrice")?.addEventListener("input", () => {
        if (!settingCustomerPrice) customerPriceManual = true;
        updatePriceOverrideUi();
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

    document.getElementById("dateFrom")?.addEventListener("change", onCustomDateChange);
    document.getElementById("dateTo")?.addEventListener("change", onCustomDateChange);
    document.querySelectorAll("[data-range]").forEach(button => button.addEventListener("click", () => applyQuickRange(button.dataset.range)));

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

                localStorage.setItem(`bookingsDefaultView:${adminCompanyId}`,currentTab);

                setRangeForTab(currentTab);
                updateStatusFilterForTab();
                loadBookings();
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
    window.addEventListener("beforeunload", event => {
        if (editingBooking && adminBookingFormDirty) { event.preventDefault(); event.returnValue = ""; }
    });
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

function setRangeForTab(tab) {
    const today = new Date();
    if (tab === "all") return applyDateRange(new Date(today.getFullYear(), today.getMonth(), 1), new Date(today.getFullYear(), today.getMonth() + 1, 0), "this_month");
    if (tab === "upcoming") return applyDateRange(today, addDays(today, 29), "next_30");
    if (tab === "on_job") return applyDateRange(today, today, "today");
    applyDateRange(addDays(today, -29), today, "custom");
}

function applyQuickRange(range) {
    const today = new Date();
    if (range === "today") applyDateRange(today, today, range);
    else if (range === "7_days") applyDateRange(today, addDays(today, 6), range);
    else if (range === "this_month") applyDateRange(new Date(today.getFullYear(), today.getMonth(), 1), new Date(today.getFullYear(), today.getMonth() + 1, 0), range);
    else if (range === "next_30") applyDateRange(today, addDays(today, 29), range);
    else { activeQuickRange = "custom"; updateQuickRangeButtons(); document.getElementById("dateFrom")?.focus(); return; }
    loadBookings();
}

function applyDateRange(from, to, range) {
    document.getElementById("dateFrom").value = localDateKey(from);
    document.getElementById("dateTo").value = localDateKey(to);
    const journeyDate = document.getElementById("journeyDate");
    if (journeyDate && !journeyDate.value) journeyDate.value = localDateKey(new Date());
    activeQuickRange = range;
    updateQuickRangeButtons();
}

function onCustomDateChange() {
    activeQuickRange = "custom";
    updateQuickRangeButtons();
    loadBookings();
}

function updateQuickRangeButtons() {
    document.querySelectorAll("[data-range]").forEach(button => button.classList.toggle("active", button.dataset.range === activeQuickRange));
}

function addDays(date, days) {
    const result = new Date(date);
    result.setDate(result.getDate() + days);
    return result;
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

    select.innerHTML = `<option value="">All statuses in this view</option>
        <option value="waiting">Waiting</option><option value="pending">Pending</option>
        <option value="booked">Booked</option><option value="assigned">Assigned</option>
        <option value="accepted">Accepted</option><option value="on_way">On Way</option><option value="arrived">Arrived</option>
        <option value="passenger_onboard">Passenger Onboard</option><option value="completed">Completed</option>
        <option value="no_show">No Show</option><option value="cancelled">Cancelled</option>`;
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
                active,
                vehicle,
                status,
                online,
                latitude,
                longitude,
                location_updated_at,
                pay_type,
                commission_percent,
                fixed_job_amount
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
        allDrivers=[];const select=document.getElementById("driverSelect"),returnSelect=document.getElementById("returnDriverSelect");if(select)select.innerHTML='<option value="">Drivers unavailable — refresh or contact an administrator</option>';if(returnSelect)returnSelect.innerHTML='<option value="">Drivers unavailable — refresh or contact an administrator</option>';
        return;
    }

    allDrivers =
        data || [];

    populateDriverDropdown();
}


function populateDriverDropdown() {

    const select =
        document.getElementById("driverSelect");

    const returnSelect =
        document.getElementById("returnDriverSelect");

    if (!select) return;

    select.innerHTML =
        '<option value="">Unassigned</option>';
    if (returnSelect) returnSelect.innerHTML = '<option value="">Unassigned</option>';

    allDrivers.forEach(driver => {

        const option =
            document.createElement("option");

        option.value =
            driver.id;

        option.textContent =
            `${driver.driver_number || "-"} — ${driver.full_name || "Driver"} • ${driver.active===false?"INACTIVE":driver.online?"ONLINE":"OFFLINE"}`;

        select.appendChild(option);
        if (returnSelect) returnSelect.appendChild(option.cloneNode(true));
    });
}

async function loadQuotePricing() {
    const [settingsResult, airportsResult] = await Promise.all([
        bookingsDb.from("settings")
            .select("company_id,airportpricing,distancecalculator,minimumfare,firstmile,mileband1,mileband2,mileband3,mileband4,mileband5,mileband6,bookingfee,airportviasurcharge,currencysymbol,drivercommission")
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

    let bookingsQuery = bookingsDb
            .from("bookings")
            .select("*")
            .eq(
                "company_id",
                adminCompanyId
            );
    const from = document.getElementById("dateFrom")?.value;
    const to = document.getElementById("dateTo")?.value;
    if (from) bookingsQuery = bookingsQuery.gte("journey_date", from);
    if (to) bookingsQuery = bookingsQuery.lte("journey_date", to);
    const { data, error } = await bookingsQuery
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

    const bookingIds = (data || []).map(booking => booking.id);
    const stopsResult = bookingIds.length
        ? await bookingsDb.from("booking_stops").select("*").eq("company_id", adminCompanyId).in("booking_id", bookingIds).order("stop_order", { ascending: true })
        : { data: [], error: null };
    const { data: stops, error: stopsError } = stopsResult;

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

    if (currentTab === "all") return true;
    if (currentTab === "completed") return status === "completed";
    if (currentTab === "no_show") return status === "no_show";
    if (currentTab === "cancelled") return ["cancelled", "canceled"].includes(status);
    if (currentTab === "on_job") return ["accepted", "on_way", "arrived", "passenger_onboard"].includes(status);
    if (currentTab === "upcoming") {
        const finalStatuses = ["completed", "cancelled", "canceled", "no_show", "archived"];
        return booking.journey_date >= companyTodayKey() && !finalStatuses.includes(status);
    }
    return true;
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
                    booking.notes,
                    driverDisplayName(booking.driver_id)
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

    const isHistory = ["completed", "no_show", "cancelled"].includes(currentTab);
    const canAllocate = currentTab === "upcoming";
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
        !canAllocate
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
        <button type="button" class="booking-menu-trigger" data-booking-menu="${escapeHtml(booking.id)}" aria-label="More actions for booking ${escapeHtml(booking.booking_reference || shortId(booking.id))}">⋮</button>
        <button type="button" onclick="beginBookingEdit('${booking.id}')">Edit</button>

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
                "canceled",
                "no_show"
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

        ${!["completed", "cancelled", "canceled", "no_show"].includes(status) ? `<button type="button" onclick="markBookingNoShow('${booking.id}')">No Show</button>` : ""}
    `;

    return `
        <tr class="${paymentClass}" data-booking-id="${escapeHtml(booking.id)}">

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
                <span class="payment-pill">${escapeHtml(bookingPaymentLabel(booking))}</span>
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
                <span class="status-pill status-${escapeHtml(String(status).toLowerCase().replaceAll(" ","_"))}">
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


function updateReturnFields() {
    const enabled = Boolean(document.getElementById("returnJourney")?.checked);
    const fields = document.getElementById("returnFields");
    if (fields) fields.hidden = !enabled;
    for (const id of ["returnDate", "returnTime"]) {
        const input = document.getElementById(id);
        if (input) { input.required = enabled; input.disabled = !enabled; }
    }
}

function setAddressFromBooking(id, booking, prefix) {
    window.TransportAddressAutocomplete.setMetadata(id, {
        formattedAddress: booking[`${prefix}_address`] || "",
        canonicalAddress: booking[`${prefix}_address`] || "",
        placeId: booking[`${prefix}_place_id`] || "",
        latitude: booking[`${prefix}_lat`],
        longitude: booking[`${prefix}_lng`],
        postcode: booking[`${prefix}_postcode`] || "",
        placeName: ""
    });
}

function addLoadedStop(stop) {
    const kind = String(stop.label || "").toLowerCase().includes("pickup") ? "pickup" : "dropoff";
    addAdminStop(kind);
    const container = document.getElementById(kind === "pickup" ? "adminPickupStops" : "adminDropoffStops");
    const input = [...container.querySelectorAll(".admin-stop-address")].at(-1);
    window.TransportAddressAutocomplete.setMetadata(input, {
        formattedAddress: stop.formatted_address,
        canonicalAddress: stop.formatted_address,
        placeId: stop.place_id,
        latitude: stop.latitude,
        longitude: stop.longitude,
        postcode: stop.postcode,
        placeName: stop.address_name
    });
}

async function beginBookingEdit(id) {
    let booking = allBookings.find(row => String(row.id) === String(id));
    if (!booking && id) {
        const [bookingResult, stopsResult] = await Promise.all([
            bookingsDb.from("bookings").select("*").eq("id", id).eq("company_id", adminCompanyId).maybeSingle(),
            bookingsDb.from("booking_stops").select("*").eq("booking_id", id).eq("company_id", adminCompanyId).order("stop_order")
        ]);
        if (bookingResult.error || !bookingResult.data) return alert("This company booking could not be loaded.");
        booking = { ...bookingResult.data, via_stops: stopsResult.data || [] };
    }
    if (!booking) return alert("This company booking could not be loaded.");
    const status = bookingStatus(booking);
    editingBooking = booking;
    editInitialSnapshot = JSON.stringify(editableBookingValues(booking));
    document.getElementById("adminBookingForm")?.reset();
    document.getElementById("adminPickupStops").innerHTML = "";
    document.getElementById("adminDropoffStops").innerHTML = "";
    adminStopCounters = { pickup: 0, dropoff: 0 };
    const values = {
        customerName: booking.customer_name || booking.full_name || "", customerPhone: booking.customer_phone || booking.phone || "",
        customerEmail: booking.customer_email || booking.email || "", pickupName: booking.pickup_name || "", dropoffName: booking.dropoff_name || "",
        journeyDate: booking.journey_date || "", journeyTime: String(booking.journey_time || "").slice(0,5), passengers: booking.passengers ?? "",
        suitcases: booking.suitcases ?? 0, handLuggage: booking.hand_luggage ?? 0, jobPrice: booking.price ?? booking.job_price ?? "",
        driverAmount: booking.driver_amount ?? "", driverSelect: booking.driver_id || "", paymentMethod: canonicalPaymentMethod(booking.payment_method),
        bookingStatus: status, accountCustomerSelect: booking.account_customer_id || "", accountPoReference: booking.account_po_reference || "",
        notes: booking.notes || "", flightNumber: booking.flight_number || "", returnDate: booking.return_date || "",
        returnTime: String(booking.return_time || "").slice(0,5)
    };
    Object.entries(values).forEach(([id, value]) => { const input=document.getElementById(id); if(input) input.value=value; });
    document.getElementById("returnJourney").checked = Boolean(booking.return_journey);
    updateReturnFields(); updateAdminAccountSelector();
    setAddressFromBooking("pickupAddress", booking, "pickup");
    setAddressFromBooking("dropoffAddress", booking, "dropoff");
    (booking.via_stops || []).forEach(addLoadedStop);
    lastRouteQuote = booking.route_distance_miles == null ? null : { miles:Number(booking.route_distance_miles), minutes:Number(booking.route_duration_minutes || 0), fare:Number(booking.price || 0), method:booking.pricing_method || "Existing" };
    customerPriceManual = false;
    document.getElementById("bookingFormTitle").textContent = `Edit Booking ${booking.booking_reference || shortId(booking.id)}`;
    document.getElementById("saveBookingButton").textContent = "Save Changes";
    document.getElementById("cancelBookingEdit").hidden = false;
    const notice=document.getElementById("bookingEditNotice"); notice.hidden=false; notice.textContent=`Editing ${booking.booking_reference || shortId(booking.id)} (${status}). Journey progress, timestamps, payments and identity links are preserved. Active operational changes notify the assigned driver through enabled channels.`;
    const correctionReasonField=document.getElementById("bookingCorrectionReasonField"),correctionReason=document.getElementById("bookingCorrectionReason");correctionReasonField.hidden=false;correctionReason.required=true;correctionReason.value="";
    const paid=String(booking.payment_status||"").toLowerCase()==="paid" || Number(booking.amount_paid||0)>0;
    const warning=document.getElementById("paidFareWarning"); warning.hidden=!paid; warning.textContent=paid ? `Paid ${money(Number(booking.amount_paid||booking.price||0))}. Changing the fare will not charge or refund the customer.` : "";
    updatePriceOverrideUi(); closeBookingView(); adminBookingFormDirty=false;
    document.getElementById("newBookingPanel")?.scrollIntoView({behavior:"smooth"});
}

function editableBookingValues(booking) {
    return { id:booking.id, reference:booking.booking_reference, version:Number(booking.edit_version||0), price:Number(booking.price??booking.job_price??0) };
}

function updatePriceOverrideUi() {
    const changed = editingBooking && Number(document.getElementById("jobPrice")?.value || 0) !== Number(editingBooking.price ?? editingBooking.job_price ?? 0);
    const matchesQuote = lastRouteQuote?.fare != null && Math.abs(Number(document.getElementById("jobPrice")?.value || 0)-Number(lastRouteQuote.fare)) < 0.005;
    const field=document.getElementById("priceOverrideReasonField"); if(field) field.hidden=!(changed && !matchesQuote);
    const reason=document.getElementById("priceOverrideReason"); if(reason) reason.required=Boolean(changed && !matchesQuote);
}

function cancelBookingEdit(confirmDirty=false) {
    if (confirmDirty && adminBookingFormDirty && !confirm("Discard unsaved booking changes?")) return;
    editingBooking=null; editInitialSnapshot=null; adminBookingFormDirty=false; customerPriceManual=false; lastRouteQuote=null;
    const form=document.getElementById("adminBookingForm"); form?.reset();
    document.getElementById("adminPickupStops").innerHTML=""; document.getElementById("adminDropoffStops").innerHTML="";
    document.getElementById("bookingFormTitle").textContent="New Admin Booking"; document.getElementById("saveBookingButton").textContent="Save Job";
    document.getElementById("cancelBookingEdit").hidden=true; document.getElementById("bookingEditNotice").hidden=true; document.getElementById("paidFareWarning").hidden=true; document.getElementById("priceOverrideReasonField").hidden=true;document.getElementById("bookingCorrectionReasonField").hidden=true;document.getElementById("bookingCorrectionReason").required=false;
    document.getElementById("suitcases").value="0"; document.getElementById("handLuggage").value="0"; updateReturnFields(); clearRouteQuote();
    history.replaceState({}, "", location.pathname);
}

async function saveAdminBookingEdit() {
    const message=document.getElementById("bookingMessage"), button=document.getElementById("saveBookingButton");
    const pickup=window.TransportAddressAutocomplete.metadata("pickupAddress"), dropoff=window.TransportAddressAutocomplete.metadata("dropoffAddress");
    const routeChanged = document.getElementById("pickupAddress").value.trim() !== String(editingBooking.pickup_address||"").trim() || document.getElementById("dropoffAddress").value.trim() !== String(editingBooking.dropoff_address||"").trim() || JSON.stringify(collectAdminViaStops().map(s=>s.formatted_address)) !== JSON.stringify((editingBooking.via_stops||[]).map(s=>s.formatted_address));
    if (routeChanged && (!pickup.placeId || !dropoff.placeId)) { message.textContent="Select changed pickup and destination addresses from Google suggestions."; return; }
    if (routeChanged && !lastRouteQuote) { message.textContent="Recalculate the route before saving address changes."; return; }
    updatePriceOverrideUi();
    if (!document.getElementById("adminBookingForm").reportValidity()) return;
    const price=Number(document.getElementById("jobPrice").value||0), oldPrice=Number(editingBooking.price??editingBooking.job_price??0);
    const manualOverride=price!==oldPrice && !(lastRouteQuote?.fare!=null && Math.abs(price-Number(lastRouteQuote.fare))<0.005);
    const changes={customer_name:document.getElementById("customerName").value.trim(),customer_email:document.getElementById("customerEmail").value.trim()||null,customer_phone:document.getElementById("customerPhone").value.trim()||null,pickup_address:pickup.formattedAddress,pickup_name:document.getElementById("pickupName").value.trim()||null,pickup_postcode:pickup.postcode,pickup_place_id:pickup.placeId,pickup_lat:pickup.latitude,pickup_lng:pickup.longitude,dropoff_address:dropoff.formattedAddress,dropoff_name:document.getElementById("dropoffName").value.trim()||null,dropoff_postcode:dropoff.postcode,dropoff_place_id:dropoff.placeId,dropoff_lat:dropoff.latitude,dropoff_lng:dropoff.longitude,journey_date:document.getElementById("journeyDate").value,journey_time:document.getElementById("journeyTime").value,passengers:Number(document.getElementById("passengers").value),suitcases:Number(document.getElementById("suitcases").value||0),hand_luggage:Number(document.getElementById("handLuggage").value||0),flight_number:document.getElementById("flightNumber").value.trim()||null,notes:document.getElementById("notes").value.trim()||null,price,driver_id:document.getElementById("driverSelect").value||null,driver_amount:document.getElementById("driverAmount").value===""?null:Number(document.getElementById("driverAmount").value),payment_method:document.getElementById("paymentMethod").value,account_customer_id:document.getElementById("paymentMethod").value==="account"?(document.getElementById("accountCustomerSelect").value||null):null,account_po_reference:document.getElementById("paymentMethod").value==="account"?(document.getElementById("accountPoReference").value.trim()||null):null,return_journey:document.getElementById("returnJourney").checked,return_date:document.getElementById("returnJourney").checked?document.getElementById("returnDate").value:null,return_time:document.getElementById("returnJourney").checked?document.getElementById("returnTime").value:null,route_distance_miles:lastRouteQuote?.miles??editingBooking.route_distance_miles,route_duration_minutes:lastRouteQuote?.minutes==null?editingBooking.route_duration_minutes:Math.round(lastRouteQuote.minutes),pricing_method:lastRouteQuote?.method||editingBooking.pricing_method};
    button.disabled=true; message.textContent="Saving changes…";
    const correctionReason=document.getElementById("bookingCorrectionReason").value.trim();
    if(correctionReason.length<5){button.disabled=false;message.textContent="Enter a meaningful correction reason for the audit history.";return;}
    const fareReason = price!==oldPrice ? `${correctionReason}${manualOverride?` — ${document.getElementById("priceOverrideReason").value.trim()}`:" — route recalculated using company pricing"}` : correctionReason;
    const {data,error}=await bookingsDb.rpc("admin_edit_booking",{target_company_id:adminCompanyId,target_booking_id:editingBooking.id,expected_edit_version:Number(editingBooking.edit_version||0),requested_changes:changes,requested_stops:collectAdminViaStops(),override_reason:fareReason});
    button.disabled=false;
    if(error){message.textContent=error.message.includes("conflict")?"This booking was changed elsewhere. Reload and review it before trying again.":`Could not save: ${error.message}`;return;}
    const id=editingBooking.id,previousDriver=editingBooking.driver_id; adminBookingFormDirty=false; cancelBookingEdit(false); await loadBookings();
    let notification="";if(data?.notification_required){const event=data.driver_changed?"driver_assignment":"booking_changed",sent=await bookingsDb.functions.invoke("send-booking-email",{body:{company_id:adminCompanyId,booking_id:id,event,audience:"driver",event_id:data.audit_id,previous_driver_id:previousDriver}});notification=sent.error||!sent.data?.ok?" The correction was saved, but the driver email was not accepted; contact the driver directly.":" The assigned driver was notified through the enabled email channel.";}
    message.textContent=`Booking correction saved with immutable audit history.${data?.document_resolution_required?" An issued invoice requires its separate correction workflow.":""}${notification}`; openBookingView(id);
}

async function createAdminBooking(event) {

    event.preventDefault();

    if (editingBooking) return saveAdminBookingEdit(event);

    const message =
        document.getElementById(
            "bookingMessage"
        );

    if (message) {
        message.textContent =
            "Saving…";
    }

    const passengersInput = document.getElementById("passengers");
    const passengers = Number(passengersInput?.value);
    const passengerError = document.getElementById("passengersError");
    if (!passengersInput?.value || !Number.isInteger(passengers) || passengers < 1 || passengers > 52) {
        const validationMessage = !passengersInput?.value
            ? "Enter the number of passengers."
            : "Passengers must be a whole number between 1 and 52.";
        passengersInput?.setCustomValidity(validationMessage);
        if (passengerError) passengerError.textContent = validationMessage;
        if (message) message.textContent = validationMessage;
        passengersInput?.focus();
        passengersInput?.reportValidity();
        return;
    }

    const luggageValues = {};
    for (const [id, key, label] of [["suitcases", "suitcases", "Suitcases"], ["handLuggage", "hand_luggage", "Hand luggage"]]) {
        const input = document.getElementById(id);
        const value = Number(input?.value ?? 0);
        if (!Number.isInteger(value) || value < 0 || value > 100) {
            const validationMessage = `${label} must be a whole number between 0 and 100.`;
            input?.setCustomValidity(validationMessage);
            if (message) message.textContent = validationMessage;
            input?.focus();
            input?.reportValidity();
            return;
        }
        input?.setCustomValidity("");
        luggageValues[key] = value;
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

        passengers,

        suitcases: luggageValues.suitcases,

        hand_luggage: luggageValues.hand_luggage,

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

        flight_number: document.getElementById("flightNumber")?.value.trim() || null,
        return_journey: Boolean(document.getElementById("returnJourney")?.checked),
        return_date: document.getElementById("returnJourney")?.checked ? (document.getElementById("returnDate")?.value || null) : null,
        return_time: document.getElementById("returnJourney")?.checked ? (document.getElementById("returnTime")?.value || null) : null,

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

    const isReturnBooking=payload.return_journey;
    const combinedPrice=payload.price==null?null:Number(payload.price);
    const combinedPennies=combinedPrice==null?null:Math.round(combinedPrice*100);
    payload.price=combinedPennies==null?null:Math.ceil(combinedPennies/(isReturnBooking?2:1))/100;
    payload.journey_fare=payload.price;
    payload.amount_paid=0;
    payload.balance_due=combinedPrice;
    payload.payment_type=canonicalPaymentMethod(newPaymentMethod)==="account"?"account":canonicalPaymentMethod(newPaymentMethod)==="card"?"full":"pay_in_car";
    const bookingRows=[payload];
    if(isReturnBooking){
        const returnDriverId=document.getElementById("returnDriverSelect")?.value||null;
        const returnDriverAmountRaw=document.getElementById("returnDriverAmount")?.value??"";
        const returnId=crypto.randomUUID();
        const returnPrice=combinedPennies==null?null:(combinedPennies-Math.ceil(combinedPennies/2))/100;
        bookingRows.push({...payload,id:returnId,booking_reference:`${payload.booking_reference}-R`,pickup_address:payload.dropoff_address,pickup_name:payload.dropoff_name,pickup_postcode:payload.dropoff_postcode,pickup_place_id:payload.dropoff_place_id,pickup_lat:payload.dropoff_lat,pickup_lng:payload.dropoff_lng,dropoff_address:payload.pickup_address,dropoff_name:payload.pickup_name,dropoff_postcode:payload.pickup_postcode,dropoff_place_id:payload.pickup_place_id,dropoff_lat:payload.pickup_lat,dropoff_lng:payload.pickup_lng,journey_date:payload.return_date,journey_time:payload.return_time,return_journey:false,return_date:null,return_time:null,journey_type:"return",price:returnPrice,journey_fare:returnPrice,payment_type:"linked_return",amount_paid:0,balance_due:0,driver_id:returnDriverId,driver_amount:returnDriverAmountRaw===""?null:Number(returnDriverAmountRaw),status:returnDriverId?"assigned":"waiting",dispatched_at:returnDriverId?new Date().toISOString():null});
    }
    const viaStops = collectAdminViaStops();
    const stopRows=bookingRows.flatMap((row,rowIndex)=>(rowIndex?[...viaStops].reverse():viaStops).map((stop,index)=>({...stop,company_id:adminCompanyId,booking_id:row.id,stop_order:index+1})));
    const createBundle=rows=>bookingsDb.rpc("create_booking_bundle",{target_company_id:adminCompanyId,booking_rows:rows,stop_rows:stopRows,payment_row:null,request_key:null});
    let bundle = await createBundle(bookingRows);
    let error=bundle.error;

    if (error && /FULLY_BOOKED|fully booked/i.test(error.message || "")) {
        const confirmed = confirm("FULLY BOOKED CONFLICT\n\nThis journey overlaps an enforced unavailable period. Existing blocks will not be changed.\n\nDo you want to create an authorised Admin override?");
        if (confirmed) {
            const overrideReason = prompt("Enter the operational reason for overriding availability (required):", "");
            if (overrideReason?.trim()) {
                bundle=await createBundle(bookingRows.map(row=>({...row,availability_override_reason:overrideReason.trim()})));
                error = bundle.error;
            } else {
                error = { message: "The booking was not saved because an override reason is required." };
            }
        }
    }

    if (error) {

        if (message) {

            message.textContent =
                "Could not save: " +
                error.message;
        }

        return;
    }

    const createdBookingRows=bundle.data?.bookings||bookingRows.map(row=>({id:row.id,booking_reference:row.booking_reference}));
    await Promise.all(createdBookingRows.map(row=>requestGoogleCalendarSync(row.id)));
    await requestBookingEmailEvent(createdBookingRows[0].id, "new_booking");
    if(createdBookingRows[1]&&bookingRows[1].driver_id)await requestBookingEmailEvent(createdBookingRows[1].id,"driver_assignment",{event_id:`return-assignment:${createdBookingRows[1].id}`});

    if (message) {

        message.textContent = createdBookingRows.length===2
            ? `Bookings saved: ${createdBookingRows.map(row=>row.booking_reference).join(" and ")}.`
            : "Booking saved.";
    }

    event.target.reset();
    document.getElementById("suitcases").value = "0";
    document.getElementById("handLuggage").value = "0";
    adminBookingFormDirty = false;
    customerPriceManual = false;
    clearRouteQuote();
    document.getElementById("adminPickupStops").innerHTML = "";
    document.getElementById("adminDropoffStops").innerHTML = "";
    adminStopCounters = { pickup: 0, dropoff: 0 };

    setRangeForTab(currentTab);

    populateDriverDropdown();

    await loadBookings();
}

function clearPassengerValidation() {
    const input = document.getElementById("passengers");
    input?.setCustomValidity("");
    const error = document.getElementById("passengersError");
    if (error) error.textContent = "";
}

function showPassengerValidation() {
    const input = document.getElementById("passengers");
    if (!input) return;
    const message = input.value
        ? "Passengers must be a whole number between 1 and 52."
        : "Enter the number of passengers.";
    input.setCustomValidity(message);
    const error = document.getElementById("passengersError");
    if (error) error.textContent = message;
}


async function cancelBooking(id) {

    if (
        !confirm(
            "Cancel this booking?"
        )
    ) {
        return;
    }

    const cancellationReason = prompt("Cancellation reason (optional):", "");
    if (cancellationReason === null) return;
    const cancelledBy = await currentAdminActor();
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
                        .toISOString(),
                cancellation_reason: cancellationReason.trim() || null,
                cancelled_by: cancelledBy
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

async function markBookingNoShow(id) {
    if (!confirm("Mark this booking as No Show?")) return;
    const { error } = await bookingsDb.from("bookings").update({
        status: "no_show",
        booking_status: "no_show",
        no_show_at: new Date().toISOString(),
        no_show_by: await currentAdminActor()
    }).eq("id", id).eq("company_id", adminCompanyId);
    if (error) return alert(error.message);
    await loadBookings();
}

async function currentAdminActor() {
    const { data } = await bookingsDb.auth.getUser();
    return data?.user?.email || data?.user?.id || "Admin";
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
        "arrived",
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

    if (next === "accepted") {
        update.accepted_at = now;
    }

    if (next === "on_way") {
        update.on_way_at = now;
    }

    if (next === "arrived") {
        update.arrived_at = now;
    }

    if (next === "passenger_onboard") {
        update.passenger_onboard_at = now;
    }

    if (next === "completed") {
        update.completed_at = now;
    }

    if (next === "on_way") {
        const overrideReason = prompt("If this job is being started more than 3 hours 30 minutes before pickup, enter the operational override reason. Otherwise leave blank.", "");
        if (overrideReason === null) return;
        const { data, error } = await bookingsDb.rpc("admin_transition_booking", {
            target_company_id: adminCompanyId,
            target_booking_id: id,
            requested_status: next,
            override_reason: overrideReason.trim() || null
        });
        if (error) return alert(error.message);
        if (!data) return alert("The booking was not updated.");
        await loadBookings();
        return;
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
    const editButton = document.getElementById("editBookingButton");
    if (editButton) editButton.dataset.bookingId = booking.id;

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
        booking.source_account_name ? `${booking.source_account_name} — ${prettyStatus(booking.source_channel || booking.booking_source || "website")}` : booking.source_channel || booking.booking_source || "website"
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

    setText("viewVehicle", vehicleTierLabel(booking.vehicle_tier || booking.vehicle_type));

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

    setTimelineItem("viewCreatedAt", booking.created_at);
    setTimelineItem("viewDispatchedAt", booking.dispatched_at);
    setTimelineItem("viewAcceptedAt", booking.accepted_at);
    setTimelineItem("viewOnWayAt", booking.on_way_at);
    setTimelineItem("viewPobAt", booking.passenger_onboard_at);
    setTimelineItem("viewCompletedAt", booking.completed_at);
    setTimelineItem("viewCancelledAt", booking.cancelled_at);
    setTimelineItem("viewNoShowAt", booking.no_show_at);
    setOptionalDetail("viewCancellationReason", [booking.cancellation_reason, booking.cancelled_by ? `By ${booking.cancelled_by}` : ""].filter(Boolean).join(" — "));
    setOptionalDetail("viewNoShowBy", booking.no_show_by);

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
    const count = statuses => allBookings.filter(booking => statuses.includes(bookingStatus(booking))).length;
    const today = companyTodayKey();
    const finalOrActive = ["completed", "cancelled", "canceled", "no_show", "archived"];
    setCount("countAll", allBookings.length);
    setCount("countUpcoming", allBookings.filter(booking => booking.journey_date >= today && !finalOrActive.includes(bookingStatus(booking))).length);
    setCount("countOnJob", count(["accepted", "on_way", "arrived", "passenger_onboard"]));
    setCount("countCompleted", count(["completed"]));
    setCount("countNoShow", count(["no_show"]));
    setCount("countCancelled", count(["cancelled", "canceled"]));
}

function resolveInitialBookingTab(){const params=new URLSearchParams(location.search),explicit=params.get('view')||params.get('status_tab')||params.get('status');if(['all','upcoming','on_job','completed','no_show','cancelled'].includes(explicit))return explicit;const saved=localStorage.getItem(`bookingsDefaultView:${adminCompanyId}`);return ['all','upcoming','on_job','completed','no_show','cancelled'].includes(saved)?saved:'upcoming'}
function applyBookingTabSelection(){document.querySelectorAll('.booking-tabs button').forEach(button=>button.classList.toggle('active',button.dataset.status===currentTab))}
function companyTodayKey(){try{const parts=new Intl.DateTimeFormat('en-GB',{timeZone:adminTimezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date()),get=t=>parts.find(x=>x.type===t)?.value;return `${get('year')}-${get('month')}-${get('day')}`}catch{return localDateKey(new Date())}}


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

        const browserMapsKey = await window.TransportAddressAutocomplete.resolveBrowserMapsKey(
            bookingsDb,
            adminCompany,
            data?.googlemapsapi
        );

        if (!browserMapsKey) {

            if (message) {

                message.textContent =
                    "Google Maps API key not found.";
            }

            return;
        }

        await window.TransportAddressAutocomplete.loadGoogleMaps(
            browserMapsKey
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
    const pickup = window.TransportAddressAutocomplete.metadata("pickupAddress");
    const dropoff = window.TransportAddressAutocomplete.metadata("dropoffAddress");
    const text = [origin, destination, pickup.placeName, dropoff.placeName, pickup.displayAddress, dropoff.displayAddress]
        .filter(Boolean).join(" ").toLowerCase();
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
    if (!dispatchMap || !window.google) return;
    const visibleIds=new Set();
    allDrivers.filter(driver=>Number.isFinite(Number(driver.latitude))&&Number.isFinite(Number(driver.longitude))).forEach(driver=>{
        const number=String(driver.driver_number||"DRV"),id=String(driver.id);visibleIds.add(id);
        const active=allBookings.find(row=>String(row.driver_id)===id&&["on_way","arrived","passenger_onboard"].includes(bookingStatus(row)));
        const stale=!driver.location_updated_at||Date.now()-Date.parse(driver.location_updated_at)>120000;
        const status=!driver.online||stale||String(driver.status||"").toLowerCase().includes("unavailable")?"Offline / Unavailable":active?({on_way:"On Way",arrived:"Arrived / Outside",passenger_onboard:"Passenger On Board"})[bookingStatus(active)]:allBookings.some(row=>String(row.driver_id)===id&&bookingStatus(row)==="completed"&&row.journey_date===localDateKey(new Date()))?"Dropped Off / Completed":"Available / No Active Job";
        const style={"Available / No Active Job":["#6d28d9","#fff"],"On Way":["#1d4ed8","#fff"],"Arrived / Outside":["#f97316","#111827"],"Passenger On Board":["#be185d","#fff"],"Dropped Off / Completed":["#fff","#111827"],"Offline / Unavailable":["#b91c1c","#fff"]}[status];
        const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="58" height="30"><rect x="1" y="1" width="56" height="25" rx="5" fill="${style[0]}" stroke="#0f172a" stroke-width="2"/><path d="M25 26h8l-4 4z" fill="#0f172a"/></svg>`;
        let marker=driverMarkers.find(item=>String(item.__driverId)===id);
        if(!marker){marker=new google.maps.Marker({map:dispatchMap});marker.__driverId=driver.id;driverMarkers.push(marker);}
        marker.setOptions({position:{lat:Number(driver.latitude),lng:Number(driver.longitude)},map:dispatchMap,title:`Driver ${number} — ${status}`,icon:{url:`data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`,scaledSize:new google.maps.Size(58,30),anchor:new google.maps.Point(29,30)},label:{text:number,color:style[1],fontWeight:"900",fontSize:"14px"}});
        if(!marker.__infoBound){marker.addListener("click",()=>{const latest=allDrivers.find(x=>String(x.id)===String(marker.__driverId))||driver;new google.maps.InfoWindow({content:`<strong>${escapeHtml(latest.driver_number||"DRV")} — ${escapeHtml(latest.full_name||"Driver")}</strong><br>Status: ${escapeHtml(marker.__status||status)}<br>Vehicle: ${escapeHtml(latest.vehicle||"Unassigned")}<br>GPS: ${escapeHtml(latest.location_updated_at?new Date(latest.location_updated_at).toLocaleString("en-GB"):"No update")}`}).open({anchor:marker,map:dispatchMap});});marker.__infoBound=true;}marker.__status=status;
    });
    driverMarkers.filter(marker=>!visibleIds.has(String(marker.__driverId))).forEach(marker=>marker.setMap(null));
    driverMarkers=driverMarkers.filter(marker=>visibleIds.has(String(marker.__driverId)));
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
    if (bookingPaymentKind(booking) === "paid" && /(stripe|card|prepaid)/i.test(String(booking?.payment_method || ""))) return "payment-prepaid";
    return `payment-${bookingPaymentKind(booking).replace("part_paid","partial")}`;
}

function bookingPaymentLabel(booking) {
    const kind=bookingPaymentKind(booking),method=String(booking?.payment_method||"").toLowerCase();if(kind==="paid"&&/(stripe|card|prepaid)/.test(method))return "PREPAID / STRIPE";return {account:"ACCOUNT / INVOICE",paid:"PAID",part_paid:"PART PAID",unpaid:"UNPAID"}[kind];
}
function bookingPaymentKind(booking){const method=canonicalPaymentMethod(booking?.payment_method),status=String(booking?.payment_status||"").trim().toLowerCase().replaceAll(" ","_"),paid=Number(booking?.amount_paid||0),fare=Number(booking?.price??booking?.job_price??0);if(method==="account")return "account";if(status==="paid"||status==="prepaid")return "paid";if(status==="part_paid"||status==="partially_paid"||(paid>0&&paid<fare))return "part_paid";return "unpaid";}

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

function vehicleTierLabel(value) {
    const tier = String(value || "").toLowerCase();
    return {
        standard: "Car",
        car: "Car",
        executive_car: "Executive Car",
        "5_7": "5–7 Seater",
        mpv: "5–7 Seater",
        executive_5_7: "Executive 5–7 Seater",
        "5_8": "5–8 Seater",
        "9_16": "9–16 Seater",
        "17_23": "17–23 Seater",
        "24_52": "24–52 Seater"
    }[tier] || prettyLabel(value);
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

function setTimelineItem(id, value) {
    const element = document.getElementById(id);
    if (!element) return;
    element.textContent = formatDateTime(value);
    element.closest(".booking-detail-item")?.toggleAttribute("hidden", !value);
}

function setOptionalDetail(id, value) {
    const element = document.getElementById(id);
    if (!element) return;
    element.textContent = value || "-";
    element.closest(".booking-detail-item")?.toggleAttribute("hidden", !value);
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
