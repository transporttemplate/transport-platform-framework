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
            .select("company_id,companies!inner(company_code)")
            .eq("user_id",user.id);
        if(membershipError||!memberships?.length){
            await db.auth.signOut();
            message.textContent=membershipError?.message||"Your login is not linked to a company.";
            return;
        }

        const requestedCompany=String(new URLSearchParams(window.location.search).get("company")||"").trim();
        const requestedMembership=/^[a-z0-9_-]+$/i.test(requestedCompany)
            ?memberships.find(item=>String(item.companies?.company_code||"").toLowerCase()===requestedCompany.toLowerCase())
            :null;
        const membership=requestedMembership||memberships.find(item=>String(item.companies?.company_code)==="0001")||memberships[0];
        const destination=new URL("dashboard.html",window.location.href);
        destination.searchParams.set("company",membership.companies.company_code);
        window.location.href=`dashboard.html${destination.search}${destination.hash}`;

    });

});
