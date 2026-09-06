const adminDb = getSupabase();

window.ADMIN_COMPANY_ID = null;
window.ADMIN_COMPANY = null;
window.ADMIN_ROLE = null;
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
        window.location.href = adminAuthUrl("login.html");
        throw new Error("No admin session");
    }

    const { data: { user }, error: userError } = await adminDb.auth.getUser();
    if (userError || !user || user.id !== session.user.id) {
        console.error("Admin user verification failed:", userError);
        await adminDb.auth.signOut();
        window.location.href = adminAuthUrl("login.html");
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
        window.location.href = adminAuthUrl("login.html");
        throw new Error("Admin user is not linked to a company");
    }

    const requestedCode = requestedAdminCompanyCode();
    const memberships = companyUsers.filter(item => item.companies?.company_code);
    const companyUser = requestedCode
        ? memberships.find(item => String(item.companies.company_code).toLowerCase() === requestedCode.toLowerCase())
        : memberships.find(item => String(item.companies.company_code) === "0001") || memberships[0];
    if (!companyUser) {
        alert(`Your login does not have access to company ${requestedCode}.`);
        throw new Error("Requested admin company is not accessible");
    }

    window.ADMIN_COMPANY_ID = companyUser.company_id;
    window.ADMIN_COMPANY = companyUser.companies || null;
    window.ADMIN_ROLE = companyUser.role || "admin";
    window.ADMIN_COMPANIES = memberships;

    const userName = document.getElementById("userName");
    if (userName) userName.textContent = session.user.email;

    window.dispatchEvent(new CustomEvent("adminCompanyReady", {
        detail: {
            companyId: window.ADMIN_COMPANY_ID,
            company: window.ADMIN_COMPANY,
            role: window.ADMIN_ROLE,
            memberships: window.ADMIN_COMPANIES
        }
    }));

    return {
        session,
        companyId: window.ADMIN_COMPANY_ID,
        company: window.ADMIN_COMPANY,
        role: window.ADMIN_ROLE,
        memberships: window.ADMIN_COMPANIES
    };
})();

window.getAdminCompanyContext = () => window.adminCompanyReadyPromise;
