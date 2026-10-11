import { adminClient, cors, json } from "../_shared/email.ts";
type Row = Record<string, any>;

Deno.serve(async request => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
  try {
    const token = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") || "";
    const db = adminClient();
    const { data: auth } = await db.auth.getUser(token);
    if (!auth.user) return json({ ok: false, error: "Forbidden" }, 403);
    const body = await request.json();
    const companyId = String(body.company_id || "");
    const { data: membership } = await db.from("company_users").select("company_id").eq("user_id", auth.user.id).eq("company_id", companyId).maybeSingle();
    if (!membership) return json({ ok: false, error: "Forbidden" }, 403);
    const platformRole = String(auth.user.app_metadata?.platform_role || "").toLowerCase();
    const isPlatform = ["platform_admin", "super_admin", "owner"].includes(platformRole);
    const since = new Date(Date.now() - 366 * 86400000).toISOString();
    const [{ data: messages, error: messageError }, { data: attempts, error: attemptError }, { data: legacy, error: legacyError }] = await Promise.all([
      db.from("email_messages").select("id,company_id,category,recipient_type,state,attempt_count,created_at,recipient,template_key").eq("company_id", companyId).gte("created_at", since),
      db.from("email_attempts").select("message_id,state,started_at").eq("company_id", companyId).gte("started_at", since),
      db.from("email_deliveries").select("id,company_id,template_key,recipient_type,status,created_at,recipient,metadata").eq("company_id", companyId).gte("created_at", since),
    ]);
    if (messageError || attemptError || legacyError) throw messageError || attemptError || legacyError;
    const rows = combine(messages || [], legacy || []);
    const now = Date.now();
    const startedAttempts = (attempts || []).filter((row: Row) => row.state !== "started").length;
    const summary = {
      today: countSince(rows, now - 86400000), week: countSince(rows, now - 7 * 86400000),
      month: countMonth(rows), year: rows.length,
      pending: rows.filter(row => ["pending", "processing", "delayed"].includes(row.state)).length,
      failed: rows.filter(row => ["failed", "bounced", "complained", "suppressed"].includes(row.state)).length,
      delivered: rows.filter(row => row.state === "delivered").length,
      accepted: rows.filter(row => ["accepted", "delivered"].includes(row.state)).length,
      retries: Math.max(0, startedAttempts - rows.filter(row => row.source === "queue").length),
    };
    const result: Row = {
      ok: true, summary, categories: group(rows, "category"), recipient_types: group(rows, "type"),
      monthly: months(rows), attempts: (attempts || []).length,
      recent: rows.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)).slice(0, 50),
    };
    if (isPlatform) {
      const [{ data: companies }, { data: allMessages }, { data: allLegacy }] = await Promise.all([
        db.from("companies").select("id,company_code,name,trading_name"),
        db.from("email_messages").select("id,company_id,category,recipient_type,state,created_at").gte("created_at", since),
        db.from("email_deliveries").select("id,company_id,template_key,recipient_type,status,created_at,metadata").gte("created_at", since),
      ]);
      result.platform = platformAggregate(companies || [], allMessages || [], allLegacy || []);
      result.provider_usage = await resendUsage();
      result.platform_recorded_month = result.platform.reduce((sum: number, row: Row) => sum + Number(row.month || 0), 0);
    }
    return json(result);
  } catch (error) {
    console.error("email-usage", error instanceof Error ? error.message : error);
    return json({ ok: false, error: "Unable to load email usage" }, 500);
  }
});

function combine(messages: Row[], legacy: Row[]) {
  const modern = messages.map(row => ({ id: `new:${row.id}`, category: row.category, type: row.recipient_type, state: row.state, created_at: row.created_at, recipient: row.recipient, attempts: row.attempt_count, source: "queue" }));
  const historical = legacy.filter(row => !row.metadata?.logical_message_id).map(row => ({ id: `legacy:${row.id}`, category: legacyCategory(row.template_key, row.recipient_type), type: row.recipient_type || "legacy", state: row.status === "sent" ? "accepted" : row.status, created_at: row.created_at, recipient: row.recipient, attempts: 1, source: "legacy" }));
  return [...modern, ...historical];
}
function countSince(rows: Row[], stamp: number) { return rows.filter(row => Date.parse(row.created_at) >= stamp).length; }
function countMonth(rows: Row[]) { const now = new Date(); return countSince(rows, Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)); }
function group(rows: Row[], key: string) { const out: Row = {}; for (const row of rows) out[row[key] || "other"] = (out[row[key] || "other"] || 0) + 1; return out; }
function months(rows: Row[]) { const out: Row = {}; for (const row of rows) { const key = String(row.created_at).slice(0, 7); out[key] = (out[key] || 0) + 1; } return Object.entries(out).sort().map(([month, total]) => ({ month, total })); }
function legacyCategory(key: string, type: string) { if (key?.includes("invoice")) return "invoice"; if (key === "receipt") return "receipt"; if (key?.includes("statement")) return "driver_statement"; if (key?.includes("unallocated")) return "unassigned_alert"; return type || key || "other"; }
function platformAggregate(companies: Row[], messages: Row[], legacy: Row[]) {
  return companies.map(company => {
    const rows = combine(messages.filter(row => row.company_id === company.id), legacy.filter(row => row.company_id === company.id));
    return { company_code: company.company_code, company_name: company.trading_name || company.name, total: rows.length, month: countMonth(rows), accepted: rows.filter(row => ["accepted", "delivered"].includes(row.state)).length, failed: rows.filter(row => ["failed", "bounced", "complained", "suppressed"].includes(row.state)).length, categories: group(rows, "category") };
  });
}
async function resendUsage() {
  const key = Deno.env.get("EMAIL_PROVIDER_API_KEY");
  if (!key) return { available: false, error: "Provider credential unavailable" };
  try {
    const response = await fetch("https://api.resend.com/usage", { headers: { Authorization: `Bearer ${key}` } });
    const data = await response.json();
    if (!response.ok) return { available: false, error: "Usage API access unavailable" };
    return { available: true, plan_name: null, emails: data.emails, domains: data.domains, rate_limit: data.rate_limit };
  } catch { return { available: false, error: "Usage API unavailable" }; }
}
