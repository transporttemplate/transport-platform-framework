const bookingdb = getSupabase();

function generateBookingReference() {
    const now = new Date();

    const year = now.getFullYear().toString().slice(-2);
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");

    const random = Math.floor(1000 + Math.random() * 9000);

    return `BK${year}${month}${day}-${random}`;
}
async function loadAirports() {

    const airportSelect = document.getElementById("airportSelect");

    if (!airportSelect) return;

    const company = await loadCompanyConfig();

if (!company) {
    console.error("Unable to identify company");
    return;
}

const { data, error } = await bookingdb
    .from("airports")
    .select("*")
    .eq("company_id", company.id)
    .eq("active", true)
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true });

    if (error) {
        console.error(error);
        return;
    }

    airportSelect.innerHTML = '<option value="">Select Airport</option>';

    data.forEach((airport) => {
        airportSelect.innerHTML += `
            <option value="${airport.name}">
                ${airport.name} (from £${airport.price_1_4_oneway || 0})
            </option>
        `;
    });

}
document.addEventListener("DOMContentLoaded", () => {

    loadAirports();

    const form = document.getElementById("bookingForm");

    if (!form) return;

    form.addEventListener("submit", saveBooking);

});

async function saveBooking(e) {

    e.preventDefault();

    const company = await loadCompanyConfig();

if (!company) {
    alert("Unable to identify company. Please try again.");
    return;
}

    const booking = {

        company_id: company.id,

        booking_reference: generateBookingReference(),

        journey_type: document.getElementById("journeyType").value,

        pickup_address: document.getElementById("pickupAddress").value.trim(),

        dropoff_address: document.getElementById("dropoffAddress").value.trim(),

        airport: document.getElementById("airportSelect").value,

        flight_number: document.getElementById("flightNumber").value.trim(),

        journey_date: document.getElementById("journeyDate").value,

        journey_time: document.getElementById("journeyTime").value,

        customer_name: document.getElementById("customerName").value.trim(),

        email: document.getElementById("customerEmail").value.trim(),

        phone: document.getElementById("customerPhone").value.trim(),

        passengers: Number(document.getElementById("passengers").value),

        suitcases: Number(document.getElementById("suitcases").value),

        hand_luggage: Number(document.getElementById("handLuggage").value),

        notes: document.getElementById("notes").value.trim(),

        payment_method: document.getElementById("paymentMethod").value,

        status: "Waiting",

        price: 0

    };

    if (
        booking.customer_name === "" ||
        booking.phone === "" ||
        booking.pickup_address === "" ||
        booking.dropoff_address === "" ||
        booking.journey_date === "" ||
        booking.journey_time === ""
    ) {

        alert("Please complete all required fields.");

        return;

    }

    try {
        if (booking.airport) {

                const { data: airportPrice, error: airportError } = await bookingdb
                    .from("airports")
                    .select(`
                        price_1_4_oneway,
                        price_1_4_return,
                        price_5_7_oneway,
                        price_5_7_return
                    `)
                    .eq("company_id", company.id)
                    .eq("name", booking.airport)
                    .eq("active", true)
                    .single();
            
                if (airportError) {
                    console.error("Airport price error:", airportError);
                    alert("Unable to calculate airport price.");
                    return;
                }
            
                const isReturn =
                    booking.journey_type.toLowerCase().includes("return");
            
                if (booking.passengers >= 1 && booking.passengers <= 4) {
            
                    booking.price = Number(
                        isReturn
                            ? airportPrice.price_1_4_return
                            : airportPrice.price_1_4_oneway
                    );
            
                } else if (booking.passengers >= 5 && booking.passengers <= 7) {
            
                    booking.price = Number(
                        isReturn
                            ? airportPrice.price_5_7_return
                            : airportPrice.price_5_7_oneway
                    );
            
                } else {
            
                    alert("Please contact us for bookings of more than 7 passengers.");
                    return;
                }
            }

        let customerId = null;
        const { data: existingCustomer } = await bookingdb
        .from("customers")
        .select("id")
        .eq("company_id" , company.id)
        .eq("phone", booking.phone)
        .limit(1);

    if (existingCustomer && existingCustomer.length > 0) {

        customerId = existingCustomer[0].id;

    } else {

        const { data: newCustomer, error: customerError } = await bookingdb

            .from("customers")

            .insert({

                company_id: company.id,

                full_name: booking.customer_name,

                email: booking.email,

                phone: booking.phone

            })

            .select()

            .single();

        if (customerError) throw customerError;

        customerId = newCustomer.id;

    }

    console.log("PRICE TEST:", {
        airport: booking.airport,
        passengers: booking.passengers,
        journeyType: booking.journey_type,
        finalPrice: booking.price
    });

    const { error } = await bookingdb

        .from("bookings")

        .insert({
            company_id: company.id,

            booking_reference: booking.booking_reference,

            customer_id: customerId,

            customer_name: booking.customer_name,

            pickup_address: booking.pickup_address,

            dropoff_address: booking.dropoff_address,

            airport: booking.airport,

            flight_number: booking.flight_number,

            journey_type: booking.journey_type,

            journey_date: booking.journey_date,

            journey_time: booking.journey_time,

            phone: booking.phone,

            email: booking.email,

            passengers: booking.passengers,

            suitcases: booking.suitcases,

            hand_luggage: booking.hand_luggage,

            notes: booking.notes,

            payment_method: booking.payment_method,

            price: booking.price,

            status: booking.status

        });

    if (error) throw error;
    alert(
        "Booking created successfully!\n\nReference: " +
        booking.booking_reference
    );

    document.getElementById("bookingForm").reset();

    const summary = document.getElementById("bookingSummary");

    if (summary) {

        summary.innerHTML = `
            <h3>Booking Summary</h3>
            <p><strong>Booking Saved</strong></p>
            <p>Reference: ${booking.booking_reference}</p>
            <p>Status: Waiting</p>
        `;

    }

} catch (err) {

    console.error(err);

    alert(
        "Unable to save booking.\n\n" +
        "Open the browser console (F12) and tell me the error shown."
    );

}

}
async function initGoogleAutocomplete() {
        try {
            const { PlaceAutocompleteElement } =
                await google.maps.importLibrary("places");
    
            const pickupInput = document.getElementById("pickupAddress");
            const dropoffInput = document.getElementById("dropoffAddress");
    
            if (pickupInput) {
                const pickupAutocomplete = new PlaceAutocompleteElement({
                    includedRegionCodes: ["gb"]
                });
    
                pickupAutocomplete.placeholder = "Enter pickup address";
                pickupAutocomplete.id = "pickupAutocomplete";
    
                pickupInput.style.display = "none";
                pickupInput.parentNode.insertBefore(
                    pickupAutocomplete,
                    pickupInput.nextSibling
                );
    
                pickupAutocomplete.addEventListener("gmp-select", async (event) => {
                    const place = event.placePrediction.toPlace();
    
                    await place.fetchFields({
                        fields: ["formattedAddress", "location"]
                    });
    
                    pickupInput.value = place.formattedAddress || "";
    
                    pickupInput.dataset.lat = place.location?.lat() ?? "";
                    pickupInput.dataset.lng = place.location?.lng() ?? "";
    
                    pickupInput.dispatchEvent(new Event("change", {
                        bubbles: true
                    }));
                });
            }
    
            if (dropoffInput) {
                const dropoffAutocomplete = new PlaceAutocompleteElement({
                    includedRegionCodes: ["gb"]
                });
    
                dropoffAutocomplete.placeholder = "Enter destination";
                dropoffAutocomplete.id = "dropoffAutocomplete";
    
                dropoffInput.style.display = "none";
                dropoffInput.parentNode.insertBefore(
                    dropoffAutocomplete,
                    dropoffInput.nextSibling
                );
    
                dropoffAutocomplete.addEventListener("gmp-select", async (event) => {
                    const place = event.placePrediction.toPlace();
    
                    await place.fetchFields({
                        fields: ["formattedAddress", "location"]
                    });
    
                    dropoffInput.value = place.formattedAddress || "";
    
                    dropoffInput.dataset.lat = place.location?.lat() ?? "";
                    dropoffInput.dataset.lng = place.location?.lng() ?? "";
    
                    dropoffInput.dispatchEvent(new Event("change", {
                        bubbles: true
                    }));
                });
            }
    
            console.log("Google Places autocomplete loaded");
    
        } catch (error) {
            console.error("Google autocomplete error:", error);
        }
    }
    
    window.addEventListener("load", () => {
        initGoogleAutocomplete();
    });