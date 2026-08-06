const db = getSupabase();

async function loadDashboard() {

    // Today's date
    const today = new Date().toISOString().split("T")[0];

    // Today's bookings
    const { data: bookings } = await db
        .from("bookings")
        .select("*")
        .eq("journey_date", today);

    document.getElementById("todayBookings").textContent =
        bookings ? bookings.length : 0;

    // Revenue
    let revenue = 0;

    if (bookings) {
        bookings.forEach(job => {
            revenue += Number(job.price || 0);
        });
    }

    document.getElementById("todayRevenue").textContent =
        "£" + revenue.toFixed(2);

    // Drivers
    const { data: drivers } = await db
        .from("drivers")
        .select("*");

    document.getElementById("driversOnline").textContent =
        drivers ? drivers.filter(d => d.online === true).length : 0;

    // Waiting jobs
    const waiting =
        bookings
            ? bookings.filter(j => j.status === "Waiting").length
            : 0;

    document.getElementById("jobsWaiting").textContent = waiting;
}

document.addEventListener("DOMContentLoaded", loadDashboard);