const contractsDb = getSupabase();
let contractsCompanyId = null;
let contractRows = [];

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
}

async function loadContracts() {
    const { data, error } = await contractsDb.from("account_customers")
        .select("id,company_id,account_code,business_name,contact_name,contact_phone,contact_email,billing_email,billing_address,billing_postcode,invoice_contact_name,payment_terms_days,po_required,default_po_reference,status,notes,created_at,updated_at")
        .eq("company_id", contractsCompanyId).order("business_name");
    if (error) throw error;
    contractRows = data || [];
    renderContracts();
}

function renderContracts() {
    const query = document.getElementById("accountSearch").value.trim().toLowerCase();
    const status = document.getElementById("accountStatusFilter").value;
    const rows = contractRows.filter(account => (!status || account.status === status) && (!query || `${account.account_code} ${account.business_name} ${account.contact_name || ""} ${account.contact_email || ""}`.toLowerCase().includes(query)));
    const body = document.getElementById("accountRows");
    body.innerHTML = rows.map(account => `<tr><td><strong>${escContract(account.account_code)}</strong></td><td>${escContract(account.business_name)}</td><td>${escContract(account.contact_name || "—")}<br><small>${escContract(account.contact_phone || account.contact_email || "")}</small></td><td>${escContract(account.billing_email || "—")}</td><td>${Number(account.payment_terms_days || 0)} days</td><td>${escContract(titleContract(account.status))}</td><td><button type="button" data-edit-account="${escContract(account.id)}">Edit</button></td></tr>`).join("") || '<tr><td colspan="7">No account customers found.</td></tr>';
    body.querySelectorAll("[data-edit-account]").forEach(button => button.onclick = () => openContractForm(button.dataset.editAccount));
}

function openContractForm(id = "") {
    const account = contractRows.find(row => row.id === id) || {};
    document.getElementById("accountForm").reset();
    document.getElementById("accountId").value = account.id || "";
    document.getElementById("accountCode").value = account.account_code || "";
    document.getElementById("businessName").value = account.business_name || "";
    document.getElementById("contactName").value = account.contact_name || "";
    document.getElementById("contactPhone").value = account.contact_phone || "";
    document.getElementById("contactEmail").value = account.contact_email || "";
    document.getElementById("billingEmail").value = account.billing_email || "";
    document.getElementById("billingAddress").value = account.billing_address || "";
    document.getElementById("billingPostcode").value = account.billing_postcode || "";
    document.getElementById("invoiceContactName").value = account.invoice_contact_name || "";
    document.getElementById("paymentTermsDays").value = account.payment_terms_days ?? 30;
    document.getElementById("poRequired").checked = account.po_required === true;
    document.getElementById("defaultPoReference").value = account.default_po_reference || "";
    document.getElementById("accountStatus").value = account.status || "active";
    document.getElementById("accountNotes").value = account.notes || "";
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
        contact_name: valueOrNull("contactName"), contact_phone: valueOrNull("contactPhone"),
        contact_email: valueOrNull("contactEmail"), billing_email: valueOrNull("billingEmail"),
        billing_address: valueOrNull("billingAddress"), billing_postcode: valueOrNull("billingPostcode"),
        invoice_contact_name: valueOrNull("invoiceContactName"), payment_terms_days: Number(document.getElementById("paymentTermsDays").value || 0),
        po_required: document.getElementById("poRequired").checked, default_po_reference: valueOrNull("defaultPoReference"),
        status: document.getElementById("accountStatus").value, notes: valueOrNull("accountNotes")
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
