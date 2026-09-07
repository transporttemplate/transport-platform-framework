document.addEventListener("DOMContentLoaded", async () => {
    initialiseAdminNavigation();
    const context = await window.getAdminCompanyContext?.();
    if (context) {
        ensureAdminCompanyQuery(context.company?.company_code);
        preserveAdminCompanyLinks(context.company?.company_code);
        initialiseAdminCompanySwitcher(context);
        initialiseTrialAccount(context);
    }
    await loadAdminCompanyTheme();
});

function ensureAdminCompanyQuery(companyCode) {
    if (!companyCode || new URLSearchParams(location.search).get("company")) return;
    const url = new URL(location.href);
    url.searchParams.set("company", companyCode);
    history.replaceState(null, "", url);
}

function preserveAdminCompanyLinks(companyCode) {
    if (!companyCode) return;
    const updateLink = link => {
        const href = link.getAttribute("href") || "";
        if (!href || href.startsWith("#") || /^(mailto:|tel:|javascript:)/i.test(href)) return;
        const url = new URL(href, location.href);
        if (url.origin !== location.origin || !/\.html$/i.test(url.pathname)) return;
        url.searchParams.set("company", companyCode);
        link.href = `${url.pathname.split("/").pop()}${url.search}${url.hash}`;
    };
    document.querySelectorAll("a[href]").forEach(updateLink);
    document.addEventListener("click", event => {
        const link = event.target.closest?.("a[href]");
        if (link) updateLink(link);
    }, true);
}

function initialiseAdminCompanySwitcher(context) {
    const topbar = document.querySelector(".topbar, .invoice-actions");
    const memberships = context.memberships || [];
    if (!topbar || memberships.length < 2 || document.getElementById("adminCompanySwitcher")) return;
    const wrapper = document.createElement("label");
    wrapper.className = "admin-company-switcher";
    wrapper.textContent = "Company";
    const select = document.createElement("select");
    select.id = "adminCompanySwitcher";
    select.setAttribute("aria-label", "Active company");
    for (const membership of memberships) {
        const company = membership.companies || {};
        const option = document.createElement("option");
        option.value = company.company_code;
        option.textContent = company.company_code === "0001"
            ? "Template / 0001"
            : `${company.trading_name || company.name || "Company"} / ${company.company_code}`;
        option.selected = String(membership.company_id) === String(context.companyId);
        select.appendChild(option);
    }
    select.addEventListener("change", () => {
        const url = new URL(location.href);
        url.searchParams.set("company", select.value);
        location.href = url.href;
    });
    wrapper.appendChild(select);
    topbar.appendChild(wrapper);
}

function initialiseTrialAccount(context) {
    const company = context.company || {};
    const status = String(company.company_status || "active").toLowerCase();
    if (!["trial", "suspended"].includes(status)) return;
    const main = document.querySelector(".main");
    if (!main || document.getElementById("trialAccountBanner")) return;

    const platformRoles = new Set(["builder", "support", "platform_owner"]);
    const isPlatformOperator = platformRoles.has(String(context.platformRole || "").toLowerCase());
    const expiresAt = company.trial_expires_at ? new Date(company.trial_expires_at) : null;
    const expired = status === "suspended" || !expiresAt || expiresAt.getTime() <= Date.now();
    const companyName = company.trading_name || company.name || `Company ${company.company_code || ""}`;

    if (expired && !isPlatformOperator) {
        const screen = document.createElement("section");
        screen.id = "trialAccountBanner";
        screen.className = "trial-expired-screen card";
        screen.innerHTML = `<p class="trial-label">Trial account</p><h1>${adminEscape(companyName)}</h1><h2>Your trial has ended</h2><p>Contact us to activate your full account.</p><p><strong>Full platform: £550 upfront + £50/month.</strong></p>`;
        [...main.children].forEach(child => { child.hidden = true; });
        main.appendChild(screen);
        return;
    }

    const days = expiresAt ? Math.max(0, Math.ceil((expiresAt.getTime() - Date.now()) / 86400000)) : 0;
    const banner = document.createElement("section");
    banner.id = "trialAccountBanner";
    banner.className = `trial-account-banner${expired ? " is-expired" : ""}`;
    banner.innerHTML = expired
        ? `<strong>${adminEscape(companyName)} — Trial Account</strong><span>Your trial has ended. Contact us to activate your full account.</span>`
        : `<div><strong>${adminEscape(companyName)} — Trial Account</strong><span>14-Day Trial · ${days === 0 ? "Ends today" : `Trial ends in ${days} day${days === 1 ? "" : "s"}`}</span></div><p>Like the platform? Upgrade to the full account for <strong>£550 upfront + £50/month</strong>.</p><small>Stripe payments and live branded email are activated on the full account. Business email requires your email/domain setup to be configured.</small>`;
    const topbar = main.querySelector(".topbar, .invoice-actions");
    topbar?.insertAdjacentElement("afterend", banner);
    if (!topbar) main.prepend(banner);
    applyTrialFeatureRestrictions();
}

function applyTrialFeatureRestrictions() {
    for (const id of ["stripePublishableKey", "enableStripe", "requirePaymentBeforeTravel", "sendTestEmail"]) {
        const control = document.getElementById(id);
        if (control) control.disabled = true;
    }
    const stripeToggle = document.getElementById("enableStripe");
    if (stripeToggle) stripeToggle.checked = false;
    const emailToggle = document.getElementById("emailNotifications");
    if (emailToggle) {
        emailToggle.checked = false;
        emailToggle.disabled = true;
    }
}

function adminEscape(value) {
    return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

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
