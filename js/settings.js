const db = getSupabase();

const fieldMap = {
    companyName: "companyname",
    tradingName: "tradingname",
    companyPhone: "companyphone",
    companyEmail: "companyemail",
    companyWebsite: "companywebsite",
    companyAddress: "companyaddress",
    companyLogo: "companylogo",
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
    stripeSecretKey: "stripesecretkey",
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
let savedCompanyLogo = "";
let pendingCompanyLogoPreviewUrl = "";

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

        await loadSettings();

        const logoInput = document.getElementById("companyLogo");
        if (logoInput) {
            logoInput.addEventListener("change", previewSelectedCompanyLogo);
        }

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
    if (!settingsCompanyId) return;

    const { data, error } = await db
        .from("settings")
        .select("*")
        .eq("company_id", settingsCompanyId)
        .maybeSingle();

    if (error) {
        console.error("Error loading settings:", error);
        return;
    }

    savedCompanyLogo = data?.companylogo || "";
    renderCompanyLogoPreview(savedCompanyLogo);

    Object.entries(fieldMap).forEach(([htmlId, dbColumn]) => {
        const el = document.getElementById(htmlId);

        if (!el) return;

        if (el.type === "checkbox") {
            el.checked = !!data[dbColumn];
        } else if (el.type === "file") {
            return;
        } else {
            el.value = data?.[dbColumn] ?? COMPANY_THEME_DEFAULTS[htmlId] ?? "";
        }
    });

    updateCompanyThemePreview();
}

async function saveSettings() {
    if (!settingsCompanyId) {
        alert("Unable to identify company.");
        return;
    }

    const settings = {
        company_id: settingsCompanyId
    };

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

    try {
        const uploadedLogoUrl = await uploadSelectedCompanyLogo();
        if (uploadedLogoUrl) {
            settings.companylogo = uploadedLogoUrl;
        }
    } catch (error) {
        console.error("Company logo upload error:", error);
        alert(error.message || "The company logo could not be uploaded.");
        return;
    }

    const { data: existing, error: existingError } = await db
        .from("settings")
        .select("id")
        .eq("company_id", settingsCompanyId)
        .maybeSingle();

    if (existingError) {
        console.error("Error finding settings:", existingError);
        alert(existingError.message);
        return;
    }

    let result;

    if (existing) {
        result = await db
            .from("settings")
            .update(settings)
            .eq("id", existing.id)
            .eq("company_id", settingsCompanyId)
            .select("company_id,companyname,tradingname,companyphone,companyemail,companyaddress,companylogo")
            .maybeSingle();
    } else {
        result = await db
            .from("settings")
            .insert(settings)
            .select("company_id,companyname,tradingname,companyphone,companyemail,companyaddress,companylogo")
            .single();
    }

    if (result.error) {
        console.error("Error saving settings:", result.error);
        alert(result.error.message);
        return;
    }

    if (!result.data || String(result.data.company_id) !== String(settingsCompanyId)) {
        console.error("Settings save returned no matching company row.", {
            expected_company_id: settingsCompanyId,
            returned_company_id: result.data?.company_id || null
        });
        alert("Settings were not saved. Your account may not have permission to update this company.");
        return;
    }

    savedCompanyLogo = result.data.companylogo || savedCompanyLogo;
    if (savedCompanyLogo) {
        const logoInput = document.getElementById("companyLogo");
        if (logoInput) logoInput.value = "";
        renderCompanyLogoPreview(savedCompanyLogo);
    }

    alert("Settings saved successfully.");
}

function previewSelectedCompanyLogo(event) {
    const file = event.target.files?.[0];

    if (!file) {
        renderCompanyLogoPreview(savedCompanyLogo);
        return;
    }

    try {
        validateCompanyLogo(file);
    } catch (error) {
        event.target.value = "";
        renderCompanyLogoPreview(savedCompanyLogo);
        alert(error.message);
        return;
    }

    if (pendingCompanyLogoPreviewUrl) {
        URL.revokeObjectURL(pendingCompanyLogoPreviewUrl);
    }

    pendingCompanyLogoPreviewUrl = URL.createObjectURL(file);
    renderCompanyLogoPreview(pendingCompanyLogoPreviewUrl, "Selected logo preview. Save changes to upload it.");
}

function validateCompanyLogo(file) {
    if (!COMPANY_LOGO_TYPES[file.type]) {
        throw new Error("Choose a PNG, JPG, WebP or GIF image.");
    }

    if (file.size > COMPANY_LOGO_MAX_BYTES) {
        throw new Error("The company logo must be 5 MB or smaller.");
    }
}

async function uploadSelectedCompanyLogo() {
    const logoInput = document.getElementById("companyLogo");
    const file = logoInput?.files?.[0];
    if (!file) return "";

    validateCompanyLogo(file);

    const extension = COMPANY_LOGO_TYPES[file.type];
    const storagePath = `${settingsCompanyId}/logo-${Date.now()}.${extension}`;
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
        throw new Error("Supabase did not return a public URL for the uploaded logo.");
    }

    return data.publicUrl;
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
