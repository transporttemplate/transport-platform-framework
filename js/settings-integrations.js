const integrationsDb = getSupabase();
const INTEGRATION_FIELDS = Object.freeze({
    googleMapsApi: "googlemapsapi",
    googleCalendarId: "googlecalendarid"
});

let integrationCompanyId = null;
let integrationSettingsId = null;
let originalIntegrationValues = {};

document.addEventListener("DOMContentLoaded", async () => {
    const saveButton = document.getElementById("saveSettings");
    if (saveButton) saveButton.disabled = true;

    try {
        const context = await window.getAdminCompanyContext();
        integrationCompanyId = context.companyId;
        await loadIntegrationSettings();
        await loadEmailProviderStatus();
        if (saveButton) {
            saveButton.disabled = false;
            saveButton.addEventListener("click", saveIntegrationSettings);
        }
    } catch (error) {
        console.error("Integration settings startup error:", error);
        showIntegrationStatus(error.message || "Integration settings could not be loaded.", true);
    }
});

async function loadIntegrationSettings() {
    if (!integrationCompanyId) throw new Error("Authenticated company context is unavailable.");

    // Deliberately excludes all server-secret and deployment credential columns.
    const { data, error } = await integrationsDb
        .from("settings")
        .select("id,company_id,googlemapsapi,googlecalendarid,enablestripe,stripepublishablekey")
        .eq("company_id", integrationCompanyId)
        .maybeSingle();

    if (error) throw error;
    if (!data || String(data.company_id) !== String(integrationCompanyId)) {
        throw new Error("The integration settings row for your company is not accessible.");
    }

    integrationSettingsId = data.id;
    originalIntegrationValues = {};
    for (const [elementId, column] of Object.entries(INTEGRATION_FIELDS)) {
        const value = String(data[column] || "");
        originalIntegrationValues[column] = value;
        const input = document.getElementById(elementId);
        if (input) input.value = value;
    }

    setText("googleMapsStatus", configuredStatus(data.googlemapsapi));
    setText("googleCalendarStatus", configuredStatus(data.googlecalendarid));
    const stripeConfigured = data.enablestripe === true && isStripeTestPublishableKey(data.stripepublishablekey);
    setText("stripeStatus", stripeConfigured ? "Configured (test mode)" : "Not configured");
    setText(
        "stripeConfigurationNote",
        stripeConfigured
            ? "Stripe test payments are enabled for this company. Secret keys remain stored server-side."
            : "Stripe test payments are not configured. Enable Stripe and save a valid pk_test_ publishable key in Payment Settings; secret keys remain server-side."
    );
    showIntegrationStatus("");
}

async function loadEmailProviderStatus() {
    const { data, error } = await integrationsDb.functions.invoke("send-booking-email", {
        body: { company_id: integrationCompanyId, event: "provider_status" }
    });
    setText("emailProviderStatus", !error && data?.configured ? "Configured" : "Not configured");
}

async function saveIntegrationSettings() {
    if (!integrationCompanyId || !integrationSettingsId) {
        return showIntegrationStatus("Integration settings were not loaded, so no save was attempted.", true);
    }

    const patch = {};
    const cleared = [];
    for (const [elementId, column] of Object.entries(INTEGRATION_FIELDS)) {
        const input = document.getElementById(elementId);
        if (!input) continue;
        const nextValue = input.value.trim();
        const previousValue = originalIntegrationValues[column] || "";
        if (nextValue === previousValue) continue;
        patch[column] = nextValue || null;
        if (previousValue && !nextValue) cleared.push(column);
    }

    if (!Object.keys(patch).length) {
        return showIntegrationStatus("No integration changes to save.");
    }

    const warning = cleared.length
        ? "You are clearing a configured integration value. This may immediately stop the service working.\n\nAre you sure you want to change this integration setting?"
        : "Are you sure you want to change this integration setting?";
    if (!window.confirm(warning)) return;

    const saveButton = document.getElementById("saveSettings");
    if (saveButton) saveButton.disabled = true;
    showIntegrationStatus("Saving…");

    const { data, error } = await integrationsDb
        .from("settings")
        .update(patch)
        .eq("id", integrationSettingsId)
        .eq("company_id", integrationCompanyId)
        .select("id,company_id,googlemapsapi,googlecalendarid")
        .maybeSingle();

    if (saveButton) saveButton.disabled = false;
    if (error) {
        console.error("Integration settings save error:", error);
        return showIntegrationStatus(error.message, true);
    }
    if (!data || String(data.id) !== String(integrationSettingsId) || String(data.company_id) !== String(integrationCompanyId)) {
        return showIntegrationStatus("No matching company integration row was updated.", true);
    }

    await loadIntegrationSettings();
    showIntegrationStatus("Integration settings saved successfully.", false, true);
}

function configuredStatus(value) {
    return String(value || "").trim() ? "Configured" : "Not configured";
}

function isStripeTestPublishableKey(value) {
    return String(value || "").trim().startsWith("pk_test_");
}

function setText(id, value) {
    const element = document.getElementById(id);
    if (element) element.textContent = value;
}

function showIntegrationStatus(message, isError = false, isSuccess = false) {
    const element = document.getElementById("integrationSaveStatus");
    if (!element) return;
    element.textContent = message;
    element.classList.toggle("error", isError);
    element.classList.toggle("success", isSuccess);
}
