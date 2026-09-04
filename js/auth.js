const adminDb = getSupabase();

window.ADMIN_COMPANY_ID = null;
window.ADMIN_COMPANY = null;
window.ADMIN_ROLE = null;

window.adminCompanyReadyPromise = (async () => {
    const { data: { session }, error: sessionError } = await adminDb.auth.getSession();

    if (sessionError) throw sessionError;

    if (!session) {
        window.location.href = "login.html";
        throw new Error("No admin session");
    }

    const { data: { user }, error: userError } = await adminDb.auth.getUser();
    if (userError || !user || user.id !== session.user.id) {
        console.error("Admin user verification failed:", userError);
        await adminDb.auth.signOut();
        window.location.href = "login.html";
        throw new Error("Admin session could not be verified");
    }

    const { data: companyUser, error } = await adminDb
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
        .limit(1)
        .maybeSingle();

    if (error) {
        console.error("Company lookup error:", error);
        alert("Unable to load your company account.");
        throw error;
    }

    if (!companyUser) {
        alert("Your login is not linked to a company.");
        await adminDb.auth.signOut();
        window.location.href = "login.html";
        throw new Error("Admin user is not linked to a company");
    }

    window.ADMIN_COMPANY_ID = companyUser.company_id;
    window.ADMIN_COMPANY = companyUser.companies || null;
    window.ADMIN_ROLE = companyUser.role || "admin";

    const userName = document.getElementById("userName");
    if (userName) userName.textContent = session.user.email;

    window.dispatchEvent(new CustomEvent("adminCompanyReady", {
        detail: {
            companyId: window.ADMIN_COMPANY_ID,
            company: window.ADMIN_COMPANY,
            role: window.ADMIN_ROLE
        }
    }));

    return {
        session,
        companyId: window.ADMIN_COMPANY_ID,
        company: window.ADMIN_COMPANY,
        role: window.ADMIN_ROLE
    };
})();

window.getAdminCompanyContext = () => window.adminCompanyReadyPromise;
