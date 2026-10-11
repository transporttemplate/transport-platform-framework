const crypto = require("node:crypto");

function equal(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function reply(response, status, body) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(body));
}

async function handler(request, response) {
  if (request.method !== "GET") return reply(response, 405, { ok: false, error: "Method not allowed" });

  const expected = process.env.CRON_SECRET || "";
  const supplied = String(request.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!equal(supplied, expected)) return reply(response, 401, { ok: false, error: "Unauthorized" });

  if (process.env.EMAIL_AUTOMATION_ENABLED !== "true") {
    return reply(response, 503, { ok: false, dispatch_enabled: false, error: "Email automation is disabled" });
  }

  const supabaseUrl = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const dispatcherSecret = process.env.EMAIL_DISPATCHER_SECRET || "";
  if (!supabaseUrl || !dispatcherSecret) {
    console.error("email-dispatcher-cron configuration is incomplete");
    return reply(response, 503, { ok: false, error: "Scheduler configuration is incomplete" });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 50_000);
  try {
    const upstream = await fetch(`${supabaseUrl}/functions/v1/email-dispatcher`, {
      method: "POST",
      headers: { Authorization: `Bearer ${dispatcherSecret}`, "Content-Type": "application/json" },
      body: "{}",
      signal: controller.signal,
    });
    let result = {};
    try { result = await upstream.json(); } catch { /* sanitised fallback below */ }
    const safe = {
      ok: upstream.ok && result.ok === true,
      dispatch_enabled: result.dispatch_enabled !== false,
      scheduled: Number(result.scheduled || 0),
      claimed: Number(result.claimed || 0),
      accepted: Number(result.accepted || 0),
      retry_scheduled: Number(result.retry_scheduled || 0),
      failed: Number(result.failed || 0),
      uncertain: Number(result.uncertain || 0),
      quota_warning: Boolean(result.quota_warning),
      error: upstream.ok ? undefined : "Email dispatcher invocation failed",
    };
    if (!upstream.ok || result.ok !== true) console.error("email-dispatcher-cron upstream failure", { status: upstream.status });
    return reply(response, upstream.ok && result.ok === true ? 200 : 502, safe);
  } catch (error) {
    console.error("email-dispatcher-cron request failed", { name: error?.name || "Error" });
    return reply(response, 502, { ok: false, error: "Email dispatcher is temporarily unavailable" });
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = handler;
module.exports._test = { equal };
