import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { gatewayHandler } from "./handler.ts";
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false, autoRefreshToken: false } });
// Release 9.2 delegates the live decision to the audited per-company database
// master switch. The handler's legacy deployment kill switch remains testable.
Deno.serve(gatewayHandler(db, true));
