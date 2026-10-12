(function (root, factory) {
    const api = factory(root);
    if (typeof module === "object" && module.exports) module.exports = api;
    root.DriverNavigation = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
    const ACTIVE_STATUSES = new Set(["accepted", "on_way", "arrived", "passenger_onboard"]);

    function normal(value) { return String(value || "").trim().toLowerCase().replaceAll(" ", "_"); }
    function navigationTarget(job) { return normal(job?.status) === "passenger_onboard" ? "dropoff" : "pickup"; }
    function canNavigate(job) { return Boolean(job?.id && ACTIVE_STATUSES.has(normal(job.status))); }
    function externalMapsUrl(job) {
        if (!job?.id) return "";
        const toDropoff = ["passenger_onboard", "completed"].includes(normal(job.status));
        const destination = toDropoff ? displayAddress(job, "dropoff") : displayAddress(job, "pickup");
        if (!destination || destination === "-") return "";
        const params = new URLSearchParams({ api: "1", travelmode: "driving", destination, dir_action: "navigate" });
        if (toDropoff) {
            const stops = (job.via_stops || []).map(stop => stop.formatted_address).filter(Boolean);
            if (stops.length) params.set("waypoints", stops.join("|"));
        }
        return `https://www.google.com/maps/dir/?${params.toString()}`;
    }
    function displayAddress(job, prefix) { return job?.[`${prefix}_name`] || job?.[`${prefix}_address`] || "-"; }
    function decodePolyline(encoded) {
        const path = []; let index = 0, latitude = 0, longitude = 0;
        while (index < String(encoded || "").length) {
            const lat = decodeValue(encoded, index); index = lat.index; latitude += lat.value;
            const lng = decodeValue(encoded, index); index = lng.index; longitude += lng.value;
            path.push({ lat: latitude / 1e5, lng: longitude / 1e5 });
        }
        return path;
    }
    function decodeValue(encoded, start) {
        let result = 0, shift = 0, byte = 0, index = start;
        do { byte = encoded.charCodeAt(index++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20 && index <= encoded.length);
        return { value: result & 1 ? ~(result >> 1) : result >> 1, index };
    }
    function metresBetween(a, b) {
        if (!a || !b) return Infinity;
        const rad = Math.PI / 180, lat1 = Number(a.lat ?? a.latitude) * rad, lat2 = Number(b.lat ?? b.latitude) * rad;
        const dLat = lat2 - lat1, dLng = (Number(b.lng ?? b.longitude) - Number(a.lng ?? a.longitude)) * rad;
        const value = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
        return 6371000 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
    }
    function distanceToPath(point, path) {
        if (!point || !path?.length) return Infinity;
        let closest = Infinity;
        const sampleEvery = Math.max(1, Math.floor(path.length / 400));
        for (let index = 0; index < path.length; index += sampleEvery) closest = Math.min(closest, metresBetween(point, path[index]));
        return closest;
    }
    function shouldReroute(state, position, now = Date.now()) {
        if (!state?.routePath?.length || !position) return { reroute: false, offRouteFixes: 0 };
        const accuracy = Math.max(0, Number(position.accuracy) || 0);
        if (accuracy > 150) return { reroute: false, offRouteFixes: 0 };
        const threshold = Math.max(80, accuracy * 2);
        const offRoute = distanceToPath(position, state.routePath) > threshold;
        const offRouteFixes = offRoute ? (state.offRouteFixes || 0) + 1 : 0;
        const reroute = offRouteFixes >= 3 && now - (state.lastRouteAt || 0) >= (state.minimumRerouteMs || 45000);
        return { reroute, offRouteFixes };
    }
    function progressForPosition(steps, position, currentIndex = 0) {
        if (!steps?.length) return 0;
        let bestIndex = Math.min(currentIndex, steps.length - 1), bestDistance = Infinity;
        for (let index = Math.max(0, currentIndex - 1); index < steps.length; index += 1) {
            const path = steps[index]._path || decodePolyline(steps[index].polyline);
            const distance = distanceToPath(position, path);
            if (distance < bestDistance) { bestDistance = distance; bestIndex = index; }
        }
        const end = steps[bestIndex]?.end_location;
        if (end && metresBetween(position, end) < Math.max(30, Number(position.accuracy || 0)) && bestIndex < steps.length - 1) return bestIndex + 1;
        return Math.max(currentIndex, bestIndex);
    }
    function remainingMetrics(steps, index, position) {
        const remaining = (steps || []).slice(index);
        let metres = remaining.reduce((sum, step) => sum + Number(step.distance_meters || 0), 0);
        let seconds = remaining.reduce((sum, step) => sum + Number(step.duration_seconds || 0), 0);
        const current = remaining[0];
        if (current?.distance_meters && current.end_location) {
            const direct = metresBetween(position, current.end_location);
            const fraction = Math.min(1, direct / Number(current.distance_meters));
            metres -= Number(current.distance_meters) * (1 - fraction);
            seconds -= Number(current.duration_seconds || 0) * (1 - fraction);
        }
        return { metres: Math.max(0, metres), seconds: Math.max(0, seconds) };
    }
    function formatDistance(metres) { return metres < 160 ? `${Math.max(0, Math.round(metres / 10) * 10)} m` : `${(metres / 1609.344).toFixed(metres < 1609 ? 1 : 1)} mi`; }
    function formatDuration(seconds) { const minutes = Math.max(1, Math.round(seconds / 60)); return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} hr ${minutes % 60} min`; }
    function usableHeading(value) { if (value === null || value === undefined || value === "") return null; const heading = Number(value); return Number.isFinite(heading) && heading >= 0 && heading < 360 ? heading : null; }
    function smoothHeading(previous, next, speed) {
        const target = usableHeading(next), current = usableHeading(previous);
        if (target === null || Number(speed) < 1.2) return current;
        if (current === null) return target;
        const delta = ((target - current + 540) % 360) - 180;
        return (current + Math.max(-18, Math.min(18, delta)) + 360) % 360;
    }
    function navigationZoom(speed, distanceToTurn, accuracy) {
        if (Number(accuracy) > 100) return 16.5;
        if (Number(distanceToTurn) < 180) return 18.5;
        const metresPerSecond = Math.max(0, Number(speed) || 0);
        if (metresPerSecond >= 24) return 16.5;
        if (metresPerSecond >= 14) return 17;
        if (metresPerSecond >= 6) return 17.5;
        return 18;
    }
    function gpsIsStale(position, now = Date.now()) { return !position || !Number.isFinite(Number(position.timestamp)) || now - Number(position.timestamp) > 30000; }

    class Controller {
        constructor(options) {
            this.options = options;
            this.active = false; this.job = null; this.route = null; this.routePath = []; this.steps = [];
            this.stepIndex = 0; this.voiceEnabled = false; this.spokenKey = ""; this.lastRouteAt = 0; this.offRouteFixes = 0;
            this.minimumRerouteMs = 45000; this.position = null; this.requestingRoute = false; this.pendingRouteReason = ""; this.completedStops = 0; this.skippedStops = 0; this.wakeLock = null;
        }
        async start(job, position) {
            if (!canNavigate(job)) throw new Error("This job is not available for navigation.");
            this.active = true; this.job = job; this.position = position; this.voiceEnabled = false; this.spokenKey = ""; this.completedStops = 0; this.skippedStops = 0;
            this.options.onStart?.(job, externalMapsUrl(job)); await this.acquireWakeLock(); await this.requestRoute("start");
        }
        async requestRoute(reason) {
            if (!this.active || !this.position) return;
            if (this.requestingRoute) { this.pendingRouteReason = reason; return; }
            this.requestingRoute = true; this.options.onStatus?.(reason === "off_route" ? "Recalculating route…" : "Calculating route…", false);
            try {
                const result = await this.options.routeRequest(this.job, this.position, reason, { completedStops: this.completedStops });
                if (!this.active) return;
                if (result.target && result.target !== navigationTarget(this.job)) { this.pendingRouteReason = "destination_change"; return; }
                this.route = result.route; this.lastRouteAt = Date.now(); this.offRouteFixes = 0; this.stepIndex = 0; this.spokenKey = ""; this.skippedStops = Number(result.skipped_stops || 0);
                this.routePath = decodePolyline(this.route.polyline);
                this.steps = (this.route.steps || []).map(step => ({ ...step, _path: decodePolyline(step.polyline) }));
                this.options.onRoute?.(this.route, this.routePath, this.steps);
                this.update(this.position);
                this.options.onStatus?.("GPS active · foreground navigation", false);
            } catch (error) { this.options.onStatus?.(error.message || "Route unavailable. Use Google Maps.", true); }
            finally {
                this.requestingRoute = false;
                const pending = this.pendingRouteReason; this.pendingRouteReason = "";
                if (pending && this.active) queueMicrotask(() => this.requestRoute(pending));
            }
        }
        update(position) {
            if (!this.active || !position) return;
            this.position = position; this.options.onPosition?.(position);
            if (!this.route) return;
            const reroute = shouldReroute(this, position); this.offRouteFixes = reroute.offRouteFixes;
            if (reroute.reroute) { this.requestRoute("off_route"); return; }
            const nextIndex = progressForPosition(this.steps, position, this.stepIndex);
            const changed = nextIndex !== this.stepIndex; this.stepIndex = nextIndex;
            const current = this.steps[this.stepIndex] || null, next = this.steps[this.stepIndex + 1] || null;
            if (navigationTarget(this.job) === "dropoff" && current) this.completedStops = Math.max(this.completedStops, this.skippedStops + Number(current.leg_index || 0));
            const metrics = remainingMetrics(this.steps, this.stepIndex, position);
            this.options.onProgress?.({ current, next, index: this.stepIndex, metrics, eta: new Date(Date.now() + metrics.seconds * 1000) });
            if (changed || !this.spokenKey) this.speakCurrent();
        }
        setVoice(enabled) {
            this.voiceEnabled = Boolean(enabled); this.options.onVoice?.(this.voiceEnabled);
            if (!enabled) { root.speechSynthesis?.cancel(); this.spokenKey = ""; }
            else this.speakCurrent(true);
        }
        speakCurrent(force = false) {
            const step = this.steps[this.stepIndex]; if (!this.voiceEnabled || !step?.instruction || !root.speechSynthesis) return;
            const key = `${this.stepIndex}|${step.instruction}`; if (!force && this.spokenKey === key) return;
            root.speechSynthesis.cancel(); const utterance = new SpeechSynthesisUtterance(step.instruction); utterance.lang = "en-GB";
            const voice = root.speechSynthesis.getVoices?.().find(item => /^en-GB/i.test(item.lang)); if (voice) utterance.voice = voice;
            root.speechSynthesis.speak(utterance); this.spokenKey = key;
        }
        async authoritativeJob(job) {
            if (!this.active) return;
            if (!job || !canNavigate(job)) { this.stop("Navigation ended because this job is no longer active."); return; }
            const bookingChanged = String(job.id) !== String(this.job?.id), targetChanged = navigationTarget(job) !== navigationTarget(this.job), changed = bookingChanged || targetChanged;
            if (changed) { this.completedStops = 0; this.skippedStops = 0; }
            this.job = job;
            this.options.onJob?.(job, externalMapsUrl(job));
            if (changed) { root.speechSynthesis?.cancel(); this.spokenKey = ""; await this.requestRoute("destination_change"); }
        }
        async acquireWakeLock() { try { if (root.navigator?.wakeLock && root.document?.visibilityState === "visible") this.wakeLock = await root.navigator.wakeLock.request("screen"); } catch {} }
        stop(message = "") {
            root.speechSynthesis?.cancel(); this.wakeLock?.release?.().catch?.(() => {}); this.wakeLock = null;
            this.active = false; this.voiceEnabled = false; this.job = null; this.route = null; this.steps = []; this.routePath = []; this.spokenKey = ""; this.pendingRouteReason = ""; this.completedStops = 0; this.skippedStops = 0;
            this.options.onStop?.(message);
        }
    }

    return { ACTIVE_STATUSES, normal, navigationTarget, canNavigate, externalMapsUrl, decodePolyline, metresBetween, distanceToPath, shouldReroute, progressForPosition, remainingMetrics, formatDistance, formatDuration, usableHeading, smoothHeading, navigationZoom, gpsIsStale, Controller };
});
