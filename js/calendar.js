const calendarDb = getSupabase();

let calendarCompanyId = null;
let calendarBookings = [];
let calendarDrivers = [];
let calendarSettings = {};
let calendarCursor = new Date();

document.addEventListener("DOMContentLoaded", async () => {
    try {
        const context = await window.getAdminCompanyContext();
        calendarCompanyId = context.companyId;

        bindCalendarEvents();

        await Promise.all([
            loadCalendarDrivers(),
            loadCalendarSettings()
        ]);

        await loadCalendarBookings();
        renderCalendarPage();

    } catch (error) {
        console.error("Calendar startup error:", error);
    }
});

function bindCalendarEvents() {
    document.getElementById("previousMonth")?.addEventListener("click", async () => {
        calendarCursor = new Date(
            calendarCursor.getFullYear(),
            calendarCursor.getMonth() - 1,
            1
        );
        await loadCalendarBookings();
        renderCalendarPage();
    });

    document.getElementById("nextMonth")?.addEventListener("click", async () => {
        calendarCursor = new Date(
            calendarCursor.getFullYear(),
            calendarCursor.getMonth() + 1,
            1
        );
        await loadCalendarBookings();
        renderCalendarPage();
    });

    document.getElementById("todayButton")?.addEventListener("click", async () => {
        calendarCursor = new Date();
        await loadCalendarBookings();
        renderCalendarPage();
    });

    document.getElementById("newBookingButton")?.addEventListener("click", () => {
        window.location.href = "bookings.html";
    });

    document.getElementById("closeCalendarBooking")?.addEventListener("click", closeCalendarBooking);

    document.getElementById("calendarBookingBackdrop")?.addEventListener("click", event => {
        if (event.target.id === "calendarBookingBackdrop") {
            closeCalendarBooking();
        }
    });
}

async function loadCalendarDrivers() {
    const { data, error } = await calendarDb
        .from("drivers")
        .select("id,driver_number,full_name,online,status")
        .eq("company_id", calendarCompanyId);

    if (error) {
        console.error("Calendar drivers:", error);
        calendarDrivers = [];
        return;
    }

    calendarDrivers = data || [];
}

async function loadCalendarSettings() {
    const { data, error } = await calendarDb
        .from("settings")
        .select("googlecalendarid,timezone")
        .eq("company_id", calendarCompanyId)
        .maybeSingle();

    if (error) {
        console.error("Calendar settings:", error);
        calendarSettings = {};
        return;
    }

    calendarSettings = data || {};
    renderGoogleCalendarStatus();
}

async function loadCalendarBookings() {
    const monthStart = new Date(
        calendarCursor.getFullYear(),
        calendarCursor.getMonth(),
        1
    );

    const gridStart = startOfCalendarGrid(monthStart);
    const gridEnd = new Date(gridStart);
    gridEnd.setDate(gridEnd.getDate() + 41);

    const { data, error } = await calendarDb
        .from("bookings")
        .select("*")
        .eq("company_id", calendarCompanyId)
        .gte("journey_date", localDateKey(gridStart))
        .lte("journey_date", localDateKey(gridEnd))
        .order("journey_date", { ascending: true })
        .order("journey_time", { ascending: true });

    if (error) {
        console.error("Calendar bookings:", error);
        calendarBookings = [];
        return;
    }

    const { data: stops, error: stopsError } = await calendarDb
        .from("booking_stops").select("*").eq("company_id", calendarCompanyId).order("stop_order");
    if (stopsError) console.error("Calendar stops:", stopsError);
    calendarBookings = (data || []).map(booking => ({
        ...booking,
        via_stops: (stops || []).filter(stop => String(stop.booking_id) === String(booking.id))
    }));
}

function renderCalendarPage() {
    renderMonthTitle();
    renderMonthGrid();
    renderStats();
    renderTodaySchedule();
    renderUpcoming();
}

function renderMonthTitle() {
    const title = document.getElementById("calendarMonthTitle");
    if (!title) return;

    title.textContent = calendarCursor.toLocaleDateString("en-GB", {
        month: "long",
        year: "numeric"
    });
}

function renderMonthGrid() {
    const body = document.getElementById("calendarBody");
    if (!body) return;

    const monthStart = new Date(
        calendarCursor.getFullYear(),
        calendarCursor.getMonth(),
        1
    );

    const gridStart = startOfCalendarGrid(monthStart);
    const todayKey = localDateKey(new Date());

    let html = "";

    for (let week = 0; week < 6; week++) {
        html += "<tr>";

        for (let day = 0; day < 7; day++) {
            const current = new Date(gridStart);
            current.setDate(gridStart.getDate() + week * 7 + day);

            const key = localDateKey(current);

            const dayBookings = calendarBookings.filter(
                booking => booking.journey_date === key
            );

            const classes = ["calendar-day"];

            if (current.getMonth() !== calendarCursor.getMonth()) {
                classes.push("other-month");
            }

            if (key === todayKey) {
                classes.push("today");
            }

            const visible = dayBookings.slice(0, 4);

            html += `
                <td class="${classes.join(" ")}">
                    <div class="calendar-day-number">
                        <span>${current.getDate()}</span>
                        <span>${dayBookings.length ? `${dayBookings.length} job${dayBookings.length === 1 ? "" : "s"}` : ""}</span>
                    </div>

                    ${visible.map(calendarJobHtml).join("")}

                    ${
                        dayBookings.length > visible.length
                            ? `<div class="calendar-more">+ ${dayBookings.length - visible.length} more</div>`
                            : ""
                    }
                </td>
            `;
        }

        html += "</tr>";
    }

    body.innerHTML = html;

    body.querySelectorAll("[data-calendar-booking]").forEach(button => {
        button.addEventListener("click", () => {
            openCalendarBooking(button.dataset.calendarBooking);
        });
    });
}

function calendarJobHtml(booking) {
    const status = normaliseStatus(booking.status);
    const classes = ["calendar-job"];

    if (!booking.driver_id) classes.push("unassigned");
    if (status === "completed") classes.push("completed");
    if (["cancelled", "canceled"].includes(status)) classes.push("cancelled");

    const driver = driverLabel(booking.driver_id);

    return `
        <button
            class="${classes.join(" ")}"
            type="button"
            data-calendar-booking="${escapeHtml(booking.id)}"
        >
            <strong>${escapeHtml(formatTime(booking.journey_time))}</strong>
            ${escapeHtml(driver)}
            <br>
            ${escapeHtml(shortPlace(booking.pickup_address || booking.pickup || "-"))}
            →
            ${escapeHtml(shortPlace(booking.dropoff_address || booking.destination || "-"))}
        </button>
    `;
}

function renderStats() {
    const today = localDateKey(new Date());

    const todayBookings = calendarBookings.filter(
        booking => booking.journey_date === today
    );

    setText("todayJobs", todayBookings.length);

    const workingDriverIds = new Set(
        todayBookings
            .filter(booking =>
                booking.driver_id &&
                !["completed", "cancelled", "canceled"].includes(
                    normaliseStatus(booking.status)
                )
            )
            .map(booking => String(booking.driver_id))
    );

    setText("driversWorking", workingDriverIds.size);

    const airportRuns = todayBookings.filter(booking =>
        Boolean(booking.airport) ||
        String(booking.journey_type || "").toLowerCase().includes("airport")
    ).length;

    setText("airportRuns", airportRuns);

    const unassigned = todayBookings.filter(booking =>
        !booking.driver_id &&
        !["completed", "cancelled", "canceled"].includes(
            normaliseStatus(booking.status)
        )
    ).length;

    setText("unassignedJobs", unassigned);
}

function renderTodaySchedule() {
    const body = document.getElementById("todayScheduleBody");
    if (!body) return;

    const today = localDateKey(new Date());

    const rows = calendarBookings
        .filter(booking => booking.journey_date === today)
        .sort(compareBookings);

    if (!rows.length) {
        body.innerHTML =
            '<tr><td colspan="4">No jobs today.</td></tr>';
        return;
    }

    body.innerHTML = rows.map(booking => `
        <tr>
            <td>${escapeHtml(formatTime(booking.journey_time))}</td>
            <td>${escapeHtml(driverLabel(booking.driver_id))}</td>
            <td>
                ${escapeHtml(shortPlace(booking.pickup_address || booking.pickup || "-"))}
                →
                ${escapeHtml(shortPlace(booking.dropoff_address || booking.destination || "-"))}
            </td>
            <td>
                <button
                    class="schedule-row-button"
                    type="button"
                    data-calendar-booking="${escapeHtml(booking.id)}"
                >
                    View
                </button>
            </td>
        </tr>
    `).join("");

    body.querySelectorAll("[data-calendar-booking]").forEach(button => {
        button.addEventListener("click", () => {
            openCalendarBooking(button.dataset.calendarBooking);
        });
    });
}

function renderUpcoming() {
    const area = document.getElementById("upcomingJobs");
    if (!area) return;

    const nowKey = localDateKey(new Date());

    const rows = calendarBookings
        .filter(booking =>
            booking.journey_date >= nowKey &&
            !["completed", "cancelled", "canceled"].includes(
                normaliseStatus(booking.status)
            )
        )
        .sort(compareBookings)
        .slice(0, 8);

    if (!rows.length) {
        area.innerHTML = "<p>No upcoming jobs.</p>";
        return;
    }

    area.innerHTML = rows.map(booking => `
        <button
            type="button"
            data-calendar-booking="${escapeHtml(booking.id)}"
            style="
                width:100%;
                text-align:left;
                border:1px solid #e5e7eb;
                background:#f8fafc;
                border-radius:8px;
                padding:10px;
                margin:0 0 8px;
            "
        >
            <strong>
                ${escapeHtml(formatDate(booking.journey_date))}
                ${escapeHtml(formatTime(booking.journey_time))}
            </strong>
            <br>
            <small>
                ${escapeHtml(driverLabel(booking.driver_id))}
                •
                ${escapeHtml(shortPlace(booking.pickup_address || booking.pickup || "-"))}
                →
                ${escapeHtml(shortPlace(booking.dropoff_address || booking.destination || "-"))}
            </small>
        </button>
    `).join("");

    area.querySelectorAll("[data-calendar-booking]").forEach(button => {
        button.addEventListener("click", () => {
            openCalendarBooking(button.dataset.calendarBooking);
        });
    });
}

function openCalendarBooking(id) {
    const booking = calendarBookings.find(
        row => String(row.id) === String(id)
    );

    if (!booking) return;

    setText(
        "calendarBookingTitle",
        booking.booking_reference || shortId(booking.id)
    );

    setText(
        "calendarBookingSubtitle",
        `${formatDate(booking.journey_date)} at ${formatTime(booking.journey_time)}`
    );

    setText("detailReference", booking.booking_reference || shortId(booking.id));
    setText("detailStatus", prettyStatus(booking.status || "waiting"));
    setText("detailDate", formatDate(booking.journey_date));
    setText("detailTime", formatTime(booking.journey_time));
    setText("detailDriver", driverLabel(booking.driver_id));
    setText("detailPassenger", booking.customer_name || booking.full_name || "-");
    setText("detailPhone", booking.customer_phone || booking.phone || "-");
    setText("detailPassengers", booking.passengers ?? "-");
    setText("detailPickup", booking.pickup_address || booking.pickup || "-");
    setText("detailDestination", booking.dropoff_address || booking.destination || "-");
    setText("detailFlight", booking.flight_number || "-");
    setText("detailPrice", money(booking.price ?? booking.job_price));
    setText("detailPayment", booking.payment_method || booking.payment_status || "-");
    setText("detailViaStops", (booking.via_stops || []).map(stop => `${stop.stop_order}. ${stop.formatted_address}`).join("\n") || "-");
    setText("detailSource", booking.booking_source || "website");
    setText("detailNotes", booking.notes || "-");

    document.getElementById("calendarBookingBackdrop")?.classList.add("open");
}

function closeCalendarBooking() {
    document.getElementById("calendarBookingBackdrop")?.classList.remove("open");
}

function renderGoogleCalendarStatus() {
    const el = document.getElementById("googleCalendarStatus");
    if (!el) return;

    if (calendarSettings.googlecalendarid) {
        el.textContent =
            `Google Calendar sync configured for: ${calendarSettings.googlecalendarid}`;
    } else {
        el.textContent =
            "No Google Calendar ID saved yet. Add one in Settings → Integrations.";
    }
}

function startOfCalendarGrid(monthStart) {
    const d = new Date(monthStart);
    const weekday = d.getDay(); // Sunday = 0
    const mondayOffset = weekday === 0 ? -6 : 1 - weekday;
    d.setDate(d.getDate() + mondayOffset);
    d.setHours(0, 0, 0, 0);
    return d;
}

function driverLabel(id) {
    if (!id) return "Unassigned";

    const driver = calendarDrivers.find(
        row => String(row.id) === String(id)
    );

    if (!driver) return "Driver";

    return `${driver.driver_number || "-"} — ${driver.full_name || "Driver"}`;
}

function compareBookings(a, b) {
    return `${a.journey_date || ""}T${a.journey_time || "00:00"}`
        .localeCompare(`${b.journey_date || ""}T${b.journey_time || "00:00"}`);
}

function normaliseStatus(status) {
    return String(status || "")
        .trim()
        .toLowerCase()
        .replaceAll(" ", "_");
}

function prettyStatus(status) {
    return normaliseStatus(status)
        .replaceAll("_", " ")
        .replace(/\b\w/g, letter => letter.toUpperCase());
}

function shortPlace(value) {
    return String(value || "").split(",")[0].trim();
}

function formatTime(value) {
    return value ? String(value).slice(0, 5) : "-";
}

function formatDate(value) {
    if (!value) return "-";

    const parts = String(value).split("-");

    return parts.length === 3
        ? `${parts[2]}/${parts[1]}/${parts[0]}`
        : value;
}

function localDateKey(date) {
    return (
        date.getFullYear() +
        "-" +
        String(date.getMonth() + 1).padStart(2, "0") +
        "-" +
        String(date.getDate()).padStart(2, "0")
    );
}

function money(value) {
    if (value === null || value === undefined || value === "") {
        return "-";
    }

    const n = Number(value);

    return Number.isFinite(n)
        ? `£${n.toFixed(2)}`
        : "-";
}

function shortId(value) {
    return String(value || "").slice(0, 8).toUpperCase();
}

function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value ?? "-";
}

function escapeHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}
