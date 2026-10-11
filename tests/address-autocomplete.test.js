const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const autocompleteSource = fs.readFileSync(path.join(__dirname, "../js/address-autocomplete.js"), "utf8");
const adminSource = fs.readFileSync(path.join(__dirname, "../js/bookings.js"), "utf8");
const secondaryAdminSource = fs.readFileSync(path.join(__dirname, "../js/all-bookings.js"), "utf8");
const publicCreateSource = fs.readFileSync(path.join(__dirname, "../supabase/functions/public-booking-create/index.ts"), "utf8");

function addressHarness() {
    let autocomplete;
    class FakeAutocomplete {
        constructor(input, options) {
            this.input = input;
            this.options = options;
            this.listeners = {};
            autocomplete = this;
        }
        addListener(name, callback) { this.listeners[name] = callback; }
        getPlace() { return this.place; }
    }
    const google = { maps: { places: { Autocomplete: FakeAutocomplete } } };
    const window = { google };
    vm.runInNewContext(autocompleteSource, {
        window,
        google,
        document: { getElementById() { return null; }, querySelector() { return null; } },
        Date,
        Number,
        String,
        Promise,
        Error,
        encodeURIComponent,
        setTimeout,
        clearTimeout
    });
    const inputListeners = {};
    const input = {
        value: "",
        dataset: {},
        addEventListener(name, callback) { inputListeners[name] = callback; }
    };
    window.TransportAddressAutocomplete.attach(input);
    return { window, input, inputListeners, autocomplete: () => autocomplete };
}

function selectPlace(harness, { label, name, canonical, postcode = "", placeId = "place-1" }) {
    const instance = harness.autocomplete();
    instance.place = {
        name,
        formatted_address: canonical,
        place_id: placeId,
        geometry: { location: { lat: () => 51.3971, lng: () => -3.3428 } },
        address_components: postcode ? [{ long_name: postcode, types: ["postal_code"] }] : []
    };
    harness.input.value = label;
    instance.listeners.place_changed();
    return harness.window.TransportAddressAutocomplete.metadata(harness.input);
}

test("selected Google prediction labels remain visible for airports, hotels, postcodes and ordinary addresses", () => {
    const cases = [
        {
            label: "Cardiff Airport (CWL), Rhoose, Barry, UK",
            expected: "Cardiff Airport (CWL), Rhoose, Barry",
            name: "Cardiff Airport",
            canonical: "Rhoose, Barry CF62 3BD, UK",
            postcode: "CF62 3BD"
        },
        {
            label: "Ivy Bush Royal Hotel by Compass Hospitality, Spilman Street, Carmarthen, UK",
            expected: "Ivy Bush Royal Hotel by Compass Hospitality, Spilman Street, Carmarthen",
            name: "Ivy Bush Royal Hotel by Compass Hospitality",
            canonical: "11 Spilman St, Carmarthen SA31 1LG, UK",
            postcode: "SA31 1LG"
        },
        {
            label: "SA31 1GA, Carmarthen, UK",
            expected: "SA31 1GA, Carmarthen",
            name: "SA31 1GA",
            canonical: "Carmarthen SA31 1GA, UK",
            postcode: "SA31 1GA"
        },
        {
            label: "10 King Street, Carmarthen, UK",
            expected: "10 King Street, Carmarthen",
            name: "10",
            canonical: "10 King St, Carmarthen SA31 1BD, UK",
            postcode: "SA31 1BD"
        }
    ];

    for (const entry of cases) {
        const harness = addressHarness();
        const metadata = selectPlace(harness, entry);
        assert.equal(harness.input.value, entry.expected);
        assert.equal(metadata.displayAddress, entry.expected);
        assert.equal(metadata.canonicalAddress, entry.canonical);
        assert.equal(metadata.placeName, entry.name);
        assert.equal(metadata.postcode, entry.postcode);
        assert.equal(metadata.placeId, "place-1");
        assert.equal(metadata.latitude, 51.3971);
        assert.equal(metadata.longitude, -3.3428);
    }
});

test("manual address edits clear every selected-place field", () => {
    const harness = addressHarness();
    selectPlace(harness, {
        label: "Bristol Airport (BRS), Bristol, UK",
        name: "Bristol Airport",
        canonical: "Bristol BS48 3DY, UK",
        postcode: "BS48 3DY"
    });
    harness.input.value = "Bristol Airport changed manually";
    harness.inputListeners.input();
    const metadata = harness.window.TransportAddressAutocomplete.metadata(harness.input);
    assert.equal(metadata.placeId, null);
    assert.equal(metadata.latitude, null);
    assert.equal(metadata.longitude, null);
    assert.equal(metadata.postcode, null);
    assert.equal(metadata.placeName, null);
    assert.equal(metadata.canonicalAddress, null);
    assert.equal(metadata.displayAddress, "Bristol Airport changed manually");
});

test("both Admin forms include selected place metadata in fixed-airport recognition", () => {
    for (const source of [adminSource, secondaryAdminSource]) {
        assert.match(source, /metadata\("pickupAddress"\)/);
        assert.match(source, /metadata\("dropoffAddress"\)/);
        assert.match(source, /pickup\.placeName/);
        assert.match(source, /dropoff\.placeName/);
        assert.match(source, /pickup\.displayAddress/);
        assert.match(source, /dropoff\.displayAddress/);
    }
});

test("public booking verification keeps canonical metadata while persisting the selected display label", () => {
    assert.match(publicCreateSource, /pickup_address: route\.origin\.displayAddress/);
    assert.match(publicCreateSource, /dropoff_address: route\.destination\.displayAddress/);
    assert.match(publicCreateSource, /const canonicalAddress = String\(location\.formatted_address/);
    assert.match(publicCreateSource, /const selectedDisplayAddress = clean\(placeId\)/);
    assert.match(publicCreateSource, /replace\(\/\[\\u0000-\\u001f\\u007f\]\//);
    assert.match(publicCreateSource, /trim\(\)\.slice\(0, 300\)/);
    assert.match(publicCreateSource, /formattedAddress: canonicalAddress/);
    assert.match(publicCreateSource, /displayAddress: String\(selectedDisplayAddress \|\| canonicalAddress\)/);
    assert.match(publicCreateSource, /origin: \{ placeId: origin\.placeId \}/);
    assert.match(publicCreateSource, /destination: \{ placeId: destination\.placeId \}/);
});
