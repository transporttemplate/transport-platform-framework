import { adminClient, cors, deliverEmail, json, logDelivery, render, requireCompanyAdmin } from "../_shared/email.ts";

Deno.serve(async request => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { company_id, statement_id } = await request.json();
    if (!await requireCompanyAdmin(request, company_id)) return json({ ok: false, error: "Forbidden" }, 403);

    const db = adminClient();
    const [statementResult, itemsResult, templateResult, settingsResult] = await Promise.all([
      db.from("driver_statements")
        .select("id,company_id,statement_number,period_start,period_end,status,drivers(full_name,email,pay_type)")
        .eq("company_id", company_id)
        .eq("id", statement_id)
        .maybeSingle(),
      db.from("driver_statement_items")
        .select("gross_fare,commission_percent,driver_amount,bookings(booking_reference,journey_date,driver_amount)")
        .eq("company_id", company_id)
        .eq("statement_id", statement_id),
      db.from("email_templates")
        .select("subject,body")
        .eq("company_id", company_id)
        .eq("template_key", "driver_statement")
        .maybeSingle(),
      db.from("settings")
        .select("currencysymbol")
        .eq("company_id", company_id)
        .maybeSingle()
    ]);

    if (statementResult.error) throw statementResult.error;
    if (itemsResult.error) throw itemsResult.error;
    if (templateResult.error) throw templateResult.error;
    if (settingsResult.error) throw settingsResult.error;
    const statement = statementResult.data;
    const driver = Array.isArray(statement?.drivers) ? statement?.drivers[0] : statement?.drivers;
    if (!statement || !driver?.email) return json({ ok: false, error: "Statement or driver email not found" }, 404);

    const currency = settingsResult.data?.currencysymbol || "£";
    const money = (value: number) => `${currency}${Number(value || 0).toFixed(2)}`;
    const roundMoney = (value: number) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
    const items = (itemsResult.data || []).map(item => {
      const booking = Array.isArray(item.bookings) ? item.bookings[0] : item.bookings;
      const commissionBase = booking?.driver_amount == null
        ? Number(item.gross_fare || 0)
        : Number(booking.driver_amount);
      const driverDue = Number(item.driver_amount || 0);
      return {
        date: booking?.journey_date || "-",
        reference: booking?.booking_reference || "-",
        commissionBase,
        rate: Number(item.commission_percent || 0),
        commission: roundMoney(Math.max(commissionBase - driverDue, 0)),
        driverDue
      };
    });
    const totals = items.reduce((sum, item) => ({
      commissionBase: sum.commissionBase + item.commissionBase,
      commission: sum.commission + item.commission,
      driverDue: sum.driverDue + item.driverDue
    }), { commissionBase: 0, commission: 0, driverDue: 0 });

    const values = {
      driver_name: driver.full_name,
      company_name: "",
      invoice_number: statement.statement_number
    };
    const subject = render(templateResult.data?.subject || "Driver statement {{invoice_number}}", values);
    const introduction = render(
      templateResult.data?.body || "Hello {{driver_name}},\n\nYour remittance {{invoice_number}} is ready.",
      values
    );
    const detailLines = items.map(item =>
      `${item.date} | ${item.reference} | Driver Amount ${money(item.commissionBase)} | Commission ${driver.pay_type === "fixed" ? "Fixed" : `${item.rate}%`} (${money(item.commission)}) | Driver Due ${money(item.driverDue)}`
    );
    const summary = [
      `Driver Amount: ${money(totals.commissionBase)}`,
      `Commission: ${money(totals.commission)}`,
      `Driver Due: ${money(totals.driverDue)}`
    ];
    const body = `${introduction}\n\n${summary.join("\n")}\n\n${detailLines.join("\n")}`;

    await logDelivery(
      company_id,
      "driver_statement",
      driver.email,
      { driver_statement_id: statement_id, subject },
      () => deliverEmail(driver.email, subject, body)
    );
    return json({ ok: true });
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : "Unexpected error" }, 500);
  }
});
