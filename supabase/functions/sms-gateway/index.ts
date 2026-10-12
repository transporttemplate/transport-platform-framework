import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { gatewayHandler } from "./handler.ts";
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false, autoRefreshToken: false } });
Deno.serve(gatewayHandler(db, Deno.env.get("SMS_LIVE_SENDING_ENABLED") === "true"));
