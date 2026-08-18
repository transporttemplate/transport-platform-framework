const bookingsDb = getSupabase();

let allBookings = [];
let currentTab = "dispatch";

document.addEventListener("DOMContentLoaded", () => {
  setDefaultDates();
  bindBookingEvents();
  loadBookings();
});

function bindBookingEvents() {
  document.getElementById("adminBookingForm")?.addEventListener("submit", createAdminBooking);
  document.getElementById("refreshBookings")?.addEventListener("click", loadBookings);
  document.getElementById("dateFrom")?.addEventListener("change", renderBookings);
  document.getElementById("dateTo")?.addEventListener("change", renderBookings);
  document.getElementById("searchBookings")?.addEventListener("input", renderBookings);
  document.getElementById("statusFilter")?.addEventListener("change", renderBookings);
  document.getElementById("focusNewBooking")?.addEventListener("click", () => {
    document.getElementById("customerName")?.focus();
    document.getElementById("newBookingPanel")?.scrollIntoView({behavior:"smooth"});
  });

  document.querySelectorAll(".dispatch-tabs button").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".dispatch-tabs button").forEach(x => x.classList.remove("active"));
      btn.classList.add("active");
      currentTab = btn.dataset.status;
      renderBookings();
    });
  });
}

function setDefaultDates() {
  const today = new Date();
  const iso = today.toISOString().slice(0,10);
  const future = new Date(today);
  future.setDate(future.getDate() + 7);
  document.getElementById("dateFrom").value = iso;
  document.getElementById("dateTo").value = future.toISOString().slice(0,10);
  document.getElementById("journeyDate").value = iso;
}

async function loadBookings() {
  const body = document.getElementById("bookingsBody");
  body.innerHTML = '<tr><td colspan="12" class="empty-row">Loading bookings…</td></tr>';

  const { data, error } = await bookingsDb
    .from("bookings")
    .select("*")
    .order("journey_date", { ascending: true })
    .order("journey_time", { ascending: true });

  if (error) {
    console.error(error);
    body.innerHTML = `<tr><td colspan="12" class="empty-row">Unable to load bookings: ${escapeHtml(error.message)}</td></tr>`;
    return;
  }

  allBookings = data || [];
  updateCounts();
  renderBookings();
}

function bookingStatus(b) {
  return String(b.status || b.booking_status || "waiting").toLowerCase();
}

function matchesTab(b) {
  const status = bookingStatus(b);
  if (currentTab === "all") return true;
  if (currentTab === "completed") return status === "completed";
  if (currentTab === "cancelled") return ["cancelled","canceled"].includes(status);
  if (currentTab === "booked") return ["booked","assigned"].includes(status);
  if (currentTab === "prebooked") {
    const today = new Date().toISOString().slice(0,10);
    return b.journey_date > today && !["completed","cancelled","canceled"].includes(status);
  }
  return ["waiting","assigned","on_way","passenger_onboard","dispatched"].includes(status);
}

function renderBookings() {
  const from = document.getElementById("dateFrom").value;
  const to = document.getElementById("dateTo").value;
  const search = document.getElementById("searchBookings").value.trim().toLowerCase();
  const statusFilter = document.getElementById("statusFilter").value;

  const rows = allBookings.filter(b => {
    if (from && b.journey_date && b.journey_date < from) return false;
    if (to && b.journey_date && b.journey_date > to) return false;
    if (!matchesTab(b)) return false;
    if (statusFilter && bookingStatus(b) !== statusFilter) return false;

    if (search) {
      const haystack = [
        b.booking_reference, b.customer_name, b.full_name,
        b.pickup_address, b.pickup, b.dropoff_address, b.destination,
        b.customer_phone, b.phone
      ].filter(Boolean).join(" ").toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });

  const body = document.getElementById("bookingsBody");
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="12" class="empty-row">No bookings found for this view.</td></tr>';
    return;
  }

  body.innerHTML = rows.map(b => `
    <tr>
      <td>${escapeHtml(b.journey_date || "")}</td>
      <td>${escapeHtml(formatTime(b.journey_time))}</td>
      <td>${escapeHtml(b.booking_reference || shortId(b.id))}</td>
      <td>${escapeHtml(b.customer_name || b.full_name || "-")}</td>
      <td>${escapeHtml(b.pickup_address || b.pickup || "-")}</td>
      <td>${escapeHtml(b.dropoff_address || b.destination || "-")}</td>
      <td>${escapeHtml(b.driver_name || (b.driver_id ? "Assigned" : "-"))}</td>
      <td>${money(b.job_price ?? b.price)}</td>
      <td>${escapeHtml(b.payment_method || b.payment_status || "-")}</td>
      <td><span class="source-pill">${escapeHtml(b.booking_source || "public")}</span></td>
      <td><span class="status-pill">${escapeHtml(prettyStatus(bookingStatus(b)))}</span></td>
      <td><button type="button" onclick="cycleBookingStatus('${b.id}','${bookingStatus(b)}')">Update</button></td>
    </tr>
  `).join("");
}

async function createAdminBooking(event) {
  event.preventDefault();
  const message = document.getElementById("bookingMessage");
  message.textContent = "Saving…";

  const payload = {
    booking_reference: makeReference(),
    customer_name: document.getElementById("customerName").value.trim(),
    customer_email: document.getElementById("customerEmail").value.trim() || null,
    customer_phone: document.getElementById("customerPhone").value.trim() || null,
    pickup_address: document.getElementById("pickupAddress").value.trim(),
    dropoff_address: document.getElementById("dropoffAddress").value.trim(),
    journey_date: document.getElementById("journeyDate").value,
    journey_time: document.getElementById("journeyTime").value,
    passengers: Number(document.getElementById("passengers").value || 1),
    job_price: document.getElementById("jobPrice").value === "" ? null : Number(document.getElementById("jobPrice").value),
    payment_method: document.getElementById("paymentMethod").value,
    status: document.getElementById("bookingStatus").value,
    notes: document.getElementById("notes").value.trim() || null,
    booking_source: "admin"
  };

  const { error } = await bookingsDb.from("bookings").insert(payload);

  if (error) {
    console.error(error);
    message.textContent = "Could not save: " + error.message;
    return;
  }

  message.textContent = "Booking saved.";
  event.target.reset();
  setDefaultDates();
  await loadBookings();
}

async function cycleBookingStatus(id, current) {
  const sequence = ["waiting","assigned","on_way","passenger_onboard","completed"];
  let next = sequence[sequence.indexOf(current) + 1] || "completed";

  const update = { status: next };
  const now = new Date().toISOString();
  if (next === "assigned") update.dispatched_at = now;
  if (next === "on_way") update.on_way_at = now;
  if (next === "passenger_onboard") update.passenger_onboard_at = now;
  if (next === "completed") update.completed_at = now;

  const { error } = await bookingsDb.from("bookings").update(update).eq("id", id);
  if (error) {
    alert(error.message);
    return;
  }
  await loadBookings();
}

function updateCounts() {
  const today = new Date().toISOString().slice(0,10);
  const status = b => bookingStatus(b);
  document.getElementById("countAll").textContent = allBookings.length;
  document.getElementById("countCompleted").textContent = allBookings.filter(b => status(b)==="completed").length;
  document.getElementById("countCancelled").textContent = allBookings.filter(b => ["cancelled","canceled"].includes(status(b))).length;
  document.getElementById("countBooked").textContent = allBookings.filter(b => ["booked","assigned"].includes(status(b))).length;
  document.getElementById("countPrebooked").textContent = allBookings.filter(b => b.journey_date > today && !["completed","cancelled","canceled"].includes(status(b))).length;
  document.getElementById("countDispatch").textContent = allBookings.filter(b => ["waiting","assigned","on_way","passenger_onboard","dispatched"].includes(status(b))).length;
}

function makeReference() {
  return "ADM-" + Date.now().toString().slice(-8);
}
function shortId(id) {
  return id ? String(id).slice(0,8).toUpperCase() : "-";
}
function formatTime(t) {
  return t ? String(t).slice(0,5) : "";
}
function money(v) {
  return v === null || v === undefined || v === "" ? "-" : "£" + Number(v).toFixed(2);
}
function prettyStatus(s) {
  return s.replaceAll("_"," ").replace(/\b\w/g, x => x.toUpperCase());
}
function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&","&amp;").replaceAll("<","&lt;")
    .replaceAll(">","&gt;").replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}
