const adminDb = getSupabase();
const ADMIN_ALLOWED_ROLES = new Set(["admin", "owner", "office_manager", "office_staff"]);

document.body?.classList.remove("admin-authenticated");

function isAdminMembership(membership) {
    return membership?.active !== false && ADMIN_ALLOWED_ROLES.has(String(membership?.role || "").trim().toLowerCase());
}

async function loginCompanyCode() {
    const requestedCode = requestedAdminCompanyCode();
    if (requestedCode) return requestedCode;
    const hostname = String(window.location.hostname || "").trim().toLowerCase().replace(/\.$/, "");
    if (!hostname) return "";
    const { data, error } = await adminDb
        .from("company_domains")
        .select("companies!inner(company_code)")
        .eq("hostname", hostname)
        .eq("active", true)
        .maybeSingle();
    if (error) console.info("Admin login company could not be resolved from the hostname.", { code: error.code || "unknown" });
    return String(data?.companies?.company_code || "").trim();
}

async function redirectToLogin() {
    document.body?.classList.remove("admin-authenticated");
    const companyCode = await loginCompanyCode();
    const loginUrl = companyCode ? adminAuthUrl("login.html", companyCode) : adminAuthUrl("login.html");
    window.location.replace(loginUrl);
}

async function adminLogout() {
    document.body?.classList.remove("admin-authenticated");
    const { error } = await adminDb.auth.signOut();
    if (error) console.error("Admin logout failed:", error);
    await redirectToLogin();
}

const ADMIN_IDLE_LIMIT_MS = 30 * 60 * 1000;
const ADMIN_IDLE_WARNING_MS = 2 * 60 * 1000;
let adminIdleCleanup = null;

function startAdminInactivity(session) {
    adminIdleCleanup?.();
    const activityKey = `transport_admin_activity:${session.user.id}`;
    const logoutKey = `transport_admin_logout:${session.user.id}`;
    let warningTimer = null, logoutTimer = null, lastRecorded = 0, expired = false;
    const dialog = document.createElement("dialog");
    dialog.className = "admin-idle-dialog";
    dialog.setAttribute("aria-labelledby", "adminIdleTitle");
    dialog.innerHTML = `<h2 id="adminIdleTitle">Still working?</h2><p>You will be signed out in 2 minutes because there has been no Admin activity.</p><div><button type="button" data-stay>Stay Logged In</button><button type="button" data-logout>Log Out</button></div>`;
    document.body.appendChild(dialog);
    const style = document.createElement("style");
    style.textContent = `.admin-idle-dialog{width:min(92vw,430px);padding:22px;border:0;border-radius:14px;box-shadow:0 24px 70px rgba(15,23,42,.3);color:#172033}.admin-idle-dialog::backdrop{background:rgba(15,23,42,.62)}.admin-idle-dialog h2{margin:0 0 8px}.admin-idle-dialog p{line-height:1.5;color:#526174}.admin-idle-dialog div{display:flex;gap:8px;justify-content:flex-end}.admin-idle-dialog button{min-height:42px;padding:9px 14px;border:0;border-radius:8px;font-weight:750;cursor:pointer}.admin-idle-dialog [data-stay]{background:#2563eb;color:#fff}`;
    document.head.appendChild(style);
    const readActivity = () => Number(localStorage.getItem(activityKey) || Date.now());
    const schedule = () => {
        clearTimeout(warningTimer); clearTimeout(logoutTimer);
        const remaining = Math.max(0, ADMIN_IDLE_LIMIT_MS - (Date.now() - readActivity()));
        if (remaining <= 0) return expire();
        if (remaining <= ADMIN_IDLE_WARNING_MS) { if (!dialog.open) dialog.showModal(); }
        else warningTimer = setTimeout(() => { if (!expired && !dialog.open) dialog.showModal(); }, remaining - ADMIN_IDLE_WARNING_MS);
        logoutTimer = setTimeout(expire, remaining);
    };
    const recordActivity = () => {
        if (expired || Date.now() - lastRecorded < 1000) return;
        lastRecorded = Date.now(); localStorage.setItem(activityKey, String(lastRecorded));
        if (dialog.open) dialog.close(); schedule();
    };
    async function expire() {
        if (expired) return; expired = true;
        localStorage.setItem(logoutKey, String(Date.now()));
        await adminLogout();
    }
    const events = ["pointerdown", "keydown", "touchstart", "scroll"];
    events.forEach(name => window.addEventListener(name, recordActivity, { passive: true, capture: true }));
    const onStorage = event => {
        if (event.key === activityKey) { if (dialog.open) dialog.close(); schedule(); }
        if (event.key === logoutKey) expire();
    };
    window.addEventListener("storage", onStorage);
    dialog.querySelector("[data-stay]").addEventListener("click", recordActivity);
    dialog.querySelector("[data-logout]").addEventListener("click", expire);
    localStorage.setItem(activityKey, String(Date.now()));
    schedule();
    adminIdleCleanup = () => { clearTimeout(warningTimer); clearTimeout(logoutTimer); events.forEach(name => window.removeEventListener(name, recordActivity, { capture: true })); window.removeEventListener("storage", onStorage); dialog.remove(); style.remove(); };
}

document.addEventListener("click", event => {
    const link = event.target.closest?.('a[href]');
    if (!link) return;
    const url = new URL(link.href, window.location.href);
    if (url.origin !== window.location.origin || !url.pathname.endsWith("/login.html")) return;
    event.preventDefault();
    adminLogout();
}, true);

window.addEventListener("pagehide", () => {
    adminIdleCleanup?.();
    document.body?.classList.remove("admin-authenticated");
});

window.addEventListener("pageshow", async event => {
    if (!event.persisted) return;
    document.body?.classList.remove("admin-authenticated");
    const [{ data: { session } }, { data: { user } }] = await Promise.all([
        adminDb.auth.getSession(),
        adminDb.auth.getUser()
    ]);
    if (!session?.user || !user || user.id !== session.user.id || !window.ADMIN_COMPANY_ID) {
        await redirectToLogin();
        return;
    }
    const { data: membership } = await adminDb.from("company_users")
        .select("company_id,role,active")
        .eq("user_id", user.id)
        .eq("company_id", window.ADMIN_COMPANY_ID)
        .maybeSingle();
    if (!membership || !isAdminMembership(membership)) {
        await adminDb.auth.signOut();
        await redirectToLogin();
        return;
    }
    startAdminInactivity(session);
    document.body?.classList.add("admin-authenticated");
});

window.ADMIN_COMPANY_ID = null;
window.ADMIN_COMPANY = null;
window.ADMIN_ROLE = null;
window.ADMIN_PLATFORM_ROLE = null;
window.ADMIN_COMPANIES = [];

function requestedAdminCompanyCode() {
    const code = String(new URLSearchParams(window.location.search).get("company") || "").trim();
    return /^[a-z0-9_-]+$/i.test(code) ? code : "";
}

function adminAuthUrl(path, companyCode = requestedAdminCompanyCode()) {
    const url = new URL(path, window.location.href);
    if (companyCode) url.searchParams.set("company", companyCode);
    return `${url.pathname.split("/").pop()}${url.search}${url.hash}`;
}

window.adminCompanyReadyPromise = (async () => {
    const { data: { session }, error: sessionError } = await adminDb.auth.getSession();

    if (sessionError) throw sessionError;

    if (!session) {
        await redirectToLogin();
        throw new Error("No admin session");
    }

    const { data: { user }, error: userError } = await adminDb.auth.getUser();
    if (userError || !user || user.id !== session.user.id) {
        console.error("Admin user verification failed:", userError);
        await adminDb.auth.signOut();
        await redirectToLogin();
        throw new Error("Admin session could not be verified");
    }

    const { data: companyUsers, error } = await adminDb
        .from("company_users")
        .select(`
            company_id,
            role,
            active,
            permission_grants,
            permission_denials,
            companies (
                id,
                company_code,
                name,
                trading_name
            )
        `)
        .eq("user_id", user.id)
        .order("company_id");

    if (error) {
        console.error("Company lookup error:", error);
        alert("Unable to load your company account.");
        throw error;
    }

    const adminMemberships = (companyUsers || []).filter(isAdminMembership);
    if (!adminMemberships.length) {
        alert("Your login is not linked to an Admin account.");
        await adminDb.auth.signOut();
        await redirectToLogin();
        throw new Error("User does not have an Admin company role");
    }

    // An explicit, authorised switch remains authoritative. Without one, use
    // the active hostname mapping before falling back to the user's first
    // membership; this prevents branded domains silently opening company 0001.
    const requestedCode = requestedAdminCompanyCode() || await loginCompanyCode();
    const memberships = adminMemberships.filter(item => item.companies?.company_code);
    const companyUser = requestedCode
        ? memberships.find(item => String(item.companies.company_code).toLowerCase() === requestedCode.toLowerCase())
        : memberships.find(item => String(item.companies.company_code) === "0001") || memberships[0];
    if (!companyUser) {
        const authorisedCode = String((memberships.find(item => String(item.companies.company_code) === "0001") || memberships[0]).companies.company_code);
        const url = new URL(window.location.href);
        url.searchParams.set("company", authorisedCode);
        window.location.replace(url.href);
        throw new Error("Requested admin company is not accessible");
    }

    const lifecycleResult = await adminDb.from("companies")
        .select("id,company_status,trial_started_at,trial_expires_at,trial_grace_expires_at")
        .eq("id", companyUser.company_id)
        .maybeSingle();
    if (!lifecycleResult.error && lifecycleResult.data) {
        Object.assign(companyUser.companies, lifecycleResult.data);
    } else if (lifecycleResult.error) {
        console.info("Company lifecycle fields are not installed yet; continuing with active-company behaviour.", {
            code: lifecycleResult.error.code || "unknown"
        });
        companyUser.companies.company_status = "active";
    }

    window.ADMIN_COMPANY_ID = companyUser.company_id;
    window.ADMIN_COMPANY = companyUser.companies || null;
    window.ADMIN_ROLE = companyUser.role || "admin";
    window.ADMIN_PERMISSIONS = { grants: companyUser.permission_grants || [], denials: companyUser.permission_denials || [] };
    window.ADMIN_PLATFORM_ROLE = String(user.app_metadata?.platform_role || "");
    window.ADMIN_COMPANIES = memberships;

    startAdminInactivity(session);

    document.body?.classList.add("admin-authenticated");

    const userName = document.getElementById("userName");
    if (userName) userName.textContent = session.user.email;

    window.dispatchEvent(new CustomEvent("adminCompanyReady", {
        detail: {
            companyId: window.ADMIN_COMPANY_ID,
            company: window.ADMIN_COMPANY,
            role: window.ADMIN_ROLE,
            permissions: window.ADMIN_PERMISSIONS,
            platformRole: window.ADMIN_PLATFORM_ROLE,
            memberships: window.ADMIN_COMPANIES
        }
    }));

    return {
        session,
        companyId: window.ADMIN_COMPANY_ID,
        company: window.ADMIN_COMPANY,
        role: window.ADMIN_ROLE,
        permissions: window.ADMIN_PERMISSIONS,
        platformRole: window.ADMIN_PLATFORM_ROLE,
        memberships: window.ADMIN_COMPANIES
    };
})();

window.getAdminCompanyContext = () => window.adminCompanyReadyPromise;
