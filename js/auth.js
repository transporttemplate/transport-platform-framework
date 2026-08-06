document.addEventListener("DOMContentLoaded", async () => {

    const db = getSupabase();

    const {
        data: { session }
    } = await db.auth.getSession();

    if (!session) {
        window.location.href = "login.html";
        return;
    }

    // Display logged in user if an element exists
    const userName = document.getElementById("userName");

    if (userName) {
        userName.textContent = session.user.email;
    }

});