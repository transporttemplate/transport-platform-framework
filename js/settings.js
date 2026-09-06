const db = getSupabase();

const fieldMap = {
    companyName: "companyname",
    tradingName: "tradingname",
    companyPhone: "companyphone",
    companyEmail: "companyemail",
    companyWebsite: "companywebsite",
    companyAddress: "companyaddress",
    companyLogo: "companylogo",
    homeHeroImage: "homeheroimage",
    bookingHeroImage: "bookingheroimage",
    fleetImage: "fleetimage",
    primaryColour: "primarycolour",
    secondaryColour: "secondarycolour",
    accentColour: "accentcolour",
    buttonColour: "buttoncolour",
    buttonTextColour: "buttontextcolour",
    adminSidebarColour: "adminsidebarcolour",

    operatorLicence: "operatorlicence",
    companyRegistration: "companyregistration",
    vatNumber: "vatnumber",
    vatRate: "vatrate",

    currency: "currency",
    timeZone: "timezone",

    businessStatus: "businessstatus",
    holidayFrom: "holidayfrom",
    holidayFromTime: "holidayfromtime",
    holidayTo: "holidayto",
    holidayToTime: "holidaytotime",
    websiteNotice: "websitenotice",
    acceptAdvanceBookings: "acceptadvancebookings",

    emergencyPhone: "emergencyphone",
    officeEmail: "officeemail",
    closedMessage: "closedmessage",

    maxAdvanceDays: "maxadvancedays",
    minimumNotice: "minimumnotice",

    monOpen: "monopen",
    monClose: "monclose",
    tueOpen: "tueopen",
    tueClose: "tueclose",
    wedOpen: "wedopen",
    wedClose: "wedclose",
    thuOpen: "thuopen",
    thuClose: "thuclose",
    friOpen: "friopen",
    friClose: "friclose",
    satOpen: "satopen",
    satClose: "satclose",
    sunOpen: "sunopen",
    sunClose: "sunclose",

    monEnabled: "monenabled",
    tueEnabled: "tueenabled",
    wedEnabled: "wedenabled",
    thuEnabled: "thuenabled",
    friEnabled: "frienabled",
    satEnabled: "satenabled",
    sunEnabled: "sunenabled",

    minimumFare: "minimumfare",
    firstMile: "firstmile",

    mileBand1: "mileband1",
    mileBand2: "mileband2",
    mileBand3: "mileband3",
    mileBand4: "mileband4",
    mileBand5: "mileband5",
    mileBand6: "mileband6",

    waitingTime: "waitingtime",
    driverCommission: "drivercommission",
    returnDiscount: "returndiscount",
    cancellationCharge: "cancellationcharge",
    airportDeposit: "airportdeposit",
    bankHoliday: "bankholiday",
    christmas: "christmas",
    bookingFee: "bookingfee",
    airportViaSurcharge: "airportviasurcharge",

    useGoogleBoundary: "usegoogleboundary",
    allowAirportOutsideArea: "allowairportoutsidearea",
    forceDistanceCalculator: "forcedistancecalculator",
    showAreaWarning: "showareawarning",

    requireDeposit: "requiredeposit",
    depositPercent: "depositpercent",
    airportDepositRequired: "airportdepositrequired",
    autoConfirm: "autoconfirm",
    autoAssign: "autoassign",
    allowCash: "allowcash",
    allowCard: "allowcard",
    allowAccounts: "allowaccounts",
    airportPricing: "airportpricing",
    distanceCalculator: "distancecalculator",
    returnBookings: "returnbookings",
    multipleStops: "multiplestops",
    driverReject: "driverreject",
    customerCancel: "customercancel",
    promoCodes: "promocodes",
    googleReviews: "googlereviews",
    emailNotifications: "emailnotifications",
    smsNotifications: "smsnotifications",
    bookWhileClosed: "acceptadvancebookings",
    emailReceipts: "emailreceipts",
    driverJobsheet: "driverjobsheet",

    stripePublishableKey: "stripepublishablekey",
    defaultPaymentMethod: "defaultpaymentmethod",
    paymentTerms: "paymentterms",
    enableStripe: "enablestripe",
    enableCash: "enablecash",
    enableAccounts: "enableaccounts",
    requirePaymentBeforeTravel: "requirepaymentbeforetravel",

    bookingConfirmationEmail: "bookingconfirmationemail",
    driverAssignedEmail: "driverassignedemail",
    bookingCancelledEmail: "bookingcancelledemail",
    receiptEmail: "receiptemail",

    googleMapsApi: "googlemapsapi",
    googlePlacesApi: "googleplacesapi",
    googleRoutesApi: "googleroutesapi",
    googleCalendarId: "googlecalendarid",

    supabaseUrl: "supabaseurl",
    supabaseAnonKey: "supabaseanonkey",

    bookingPrefix: "bookingprefix",
    invoicePrefix: "invoiceprefix",
    statementPrefix: "statementprefix",
    quotePrefix: "quoteprefix",
    dateFormat: "dateformat",
    timeFormat: "timeformat",
    language: "language",
    currencySymbol: "currencysymbol"
};

let settingsCompanyId = null;
let settingsCompanyCode = null;
let settingsRowId = null;
let settingsLoaded = false;
let savedCompanyLogo = "";
let pendingCompanyLogoFile = null;
let pendingCompanyLogoPreviewUrl = "";
const pendingCompanyMediaFiles = {};
const pendingCompanyMediaPreviewUrls = {};

const COMPANY_MEDIA_FIELDS = {
    homeHeroImage: { column: "homeheroimage", kind: "home-hero", preview: "homeHeroImagePreview", fallback: "homeHeroImageFallback", status: "homeHeroImageStatus" },
    bookingHeroImage: { column: "bookingheroimage", kind: "booking-hero", preview: "bookingHeroImagePreview", fallback: "bookingHeroImageFallback", status: "bookingHeroImageStatus" },
    fleetImage: { column: "fleetimage", kind: "fleet", preview: "fleetImagePreview", fallback: "fleetImageFallback", status: "fleetImageStatus" }
};

const COMPANY_LOGO_BUCKET = "company-logos";
const COMPANY_LOGO_MAX_BYTES = 5 * 1024 * 1024;
const COMPANY_LOGO_TYPES = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif"
};

const COMPANY_THEME_DEFAULTS = {
    primaryColour: "#37d4d4",
    secondaryColour: "#111111",
    accentColour: "#d71a1a",
    buttonColour: "#37d4d4",
    buttonTextColour: "#111111",
    adminSidebarColour: "#1f2937"
};

document.addEventListener("DOMContentLoaded", async () => {
    try {
        const context = await window.getAdminCompanyContext();
        settingsCompanyId = context.companyId;
        settingsCompanyCode = context.company?.company_code || null;

        await loadSettings();

        const logoInput = document.getElementById("companyLogo");
        if (logoInput) {
            logoInput.addEventListener("change", previewSelectedCompanyLogo);
        }
        Object.keys(COMPANY_MEDIA_FIELDS).forEach(id => {
            document.getElementById(id)?.addEventListener("change", event => previewSelectedCompanyMedia(id, event));
        });

        bindCompanyThemePreview();

        const saveButton = document.getElementById("saveSettings");

        if (saveButton) {
            saveButton.addEventListener("click", saveSettings);
        }

    } catch (error) {
        console.error("Settings startup error:", error);
    }
});

async function loadSettings() {
    if (!settingsCompanyId) throw new Error("Authenticated company context is unavailable.");

    const pageColumns = new Set(["id", "company_id"]);
    Object.entries(fieldMap).forEach(([htmlId, dbColumn]) => {
        if (document.getElementById(htmlId)) pageColumns.add(dbColumn);
    });
    if (document.getElementById("acceptAdvanceBookings") || document.getElementById("bookWhileClosed")) {
        pageColumns.add("acceptadvancebookings");
        pageColumns.add("bookwhileclosed");
    }

    const { data, error } = await db
        .from("settings")
        .select([...pageColumns].join(","))
        .eq("company_id", settingsCompanyId)
        .maybeSingle();

    if (error) {
        console.error("Error loading settings:", error);
        throw error;
    }

    if (!data || String(data.company_id) !== String(settingsCompanyId)) {
        throw new Error("The settings row for your authenticated company is not accessible. Saving has been disabled.");
    }

    settingsRowId = data.id;
    settingsLoaded = true;

    const loadedData = {
        ...data,
        acceptadvancebookings: data.acceptadvancebookings ?? data.bookwhileclosed ?? false
    };

    savedCompanyLogo = loadedData.companylogo || "";
    renderCompanyLogoPreview(savedCompanyLogo);
    Object.entries(COMPANY_MEDIA_FIELDS).forEach(([id, config]) => {
        renderCompanyMediaPreview(config, loadedData[config.column] || "");
    });

    Object.entries(fieldMap).forEach(([htmlId, dbColumn]) => {
        const el = document.getElementById(htmlId);

        if (!el) return;

        if (el.type === "checkbox") {
            el.checked = !!loadedData[dbColumn];
        } else if (el.type === "file") {
            return;
        } else {
            el.value = loadedData[dbColumn] ?? COMPANY_THEME_DEFAULTS[htmlId] ?? "";
        }
    });

    updateCompanyThemePreview();
}

async function saveSettings() {
    if (!settingsCompanyId || !settingsLoaded || !settingsRowId) {
        alert("Settings were not loaded for your authenticated company, so no save was attempted.");
        return;
    }

    const { data: { user }, error: userError } = await db.auth.getUser();
    if (userError || !user) {
        console.error("Settings save authentication check failed:", userError);
        alert("Your admin session could not be verified. Please sign in again.");
        return;
    }

    const settings = {};

    Object.entries(fieldMap).forEach(([htmlId, dbColumn]) => {
        const el = document.getElementById(htmlId);

        if (!el) return;
        if (el.type === "file") return;

        if (el.type === "checkbox") {
            settings[dbColumn] = el.checked;
        } else if (el.type === "date") {
            settings[dbColumn] = el.value || null;
        } else if (el.type === "time") {
            settings[dbColumn] = el.value || null;
        } else if (el.type === "number") {
            settings[dbColumn] =
                el.value === "" ? null : Number(el.value);
        } else {
            settings[dbColumn] = el.value;
        }
    });

    const stripeEnabledInput = document.getElementById("enableStripe");
    const stripePublishableInput = document.getElementById("stripePublishableKey");
    if (stripeEnabledInput && stripePublishableInput) {
        const publishableKey = stripePublishableInput.value.trim();
        if (stripeEnabledInput.checked && !publishableKey.startsWith("pk_test_")) {
            alert("Enable Stripe requires a valid Stripe test publishable key beginning pk_test_.");
            stripePublishableInput.focus();
            return;
        }
        settings.stripepublishablekey = publishableKey || null;
    }

    const closureCheckbox = document.getElementById("acceptAdvanceBookings") || document.getElementById("bookWhileClosed");
    if (closureCheckbox) {
        settings.acceptadvancebookings = closureCheckbox.checked;
        settings.bookwhileclosed = closureCheckbox.checked;
    }

    try {
        const uploadedLogoUrl = await uploadSelectedCompanyLogo();
        if (uploadedLogoUrl) {
            settings.companylogo = uploadedLogoUrl;
        }
        for (const [id, config] of Object.entries(COMPANY_MEDIA_FIELDS)) {
            const uploadedUrl = await uploadSelectedCompanyMedia(id, config);
            if (uploadedUrl) settings[config.column] = uploadedUrl;
        }
    } catch (error) {
        console.error("Company logo upload error:", error);
        alert(error.message || "The company logo could not be uploaded.");
        return;
    }

    const savedColumns = ["id", "company_id", ...Object.keys(settings)];
    const result = await db
        .from("settings")
        .update(settings)
        .eq("id", settingsRowId)
        .eq("company_id", settingsCompanyId)
        .select([...new Set(savedColumns)].join(","))
        .maybeSingle();

    if (result.error) {
        console.error("Error saving settings:", result.error);
        alert(result.error.message);
        return;
    }

    if (!result.data || String(result.data.id) !== String(settingsRowId) || String(result.data.company_id) !== String(settingsCompanyId)) {
        console.error("Settings save returned no matching company row.", {
            expected_company_id: settingsCompanyId,
            returned_company_id: result.data?.company_id || null
        });
        alert("Settings were not saved. Your account may not have permission to update this company.");
        return;
    }

    if (stripeEnabledInput && (
        result.data.enablestripe !== settings.enablestripe ||
        (result.data.stripepublishablekey || null) !== settings.stripepublishablekey
    )) {
        alert("Stripe settings were not saved as entered. Please refresh and try again.");
        return;
    }

    savedCompanyLogo = result.data.companylogo || savedCompanyLogo;
    if (savedCompanyLogo) {
        const logoInput = document.getElementById("companyLogo");
        if (logoInput) logoInput.value = "";
        pendingCompanyLogoFile = null;
        if (pendingCompanyLogoPreviewUrl) {
            URL.revokeObjectURL(pendingCompanyLogoPreviewUrl);
            pendingCompanyLogoPreviewUrl = "";
        }
        renderCompanyLogoPreview(savedCompanyLogo);
    }
    Object.entries(COMPANY_MEDIA_FIELDS).forEach(([id, config]) => {
        const savedUrl = result.data[config.column];
        if (!savedUrl) return;
        const input = document.getElementById(id);
        if (input) input.value = "";
        pendingCompanyMediaFiles[id] = null;
        if (pendingCompanyMediaPreviewUrls[id]) URL.revokeObjectURL(pendingCompanyMediaPreviewUrls[id]);
        pendingCompanyMediaPreviewUrls[id] = "";
        renderCompanyMediaPreview(config, savedUrl);
    });

    alert("Settings saved successfully.");
}

function previewSelectedCompanyLogo(event) {
    const file = event.target.files?.[0];

    if (!file) {
        pendingCompanyLogoFile = null;
        if (pendingCompanyLogoPreviewUrl) {
            URL.revokeObjectURL(pendingCompanyLogoPreviewUrl);
            pendingCompanyLogoPreviewUrl = "";
        }
        renderCompanyLogoPreview(savedCompanyLogo);
        return;
    }

    try {
        validateCompanyLogo(file);
    } catch (error) {
        pendingCompanyLogoFile = null;
        event.target.value = "";
        renderCompanyLogoPreview(savedCompanyLogo);
        alert(error.message);
        return;
    }

    pendingCompanyLogoFile = file;
    console.info("Company logo selected", {
        company_code: settingsCompanyCode,
        file_name: file.name,
        file_size: file.size,
        file_type: file.type
    });

    if (pendingCompanyLogoPreviewUrl) {
        URL.revokeObjectURL(pendingCompanyLogoPreviewUrl);
    }

    pendingCompanyLogoPreviewUrl = URL.createObjectURL(file);
    renderCompanyLogoPreview(pendingCompanyLogoPreviewUrl, "Selected logo preview. Save changes to upload it.");
}

function validateCompanyLogo(file) {
    if (!(file instanceof File) || file.size <= 0 || !file.type.startsWith("image/")) {
        throw new Error("Please choose a valid logo image.");
    }

    if (!COMPANY_LOGO_TYPES[file.type]) {
        throw new Error("Choose a PNG, JPG, WebP or GIF image.");
    }

    if (file.size > COMPANY_LOGO_MAX_BYTES) {
        throw new Error("The company logo must be 5 MB or smaller.");
    }
}

async function uploadSelectedCompanyLogo() {
    const file = pendingCompanyLogoFile;
    if (!file) {
        console.info("Company logo upload skipped", {
            company_code: settingsCompanyCode,
            reason: "no_new_file"
        });
        return "";
    }

    validateCompanyLogo(file);

    return uploadCompanyImage(file, "logo");
}

function previewSelectedCompanyMedia(id, event) {
    const config = COMPANY_MEDIA_FIELDS[id];
    const file = event.target.files?.[0];
    if (!config || !file) {
        pendingCompanyMediaFiles[id] = null;
        if (pendingCompanyMediaPreviewUrls[id]) {
            URL.revokeObjectURL(pendingCompanyMediaPreviewUrls[id]);
            pendingCompanyMediaPreviewUrls[id] = "";
        }
        return;
    }
    try {
        validateCompanyLogo(file);
    } catch (error) {
        pendingCompanyMediaFiles[id] = null;
        event.target.value = "";
        alert(error.message);
        return;
    }
    pendingCompanyMediaFiles[id] = file;
    if (pendingCompanyMediaPreviewUrls[id]) URL.revokeObjectURL(pendingCompanyMediaPreviewUrls[id]);
    pendingCompanyMediaPreviewUrls[id] = URL.createObjectURL(file);
    renderCompanyMediaPreview(config, pendingCompanyMediaPreviewUrls[id], "Selected image preview. Save changes to upload it.");
}

async function uploadSelectedCompanyMedia(id, config) {
    const file = pendingCompanyMediaFiles[id];
    if (!file) return "";
    validateCompanyLogo(file);
    return uploadCompanyImage(file, config.kind);
}

async function uploadCompanyImage(file, kind) {
    const extension = COMPANY_LOGO_TYPES[file.type];
    const originalStem = file.name.replace(/\.[^.]+$/, "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || kind;
    const storagePath = `${settingsCompanyId}/${kind}-${Date.now()}-${originalStem}.${extension}`;
    console.info("Uploading company image", { company_code: settingsCompanyCode, media_type: kind, file_name: file.name, file_size: file.size, file_type: file.type, upload_path: storagePath });
    const { error } = await db.storage
        .from(COMPANY_LOGO_BUCKET)
        .upload(storagePath, file, {
            cacheControl: "3600",
            contentType: file.type,
            upsert: false
        });

    if (error) throw error;

    const { data } = db.storage
        .from(COMPANY_LOGO_BUCKET)
        .getPublicUrl(storagePath);

    if (!data?.publicUrl) {
        throw new Error("Supabase did not return a public URL for the uploaded image.");
    }

    return data.publicUrl;
}

function renderCompanyMediaPreview(config, url, statusMessage = "") {
    const preview = document.getElementById(config.preview);
    const fallback = document.getElementById(config.fallback);
    const status = document.getElementById(config.status);
    if (!preview || !fallback) return;
    if (url) {
        preview.src = url;
        preview.hidden = false;
        fallback.hidden = true;
        preview.onerror = () => { preview.hidden = true; fallback.hidden = false; fallback.textContent = "The saved image could not be loaded."; };
    } else {
        preview.removeAttribute("src");
        preview.hidden = true;
        fallback.hidden = false;
    }
    if (statusMessage && status) status.textContent = statusMessage;
}

function renderCompanyLogoPreview(url, statusMessage = "") {
    const preview = document.getElementById("companyLogoPreview");
    const fallback = document.getElementById("companyLogoPreviewFallback");
    const status = document.getElementById("companyLogoStatus");
    if (!preview || !fallback) return;

    if (url) {
        preview.src = url;
        preview.style.display = "block";
        fallback.style.display = "none";
        preview.onerror = () => {
            preview.style.display = "none";
            fallback.style.display = "inline";
            fallback.textContent = "The saved logo could not be loaded.";
        };
    } else {
        preview.removeAttribute("src");
        preview.style.display = "none";
        fallback.style.display = "inline";
        fallback.textContent = "No company logo saved.";
    }

    if (status && statusMessage) status.textContent = statusMessage;
}

function bindCompanyThemePreview() {
    Object.keys(COMPANY_THEME_DEFAULTS).forEach(id => {
        document.getElementById(id)?.addEventListener("input", updateCompanyThemePreview);
    });
    updateCompanyThemePreview();
}

function updateCompanyThemePreview() {
    const preview = document.getElementById("companyThemePreview");
    if (!preview) return;

    preview.style.setProperty("--preview-primary", themeFieldValue("primaryColour"));
    preview.style.setProperty("--preview-secondary", themeFieldValue("secondaryColour"));
    preview.style.setProperty("--preview-accent", themeFieldValue("accentColour"));
    preview.style.setProperty("--preview-button", themeFieldValue("buttonColour"));
    preview.style.setProperty("--preview-button-text", themeFieldValue("buttonTextColour"));
    preview.style.setProperty("--preview-sidebar", themeFieldValue("adminSidebarColour"));
}

function themeFieldValue(id) {
    return document.getElementById(id)?.value || COMPANY_THEME_DEFAULTS[id];
}
