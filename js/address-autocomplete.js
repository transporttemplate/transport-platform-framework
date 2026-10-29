(function initialiseTransportAddressAutocomplete() {
    let mapsPromise = null;
    let mapsLoaderKey = "";
    const providers = [];
    const ukBounds = { north: 61.0, south: 49.5, east: 2.0, west: -8.7 };

    function loadGoogleMaps(apiKey) {
        const key = String(apiKey || "").trim();
        if (!key) return Promise.reject(new Error("Google Maps is not configured for this company."));
        if (window.google?.maps?.places?.Autocomplete) return Promise.resolve(window.google.maps);
        if (mapsPromise && mapsLoaderKey === key) return mapsPromise;
        if (mapsPromise && mapsLoaderKey !== key) return Promise.reject(new Error("A different company Google Maps key is already loaded. Reload this page after switching company."));
        mapsLoaderKey = key;

        mapsPromise = new Promise((resolve, reject) => {
            const existing = document.querySelector('script[data-transport-google-maps="true"]');
            if (existing) {
                if (window.google?.maps) return ready(resolve, reject);
                existing.addEventListener("load", () => ready(resolve, reject), { once: true });
                existing.addEventListener("error", () => fail(reject, "Google Maps JavaScript API failed to load."), { once: true });
                return;
            }

            const callbackName = `__transportGoogleMapsLoaded_${Date.now()}`;
            window[callbackName] = () => {
                delete window[callbackName];
                ready(resolve, reject);
            };
            const previousAuthFailure = window.gm_authFailure;
            window.gm_authFailure = () => {
                previousAuthFailure?.();
                fail(reject, "Google Maps rejected this company's browser key. Check billing, referrer restrictions, and the Maps JavaScript and Places APIs.");
            };
            const script = document.createElement("script");
            script.dataset.transportGoogleMaps = "true";
            script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&libraries=places&v=weekly&loading=async&callback=${callbackName}`;
            script.async = true;
            script.onerror = () => {
                delete window[callbackName];
                fail(reject, "Google Maps JavaScript API failed to load. Check the network and this company's key restrictions.");
            };
            document.head.appendChild(script);
            setTimeout(() => {
                if (!window.google?.maps?.places?.Autocomplete) fail(reject, "Google Maps timed out while loading for this company.");
            }, 15000);
        });
        return mapsPromise;

        async function ready(resolve, reject) {
            try {
                if (!window.google?.maps?.places?.Autocomplete && window.google?.maps?.importLibrary) await window.google.maps.importLibrary("places");
                if (!window.google?.maps?.places?.Autocomplete) throw new Error("Google Places is not enabled for this company's browser key.");
                resolve(window.google.maps);
            } catch (error) { fail(reject, error.message || "Google Places failed to initialise."); }
        }
        function fail(reject, message) {
            mapsPromise = null;
            mapsLoaderKey = "";
            reject(new Error(message));
        }
    }

    async function resolveBrowserMapsKey(_db, _company, configuredKey) {
        const ownKey = String(configuredKey || "").trim();
        return ownKey;
    }

    function clearMetadata(input) {
        delete input.dataset.placeId;
        delete input.dataset.lat;
        delete input.dataset.lng;
        delete input.dataset.postcode;
        delete input.dataset.placeName;
        delete input.dataset.displayAddress;
        delete input.dataset.canonicalAddress;
    }

    function displayAddress(selectedLabel, fallback) {
        return String(selectedLabel || fallback || "")
            .trim()
            .replace(/,\s*UK$/i, "");
    }

    function placeDetails(place, selectedLabel) {
        const location = place?.geometry?.location;
        const canonicalAddress = place?.formatted_address || place?.name || "";
        return {
            formattedAddress: displayAddress(selectedLabel, canonicalAddress),
            canonicalAddress,
            placeId: place?.place_id || "",
            latitude: location ? location.lat() : null,
            longitude: location ? location.lng() : null,
            postcode: (place?.address_components || []).find(component => component.types.includes("postal_code"))?.long_name || "",
            placeName: place?.name || ""
        };
    }

    function applyDetails(input, details) {
        input.value = details.formattedAddress;
        input.dataset.placeId = details.placeId;
        input.dataset.lat = details.latitude ?? "";
        input.dataset.lng = details.longitude ?? "";
        input.dataset.postcode = details.postcode;
        input.dataset.placeName = details.placeName;
        input.dataset.displayAddress = details.formattedAddress;
        input.dataset.canonicalAddress = details.canonicalAddress;
    }

    function attach(inputOrId, options = {}) {
        const input = typeof inputOrId === "string" ? document.getElementById(inputOrId) : inputOrId;
        if (!input || input.dataset.transportAutocompleteBound === "true") return null;
        if (!window.google?.maps?.places?.Autocomplete) throw new Error("Google Places is not loaded.");

        input.dataset.transportAutocompleteBound = "true";
        input.autocomplete = "off";
        if (options.placeholder) input.placeholder = options.placeholder;
        input.addEventListener("input", () => {
            clearMetadata(input);
            options.onInput?.(input);
            for (const provider of providers) provider.onInput?.(input, options);
        });

        const autocomplete = new google.maps.places.Autocomplete(input, {
            componentRestrictions: { country: "gb" },
            bounds: ukBounds,
            strictBounds: false,
            fields: ["formatted_address", "geometry", "name", "place_id", "address_components"]
        });
        autocomplete.addListener("place_changed", () => {
            const place = autocomplete.getPlace();
            if (!place?.geometry?.location) return;
            const selectedLabel = input.value;
            const details = placeDetails(place, selectedLabel);
            applyDetails(input, details);
            options.onSelect?.(details, input, place);
        });
        return autocomplete;
    }

    function metadata(inputOrId) {
        const input = typeof inputOrId === "string" ? document.getElementById(inputOrId) : inputOrId;
        return {
            formattedAddress: input?.value.trim() || "",
            placeId: input?.dataset.placeId || null,
            latitude: input?.dataset.lat ? Number(input.dataset.lat) : null,
            longitude: input?.dataset.lng ? Number(input.dataset.lng) : null,
            postcode: input?.dataset.postcode || null,
            placeName: input?.dataset.placeName || null,
            displayAddress: input?.dataset.displayAddress || input?.value.trim() || "",
            canonicalAddress: input?.dataset.canonicalAddress || null
        };
    }

    window.TransportAddressAutocomplete = {
        loadGoogleMaps,
        resolveBrowserMapsKey,
        attach,
        metadata,
        setMetadata(inputOrId, details = {}) {
            const input = typeof inputOrId === "string" ? document.getElementById(inputOrId) : inputOrId;
            if (!input) return;
            applyDetails(input, {
                formattedAddress: details.formattedAddress || "",
                canonicalAddress: details.canonicalAddress || details.formattedAddress || "",
                placeId: details.placeId || "",
                latitude: details.latitude ?? "",
                longitude: details.longitude ?? "",
                postcode: details.postcode || "",
                placeName: details.placeName || ""
            });
        },
        clearMetadata,
        registerProvider(provider) { if (provider && !providers.includes(provider)) providers.push(provider); }
    };
})();
