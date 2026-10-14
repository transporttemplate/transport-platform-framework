const driverdb = getSupabase();

let currentCompany = null;
let currentDriver = null;
let currentJob = null;
let selectedJob = null;
let driverBookings = [];
let driverUnavailable = false;
let driverCommissionDefault = 0;
let driverCurrencySymbol = "£";
let driverSessionToken = null;
let driverUnavailability = [];
let driverSettings = {};
let driverNavigationConfig = { enabled: false, browser_maps_key: null };
let serverClockOffset = 0;
let lastSuccessfulRefresh = null;
let refreshFailures = 0;
const pendingJobActions = new Set();
let paymentConfirmationResolver = null;

let gpsWatchId = null;
let driverRefreshTimer = null;
let driverStaleTimer = null;
let latestDriverPosition = null;
let navigationController = null;
let navigationMap = null;
let navigationMarker = null;
let navigationRouteLine = null;
let navigationFollowMode = true;
let navigationCameraHeading = null;
let navigationCameraChanging = false;
let navigationCameraFrame = null;
let navigationPendingCamera = null;
let navigationDistanceToTurn = Infinity;
let navigationGpsTimer = null;
let mapsLoaderPromise = null;
let mapsLoaderKey = null;
let driverAccountsSnapshot = null;

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
    document.getElementById("arrivedButton")?.addEventListener("click", setArrived);
    document.getElementById("pobButton")?.addEventListener("click", setPOB);
    document.getElementById("dropOffButton")?.addEventListener("click", completeCurrentJob);
    document.getElementById("markPaidButton")?.addEventListener("click", () => markJobPaid(currentJob));
    document.getElementById("detailMarkPaidButton")?.addEventListener("click", () => markJobPaid(selectedJob));
    document.getElementById("detailNavigateButton")?.addEventListener("click", () => selectedJob && navigateJob(selectedJob));
    document.getElementById("viewCurrentJobButton")?.addEventListener("click", () => currentJob && openJobDetails(currentJob));
    document.getElementById("navigateCurrentJobButton")?.addEventListener("click", () => currentJob && navigateJob(currentJob));
    document.getElementById("closeNavigationButton")?.addEventListener("click", () => navigationController?.stop());
    document.getElementById("navigationVoiceButton")?.addEventListener("click", () => navigationController?.setVoice(!navigationController.voiceEnabled));
    document.getElementById("navigationArrivedButton")?.addEventListener("click", setArrived);
    document.getElementById("navigationPobButton")?.addEventListener("click", setPOB);
    document.getElementById("navigationCompleteButton")?.addEventListener("click", completeCurrentJob);
    document.getElementById("navigationRecenterButton")?.addEventListener("click", resumeNavigationFollow);
    document.getElementById("navigationOverviewButton")?.addEventListener("click", showNavigationOverview);
    document.getElementById("closeJobDetailsButton")?.addEventListener("click", closeJobDetails);
    document.getElementById("jobDetailsOverlay")?.addEventListener("click", closeJobDetails);
    document.getElementById("holidayForm")?.addEventListener("submit", saveDriverHoliday);
    document.getElementById("imBackButton")?.addEventListener("click", endDriverHoliday);
    document.getElementById("refreshDiaryButton")?.addEventListener("click", () => refreshDriverPortal(true));
    document.getElementById("awaitingJobsList")?.addEventListener("click", handleDiaryAction);
    document.getElementById("acceptedJobsList")?.addEventListener("click", handleDiaryAction);
    document.getElementById("completedJobsList")?.addEventListener("click", handleDiaryAction);
    document.getElementById("paymentConfirmPaid")?.addEventListener("click", () => settlePaymentConfirmation("paid"));
    document.getElementById("paymentConfirmUnpaid")?.addEventListener("click", () => settlePaymentConfirmation("unpaid"));
    document.getElementById("paymentConfirmCancel")?.addEventListener("click", () => settlePaymentConfirmation("cancel"));
    document.getElementById("accountsRefresh")?.addEventListener("click", loadDriverAccounts);
    document.getElementById("accountsPeriod")?.addEventListener("change", applyAccountsPeriod);
    document.getElementById("expenseForm")?.addEventListener("submit", saveDriverExpense);
    document.getElementById("expenseFrequency")?.addEventListener("change", updateExpenseRecurrenceFields);
    document.getElementById("accountsExpenseList")?.addEventListener("click", handleExpenseAction);
    document.getElementById("accountsCsv")?.addEventListener("click", exportAccountsCsv);
    document.getElementById("accountsPdf")?.addEventListener("click", () => window.print());
    document.getElementById("driverMessageForm")?.addEventListener("submit", sendInternalDriverMessage);
    document.querySelector(".quick-replies")?.addEventListener("click", event => { const button=event.target.closest("button"); if(button){document.getElementById("driverMessageInput").value=button.textContent;document.getElementById("driverMessageInput").focus();} });
    document.getElementById("driverPreferencesForm")?.addEventListener("submit", savePreferences);
    window.addEventListener("online", () => { showConnectionMessage("Connection restored. Refreshing…", false); refreshDriverPortal(true); });
    window.addEventListener("offline", () => showConnectionMessage("You are offline. Displayed jobs may be out of date.", true));
    document.addEventListener("visibilitychange", () => { if (!document.hidden && driverSessionToken) { refreshDriverPortal(); if (navigationController?.active) navigationController.acquireWakeLock(); } });

    initialiseIntegratedNavigation();

    document.querySelectorAll("[data-view]").forEach(btn => {
        btn.addEventListener("click", () => {
            showDriverView(btn.dataset.view);
            if(btn.dataset.view==="messages") loadDriverMessages(true);
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
    if (driverStaleTimer) clearInterval(driverStaleTimer);
    driverStaleTimer = setInterval(updateLastUpdatedText, 5000);

    if (isDriverOnline(currentDriver) && !driverUnavailable) startGpsTracking();
}

async function driverLogout() {
    const reloadForMapIsolation = Boolean(mapsLoaderKey);
    navigationController?.stop();
    stopGpsTracking();
    if (driverRefreshTimer) clearInterval(driverRefreshTimer);
    if (driverStaleTimer) clearInterval(driverStaleTimer);

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
    if (reloadForMapIsolation) location.reload();
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
    driverSettings = data.settings || driverSettings;
    applyDriverPreferences(data.driver);
    renderUnreadMessages(Number(data.unread_messages||0));
    driverNavigationConfig = data.navigation || { enabled: data.settings?.driver_integrated_navigation === true, browser_maps_key: null };
    if (data.server_time) serverClockOffset = new Date(data.server_time).getTime() - Date.now();
    const now = new Date();
    driverUnavailable = driverUnavailability.some(row => row.active !== false && new Date(row.from_datetime) <= now && new Date(row.to_datetime) >= now);
    renderHolidayList(driverUnavailability);
    document.getElementById("imBackButton")?.classList.toggle("hidden", !driverUnavailable);
    document.getElementById("driverExpensesNav")?.classList.toggle("hidden", currentDriver?.driver_expenses_enabled !== true);
    document.getElementById("expensesShortcut")?.classList.toggle("hidden", currentDriver?.driver_expenses_enabled !== true);
    populateDriverHeader();
    applyCompanyBranding();
    if (navigationController?.active) {
        const updatedJob = driverBookings.find(job => String(job.id) === String(navigationController.job?.id));
        navigationController.authoritativeJob(updatedJob);
    }
}

async function refreshDriverPortal(showLoading = false) {
    if (!driverSessionToken) return;
    const refreshButton = document.getElementById("refreshDiaryButton");
    if (showLoading) refreshButton?.classList.add("loading");
    try {
        applyDriverPortalData(await driverPortalRequest("refresh"));
    } catch (error) {
        console.error("Driver refresh:", error);
        if (/session/i.test(error.message)) await driverLogout();
        refreshFailures += 1;
        showConnectionMessage("Unable to refresh. Showing the last successful diary.", true);
        return;
    } finally {
        refreshButton?.classList.remove("loading");
    }

    refreshFailures = 0;
    lastSuccessfulRefresh = new Date();
    showConnectionMessage("", false);
    renderCurrentJob();
    renderDiary();
    renderEarnings();
    refreshAvailabilityUI();
    updateLastUpdatedText();
}

function applyCompanyBranding() {
    const primary = safeColour(driverSettings.primarycolour);
    const button = safeColour(driverSettings.buttoncolour);
    if (primary) document.documentElement.style.setProperty("--brand", primary);
    if (button) document.documentElement.style.setProperty("--blue", button);
    const logo = String(driverSettings.companylogo || "").trim();
    const image = document.getElementById("loginCompanyLogo");
    if (image && /^https:\/\//i.test(logo)) { image.src = logo; image.classList.remove("hidden"); document.getElementById("loginFallbackIcon")?.classList.add("hidden"); }
}

function safeColour(value) { return /^#[0-9a-f]{6}$/i.test(String(value || "")) ? String(value) : ""; }

function showConnectionMessage(message, error) {
    const banner = document.getElementById("connectionBanner");
    if (!banner) return;
    banner.textContent = message;
    banner.classList.toggle("hidden", !message);
    banner.classList.toggle("error", Boolean(error));
}

function updateLastUpdatedText() {
    const text = lastSuccessfulRefresh ? `Updated ${lastSuccessfulRefresh.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}` : "Waiting for an update…";
    setText("lastUpdatedText", text);
    if (lastSuccessfulRefresh && Date.now() - lastSuccessfulRefresh.getTime() > 30000 && !refreshFailures) {
        showConnectionMessage("Updates appear delayed. Tap refresh before taking action.", true);
    }
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

    latestDriverPosition = { lat: update.latitude, lng: update.longitude, accuracy: Number(position.coords.accuracy || 0), heading: position.coords.heading == null ? null : Number(position.coords.heading), speed: position.coords.speed == null ? null : Number(position.coords.speed), timestamp: Number(position.timestamp || Date.now()) };
    navigationController?.update(latestDriverPosition);

    try { await driverPortalRequest("gps", {...update,accuracy:latestDriverPosition.accuracy,speed:latestDriverPosition.speed,booking_id:currentJob?.id||null}); Object.assign(currentDriver, update); }
    catch (error) { console.warn("Driver GPS update:", error); }
}

function renderCurrentJob() {
    const active = ["on_way", "arrived", "passenger_onboard"];

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
    setText("currentPassenger", currentJob.customer_name || "-");
    setText("currentPassengers", currentJob.passengers ?? "-");
    setText("currentFlight", currentJob.flight_number || "-");
    setText("currentFare", money(jobPrice(currentJob)));
    setText("currentPayment", `${currentJob.payment_method || "-"} — ${prettyStatus(currentJob.payment_status || "unpaid")}`);

    renderJobActions();
}

function renderJobActions() {
    if (!currentJob) return;

    const status = normaliseStatus(currentJob.status);
    const progress = document.getElementById("jobProgressActions");

    progress?.classList.remove("hidden");

    document.getElementById("arrivedButton")?.classList.toggle("hidden", status !== "on_way");
    document.getElementById("pobButton")?.classList.toggle("hidden", status !== "arrived");
    document.getElementById("dropOffButton")?.classList.toggle("hidden", status !== "passenger_onboard");
    document.getElementById("markPaidButton")?.classList.toggle("hidden", !canDriverMarkPaid(currentJob));
    const completing = pendingJobActions.has(`completion:${currentJob.id}`);
    for (const id of ["arrivedButton", "pobButton", "dropOffButton", "markPaidButton"]) {
        const button = document.getElementById(id);
        if (button) button.disabled = completing;
    }
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

async function setArrived() {
    if (!currentJob || !confirm("Confirm you have arrived and are waiting outside?")) return;
    await transitionJob(currentJob, "arrived");
}

async function setPOB() {
    if (await transitionJob(currentJob, "passenger_onboard")) {
        navigateJob(currentJob);
    }
}

async function completeCurrentJob() {
    const job = currentJob;
    if (!job || !canWork()) return;
    const actionKey = `completion:${job.id}`;
    if (pendingJobActions.has(actionKey) || pendingJobActions.has(String(job.id))) return;
    pendingJobActions.add(actionKey);
    renderJobActions();
    try {
        const summary = (await driverPortalRequest("completion_payment_status", { booking_id: job.id })).payment;
        if (!summary || summary.mode === "blocked") {
            alert(summary?.reason || "Payment state is unsupported or ambiguous. Contact the office before completing this job.");
            return;
        }
        let paymentConfirmation = null;
        if (summary.mode === "confirm_cash") {
            paymentConfirmation = await askPaymentConfirmation(summary);
            if (paymentConfirmation === "cancel") return;
        } else if (!confirm("Confirm this journey is completed?")) return;
        await driverPortalRequest("complete_job", { booking_id: job.id, payment_confirmation: paymentConfirmation });
        await refreshDriverPortal();
        navigationController?.stop("Journey completed.");
        currentJob = null;
    } catch (error) {
        alert(error.message || "Unable to complete this job.");
    } finally {
        pendingJobActions.delete(actionKey);
        closePaymentConfirmation();
        renderJobActions();
    }
}

function askPaymentConfirmation(summary) {
    if (paymentConfirmationResolver) return Promise.resolve("cancel");
    setText("paymentConfirmReference", summary.booking_reference || "-");
    setText("paymentConfirmFare", money(summary.fare));
    setText("paymentConfirmPaidAmount", money(summary.amount_paid));
    setText("paymentConfirmOutstanding", money(summary.outstanding));
    setText("paymentConfirmMethod", summary.payment_method || "Unknown");
    const modal = document.getElementById("paymentConfirmationModal");
    modal?.classList.remove("hidden");
    document.body.classList.add("payment-confirmation-open");
    for (const id of ["paymentConfirmPaid", "paymentConfirmUnpaid", "paymentConfirmCancel"]) {
        const button = document.getElementById(id); if (button) button.disabled = false;
    }
    document.getElementById("paymentConfirmPaid")?.focus();
    return new Promise(resolve => { paymentConfirmationResolver = resolve; });
}

function settlePaymentConfirmation(choice) {
    if (!paymentConfirmationResolver) return;
    const resolve = paymentConfirmationResolver;
    paymentConfirmationResolver = null;
    for (const id of ["paymentConfirmPaid", "paymentConfirmUnpaid", "paymentConfirmCancel"]) {
        const button = document.getElementById(id); if (button) button.disabled = true;
    }
    closePaymentConfirmation();
    resolve(choice);
}

function closePaymentConfirmation() {
    document.getElementById("paymentConfirmationModal")?.classList.add("hidden");
    document.body.classList.remove("payment-confirmation-open");
}

async function transitionJob(job, status) {
    if (!job || pendingJobActions.has(String(job.id))) return false;
    if (["on_way", "arrived", "passenger_onboard"].includes(status) && !canWork()) return false;
    if (status === "declined" && !confirm(`Decline ${job.booking_reference || "this job"}? It will return to the office for reallocation.`)) return false;
    if (status === "passenger_onboard" && !confirm("Confirm the passengers are on board?")) return false;
    pendingJobActions.add(String(job.id));
    renderDiary();
    try {
        const data = await driverPortalRequest("job_status", { booking_id: job.id, status });
        if (data.server_time) serverClockOffset = new Date(data.server_time).getTime() - Date.now();
        await refreshDriverPortal();
        return true;
    } catch (error) {
        alert(error.message || "Unable to update this job.");
        return false;
    } finally {
        pendingJobActions.delete(String(job.id));
        renderDiary();
    }
}

function canDriverMarkPaid(job) {
    return Boolean(window.DriverWorkflow?.canMarkCashPaid(job));
}

async function markJobPaid(job) {
    if (!job || !canDriverMarkPaid(job)) return;
    const actionKey = `payment:${job.id}`;
    if (pendingJobActions.has(actionKey)) return;
    const amount = Number(job.cash_collection_amount);
    const prompt = Number.isFinite(amount)
        ? `Confirm ${money(amount)} has been received from the customer?`
        : "Confirm the full cash fare has been received from the customer?";
    if (!confirm(prompt)) return;
    pendingJobActions.add(actionKey);
    try {
        await driverPortalRequest("mark_cash_paid", { booking_id: job.id });
        await refreshDriverPortal();
        const authoritativeJob = driverBookings.find(row => String(row.id) === String(job.id)) || job;
        Object.assign(job, authoritativeJob);
        if (selectedJob && String(selectedJob.id) === String(job.id)) selectedJob = authoritativeJob;
        setText("detailPayment", "Paid");
        if (currentJob && String(currentJob.id) === String(job.id)) setText("currentPayment", "Paid");
        renderJobActions();
        document.getElementById("detailMarkPaidButton")?.classList.add("hidden");
    } catch (error) {
        alert(error.message || "Unable to mark this booking paid.");
    } finally {
        pendingJobActions.delete(actionKey);
    }
}

function openNavigation(address) {
    if (!address || address === "-") return alert("No address saved for this job.");

    window.location.href =
        "https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=" +
        encodeURIComponent(address);
}

function openJobRoute(job) {
    const url = window.DriverNavigation.externalMapsUrl(job);
    if (!url) return alert("No address saved for this job.");
    window.location.href = url;
}

async function navigateJob(job) {
    if (!driverNavigationConfig.enabled) return openJobRoute(job);
    if (!window.DriverNavigation.canNavigate(job)) return alert("This job is not currently available for navigation.");
    try {
        closeJobDetails();
        const position = await currentNavigationPosition();
        if (navigationController?.active) await navigationController.authoritativeJob(job);
        else await navigationController.start(job, position);
    } catch (error) {
        console.warn("Integrated navigation:", error);
        alert(`${error.message || "Unable to start integrated navigation."} You can still use Google Maps.`);
    }
}

function initialiseIntegratedNavigation() {
    if (!window.DriverNavigation?.Controller) return;
    navigationController = new window.DriverNavigation.Controller({
        routeRequest: (job, position, reason, progress) => driverPortalRequest("navigation_route", { booking_id: job.id, latitude: position.lat, longitude: position.lng, accuracy: position.accuracy, completed_stop_count: progress?.completedStops || 0, reason }),
        onStart: (job, externalUrl) => {
            navigationFollowMode = true; navigationCameraHeading = null; navigationDistanceToTurn = Infinity;
            document.body.classList.add("driver-navigation-active");
            document.getElementById("driverNavigationView")?.classList.remove("hidden");
            updateNavigationJob(job, externalUrl);
            setNavigationStatus("Loading live map…", false);
            loadNavigationMap().catch(error => {
                console.warn("Navigation map:", error);
                document.getElementById("driverNavigationMap")?.classList.add("hidden");
                document.getElementById("navigationMapFallback")?.classList.remove("hidden");
                setNavigationStatus("Live map unavailable. Written route remains active.", true);
            });
            clearInterval(navigationGpsTimer);
            navigationGpsTimer = setInterval(checkNavigationGpsFreshness, 5000);
        },
        onRoute: (route, path, steps) => {
            drawNavigationRoute(path);
            renderNavigationSteps(steps, 0);
            setText("navigationDistance", window.DriverNavigation.formatDistance(route.distance_meters));
            setText("navigationDuration", window.DriverNavigation.formatDuration(route.duration_seconds));
        },
        onPosition: updateNavigationMarker,
        onProgress: progress => {
            setText("navigationCurrentInstruction", progress.current?.instruction || "Continue on the route");
            setText("navigationNextInstruction", progress.next ? `Then: ${progress.next.instruction}` : "Continue to your destination");
            setText("navigationManeuver", maneuverSymbol(progress.current?.maneuver));
            setText("navigationDistance", window.DriverNavigation.formatDistance(progress.metrics.metres));
            setText("navigationDuration", window.DriverNavigation.formatDuration(progress.metrics.seconds));
            setText("navigationEta", progress.eta.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }));
            navigationDistanceToTurn = progress.current?.end_location && latestDriverPosition
                ? window.DriverNavigation.metresBetween(latestDriverPosition, progress.current.end_location)
                : Infinity;
            renderNavigationSteps(navigationController.steps, progress.index);
        },
        onStatus: setNavigationStatus,
        onVoice: enabled => {
            const button = document.getElementById("navigationVoiceButton");
            if (!button) return;
            button.textContent = enabled ? "🔊" : "🔇";
            button.classList.toggle("voice-off", !enabled);
            button.setAttribute("aria-pressed", String(enabled));
            button.setAttribute("aria-label", enabled ? "Turn spoken directions off" : "Turn spoken directions on");
        },
        onJob: updateNavigationJob,
        onStop: message => {
            clearInterval(navigationGpsTimer); navigationGpsTimer = null;
            document.body.classList.remove("driver-navigation-active");
            document.getElementById("driverNavigationView")?.classList.add("hidden");
            if (message) showConnectionMessage(message, false);
        }
    });
}

async function currentNavigationPosition() {
    if (latestDriverPosition && Date.now() - latestDriverPosition.timestamp < 60000) return latestDriverPosition;
    const savedLat = Number(currentDriver?.latitude), savedLng = Number(currentDriver?.longitude);
    const savedAt = Date.parse(String(currentDriver?.location_updated_at || ""));
    if (Number.isFinite(savedLat) && Number.isFinite(savedLng) && Date.now() - savedAt < 60000) return { lat: savedLat, lng: savedLng, accuracy: 100, timestamp: savedAt };
    if (!navigator.geolocation) throw new Error("Location is not supported on this device.");
    setNavigationStatus("Waiting for an accurate GPS position…", false);
    return await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(position => {
        latestDriverPosition = { lat: position.coords.latitude, lng: position.coords.longitude, accuracy: position.coords.accuracy, heading: position.coords.heading == null ? null : Number(position.coords.heading), speed: position.coords.speed == null ? null : Number(position.coords.speed), timestamp: position.timestamp || Date.now() };
        resolve(latestDriverPosition);
    }, error => reject(new Error(error.code === 1 ? "Location permission is required for integrated navigation." : "A current GPS position could not be obtained.")), { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }));
}

async function loadNavigationMap() {
    const key = String(driverNavigationConfig.browser_maps_key || "").trim();
    if (!key) throw new Error("The company browser Maps key is not configured.");
    if (mapsLoaderKey && mapsLoaderKey !== key) throw new Error("Reload the Driver Portal before switching company navigation.");
    mapsLoaderKey = key;
    if (!mapsLoaderPromise) mapsLoaderPromise = new Promise((resolve, reject) => {
        if (window.google?.maps) return resolve(window.google.maps);
        const callback = `driverMapsReady_${Date.now()}`;
        window[callback] = () => { delete window[callback]; resolve(window.google.maps); };
        const script = document.createElement("script");
        script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&callback=${callback}&v=weekly`;
        script.async = true; script.onerror = () => { delete window[callback]; mapsLoaderPromise = null; reject(new Error("Google Maps could not be loaded.")); };
        document.head.appendChild(script);
    });
    const maps = await mapsLoaderPromise;
    document.getElementById("driverNavigationMap")?.classList.remove("hidden");
    document.getElementById("navigationMapFallback")?.classList.add("hidden");
    if (!navigationMap) {
        navigationMap = new maps.Map(document.getElementById("driverNavigationMap"), { center: latestDriverPosition || { lat: 51.5, lng: -3.2 }, zoom: 18, heading: 0, tilt: 45, disableDefaultUI: true, zoomControl: true, gestureHandling: "greedy", clickableIcons: false, keyboardShortcuts: false, backgroundColor: "#0b1220", styles: navigationDarkMapStyles() });
        navigationMap.addListener("dragstart", pauseNavigationFollow);
        navigationMap.addListener("zoom_changed", () => { if (!navigationCameraChanging) pauseNavigationFollow(); });
    }
    updateNavigationMarker(latestDriverPosition);
    if (navigationController?.routePath?.length) drawNavigationRoute(navigationController.routePath);
    return navigationMap;
}

function drawNavigationRoute(path) {
    if (!navigationMap || !window.google?.maps || !path?.length) return;
    if (!navigationRouteLine) navigationRouteLine = new google.maps.Polyline({ path, map: navigationMap, strokeColor: "#38bdf8", strokeOpacity: 0.95, strokeWeight: 7 });
    else navigationRouteLine.setPath(path);
    updateNavigationCamera(latestDriverPosition);
}

function updateNavigationMarker(position) {
    if (!position || !navigationMap || !window.google?.maps) return;
    const point = { lat: Number(position.lat), lng: Number(position.lng) };
    if (!navigationMarker) navigationMarker = new google.maps.Marker({ map: navigationMap, position: point, title: "Your location", zIndex: 10, icon: { path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW, scale: 6, fillColor: "#0f172a", fillOpacity: 1, strokeColor: "#fff", strokeWeight: 2, rotation: Number.isFinite(position.heading) ? position.heading : 0 } });
    else { navigationMarker.setPosition(point); const icon = navigationMarker.getIcon(); if (icon && Number.isFinite(position.heading)) navigationMarker.setIcon({ ...icon, rotation: position.heading }); }
    updateNavigationCamera(position);
}

function pauseNavigationFollow() {
    if (!navigationController?.active) return;
    navigationFollowMode = false;
    document.getElementById("navigationRecenterButton")?.classList.remove("following");
}

function resumeNavigationFollow() {
    navigationFollowMode = true;
    document.getElementById("navigationRecenterButton")?.classList.add("following");
    updateNavigationCamera(latestDriverPosition, true);
}

function updateNavigationCamera(position, force = false) {
    if (!navigationMap || !position || (!navigationFollowMode && !force)) return;
    if (Number(position.accuracy) > 150) return;
    navigationPendingCamera = { position, force };
    if (navigationCameraFrame) return;
    navigationCameraFrame = requestAnimationFrame(() => {
        navigationCameraFrame = null;
        const pending = navigationPendingCamera; navigationPendingCamera = null;
        if (!pending || (!navigationFollowMode && !pending.force)) return;
        const point = pending.position;
        navigationCameraHeading = window.DriverNavigation.smoothHeading(navigationCameraHeading, point.heading, point.speed);
        const zoom = window.DriverNavigation.navigationZoom(point.speed, navigationDistanceToTurn, point.accuracy);
        navigationCameraChanging = true;
        const camera = { center: { lat: Number(point.lat), lng: Number(point.lng) }, zoom };
        if (navigationCameraHeading !== null) camera.heading = navigationCameraHeading;
        if (typeof navigationMap.moveCamera === "function") navigationMap.moveCamera({ ...camera, tilt: navigationCameraHeading === null ? 0 : 45 });
        else { navigationMap.panTo(camera.center); navigationMap.setZoom(zoom); if (navigationCameraHeading !== null) navigationMap.setHeading?.(navigationCameraHeading); }
        google.maps.event.addListenerOnce(navigationMap, "idle", () => { navigationCameraChanging = false; });
    });
}

function navigationDarkMapStyles() {
    return [
        { elementType: "geometry", stylers: [{ color: "#172033" }] },
        { elementType: "labels.text.stroke", stylers: [{ color: "#172033" }] },
        { elementType: "labels.text.fill", stylers: [{ color: "#a8b3c7" }] },
        { featureType: "road", elementType: "geometry", stylers: [{ color: "#2a3548" }] },
        { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#3a465b" }] },
        { featureType: "water", elementType: "geometry", stylers: [{ color: "#09111f" }] },
        { featureType: "poi", stylers: [{ visibility: "off" }] },
        { featureType: "transit", stylers: [{ visibility: "off" }] }
    ];
}

function showNavigationOverview() {
    if (!navigationMap || !window.google?.maps || !navigationController?.routePath?.length) return;
    pauseNavigationFollow(); navigationCameraChanging = true;
    const bounds = new google.maps.LatLngBounds(); navigationController.routePath.forEach(point => bounds.extend(point)); if (latestDriverPosition) bounds.extend(latestDriverPosition);
    navigationMap.setHeading?.(0); navigationMap.setTilt?.(0); navigationMap.fitBounds(bounds, 48);
    google.maps.event.addListenerOnce(navigationMap, "idle", () => { navigationCameraChanging = false; });
}

function checkNavigationGpsFreshness() {
    if (!navigationController?.active) return;
    if (window.DriverNavigation.gpsIsStale(latestDriverPosition)) setNavigationStatus("GPS signal lost · holding the last known route", true);
}

function updateNavigationJob(job, externalUrl) {
    const target = window.DriverNavigation.navigationTarget(job);
    setText("navigationTargetLabel", target === "pickup" ? "Navigating to pickup" : "Navigating to destination");
    setText("navigationDestination", target === "pickup" ? pickup(job) : destination(job));
    setText("navigationPassenger", job.customer_name || job.passenger_name || "Passenger");
    setText("navigationReference", job.booking_reference || shortId(job.id));
    setText("navigationPassengerCount", job.passengers ?? "-");
    setText("navigationLuggage", `${job.suitcases ?? 0} cases · ${job.hand_luggage ?? 0} hand`);
    setText("navigationFlight", job.flight_number || "-");
    setText("navigationNotes", job.notes || "");
    const phone = String(job.phone || job.customer_phone || "").trim();
    const phoneLink = document.getElementById("navigationPassengerPhone"); if (phoneLink) { phoneLink.textContent = phone || "-"; phoneLink.href = phone ? `tel:${phone.replace(/\s+/g, "")}` : "#"; }
    const external = document.getElementById("navigationExternalButton"); if (external) external.href = externalUrl || window.DriverNavigation.externalMapsUrl(job) || "#";
    const status = normaliseStatus(job.status);
    document.getElementById("navigationArrivedButton")?.classList.toggle("hidden", status !== "on_way");
    document.getElementById("navigationPobButton")?.classList.toggle("hidden", status !== "arrived");
    document.getElementById("navigationCompleteButton")?.classList.toggle("hidden", status !== "passenger_onboard");
}

function renderNavigationSteps(steps, activeIndex) {
    const list = document.getElementById("navigationSteps"); if (!list) return;
    list.innerHTML = (steps || []).map((step, index) => `<li class="${index === activeIndex ? "active" : ""}">${escapeHtml(step.instruction || "Continue")} · ${escapeHtml(window.DriverNavigation.formatDistance(step.distance_meters || 0))}</li>`).join("") || "<li>Directions are loading…</li>";
}
function setNavigationStatus(message, error) { const element = document.getElementById("navigationStatus"); if (!element) return; element.textContent = message; element.classList.toggle("error", Boolean(error)); }
function maneuverSymbol(value) { const name = String(value || "").toUpperCase(); if (name.includes("LEFT")) return "↰"; if (name.includes("RIGHT")) return "↱"; if (name.includes("UTURN")) return "↶"; if (name.includes("ROUNDABOUT")) return "⟳"; if (name.includes("MERGE")) return "⤴"; return "↑"; }

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
    setText("detailVehicle", vehicleTierLabel(job.vehicle_tier || job.vehicle_type));
    setText("detailSuitcases", job.suitcases ?? "-");
    setText("detailHandLuggage", job.hand_luggage ?? "-");
    setText("detailFlightNumber", job.flight_number || "-");
    setText("detailFare", money(jobPrice(job)));
    setText("detailPayment", `${job.payment_method || "-"} — ${prettyStatus(job.payment_status || "unpaid")}`);
    selectedJob = job;
    document.getElementById("detailMarkPaidButton")?.classList.toggle("hidden", !canDriverMarkPaid(job));
    setText("detailStatus", prettyStatus(job.status));
    setText("detailActivation", normaliseStatus(job.status) === "accepted" ? activationLabel(job) : "—");
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
    selectedJob = null;
}

function renderDiary() {
    const diary = window.DriverWorkflow.classifyJobs(driverBookings);
    setText("awaitingCount", diary.awaiting.length);
    setText("acceptedCount", diary.accepted.length);
    renderDiaryList("awaitingJobsList", diary.awaiting, "awaiting");
    renderDiaryList("acceptedJobsList", diary.accepted, "accepted");
    renderDiaryList("completedJobsList", diary.completed.slice().reverse(), "completed");
}

function renderDiaryList(id, jobs, kind) {
    const list = document.getElementById(id);
    if (!list) return;
    if (!jobs.length) {
        const labels = { awaiting: "No jobs awaiting your response.", accepted: "No accepted upcoming jobs.", completed: "No completed jobs yet." };
        list.innerHTML = `<div class="empty-list">${labels[kind]}</div>`;
        return;
    }
    if (kind === "accepted") {
        const groups = groupJobsByDate(jobs);
        list.innerHTML = Object.entries(groups).map(([label, rows]) => `<div class="date-group"><h3>${escapeHtml(label)}</h3>${rows.map(row => diaryCard(row, kind)).join("")}</div>`).join("");
    } else list.innerHTML = jobs.map(row => diaryCard(row, kind)).join("");
}

function diaryCard(job, kind) {
    const busy = pendingJobActions.has(String(job.id));
    const decline = kind === "awaiting" && window.DriverWorkflow.canDecline(driverSettings, job);
    const startReady = kind === "accepted" && window.DriverWorkflow.canStart(job, trustedNow(), driverSettings.timezone || "Europe/London");
    const payment = driverPaymentLabel(job);
    return `<article class="diary-card ${busy ? "busy" : ""}">
        <div class="diary-card-top"><div><time>${escapeHtml(formatTime(job.journey_time))}</time><span>${escapeHtml(formatDate(job.journey_date))}</span></div><span class="status-pill status-${escapeHtml(normaliseStatus(job.status))}">${escapeHtml(prettyStatus(job.status))}</span></div>
        <strong class="booking-reference">${escapeHtml(job.booking_reference || shortId(job.id))}</strong>
        <div class="compact-route"><span><b>A</b>${escapeHtml(pickup(job))}</span><span><b>B</b>${escapeHtml(destination(job))}</span></div>
        <div class="job-meta"><span>${escapeHtml(String(job.passengers ?? "—"))} passengers</span>${job.driver_amount==null?"":`<span>${escapeHtml(money(jobPrice(job)))} earnings</span>`}<span class="driver-payment ${escapeHtml(driverPaymentKind(job))}">${escapeHtml(payment)}</span></div>
        ${kind === "accepted" ? `<p class="activation-note ${startReady ? "ready" : ""}">${escapeHtml(startReady ? "Ready to start" : activationLabel(job))}</p>` : ""}
        <div class="card-actions">
          ${kind === "awaiting" ? `<button class="btn btn-success" data-job-action="accepted" data-job-id="${escapeHtml(job.id)}" ${busy ? "disabled" : ""}>${busy ? "Working…" : "Accept"}</button>` : ""}
          ${decline ? `<button class="btn btn-danger" data-job-action="declined" data-job-id="${escapeHtml(job.id)}" ${busy ? "disabled" : ""}>Decline</button>` : ""}
          ${kind === "accepted" ? `<button class="btn btn-primary" data-job-action="on_way" data-job-id="${escapeHtml(job.id)}" ${busy || !startReady ? "disabled" : ""}>On Route</button>` : ""}
          <button class="btn btn-secondary" data-job-action="details" data-job-id="${escapeHtml(job.id)}">View Details</button>
        </div>
    </article>`;
}
function driverPaymentKind(job){const method=normaliseStatus(job?.payment_method),status=normaliseStatus(job?.payment_status),paid=Number(job?.amount_paid||0),balance=Number(job?.balance_due||0);if(job?.account_customer_id||["account","invoice","account_invoice"].includes(method))return "account";if(status==="paid"||["stripe","card","prepaid"].includes(method)&&balance<=0)return "paid";if(status==="part_paid"||status==="partially_paid"||paid>0&&balance>0)return "partial";return "unpaid";}
function driverPaymentLabel(job){return {account:"ACCOUNT / INVOICE",paid:"PAID / PREPAID",partial:"PART PAID",unpaid:"UNPAID"}[driverPaymentKind(job)];}

function handleDiaryAction(event) {
    const button = event.target.closest("[data-job-action]");
    if (!button) return;
    const job = driverBookings.find(row => String(row.id) === String(button.dataset.jobId));
    if (!job) return;
    if (button.dataset.jobAction === "details") openJobDetails(job);
    else transitionJob(job, button.dataset.jobAction).then(ok => { if (ok && button.dataset.jobAction === "on_way") navigateJob(driverBookings.find(row => String(row.id) === String(job.id)) || job); });
}

function trustedNow() { return new Date(Date.now() + serverClockOffset); }

function activationLabel(job) {
    const date = window.DriverWorkflow.activationAt(job, driverSettings.timezone || "Europe/London");
    return date && !Number.isNaN(date.getTime()) ? `Available ${date.toLocaleString("en-GB", { timeZone: driverSettings.timezone || "Europe/London", weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}` : "Activation time unavailable";
}

function groupJobsByDate(jobs) {
    const now = trustedNow();
    const formatter = new Intl.DateTimeFormat("en-GB", { timeZone: driverSettings.timezone || "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" });
    const dateKey = value => {
        const parts = Object.fromEntries(formatter.formatToParts(value).map(part => [part.type, part.value]));
        return `${parts.year}-${parts.month}-${parts.day}`;
    };
    const today = dateKey(now), tomorrowDate = new Date(now.getTime() + 86400000), tomorrow = dateKey(tomorrowDate);
    return jobs.reduce((groups, job) => {
        const label = job.journey_date === today ? "Today" : job.journey_date === tomorrow ? "Tomorrow" : "Later";
        (groups[label] ||= []).push(job); return groups;
    }, {});
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
        <button type="button" class="earning-row" data-completed-job="${escapeHtml(String(job.id))}">
            <div>
                <strong>${escapeHtml(formatDate(job.journey_date))} • ${escapeHtml(formatTime(job.journey_time))}</strong>
                <span>${escapeHtml(destination(job))}</span>
            </div>
            <strong>${escapeHtml(money(driverEarning(job)))}</strong>
        </button>
    `).join("");
    list.querySelectorAll("[data-completed-job]").forEach(button => button.addEventListener("click", () => {
        const job = driverBookings.find(item => String(item.id) === String(button.dataset.completedJob));
        if (job) openJobDetails(job);
    }));
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
    if (name === "completed") renderDiary();
    if (name === "holidays") refreshHolidayStatus();
    if (name === "accounts" && currentDriver?.driver_expenses_enabled === true) loadDriverAccounts();

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
    return addressWithDetail(job?.pickup_name, job?.pickup_address ?? job?.pickup);
}

function destination(job) {
    return addressWithDetail(job?.dropoff_name, job?.dropoff_address ?? job?.destination ?? job?.dropoff);
}

function addressWithDetail(detail, address) {
    return [detail, address].map(value => String(value || "").trim()).filter(Boolean).join(", ") || "-";
}

function jobPrice(job) {
    const driverAmount = Number(job?.driver_amount);
    const p = Number(job?.price);
    const jp = Number(job?.job_price);
    if (job?.driver_amount != null && Number.isFinite(driverAmount) && driverAmount >= 0) return driverAmount;
    if (Number.isFinite(p) && p > 0) return p;
    if (Number.isFinite(jp) && jp > 0) return jp;
    return 0;
}

function defaultAccountsRange() {
    const now = new Date(), from = new Date(now.getFullYear(), now.getMonth(), 1);
    const iso = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    const fromInput = document.getElementById("accountsFrom"), toInput = document.getElementById("accountsTo");
    if (fromInput && !fromInput.value) fromInput.value = iso(from);
    if (toInput && !toInput.value) toInput.value = iso(now);
    const expenseDate = document.getElementById("expenseDate"); if (expenseDate && !expenseDate.value) expenseDate.value = iso(now);
}
function updateExpenseRecurrenceFields() {
    const recurring = document.getElementById("expenseFrequency")?.value !== "one_off";
    const wrap = document.getElementById("expenseEndDateWrap");
    wrap?.classList.toggle("hidden", !recurring);
    if (!recurring) { const input = document.getElementById("expenseEndDate"); if (input) input.value = ""; }
}
function setExpenseFormMessage(message, isError = false) {
    const el = document.getElementById("expenseFormMessage"); if (!el) return;
    el.textContent = message; el.classList.toggle("hidden", !message); el.classList.toggle("error", isError); el.classList.toggle("success", !isError && Boolean(message));
}
function applyAccountsPeriod() {
    const period=document.getElementById("accountsPeriod")?.value,now=new Date(),year=now.getFullYear();let from,to;
    if(period==="personal_tax_year"){const startYear=now>=new Date(year,3,6)?year:year-1;from=new Date(startYear,3,6);to=new Date(startYear+1,3,5);}
    else if(period==="business_year"){const startYear=now>=new Date(year,3,1)?year:year-1;from=new Date(startYear,3,1);to=new Date(startYear+1,2,31);}
    else if(period==="month"){from=new Date(year,now.getMonth(),1);to=new Date(year,now.getMonth()+1,0);}else return;
    const iso=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;document.getElementById("accountsFrom").value=iso(from);document.getElementById("accountsTo").value=iso(to);loadDriverAccounts();
}
async function loadDriverAccounts() {
    if (currentDriver?.driver_expenses_enabled !== true) return;
    defaultAccountsRange();
    try {
        driverAccountsSnapshot = await driverPortalRequest("accounts_snapshot", { from: document.getElementById("accountsFrom")?.value, to: document.getElementById("accountsTo")?.value });
        const summary = driverAccountsSnapshot.summary || {};
        setText("accountsEarnings", money(summary.total_earnings)); setText("accountsExpenses", money(summary.total_expenses)); setText("accountsProfit", money(summary.estimated_profit)); setText("accountsOutstanding", money(summary.outstanding_earnings));
        setText("accountsDisclaimer", driverAccountsSnapshot.disclaimer || "Management records only.");
        const expenses = document.getElementById("accountsExpenseList");
        expenses.innerHTML = (driverAccountsSnapshot.expenses || []).map(row => `<article class="account-row"><div><strong>${escapeHtml(prettyStatus(row.category))}</strong><span>${escapeHtml(row.expense_date)} · ${escapeHtml(row.description)}</span><small>${escapeHtml(row.accounting_treatment)} · ${escapeHtml(String(row.business_use_percent))}% business use</small></div><div><strong>${escapeHtml(money(row.amount))}</strong><button data-edit-expense="${escapeHtml(row.id)}" type="button">Edit</button><button data-delete-expense="${escapeHtml(row.id)}" type="button">${row.rule_id?"Skip":"Delete"}</button></div></article>`).join("") || '<div class="empty-list">No expenses in this period.</div>';
        const income = document.getElementById("accountsIncomeList");
        income.innerHTML = (driverAccountsSnapshot.jobs || []).map(row => `<article class="account-row"><div><strong>${escapeHtml(row.booking_reference || "Job")}</strong><span>${escapeHtml(row.journey_date)} · ${escapeHtml(prettyStatus(row.payment_status))}</span></div><strong>${row.driver_earnings == null ? "Not authorised" : escapeHtml(money(row.driver_earnings))}</strong></article>`).join("") || '<div class="empty-list">No completed-job earnings in this period.</div>';
        renderAccountsBreakdowns(driverAccountsSnapshot);
    } catch (error) { alert(error.message || "Unable to load Driver Accounts."); }
}
function renderAccountsBreakdowns(snapshot){const monthly={},categories={};(snapshot.jobs||[]).forEach(x=>{const key=String(x.journey_date||"").slice(0,7);(monthly[key]||={earnings:0,expenses:0}).earnings+=Number(x.driver_earnings||0);});(snapshot.expenses||[]).forEach(x=>{const key=String(x.expense_date||"").slice(0,7),amount=Number(x.amount||0)*Number(x.business_use_percent||0)/100;(monthly[key]||={earnings:0,expenses:0}).expenses+=amount;categories[x.category]=(categories[x.category]||0)+amount;});document.getElementById("accountsMonthlyList").innerHTML=Object.entries(monthly).sort().reverse().map(([key,x])=>`<div class="account-row"><strong>${escapeHtml(key)}</strong><span>${escapeHtml(money(x.earnings))} earnings · ${escapeHtml(money(x.expenses))} expenses · ${escapeHtml(money(x.earnings-x.expenses))} estimated profit</span></div>`).join("")||'<div class="empty-list">No monthly figures.</div>';document.getElementById("accountsCategoryList").innerHTML=Object.entries(categories).sort((a,b)=>b[1]-a[1]).map(([key,value])=>`<div class="account-row"><strong>${escapeHtml(prettyStatus(key))}</strong><strong>${escapeHtml(money(value))}</strong></div>`).join("")||'<div class="empty-list">No expense categories.</div>';}
async function saveDriverExpense(event) {
    event.preventDefault();
    setExpenseFormMessage("");
    if (!event.target.checkValidity()) { event.target.reportValidity(); setExpenseFormMessage("Please complete the required expense fields.", true); return; }
    const value = id => document.getElementById(id)?.value;
    const expense = { id:value("expenseId")||null, expense_date:value("expenseDate"), amount:value("expenseAmount"), category:value("expenseCategory"), description:value("expenseDescription"), frequency:value("expenseFrequency"), end_date:value("expenseEndDate")||null, supplier:value("expenseSupplier")||null, payment_method:value("expensePaymentMethod")||null, business_use_percent:value("expenseBusinessUse"), accounting_treatment:value("expenseTreatment"), notes:value("expenseNotes")||null };
    const file=document.getElementById("expenseReceipt")?.files?.[0];if(file){if(file.size>3145728)return alert("Receipt must be 3 MB or smaller.");expense.receipt={mime_type:file.type,data_base64:await fileToBase64(file)};}
    try { await driverPortalRequest("save_expense", { expense }); event.target.reset(); document.getElementById("expenseBusinessUse").value="100"; updateExpenseRecurrenceFields(); defaultAccountsRange(); await loadDriverAccounts(); setExpenseFormMessage("Expense saved successfully."); }
    catch (error) { setExpenseFormMessage(error.message || "Unable to save expense.", true); }
}
function fileToBase64(file){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result||"").split(",")[1]||"");reader.onerror=()=>reject(new Error("Receipt could not be read"));reader.readAsDataURL(file);});}
async function handleExpenseAction(event) { const editId=event.target.closest("[data-edit-expense]")?.dataset.editExpense;if(editId){const row=(driverAccountsSnapshot?.expenses||[]).find(x=>String(x.id)===String(editId));if(!row)return;const set=(id,value)=>{const el=document.getElementById(id);if(el)el.value=value??"";};set("expenseId",row.id);set("expenseDate",row.expense_date);set("expenseAmount",row.amount);set("expenseCategory",row.category);set("expenseDescription",row.description);set("expenseSupplier",row.supplier);set("expensePaymentMethod",row.payment_method);set("expenseBusinessUse",row.business_use_percent);set("expenseTreatment",row.accounting_treatment);set("expenseNotes",row.notes);document.getElementById("expenseForm")?.scrollIntoView({behavior:"smooth"});return;}const id=event.target.closest("[data-delete-expense]")?.dataset.deleteExpense;if(!id)return;if(!confirm("Delete or skip this expense occurrence? An audit entry will remain."))return;try{await driverPortalRequest("delete_expense",{expense_id:id});await loadDriverAccounts();}catch(error){alert(error.message||"Unable to delete expense.");} }
function exportAccountsCsv() {
    if (!driverAccountsSnapshot) return;
    const quote=value=>`"${String(value??"").replaceAll('"','""')}"`, rows=[["Type","Date","Reference/Category","Description","Amount GBP","Payment status"]];
    (driverAccountsSnapshot.jobs||[]).forEach(x=>rows.push(["Income",x.journey_date,x.booking_reference,"Driver earnings",x.driver_earnings??"",x.payment_status]));
    (driverAccountsSnapshot.expenses||[]).forEach(x=>rows.push(["Expense",x.expense_date,x.category,x.description,x.amount,x.accounting_treatment]));
    const blob=new Blob([rows.map(row=>row.map(quote).join(",")).join("\r\n")],{type:"text/csv;charset=utf-8"}),url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download=`driver-accounts-${driverAccountsSnapshot.from}-${driverAccountsSnapshot.to}.csv`;a.click();URL.revokeObjectURL(url);
}

function money(value) {
    const n = Number(value);
    return Number.isFinite(n) ? `${driverCurrencySymbol}${n.toFixed(2)}` : `${driverCurrencySymbol}0.00`;
}

function renderUnreadMessages(count) {
    for (const id of ["menuUnreadCount","homeUnreadCount"]) { const el=document.getElementById(id); if(el){el.textContent=String(count);el.classList.toggle("hidden",count<1);} }
    document.getElementById("messageAlert")?.classList.toggle("hidden",count<1);
}
async function loadDriverMessages(markRead=false) {
    try { const data=await driverPortalRequest("messages"); const list=document.getElementById("driverMessageList"); if(list)list.innerHTML=(data.messages||[]).map(row=>`<article class="message-bubble ${row.sender_type==='driver'?'driver':'admin'}"><p>${escapeHtml(row.body)}</p><small>${escapeHtml(new Date(row.created_at).toLocaleString('en-GB'))} · ${row.read_at?'Read':row.delivered_at?'Delivered':'Sent'}</small></article>`).join("")||'<div class="empty-list">No messages yet.</div>'; if(markRead){await driverPortalRequest("read_messages");renderUnreadMessages(0);} }
    catch(error){showConnectionMessage(error.message||"Unable to load messages.",true);}
}
async function sendInternalDriverMessage(event) {
    event.preventDefault(); const input=document.getElementById("driverMessageInput"),message=input?.value.trim(); if(!message)return;
    const key=`driver:${currentDriver.id}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    try{await driverPortalRequest("send_message",{message,client_key:key,booking_id:currentJob?.id||null});input.value="";await loadDriverMessages();}catch(error){showConnectionMessage(error.message||"Unable to send message.",true);}
}
function applyDriverPreferences(driver=currentDriver) {
    if(!driver)return; document.body.classList.remove("theme-light","theme-dark","text-large","text-extra_large");
    const theme=driver.portal_theme||"device"; if(theme==="light"||(theme==="device"&&matchMedia("(prefers-color-scheme: light)").matches))document.body.classList.add("theme-light"); else document.body.classList.add("theme-dark");
    if(driver.portal_text_size==="large")document.body.classList.add("text-large"); if(driver.portal_text_size==="extra_large")document.body.classList.add("text-extra_large");
    const set=(id,value)=>{const el=document.getElementById(id);if(el)el.value=value||"";};set("driverTheme",theme);set("driverTextSize",driver.portal_text_size||"normal");set("driverPublicPhone",driver.public_contact_phone);const sharing=document.getElementById("driverPhoneSharing");if(sharing)sharing.checked=driver.customer_phone_sharing===true;
}
async function savePreferences(event) {
    event.preventDefault();const payload={theme:document.getElementById("driverTheme").value,text_size:document.getElementById("driverTextSize").value,customer_phone_sharing:document.getElementById("driverPhoneSharing").checked,public_contact_phone:document.getElementById("driverPublicPhone").value.trim()};
    try{const data=await driverPortalRequest("save_preferences",payload);Object.assign(currentDriver,{portal_theme:payload.theme,portal_text_size:payload.text_size,customer_phone_sharing:data.customer_phone_sharing,public_contact_phone:data.customer_phone_sharing?payload.public_contact_phone:null});applyDriverPreferences();const el=document.getElementById("preferencesMessage");if(el){el.textContent="Preferences saved.";el.className="form-message success";}}catch(error){const el=document.getElementById("preferencesMessage");if(el){el.textContent=error.message||"Unable to save preferences.";el.className="form-message error";}}
}

function normaliseStatus(status) {
    return String(status || "").trim().toLowerCase().replaceAll(" ", "_");
}

function prettyStatus(status) {
    const v = normaliseStatus(status);
    return {
        "on_way": "On Way",
        "arrived": "Arrived",
        "passenger_onboard": "POB",
        "completed": "Completed",
        "waiting": "Waiting",
        "assigned": "Assigned",
        "accepted": "Accepted",
        "declined": "Declined",
        "cancelled": "Cancelled"
    }[v] || status || "Waiting";
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
    }[tier] || String(value || "-").replaceAll("_", " ").replace(/\b\w/g, letter => letter.toUpperCase());
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
    if (driverStaleTimer) clearInterval(driverStaleTimer);
});
