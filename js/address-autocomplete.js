(function initialiseTransportAddressAutocomplete() {
    let mapsPromise = null;
    const providers = [];
    const ukBounds = { north: 61.0, south: 49.5, east: 2.0, west: -8.7 };

    function loadGoogleMaps(apiKey) {
        if (window.google?.maps?.places?.Autocomplete) return Promise.resolve(window.google.maps);
        if (mapsPromise) return mapsPromise;

        mapsPromise = new Promise((resolve, reject) => {
            const existing = document.querySelector('script[data-transport-google-maps="true"]');
            if (existing) {
                existing.addEventListener("load", () => resolve(window.google.maps), { once: true });
                existing.addEventListener("error", () => reject(new Error("Google Maps JavaScript API failed to load.")), { once: true });
                return;
            }

            const callbackName = `__transportGoogleMapsLoaded_${Date.now()}`;
            window[callbackName] = () => {
                delete window[callbackName];
                resolve(window.google.maps);
            };
            const script = document.createElement("script");
            script.dataset.transportGoogleMaps = "true";
            script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&libraries=places&v=weekly&loading=async&callback=${callbackName}`;
            script.async = true;
            script.onerror = () => {
                delete window[callbackName];
                mapsPromise = null;
                reject(new Error("Google Maps JavaScript API failed to load."));
            };
            document.head.appendChild(script);
        });
        return mapsPromise;
    }

    function clearMetadata(input) {
        delete input.dataset.placeId;
        delete input.dataset.lat;
        delete input.dataset.lng;
        delete input.dataset.postcode;
        delete input.dataset.placeName;
    }

    function placeDetails(place) {
        const location = place?.geometry?.location;
        return {
            formattedAddress: place?.formatted_address || place?.name || "",
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
            const details = placeDetails(place);
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
            placeName: input?.dataset.placeName || null
        };
    }

    window.TransportAddressAutocomplete = {
        loadGoogleMaps,
        attach,
        metadata,
        registerProvider(provider) { if (provider && !providers.includes(provider)) providers.push(provider); }
    };
})();
