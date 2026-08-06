const db = getSupabase();

async function loadDashboard() {

    const today = new Date().toISOString().split("T")[0];

    // Today's bookings
    const { data: bookings } = await db
        .from("bookings")
        .select("*")
        .eq("journey_date", today);

    document.getElementById("todayBookings").textContent =
        bookings ? bookings.length : 0;

    // Today's revenue
    let revenue = 0;

    if (bookings) {
        bookings.forEach(job => {
            revenue += Number(job.price || 0);
        });
    }

    document.getElementById("todayRevenue").textContent =
        "£" + revenue.toFixed(2);

}

document.addEventListener("DOMContentLoaded", loadDashboard);