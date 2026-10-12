/* All mutations use sms_admin: company membership is checked in PostgreSQL. */
const smsDb = getSupabase();
let smsCompany, smsConversation, smsSnapshot, templates = [], rules = [], conversations = [], replyKey = null, historyLimit = 100;
const smsEl = id => document.getElementById(id);
const smsEscape = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const smsChannels = ["customer_booking_confirmation", "office_new_booking", "driver_assignment", "driver_on_route", "driver_arrived", "passenger_on_board", "booking_completed", "cancellations", "customer_reminder", "driver_booking_reminder_12h", "office_booking_reminder_24h", "unassigned_48h", "unassigned_24h", "driver_document_expiry", "review_request"];
const smsEmailKeys = new Set(["customer_booking_confirmation","office_new_booking","driver_assignment","cancellations","driver_booking_reminder_12h","office_booking_reminder_24h","unassigned_48h","unassigned_24h","driver_document_expiry"]);
const smsTriggers = ["booking_created", "booking_confirmed", "driver_assigned", "driver_on_route", "driver_arrived", "passenger_on_board", "booking_completed", "booking_cancelled", "pickup_reminder_due", "driver_reminder_due", "office_reminder_due", "office_unassigned_48h", "office_unassigned_24h", "driver_document_expiry", "review_request"];
function smsNote(message, error = false) { smsEl("smsNotice").textContent = message; smsEl("smsNotice").classList.toggle("error", error); }
async function smsRpc(action, payload = {}) { const { data, error } = await smsDb.rpc("sms_admin", { target_company_id: smsCompany, action, payload }); if (error) throw new Error(error.message); if (!data?.ok) throw new Error(data?.error || "SMS operation rejected"); return data; }
async function smsQuery(query) { const { data, error } = await query; if (error) throw new Error(error.message); return data || []; }
function smsTab(name) { if (!smsEl(`tab-${name}`)) name = "inbox"; document.querySelectorAll(".sms-view").forEach(x => x.hidden = x.id !== `tab-${name}`); document.querySelectorAll("[data-tab]").forEach(x => { x.classList.toggle("active", x.dataset.tab === name); x.setAttribute("aria-selected", String(x.dataset.tab === name)); }); }
async function smsRun(fn) { try { await fn(); } catch (e) { smsNote(e.message || "Unable to load SMS. Please refresh.", true); } }
async function smsSubmit(event, fn) { event.preventDefault(); const button = event.target.querySelector("button[type=submit],button:not([type])"); if (button?.disabled) return; if (button) button.disabled = true; try { await fn(); } catch (e) { smsNote(e.message, true); } finally { if (button) button.disabled = false; } }

document.addEventListener("DOMContentLoaded", () => smsRun(async () => {
  const context = await getAdminCompanyContext(); if (!context) return; smsCompany = context.companyId;
  document.querySelectorAll("[data-tab]").forEach(b => b.onclick = () => { location.hash = b.dataset.tab; smsTab(b.dataset.tab); });
  window.addEventListener("hashchange", () => smsTab(location.hash.slice(1)));
  smsEl("refreshSms").onclick = () => smsRun(loadSms);
  smsEl("smsSearch").oninput = renderConversations;
  smsEl("ruleTrigger").innerHTML = smsTriggers.map(x => `<option>${x}</option>`).join("");
  smsEl("smsChannels").innerHTML = smsChannels.map(x => `<label>${x.replaceAll("_", " ")}<select data-channel="${x}"><option value="">Neither</option>${smsEmailKeys.has(x) ? '<option value="email">Email only</option>' : ''}<option value="sms">SMS only</option>${smsEmailKeys.has(x) ? '<option value="email,sms">Both (explicitly selected)</option>' : ''}</select></label>`).join("");
  smsEl("replyForm").onsubmit = e => smsSubmit(e, async () => {
    if (!smsConversation) throw new Error("Select a conversation first");
    replyKey ||= crypto.randomUUID(); // Preserve the key after any network error.
    await smsRpc("reply", { conversation_id: smsConversation, body: smsEl("replyBody").value.trim(), key: replyKey });
    replyKey = null; smsEl("replyBody").value = ""; await openSmsConversation(smsConversation); smsNote("Reply queued. Live sending remains disabled pending approval; queued replies expire after 24 hours.");
  });
  smsEl("ruleForm").onsubmit = e => smsSubmit(e, async () => {
    const conditions = {}; for (const [key, id] of [["booking_source", "ruleSource"], ["payment_method", "rulePayment"]]) if (smsEl(id).value.trim()) conditions[key] = smsEl(id).value.trim();
    await smsRpc("rule", { id: smsEl("ruleId").value || null, name: smsEl("ruleName").value.trim(), trigger_key: smsEl("ruleTrigger").value, recipient_type: smsEl("ruleRecipient").value, delay_minutes: Number(smsEl("ruleDelay").value), template_id: smsEl("ruleTemplate").value, conditions, enabled: smsEl("ruleEnabled").checked, sending_start: smsEl("ruleStart").value, sending_end: smsEl("ruleEnd").value });
    e.target.reset(); await loadSms(); smsNote("Automation saved. No live SMS will send.");
  });
  smsEl("templateForm").onsubmit = e => smsSubmit(e, async () => {
    await smsRpc("template", { id: smsEl("templateId").value || null, name: smsEl("templateName").value, body: smsEl("templateBody").value, enabled: smsEl("templateEnabled").checked, marketing: smsEl("templateMarketing").checked });
    e.target.reset(); await loadSms(); smsNote("Template saved.");
  });
  smsEl("smsSettingsForm").onsubmit = e => smsSubmit(e, async () => {
    const channels = { ...smsSnapshot.settings.channels };
    document.querySelectorAll("[data-channel]").forEach(x => channels[x.dataset.channel] = x.value ? x.value.split(",") : []);
    await smsRpc("settings", { enabled: smsEl("smsEnabled").checked, office_phone: smsEl("officeSmsPhone").value, google_review_link: smsEl("reviewLink").value, quiet_start: smsEl("quietStart").value, quiet_end: smsEl("quietEnd").value, channels });
    await loadSms(); smsNote("Notification channels saved. Only your explicit selections changed; the email scheduler remains inactive.");
  });
  smsEl("setGatewayPin").onclick = () => smsRun(async () => {
    if (!confirm("Reset the pairing PIN and revoke every currently paired gateway for this company?")) return;
    await smsRpc("pin", { pin: smsEl("gatewayPin").value }); smsEl("gatewayPin").value = ""; await loadSms(); smsNote("PIN reset. Pair the dedicated Android handset again.");
  });
  smsEl("consentForm").onsubmit = e => smsSubmit(e, async () => { await smsRpc("consent", { phone: smsEl("consentPhone").value, allowed: smsEl("consentAllowed").checked, evidence: smsEl("consentEvidence").value }); e.target.reset(); smsNote("Consent / opt-out recorded for this company."); });
  smsEl("loadHistory").onclick = () => smsRun(async () => { historyLimit += 100; await loadSmsHistory(); });
  smsEl("loadMessages").onclick = () => smsRun(() => openSmsConversation(smsConversation, Number(smsEl("messageList").dataset.limit || 100) + 100));
  await loadSms(); smsTab(location.hash.slice(1));
  setInterval(() => { if (!document.hidden && !document.querySelector("form:focus-within")) smsRun(async () => { await loadSms(false); if (smsConversation) await openSmsConversation(smsConversation); }); }, 30000);
}));
function renderConversations() {
  const query = smsEl("smsSearch").value.toLowerCase();
  smsEl("conversationList").innerHTML = conversations.filter(c => `${c.display_name} ${c.phone_e164}`.toLowerCase().includes(query)).map(c => `<button class="conversation${c.id === smsConversation ? " selected" : ""}" data-id="${c.id}"><b>${smsEscape(c.display_name || c.phone_e164)}</b><small>${smsEscape(c.phone_e164)} · ${smsEscape(c.contact_type || "unknown")} · ${c.unread_count} unread</small></button>`).join("") || "No matching conversations";
  smsEl("conversationList").querySelectorAll("[data-id]").forEach(x => x.onclick = () => smsRun(() => openSmsConversation(x.dataset.id)));
}
async function loadSms(refreshForms = true) {
  const [snapshot, cs, ts, rs] = await Promise.all([smsRpc("snapshot"), smsQuery(smsDb.from("sms_conversations").select("*").eq("company_id", smsCompany).order("last_message_at", { ascending: false }).limit(1000)), smsQuery(smsDb.from("sms_templates").select("*").eq("company_id", smsCompany).order("name")), smsQuery(smsDb.from("sms_automation_rules").select("*").eq("company_id", smsCompany).order("name"))]);
  smsSnapshot = snapshot; conversations = cs; templates = ts; rules = rs; renderConversations();
  if (refreshForms) {
    const s = snapshot.settings; smsEl("smsEnabled").checked = s.enabled; smsEl("officeSmsPhone").value = s.office_phone || ""; smsEl("reviewLink").value = s.google_review_link || ""; smsEl("quietStart").value = s.quiet_start.slice(0, 5); smsEl("quietEnd").value = s.quiet_end.slice(0, 5);
    document.querySelectorAll("[data-channel]").forEach(x => x.value = [...(s.channels[x.dataset.channel] || [])].sort().join(","));
    smsEl("pinState").textContent = s.pin_set ? "Pairing PIN set (never displayed)." : "No pairing PIN set yet.";
    smsEl("ruleTemplate").innerHTML = templates.map(t => `<option value="${t.id}">${smsEscape(t.name)}${t.enabled ? "" : " (disabled)"}</option>`).join("");
  }
  smsEl("templateList").innerHTML = templates.map(t => `<article class="card"><b>${smsEscape(t.name)}</b><p>${smsEscape(t.body)}</p><small>${t.enabled ? "Enabled" : "Disabled"} · ${t.marketing ? "Marketing — consent required" : "Service message"}</small><button type="button" data-template="${t.id}">Edit</button></article>`).join("");
  document.querySelectorAll("[data-template]").forEach(x => x.onclick = () => { const t = templates.find(t => t.id === x.dataset.template); smsEl("templateId").value = t.id; smsEl("templateName").value = t.name; smsEl("templateBody").value = t.body; smsEl("templateEnabled").checked = t.enabled; smsEl("templateMarketing").checked = t.marketing; smsEl("templateName").focus(); });
  smsEl("ruleList").innerHTML = rules.map(r => `<article class="card"><b>${smsEscape(r.name)}</b><p>${smsEscape(r.trigger_key)} → ${smsEscape(r.recipient_type)} · ${r.delay_minutes}m · ${r.enabled ? "Enabled" : "Disabled"}</p><button type="button" data-rule="${r.id}">Edit / disable</button></article>`).join("") || "No automation rules. Nothing is enabled automatically.";
  document.querySelectorAll("[data-rule]").forEach(x => x.onclick = () => { const r = rules.find(r => r.id === x.dataset.rule); for (const [id, key] of [["ruleId", "id"], ["ruleName", "name"], ["ruleTrigger", "trigger_key"], ["ruleRecipient", "recipient_type"], ["ruleDelay", "delay_minutes"], ["ruleTemplate", "template_id"]]) smsEl(id).value = r[key]; smsEl("ruleEnabled").checked = r.enabled; smsEl("ruleStart").value = r.sending_start.slice(0,5); smsEl("ruleEnd").value = r.sending_end.slice(0,5); smsEl("ruleSource").value = r.conditions.booking_source || ""; smsEl("rulePayment").value = r.conditions.payment_method || ""; smsEl("ruleName").focus(); });
  smsEl("gatewayList").innerHTML = snapshot.devices.map(d => `<article class="card"><b>${smsEscape(d.device_name)}</b><p>${d.revoked_at ? "Revoked" : d.last_heartbeat_at && Date.now() - Date.parse(d.last_heartbeat_at) < 180000 ? "Online" : "Offline / stale"} · ${smsEscape(d.apk_version)}</p><p>Last heartbeat: ${d.last_heartbeat_at ? new Date(d.last_heartbeat_at).toLocaleString() : "Never"}</p><p>SIM: ${smsEscape(d.sim_status || "Unknown")} · Network: ${smsEscape(d.network_status || "Unknown")}</p><small>Send permission: ${d.permission_state.send_sms ? "yes" : "no"} · Receive: ${d.permission_state.receive_sms ? "yes" : "no"} · Sent ${d.sent_total} / received ${d.received_total}</small><button type="button" data-revoke="${d.id}" ${d.revoked_at ? "disabled" : ""}>Revoke</button></article>`).join("") || "No paired gateway";
  document.querySelectorAll("[data-revoke]").forEach(x => x.onclick = () => smsRun(async () => { if (!confirm("Revoke this gateway immediately?")) return; await smsRpc("revoke", { id: x.dataset.revoke }); await loadSms(); }));
  smsEl("usageCards").innerHTML = Object.entries(snapshot.usage).map(([key, value]) => `<div class="card"><small>${key.replaceAll("_", " ")}</small><div class="stat">${value}</div></div>`).join("");
  await loadSmsHistory(); smsNote(snapshot.settings.sending_enabled ? "SMS sending is authorised." : "Live SMS sending is disabled pending physical handset testing and separate approval.");
}
async function loadSmsHistory() {
  const messages = await smsQuery(smsDb.from("sms_messages").select("id,direction,phone_e164,state,created_at,error_code").eq("company_id", smsCompany).order("created_at", { ascending: false }).limit(historyLimit));
  smsEl("historyList").innerHTML = messages.map(m => `<p>${smsEscape(m.direction)} · ${smsEscape(m.phone_e164)} · <b>${smsEscape(m.state)}</b> · ${new Date(m.created_at).toLocaleString()} ${smsEscape(m.error_code || "")}${m.state === "queued" ? ` <button type="button" data-cancel="${m.id}">Cancel queued message</button>` : ""}</p>`).join("") || "No messages";
  smsEl("loadHistory").hidden = messages.length < historyLimit;
  document.querySelectorAll("[data-cancel]").forEach(x => x.onclick = () => smsRun(async () => { await smsRpc("cancel", { id: x.dataset.cancel }); await loadSmsHistory(); }));
}
async function openSmsConversation(id, limit = 100) {
  if (!id) return; if (smsConversation !== id && smsEl("replyBody").value && !confirm("Discard the unsent reply draft?")) return;
  if (smsConversation !== id) { replyKey = null; smsEl("replyBody").value = ""; }
  smsConversation = id;
  const messages = await smsQuery(smsDb.from("sms_messages").select("*").eq("company_id", smsCompany).eq("conversation_id", id).order("created_at", { ascending: false }).limit(limit));
  smsEl("messageList").dataset.limit = limit;
  smsEl("messageList").innerHTML = messages.reverse().map(m => `<div class="bubble ${m.direction}">${smsEscape(m.body)}<small>${smsEscape(m.state)} · ${new Date(m.created_at).toLocaleString()}</small></div>`).join("");
  smsEl("loadMessages").hidden = messages.length < limit;
  const c = conversations.find(c => c.id === id); smsEl("conversationTitle").textContent = c ? `${c.display_name || "Conversation"} · ${c.phone_e164}` : "Conversation";
  await smsRpc("read", { id }); if (c) c.unread_count = 0; renderConversations();
}
