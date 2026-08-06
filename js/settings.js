const db = getSupabase();

const fieldMap = {

    companyName: "companyname",
    tradingName: "tradingname",
    companyPhone: "companyphone",
    companyEmail: "companyemail",
    companyWebsite: "companywebsite",
    companyAddress: "companyaddress",
    companyLogo: "companylogo",

    operatorLicence: "operatorlicence",
    companyRegistration: "companyregistration",
    vatNumber: "vatnumber",

    currency: "currency",
    timeZone: "timezone",

    businessStatus: "businessstatus",
    holidayFrom: "holidayfrom",
    holidayTo: "holidayto",
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

    bookWhileClosed: "bookwhileclosed",

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

    quotePrefix: "quoteprefix",

    dateFormat: "dateformat",

    timeFormat: "timeformat",

    language: "language",

    currencySymbol: "currencysymbol"

};

document.addEventListener("DOMContentLoaded", () => {

    loadSettings();

    document.getElementById("saveSettings").addEventListener("click", saveSettings);

});

async function loadSettings() {

    const { data } = await db
        .from("settings")
        .select("*")
        .limit(1)
        .maybeSingle();

    if (!data) return;

    Object.entries(fieldMap).forEach(([htmlId, dbColumn]) => {

        const el = document.getElementById(htmlId);

        if (!el) return;

        if (el.type === "checkbox")
            el.checked = !!data[dbColumn];
        else
            el.value = data[dbColumn] ?? "";

    });

}

async function saveSettings() {

    const settings = {};

    Object.entries(fieldMap).forEach(([htmlId, dbColumn]) => {

        const el = document.getElementById(htmlId);

        if (!el) return;

        settings[dbColumn] =
            el.type === "checkbox"
                ? el.checked
                : el.value;

    });

    const { data: existing } = await db
        .from("settings")
        .select("id")
        .limit(1)
        .maybeSingle();

    if (existing) {

        await db
            .from("settings")
            .update(settings)
            .eq("id", existing.id);

    } else {

        await db
            .from("settings")
            .insert(settings);

    }

    alert("Settings saved.");

}