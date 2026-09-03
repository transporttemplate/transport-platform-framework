document.addEventListener("DOMContentLoaded", async () => {

    const menuButton = document.querySelector(".menu-toggle");
    const sidebar = document.querySelector(".sidebar");

    if (menuButton && sidebar) {
        menuButton.addEventListener("click", () => {
            sidebar.classList.toggle("open");
        });
    }

    await loadAdminCompanyTheme();
});

async function loadAdminCompanyTheme() {
    if (typeof window.getAdminCompanyContext !== "function") return;

    try {
        const context = await window.getAdminCompanyContext();
        const db = getSupabase();
        const { data, error } = await db
            .from("settings")
            .select("primarycolour,accentcolour,buttoncolour,buttontextcolour,adminsidebarcolour")
            .eq("company_id", context.companyId)
            .maybeSingle();

        if (error) {
            console.error("Admin company theme load error:", error);
            return;
        }

        setAdminThemeVariable("--admin-primary", data?.primarycolour);
        setAdminThemeVariable("--admin-accent", data?.accentcolour);
        setAdminThemeVariable("--admin-button", data?.buttoncolour || data?.primarycolour);
        setAdminThemeVariable("--admin-button-text", data?.buttontextcolour);
        setAdminThemeVariable("--sidebar", data?.adminsidebarcolour);
    } catch (error) {
        console.error("Admin company theme startup error:", error);
    }
}

function setAdminThemeVariable(name, value) {
    if (value && CSS.supports("color", value)) {
        document.documentElement.style.setProperty(name, value);
    }
}
