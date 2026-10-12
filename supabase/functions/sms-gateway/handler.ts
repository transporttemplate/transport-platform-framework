type Db = { rpc: (name: string, args: Record<string, unknown>) => PromiseLike<{ data: any; error: any }> };
const headers = { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization,apikey,content-type,x-gateway-token", "Access-Control-Allow-Methods": "POST,OPTIONS" };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
export async function hash(value: string) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map(x => x.toString(16).padStart(2, "0")).join("");
}
// Injected client enables actual handler tests without SMS/network access.
export function gatewayHandler(db: Db, liveSending = false) {
  return async (request: Request): Promise<Response> => {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (request.method !== "POST") return reply({ ok: false, error: "POST required" }, 405);
    try {
      const reader = request.body?.getReader(); let size = 0; const chunks: Uint8Array[] = [];
      if (!reader) return reply({ ok: false, error: "JSON body required" }, 400);
      while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 20000) { await reader.cancel(); return reply({ ok: false, error: "Request too large" }, 413); } chunks.push(value); }
      const bytes = new Uint8Array(size); let offset = 0; for (const part of chunks) { bytes.set(part, offset); offset += part.length; }
      let input: any; try { input = JSON.parse(new TextDecoder().decode(bytes)); } catch { return reply({ ok: false, error: "Invalid JSON" }, 400); }
      if (!input || Array.isArray(input) || typeof input !== "object") return reply({ ok: false, error: "Object required" }, 400);
      const action = input.action;
      if (!["pair", "heartbeat", "claim", "prepare", "status", "inbound", "unpair"].includes(action)) return reply({ ok: false, error: "Unknown gateway action" }, 400);
      const payload: Record<string, unknown> = {};
      let token: string | null = null, tokenHash: string | null = null;
      if (action === "pair") {
        if (!/^\d{4}$/.test(input.company_code || "") || !/^\d{6,12}$/.test(input.pin || "") || !/^[a-zA-Z0-9-]{16,200}$/.test(input.device_fingerprint || "")) return reply({ ok: false, error: "Company code, 6–12 digit PIN and device identity required" }, 400);
        token = [...crypto.getRandomValues(new Uint8Array(32))].map(x => x.toString(16).padStart(2, "0")).join("");
        Object.assign(payload, { company_code: input.company_code, pin: input.pin, device_fingerprint: input.device_fingerprint, device_name: String(input.device_name || "Android Gateway").slice(0, 100), apk_version: String(input.apk_version || "").slice(0, 30), credential_hash: await hash(token) });
      } else {
        const credential = request.headers.get("x-gateway-token") || "";
        if (!/^[a-f0-9]{64}$/.test(credential)) return reply({ ok: false, error: "Paired gateway credential required" }, 401);
        tokenHash = await hash(credential);
        const fields = action === "heartbeat" ? ["sim_status", "network_status", "send_sms", "receive_sms", "apk_version"] : action === "inbound" ? ["phone_e164", "body", "idempotency_key"] : ["message_id", "state", "attempt", "error_code"];
        for (const field of fields) if (input[field] !== undefined) payload[field] = input[field];
        if (["prepare", "status"].includes(action) && (!/^[0-9a-f-]{36}$/i.test(String(input.message_id || "")) || !Number.isInteger(input.attempt) || input.attempt < 1 || input.attempt > 4)) return reply({ ok: false, error: "Message lease required" }, 400);
      }
      const disabled = !liveSending && ["claim", "prepare"].includes(action);
      const { data, error } = await db.rpc("sms_gateway", { action: disabled ? "heartbeat" : action, payload: disabled ? {} : payload, token_hash: tokenHash });
      if (error) { console.error("sms_gateway rpc failed", { action, code: error.code }); return reply({ ok: false, error: "Gateway operation rejected. Check request and pairing, then retry.", code: error.code }, error.code === "42501" ? 403 : 400); }
      if (!data?.ok) return reply({ ok: false, error: data?.error || "Gateway request rejected" }, [400, 401, 403, 409, 429].includes(data?.status) ? data.status : 400);
      if (disabled) return action === "claim" ? reply({ ok: true, messages: [], sending_enabled: false }) : reply({ ok: false, error: "Live SMS sending is disabled" }, 409);
      if (action === "pair") return reply({ ...data, token, sending_enabled: false });
      return reply({ ...data, ...(action === "heartbeat" && !liveSending ? { sending_enabled: false } : {}) });
    } catch { return reply({ ok: false, error: "Gateway unavailable; retry safely" }, 503); }
  };
}
