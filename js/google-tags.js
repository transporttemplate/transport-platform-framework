(function initialiseGoogleTags(global) {
    "use strict";

    const state = { loadedIds: new Set(), companyCode: null, loaderAdded: false };
    const cleanId = value => String(value || "").trim();

    function configure(config = {}) {
        const measurementId = cleanId(config.measurementId || config.googleanalyticsid);
        const adsId = cleanId(config.adsId || config.googleadsid);
        state.companyCode = config.companyCode || state.companyCode;
        [measurementId, adsId].filter(Boolean).forEach(loadId);
        return { measurementId, adsId, conversionLabel: cleanId(config.conversionLabel || config.googleadsconversionlabel) };
    }

    function configureFromSettings(settings = {}, companyCode) {
        return configure({ ...settings, companyCode });
    }

    function loadId(id) {
        if (state.loadedIds.has(id)) return;
        ensureDataLayer();
        if (!state.loaderAdded && !document.querySelector('script[data-google-tag-loader]')) {
            const script = document.createElement("script");
            script.async = true;
            script.dataset.googleTagLoader = "true";
            script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}`;
            document.head.appendChild(script);
            state.loaderAdded = true;
        }
        global.gtag("js", new Date());
        global.gtag("config", id);
        state.loadedIds.add(id);
    }

    function ensureDataLayer() {
        global.dataLayer = global.dataLayer || [];
        global.gtag = global.gtag || function gtag() { global.dataLayer.push(arguments); };
    }

    function event(name, parameters = {}) {
        if (!state.loadedIds.size || !name) return false;
        ensureDataLayer();
        global.gtag("event", name, { company_code: state.companyCode, ...parameters });
        return true;
    }

    global.GoogleTags = Object.freeze({
        configure,
        configureFromSettings,
        event,
        bookingStarted: parameters => event("booking_started", parameters),
        bookingSubmitted: parameters => event("booking_submitted", parameters),
        paymentStarted: parameters => event("payment_started", parameters),
        paymentCompleted: parameters => event("payment_completed", parameters)
    });

    if (global.GOOGLE_TAG_CONFIG) configure(global.GOOGLE_TAG_CONFIG);
})(window);
