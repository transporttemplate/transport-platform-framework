const decisionToken = new URLSearchParams(location.search).get("token") || "";
const decisionDb = getSupabase();
const content = document.getElementById("offerContent");
const actions = document.getElementById("offerActions");
document.addEventListener("DOMContentLoaded", loadOffer);
async function callDecision(body) { const { data, error } = await decisionDb.functions.invoke("external-offer-decision", { body }); if (error) throw new Error(data?.error || error.message); return data; }
async function loadOffer() {
  try {
    const response = await fetch(`${SUPABASE_URL}/functions/v1/external-offer-decision?token=${encodeURIComponent(decisionToken)}`), data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "Link unavailable");
    const o = data.offer;
    document.getElementById("offerTitle").textContent = `Booking ${o.reference}`;
    content.innerHTML = `<div class="offer-route">${esc(o.pickup_address)} → ${esc(o.dropoff_address)}</div><div class="offer-grid"><p><strong>Journey</strong><br>${esc(o.journey_date)} at ${esc(String(o.journey_time || "").slice(0, 5))}</p><p><strong>Passengers</strong><br>${esc(o.passengers || 1)}</p><p><strong>Supplier payment</strong><br>£${Number(o.supplier_payment || 0).toFixed(2)}</p><p><strong>Offer expires</strong><br>${new Date(o.expires_at).toLocaleString()}</p></div>`;
    if (data.used || data.expired || !["offered", "viewed"].includes(o.status)) { const state = data.used ? `Decision recorded: ${esc(data.decision)}` : data.expired ? "This offer has expired." : `Current status: ${esc(o.status)}`; content.insertAdjacentHTML("beforeend", `<p><strong>${state}</strong></p>`); return; }
    actions.hidden = false; document.getElementById("acceptOffer").onclick = () => decide("accepted"); document.getElementById("declineOffer").onclick = () => decide("declined");
  } catch (error) { document.getElementById("offerTitle").textContent = "Link unavailable"; content.textContent = error.message; }
}
async function decide(decision) {
  if (decision === "declined" && !confirm("Decline this booking offer?")) return;
  actions.querySelectorAll("button").forEach(button => { button.disabled = true; }); content.insertAdjacentHTML("beforeend", "<p id=decisionProgress>Saving decision…</p>");
  try { const data = await callDecision({ token: decisionToken, decision }); if (!data.ok) throw new Error(data.error); content.innerHTML = `<p><strong>Decision recorded: ${esc(data.decision || decision)}.</strong></p>`; actions.hidden = true; }
  catch (error) { document.getElementById("decisionProgress").textContent = error.message; actions.querySelectorAll("button").forEach(button => { button.disabled = false; }); }
}
function esc(value) { return String(value ?? "—").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"); }
