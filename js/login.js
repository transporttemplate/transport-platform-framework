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

        const requestedCompany=String(new URLSearchParams(window.location.search).get("company")||"").trim();
        const destination=new URL("dashboard.html",window.location.href);
        if(/^[a-z0-9_-]+$/i.test(requestedCompany))destination.searchParams.set("company",requestedCompany);
        window.location.href=`dashboard.html${destination.search}${destination.hash}`;

    });

});
