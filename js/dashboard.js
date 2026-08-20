const db = getSupabase();

async function loadDashboard() {
    try {
        const { companyId } = await window.getAdminCompanyContext();
        const today = new Date().toISOString().split("T")[0];

        const { data: bookings, error: bookingsError } = await db
            .from("bookings")
            .select("*")
            .eq("company_id", companyId)
            .eq("journey_date", today);

        if (bookingsError) throw bookingsError;

        const todayBookings = document.getElementById("todayBookings");
        if (todayBookings) todayBookings.textContent = bookings?.length || 0;

        let revenue = 0;
        (bookings || []).forEach(job => {
            revenue += Number(job.price ?? job.job_price ?? 0);
        });

        const todayRevenue = document.getElementById("todayRevenue");
        if (todayRevenue) todayRevenue.textContent = "£" + revenue.toFixed(2);

        const { data: drivers, error: driversError } = await db
            .from("drivers")
            .select("*")
            .eq("company_id", companyId);

        if (driversError) throw driversError;

        const driversOnline = document.getElementById("driversOnline");
        if (driversOnline) {
            driversOnline.textContent =
                (drivers || []).filter(d => d.online === true).length;
        }

        const waiting = (bookings || []).filter(job =>
            ["waiting", "assigned"].includes(
                String(job.status || job.booking_status || "").toLowerCase()
            )
        ).length;

        const jobsWaiting = document.getElementById("jobsWaiting");
        if (jobsWaiting) jobsWaiting.textContent = waiting;

    } catch (error) {
        console.error("Dashboard load error:", error);
    }
}

document.addEventListener("DOMContentLoaded", loadDashboard);
