const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const workflow = require("../js/driver-workflow.js");

const identity = { company_id: "0001-company", driver_id: "0001-driver" };
const job = (id, status, time = "12:00:00") => ({ id, company_id: identity.company_id, driver_id: identity.driver_id, status, journey_date: "2026-10-10", journey_time: time, payment_method: "Pay in Car", payment_status: "unpaid" });

test("multiple allocated jobs remain independently visible and acceptable", () => {
    const diary = workflow.classifyJobs([job("a", "assigned", "09:00:00"), job("b", "assigned", "12:30:00"), job("c", "assigned", "17:00:00")]);
    assert.deepEqual(diary.awaiting.map(row => row.id), ["a", "b", "c"]);
    assert.equal(workflow.applyTransition(diary.awaiting[0], "accepted").status, "accepted");
    assert.equal(diary.awaiting[1].status, "assigned");
});

test("several future jobs may be accepted while only active statuses count as current", () => {
    const diary = workflow.classifyJobs([job("a", "accepted"), job("b", "accepted", "15:00:00"), job("c", "on_way", "09:00:00")]);
    assert.equal(diary.accepted.length, 2);
    assert.equal(diary.current.id, "c");
});

test("overlapping accepted work is detected while sequential work is permitted", () => {
    const first = { ...job("a", "accepted", "09:00:00"), route_duration_minutes: 120 };
    const overlap = { ...job("b", "assigned", "10:30:00"), route_duration_minutes: 60 };
    const later = { ...job("c", "assigned", "12:30:00"), route_duration_minutes: 60 };
    assert.equal(workflow.jobsOverlap(first, overlap, "Europe/London"), true);
    assert.equal(workflow.jobsOverlap(first, later, "Europe/London"), false);
});

test("invalid transitions are rejected and duplicates are idempotent", () => {
    assert.throws(() => workflow.applyTransition(job("a", "assigned"), "completed"), /Invalid job transition/);
    assert.equal(workflow.applyTransition(job("a", "accepted"), "accepted").idempotent, true);
});

test("only one On Route or POB job is classified as the current job", () => {
    const rows = [job("a", "accepted", "08:00:00"), job("b", "on_way", "09:00:00")];
    assert.equal(workflow.classifyJobs(rows).current.id, "b");
    assert.equal(workflow.activeStatuses.has("on_way"), true);
    assert.equal(workflow.activeStatuses.has("passenger_onboard"), true);
    assert.equal(workflow.activeStatuses.has("accepted"), false);
});

test("rapid duplicate acceptance is harmless", () => {
    const first = workflow.applyTransition(job("a", "assigned"), "accepted");
    const second = workflow.applyTransition(first, "accepted");
    assert.equal(first.idempotent, false);
    assert.equal(second.idempotent, true);
    assert.equal(second.status, "accepted");
});

test("3.5 hour boundary is exact", () => {
    const accepted = job("a", "accepted", "18:00:00");
    assert.equal(workflow.canStart(accepted, "2026-10-10T13:29:59.999Z", "Europe/London"), false);
    assert.equal(workflow.canStart(accepted, "2026-10-10T13:30:00.000Z", "Europe/London"), true);
});

test("British Summer Time conversion handles spring and autumn offsets", () => {
    assert.equal(workflow.zonedDateTimeUtc("2026-03-30", "18:00:00", "Europe/London").toISOString(), "2026-03-30T17:00:00.000Z");
    assert.equal(workflow.zonedDateTimeUtc("2026-10-26", "18:00:00", "Europe/London").toISOString(), "2026-10-26T18:00:00.000Z");
});

test("cross-company and cross-driver access is denied", () => {
    assert.equal(workflow.canAccessJob(identity, job("a", "assigned")), true);
    assert.equal(workflow.canAccessJob(identity, { ...job("a", "assigned"), company_id: "0003-company" }), false);
    assert.equal(workflow.canAccessJob(identity, { ...job("a", "assigned"), driver_id: "other-driver" }), false);
});

test("cash collection never applies to Stripe or already-paid jobs", () => {
    assert.equal(workflow.canMarkCashPaid(job("a", "accepted")), true);
    assert.equal(workflow.canMarkCashPaid({ ...job("a", "accepted"), payment_method: "Card" }), false);
    assert.equal(workflow.canMarkCashPaid({ ...job("a", "accepted"), payment_status: "paid" }), false);
});

test("decline is exposed only for assigned jobs when that company enables it", () => {
    assert.equal(workflow.canDecline({ driverreject: true }, job("a", "assigned")), true);
    assert.equal(workflow.canDecline({ driverreject: false }, job("a", "assigned")), false);
    assert.equal(workflow.canDecline({ driverreject: true }, job("a", "accepted")), false);
});

test("admin override requires membership", () => {
    assert.equal(workflow.canAdminOverride([{ company_id: "0001-company" }], "0001-company"), true);
    assert.equal(workflow.canAdminOverride([{ company_id: "0001-company" }], "0003-company"), false);
});

test("migration contains server enforcement contracts", () => {
    const sql = fs.readFileSync(path.join(__dirname, "../supabase/migrations/202610090001_driver_diary_workflow.sql"), "utf8");
    assert.match(sql, /for update/i);
    assert.match(sql, /3 hours 30 minutes/i);
    assert.match(sql, /bookings_one_active_job_per_driver/i);
    assert.match(sql, /driver_job_events/i);
    assert.match(sql, /user_can_access_company/i);
    assert.match(sql, /revoke all on function public\.transition_driver_booking/i);
    assert.match(sql, /where driver_id is not null\s+and lower\(coalesce\(status,''\)\) in \('on_way','passenger_onboard'\)/i);
    assert.match(sql, /old_status in \('','pending','waiting'\)/i);
    assert.match(sql, /overlaps another accepted job/i);
    assert.match(sql, /pg_advisory_xact_lock/i);
    assert.match(sql, /if new_status='accepted'/i);
});

test("mobile diary shell keeps the required sections and responsive viewport", () => {
    const html = fs.readFileSync(path.join(__dirname, "../driver.html"), "utf8");
    assert.match(html, /width=device-width/);
    assert.match(html, /Awaiting Your Response/);
    assert.match(html, /Accepted \/ Upcoming/);
    assert.match(html, /Completed Jobs/);
    assert.match(html, /Holidays \/ Off Days/);
});

test("both admin booking views route On Route through the protected admin RPC", () => {
    for (const filename of ["js/bookings.js", "js/all-bookings.js"]) {
        const source = fs.readFileSync(path.join(__dirname, "..", filename), "utf8");
        assert.match(source, /rpc\("admin_transition_booking"/);
        assert.match(source, /override_reason:/);
    }
});

test("historical terminal states remain readable without becoming active work", () => {
    const diary = workflow.classifyJobs([
        job("complete", "completed"),
        job("cancelled", "cancelled"),
        job("no-show", "no_show")
    ]);
    assert.deepEqual(diary.completed.map(row => row.id), ["complete"]);
    assert.equal(diary.current, null);
    assert.equal(diary.awaiting.length, 0);
    assert.equal(diary.accepted.length, 0);
});
