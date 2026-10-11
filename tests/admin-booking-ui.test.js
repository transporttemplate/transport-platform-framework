const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "../bookings.html"), "utf8");
const source = fs.readFileSync(path.join(__dirname, "../js/bookings.js"), "utf8");

test("new admin bookings require an explicitly entered passenger count", () => {
    const passengerInput = html.match(/<input id="passengers"[^>]*>/)?.[0] || "";
    assert.match(passengerInput, /placeholder="Passengers"/);
    assert.match(passengerInput, /required/);
    assert.match(passengerInput, /min="1"/);
    assert.match(passengerInput, /max="52"/);
    assert.doesNotMatch(passengerInput, /value=/);
    assert.match(source, /Enter the number of passengers\./);
    assert.doesNotMatch(source, /getElementById\("passengers"\)[\s\S]{0,100}\?\.value \|\| 1\s*\n\s*\)/);
});

test("admin luggage controls are bounded and persisted in the booking payload", () => {
    for (const id of ["suitcases", "handLuggage"]) {
        const input = html.match(new RegExp(`<input id="${id}"[^>]*>`))?.[0] || "";
        assert.match(input, /type="number"/);
        assert.match(input, /min="0"/);
        assert.match(input, /max="100"/);
        assert.match(input, /step="1"/);
        assert.match(input, /value="0"/);
    }
    assert.match(source, /suitcases: luggageValues\.suitcases/);
    assert.match(source, /hand_luggage: luggageValues\.hand_luggage/);
    assert.match(source, /Number\.isInteger\(value\) \|\| value < 0 \|\| value > 100/);
});

test("admin booking layout has coordinated responsive form and map panels", () => {
    assert.match(html, /class="passenger-luggage-grid"/);
    assert.match(html, /\.map-panel\{align-self:start/);
    assert.match(html, /@media\(max-width:520px\)[\s\S]*\.passenger-luggage-grid\{grid-template-columns:1fr\}/);
    assert.match(html, /id="dispatchMap"/);
    assert.match(html, /id="recalculateQuote"/);
    assert.match(html, /class="driver-dot"/);
});

test("existing booking detail remains null-safe for historical passenger and luggage data", () => {
    assert.match(source, /booking\.passengers \?\?/);
    assert.match(source, /booking\.suitcases \?\?/);
    assert.match(source, /booking\.hand_luggage \?\?/);
});
