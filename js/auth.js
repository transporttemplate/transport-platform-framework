const adminDb = getSupabase();

document.body?.classList.remove("admin-authenticated");

function redirectToLogin() {
    window.location.replace(adminAuthUrl("login.html"));
}

async function adminLogout() {
    document.body?.classList.remove("admin-authenticated");
    const { error } = await adminDb.auth.signOut();
    if (error) console.error("Admin logout failed:", error);
    window.location.replace("login.html");
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
    document.body?.classList.remove("admin-authenticated");
});

window.addEventListener("pageshow", async event => {
    if (!event.persisted) return;
    const { data: { user } } = await adminDb.auth.getUser();
    if (!user) redirectToLogin();
    else document.body?.classList.add("admin-authenticated");
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
        redirectToLogin();
        throw new Error("No admin session");
    }

    const { data: { user }, error: userError } = await adminDb.auth.getUser();
    if (userError || !user || user.id !== session.user.id) {
        console.error("Admin user verification failed:", userError);
        await adminDb.auth.signOut();
        redirectToLogin();
        throw new Error("Admin session could not be verified");
    }

    const { data: companyUsers, error } = await adminDb
        .from("company_users")
        .select(`
            company_id,
            role,
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

    if (!companyUsers?.length) {
        alert("Your login is not linked to a company.");
        await adminDb.auth.signOut();
        redirectToLogin();
        throw new Error("Admin user is not linked to a company");
    }

    const requestedCode = requestedAdminCompanyCode();
    const memberships = companyUsers.filter(item => item.companies?.company_code);
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
    window.ADMIN_PLATFORM_ROLE = String(user.app_metadata?.platform_role || "");
    window.ADMIN_COMPANIES = memberships;

    document.body?.classList.add("admin-authenticated");

    const userName = document.getElementById("userName");
    if (userName) userName.textContent = session.user.email;

    window.dispatchEvent(new CustomEvent("adminCompanyReady", {
        detail: {
            companyId: window.ADMIN_COMPANY_ID,
            company: window.ADMIN_COMPANY,
            role: window.ADMIN_ROLE,
            platformRole: window.ADMIN_PLATFORM_ROLE,
            memberships: window.ADMIN_COMPANIES
        }
    }));

    return {
        session,
        companyId: window.ADMIN_COMPANY_ID,
        company: window.ADMIN_COMPANY,
        role: window.ADMIN_ROLE,
        platformRole: window.ADMIN_PLATFORM_ROLE,
        memberships: window.ADMIN_COMPANIES
    };
})();

window.getAdminCompanyContext = () => window.adminCompanyReadyPromise;
