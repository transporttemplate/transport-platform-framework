document.addEventListener("DOMContentLoaded", async () => {
    initialisePublicNavigation();
    if (typeof window.loadPublicCompanyData !== "function") return;

    const publicData = await window.loadPublicCompanyData();
    if (!publicData) return;

    applyCompanyInformation(publicData);
    renderPublicAirports(publicData);
    renderServiceAreas(publicData);
    renderPublicFleet(publicData);
    renderOpeningHours(publicData.settings);
    preserveCompanyOnPublicLinks(publicData.company.company_code);
    window.GoogleTags?.configureFromSettings(publicData.settings, publicData.company.company_code);
});

function initialisePublicNavigation() {
    const header = document.querySelector("header");
    const nav = header?.querySelector("nav");
    const container = header?.querySelector(".container");
    if (!nav || !container) return;
    nav.id ||= "publicNavigation";

    const button = document.createElement("button");
    button.className = "public-menu-toggle";
    button.type = "button";
    button.innerHTML = '<span aria-hidden="true">☰</span><span class="sr-only">Menu</span>';
    button.setAttribute("aria-controls", nav.id);
    button.setAttribute("aria-expanded", "false");
    container.insertBefore(button, nav);

    const close = () => { nav.classList.remove("open"); button.setAttribute("aria-expanded", "false"); };
    button.addEventListener("click", () => {
        const open = !nav.classList.contains("open");
        nav.classList.toggle("open", open);
        button.setAttribute("aria-expanded", String(open));
    });
    nav.querySelectorAll("a").forEach(link => link.addEventListener("click", close));
    document.addEventListener("click", event => { if (!header.contains(event.target)) close(); });
    document.addEventListener("keydown", event => { if (event.key === "Escape") close(); });
    window.addEventListener("resize", () => { if (window.innerWidth > 900) close(); });
}

function applyCompanyInformation({ company, settings }) {
    const displayName = settings.tradingname || company.trading_name || settings.companyname || company.name;

    setTextIfValue("companyName", displayName);
    setTextIfValue("companyTradingName", displayName);
    setTextIfValue("companyPhone", settings.companyphone);
    setTextIfValue("companyEmail", settings.companyemail);
    setTextIfValue("companyAddress", settings.companyaddress);
    setTextIfValue("contactPhone", settings.companyphone);
    setTextIfValue("contactEmail", settings.companyemail);
    setTextIfValue("footerPhone", settings.companyphone);
    setTextIfValue("footerEmail", settings.companyemail);
    setTextIfValue("footerCompany", displayName);

    renderCompanyLogo(settings.companylogo, displayName);
    applyCompanyPublicImages(settings);

    setCssVariableIfValue("--primary", settings.primarycolour || settings.primary_color);
    setCssVariableIfValue("--secondary", settings.secondarycolour || settings.secondary_color);
    setCssVariableIfValue("--accent", settings.accentcolour || settings.accent_color);
    setCssVariableIfValue("--button", settings.buttoncolour || settings.button_color);
    setCssVariableIfValue("--button-text", settings.buttontextcolour || settings.button_text_color);
    setCssVariableIfValue("--background", settings.publicbackgroundcolour);
    setCssVariableIfValue("--card", settings.publiccardcolour);
    setCssVariableIfValue("--header-background", settings.publicheadercolour);
    setCssVariableIfValue("--text", settings.publictextcolour);
    setCssVariableIfValue("--muted", settings.publicmutedcolour);
    setCssVariableIfValue("--footer-background", settings.publicfootercolour);
}

function applyCompanyPublicImages(settings) {
    setPublicHeroImage("homeHero", settings.homeheroimage);
    const bookingHero = document.getElementById("bookingHero");
    if (setPublicHeroImage("bookingHero", settings.bookingheroimage) && bookingHero) bookingHero.classList.add("has-company-image");
    const fleet = document.getElementById("fleetImage");
    const fleetUrl = safePublicImageUrl(settings.fleetimage);
    if (fleet && fleetUrl) fleet.src = fleetUrl;
    setPublicHeroImage("contactHero", settings.contactheroimage);
}

function renderPublicFleet({ fleetItems = [], settings = {} }) {
    const grid = document.getElementById("publicFleetGrid");
    if (!grid) return;

    if (!fleetItems.length) {
        const legacyImage = safePublicImageUrl(settings.fleetimage) || "assets/images/saloon.jpg";
        grid.innerHTML = `<article class="airport-card fleet-card"><img src="${escapePublicHtml(legacyImage)}" alt="Company vehicle"><h3>Our Fleet</h3><p>Contact us to discuss the best vehicle for your journey.</p></article>`;
        return;
    }

    grid.innerHTML = fleetItems.map(item => {
        const image = safePublicImageUrl(item.image_url);
        const capacities = [
            Number.isFinite(Number(item.passenger_capacity)) ? `Up to ${Number(item.passenger_capacity)} passengers` : "",
            Number.isFinite(Number(item.luggage_capacity)) ? `${Number(item.luggage_capacity)} luggage` : ""
        ].filter(Boolean).join(" • ");
        return `<article class="airport-card fleet-card">
            ${image ? `<img src="${escapePublicHtml(image)}" alt="${escapePublicHtml(item.title)}">` : ""}
            <h3>${escapePublicHtml(item.title)}</h3>
            ${item.description ? `<p>${escapePublicHtml(item.description)}</p>` : ""}
            ${capacities ? `<small>${escapePublicHtml(capacities)}</small>` : ""}
        </article>`;
    }).join("");
}

function renderOpeningHours(settings) {
    const target = document.getElementById("openingHours");
    if (!target) return;
    const days = [
        ["Monday", "mon"], ["Tuesday", "tue"], ["Wednesday", "wed"],
        ["Thursday", "thu"], ["Friday", "fri"], ["Saturday", "sat"], ["Sunday", "sun"]
    ];
    const hasHours = days.some(([, key]) => settings[`${key}enabled`] !== undefined);
    if (!hasHours) return;

    target.className = "opening-hours-list";
    target.innerHTML = days.map(([label, key]) => {
        let value = "Closed";
        if (settings[`${key}enabled`]) {
            if (settings[`${key}24hours`]) value = "Open 24 hours";
            else {
                const open = displayTime(settings[`${key}open`]);
                const close = displayTime(settings[`${key}close`]);
                value = open && close ? `${open}–${close}${close <= open ? " (next day)" : ""}` : "Contact us";
            }
        }
        return `<div><span>${label}</span><strong>${escapePublicHtml(value)}</strong></div>`;
    }).join("");
}

function displayTime(value) {
    const match = String(value || "").match(/^(\d{2}):(\d{2})/);
    return match ? `${match[1]}:${match[2]}` : "";
}

function setPublicHeroImage(id, value) {
    const element = document.getElementById(id);
    const url = safePublicImageUrl(value);
    if (!element || !url) return false;
    element.style.backgroundImage = `linear-gradient(rgba(0,0,0,.48),rgba(0,0,0,.48)),url("${url.replaceAll('"', '%22')}")`;
    return true;
}

function safePublicImageUrl(value) {
    try {
        const url = new URL(String(value || ""), window.location.href);
        return ["https:", "http:"].includes(url.protocol) ? url.href : "";
    } catch { return ""; }
}

function renderCompanyLogo(logoUrl, displayName) {
    const logo = document.getElementById("companyLogo");
    const fallback = document.getElementById("companyLogoFallback");
    if (!logo) return;

    const showFallback = () => {
        logo.hidden = true;
        logo.removeAttribute("src");
        if (fallback) {
            fallback.hidden = false;
            fallback.textContent = companyInitials(displayName);
            fallback.setAttribute("aria-label", displayName || "Company");
        }
    };

    if (!logoUrl) {
        showFallback();
        return;
    }

    logo.hidden = true;
    logo.alt = displayName ? `${displayName} logo` : "Company logo";
    logo.onload = () => {
        logo.hidden = false;
        if (fallback) fallback.hidden = true;
    };
    logo.onerror = showFallback;
    logo.src = logoUrl;
}

function companyInitials(name) {
    const words = String(name || "Company").trim().split(/\s+/).filter(Boolean);
    return words.slice(0, 2).map(word => word.charAt(0).toUpperCase()).join("") || "C";
}

function airportCards(airports, settings) {
    const currency = settings.currencysymbol || "£";

    return airports.map(airport => {
        const prices = [airport.price_1_4_oneway, airport.price_5_7_oneway]
            .map(Number)
            .filter(price => Number.isFinite(price) && price > 0);
        const price = prices.length
            ? `From ${escapePublicHtml(currency)}${Math.min(...prices).toFixed(2)}`
            : "Contact us for a price";
        const bookingUrl = publicPageUrl("booking.html", {
            airport: airport.name,
            company: window.APP_CONFIG.companyCode
        });

        return `
            <div class="airport-card">
                <h3>✈️ ${escapePublicHtml(airport.name)}</h3>
                <p>${price}</p>
                <a class="book-btn" href="${escapePublicHtml(bookingUrl)}">Book Now</a>
            </div>
        `;
    }).join("");
}

function renderPublicAirports({ airports, settings }) {
    if (!airports.length) return;

    const allAirports = document.getElementById("publicAirportGrid");
    if (allAirports) allAirports.innerHTML = airportCards(airports, settings);

    const popularAirports = document.getElementById("publicPopularAirportGrid");
    if (popularAirports) popularAirports.innerHTML = airportCards(airports.slice(0, 4), settings);
}

function renderServiceAreas({ serviceAreas, settings }) {
    if (!serviceAreas.length) return;

    const seen = new Set();
    const names = serviceAreas.map(area => String(area.area_name || "").trim()).filter(name => {
        const key = name.toLocaleLowerCase("en-GB");
        if (!name || seen.has(key)) return false;
        seen.add(key);
        return true;
    }).map(publicAreaName);
    if (!names.length) return;

    setTextIfValue("serviceArea", names.join(" • "));

    const bookingMessage = document.getElementById("airportServiceAreaMessage");
    if (bookingMessage) {
        bookingMessage.textContent = settings.allowairportoutsidearea
            ? `Fixed airport prices are configured for ${names.join(", ")}. Other areas can also be booked where enabled.`
            : `Fixed airport prices apply when the non-airport address is in ${names.join(", ")}.`;
    }
}

function publicAreaName(value) {
    const name = String(value || "").trim();
    return name === name.toLowerCase() ? name.replace(/\b\p{L}/gu, letter => letter.toLocaleUpperCase("en-GB")) : name;
}

function preserveCompanyOnPublicLinks(companyCode) {
    if (!companyCode) return;

    document.querySelectorAll('a[href$=".html"], a[href*=".html?"]').forEach(link => {
        const rawHref = link.getAttribute("href");
        if (!rawHref || /^(https?:|mailto:|tel:|#)/i.test(rawHref)) return;

        const url = new URL(rawHref, window.location.href);
        url.searchParams.set("company", companyCode);
        link.href = `${url.pathname.split("/").pop()}${url.search}${url.hash}`;
    });
}

function publicPageUrl(path, params = {}) {
    const url = new URL(path, window.location.href);
    Object.entries(params).forEach(([key, value]) => {
        if (value) url.searchParams.set(key, value);
    });
    return `${url.pathname.split("/").pop()}${url.search}`;
}

function setTextIfValue(id, value) {
    const element = document.getElementById(id);
    if (element && value !== null && value !== undefined && value !== "") {
        element.textContent = value;
    }
}

function setCssVariableIfValue(name, value) {
    if (value) document.documentElement.style.setProperty(name, value);
}

function escapePublicHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}
