const usageDb = getSupabase();
let usageCompanyId = null;
document.addEventListener("DOMContentLoaded", async () => { const context = await getAdminCompanyContext(); usageCompanyId = context.companyId; document.getElementById("refreshEmailUsage").onclick = loadEmailUsage; ensureUsageStatus(); await loadEmailUsage(); });

async function loadEmailUsage() {
    const button = document.getElementById("refreshEmailUsage"); button.disabled = true; showUsageStatus("Loading company email history…", false);
    try {
        const { data, error } = await usageDb.functions.invoke("email-usage", { body: { company_id: usageCompanyId } });
        if (error || !data?.ok) throw new Error(await usageErrorMessage(error, data));
        renderCompanyUsage(data); renderPlatform(data); showUsageStatus("Email history updated.", false, 3500);
    } catch (error) { showUsageStatus(error instanceof Error ? error.message : "Email usage is temporarily unavailable.", true); }
    finally { button.disabled = false; }
}
function renderCompanyUsage(data) {
    const summary = data.summary || {}, stats = [["Today", summary.today], ["This week", summary.week], ["This month", summary.month], ["This year", summary.year], ["Provider accepted", summary.accepted], ["Delivered", summary.delivered], ["Pending", summary.pending], ["Failed", summary.failed], ["Retries", Math.max(0, summary.retries || 0)], ["Delivery attempts", data.attempts]];
    document.getElementById("emailUsageSummary").innerHTML = stats.map(([name, value]) => `<div class="usage-stat"><span>${esc(name)}</span><strong>${Number(value || 0)}</strong></div>`).join("");
    document.getElementById("emailCategoryCounts").innerHTML = Object.entries(data.categories || {}).map(([key, value]) => `<p><strong>${esc(label(key))}</strong>: ${Number(value)}</p>`).join("") || "<p>No email history recorded.</p>";
    const max = Math.max(1, ...(data.monthly || []).map(row => Number(row.total)));
    document.getElementById("emailMonthlyTrend").innerHTML = (data.monthly || []).map(row => `<div class="usage-bar"><b>${Number(row.total)}</b><i style="height:${Math.max(4, Math.round(Number(row.total) / max * 130))}px"></i><span>${esc(row.month)}</span></div>`).join("") || "<p>No monthly history recorded.</p>";
    document.getElementById("emailUsageRows").innerHTML = (data.recent || []).map(row => `<tr><td>${esc(new Date(row.created_at).toLocaleString("en-GB"))}</td><td>${esc(label(row.category))}</td><td>${esc(row.type || "—")}</td><td>${esc(row.recipient || "—")}</td><td>${esc(row.state)}</td><td>${Number(row.attempts || 0)}</td></tr>`).join("") || '<tr><td colspan="6">No delivery history.</td></tr>';
}
function renderPlatform(data) {
    const platformCard = document.getElementById("platformUsageCard"), providerCard = document.getElementById("providerUsageCard"); platformCard.hidden = !data.platform; providerCard.hidden = !data.provider_usage;
    if (data.platform) document.getElementById("platformUsageRows").innerHTML = data.platform.map(row => `<tr><td>${esc(row.company_code)} — ${esc(row.company_name)}</td><td>${Number(row.month)}</td><td>${Number(row.total)}</td><td>${Number(row.accepted)}</td><td>${Number(row.failed)}</td></tr>`).join("");
    if (!data.provider_usage) return;
    const provider = data.provider_usage;
    if (!provider.available) { document.getElementById("providerUsage").innerHTML = `<p class="usage-unavailable"><strong>Provider quota unavailable.</strong> ${esc(provider.error || "Resend did not return quota data.")}</p><p>Company delivery history above remains available and is not a zero-usage result.</p>`; return; }
    const month = provider.emails?.monthly || {}, daily = provider.emails?.daily || {}, remaining = month.limit == null ? "Unlimited" : Math.max(0, Number(month.limit) - Number(month.used || 0)), ratio = month.limit ? Number(month.used || 0) / Number(month.limit) : 0, warning = ratio >= .95 ? "Critical — 95% used" : ratio >= .85 ? "Warning — 85% used" : ratio >= .7 ? "Notice — 70% used" : "Within allowance", difference = Number(month.used || 0) - Number(data.platform_recorded_month || 0);
    document.getElementById("providerUsage").innerHTML = `<p><strong>Plan:</strong> Not returned by Usage API</p><p><strong>Monthly:</strong> ${Number(month.used || 0)} used / ${month.limit ?? "unlimited"}; ${remaining} remaining</p><p><strong>Daily:</strong> ${Number(daily.used || 0)} used / ${daily.limit ?? "unlimited"}</p><p><strong>Platform recorded this month:</strong> ${Number(data.platform_recorded_month || 0)}</p><p><strong>Provider difference:</strong> ${difference}</p><p><strong>Reset:</strong> ${esc(month.resets_at ? new Date(month.resets_at).toLocaleString("en-GB") : "Unavailable")}</p><p><strong>Status:</strong> ${esc(warning)}</p>`;
}
async function usageErrorMessage(error, data) { if (data?.error) return cleanError(data.error); const response = error?.context; if (response instanceof Response) { try { const body = await response.clone().json(); if (body?.error) return cleanError(body.error); } catch { /* fallback */ } } if (response?.status === 401 || response?.status === 403) return "Your session is not authorised to view this company’s email history. Please sign in again."; return "Email history could not be loaded. Please retry; no emails were sent."; }
function ensureUsageStatus() { const node = document.createElement("p"); node.id = "emailUsageStatus"; node.className = "email-usage-status"; node.setAttribute("role", "status"); node.setAttribute("aria-live", "polite"); document.querySelector(".topbar")?.after(node); }
function showUsageStatus(message, failed, hideAfter = 0) { const node = document.getElementById("emailUsageStatus"); node.textContent = message; node.classList.toggle("is-error", failed); node.hidden = false; if (hideAfter) setTimeout(() => { node.hidden = true; }, hideAfter); }
function cleanError(value) { const text = String(value || "").replace(/[\r\n<>]/g, " ").trim(); return text && text.length <= 180 ? text : "Email history is temporarily unavailable."; }
function label(value) { return String(value || "other").replaceAll("_", " ").replace(/\b\w/g, character => character.toUpperCase()); }
function esc(value) { return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"); }
