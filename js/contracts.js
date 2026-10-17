const contractsDb = getSupabase();
let contractsCompanyId = null;
let contractRows = [];
let contractIntegrations = [];

document.addEventListener("DOMContentLoaded", async () => {
    try {
        const context = await getAdminCompanyContext();
        contractsCompanyId = context.companyId;
        bindContractEvents();
        await loadContracts();
    } catch (error) {
        showContractMessage(error.message || "Unable to load account customers.", true);
    }
});

function bindContractEvents() {
    document.getElementById("newAccount").onclick = () => openContractForm();
    document.getElementById("cancelAccount").onclick = closeContractForm;
    document.getElementById("accountForm").onsubmit = saveContract;
    document.getElementById("accountSearch").oninput = renderContracts;
    document.getElementById("accountStatusFilter").onchange = renderContracts;
    document.getElementById("accountColourPreset").onchange = event => { document.getElementById("accountColour").value = event.target.value; };
}

async function loadContracts() {
    const [accounts, integrations] = await Promise.all([
        contractsDb.from("account_customers").select("id,company_id,account_code,business_name,category,relationship,account_colour,contact_name,contact_phone,contact_email,billing_email,billing_address,billing_postcode,invoice_contact_name,company_registration,vat_number,payment_terms_days,default_payment_method,supplier_payment_terms,invoice_frequency,invoice_preferences,booking_rules,po_required,default_po_reference,status,notes,created_at,updated_at").eq("company_id", contractsCompanyId).order("business_name"),
        contractsDb.from("api_integrations").select("id,account_customer_id,status").eq("company_id", contractsCompanyId)
    ]);
    if (accounts.error) throw accounts.error;
    contractRows = accounts.data || [];
    contractIntegrations = integrations.error ? [] : integrations.data || [];
    renderContracts();
}

function renderContracts() {
    const query = document.getElementById("accountSearch").value.trim().toLowerCase();
    const status = document.getElementById("accountStatusFilter").value;
    const rows = contractRows.filter(account => (!status || account.status === status) && (!query || `${account.account_code} ${account.business_name} ${account.contact_name || ""} ${account.contact_email || ""}`.toLowerCase().includes(query)));
    const body = document.getElementById("accountRows");
    body.innerHTML = rows.map(account => { const integrations=contractIntegrations.filter(row=>row.account_customer_id===account.id); const api=integrations.some(row=>row.status==="active")?"Connected":integrations.length?"Disabled":"None"; return `<tr><td><span class="account-swatch" style="--account-colour:${escContract(account.account_colour)}"></span><strong>${escContract(account.business_name)}</strong><br><small>${escContract(account.account_code)}</small></td><td>${escContract(titleContract(account.category))}</td><td>${escContract(titleContract(account.relationship))}</td><td>${escContract(account.contact_name || "—")}<br><small>${escContract(account.contact_phone || account.contact_email || "")}</small></td><td>${escContract(titleContract(account.default_payment_method))} · ${Number(account.payment_terms_days || 0)} days</td><td>${escContract(api)}</td><td>${escContract(titleContract(account.status))}</td><td><button type="button" data-edit-account="${escContract(account.id)}">Edit</button></td></tr>`; }).join("") || '<tr><td colspan="8">No accounts found.</td></tr>';
    body.querySelectorAll("[data-edit-account]").forEach(button => button.onclick = () => openContractForm(button.dataset.editAccount));
}

function openContractForm(id = "") {
    const account = contractRows.find(row => row.id === id) || {};
    document.getElementById("accountForm").reset();
    document.getElementById("accountId").value = account.id || "";
    document.getElementById("accountCode").value = account.account_code || "";
    document.getElementById("businessName").value = account.business_name || "";
    document.getElementById("accountCategory").value = account.category || "private_business";
    document.getElementById("accountRelationship").value = account.relationship || "customer";
    document.getElementById("accountColour").value = account.account_colour || "#64748b";
    document.getElementById("contactName").value = account.contact_name || "";
    document.getElementById("contactPhone").value = account.contact_phone || "";
    document.getElementById("contactEmail").value = account.contact_email || "";
    document.getElementById("billingEmail").value = account.billing_email || "";
    document.getElementById("billingAddress").value = account.billing_address || "";
    document.getElementById("billingPostcode").value = account.billing_postcode || "";
    document.getElementById("invoiceContactName").value = account.invoice_contact_name || "";
    document.getElementById("companyRegistration").value = account.company_registration || "";
    document.getElementById("vatNumber").value = account.vat_number || "";
    document.getElementById("paymentTermsDays").value = account.payment_terms_days ?? 30;
    document.getElementById("defaultPaymentMethod").value = account.default_payment_method || "on_account";
    document.getElementById("supplierPaymentTerms").value = account.supplier_payment_terms || "on_account";
    document.getElementById("invoiceFrequency").value = account.invoice_frequency || "monthly";
    document.getElementById("poRequired").checked = account.po_required === true;
    document.getElementById("defaultPoReference").value = account.default_po_reference || "";
    document.getElementById("accountStatus").value = account.status || "active";
    document.getElementById("accountNotes").value = account.notes || "";
    const rules=account.booking_rules||{};
    document.getElementById("shareDriverPhone").checked = rules.share_driver_phone === true;
    document.getElementById("customerNotifications").checked = rules.customer_notifications !== false;
    document.getElementById("allowedVehicleCategories").value = Array.isArray(rules.allowed_vehicle_categories) ? rules.allowed_vehicle_categories.join(", ") : "";
    document.getElementById("providerReferenceFormat").value = rules.provider_reference_format || "";
    document.getElementById("accountFormTitle").textContent = account.id ? `Edit ${account.account_code}` : "New Account Customer";
    document.getElementById("accountFormCard").hidden = false;
    document.getElementById("accountCode").focus();
}

function closeContractForm() { document.getElementById("accountFormCard").hidden = true; }

async function saveContract(event) {
    event.preventDefault();
    const id = document.getElementById("accountId").value;
    const payload = {
        company_id: contractsCompanyId,
        account_code: document.getElementById("accountCode").value.trim().toUpperCase(),
        business_name: document.getElementById("businessName").value.trim(),
        category: document.getElementById("accountCategory").value, relationship: document.getElementById("accountRelationship").value,
        account_colour: document.getElementById("accountColour").value,
        contact_name: valueOrNull("contactName"), contact_phone: valueOrNull("contactPhone"),
        contact_email: valueOrNull("contactEmail"), billing_email: valueOrNull("billingEmail"),
        billing_address: valueOrNull("billingAddress"), billing_postcode: valueOrNull("billingPostcode"),
        invoice_contact_name: valueOrNull("invoiceContactName"), company_registration: valueOrNull("companyRegistration"), vat_number: valueOrNull("vatNumber"), payment_terms_days: Number(document.getElementById("paymentTermsDays").value || 0),
        default_payment_method: document.getElementById("defaultPaymentMethod").value, supplier_payment_terms: document.getElementById("supplierPaymentTerms").value, invoice_frequency: document.getElementById("invoiceFrequency").value,
        po_required: document.getElementById("poRequired").checked, default_po_reference: valueOrNull("defaultPoReference"),
        status: document.getElementById("accountStatus").value, notes: valueOrNull("accountNotes"),
        booking_rules: { share_driver_phone: document.getElementById("shareDriverPhone").checked, customer_notifications: document.getElementById("customerNotifications").checked, allowed_vehicle_categories: document.getElementById("allowedVehicleCategories").value.split(",").map(value=>value.trim()).filter(Boolean), provider_reference_format: valueOrNull("providerReferenceFormat") }
    };
    if (!payload.account_code || !payload.business_name) return showContractMessage("Account code and business name are required.", true);
    const query = id
        ? contractsDb.from("account_customers").update(payload).eq("id", id).eq("company_id", contractsCompanyId)
        : contractsDb.from("account_customers").insert(payload);
    const { data, error } = await query.select("id,company_id").maybeSingle();
    if (error || !data || String(data.company_id) !== String(contractsCompanyId)) return showContractMessage(error?.code === "23505" ? "That account code already exists for this company." : error?.message || "Account was not saved.", true);
    showContractMessage("Account saved.");
    closeContractForm();
    await loadContracts();
}

function valueOrNull(id) { return document.getElementById(id).value.trim() || null; }
function showContractMessage(message, error = false) { const el = document.getElementById("accountMessage"); if (el) { el.textContent = message; el.style.color = error ? "#b91c1c" : "#166534"; } }
function titleContract(value) { return String(value || "").replaceAll("_", " ").replace(/\b\w/g, letter => letter.toUpperCase()); }
function escContract(value) { return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;"); }
