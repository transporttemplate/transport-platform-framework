(function initialiseBookingActionMenu() {
    const menu = document.createElement("div");
    menu.className = "booking-action-menu";
    menu.setAttribute("role", "menu");
    menu.hidden = true;
    document.body.appendChild(menu);
    let activeBooking = null;

    const terminal = new Set(["accepted", "on_way", "arrived", "passenger_onboard", "completed", "cancelled", "canceled", "no_show"]);
    const statusOf = booking => String(booking?.status || booking?.booking_status || "waiting").toLowerCase();
    const close = () => { menu.hidden = true; activeBooking = null; };
    const findBooking = id => allBookings.find(row => String(row.id) === String(id));
    const action = (label, name, options = {}) => `<button type="button" role="menuitem" data-menu-action="${name}"${options.danger ? ' class="danger"' : ""}>${label}</button>`;

    function openMenu(booking, x, y, anchor) {
        if (!booking || String(booking.company_id) !== String(adminCompanyId)) return;
        activeBooking = booking;
        const editable = !terminal.has(statusOf(booking));
        menu.innerHTML = [
            action("View booking details", "view"),
            editable ? action("Edit booking", "edit") : "",
            editable ? action(booking.driver_id ? "Change driver" : "Assign driver", "driver") : "",
            action("View journey", "journey"),
            booking.customer_phone || booking.phone ? action("Call customer", "call") : "",
            action("Resend confirmation", "resend"),
            action("View payment history", "payments"),
            action("View booking activity", "activity"),
            editable ? action("Cancel booking", "cancel", { danger: true }) : ""
        ].join("");
        menu.hidden = false;
        const rect = menu.getBoundingClientRect();
        const left = Math.max(8, Math.min(x, innerWidth - rect.width - 8));
        const top = Math.max(8, Math.min(y, innerHeight - rect.height - 8));
        menu.style.left = `${left}px`; menu.style.top = `${top}px`;
        menu.dataset.anchorId = anchor?.dataset.bookingMenu || "";
        menu.querySelector("button")?.focus();
    }

    async function run(name) {
        const booking = activeBooking; close(); if (!booking) return;
        if (name === "view") return openBookingView(booking.id);
        if (name === "edit") return typeof beginBookingEdit === "function" ? beginBookingEdit(booking.id) : location.assign(`bookings.html?edit=${encodeURIComponent(booking.id)}`);
        if (name === "driver") { if (typeof beginBookingEdit === "function") { await beginBookingEdit(booking.id); document.getElementById("driverSelect")?.focus(); } else location.assign(`bookings.html?edit=${encodeURIComponent(booking.id)}`); return; }
        if (name === "journey") return window.open(`https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(booking.pickup_address || booking.pickup || "")}&destination=${encodeURIComponent(booking.dropoff_address || booking.destination || "")}`, "_blank", "noopener");
        if (name === "call") return location.assign(`tel:${String(booking.customer_phone || booking.phone).replace(/[^+\d]/g, "")}`);
        if (name === "resend") return requestBookingConfirmation(booking.id, true);
        if (name === "payments") return showHistory("Payment history", await bookingsDb.from("payments").select("amount,method,status,reference,paid_at,created_at").eq("company_id", adminCompanyId).eq("booking_id", booking.id).order("created_at", { ascending: false }), row => `${dateTime(row.paid_at || row.created_at)} — ${row.method || "Payment"} — ${money(row.amount)} — ${row.status || ""}${row.reference ? ` — ${row.reference}` : ""}`);
        if (name === "activity") return showHistory("Booking activity", await bookingsDb.from("admin_booking_audit").select("changed_fields,price_override_reason,created_at").eq("company_id", adminCompanyId).eq("booking_id", booking.id).order("created_at", { ascending: false }), row => `${dateTime(row.created_at)} — ${(row.changed_fields || []).join(", ") || "Booking updated"}${row.price_override_reason ? ` — ${row.price_override_reason}` : ""}`);
        if (name === "cancel") return cancelBooking(booking.id);
    }

    function showHistory(title, result, formatter) {
        if (result.error) return alert(result.error.message);
        const dialog = document.createElement("dialog"); dialog.className = "booking-history-dialog";
        const items = result.data?.length ? result.data.map(row => `<li>${escapeMenu(formatter(row))}</li>`).join("") : "<li>No history recorded.</li>";
        dialog.innerHTML = `<header><h2>${escapeMenu(title)}</h2><button type="button" aria-label="Close">×</button></header><ul>${items}</ul>`;
        document.body.appendChild(dialog); dialog.querySelector("button").onclick = () => dialog.close(); dialog.addEventListener("close", () => dialog.remove()); dialog.showModal();
    }
    const escapeMenu = value => String(value || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    const dateTime = value => value ? new Date(value).toLocaleString("en-GB") : "—";

    document.addEventListener("contextmenu", event => { const row = event.target.closest("tr[data-booking-id]"); if (!row) return; event.preventDefault(); openMenu(findBooking(row.dataset.bookingId), event.clientX, event.clientY, row); });
    document.addEventListener("click", event => { const trigger = event.target.closest("[data-booking-menu]"); if (trigger) { event.preventDefault(); const rect=trigger.getBoundingClientRect(); openMenu(findBooking(trigger.dataset.bookingMenu), rect.right, rect.bottom, trigger); return; } if (!event.target.closest(".booking-action-menu")) close(); });
    menu.addEventListener("click", event => { const button=event.target.closest("[data-menu-action]"); if(button) run(button.dataset.menuAction); });
    menu.addEventListener("keydown", event => { const buttons=[...menu.querySelectorAll("button")]; const index=buttons.indexOf(document.activeElement); if(event.key==="Escape"){close();return;} if(["ArrowDown","ArrowUp","Home","End"].includes(event.key)){event.preventDefault(); const next=event.key==="Home"?0:event.key==="End"?buttons.length-1:(index+(event.key==="ArrowDown"?1:-1)+buttons.length)%buttons.length; buttons[next]?.focus();} });
    window.addEventListener("resize", close); window.addEventListener("scroll", close, true);
})();
