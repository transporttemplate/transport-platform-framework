const VEHICLE_TIERS = [
    { id: "standard", label: "Car", art: "CAR", capacity: 4, allow: "allowvehicle_standard", uplift: null },
    { id: "5_8", label: "5–8 Seater", art: "5–8", capacity: 8, allow: "allowvehicle_5_8", uplift: "vehicleuplift_5_8_percent" },
    { id: "9_16", label: "9–16 Seater", art: "9–16", capacity: 16, allow: "allowvehicle_9_16", uplift: "vehicleuplift_9_16_percent" },
    { id: "17_23", label: "17–23 Seater", art: "17–23", capacity: 23, allow: "allowvehicle_17_23", uplift: "vehicleuplift_17_23_percent" },
    { id: "24_52", label: "24–52 Seater", art: "24–52", capacity: 52, allow: "allowvehicle_24_52", uplift: "vehicleuplift_24_52_percent" }
];

const legacyLoadPricingSettings = loadPricingSettings;
loadPricingSettings = async function loadVehicleCapacityPricingSettings() {
    await legacyLoadPricingSettings();
    const result = await bookingdb.from("settings").select("allowvehicle_standard,allowvehicle_5_8,allowvehicle_9_16,allowvehicle_17_23,allowvehicle_24_52,vehicleuplift_5_8_percent,vehicleuplift_9_16_percent,vehicleuplift_17_23_percent,vehicleuplift_24_52_percent").eq("company_id", bookingCompany.id).maybeSingle();
    if (result.error) {
        console.info("Vehicle capacity pricing migration is not installed; using Car and 5–8 compatibility defaults.");
        Object.assign(pricingSettings, { allowvehicle_standard: true, allowvehicle_5_8: true, allowvehicle_9_16: false, allowvehicle_17_23: false, allowvehicle_24_52: false });
    } else Object.assign(pricingSettings, result.data || {});
    if (pricingSettings.allowvehicle_standard == null) pricingSettings.allowvehicle_standard = true;
    if (pricingSettings.allowvehicle_5_8 == null) pricingSettings.allowvehicle_5_8 = true;
    if (pricingSettings.vehicleuplift_5_8_percent == null) pricingSettings.vehicleuplift_5_8_percent = settingNumber(["bookingfee"], 0);
    renderVehicleTierCards();
    calculatePrices();
};

function renderVehicleTierCards() {
    const grid = document.getElementById("vehicleTierGrid");
    if (!grid) return;
    grid.innerHTML = VEHICLE_TIERS.map(tier => `<button type="button" class="vehicle-card" data-vehicle="${tier.id}"><div class="vehicle-art">${tier.art}</div><div class="vehicle-copy"><strong>${tier.label}</strong><span>Up to ${tier.capacity} passengers</span></div><div class="vehicle-price" id="tierPrice-${tier.id}">—</div></button>`).join("");
    grid.querySelectorAll(".vehicle-card").forEach(card => card.addEventListener("click", () => {
        if (card.hidden || card.classList.contains("disabled")) return;
        grid.querySelectorAll(".vehicle-card").forEach(item => item.classList.remove("active"));
        card.classList.add("active");
        document.getElementById("vehicleType").value = card.dataset.vehicle;
        selectPrice(); updateLiveFare(); buildSummary();
    }));
}

calculatePrices = function calculateVehicleTierPrices() {
    const mode = document.getElementById("journeyMode").value;
    const isReturn = document.getElementById("returnJourney").checked;
    const prices = {};
    if (mode === "airport") {
        const airport = findAirport();
        if (airport) {
            const trip = isReturn ? "return" : "oneway";
            const standardBase = Number(airport[`price_1_4_${trip}`]);
            const largerBase = Number(airport[`price_5_7_${trip}`]);
            const viaTotal = collectPublicViaStops().length * Math.max(0, settingNumber(["airportviasurcharge"], 0));
            prices.standard = Number.isFinite(standardBase) ? standardBase + viaTotal : null;
            prices["5_8"] = Number.isFinite(largerBase) && largerBase > 0 ? largerBase + viaTotal : null;
            for (const tier of VEHICLE_TIERS.slice(2)) prices[tier.id] = Number.isFinite(standardBase) && standardBase > 0 ? round(standardBase * (1 + vehicleTierUplift(tier) / 100) + viaTotal) : null;
        }
        currentPrices.method = "Airport fixed price";
        document.getElementById("routePricingType").textContent = "Airport fixed";
    } else {
        const legacyUplift = pricingSettings.bookingfee;
        pricingSettings.bookingfee = 0;
        const base = distanceFare(currentRoute.miles);
        pricingSettings.bookingfee = legacyUplift;
        for (const tier of VEHICLE_TIERS) prices[tier.id] = Number.isFinite(base) ? round(base * (1 + vehicleTierUplift(tier) / 100)) : null;
        currentPrices.method = "Distance price";
        document.getElementById("routePricingType").textContent = "Distance";
    }
    currentPrices.tiers = prices;
    currentPrices.car = prices.standard;
    currentPrices.mpv = prices["5_8"];
    updateVehicleCards(); selectPrice(); updateLiveFare();
};

updateVehicleCards = function updateVehicleTierCards() {
    const passengers = Number(document.getElementById("passengers").value || 0);
    const valid = VEHICLE_TIERS.filter(tier => pricingSettings[tier.allow] === true && passengers <= tier.capacity);
    for (const tier of VEHICLE_TIERS) {
        const card = document.querySelector(`[data-vehicle="${tier.id}"]`);
        if (!card) continue;
        const available = valid.includes(tier);
        card.hidden = !available;
        card.classList.toggle("disabled", !Number.isFinite(currentPrices.tiers?.[tier.id]));
        const price = document.getElementById(`tierPrice-${tier.id}`);
        if (price) price.textContent = money(currentPrices.tiers?.[tier.id]);
    }
    const input = document.getElementById("vehicleType");
    if (!valid.some(tier => tier.id === input.value && Number.isFinite(currentPrices.tiers?.[tier.id]))) {
        const first = valid.find(tier => Number.isFinite(currentPrices.tiers?.[tier.id]));
        input.value = first?.id || "";
    }
    document.querySelectorAll(".vehicle-card").forEach(card => card.classList.toggle("active", card.dataset.vehicle === input.value));
    document.getElementById("vehiclePriceNote").textContent = valid.length ? "Select a vehicle to continue." : "No suitable vehicle is currently available for this group size. Please contact us.";
};

selectPrice = function selectVehicleTierPrice() {
    currentPrices.selected = currentPrices.tiers?.[document.getElementById("vehicleType").value] ?? null;
    document.getElementById("finalPrice").textContent = money(currentPrices.selected);
};

function vehicleTierUplift(tier) { return tier.uplift ? Math.max(0, settingNumber([tier.uplift], 0)) : 0; }
