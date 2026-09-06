import {
  adminClient, brandedEmail, cors, deliverEmail, escapeHtml, formatCompanyLocalDateTime, json, logDelivery,
  render, requireInternalOrCompanyAdmin, textToHtml,
} from "../_shared/email.ts";

type Row = Record<string, any>;
type Recipient = { type: "customer" | "office" | "driver" | "admin_test"; email: string; template: string; driver?: Row; eventKey: string };

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
  try {
    const body = await request.json();
    const companyId = clean(body.company_id);
    const bookingId = clean(body.booking_id);
    const event = canonicalEvent(body.event || body.template_key);
    const providerConfigured = Boolean(Deno.env.get("EMAIL_PROVIDER_API_KEY") && Deno.env.get("EMAIL_FROM_ADDRESS"));
    if (!companyId) return json({ ok: false, error: "company_id is required" }, 400);
    if (!await requireInternalOrCompanyAdmin(request, companyId)) return json({ ok: false, error: "Forbidden" }, 403);
    console.info("Email event received", { event, company_id: companyId, booking_id: bookingId, provider_configured: providerConfigured });
    if (event === "provider_status") return json({ ok: true, configured: providerConfigured });
    if (event === "test") return await sendTestEmail(request, companyId, body);
    if (!bookingId) return json({ ok: false, error: "booking_id is required" }, 400);

    const db = adminClient();
    const [bookingResult, settingsResult, companyResult, stopsResult] = await Promise.all([
      db.from("bookings").select("*").eq("company_id", companyId).eq("id", bookingId).maybeSingle(),
      db.from("settings").select("*").eq("company_id", companyId).maybeSingle(),
      db.from("companies").select("id,company_code,name,trading_name").eq("id", companyId).maybeSingle(),
      db.from("booking_stops").select("address_name,formatted_address,stop_order").eq("company_id", companyId).eq("booking_id", bookingId).order("stop_order"),
    ]);
    if (bookingResult.error) throw bookingResult.error;
    if (settingsResult.error) throw settingsResult.error;
    if (stopsResult.error) throw stopsResult.error;
    const booking = bookingResult.data;
    const settings = settingsResult.data || {};
    const company = companyResult.data || {};
    if (!booking) return json({ ok: false, error: "Booking not found" }, 404);
    console.info("Email company settings resolved", { event, company_id: companyId, notifications_enabled: settings.emailnotifications !== false, customer_notifications_enabled: settings.customer_booking_emails !== false });
    if (settings.emailnotifications === false) {
      console.warn("Email event skipped", { event, company_id: companyId, reason: "notifications_disabled" });
      return json({ ok: true, sent: false, skipped: "Email notifications disabled" });
    }

    const driverIds = [...new Set([booking.driver_id, body.previous_driver_id].filter(Boolean))];
    const { data: drivers, error: driverError } = driverIds.length
      ? await db.from("drivers").select("id,company_id,full_name,email").eq("company_id", companyId).in("id", driverIds)
      : { data: [], error: null };
    if (driverError) throw driverError;
    const currentDriver = (drivers || []).find((row: Row) => String(row.id) === String(booking.driver_id));
    const previousDriver = (drivers || []).find((row: Row) => String(row.id) === String(body.previous_driver_id));
    const eventId = clean(body.event_id) || eventIdentity(event, booking, body);
    let recipients = recipientsFor(event, booking, settings, currentDriver, previousDriver, eventId, Boolean(body.resend));
    if (["customer", "office", "driver"].includes(String(body.audience || ""))) {
      recipients = recipients.filter(item => item.type === body.audience);
    }
    console.info("Email recipients resolved", { event, company_id: companyId, recipient_count: recipients.length, recipient_types: [...new Set(recipients.map(item => item.type))], provider_configured: providerConfigured });
    if (!recipients.length) {
      console.warn("Email event skipped", { event, company_id: companyId, reason: "no_enabled_recipients" });
      return json({ ok: true, sent: false, skipped: "No enabled recipients" });
    }

    const templateKeys = [...new Set(recipients.map(item => item.template))];
    const { data: templates, error: templateError } = await db.from("email_templates")
      .select("template_key,subject,body,active").eq("company_id", companyId).in("template_key", templateKeys);
    if (templateError) throw templateError;

    const values = valuesFor(booking, settings, company, stopsResult.data || [], currentDriver);
    const sent: Array<{ recipient_type: string; status: string }> = [];
    for (const recipient of recipients) {
      const template = (templates || []).find((row: Row) => row.template_key === recipient.template);
      if (template?.active === false) { sent.push({ recipient_type: recipient.type, status: "template_disabled" }); continue; }
      const recipientValues = { ...values, driver_name: recipient.driver?.full_name || values.driver_name };
      const defaults = defaultTemplate(recipient.template);
      const subject = render(template?.subject || defaults.subject, recipientValues);
      const templateBody = template?.body || defaults.body;
      const text = render(templateBody, recipientValues);
      const htmlText = recipient.type === "customer"
        ? render(templateBody, { ...recipientValues, journey_summary: "", payment_summary: "" }).replace(/\n{3,}/g, "\n\n").trim()
        : text;
      const html = brandedEmail(settings, `<div style="font-size:16px">${textToHtml(htmlText)}</div>${journeyHtml(booking, stopsResult.data || [], settings, String(recipientValues.journey_datetime || ""))}${paymentHtml(booking, settings)}`);
      try {
        const result = await logDelivery(companyId, recipient.template, recipient.email, {
          booking_id: bookingId,
          subject,
          recipient_type: recipient.type,
          event_key: recipient.eventKey,
          metadata: { event },
        }, () => deliverEmail(recipient.email, subject, text, {
          html,
          replyTo: clean(settings.email_reply_to) || clean(settings.officeemail) || clean(settings.companyemail) || undefined,
          senderName: clean(settings.email_sender_name) || clean(settings.tradingname) || clean(settings.companyname) || undefined,
        }));
        console.info("Email delivery completed", { event, company_id: companyId, recipient_type: recipient.type, result: result === "duplicate" ? "deduplicated" : "provider_accepted" });
        sent.push({ recipient_type: recipient.type, status: result === "duplicate" ? "duplicate" : "sent" });
      } catch (error) {
        sent.push({ recipient_type: recipient.type, status: "failed" });
        console.error("Email recipient delivery failed", recipient.type, error instanceof Error ? error.message : error);
      }
    }
    const accepted = sent.filter(item => item.status === "sent").length;
    const duplicates = sent.filter(item => item.status === "duplicate").length;
    const response = { ok: accepted > 0 || duplicates > 0, sent: accepted > 0, accepted, deduplicated: duplicates > 0, deliveries: sent };
    console.info("Email event completed", { event, company_id: companyId, accepted, duplicates, failed: sent.filter(item => item.status === "failed").length });
    return accepted > 0 || duplicates > 0 ? json(response) : json({ ...response, error: "No email was accepted by the provider" }, 502);
  } catch (error) {
    console.error("send-booking-email", error instanceof Error ? error.message : error);
    return json({ ok: false, error: error instanceof Error ? error.message : "Unexpected error" }, 500);
  }
});

async function sendTestEmail(request: Request, companyId: string, body: Row) {
  const db = adminClient();
  const token = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") || "";
  const { data: auth } = await db.auth.getUser(token);
  const [{ data: settings }, { data: company }] = await Promise.all([
    db.from("settings").select("*").eq("company_id", companyId).maybeSingle(),
    db.from("companies").select("company_code,name,trading_name").eq("id", companyId).maybeSingle(),
  ]);
  const recipient = clean(auth.user?.email) || clean(settings?.office_notification_email) || clean(settings?.officeemail) || clean(settings?.companyemail);
  if (!recipient) return json({ ok: false, error: "No authenticated admin or office email is configured" }, 400);
  const values = { company_name: settings?.tradingname || company?.trading_name || settings?.companyname || company?.name || "Transport Company" };
  const subject = render("TEST — {{company_name}} email configuration", values);
  const text = render("This is a test email from {{company_name}}.\n\nCompany-scoped email delivery is configured correctly.", values);
  const result = await logDelivery(companyId, "admin_test_email", recipient, {
    subject, recipient_type: "admin_test", event_key: `test:${auth.user?.id || recipient}:${clean(body.event_id) || crypto.randomUUID()}`,
  }, () => deliverEmail(recipient, subject, text, {
    html: brandedEmail(settings || {}, textToHtml(text)),
    replyTo: clean(settings?.email_reply_to) || clean(settings?.officeemail) || undefined,
    senderName: clean(settings?.email_sender_name) || clean(settings?.tradingname) || undefined,
  }));
  return json({ ok: true, sent: result !== "duplicate", deduplicated: result === "duplicate", status: result === "duplicate" ? "duplicate" : "sent" });
}

function recipientsFor(event: string, booking: Row, settings: Row, currentDriver: Row | undefined, previousDriver: Row | undefined, eventId: string, resend: boolean): Recipient[] {
  const customer = clean(booking.customer_email) || clean(booking.email);
  const offices = officeRecipients(settings);
  const suffix = resend ? `${eventId}:resend:${crypto.randomUUID()}` : eventId;
  const result: Recipient[] = [];
  const add = (type: Recipient["type"], email: string | null, template: string, driver?: Row) => {
    if (email) result.push({ type, email, template, driver, eventKey: `${booking.id}:${suffix}:${template}:${type}` });
  };
  if (event === "new_booking") {
    if (settings.customer_booking_emails !== false) add("customer", customer, "customer_booking_confirmation");
    if (settings.office_new_booking_emails !== false) offices.forEach(email => add("office", email, "office_new_booking"));
    if (currentDriver && settings.driver_assignment_emails !== false) add("driver", clean(currentDriver.email), "driver_assignment", currentDriver);
  } else if (event === "payment_received") {
    if (settings.payment_confirmation_emails !== false) {
      add("customer", customer, "customer_payment_confirmation");
      offices.forEach(email => add("office", email, "office_payment_received"));
    }
  } else if (event === "booking_changed") {
    if (settings.booking_change_emails !== false) {
      add("customer", customer, "customer_booking_changed");
      offices.forEach(email => add("office", email, "office_booking_changed"));
      if (currentDriver) add("driver", clean(currentDriver.email), "driver_job_changed", currentDriver);
    }
  } else if (event === "booking_cancelled") {
    if (settings.cancellation_emails !== false) {
      add("customer", customer, "customer_booking_cancelled");
      offices.forEach(email => add("office", email, "office_booking_cancelled"));
      if (currentDriver) add("driver", clean(currentDriver.email), "driver_job_cancelled", currentDriver);
    }
  } else if (event === "driver_assignment") {
    if (settings.driver_assignment_emails !== false) {
      if (previousDriver && previousDriver.id !== currentDriver?.id) add("driver", clean(previousDriver.email), "driver_job_removed", previousDriver);
      if (currentDriver && previousDriver?.id !== currentDriver.id) add("driver", clean(currentDriver.email), "driver_assignment", currentDriver);
    }
  } else if (event === "unallocated_reminder" && settings.unallocated_reminder_emails !== false) {
    const threshold = Number(eventId.replace(/\D/g, ""));
    const template = threshold <= 1440 ? "office_unallocated_24h" : "office_unallocated_48h";
    offices.forEach(email => add("office", email, template));
  }
  return result;
}

function valuesFor(booking: Row, settings: Row, company: Row, stops: Row[], driver?: Row) {
  const currency = clean(settings.currencysymbol) || "£";
  const money = (value: unknown) => `${currency}${Number(value || 0).toFixed(2)}`;
  const pickup = [booking.pickup_name, booking.pickup_address].filter(Boolean).join(", ");
  const dropoff = [booking.dropoff_name, booking.dropoff_address].filter(Boolean).join(", ");
  const vias = stops.map(stop => [stop.address_name, stop.formatted_address].filter(Boolean).join(", ")).filter(Boolean);
  const route = [pickup, ...vias, dropoff].join(" → ");
  const total = Number(booking.price ?? booking.job_price ?? 0);
  const paid = Number(booking.amount_paid || 0);
  const balance = Number(booking.balance_due ?? Math.max(0, total - paid));
  const journeyWhen = formatCompanyLocalDateTime(booking.journey_date, booking.journey_time, settings.timezone);
  return {
    company_name: settings.tradingname || company.trading_name || settings.companyname || company.name || "Transport Company",
    customer_name: booking.customer_name || booking.full_name || "Customer",
    customer_phone: booking.customer_phone || booking.phone || "—",
    customer_email: booking.customer_email || booking.email || "—",
    booking_reference: booking.booking_reference || booking.id,
    journey_date: journeyWhen.date,
    journey_time: journeyWhen.time,
    journey_datetime: journeyWhen.dateTime,
    pickup_address: pickup,
    via_stops: vias.join(" → "),
    dropoff_address: dropoff,
    journey_summary: `${journeyWhen.dateTime}\n${route}`,
    passengers: booking.passengers ?? "—",
    suitcases: booking.suitcases ?? 0,
    hand_luggage: booking.hand_luggage ?? 0,
    luggage: `${booking.suitcases ?? 0} suitcase(s), ${booking.hand_luggage ?? 0} hand luggage`,
    flight_number: booking.flight_number || "—",
    notes: booking.notes || "—",
    price: money(total),
    amount_paid: money(paid),
    balance_due: money(balance),
    payment_method: booking.payment_method || "—",
    payment_status: booking.payment_status || "unpaid",
    payment_summary: `Journey total: ${money(total)}\nPayment method: ${booking.payment_method || "—"}\nPayment status: ${booking.payment_status || "unpaid"}\nAmount paid: ${money(paid)}\nBalance remaining: ${money(balance)}`,
    booking_source: booking.booking_source || "—",
    driver_name: driver?.full_name || "Unassigned",
    driver_amount: money(booking.driver_amount == null ? total : booking.driver_amount),
  };
}

function journeyHtml(booking: Row, stops: Row[], settings: Row, journeyDateTime: string) {
  const locations = [
    ["Pickup", [booking.pickup_name, booking.pickup_address].filter(Boolean).join(", ")],
    ...stops.map((stop, index) => [`Stop ${index + 1}`, [stop.address_name, stop.formatted_address].filter(Boolean).join(", ")]),
    ["Drop-off", [booking.dropoff_name, booking.dropoff_address].filter(Boolean).join(", ")],
  ];
  const accent = /^#[0-9a-f]{6}$/i.test(String(settings.primarycolour || "")) ? settings.primarycolour : "#14b8a6";
  return `<div style="margin:22px 0;border-left:4px solid ${accent};padding-left:16px"><strong style="font-size:18px">${escapeHtml(booking.booking_reference)}</strong><div style="margin:6px 0 14px">${escapeHtml(journeyDateTime)}</div>${locations.map(([label, address]) => `<div style="margin:9px 0"><span style="color:#64748b;font-size:12px;text-transform:uppercase">${escapeHtml(label)}</span><br><strong>${escapeHtml(address)}</strong></div>`).join("")}</div>`;
}

function paymentHtml(booking: Row, settings: Row) {
  const symbol = clean(settings.currencysymbol) || "£";
  const money = (value: unknown) => `${symbol}${Number(value || 0).toFixed(2)}`;
  const total = Number(booking.price ?? booking.job_price ?? 0);
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="7" style="margin-top:18px;background:#f8fafc;border-radius:8px"><tr><td>Journey total</td><td align="right"><strong>${money(total)}</strong></td></tr><tr><td>Amount paid</td><td align="right">${money(booking.amount_paid)}</td></tr><tr><td>Balance remaining</td><td align="right">${money(booking.balance_due ?? total)}</td></tr></table>`;
}

function defaultTemplate(key: string) {
  const defaults: Record<string, { subject: string; body: string }> = {
    customer_booking_confirmation: { subject: "Booking {{booking_reference}} received", body: "Hello {{customer_name}},\n\nThank you for booking with {{company_name}}.\n\n{{journey_summary}}\n\n{{payment_summary}}" },
    customer_payment_confirmation: { subject: "Payment received for {{booking_reference}}", body: "Hello {{customer_name}},\n\nYour payment has been verified securely.\n\n{{payment_summary}}" },
    customer_booking_changed: { subject: "Booking {{booking_reference}} updated", body: "Hello {{customer_name}},\n\nYour booking has been updated.\n\n{{journey_summary}}" },
    customer_booking_cancelled: { subject: "Booking {{booking_reference}} cancelled", body: "Hello {{customer_name}},\n\nYour booking has been cancelled." },
    office_new_booking: { subject: "NEW BOOKING — {{booking_reference}}", body: "NEW BOOKING\n\nCustomer: {{customer_name}}\nPhone: {{customer_phone}}\n{{journey_summary}}\n\n{{payment_summary}}" },
    office_booking_changed: { subject: "BOOKING UPDATED — {{booking_reference}}", body: "Booking {{booking_reference}} has been updated.\n\n{{journey_summary}}" },
    office_booking_cancelled: { subject: "BOOKING CANCELLED — {{booking_reference}}", body: "Booking {{booking_reference}} has been cancelled." },
    office_payment_received: { subject: "PAYMENT RECEIVED — {{booking_reference}}", body: "Payment has been verified for {{booking_reference}}.\n\n{{payment_summary}}" },
    driver_assignment: { subject: "New job {{booking_reference}}", body: "Hello {{driver_name}},\n\nA job has been assigned to you.\n\n{{journey_summary}}\n\nDriver amount: {{driver_amount}}" },
    driver_job_changed: { subject: "Job {{booking_reference}} updated", body: "Hello {{driver_name}},\n\nYour assigned job has changed.\n\n{{journey_summary}}" },
    driver_job_removed: { subject: "Job {{booking_reference}} removed", body: "Hello {{driver_name}},\n\nJob {{booking_reference}} has been removed from your allocation." },
    driver_job_cancelled: { subject: "Job {{booking_reference}} cancelled", body: "Hello {{driver_name}},\n\nJob {{booking_reference}} has been cancelled." },
    office_unallocated_48h: { subject: "DRIVER NOT ALLOCATED — {{booking_reference}} (48 hours)", body: "Booking {{booking_reference}} is due within 48 hours and has no driver.\n\n{{journey_summary}}" },
    office_unallocated_24h: { subject: "URGENT: DRIVER NOT ALLOCATED — {{booking_reference}} (24 hours)", body: "Booking {{booking_reference}} is due within 24 hours and has no driver.\n\n{{journey_summary}}" },
  };
  return defaults[key] || { subject: "Booking {{booking_reference}}", body: "{{journey_summary}}" };
}

function officeRecipients(settings: Row) {
  const values = [settings.office_notification_email, settings.officeemail, settings.companyemail, settings.additional_office_recipients]
    .flatMap(value => String(value || "").split(/[;,\n]/)).map(value => value.trim().toLowerCase()).filter(validEmail);
  return [...new Set(values)];
}
function canonicalEvent(value: unknown) { const key = String(value || "new_booking").toLowerCase(); const map: Record<string, string> = { booking_confirmation: "new_booking", booking_amended: "booking_changed", booking_cancelled: "booking_cancelled", driver_assigned: "driver_assignment", payment_confirmation: "payment_received" }; return map[key] || key; }
function eventIdentity(event: string, booking: Row, body: Row) { if (event === "payment_received") return `payment:${booking.payment_status}:${booking.amount_paid}`; if (event === "unallocated_reminder") return `unallocated:${Number(body.threshold_minutes || 0)}`; return event; }
function clean(value: unknown): string | null { return String(value ?? "").trim() || null; }
function validEmail(value: string) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value); }
