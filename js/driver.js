const driverdb = getSupabase();

let currentCompany = null;
let currentDriver = null;
let currentJob = null;
let driverBookings = [];
let driverUnavailable = false;

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
        setLoginMessage("Enter Company ID, Driver Number and PIN.", true);
        return;
    }

    setLoginMessage("Checking details...", false);

    try {
        const { data: company, error: companyError } = await driverdb
            .from("companies")
            .select("*")
            .eq("company_code", companyCode)
            .maybeSingle();

        if (companyError) throw companyError;
        if (!company) return setLoginMessage("Company ID not recognised.", true);

        const { data: drivers, error: driverError } = await driverdb
            .from("drivers")
            .select("*")
            .eq("company_id", company.id);

        if (driverError) throw driverError;

        const driver = (drivers || []).find(row => {
            const no = String(row.driver_number ?? row.driver_no ?? row.number ?? row.driver_ref ?? "").trim();
            const pin = String(row.pin ?? row.driver_pin ?? row.password ?? "").trim();
            return no === numberInput && pin === pinInput;
        });

        if (!driver) return setLoginMessage("Driver Number or PIN is incorrect.", true);

        currentCompany = company;
        currentDriver = driver;

        localStorage.setItem("driverPortalSession", JSON.stringify({
            companyCode,
            driverId: driver.id
        }));

        await enterDriverPortal();
    } catch (error) {
        console.error("Driver login:", error);
        setLoginMessage("Unable to log in.", true);
    }
}

async function restoreDriverSession() {
    const raw = localStorage.getItem("driverPortalSession");
    if (!raw) return;

    try {
        const session = JSON.parse(raw);

        const { data: company } = await driverdb
            .from("companies").select("*")
            .eq("company_code", session.companyCode)
            .maybeSingle();

        if (!company) return;

        const { data: driver } = await driverdb
            .from("drivers").select("*")
            .eq("id", session.driverId)
            .eq("company_id", company.id)
            .maybeSingle();

        if (!driver) return;

        currentCompany = company;
        currentDriver = driver;
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
}

function driverLogout() {
    localStorage.removeItem("driverPortalSession");
    currentCompany = null;
    currentDriver = null;
    currentJob = null;
    driverBookings = [];

    closeSideMenu();
    closeJobDetails();

    document.getElementById("driverApp")?.classList.add("hidden");
    document.getElementById("driverLoginScreen")?.classList.remove("hidden");

    if (document.getElementById("driverPin")) document.getElementById("driverPin").value = "";
}

function driverName(driver) {
    const firstLast = `${driver?.first_name ?? ""} ${driver?.last_name ?? ""}`.trim();
    return driver?.full_name || driver?.name || driver?.driver_name || firstLast || "Driver";
}

function driverNumber(driver) {
    return String(driver?.driver_number ?? driver?.driver_no ?? driver?.number ?? driver?.driver_ref ?? "-");
}

function populateDriverHeader() {
    const name = driverName(currentDriver);
    const number = driverNumber(currentDriver);
    const companyName = currentCompany?.name || currentCompany?.company_name || currentCompany?.display_name || `Company ${currentCompany?.company_code ?? ""}`;

    setText("driverName", name);
    setText("menuDriverName", name);
    setText("menuDriverNumber", number);
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

async function refreshDriverPortal() {
    await refreshHolidayStatus();
    await loadDriverBookings();
    renderCurrentJob();
    renderUpcomingBookings();
    renderEarnings();
    refreshAvailabilityUI();
}

function isDriverOnline(driver) {
    return Boolean(driver?.online ?? driver?.is_online ?? driver?.available ?? false);
}

function availabilityUpdate(value) {
    if ("online" in currentDriver) return { online: value };
    if ("is_online" in currentDriver) return { is_online: value };
    if ("available" in currentDriver) return { available: value };
    return { online: value };
}

async function toggleAvailability() {
    if (driverUnavailable) {
        alert("You are marked unavailable. Use I'm Back in Holidays / Off Days.");
        return;
    }

    const update = availabilityUpdate(!isDriverOnline(currentDriver));

    const { error } = await driverdb
        .from("drivers")
        .update(update)
        .eq("id", currentDriver.id)
        .eq("company_id", currentCompany.id);

    if (error) {
        console.error(error);
        return alert("Unable to update availability.");
    }

    Object.assign(currentDriver, update);
    refreshAvailabilityUI();
}

function refreshAvailabilityUI() {
    const online = isDriverOnline(currentDriver) && !driverUnavailable;
    const button = document.getElementById("availabilityButton");
    const dot = document.getElementById("availabilityDot");

    setText("availabilityText", driverUnavailable ? "Unavailable" : online ? "Online" : "Offline");

    if (button) {
        button.textContent = driverUnavailable ? "Unavailable" : online ? "Go Offline" : "Go Online";
        button.classList.toggle("online", online);
        button.classList.toggle("offline", !online);
    }

    if (dot) {
        dot.classList.toggle("online", online);
        dot.classList.toggle("offline", !online);
    }
}

async function loadDriverBookings() {
    const { data, error } = await driverdb
        .from("bookings")
        .select("*")
        .eq("company_id", currentCompany.id)
        .order("journey_date", { ascending: true })
        .order("journey_time", { ascending: true });

    if (error) {
        console.error("Driver bookings:", error);
        driverBookings = [];
        return;
    }

    const id = String(currentDriver.id);
    const no = driverNumber(currentDriver);

    driverBookings = (data || []).filter(job => {
        const assignedId = job.driver_id ?? job.assigned_driver_id ?? job.allocated_driver_id ?? null;
        const assignedNo = job.driver_number ?? job.assigned_driver_number ?? job.driver ?? null;
        return String(assignedId ?? "") === id || String(assignedNo ?? "") === no;
    });
}

function renderCurrentJob() {
    const active = ["assigned","waiting","pending","accepted","on way","on_way","pob","picked up","passenger onboard","passengers onboard"];
    currentJob = driverBookings.find(job => active.includes(normaliseStatus(job.status))) || null;

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
    setText("currentJobStatus", prettyStatus(currentJob.status || "Waiting"));
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

    const isOffer = ["assigned","waiting","pending"].includes(status);
    offer?.classList.toggle("hidden", !isOffer);
    progress?.classList.toggle("hidden", isOffer);

    document.getElementById("onWayButton")?.classList.toggle("hidden", status !== "accepted");
    document.getElementById("pobButton")?.classList.toggle("hidden", !["on way","on_way"].includes(status));
    document.getElementById("dropOffButton")?.classList.toggle("hidden", !["pob","picked up","passenger onboard","passengers onboard"].includes(status));
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
    if (await updateCurrentJobStatus("Accepted")) renderJobActions();
}

async function declineCurrentJob() {
    if (!currentJob || !confirm("Decline this job?")) return;
    if (await updateCurrentJobStatus("Declined")) await refreshDriverPortal();
}

async function setOnWay() {
    if (!canWork()) return;
    if (await updateCurrentJobStatus("On Way")) {
        openNavigation(pickup(currentJob));
        renderJobActions();
    }
}

async function setPOB() {
    if (!canWork()) return;
    if (await updateCurrentJobStatus("POB")) {
        openNavigation(destination(currentJob));
        renderJobActions();
    }
}

async function completeCurrentJob() {
    if (!canWork() || !confirm("Mark this job as dropped off and completed?")) return;
    if (await updateCurrentJobStatus("Completed")) {
        currentJob = null;
        await refreshDriverPortal();
    }
}

async function updateCurrentJobStatus(status) {
    if (!currentJob) return false;

    const { error } = await driverdb
        .from("bookings")
        .update({ status })
        .eq("id", currentJob.id)
        .eq("company_id", currentCompany.id);

    if (error) {
        console.error(error);
        alert("Unable to update this job.");
        return false;
    }

    currentJob.status = status;
    setText("currentJobStatus", prettyStatus(status));
    return true;
}

function openNavigation(address) {
    if (!address || address === "-") return alert("No address saved for this job.");
    window.open(`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address)}`, "_blank");
}

function openJobDetails(job) {
    setText("detailReference", job.booking_reference || shortId(job.id));
    setText("detailDate", formatDate(job.journey_date));
    setText("detailTime", formatTime(job.journey_time));
    setText("detailPickup", pickup(job));
    setText("detailDestination", destination(job));
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
    if (call) call.href = phone ? `tel:${String(phone).replace(/\s+/g,"")}` : "#";

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
        .filter(job => !["completed","cancelled","declined"].includes(normaliseStatus(job.status)))
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
            <span>${escapeHtml(prettyStatus(job.status || "Waiting"))}</span>
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
    const todayTotal = todayJobs.reduce((sum, job) => sum + jobPrice(job), 0);

    const weekStart = getWeekStart(new Date());
    const weekTotal = completed.reduce((sum, job) => {
        const d = job.journey_date ? new Date(`${job.journey_date}T00:00:00`) : null;
        return d && d >= weekStart ? sum + jobPrice(job) : sum;
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
            <strong>${escapeHtml(money(jobPrice(job)))}</strong>
        </div>
    `).join("");
}

async function refreshHolidayStatus() {
    driverUnavailable = false;
    const list = document.getElementById("holidayList");

    try {
        const { data, error } = await driverdb
            .from("driver_unavailability")
            .select("*")
            .eq("company_id", currentCompany.id)
            .eq("driver_id", currentDriver.id)
            .order("from_datetime", { ascending: false });

        if (error) {
            if (list) list.innerHTML = '<div class="empty-list">Holiday storage has not been set up yet.</div>';
            return;
        }

        const rows = data || [];
        const now = new Date();

        driverUnavailable = rows.some(row =>
            row.active !== false &&
            new Date(row.from_datetime) <= now &&
            new Date(row.to_datetime) >= now
        );

        renderHolidayList(rows);
        document.getElementById("imBackButton")?.classList.toggle("hidden", !driverUnavailable);
    } catch (error) {
        console.error(error);
    }
}

async function saveDriverHoliday(event) {
    event.preventDefault();

    const fromDate = document.getElementById("holidayFromDate").value;
    const fromTime = document.getElementById("holidayFromTime").value;
    const toDate = document.getElementById("holidayToDate").value;
    const toTime = document.getElementById("holidayToTime").value;
    const reason = document.getElementById("holidayReason").value.trim();

    const from = new Date(`${fromDate}T${fromTime}`);
    const to = new Date(`${toDate}T${toTime}`);

    if (!fromDate || !fromTime || !toDate || !toTime || to <= from) {
        return alert("Check the From and To dates/times.");
    }

    const { error } = await driverdb
        .from("driver_unavailability")
        .insert({
            company_id: currentCompany.id,
            driver_id: currentDriver.id,
            from_datetime: from.toISOString(),
            to_datetime: to.toISOString(),
            reason,
            active: true
        });

    if (error) {
        console.error(error);
        return alert("Unable to save holiday/off day.");
    }

    const update = availabilityUpdate(false);
    await driverdb.from("drivers").update(update)
        .eq("id", currentDriver.id)
        .eq("company_id", currentCompany.id);

    Object.assign(currentDriver, update);
    event.target.reset();
    await refreshHolidayStatus();
    refreshAvailabilityUI();
}

async function endDriverHoliday() {
    const { data, error } = await driverdb
        .from("driver_unavailability")
        .select("*")
        .eq("company_id", currentCompany.id)
        .eq("driver_id", currentDriver.id)
        .eq("active", true);

    if (error) return alert("Unable to end unavailable period.");

    const now = new Date().toISOString();

    for (const row of data || []) {
        await driverdb
            .from("driver_unavailability")
            .update({ active:false, to_datetime:now })
            .eq("id", row.id);
    }

    await refreshHolidayStatus();
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
    document.querySelectorAll(".driver-view").forEach(view => view.classList.remove("active"));
    document.getElementById(`view-${name}`)?.classList.add("active");
    if (name === "earnings") renderEarnings();
    if (name === "upcoming") renderUpcomingBookings();
    if (name === "holidays") refreshHolidayStatus();
    window.scrollTo({top:0, behavior:"instant"});
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
    return Number.isFinite(n) ? `£${n.toFixed(2)}` : "£0.00";
}

function normaliseStatus(status) {
    return String(status || "").trim().toLowerCase();
}

function prettyStatus(status) {
    const v = normaliseStatus(status);
    return {
        "on_way":"On Way",
        "on way":"On Way",
        "pob":"POB",
        "completed":"Completed",
        "waiting":"Waiting",
        "assigned":"Assigned",
        "pending":"Pending",
        "accepted":"Accepted",
        "declined":"Declined",
        "cancelled":"Cancelled"
    }[v] || status || "Waiting";
}

function formatTime(value) {
    return value ? String(value).slice(0,5) : "-";
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
        day:"2-digit",month:"2-digit",year:"numeric",
        hour:"2-digit",minute:"2-digit",hour12:false
    });
}

function compareJobs(a,b) {
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

function setText(id,value) {
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
