document.addEventListener("DOMContentLoaded", async () => {
    initialiseAdminNavigation();
    await loadAdminCompanyTheme();
});

function initialiseAdminNavigation() {
    const sidebar = document.querySelector(".sidebar");
    if (!sidebar) return;
    sidebar.id ||= "adminSidebar";

    if (!sidebar.querySelector('a[href="contracts.html"]')) {
        const customersLink = sidebar.querySelector('a[href="customers.html"]');
        const link = document.createElement("a");
        link.href = "contracts.html";
        link.textContent = "🏢 Contracts / Accounts";
        if (location.pathname.endsWith("/contracts.html")) link.classList.add("active");
        customersLink?.after(link);
    }

    let menuButton = document.querySelector(".menu-toggle");
    const topbar = document.querySelector(".topbar");
    if (!menuButton) {
        menuButton = document.createElement("button");
        menuButton.className = "menu-toggle";
        menuButton.type = "button";
        menuButton.textContent = "☰";
        (topbar || document.querySelector(".main") || document.body).prepend(menuButton);
    }

    let overlay = document.querySelector(".overlay");
    if (!overlay) {
        overlay = document.createElement("div");
        overlay.className = "overlay";
        document.body.appendChild(overlay);
    }

    const close = () => {
        sidebar.classList.remove("open");
        overlay.classList.remove("open");
        document.body.classList.remove("admin-nav-open");
        menuButton?.setAttribute("aria-expanded", "false");
        menuButton?.setAttribute("aria-label", "Open navigation");
    };
    const toggle = () => {
        const open = !sidebar.classList.contains("open");
        sidebar.classList.toggle("open", open);
        overlay.classList.toggle("open", open);
        document.body.classList.toggle("admin-nav-open", open);
        menuButton?.setAttribute("aria-expanded", String(open));
        menuButton?.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
    };

    if (menuButton) {
        menuButton.setAttribute("aria-controls", sidebar.id);
        menuButton.setAttribute("aria-expanded", "false");
        menuButton.setAttribute("aria-label", "Open navigation");
        menuButton.addEventListener("click", toggle);
    }
    overlay.addEventListener("click", close);
    sidebar.querySelectorAll("a").forEach(link => link.addEventListener("click", close));
    document.addEventListener("keydown", event => { if (event.key === "Escape") close(); });
    window.addEventListener("resize", () => { if (window.innerWidth > 900) close(); });
}

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
