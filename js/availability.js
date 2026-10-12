const availabilityDb = getSupabase();

let availabilityCompanyId = null;
let availabilityDrivers = [];
let availabilityBookings = [];
let availabilityPeriods = [];
let availabilityBlocks = [];
let availabilityTimezone = "Europe/London";
let availabilitySettings = {};
let availabilityMonth = new Date();

const ACTIVE_JOB_STATUSES = ["assigned", "accepted", "on_way", "passenger_onboard"];
const BREAK_STATUSES = ["break", "on break", "on_break"];
const UNAVAILABLE_STATUSES = ["unavailable", "holiday", "off", "off duty", "off_duty"];

document.addEventListener("DOMContentLoaded", async () => {
    try {
        const context = await window.getAdminCompanyContext();
        availabilityCompanyId = context.companyId;
        document.getElementById("refreshAvailability")?.addEventListener("click", loadAvailability);
        bindBlockControls();
        await loadAvailability();
    } catch (error) {
        console.error("Availability startup error:", error);
        renderAvailabilityError("Unable to identify the admin company.");
    }
});

async function loadAvailability() {
    if (!availabilityCompanyId) return;

    const refreshButton = document.getElementById("refreshAvailability");
    if (refreshButton) refreshButton.disabled = true;
    setRowsMessage("Loading drivers…");

    const monthStart = new Date(availabilityMonth.getFullYear(), availabilityMonth.getMonth() - 1, 1).toISOString();
    const monthEnd = new Date(availabilityMonth.getFullYear(), availabilityMonth.getMonth() + 2, 1).toISOString();
    const [driversResult, bookingsResult, periodsResult, blocksResult, settingsResult] = await Promise.all([
        availabilityDb
            .from("drivers")
            .select("id,company_id,driver_number,full_name,vehicle,status,online,latitude,longitude,location_updated_at")
            .eq("company_id", availabilityCompanyId)
            .order("driver_number", { ascending: true })
            .order("full_name", { ascending: true }),
        availabilityDb
            .from("bookings")
            .select("id,company_id,driver_id,booking_reference,status,pickup_address,dropoff_address,journey_date,journey_time")
            .eq("company_id", availabilityCompanyId)
            .in("status", ACTIVE_JOB_STATUSES)
            .order("journey_date", { ascending: true })
            .order("journey_time", { ascending: true }),
        availabilityDb
            .from("driver_unavailability")
            .select("id,company_id,driver_id,from_datetime,to_datetime,reason,active")
            .eq("company_id", availabilityCompanyId)
            .eq("active", true),
        availabilityDb.from("availability_blocks").select("id,company_id,starts_at,ends_at,whole_day,reason,recurrence_frequency,recurrence_interval,recurrence_until,active,created_at,created_by,updated_at,updated_by")
            .eq("company_id", availabilityCompanyId).eq("active", true).or(`ends_at.gte.${monthStart},recurrence_frequency.not.is.null`).lte("starts_at", monthEnd).order("starts_at"),
        availabilityDb.from("settings").select("timezone,availability_mode,automatic_capacity_enforced,turnaround_buffer_minutes").eq("company_id", availabilityCompanyId).maybeSingle()
    ]);

    if (refreshButton) refreshButton.disabled = false;

    if (driversResult.error) {
        console.error("Availability driver load error:", driversResult.error);
        renderAvailabilityError(driversResult.error.message);
        return;
    }

    availabilityDrivers = driversResult.data || [];

    if (bookingsResult.error) {
        console.error("Availability booking load error:", bookingsResult.error);
        availabilityBookings = [];
    } else {
        availabilityBookings = bookingsResult.data || [];
    }

    if (periodsResult.error) {
        console.warn("Driver unavailability is not available:", periodsResult.error.message);
        availabilityPeriods = [];
    } else {
        availabilityPeriods = periodsResult.data || [];
    }
    availabilityBlocks = blocksResult.error ? [] : (blocksResult.data || []);
    if (blocksResult.error) console.error("Availability blocks:", blocksResult.error);
    availabilitySettings = settingsResult.error ? {} : (settingsResult.data || {});
    if (availabilitySettings.timezone) availabilityTimezone = availabilitySettings.timezone;
    const mode = document.getElementById("availabilityMode"); if (mode) mode.value = availabilitySettings.availability_mode || "manual";

    renderAvailability();
    renderBlocks();
}

function renderAvailability() {
    const rows = availabilityDrivers.map(driver => {
        const currentJob = findCurrentJob(driver.id);
        const state = driverState(driver, currentJob);
        return { driver, currentJob, state };
    });

    setText("availableCount", rows.filter(row => row.state.key === "available").length);
    setText("onJobCount", rows.filter(row => row.state.key === "on-job").length);
    setText("onBreakCount", rows.filter(row => row.state.key === "on-break").length);
    setText("offlineCount", rows.filter(row => row.state.key === "offline").length);
    setText("unavailableCount", rows.filter(row => row.state.key === "unavailable").length);

    const body = document.getElementById("availabilityRows");
    if (!body) return;

    if (!rows.length) {
        body.innerHTML = '<tr><td colspan="5">No drivers found for this company</td></tr>';
    } else {
        body.innerHTML = rows.map(({ driver, currentJob, state }) => `
            <tr>
                <td><strong>${escapeAvailabilityHtml(driver.full_name || "Unnamed driver")}</strong><br><small>${escapeAvailabilityHtml(driver.driver_number || "No driver number")}</small></td>
                <td>${escapeAvailabilityHtml(driver.vehicle || "—")}</td>
                <td><span class="availability-status ${state.key}"><span class="availability-dot"></span>${escapeAvailabilityHtml(state.label)}</span></td>
                <td>${currentJobHtml(currentJob)}</td>
                <td>${escapeAvailabilityHtml(formatLocationUpdated(driver.location_updated_at))}</td>
                <td><button type="button" data-driver-leave="${escapeAvailabilityHtml(driver.id)}">Add leave</button></td>
            </tr>
        `).join("");
    }

    setText("availabilityUpdated", `Last refreshed ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`);
    body.querySelectorAll("[data-driver-leave]").forEach(button => button.addEventListener("click", () => addDriverLeave(button.dataset.driverLeave)));
}

function bindBlockControls() {
    document.getElementById("addAvailabilityBlock")?.addEventListener("click", () => openBlockForm());
    document.getElementById("cancelAvailabilityBlock")?.addEventListener("click", closeBlockForm);
    document.getElementById("availabilityBlockForm")?.addEventListener("submit", saveBlock);
    document.getElementById("availabilityWholeDay")?.addEventListener("change", applyWholeDay);
    document.getElementById("availabilityListView")?.addEventListener("click", () => setBlockView("list"));
    document.getElementById("availabilityCalendarView")?.addEventListener("click", () => setBlockView("calendar"));
    document.getElementById("previousAvailabilityMonth")?.addEventListener("click", () => changeBlockMonth(-1));
    document.getElementById("nextAvailabilityMonth")?.addEventListener("click", () => changeBlockMonth(1));
    document.getElementById("availabilityMode")?.addEventListener("change", saveAvailabilityMode);
}

async function saveAvailabilityMode(event) {
    const mode=event.target.value;
    const {error}=await availabilityDb.from("settings").update({availability_mode:mode,automatic_capacity_enforced:false}).eq("company_id",availabilityCompanyId);
    if(error){event.target.value=availabilitySettings.availability_mode||"manual";alert(error.message);return;}
    availabilitySettings.availability_mode=mode;
    if(mode==="automatic") alert("Automatic capacity is in preview mode. Public rejection remains OFF until company data has been validated.");
}

async function changeBlockMonth(delta) {
    availabilityMonth = new Date(availabilityMonth.getFullYear(), availabilityMonth.getMonth() + delta, 1);
    await loadAvailability();
}

function setBlockView(view) {
    document.getElementById("availabilityBlockList").hidden = view !== "list";
    document.getElementById("availabilityBlockCalendar").hidden = view !== "calendar";
}

function renderBlocks() {
    setText("availabilityMonthTitle", availabilityMonth.toLocaleDateString("en-GB", { month: "long", year: "numeric" }));
    const list = document.getElementById("availabilityBlockList");
    if (list) {
        list.innerHTML = availabilityBlocks.length ? availabilityBlocks.map(block => `
            <article class="block-row"><div><span class="status-pill">Fully booked</span>
            <strong>${escapeAvailabilityHtml(blockLabel(block))}</strong>
            <div>${escapeAvailabilityHtml(block.reason || "No internal reason")}</div>
            <div class="block-meta">${block.recurrence_frequency ? `Repeats ${escapeAvailabilityHtml(block.recurrence_frequency)}${block.recurrence_until ? ` until ${escapeAvailabilityHtml(block.recurrence_until)}` : ""} · ` : ""}Updated ${escapeAvailabilityHtml(formatLocationUpdated(block.updated_at))}${block.updated_by ? ` by ${escapeAvailabilityHtml(block.updated_by)}` : ""}</div></div>
            <div class="block-actions"><button type="button" data-edit-block="${block.id}">Edit</button><button type="button" data-delete-block="${block.id}">Delete</button></div></article>`).join("") : "<p>No future fully booked periods in this range.</p>";
        list.querySelectorAll("[data-edit-block]").forEach(button => button.addEventListener("click", () => openBlockForm(availabilityBlocks.find(row => row.id === button.dataset.editBlock))));
        list.querySelectorAll("[data-delete-block]").forEach(button => button.addEventListener("click", () => deleteBlock(button.dataset.deleteBlock)));
    }
    renderBlockCalendar();
}

function renderBlockCalendar() {
    const grid = document.getElementById("availabilityBlockCalendar"); if (!grid) return;
    const first = new Date(availabilityMonth.getFullYear(), availabilityMonth.getMonth(), 1);
    const start = new Date(first); start.setDate(1 - ((first.getDay() + 6) % 7));
    let html = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map(day => `<div class="availability-calendar-head">${day}</div>`).join("");
    for (let i=0;i<42;i+=1) {
        const day = new Date(start); day.setDate(start.getDate()+i);
        const dayStart=day.getTime(), dayEnd=dayStart+86400000;
        const blocks=availabilityBlocks.filter(block => new Date(block.starts_at).getTime()<dayEnd && new Date(block.ends_at).getTime()>dayStart);
        html += `<div class="availability-calendar-day ${blocks.length ? "blocked" : ""}"><strong>${day.getDate()}</strong>${blocks.map(block => `<span title="${escapeAvailabilityHtml(block.reason || "Fully booked")}">Fully booked</span>`).join("<br>")}</div>`;
    }
    grid.innerHTML=html;
}

function blockLabel(block) {
    const options={timeZone:availabilityTimezone,dateStyle:"medium",timeStyle:"short"};
    if (block.whole_day) return new Date(block.starts_at).toLocaleDateString("en-GB",{timeZone:availabilityTimezone,dateStyle:"full"});
    return `${new Date(block.starts_at).toLocaleString("en-GB",options)} – ${new Date(block.ends_at).toLocaleString("en-GB",options)}`;
}

function openBlockForm(block=null) {
    const form=document.getElementById("availabilityBlockForm"); form.hidden=false;
    setText("availabilityFormTitle",block?"Edit Fully Booked period":"Add Fully Booked period");
    document.getElementById("availabilityBlockId").value=block?.id||"";
    document.getElementById("availabilityWholeDay").checked=Boolean(block?.whole_day);
    document.getElementById("availabilityStarts").value=block?toLocalInput(block.starts_at):defaultLocalInput(1);
    document.getElementById("availabilityEnds").value=block?toLocalInput(block.ends_at):defaultLocalInput(2);
    document.getElementById("availabilityRecurrence").value=block?.recurrence_frequency||"";
    document.getElementById("availabilityRecurrenceUntil").value=block?.recurrence_until||"";
    document.getElementById("availabilityReason").value=block?.reason||""; setText("availabilityFormError","");
    form.scrollIntoView({behavior:"smooth",block:"nearest"});
}
function closeBlockForm(){document.getElementById("availabilityBlockForm").hidden=true;}
function applyWholeDay(){if(!document.getElementById("availabilityWholeDay").checked)return; const start=document.getElementById("availabilityStarts"),end=document.getElementById("availabilityEnds"); const date=(start.value||defaultLocalInput(1)).slice(0,10); start.value=`${date}T00:00`; const next=new Date(`${date}T12:00`);next.setDate(next.getDate()+1);end.value=`${localDate(next)}T00:00`;}

async function saveBlock(event) {
    event.preventDefault(); const button=document.getElementById("saveAvailabilityBlock"); button.disabled=true; setText("availabilityFormError","");
    const id=document.getElementById("availabilityBlockId").value; const starts=document.getElementById("availabilityStarts").value; const ends=document.getElementById("availabilityEnds").value;
    if(!starts||!ends||new Date(ends)<=new Date(starts)){setText("availabilityFormError","End must be after start.");button.disabled=false;return;}
    const row={company_id:availabilityCompanyId,starts_at:zonedLocalToIso(starts,availabilityTimezone),ends_at:zonedLocalToIso(ends,availabilityTimezone),whole_day:document.getElementById("availabilityWholeDay").checked,reason:document.getElementById("availabilityReason").value.trim()||null,recurrence_frequency:document.getElementById("availabilityRecurrence").value||null,recurrence_interval:1,recurrence_until:document.getElementById("availabilityRecurrenceUntil").value||null,active:true};
    const result=id?await availabilityDb.from("availability_blocks").update(row).eq("company_id",availabilityCompanyId).eq("id",id):await availabilityDb.from("availability_blocks").insert(row);
    button.disabled=false; if(result.error){setText("availabilityFormError",result.error.message);return;} closeBlockForm();await loadAvailability();
}
async function deleteBlock(id){if(!confirm("Delete this future Fully Booked period? Existing bookings will not be changed."))return; const {error}=await availabilityDb.from("availability_blocks").update({active:false}).eq("company_id",availabilityCompanyId).eq("id",id);if(error)return alert(error.message);await loadAvailability();}

async function addDriverLeave(driverId) {
    const driver=availabilityDrivers.find(row=>String(row.id)===String(driverId)); const from=prompt(`Leave start for ${driver?.full_name||"driver"} (YYYY-MM-DD HH:MM)`); if(!from)return; const to=prompt("Leave end (YYYY-MM-DD HH:MM)");if(!to)return; const start=new Date(from.replace(" ","T")),end=new Date(to.replace(" ","T"));if(!Number.isFinite(start.getTime())||!Number.isFinite(end.getTime())||end<=start)return alert("Enter a valid end after the start.");
    const conflicts=availabilityBookings.filter(job=>String(job.driver_id)===String(driverId)&&new Date(`${job.journey_date}T${job.journey_time}`).getTime()>=start.getTime()&&new Date(`${job.journey_date}T${job.journey_time}`).getTime()<end.getTime());
    if(conflicts.length&&!confirm(`Warning: this conflicts with ${conflicts.length} assigned booking(s). Add leave for authorised review without cancelling or reassigning them?`))return;
    const reason=prompt("Reason (optional)",""); const {error}=await availabilityDb.from("driver_unavailability").insert({company_id:availabilityCompanyId,driver_id:driverId,from_datetime:start.toISOString(),to_datetime:end.toISOString(),reason:reason||null,active:true,request_status:"approved"});if(error)return alert(error.message);await loadAvailability();
}

function toLocalInput(value){const parts=new Intl.DateTimeFormat("en-CA",{timeZone:availabilityTimezone,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(new Date(value));const x=Object.fromEntries(parts.map(p=>[p.type,p.value]));return `${x.year}-${x.month}-${x.day}T${x.hour}:${x.minute}`;}
function defaultLocalInput(hours){const d=new Date(Date.now()+hours*3600000);d.setMinutes(Math.ceil(d.getMinutes()/15)*15,0,0);return toLocalInput(d.toISOString());}
function localDate(date){return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;}
function zonedLocalToIso(value,timeZone){const [date,time]=value.split("T"),[year,month,day]=date.split("-").map(Number),[hour,minute]=time.split(":").map(Number);const target=Date.UTC(year,month-1,day,hour,minute);let guess=target;for(let i=0;i<4;i+=1){const p=Object.fromEntries(new Intl.DateTimeFormat("en-GB",{timeZone,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(new Date(guess)).map(x=>[x.type,Number(x.value)]));guess+=target-Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute);}return new Date(guess).toISOString();}

function driverState(driver, currentJob) {
    const status = normaliseAvailabilityStatus(driver.status);

    if (isCurrentlyUnavailable(driver.id) || UNAVAILABLE_STATUSES.includes(status)) {
        return { key: "unavailable", label: "Unavailable / Holiday" };
    }

    if (currentJob || status === "on job" || status === "on_job") {
        return { key: "on-job", label: currentJob ? prettyAvailabilityStatus(currentJob.status) : "On Job" };
    }

    if (BREAK_STATUSES.includes(status)) {
        return { key: "on-break", label: "On Break" };
    }

    if (driver.online) {
        return { key: "available", label: "Available / Online" };
    }

    return { key: "offline", label: "Offline" };
}

function findCurrentJob(driverId) {
    return availabilityBookings.find(booking => String(booking.driver_id) === String(driverId)) || null;
}

function isCurrentlyUnavailable(driverId) {
    const now = Date.now();
    return availabilityPeriods.some(period => {
        if (String(period.driver_id) !== String(driverId) || period.active === false) return false;
        const from = new Date(period.from_datetime).getTime();
        const to = new Date(period.to_datetime).getTime();
        return Number.isFinite(from) && Number.isFinite(to) && from <= now && to >= now;
    });
}

function currentJobHtml(job) {
    if (!job) return "—";
    const reference = job.booking_reference || job.id;
    const route = [job.pickup_address, job.dropoff_address].filter(Boolean).join(" → ");
    return `<strong>${escapeAvailabilityHtml(reference)}</strong>${route ? `<br><small>${escapeAvailabilityHtml(route)}</small>` : ""}`;
}

function formatLocationUpdated(value) {
    if (!value) return "Never";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "Unknown";
    return date.toLocaleString([], { dateStyle: "short", timeStyle: "short" });
}

function prettyAvailabilityStatus(value) {
    const status = normaliseAvailabilityStatus(value);
    const labels = {
        assigned: "Assigned",
        accepted: "Accepted",
        on_way: "On Way",
        passenger_onboard: "Passenger Onboard"
    };
    return labels[status] || value || "On Job";
}

function normaliseAvailabilityStatus(value) {
    return String(value || "").trim().toLowerCase();
}

function setRowsMessage(message) {
    const body = document.getElementById("availabilityRows");
    if (body) body.innerHTML = `<tr><td colspan="6">${escapeAvailabilityHtml(message)}</td></tr>`;
}

function renderAvailabilityError(message) {
    setRowsMessage(`Unable to load driver availability: ${message}`);
    setText("availabilityUpdated", "Availability could not be loaded.");
}

function setText(id, value) {
    const element = document.getElementById(id);
    if (element) element.textContent = value;
}

function escapeAvailabilityHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}
