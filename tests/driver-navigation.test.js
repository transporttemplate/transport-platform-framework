const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const navigation = require("../js/driver-navigation.js");

const job = status => ({ id: "booking-1", status, pickup_name: "Cardiff Airport (CWL), Rhoose, Barry", pickup_address: "Rhoose, Barry CF62 3BD, UK", dropoff_name: "The Parkgate Hotel, Cardiff", dropoff_address: "Westgate Street, Cardiff", via_stops: [{ formatted_address: "Cardiff Central Station" }] });

test("authoritative booking status chooses pickup before collection and dropoff afterwards", () => {
    assert.equal(navigation.navigationTarget(job("accepted")), "pickup");
    assert.equal(navigation.navigationTarget(job("on_way")), "pickup");
    assert.equal(navigation.navigationTarget(job("arrived")), "pickup");
    assert.equal(navigation.canNavigate(job("arrived")), true);
    assert.equal(navigation.navigationTarget(job("passenger_onboard")), "dropoff");
    assert.equal(navigation.canNavigate(job("cancelled")), false);
    assert.equal(navigation.canNavigate(job("completed")), false);
});

test("external fallback keeps the pickup name before collection and stops after collection", () => {
    const pickupUrl = new URL(navigation.externalMapsUrl(job("on_way")));
    assert.equal(pickupUrl.searchParams.get("destination"), "Cardiff Airport (CWL), Rhoose, Barry");
    assert.equal(pickupUrl.searchParams.has("waypoints"), false);
    const dropoffUrl = new URL(navigation.externalMapsUrl(job("passenger_onboard")));
    assert.equal(dropoffUrl.searchParams.get("destination"), "The Parkgate Hotel, Cardiff");
    assert.equal(dropoffUrl.searchParams.get("waypoints"), "Cardiff Central Station");
});

test("polyline decoding and distance calculations are stable", () => {
    const pathPoints = navigation.decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@");
    assert.deepEqual(pathPoints[0], { lat: 38.5, lng: -120.2 });
    assert.equal(pathPoints.length, 3);
    assert.ok(navigation.metresBetween(pathPoints[0], pathPoints[1]) > 100000);
    assert.equal(navigation.distanceToPath(pathPoints[0], pathPoints), 0);
});

test("rerouting requires accurate repeated off-route fixes and a cooldown", () => {
    const state = { routePath: [{ lat: 51.5, lng: -3.2 }], offRouteFixes: 2, lastRouteAt: 0, minimumRerouteMs: 45000 };
    assert.equal(navigation.shouldReroute(state, { lat: 51.51, lng: -3.2, accuracy: 10 }, 60000).reroute, true);
    assert.equal(navigation.shouldReroute({ ...state, offRouteFixes: 0 }, { lat: 51.51, lng: -3.2, accuracy: 10 }, 60000).reroute, false);
    assert.equal(navigation.shouldReroute(state, { lat: 51.51, lng: -3.2, accuracy: 200 }, 60000).reroute, false);
    assert.equal(navigation.shouldReroute({ ...state, lastRouteAt: 40000 }, { lat: 51.51, lng: -3.2, accuracy: 10 }, 60000).reroute, false);
});

test("spoken directions are off by default and duplicate instructions are suppressed", () => {
    const spoken = [];
    const previousSpeech = globalThis.speechSynthesis;
    const PreviousUtterance = globalThis.SpeechSynthesisUtterance;
    globalThis.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
    globalThis.speechSynthesis = { cancel() {}, speak(value) { spoken.push(value.text); }, getVoices() { return []; } };
    try {
        const controller = new navigation.Controller({});
        controller.steps = [{ instruction: "Turn left" }];
        controller.speakCurrent();
        assert.deepEqual(spoken, []);
        controller.setVoice(true);
        controller.speakCurrent();
        assert.deepEqual(spoken, ["Turn left"]);
        controller.stop();
        assert.equal(controller.voiceEnabled, false);
    } finally {
        globalThis.speechSynthesis = previousSpeech;
        globalThis.SpeechSynthesisUtterance = PreviousUtterance;
    }
});

test("driver-follow camera uses stable heading and street-level speed-aware zoom", () => {
    assert.equal(navigation.usableHeading(null), null);
    assert.equal(navigation.smoothHeading(350, 10, 8), 8);
    assert.equal(navigation.smoothHeading(90, null, 8), 90);
    assert.equal(navigation.smoothHeading(90, 180, 0.5), 90);
    assert.equal(navigation.navigationZoom(0, 1000, 10), 18);
    assert.equal(navigation.navigationZoom(30, 1000, 10), 16.5);
    assert.equal(navigation.navigationZoom(20, 100, 10), 18.5);
    assert.equal(navigation.navigationZoom(5, 1000, 120), 16.5);
});

test("GPS loss is detected without discarding the last route", () => {
    assert.equal(navigation.gpsIsStale({ timestamp: 1000 }, 30000), false);
    assert.equal(navigation.gpsIsStale({ timestamp: 1000 }, 32000), true);
    assert.equal(navigation.gpsIsStale(null, 32000), true);
});

test("route failures remain inside the portal with a sanitised fallback status", async () => {
    const statuses = [];
    const controller = new navigation.Controller({
        routeRequest: async () => { throw new Error("Navigation route is temporarily unavailable"); },
        onStatus: (message, error) => statuses.push({ message, error })
    });
    await controller.start(job("on_way"), { lat: 51.48, lng: -3.18, accuracy: 10 });
    assert.equal(controller.active, true);
    assert.deepEqual(statuses.at(-1), { message: "Navigation route is temporarily unavailable", error: true });
    controller.stop();
});

test("cancellation or reassignment in an authoritative refresh stops navigation", async () => {
    const stopped = [];
    const controller = new navigation.Controller({ routeRequest: async () => ({ route: { polyline: "", steps: [] } }), onStop: message => stopped.push(message) });
    controller.active = true;
    controller.job = job("on_way");
    await controller.authoritativeJob(null);
    assert.equal(controller.active, false);
    assert.match(stopped[0], /no longer active/i);
});

test("passenger collection changes the destination and requests one fresh route", async () => {
    let requests = 0;
    const controller = new navigation.Controller({ routeRequest: async () => { requests += 1; return { route: { polyline: "", steps: [] } }; } });
    controller.active = true;
    controller.position = { lat: 51.48, lng: -3.18, accuracy: 10 };
    controller.job = job("on_way");
    await controller.authoritativeJob(job("passenger_onboard"));
    assert.equal(requests, 1);
    assert.equal(navigation.navigationTarget(controller.job), "dropoff");
});

test("a destination change during an in-flight request cannot install the stale pickup route", async () => {
    const resolvers = [];
    const routes = [];
    const controller = new navigation.Controller({
        routeRequest: () => new Promise(resolve => resolvers.push(resolve)),
        onRoute: route => routes.push(route.name)
    });
    controller.active = true;
    controller.position = { lat: 51.48, lng: -3.18, accuracy: 10 };
    controller.job = job("on_way");
    const first = controller.requestRoute("start");
    await controller.authoritativeJob(job("passenger_onboard"));
    resolvers.shift()({ target: "pickup", route: { name: "stale", polyline: "", steps: [] } });
    await first;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(resolvers.length, 1);
    resolvers.shift()({ target: "dropoff", route: { name: "fresh", polyline: "", steps: [] } });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(routes, ["fresh"]);
});

test("migration and Edge route preserve feature gating and tenant isolation", () => {
    const migration = fs.readFileSync(path.join(__dirname, "../supabase/migrations/202610110006_driver_integrated_navigation_flag.sql"), "utf8");
    const edge = fs.readFileSync(path.join(__dirname, "../supabase/functions/driver-portal/index.ts"), "utf8");
    assert.match(migration, /driver_integrated_navigation boolean not null default false/i);
    assert.match(edge, /eq\("company_id",s\.company_id\)\.eq\("driver_id",s\.driver_id\)/);
    assert.match(edge, /driver_integrated_navigation!==true/);
    assert.match(edge, /GOOGLE_ROUTES_API_KEY_\$\{safeCode\}/);
    assert.match(edge, /TRAFFIC_UNAWARE/);
    assert.match(edge, /stops\.length>10/);
    assert.match(edge, /remainingStops=stops\.slice\(skippedStops\)/);
    assert.match(edge, /maximum_attempts:30,window_seconds:300/);
    assert.doesNotMatch(edge, /company_id:String\(b\./);
});

test("automatic leg progression excludes already passed intermediate stops from reroutes", async () => {
    const progressValues = [];
    const controller = new navigation.Controller({ routeRequest: async (_job, _position, _reason, progress) => { progressValues.push(progress.completedStops); return { skipped_stops: progress.completedStops, route: { polyline: "", steps: [] } }; } });
    controller.active = true;
    controller.job = job("passenger_onboard");
    controller.position = { lat: 51.48, lng: -3.18, accuracy: 10 };
    controller.route = {};
    controller.steps = [{ instruction: "Continue", leg_index: 1, distance_meters: 100, duration_seconds: 10, _path: [{ lat: 51.48, lng: -3.18 }] }];
    controller.routePath = [{ lat: 51.48, lng: -3.18 }];
    controller.update(controller.position);
    assert.equal(controller.completedStops, 1);
    await controller.requestRoute("off_route");
    assert.deepEqual(progressValues, [1]);
});

test("Driver Portal contains integrated controls while preserving the existing workflow", () => {
    const html = fs.readFileSync(path.join(__dirname, "../driver.html"), "utf8");
    const driver = fs.readFileSync(path.join(__dirname, "../js/driver.js"), "utf8");
    for (const label of ["Arrived / Outside", "Passengers On Board", "Complete Job", "Open in Google Maps", "All driving instructions"]) assert.match(html, new RegExp(label));
    assert.match(html, /navigationVoiceButton/);
    assert.match(html, /voice-off/);
    assert.match(html, /navigationRecenterButton/);
    assert.match(html, /navigationOverviewButton/);
    assert.match(driver, /pauseNavigationFollow/);
    assert.match(driver, /showNavigationOverview/);
    assert.match(driver, /navigationMap\.fitBounds\(bounds, 48\)/);
    assert.match(driver, /navigationController\.acquireWakeLock/);
    assert.match(driver, /mapsLoaderKey && mapsLoaderKey !== key/);
    assert.match(driver, /reloadForMapIsolation/);
});

test("Admin canvas has a persistent background and reduced-motion navigation treatment", () => {
    const css = fs.readFileSync(path.join(__dirname, "../css/admin.css"), "utf8");
    assert.match(css, /html\{background:#0b1220;color-scheme:light\}/);
    assert.match(css, /prefers-reduced-motion:reduce/);
    assert.match(css, /body:not\(\.login-page\):not\(\.admin-authenticated\)\{visibility:hidden\}/);
});
