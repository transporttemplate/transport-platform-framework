/* All mutations use sms_admin: company membership is checked in PostgreSQL. */
const smsDb = getSupabase();
let smsCompany, smsConversation, smsSnapshot, templates = [], rules = [], conversations = [], replyKey = null, historyLimit = 100;
const smsEl = id => document.getElementById(id);
const smsEscape = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const smsChannels = ["customer_booking_confirmation", "office_new_booking", "driver_assignment", "driver_on_route", "driver_arrived", "passenger_on_board", "booking_completed", "cancellations", "customer_reminder", "driver_booking_reminder_12h", "office_booking_reminder_24h", "unassigned_48h", "unassigned_24h", "driver_document_expiry", "review_request"];
const smsEmailKeys = new Set(["customer_booking_confirmation","office_new_booking","driver_assignment","cancellations","driver_booking_reminder_12h","office_booking_reminder_24h","unassigned_48h","unassigned_24h","driver_document_expiry"]);
const smsTriggers = ["booking_created", "booking_confirmed", "booking_changed", "driver_assigned", "driver_allocated", "driver_on_route", "driver_arrived", "passenger_on_board", "booking_completed", "booking_cancelled", "pickup_reminder_due", "driver_reminder_due", "office_reminder_due", "office_unassigned_48h", "office_unassigned_24h", "driver_document_expiry", "review_request", "external_booking_created"];
const smsTriggerMeta = {
  booking_created:["Customer","Booking created"],booking_confirmed:["Customer","Booking confirmed"],booking_changed:["Customer","Booking changed"],driver_allocated:["Customer","Driver allocated"],driver_on_route:["Customer","Driver on route"],driver_arrived:["Customer","Driver arrived / outside"],passenger_on_board:["Customer","Passenger on board"],booking_completed:["Customer","Booking completed"],booking_cancelled:["Customer","Booking cancelled"],pickup_reminder_due:["Customer","Pickup reminder (12 hours)"],review_request:["Customer","Review request"],
  driver_assigned:["Driver","New job assigned"],driver_reminder_due:["Driver","Journey reminder (12 hours)"],driver_document_expiry:["Driver","Document expiry"],
  office_reminder_due:["Office","Booking reminder (24 hours)"],office_unassigned_48h:["Office","Unassigned warning (48 hours)"],office_unassigned_24h:["Office","Unassigned warning (24 hours)"],external_booking_created:["Office","New external API booking"]
};
const smsExampleValues = {company_name:"Example Cars",booking_reference:"BK-1234",customer_name:"Chris",pickup_date:"24/10/2026",pickup_time:"14:30",pickup_address:"10 High Street, Cardiff",destination_address:"Cardiff Airport",driver_name:"Alex Driver",driver_phone:"+447700900000",google_review_link:"https://example.com/review",document_label:"Driving licence",expiry_date:"31/10/2026"};
function smsSegments(value) { const text=String(value||""), gsm=/^[\x00-\x7F\n\r£€]*$/.test(text), single=gsm?160:70, multi=gsm?153:67; return {characters:text.length,segments:text.length<=single?1:Math.ceil(text.length/multi),encoding:gsm?"GSM-7 compatible":"Unicode"}; }
function renderTemplatePreview() { const source=smsEl("templateBody").value; const missing=[...source.matchAll(/\{\{([^}]+)\}\}/g)].map(x=>x[1]).filter(x=>!(x in smsExampleValues)); let preview=source; for(const [key,value] of Object.entries(smsExampleValues)) preview=preview.replaceAll(`{{${key}}}`,value); const metrics=smsSegments(preview); smsEl("templatePreview").textContent=preview||"Start typing to preview the message."; smsEl("templateMetrics").textContent=`${metrics.characters} characters · estimated ${metrics.segments} SMS segment${metrics.segments===1?"":"s"} · ${metrics.encoding}`; smsEl("templateWarnings").textContent=missing.length?`Unsupported or missing example variables: ${[...new Set(missing)].join(", ")}`:""; }
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
  smsEl("changeMasterSms").onclick = () => smsRun(async () => {
    const turningOn = !smsSnapshot.settings.sending_enabled;
    if (turningOn) {
      if (!smsSnapshot.readiness.ready) throw new Error(`SMS is not ready: ${smsSnapshot.readiness.missing.join("; ")}`);
      const confirmation = prompt("Activation can send enabled rules to real recipients. Type ENABLE SMS to confirm.");
      if (confirmation !== "ENABLE SMS") return;
      const reason = prompt("Record the activation reason (optional):") || "";
      await smsRpc("master", { enabled:true, confirmation, reason, manual_only:rules.every(r=>!r.enabled) });
      smsNote("Master SMS is ON. Only enabled rules and authorised manual replies can send.");
    } else {
      if (!confirm("Switch Master SMS OFF immediately and cancel every queued or claimed message?")) return;
      await smsRpc("master", { enabled:false, confirmation:"DISABLE SMS", reason:"Paused by Admin" });
      smsNote("Master SMS is OFF. Outgoing messages are paused and stale queued work was cancelled.");
    }
    await loadSms();
  });
  smsEl("runSmsTest").onclick = () => smsRun(async () => {
    const phone=prompt("Controlled test recipient (UK or international mobile):");if(!phone)return;
    if(!confirm(`Queue one 10-minute gateway test to ${phone}? No other message can send in test mode.`))return;
    await smsRpc("test",{phone});await loadSms();smsNote("Controlled test queued. Reply TEST from that phone, then refresh readiness.");
  });
  smsEl("smsSearch").oninput = renderConversations;
  smsEl("ruleTrigger").innerHTML = ["Customer","Driver","Office"].map(group=>`<optgroup label="${group}">${smsTriggers.filter(x=>smsTriggerMeta[x][0]===group).map(x=>`<option value="${x}">${smsTriggerMeta[x][1]}</option>`).join("")}</optgroup>`).join("");
  smsEl("templateBody").addEventListener("input",renderTemplatePreview); smsEl("templateForm").addEventListener("reset",()=>setTimeout(renderTemplatePreview)); renderTemplatePreview();
  smsEl("smsChannels").innerHTML = smsChannels.map(x => `<label>${x.replaceAll("_", " ")}<select data-channel="${x}"><option value="">Neither</option>${smsEmailKeys.has(x) ? '<option value="email">Email only</option>' : ''}<option value="sms">SMS only</option>${smsEmailKeys.has(x) ? '<option value="email,sms">Both (explicitly selected)</option>' : ''}</select></label>`).join("");
  smsEl("replyForm").onsubmit = e => smsSubmit(e, async () => {
    if (!smsConversation) throw new Error("Select a conversation first");
    replyKey ||= crypto.randomUUID(); // Preserve the key after any network error.
    await smsRpc("reply", { conversation_id: smsConversation, body: smsEl("replyBody").value.trim(), key: replyKey });
    replyKey = null; smsEl("replyBody").value = ""; await openSmsConversation(smsConversation); smsNote("Reply queued. Live sending remains disabled pending approval; queued replies expire after 24 hours.");
  });
  smsEl("ruleForm").onsubmit = e => smsSubmit(e, async () => {
    const conditions = {}; for (const [key, id] of [["booking_source", "ruleSource"], ["payment_method", "rulePayment"]]) if (smsEl(id).value.trim()) conditions[key] = smsEl(id).value.trim();
    const duplicate=rules.find(r=>r.id!==smsEl("ruleId").value&&r.trigger_key===smsEl("ruleTrigger").value&&r.recipient_type===smsEl("ruleRecipient").value&&JSON.stringify(r.conditions||{})===JSON.stringify(conditions)); if(duplicate) throw new Error(`A matching ${smsTriggerMeta[duplicate.trigger_key][1]} rule already exists. Edit it or add an explicit filter.`);
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
  smsEl("masterSms").checked = snapshot.settings.sending_enabled;
  smsEl("masterSms").disabled = true;
  smsEl("masterSummary").textContent = snapshot.settings.sending_enabled ? "ON — approved rules and manual replies may use the paired gateway." : "OFF — no outgoing SMS can be claimed by the gateway. Incoming messages and history remain available.";
  smsEl("changeMasterSms").textContent = snapshot.settings.sending_enabled ? "Switch OFF now" : "Review activation";
  smsEl("readinessList").innerHTML = snapshot.readiness.missing.length ? snapshot.readiness.missing.map(x=>`<li>${smsEscape(x)}</li>`).join("") : "<li>Gateway, permissions, SIM and company configuration checks passed.</li>";
  if (refreshForms) {
    const s = snapshot.settings; smsEl("smsEnabled").checked = s.enabled; smsEl("officeSmsPhone").value = s.office_phone || ""; smsEl("reviewLink").value = s.google_review_link || ""; smsEl("quietStart").value = s.quiet_start.slice(0, 5); smsEl("quietEnd").value = s.quiet_end.slice(0, 5);
    document.querySelectorAll("[data-channel]").forEach(x => x.value = [...(s.channels[x.dataset.channel] || [])].sort().join(","));
    smsEl("pinState").textContent = s.pin_set ? "Pairing PIN set (never displayed)." : "No pairing PIN set yet.";
    smsEl("ruleTemplate").innerHTML = templates.map(t => `<option value="${t.id}">${smsEscape(t.name)}${t.enabled ? "" : " (disabled)"}</option>`).join("");
  }
  smsEl("automationGateStatus").textContent = snapshot.settings.sending_enabled && snapshot.devices.some(d=>!d.revoked_at&&d.last_heartbeat_at&&Date.now()-Date.parse(d.last_heartbeat_at)<180000) ? "Gateway online and company live sending authorised. Enabled rules may dispatch when their event and channel are eligible." : "Automation sending is blocked until this company has an online tested gateway and live sending is authorised. Rules may still be configured.";
  smsEl("templateList").innerHTML = templates.map(t => {const metric=smsSegments(t.body);return `<article class="card"><b>${smsEscape(t.name)}</b><p>${smsEscape(t.body)}</p><small>${t.enabled ? "Enabled" : "Disabled"} · ${t.marketing ? "Marketing — consent required" : "Transactional service message"} · template estimate ${metric.segments} segment${metric.segments===1?"":"s"}</small><button type="button" data-template="${t.id}">Edit</button></article>`}).join("");
  document.querySelectorAll("[data-template]").forEach(x => x.onclick = () => { const t = templates.find(t => t.id === x.dataset.template); smsEl("templateId").value = t.id; smsEl("templateName").value = t.name; smsEl("templateBody").value = t.body; smsEl("templateEnabled").checked = t.enabled; smsEl("templateMarketing").checked = t.marketing; renderTemplatePreview(); smsEl("templateName").focus(); });
  smsEl("ruleList").innerHTML = ["Customer","Driver","Office"].map(group=>{const items=rules.filter(r=>(smsTriggerMeta[r.trigger_key]||[r.recipient_type])[0].toLowerCase()===group.toLowerCase());return `<section class="rule-group"><h3>${group} automations</h3>${items.map(r=>{const t=templates.find(t=>t.id===r.template_id);return `<article class="card"><b>${smsEscape(r.name)}</b> <span class="rule-status ${r.enabled?"enabled":"disabled"}">${r.enabled?"Enabled":"Disabled"}</span><p>${smsEscape((smsTriggerMeta[r.trigger_key]||[null,r.trigger_key])[1])} → ${smsEscape(r.recipient_type)} · ${r.delay_minutes}m</p><small>Template: ${smsEscape(t?.name||"Missing template")} · ${snapshot.settings.sending_enabled?"company sending authorised":"blocked by company/gateway status"}</small><button type="button" data-rule="${r.id}">Edit / disable</button></article>`}).join("")||"<p>No rules in this group.</p>"}</section>`}).join("");
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
