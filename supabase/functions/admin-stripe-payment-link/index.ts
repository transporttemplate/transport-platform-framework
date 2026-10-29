import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type Row = Record<string, any>;
const cors = {"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization,x-client-info,apikey,content-type","Content-Type":"application/json"};
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {auth:{persistSession:false,autoRefreshToken:false}});
const reply = (body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:cors});
class SafeError extends Error { constructor(public status:number,message:string){super(message)} }

Deno.serve(async request=>{
  if(request.method==="OPTIONS")return new Response("ok",{headers:cors});
  if(request.method!=="POST")return reply({ok:false,error:"Method not allowed"},405);
  try{
    const token=request.headers.get("authorization")?.replace(/^Bearer\s+/i,"")||"";
    const {data:{user}}=await db.auth.getUser(token);
    if(!user)throw new SafeError(401,"Admin login required");
    const body=await request.json(),companyId=clean(body.company_id),bookingId=clean(body.booking_id),paymentKind=clean(body.payment_kind);
    if(!companyId||!bookingId||!["deposit_20","full"].includes(paymentKind||""))throw new SafeError(400,"Company, booking and payment type are required");
    const platform=["platform_admin","super_admin"].includes(String(user.app_metadata?.platform_role||"").toLowerCase());
    const membership=await db.from("company_users").select("role,active,permission_grants,permission_denials").eq("company_id",companyId).eq("user_id",user.id).maybeSingle();
    const role=String(membership.data?.role||"").toLowerCase(),denied=(membership.data?.permission_denials||[]).includes("payments.record"),granted=(membership.data?.permission_grants||[]).includes("payments.record");
    if(!platform&&(!membership.data?.active||denied||(!["owner","admin"].includes(role)&&!granted)))throw new SafeError(403,"Payment recording permission is required");
    const [{data:company,error:companyError},{data:booking,error:bookingError},{data:settings,error:settingsError}]=await Promise.all([
      db.from("companies").select("id,company_code,trading_name,name,company_status").eq("id",companyId).maybeSingle(),
      db.from("bookings").select("id,company_id,booking_reference,customer_name,email,phone,price,amount_paid,balance_due,payment_status,status").eq("company_id",companyId).eq("id",bookingId).maybeSingle(),
      db.from("settings").select("company_id,enablestripe,stripe_payment_links_enabled,stripepublishablekey,currencysymbol").eq("company_id",companyId).maybeSingle()
    ]);
    if(companyError||bookingError||settingsError)throw companyError||bookingError||settingsError;
    if(!company||!booking||!settings)throw new SafeError(404,"Booking or company payment settings were not found");
    if(settings.stripe_payment_links_enabled!==true)throw new SafeError(403,"Stripe Payment Links are not enabled for this company");
    if(["trial","suspended","cancelled"].includes(String(company.company_status||"active").toLowerCase()))throw new SafeError(403,"Payment links are unavailable for this company status");
    if(["cancelled","canceled","archived","no_show"].includes(String(booking.status||"").toLowerCase()))throw new SafeError(409,"Payment links cannot be created for this booking status");
    const balance=moneyNumber(booking.balance_due);
    if(balance<=0||["paid","refunded"].includes(String(booking.payment_status||"").toLowerCase()))throw new SafeError(409,"This booking has no outstanding balance");
    if(paymentKind==="deposit_20"&&moneyNumber(booking.amount_paid)>0)throw new SafeError(409,"A deposit link is available only before any payment has been received");
    const publishable=clean(settings.stripepublishablekey),secret=stripeSecretForCompany(String(company.company_code||""));
    if(settings.enablestripe!==true||!publishable?.startsWith("pk_test_")||!secret?.startsWith("sk_test_"))throw new SafeError(503,"Stripe TEST MODE is not configured for this company");
    const amount=paymentKind==="deposit_20"?round2(balance*.20):balance,minor=Math.round(amount*100);
    if(minor<50)throw new SafeError(400,"The requested payment amount is too small");
    const prior=await db.from("admin_payment_links").select("checkout_url,amount,payment_kind,status").eq("company_id",companyId).eq("booking_id",bookingId).eq("payment_kind",paymentKind).eq("amount",amount).eq("status","pending").maybeSingle();
    if(prior.error)throw prior.error;
    if(prior.data)return reply({ok:true,url:prior.data.checkout_url,amount,payment_kind:paymentKind,test_mode:true,duplicate:true});
    const otherPending=await db.from("admin_payment_links").select("id").eq("company_id",companyId).eq("booking_id",bookingId).eq("status","pending").limit(1);
    if(otherPending.error)throw otherPending.error;
    if(otherPending.data?.length)throw new SafeError(409,"This booking already has a different pending payment link. Complete or expire it before creating another.");
    const history=await db.from("admin_payment_links").select("id",{count:"exact",head:true}).eq("company_id",companyId).eq("booking_id",bookingId).eq("payment_kind",paymentKind).eq("amount",amount).neq("status","pending");
    if(history.error)throw history.error;
    const idempotencyKey=`admin-link-${companyId}-${bookingId}-${paymentKind}-${minor}-${history.count||0}`,site=publicSiteUrl(),form=new URLSearchParams();
    form.set("mode","payment");form.set("client_reference_id",String(booking.id));
    form.set("success_url",`${site}/booking.html?payment=success&company=${encodeURIComponent(String(company.company_code))}`);
    form.set("cancel_url",`${site}/booking.html?payment=cancelled&company=${encodeURIComponent(String(company.company_code))}`);
    if(clean(booking.email))form.set("customer_email",String(clean(booking.email)));
    form.set("line_items[0][quantity]","1");form.set("line_items[0][price_data][currency]","gbp");form.set("line_items[0][price_data][unit_amount]",String(minor));
    form.set("line_items[0][price_data][product_data][name]",`${paymentKind==="deposit_20"?"20% deposit":"Outstanding balance"} — ${clean(booking.booking_reference)}`);
    for(const [key,value] of Object.entries({company_id:companyId,booking_id:bookingId,booking_reference:booking.booking_reference,payment_type:paymentKind==="deposit_20"?"deposit":"full",source:"admin_payment_link"})){
      form.set(`payment_intent_data[metadata][${key}]`,String(value||""));form.set(`metadata[${key}]`,String(value||""));
    }
    const stripeResponse=await fetch("https://api.stripe.com/v1/checkout/sessions",{method:"POST",headers:{Authorization:`Bearer ${secret}`,"Content-Type":"application/x-www-form-urlencoded","Idempotency-Key":idempotencyKey},body:form});
    const session=await stripeResponse.json();
    if(!stripeResponse.ok||!session?.url||!session?.payment_intent){console.error("admin payment link Stripe failure",{companyId,bookingId,status:stripeResponse.status,type:session?.error?.type});throw new SafeError(502,"Stripe could not create the test payment link")}
    const reference=String(session.payment_intent),existing=await db.from("payments").select("id,amount,status,reference").eq("company_id",companyId).eq("reference",reference).maybeSingle();
    if(existing.error)throw existing.error;
    if(existing.data&&(Number(existing.data.amount)!==amount||!["pending","failed"].includes(String(existing.data.status))))throw new SafeError(409,"The existing payment link no longer matches this booking balance");
    if(!existing.data){const inserted=await db.from("payments").insert({company_id:companyId,booking_id:bookingId,amount,method:"stripe",status:"pending",reference});if(inserted.error)throw inserted.error}
    const linkInsert=await db.from("admin_payment_links").insert({company_id:companyId,booking_id:bookingId,payment_kind:paymentKind,amount,stripe_checkout_session_id:String(session.id),stripe_payment_intent_id:reference,checkout_url:String(session.url),status:"pending",created_by:user.id});
    if(linkInsert.error){
      const concurrent=await db.from("admin_payment_links").select("checkout_url").eq("company_id",companyId).eq("booking_id",bookingId).eq("payment_kind",paymentKind).eq("amount",amount).eq("status","pending").maybeSingle();
      if(concurrent.data?.checkout_url)return reply({ok:true,url:concurrent.data.checkout_url,amount,payment_kind:paymentKind,test_mode:true,duplicate:true});
      throw linkInsert.error;
    }
    const audit=await db.from("admin_booking_audit").insert({company_id:companyId,booking_id:bookingId,booking_reference:booking.booking_reference,admin_user_id:user.id,changed_fields:["payment_link_created"],previous_values:{balance_due:balance},new_values:{payment_kind:paymentKind,amount,test_mode:true},change_reason:`${paymentKind}:${amount.toFixed(2)}:test_mode`});
    if(audit.error)throw audit.error;
    return reply({ok:true,url:session.url,amount,payment_kind:paymentKind,test_mode:true,duplicate:false});
  }catch(error){const status=error instanceof SafeError?error.status:500;console.error("admin-stripe-payment-link",{status,error:error instanceof Error?error.message:"Unexpected error"});return reply({ok:false,error:status===500?"Unable to create the test payment link":(error as Error).message},status)}
});

function stripeSecretForCompany(code:string){if(!/^\d{4}$/.test(code))return null;return clean(Deno.env.get(`STRIPE_SECRET_KEY_${code}`))||(code==="0001"?clean(Deno.env.get("STRIPE_SECRET_KEY")):null)}
function publicSiteUrl(){const value=String(Deno.env.get("PUBLIC_SITE_URL")||"").trim().replace(/\/$/,"");if(!/^https:\/\//i.test(value))throw new SafeError(503,"The public payment return URL is not configured");return value}
function clean(value:unknown){return String(value??"").trim()||null}
function round2(value:number){return Math.round(value*100)/100}
function moneyNumber(value:unknown){const parsed=Number(value);return Number.isFinite(parsed)?Math.max(0,round2(parsed)):0}
