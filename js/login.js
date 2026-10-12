document.addEventListener("DOMContentLoaded", () => {

    const loginBtn = document.getElementById("loginBtn");
    const message = document.getElementById("loginMessage");

    loginBtn.addEventListener("click", async () => {

        const email = document.getElementById("email").value.trim();
        const password = document.getElementById("password").value;

        if (!email || !password) {
            message.textContent = "Please enter email and password.";
            return;
        }

        const db = getSupabase();

        const requestedCompany=await resolveLoginCompanyCode(db);

        const { error } = await db.auth.signInWithPassword({
            email,
            password
        });

        if (error) {
            message.textContent = error.message;
            return;
        }

        const {data:{user},error:userError}=await db.auth.getUser();
        if(userError||!user){
            await db.auth.signOut();
            message.textContent="Unable to verify your login.";
            return;
        }

        const {data:memberships,error:membershipError}=await db
            .from("company_users")
            .select("company_id,role,companies!inner(company_code)")
            .eq("user_id",user.id);
        const adminMemberships=(memberships||[]).filter(item=>["admin","owner"].includes(String(item.role||"").trim().toLowerCase()));
        if(membershipError||!adminMemberships.length){
            await db.auth.signOut();
            message.textContent=membershipError?.message||"Your login is not linked to an Admin account.";
            return;
        }

        const requestedMembership=/^[a-z0-9_-]+$/i.test(requestedCompany)
            ?adminMemberships.find(item=>String(item.companies?.company_code||"").toLowerCase()===requestedCompany.toLowerCase())
            :null;
        if(requestedCompany&&!requestedMembership){
            await db.auth.signOut();
            message.textContent="Your login is not authorised for this company.";
            return;
        }
        const membership=requestedMembership||adminMemberships.find(item=>String(item.companies?.company_code)==="0001")||adminMemberships[0];
        const destination=new URL("dashboard.html",window.location.href);
        destination.searchParams.set("company",membership.companies.company_code);
        window.location.href=`dashboard.html${destination.search}${destination.hash}`;

    });

});

async function resolveLoginCompanyCode(db){
    const query=String(new URLSearchParams(window.location.search).get("company")||"").trim();
    if(/^[a-z0-9_-]+$/i.test(query))return query;
    const hostname=String(window.location.hostname||"").trim().toLowerCase().replace(/\.$/,"");
    if(!hostname)return "";
    const{data}=await db.from("company_domains").select("companies!inner(company_code)").eq("hostname",hostname).eq("active",true).maybeSingle();
    return String(data?.companies?.company_code||"").trim();
}
