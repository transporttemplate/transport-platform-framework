const contractsDb = getSupabase();
let contractsCompanyId = null;
let contractRows = [];
let contractIntegrations = [];
let contractContacts=[],contractHooks=[],contractActivity=[];

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
    document.querySelectorAll("[data-account-tab]").forEach(button=>button.onclick=()=>showAccountTab(button.dataset.accountTab));
    document.getElementById("saveExtraContact").onclick=saveExtraContact;
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

async function openContractForm(id = "") {
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
    const invoice=account.invoice_preferences||{};document.getElementById("invoiceShowReference").checked=invoice.show_booking_reference!==false;document.getElementById("invoiceShowJourney").checked=invoice.show_journey_date!==false;document.getElementById("invoiceShowRoute").checked=invoice.show_route!==false;document.getElementById("invoiceGroupBy").value=invoice.group_by||"booking";document.getElementById("invoiceFooter").value=invoice.footer||"";document.getElementById("invoiceCustomFields").value=Array.isArray(invoice.custom_fields)?invoice.custom_fields.join(", "):"";
    document.getElementById("accountFormTitle").textContent = account.id ? `Edit ${account.account_code}` : "New Account Customer";
    document.getElementById("accountFormCard").hidden = false;
    document.getElementById("accountCode").focus();
    showAccountTab("overview");
    await loadAccountWorkspace(account.id);
}

function showAccountTab(tab){document.querySelectorAll("[data-account-tab]").forEach(b=>b.classList.toggle("active",b.dataset.accountTab===tab));const groups={contacts:["accountContactsPanel"],booking:["shareDriverPhone","customerNotifications","allowedVehicleCategories","providerReferenceFormat"],payments:["paymentTermsDays","defaultPaymentMethod","supplierPaymentTerms","invoiceFrequency","poRequired","defaultPoReference"],invoice:["billingEmail","billingAddress","billingPostcode","invoiceContactName","accountInvoicePanel"],api:["accountApiPanel"],hooks:["accountHooksPanel"],activity:["accountActivityPanel"]};document.querySelectorAll("#accountFields>label,#accountFields>fieldset,#accountFields>section").forEach(node=>node.hidden=tab!=="overview");if(tab!=="overview")for(const id of groups[tab]||[]){const el=document.getElementById(id);if(el)(el.closest("label")||el).hidden=false}}
async function loadAccountWorkspace(id){contractContacts=[];contractHooks=[];contractActivity=[];if(id){const [contacts,hooks,activity,apis]=await Promise.all([contractsDb.from("account_contacts").select("*").eq("company_id",contractsCompanyId).eq("account_customer_id",id).order("is_primary",{ascending:false}),contractsDb.from("outbound_webhook_endpoints").select("id,url,event_types,status,event_mapping,payload_schema_key,gps_authorised").eq("company_id",contractsCompanyId).eq("account_customer_id",id),contractsDb.from("account_activity").select("action,details,created_at").eq("company_id",contractsCompanyId).eq("account_customer_id",id).order("created_at",{ascending:false}).limit(100),contractsDb.from("api_integrations").select("id,name,status,scopes,integration_type").eq("company_id",contractsCompanyId).eq("account_customer_id",id)]);contractContacts=contacts.data||[];contractHooks=hooks.data||[];contractActivity=activity.data||[];document.getElementById("accountApiList").innerHTML=(apis.data||[]).map(x=>`<p><strong>${escContract(x.name)}</strong> · ${escContract(x.status)}<br><small>${escContract((x.scopes||[]).join(", "))}</small></p>`).join("")||'<p>No API integration mapped.</p>'}renderAccountWorkspace()}
function renderAccountWorkspace(){document.getElementById("accountContactList").innerHTML=contractContacts.map(x=>`<p><strong>${escContract(x.name)}</strong> · ${escContract(x.role||"")}<br><small>${escContract(x.email||x.phone||"")}${x.is_primary?" · Primary":""}${x.billing_contact?" · Billing":""}</small></p>`).join("")||'<p>No additional contacts.</p>';document.getElementById("accountHookList").innerHTML=contractHooks.map(x=>`<p><strong>${escContract(x.status)}</strong> · ${escContract(new URL(x.url).hostname)}<br><small>${escContract((x.event_types||[]).join(", "))}</small></p>`).join("")||'<p>No webhook mapped. Configure dormant hooks in API Management.</p>';document.getElementById("accountActivityList").innerHTML=contractActivity.map(x=>`<p><strong>${escContract(titleContract(x.action))}</strong><br><small>${new Date(x.created_at).toLocaleString()} · ${escContract((x.details?.changed_fields||[]).join(", "))}</small></p>`).join("")||'<p>No activity yet.</p>'}
async function saveExtraContact(){const accountId=document.getElementById("accountId").value;if(!accountId)return showContractMessage("Save the account before adding contacts.",true);const name=valueOrNull("extraContactName");if(!name)return showContractMessage("Contact name is required.",true);const{error}=await contractsDb.from("account_contacts").insert({company_id:contractsCompanyId,account_customer_id:accountId,name,role:valueOrNull("extraContactRole"),email:valueOrNull("extraContactEmail"),phone:valueOrNull("extraContactPhone"),is_primary:document.getElementById("extraContactPrimary").checked,billing_contact:document.getElementById("extraContactBilling").checked});if(error)return showContractMessage(error.message,true);await loadAccountWorkspace(accountId);showContractMessage("Contact added.")}

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
        booking_rules: { share_driver_phone: document.getElementById("shareDriverPhone").checked, customer_notifications: document.getElementById("customerNotifications").checked, allowed_vehicle_categories: document.getElementById("allowedVehicleCategories").value.split(",").map(value=>value.trim()).filter(Boolean), provider_reference_format: valueOrNull("providerReferenceFormat") },
        invoice_preferences:{show_booking_reference:document.getElementById("invoiceShowReference").checked,show_journey_date:document.getElementById("invoiceShowJourney").checked,show_route:document.getElementById("invoiceShowRoute").checked,group_by:document.getElementById("invoiceGroupBy").value,footer:valueOrNull("invoiceFooter"),custom_fields:document.getElementById("invoiceCustomFields").value.split(",").map(x=>x.trim()).filter(Boolean)}
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
