import { adminClient, cors, deliverEmail, json, logDelivery, render } from "../_shared/email.ts";

Deno.serve(async req => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { company_id, booking_id, template_key = "booking_confirmation" } = await req.json();
    if (!company_id || !booking_id) return json({ ok: false, error: "company_id and booking_id are required" }, 400);
    const db = adminClient();
    const [bookingResult, settingsResult, companyResult, templateResult, stopsResult] = await Promise.all([
      db.from("bookings").select("*").eq("company_id", company_id).eq("id", booking_id).maybeSingle(),
      db.from("settings").select("companyname,tradingname,currencysymbol").eq("company_id", company_id).maybeSingle(),
      db.from("companies").select("name,trading_name").eq("id", company_id).maybeSingle(),
      db.from("email_templates").select("subject,body,active").eq("company_id", company_id).eq("template_key", template_key).maybeSingle(),
      db.from("booking_stops").select("formatted_address,stop_order").eq("company_id", company_id).eq("booking_id", booking_id).order("stop_order")
    ]);
    const booking = bookingResult.data;
    if (!booking) return json({ ok: false, error: "Booking not found" }, 404);
    const { data: driver } = booking.driver_id
      ? await db.from("drivers").select("full_name").eq("company_id", company_id).eq("id", booking.driver_id).maybeSingle()
      : { data: null };
    const recipient = booking.customer_email || booking.email;
    if (!recipient) return json({ ok: false, error: "Booking has no customer email" }, 400);
    if (templateResult.data?.active === false) return json({ ok: false, error: "Template is disabled" }, 400);
    const settings = settingsResult.data;
    const company = companyResult.data;
    const values = {
      company_name: settings?.tradingname || company?.trading_name || settings?.companyname || company?.name,
      customer_name: booking.customer_name || booking.full_name,
      booking_reference: booking.booking_reference,
      journey_date: booking.journey_date,
      journey_time: booking.journey_time,
      pickup_address: booking.pickup_address,
      via_stops: (stopsResult.data || []).map(stop => ` → ${stop.formatted_address}`).join(""),
      dropoff_address: booking.dropoff_address,
      passengers: booking.passengers,
      suitcases: booking.suitcases,
      hand_luggage: booking.hand_luggage,
      flight_number: booking.flight_number,
      price: `${settings?.currencysymbol || "£"}${Number(booking.price ?? booking.job_price ?? 0).toFixed(2)}`,
      payment_method: booking.payment_method,
      driver_name: driver?.full_name || "",
      invoice_number: ""
    };
    const subject = render(templateResult.data?.subject || "Booking {{booking_reference}} confirmed", values);
    const body = render(templateResult.data?.body || "Hello {{customer_name}},\n\nYour booking with {{company_name}} is confirmed.\n\n{{pickup_address}}{{via_stops}} → {{dropoff_address}}", values);
    await logDelivery(company_id, template_key, recipient, { booking_id, subject }, () => deliverEmail(recipient, subject, body));
    return json({ ok: true });
  } catch (error) {
    return json({ ok: false, error: error.message }, 500);
  }
});
