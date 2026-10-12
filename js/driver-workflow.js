(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    root.DriverWorkflow = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    const normal = value => String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    const activeStatuses = new Set(["on_way", "arrived", "passenger_onboard"]);
    const finalStatuses = new Set(["completed", "cancelled", "canceled", "no_show"]);
    const transitions = Object.freeze({
        assigned: ["accepted", "declined"],
        accepted: ["on_way"],
        on_way: ["arrived"],
        arrived: ["passenger_onboard"],
        passenger_onboard: ["completed"]
    });

    function canAccessJob(identity, job) {
        return Boolean(identity && job && String(identity.company_id) === String(job.company_id) && String(identity.driver_id) === String(job.driver_id));
    }

    function canTransition(from, to) {
        const current = normal(from), next = normal(to);
        return current === next || (transitions[current] || []).includes(next);
    }

    function isActive(job) { return activeStatuses.has(normal(job?.status)); }
    function isFinal(job) { return finalStatuses.has(normal(job?.status)); }

    function classifyJobs(jobs) {
        const sorted = [...(jobs || [])].sort(compareJobs);
        return {
            current: sorted.find(isActive) || null,
            awaiting: sorted.filter(job => normal(job.status) === "assigned"),
            accepted: sorted.filter(job => normal(job.status) === "accepted"),
            completed: sorted.filter(job => normal(job.status) === "completed")
        };
    }

    function compareJobs(a, b) {
        return `${a?.journey_date || ""}T${a?.journey_time || "00:00"}`.localeCompare(`${b?.journey_date || ""}T${b?.journey_time || "00:00"}`);
    }

    function zonedDateTimeUtc(dateValue, timeValue, timezone) {
        const date = String(dateValue || ""), time = String(timeValue || "");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}/.test(time)) return null;
        const [year, month, day] = date.split("-").map(Number);
        const [hour, minute, second = 0] = time.slice(0, 8).split(":").map(Number);
        const target = Date.UTC(year, month - 1, day, hour, minute, second);
        let guess = target;
        try {
            for (let attempt = 0; attempt < 3; attempt += 1) {
                const parts = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(guess));
                const values = Object.fromEntries(parts.map(part => [part.type, Number(part.value)]));
                guess += target - Date.UTC(values.year, values.month - 1, values.day, values.hour, values.minute, values.second);
            }
            return new Date(guess);
        } catch { return null; }
    }

    function activationAt(job, timezone = "Europe/London") {
        if (job?.operational_available_at) return new Date(job.operational_available_at);
        const pickup = zonedDateTimeUtc(job?.journey_date, job?.journey_time, timezone);
        return pickup ? new Date(pickup.getTime() - 3.5 * 60 * 60 * 1000) : null;
    }

    function canStart(job, serverNow, timezone) {
        const available = activationAt(job, timezone);
        const now = new Date(serverNow);
        return normal(job?.status) === "accepted" && available && !Number.isNaN(now.getTime()) && now >= available;
    }

    function canMarkCashPaid(job) {
        const method = normal(job?.payment_method);
        const paymentType = normal(job?.payment_type);
        const cashEligible = ["cash", "pay_in_car", "pay_by_cash"].includes(method)
            || paymentType === "pay_in_car"
            || (paymentType === "deposit" && normal(job?.payment_status) === "deposit_paid");
        return normal(job?.payment_status) !== "paid" && cashEligible
            && ["accepted", "on_way", "arrived", "passenger_onboard", "completed"].includes(normal(job?.status));
    }

    function canDecline(settings, job) {
        return settings?.driverreject === true && normal(job?.status) === "assigned";
    }

    function canAdminOverride(memberships, companyId) {
        return (memberships || []).some(item => String(item.company_id) === String(companyId));
    }

    function jobWindow(job, timezone = "Europe/London") {
        const start = zonedDateTimeUtc(job?.journey_date, job?.journey_time, timezone);
        if (!start) return null;
        const minutes = Math.max(1, Number(job?.route_duration_minutes) || 60);
        return { start, end: new Date(start.getTime() + minutes * 60000) };
    }

    function jobsOverlap(first, second, timezone = "Europe/London") {
        const a = jobWindow(first, timezone), b = jobWindow(second, timezone);
        return Boolean(a && b && a.start < b.end && b.start < a.end);
    }

    function applyTransition(job, requested) {
        const next = normal(requested), current = normal(job?.status);
        if (current === next) return { ...job, idempotent: true };
        if (!canTransition(current, next)) throw new Error(`Invalid job transition: ${current} to ${next}`);
        return { ...job, status: next, idempotent: false };
    }

    return { normal, activeStatuses, finalStatuses, canAccessJob, canTransition, isActive, isFinal, classifyJobs, compareJobs, zonedDateTimeUtc, activationAt, canStart, canMarkCashPaid, canDecline, canAdminOverride, jobWindow, jobsOverlap, applyTransition };
});
