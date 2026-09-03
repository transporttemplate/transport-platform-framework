import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Content-Type": "application/json" };
export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: cors });
export const adminClient = () => createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

export async function requireCompanyAdmin(req: Request, companyId: string) {
  const token = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (!token) return false;
  const db = adminClient();
  const { data: user } = await db.auth.getUser(token);
  if (!user.user) return false;
  const { data } = await db.from("company_users").select("company_id").eq("user_id", user.user.id).eq("company_id", companyId).maybeSingle();
  return Boolean(data);
}

export function render(template: string, values: Record<string, unknown>) {
  return Object.entries(values).reduce((text, [key, value]) => text.replaceAll(`{{${key}}}`, String(value ?? "")), template);
}

export async function deliverEmail(to: string, subject: string, text: string) {
  const apiKey = Deno.env.get("EMAIL_PROVIDER_API_KEY");
  const from = Deno.env.get("EMAIL_FROM_ADDRESS");
  const endpoint = Deno.env.get("EMAIL_PROVIDER_URL") || "https://api.resend.com/emails";
  if (!apiKey || !from) throw new Error("EMAIL_PROVIDER_API_KEY and EMAIL_FROM_ADDRESS must be configured.");
  const response = await fetch(endpoint, { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ from, to: [to], subject, text }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || "Email provider rejected the request.");
  return result.id || null;
}

export async function logDelivery(companyId: string, templateKey: string, recipient: string, links: Record<string, unknown>, task: () => Promise<string | null>) {
  const db = adminClient();
  const { data: row } = await db.from("email_deliveries").insert({ company_id: companyId, template_key: templateKey, recipient, status: "queued", ...links }).select("id").single();
  try { const providerId = await task(); await db.from("email_deliveries").update({ status: "sent", sent_at: new Date().toISOString(), provider_message_id: providerId }).eq("id", row.id).eq("company_id", companyId); return providerId; }
  catch (error) { await db.from("email_deliveries").update({ status: "failed", error_message: error.message }).eq("id", row.id).eq("company_id", companyId); throw error; }
}
