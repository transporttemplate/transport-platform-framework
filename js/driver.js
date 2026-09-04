const driverdb = getSupabase();

let currentCompany = null;
let currentDriver = null;
let currentJob = null;
let driverBookings = [];
let driverUnavailable = false;
let driverCommissionDefault = 0;
let driverCurrencySymbol = "£";
let driverSessionToken = null;
let driverUnavailability = [];

let gpsWatchId = null;
let driverRefreshTimer = null;

document.addEventListener("DOMContentLoaded", () => {
    bindDriverUI();
    restoreDriverSession();
});

function bindDriverUI() {
    document.getElementById("driverLoginButton")?.addEventListener("click", driverLogin);
    document.getElementById("driverLogoutButton")?.addEventListener("click", driverLogout);
    document.getElementById("menuButton")?.addEventListener("click", openSideMenu);
    document.getElementById("closeMenuButton")?.addEventListener("click", closeSideMenu);
    document.getElementById("menuOverlay")?.addEventListener("click", closeSideMenu);
    document.getElementById("availabilityButton")?.addEventListener("click", toggleAvailability);
    document.getElementById("acceptJobButton")?.addEventListener("click", acceptCurrentJob);
    document.getElementById("declineJobButton")?.addEventListener("click", declineCurrentJob);
    document.getElementById("onWayButton")?.addEventListener("click", setOnWay);
    document.getElementById("pobButton")?.addEventListener("click", setPOB);
    document.getElementById("dropOffButton")?.addEventListener("click", completeCurrentJob);
    document.getElementById("viewCurrentJobButton")?.addEventListener("click", () => currentJob && openJobDetails(currentJob));
    document.getElementById("closeJobDetailsButton")?.addEventListener("click", closeJobDetails);
    document.getElementById("jobDetailsOverlay")?.addEventListener("click", closeJobDetails);
    document.getElementById("holidayForm")?.addEventListener("submit", saveDriverHoliday);
    document.getElementById("imBackButton")?.addEventListener("click", endDriverHoliday);

    document.querySelectorAll("[data-view]").forEach(btn => {
        btn.addEventListener("click", () => {
            showDriverView(btn.dataset.view);
            closeSideMenu();
        });
    });

    document.getElementById("driverPin")?.addEventListener("keydown", e => {
        if (e.key === "Enter") driverLogin();
    });
}

async function driverLogin() {
    const companyCode = document.getElementById("companyId")?.value.trim();
    const numberInput = document.getElementById("driverNumber")?.value.trim();
    const pinInput = document.getElementById("driverPin")?.value.trim();

    if (!companyCode || !numberInput || !pinInput) {
        return setLoginMessage("Enter Company ID, Driver Number and PIN.", true);
    }

    setLoginMessage("Checking details...", false);

    try {
        const data = await driverPortalRequest("login", { company_code: companyCode, driver_number: numberInput, pin: pinInput }, false);
        currentCompany = data.company;
        currentDriver = data.driver;
        driverSessionToken = data.session_token;
        document.getElementById("driverPin").value = "";
        localStorage.setItem("driverPortalSession", JSON.stringify({ token: driverSessionToken, expiresAt: data.expires_at }));

        await enterDriverPortal();
    } catch (error) {
        console.error("Driver login:", error);
        setLoginMessage(error.message || "Unable to log in.", true);
    }
}

async function restoreDriverSession() {
    const raw = localStorage.getItem("driverPortalSession");
    if (!raw) return;

    try {
        const session = JSON.parse(raw);
        if (!session.token) throw new Error("Legacy driver session");
        driverSessionToken = session.token;
        const data = await driverPortalRequest("refresh");
        applyDriverPortalData(data);
        await enterDriverPortal();

    } catch (error) {
        console.error(error);
        localStorage.removeItem("driverPortalSession");
    }
}

async function enterDriverPortal() {
    document.getElementById("driverLoginScreen")?.classList.add("hidden");
    document.getElementById("driverApp")?.classList.remove("hidden");

    showDriverView("jobs");
    populateDriverHeader();
    await refreshDriverPortal();

    if (driverRefreshTimer) clearInterval(driverRefreshTimer);
    driverRefreshTimer = setInterval(refreshDriverPortal, 7000);

    if (isDriverOnline(currentDriver) && !driverUnavailable) startGpsTracking();
}

async function driverLogout() {
    stopGpsTracking();
    if (driverRefreshTimer) clearInterval(driverRefreshTimer);

    if (driverSessionToken) await driverPortalRequest("logout").catch(error => console.warn("Driver logout:", error));

    localStorage.removeItem("driverPortalSession");
    currentCompany = null;
    currentDriver = null;
    driverSessionToken = null;
    currentJob = null;
    driverBookings = [];

    closeSideMenu();
    closeJobDetails();

    document.getElementById("driverApp")?.classList.add("hidden");
    document.getElementById("driverLoginScreen")?.classList.remove("hidden");
}

function driverName(driver) {
    const firstLast = `${driver?.first_name ?? ""} ${driver?.last_name ?? ""}`.trim();
    return driver?.full_name || driver?.name || driver?.driver_name || firstLast || "Driver";
}

function driverNumber(driver) {
    return String(driver?.driver_number ?? driver?.driver_no ?? driver?.number ?? driver?.driver_ref ?? "-");
}

function populateDriverHeader() {
    const companyName =
        currentCompany?.name ||
        currentCompany?.trading_name ||
        `Company ${currentCompany?.company_code ?? ""}`;

    setText("driverName", driverName(currentDriver));
    setText("menuDriverName", driverName(currentDriver));
    setText("menuDriverNumber", driverNumber(currentDriver));
    setText("driverCompanyName", companyName);
    setText("menuCompanyName", companyName);
    refreshAvailabilityUI();
}

function setLoginMessage(text, error) {
    const el = document.getElementById("driverLoginMessage");
    if (!el) return;
    el.textContent = text;
    el.classList.toggle("error", !!error);
}

async function driverPortalRequest(action, body = {}, includeSession = true) {
    const requestBody = { action, ...body };
    if (includeSession) requestBody.session_token = driverSessionToken;
    const { data, error } = await driverdb.functions.invoke("driver-portal", { body: requestBody });
    if (error || !data?.ok) throw new Error(data?.error || error?.message || "Driver portal request failed");
    return data;
}

function applyDriverPortalData(data) {
    currentCompany = data.company || currentCompany;
    currentDriver = data.driver || currentDriver;
    driverBookings = data.jobs || driverBookings;
    driverUnavailability = data.unavailability || [];
    driverCommissionDefault = Number(data.settings?.drivercommission || 0);
    driverCurrencySymbol = data.settings?.currencysymbol || "£";
    const now = new Date();
    driverUnavailable = driverUnavailability.some(row => row.active !== false && new Date(row.from_datetime) <= now && new Date(row.to_datetime) >= now);
    renderHolidayList(driverUnavailability);
    document.getElementById("imBackButton")?.classList.toggle("hidden", !driverUnavailable);
    populateDriverHeader();
}

async function refreshDriverPortal() {
    if (!driverSessionToken) return;
    try {
        applyDriverPortalData(await driverPortalRequest("refresh"));
    } catch (error) {
        console.error("Driver refresh:", error);
        if (/session/i.test(error.message)) await driverLogout();
        return;
    }

    renderCurrentJob();
    renderUpcomingBookings();
    renderEarnings();
    refreshAvailabilityUI();
}

function isDriverOnline(driver) {
    return Boolean(driver?.online ?? driver?.is_online ?? driver?.available ?? false);
}

async function toggleAvailability() {
    if (driverUnavailable) {
        return alert("You are marked unavailable. Use I'm Back first.");
    }

    const goingOnline = !isDriverOnline(currentDriver);

    try { await driverPortalRequest("set_online", { online: goingOnline }); }
    catch (error) { console.error(error); return alert("Unable to update availability."); }

    currentDriver.online = goingOnline;

    if (goingOnline) startGpsTracking();
    else stopGpsTracking();

    refreshAvailabilityUI();
}

function refreshAvailabilityUI() {
    const online = isDriverOnline(currentDriver) && !driverUnavailable;

    setText("availabilityText",
        driverUnavailable ? "Unavailable" : online ? "Online" : "Offline"
    );

    const button = document.getElementById("availabilityButton");
    if (button) {
        button.textContent =
            driverUnavailable ? "Unavailable" : online ? "Go Offline" : "Go Online";
        button.classList.toggle("online", online);
        button.classList.toggle("offline", !online);
    }

    const dot = document.getElementById("availabilityDot");
    if (dot) {
        dot.classList.toggle("online", online);
        dot.classList.toggle("offline", !online);
    }
}

function startGpsTracking() {
    if (!navigator.geolocation || gpsWatchId !== null) return;

    gpsWatchId = navigator.geolocation.watchPosition(
        saveDriverPosition,
        error => {
            console.warn("GPS error:", error);
            if (error.code === 1) {
                alert("Allow Location access for the driver portal while you are online.");
                stopGpsTracking();
            }
        },
        {
            enableHighAccuracy: true,
            maximumAge: 5000,
            timeout: 20000
        }
    );
}

function stopGpsTracking() {
    if (gpsWatchId !== null && navigator.geolocation) {
        navigator.geolocation.clearWatch(gpsWatchId);
    }
    gpsWatchId = null;
}

async function saveDriverPosition(position) {
    if (!currentDriver || !currentCompany || !isDriverOnline(currentDriver)) return;

    const update = {
        latitude: Number(position.coords.latitude),
        longitude: Number(position.coords.longitude),
        location_updated_at: new Date().toISOString()
    };

    try { await driverPortalRequest("gps", update); Object.assign(currentDriver, update); }
    catch (error) { console.warn("Driver GPS update:", error); }
}

function renderCurrentJob() {
    const active = ["assigned", "accepted", "on_way", "passenger_onboard"];

    currentJob =
        driverBookings.find(job => active.includes(normaliseStatus(job.status))) || null;

    const card = document.getElementById("currentJobCard");
    const empty = document.getElementById("noCurrentJob");

    if (!currentJob) {
        card?.classList.add("hidden");
        empty?.classList.remove("hidden");
        return;
    }

    card?.classList.remove("hidden");
    empty?.classList.add("hidden");

    setText("currentJobReference", currentJob.booking_reference || shortId(currentJob.id));
    setText("currentJobStatus", prettyStatus(currentJob.status || "assigned"));
    setText("currentPickup", pickup(currentJob));
    setText("currentDestination", destination(currentJob));
    setText("currentJobTime", formatTime(currentJob.journey_time));
    setText("currentPassengers", currentJob.passengers ?? "-");
    setText("currentFare", money(jobPrice(currentJob)));
    setText("currentPayment", currentJob.payment_method ?? currentJob.payment_status ?? "-");

    renderJobActions();
}

function renderJobActions() {
    if (!currentJob) return;

    const status = normaliseStatus(currentJob.status);
    const offer = document.getElementById("jobOfferActions");
    const progress = document.getElementById("jobProgressActions");

    offer?.classList.toggle("hidden", status !== "assigned");
    progress?.classList.toggle("hidden", status === "assigned");

    document.getElementById("onWayButton")?.classList.toggle("hidden", status !== "accepted");
    document.getElementById("pobButton")?.classList.toggle("hidden", status !== "on_way");
    document.getElementById("dropOffButton")?.classList.toggle("hidden", status !== "passenger_onboard");
}

function canWork() {
    if (driverUnavailable) {
        alert("You are marked unavailable.");
        return false;
    }

    if (!isDriverOnline(currentDriver)) {
        alert("Go Online before starting a job.");
        return false;
    }

    return true;
}

async function acceptCurrentJob() {
    if (!canWork()) return;
    await updateCurrentJobStatus("accepted");
    renderJobActions();
}

async function declineCurrentJob() {
    if (!currentJob || !confirm("Decline this job?")) return;

    try { await driverPortalRequest("job_status", { booking_id: currentJob.id, status: "declined" }); }
    catch (error) { console.error(error); return alert("Unable to decline this job."); }

    currentJob = null;
    await refreshDriverPortal();
}

async function setOnWay() {
    if (!canWork()) return;

    if (await updateCurrentJobStatus("on_way", {
        on_way_at: new Date().toISOString()
    })) {
        openNavigation(pickup(currentJob));
        renderJobActions();
    }
}

async function setPOB() {
    if (!canWork()) return;

    if (await updateCurrentJobStatus("passenger_onboard", {
        passenger_onboard_at: new Date().toISOString()
    })) {
        openJobRoute(currentJob);
        renderJobActions();
    }
}

async function completeCurrentJob() {
    if (!canWork() || !confirm("Mark this job dropped off and completed?")) return;

    if (await updateCurrentJobStatus("completed", {
        completed_at: new Date().toISOString()
    })) {
        currentJob = null;
        await refreshDriverPortal();
    }
}

async function updateCurrentJobStatus(status, extra = {}) {
    if (!currentJob) return false;

    const update = { status, ...extra };
    try { await driverPortalRequest("job_status", { booking_id: currentJob.id, status }); }
    catch (error) {
        console.error(error);
        alert("Unable to update this job.");
        return false;
    }

    Object.assign(currentJob, update);
    setText("currentJobStatus", prettyStatus(status));
    return true;
}

function openNavigation(address) {
    if (!address || address === "-") return alert("No address saved for this job.");

    window.location.href =
        "https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=" +
        encodeURIComponent(address);
}

function openJobRoute(job) {
    const stops = (job?.via_stops || []).map(stop => stop.formatted_address).filter(Boolean);
    const params = new URLSearchParams({ api: "1", travelmode: "driving", destination: destination(job) });
    if (stops.length) params.set("waypoints", stops.join("|"));
    window.location.href = `https://www.google.com/maps/dir/?${params.toString()}`;
}

function openJobDetails(job) {
    setText("detailReference", job.booking_reference || shortId(job.id));
    setText("detailDate", formatDate(job.journey_date));
    setText("detailTime", formatTime(job.journey_time));
    setText("detailPickup", pickup(job));
    setText("detailDestination", destination(job));
    setText("detailViaStops", (job.via_stops || []).map(stop => `${stop.stop_order}. ${stop.formatted_address}`).join("\n") || "-");
    setText("detailPassenger", job.customer_name ?? job.passenger_name ?? "-");
    setText("detailPhone", job.phone ?? job.customer_phone ?? "-");
    setText("detailPassengers", job.passengers ?? "-");
    setText("detailSuitcases", job.suitcases ?? "-");
    setText("detailHandLuggage", job.hand_luggage ?? "-");
    setText("detailFlightNumber", job.flight_number || "-");
    setText("detailFare", money(jobPrice(job)));
    setText("detailPayment", job.payment_method ?? job.payment_status ?? "-");
    setText("detailNotes", job.notes || "-");

    const phone = job.phone ?? job.customer_phone ?? "";
    const call = document.getElementById("callPassengerButton");
    if (call) call.href = phone ? `tel:${String(phone).replace(/\s+/g, "")}` : "#";

    document.getElementById("jobDetailsDrawer")?.classList.add("open");
    document.getElementById("jobDetailsOverlay")?.classList.add("open");
}

function closeJobDetails() {
    document.getElementById("jobDetailsDrawer")?.classList.remove("open");
    document.getElementById("jobDetailsOverlay")?.classList.remove("open");
}

function renderUpcomingBookings() {
    const list = document.getElementById("upcomingBookingsList");
    if (!list) return;

    const jobs = driverBookings
        .filter(job => !["completed", "cancelled", "declined"].includes(normaliseStatus(job.status)))
        .sort(compareJobs);

    if (!jobs.length) {
        list.innerHTML = '<div class="empty-list">No upcoming bookings.</div>';
        return;
    }

    list.innerHTML = jobs.map(job => `
        <button class="upcoming-job-card" type="button" data-job-id="${escapeHtml(String(job.id))}">
            <div>
                <strong>${escapeHtml(formatDate(job.journey_date))} • ${escapeHtml(formatTime(job.journey_time))}</strong>
                <span>${escapeHtml(pickup(job))} → ${escapeHtml(destination(job))}</span>
            </div>
            <span>${escapeHtml(prettyStatus(job.status || "assigned"))}</span>
        </button>
    `).join("");

    list.querySelectorAll("[data-job-id]").forEach(button => {
        button.addEventListener("click", () => {
            const job = driverBookings.find(x => String(x.id) === String(button.dataset.jobId));
            if (job) openJobDetails(job);
        });
    });
}

function renderEarnings() {
    const completed = driverBookings.filter(job => normaliseStatus(job.status) === "completed");
    const today = localDateKey(new Date());

    const todayJobs = completed.filter(job => job.journey_date === today);
    const todayTotal = todayJobs.reduce((sum, job) => sum + driverEarning(job), 0);

    const weekStart = getWeekStart(new Date());
    const weekTotal = completed.reduce((sum, job) => {
        const d = job.journey_date ? new Date(`${job.journey_date}T00:00:00`) : null;
        return d && d >= weekStart ? sum + driverEarning(job) : sum;
    }, 0);

    setText("todayEarnings", money(todayTotal));
    setText("todayJobs", driverBookings.filter(job => job.journey_date === today).length);
    setText("earningsToday", money(todayTotal));
    setText("earningsWeek", money(weekTotal));

    const list = document.getElementById("earningsList");
    if (!list) return;

    if (!completed.length) {
        list.innerHTML = '<div class="empty-list">No completed jobs yet.</div>';
        return;
    }

    list.innerHTML = completed.slice().reverse().map(job => `
        <div class="earning-row">
            <div>
                <strong>${escapeHtml(formatDate(job.journey_date))} • ${escapeHtml(formatTime(job.journey_time))}</strong>
                <span>${escapeHtml(destination(job))}</span>
            </div>
            <strong>${escapeHtml(money(driverEarning(job)))}</strong>
        </div>
    `).join("");
}

function driverEarning(job) {
    if (currentDriver?.pay_type === "fixed") return Number(currentDriver.fixed_job_amount || 0);
    const rate = Number(currentDriver?.commission_percent ?? driverCommissionDefault ?? 0);
    const grossFare = jobPrice(job);
    const companyCommission = grossFare * rate / 100;
    return grossFare - companyCommission;
}

async function refreshHolidayStatus() {
    driverUnavailable = false;
    const list = document.getElementById("holidayList");

    const rows = driverUnavailability;
    const now = new Date();

    driverUnavailable = rows.some(row =>
        row.active !== false &&
        new Date(row.from_datetime) <= now &&
        new Date(row.to_datetime) >= now
    );

    renderHolidayList(rows);
    document.getElementById("imBackButton")?.classList.toggle("hidden", !driverUnavailable);
}

async function saveDriverHoliday(event) {
    event.preventDefault();

    const from = new Date(
        `${document.getElementById("holidayFromDate").value}T${document.getElementById("holidayFromTime").value}`
    );
    const to = new Date(
        `${document.getElementById("holidayToDate").value}T${document.getElementById("holidayToTime").value}`
    );
    const reason = document.getElementById("holidayReason").value.trim();

    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) {
        return alert("Check the From and To dates/times.");
    }

    try { await driverPortalRequest("create_unavailability", { from_datetime: from.toISOString(), to_datetime: to.toISOString(), reason }); }
    catch (error) { console.error(error); return alert("Unable to save holiday/off day."); }

    currentDriver.online = false;
    stopGpsTracking();
    event.target.reset();

    await refreshHolidayStatus();
    refreshAvailabilityUI();
}

async function endDriverHoliday() {
    try { await driverPortalRequest("end_unavailability"); await refreshDriverPortal(); }
    catch (error) { console.error(error); return alert("Unable to end unavailable period."); }
    refreshAvailabilityUI();
}

function renderHolidayList(rows) {
    const list = document.getElementById("holidayList");
    if (!list) return;

    if (!rows.length) {
        list.innerHTML = '<div class="empty-list">No holidays or off days saved.</div>';
        return;
    }

    list.innerHTML = rows.map(row => `
        <div class="holiday-row">
            <div>
                <strong>${escapeHtml(formatDateTime(row.from_datetime))}</strong>
                <span>to ${escapeHtml(formatDateTime(row.to_datetime))}</span>
                ${row.reason ? `<small>${escapeHtml(row.reason)}</small>` : ""}
            </div>
            <span>${row.active === false ? "Ended" : "Booked"}</span>
        </div>
    `).join("");
}

function showDriverView(name) {
    document.querySelectorAll(".driver-view")
        .forEach(view => view.classList.remove("active"));

    document.getElementById(`view-${name}`)?.classList.add("active");

    if (name === "earnings") renderEarnings();
    if (name === "upcoming") renderUpcomingBookings();
    if (name === "holidays") refreshHolidayStatus();

    window.scrollTo({ top: 0, behavior: "instant" });
}

function openSideMenu() {
    document.getElementById("driverSideMenu")?.classList.add("open");
    document.getElementById("menuOverlay")?.classList.add("open");
}

function closeSideMenu() {
    document.getElementById("driverSideMenu")?.classList.remove("open");
    document.getElementById("menuOverlay")?.classList.remove("open");
}

function pickup(job) {
    return job?.pickup_address ?? job?.pickup ?? "-";
}

function destination(job) {
    return job?.dropoff_address ?? job?.destination ?? job?.dropoff ?? "-";
}

function jobPrice(job) {
    const p = Number(job?.price);
    const jp = Number(job?.job_price);
    if (Number.isFinite(p) && p > 0) return p;
    if (Number.isFinite(jp) && jp > 0) return jp;
    return 0;
}

function money(value) {
    const n = Number(value);
    return Number.isFinite(n) ? `${driverCurrencySymbol}${n.toFixed(2)}` : `${driverCurrencySymbol}0.00`;
}

function normaliseStatus(status) {
    return String(status || "").trim().toLowerCase().replaceAll(" ", "_");
}

function prettyStatus(status) {
    const v = normaliseStatus(status);
    return {
        "on_way": "On Way",
        "passenger_onboard": "POB",
        "completed": "Completed",
        "waiting": "Waiting",
        "assigned": "Assigned",
        "accepted": "Accepted",
        "declined": "Declined",
        "cancelled": "Cancelled"
    }[v] || status || "Waiting";
}

function formatTime(value) {
    return value ? String(value).slice(0, 5) : "-";
}

function formatDate(value) {
    if (!value) return "-";
    const p = String(value).split("-");
    return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : value;
}

function formatDateTime(value) {
    if (!value) return "-";
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return value;

    return d.toLocaleString("en-GB", {
        day: "2-digit", month: "2-digit", year: "numeric",
        hour: "2-digit", minute: "2-digit", hour12: false
    });
}

function compareJobs(a, b) {
    return `${a.journey_date || ""}T${a.journey_time || "00:00"}`
        .localeCompare(`${b.journey_date || ""}T${b.journey_time || "00:00"}`);
}

function localDateKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;
}

function getWeekStart(date) {
    const d = new Date(date);
    const day = d.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    d.setDate(d.getDate() + diff);
    d.setHours(0,0,0,0);
    return d;
}

function shortId(value) {
    return String(value || "").slice(0,8).toUpperCase();
}

function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value ?? "-";
}

function escapeHtml(value) {
    return String(value ?? "")
        .replaceAll("&","&amp;")
        .replaceAll("<","&lt;")
        .replaceAll(">","&gt;")
        .replaceAll('"',"&quot;")
        .replaceAll("'","&#039;");
}

window.addEventListener("beforeunload", () => {
    stopGpsTracking();
    if (driverRefreshTimer) clearInterval(driverRefreshTimer);
});
