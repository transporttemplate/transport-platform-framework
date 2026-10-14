const driversDb = getSupabase();

let currentCompanyId = null;
let allDrivers = [];
let selectedDriver = null;
let adminAccountsSnapshot = null;
let allVehicles = [];

document.addEventListener("DOMContentLoaded", async () => {
    bindDriverManagementUI();
    try {
        const context = await window.getAdminCompanyContext();
        currentCompanyId = context.companyId;
        await Promise.all([loadDrivers(),loadVehicles()]);
    } catch (error) {
        console.error("Driver management startup error:", error);
        renderDriverError("Unable to load the signed-in company.");
    }
});

function bindDriverManagementUI() {
    document.getElementById("addDriverButton")?.addEventListener("click", () => openDriverForm());

    document.getElementById("closeDriverModalButton")?.addEventListener("click", closeDriverForm);
    document.getElementById("cancelDriverButton")?.addEventListener("click", closeDriverForm);
    document.getElementById("driverModalBackdrop")?.addEventListener("click", event => {
        if (event.target.id === "driverModalBackdrop") closeDriverForm();
    });

    document.getElementById("driverForm")?.addEventListener("submit", saveDriver);

    document.getElementById("closeViewDriverButton")?.addEventListener("click", closeViewDriver);
    document.getElementById("closeViewDriverBottomButton")?.addEventListener("click", closeViewDriver);
    document.getElementById("viewDriverBackdrop")?.addEventListener("click", event => {
        if (event.target.id === "viewDriverBackdrop") closeViewDriver();
    });

    document.getElementById("editDriverButton")?.addEventListener("click", () => {
        if (!selectedDriver) return;
        closeViewDriver();
        openDriverForm(selectedDriver);
    });
    document.getElementById("driverAccountsReportButton")?.addEventListener("click", openAdminAccountsReport);
    document.getElementById("messageSelectedDriverButton")?.addEventListener("click",()=>{if(selectedDriver)location.assign(`driver-messages.html?driver=${encodeURIComponent(selectedDriver.id)}`);});
    document.getElementById("closeDriverAccountsReport")?.addEventListener("click", () => document.getElementById("driverAccountsReportBackdrop")?.classList.remove("open"));
    document.getElementById("adminAccountsRefresh")?.addEventListener("click", loadAdminAccountsReport);
    document.getElementById("adminAccountsPeriod")?.addEventListener("change", applyAdminAccountsPeriod);
    document.getElementById("adminAccountsCsv")?.addEventListener("click", exportAdminAccountsCsv);

    document.getElementById("driverNameSearch")?.addEventListener("input", renderDrivers);
    document.getElementById("driverPhoneSearch")?.addEventListener("input", renderDrivers);
    document.getElementById("driverStatusFilter")?.addEventListener("change", renderDrivers);
    document.getElementById("driverVehicleFilter")?.addEventListener("change", renderDrivers);
    document.getElementById("addVehicleButton")?.addEventListener("click",()=>openVehicleForm());
    document.getElementById("closeVehicleModalButton")?.addEventListener("click",closeVehicleForm);
    document.getElementById("cancelVehicleButton")?.addEventListener("click",closeVehicleForm);
    document.getElementById("vehicleForm")?.addEventListener("submit",saveVehicle);
    document.getElementById("vehicleSearch")?.addEventListener("input",renderVehicles);
}

async function loadDrivers() {
    const body = document.getElementById("driversTableBody");
    if (body) body.innerHTML = '<tr><td colspan="8" class="muted">Loading drivers...</td></tr>';

    const { data, error } = await driversDb.functions.invoke("driver-portal", { body: { action:"admin_list_drivers", company_id:currentCompanyId } });

    if (error) {
        console.error("Driver load error:", error);
        renderDriverError(error.message);
        return;
    }

    allDrivers = data?.drivers || [];
    buildVehicleFilter();
    updateDriverStats();
    renderDrivers();
}

function renderDrivers() {
    const body = document.getElementById("driversTableBody");
    if (!body) return;

    const nameSearch = (document.getElementById("driverNameSearch")?.value || "").trim().toLowerCase();
    const phoneSearch = (document.getElementById("driverPhoneSearch")?.value || "").trim().toLowerCase();
    const statusFilter = (document.getElementById("driverStatusFilter")?.value || "").trim().toLowerCase();
    const vehicleFilter = (document.getElementById("driverVehicleFilter")?.value || "").trim().toLowerCase();

    const filtered = allDrivers.filter(driver => {
        const name = String(driver.full_name || "").toLowerCase();
        const phone = String(driver.phone || "").toLowerCase();
        const vehicle = String(driver.vehicle || "").toLowerCase();
        const displayStatus = getDisplayStatus(driver).toLowerCase();

        if (nameSearch && !name.includes(nameSearch)) return false;
        if (phoneSearch && !phone.includes(phoneSearch)) return false;
        if (statusFilter && displayStatus !== statusFilter) return false;
        if (vehicleFilter && vehicle !== vehicleFilter) return false;

        return true;
    });

    if (!filtered.length) {
        body.innerHTML = '<tr><td colspan="8" class="muted">No drivers found.</td></tr>';
        return;
    }

    body.innerHTML = filtered.map(driver => `
        <tr>
            <td>${escapeHtml(driver.full_name || "Unnamed")}</td>
            <td>${escapeHtml(driver.driver_number || "-")}</td>
            <td>${statusHtml(driver)}</td>
            <td>${escapeHtml(driver.vehicle || "-")}</td>
            <td>${Number(driver.today_jobs || 0)}</td>
            <td>${escapeHtml(driver.phone || "-")}</td>
            <td>${escapeHtml(licenceText(driver))}</td>
            <td>
                <button type="button" data-view-driver="${escapeHtml(driver.id)}">View</button>
            </td>
        </tr>
    `).join("");

    body.querySelectorAll("[data-view-driver]").forEach(button => {
        button.addEventListener("click", () => {
            const driver = allDrivers.find(row => String(row.id) === String(button.dataset.viewDriver));
            if (driver) openViewDriver(driver);
        });
    });
}

function buildVehicleFilter() {
    const select = document.getElementById("driverVehicleFilter");
    if (!select) return;

    const current = select.value;
    const vehicles = [...new Set(
        allDrivers
            .map(driver => String(driver.vehicle || "").trim())
            .filter(Boolean)
    )].sort((a, b) => a.localeCompare(b));

    select.innerHTML = '<option value="">All Vehicles</option>' +
        vehicles.map(vehicle => `<option value="${escapeHtml(vehicle)}">${escapeHtml(vehicle)}</option>`).join("");

    if ([...select.options].some(option => option.value === current)) {
        select.value = current;
    }
}

function updateDriverStats() {
    const total = allDrivers.length;
    const online = allDrivers.filter(driver => Boolean(driver.online)).length;
    const onJob = allDrivers.filter(driver => getDisplayStatus(driver).toLowerCase() === "on job").length;
    const offline = allDrivers.filter(driver => !driver.online && getDisplayStatus(driver).toLowerCase() !== "on job").length;

    setText("statTotalDrivers", total);
    setText("statOnlineDrivers", online);
    setText("statOnJobDrivers", onJob);
    setText("statOfflineDrivers", offline);
}

function openDriverForm(driver = null) {
    const isEdit = Boolean(driver);

    setText("driverModalTitle", isEdit ? "Edit Driver" : "Add Driver");

    document.getElementById("driverId").value = driver?.id || "";
    document.getElementById("driverFullName").value = driver?.full_name || "";
    document.getElementById("driverNumberInput").value = driver?.driver_number || "";
    document.getElementById("driverPinInput").value = "";
    document.getElementById("driverPinInput").required = !isEdit;
    document.getElementById("driverPinInput").placeholder = isEdit ? "Leave blank to keep current PIN" : "4–12 digits";
    document.getElementById("driverPhoneInput").value = driver?.phone || "";
    document.getElementById("driverEmailInput").value = driver?.email || "";
    document.getElementById("driverVehicleInput").value = driver?.vehicle || "";
    document.getElementById("driverLicenceInput").value = driver?.licence_number || "";
    document.getElementById("driverLicenceExpiryInput").value = driver?.licence_expiry || "";
    document.getElementById("driverLicenceAuthorityInput").value = driver?.licence_authority || "";
    document.getElementById("driverActiveInput").value = String(driver?.active !== false);
    document.getElementById("driverStatusInput").value = driver?.status || "available";
    document.getElementById("driverOnlineInput").value = String(Boolean(driver?.online));
    document.getElementById("driverPayTypeInput").value = driver?.pay_type || "commission";
    document.getElementById("driverCommissionInput").value = driver?.commission_percent ?? "";
    document.getElementById("driverFixedPayInput").value = driver?.fixed_job_amount ?? "";
    document.getElementById("driverExpensesEnabledInput").checked = driver?.driver_expenses_enabled === true;
    document.getElementById("driverPhoneSharingInput").checked = driver?.customer_phone_sharing === true;
    document.getElementById("driverPublicPhoneInput").value = driver?.public_contact_phone || "";

    document.getElementById("driverModalBackdrop")?.classList.add("open");
}

function closeDriverForm() {
    document.getElementById("driverModalBackdrop")?.classList.remove("open");
    document.getElementById("driverForm")?.reset();
    document.getElementById("driverId").value = "";
}

async function saveDriver(event) {
    event.preventDefault();

    const id = document.getElementById("driverId").value.trim();

    const pin = document.getElementById("driverPinInput").value.trim();
    const payload = {
        full_name: document.getElementById("driverFullName").value.trim(),
        driver_number: document.getElementById("driverNumberInput").value.trim(),
        phone: document.getElementById("driverPhoneInput").value.trim() || null,
        email: document.getElementById("driverEmailInput").value.trim() || null,
        vehicle: document.getElementById("driverVehicleInput").value.trim() || null,
        licence_number: document.getElementById("driverLicenceInput").value.trim() || null,
        licence_expiry: document.getElementById("driverLicenceExpiryInput").value || null,
        licence_authority: document.getElementById("driverLicenceAuthorityInput").value.trim() || null,
        active: document.getElementById("driverActiveInput").value === "true",
        status: document.getElementById("driverStatusInput").value,
        online: document.getElementById("driverOnlineInput").value === "true",
        pay_type: document.getElementById("driverPayTypeInput").value,
        commission_percent: document.getElementById("driverCommissionInput").value === "" ? null : Number(document.getElementById("driverCommissionInput").value),
        fixed_job_amount: document.getElementById("driverFixedPayInput").value === "" ? null : Number(document.getElementById("driverFixedPayInput").value),
        driver_expenses_enabled: document.getElementById("driverExpensesEnabledInput").checked,
        customer_phone_sharing: document.getElementById("driverPhoneSharingInput").checked,
        public_contact_phone: document.getElementById("driverPublicPhoneInput").value.trim() || null
    };

    if (!payload.full_name || !payload.driver_number || (!id && !pin)) {
        alert("Full Name and Driver Number are required. New drivers also need a PIN.");
        return;
    }

    const duplicateNumber = allDrivers.find(driver =>
        String(driver.driver_number || "").trim() === payload.driver_number &&
        String(driver.id) !== String(id)
    );

    if (duplicateNumber) {
        alert("That driver number is already in use.");
        return;
    }

    const result = await driversDb.functions.invoke("driver-portal", {
        body: { action: "admin_save_driver", company_id: currentCompanyId, driver_id: id || null, pin: pin || null, driver: payload }
    });

    if (result.error) {
        console.error("Save driver error:", result.error);
        alert(`Unable to save driver.\n\n${result.error.message}`);
        return;
    }

    closeDriverForm();
    await loadDrivers();
}

function openViewDriver(driver) {
    selectedDriver = driver;

    const content = document.getElementById("driverViewContent");
    if (!content) return;

    content.innerHTML = [
        viewItem("Full Name", driver.full_name || "-"),
        viewItem("Driver Number", driver.driver_number || "-"),
        viewItem("PIN", "Stored securely — use Edit Driver to replace it"),
        viewItem("Phone", driver.phone || "-"),
        viewItem("Email", driver.email || "-"),
        viewItem("Vehicle", driver.vehicle || "-"),
        viewItem("Status", getDisplayStatus(driver)),
        viewItem("Online", driver.online ? "Yes" : "No"),
        viewItem("Licence Number", driver.licence_number || "-"),
        viewItem("Licence Expiry", driver.licence_expiry || "-"),
        viewItem("Issuing Authority", driver.licence_authority || "-"),
        viewItem("Active", driver.active === false ? "Inactive" : "Active"),
        viewItem("Pay Rule", driver.pay_type || "commission"),
        viewItem("Company Commission %", driver.commission_percent ?? "Company default"),
        viewItem("Fixed Amount / Job", driver.fixed_job_amount ?? "-"),
        viewItem("Driver Expenses", driver.driver_expenses_enabled ? "Enabled" : "Disabled"),
        viewItem("Customer phone sharing", driver.customer_phone_sharing ? `Enabled · ${driver.public_contact_phone||"approved number not set"}` : "Disabled"),
        viewItem("Company ID", driver.company_id || "-"),
        viewItem("Driver ID", driver.id || "-")
    ].join("");
    document.getElementById("driverAccountsReportButton")?.classList.toggle("hidden", !driver.driver_expenses_enabled);

    document.getElementById("viewDriverBackdrop")?.classList.add("open");
}

function closeViewDriver() {
    document.getElementById("viewDriverBackdrop")?.classList.remove("open");
}

async function openAdminAccountsReport() { if(!selectedDriver?.driver_expenses_enabled)return;const now=new Date(),from=new Date(now.getFullYear(),now.getMonth(),1),iso=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;document.getElementById("adminAccountsFrom").value=iso(from);document.getElementById("adminAccountsTo").value=iso(now);document.getElementById("driverAccountsReportBackdrop")?.classList.add("open");await loadAdminAccountsReport(); }
async function loadAdminAccountsReport(){if(!selectedDriver)return;const {data,error}=await driversDb.functions.invoke("driver-portal",{body:{action:"admin_accounts_report",company_id:currentCompanyId,driver_id:selectedDriver.id,from:document.getElementById("adminAccountsFrom").value,to:document.getElementById("adminAccountsTo").value}});if(error||!data?.ok){alert(data?.error||error?.message||"Unable to load report");return;}adminAccountsSnapshot=data;setText("adminAccountsTitle",`${selectedDriver.full_name} — Accounts`);const s=data.summary||{};document.getElementById("adminAccountsContent").innerHTML=`<div class="driver-view-grid">${viewItem("Total earnings",gbp(s.total_earnings))}${viewItem("Expenses",gbp(s.total_expenses))}${viewItem("Estimated profit",gbp(s.estimated_profit))}${viewItem("Outstanding",gbp(s.outstanding_earnings))}</div><h3 style="margin-top:18px">Expenses</h3>${(data.expenses||[]).map(x=>viewItem(`${x.expense_date} · ${x.category}`,`${gbp(x.amount)} — ${x.description}`)).join("")||'<p class="muted">No expenses.</p>'}<h3 style="margin-top:18px">Completed jobs</h3>${(data.jobs||[]).map(x=>viewItem(`${x.journey_date} · ${x.booking_reference}`,x.driver_earnings==null?'Not authorised':gbp(x.driver_earnings))).join("")||'<p class="muted">No completed jobs.</p>'}`;}
function exportAdminAccountsCsv(){if(!adminAccountsSnapshot)return;const q=v=>`"${String(v??"").replaceAll('"','""')}"`,rows=[["Type","Date","Reference/Category","Description","Amount GBP","Status"]];(adminAccountsSnapshot.jobs||[]).forEach(x=>rows.push(["Income",x.journey_date,x.booking_reference,"Driver earnings",x.driver_earnings??"",x.payment_status]));(adminAccountsSnapshot.expenses||[]).forEach(x=>rows.push(["Expense",x.expense_date,x.category,x.description,x.amount,x.accounting_treatment]));const blob=new Blob([rows.map(r=>r.map(q).join(",")).join("\r\n")],{type:"text/csv"}),url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download=`driver-accounts-${adminAccountsSnapshot.from}-${adminAccountsSnapshot.to}.csv`;a.click();URL.revokeObjectURL(url);}
function applyAdminAccountsPeriod(){const period=document.getElementById("adminAccountsPeriod").value,now=new Date(),year=now.getFullYear();let from,to;if(period==="personal_tax_year"){const y=now>=new Date(year,3,6)?year:year-1;from=new Date(y,3,6);to=new Date(y+1,3,5);}else if(period==="business_year"){const y=now>=new Date(year,3,1)?year:year-1;from=new Date(y,3,1);to=new Date(y+1,2,31);}else if(period==="month"){from=new Date(year,now.getMonth(),1);to=new Date(year,now.getMonth()+1,0);}else return;const iso=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;document.getElementById("adminAccountsFrom").value=iso(from);document.getElementById("adminAccountsTo").value=iso(to);loadAdminAccountsReport();}
function gbp(value){return `£${Number(value||0).toFixed(2)}`;}

async function loadVehicles(){const {data,error}=await driversDb.from("vehicles").select("id,company_id,registration,make,model,model_year,colour,passenger_seats,vehicle_type,taxi_plate_number,taxi_plate_expiry,mot_expiry,insurance_policy_reference,insurance_expiry,licensing_authority,active").eq("company_id",currentCompanyId).order("registration");if(error){document.getElementById("vehiclesTableBody").innerHTML=`<tr><td colspan="8">${escapeHtml(error.message)}</td></tr>`;return;}allVehicles=data||[];renderVehicles();}
function complianceLabel(date){if(!date)return "Not recorded";const days=Math.ceil((new Date(`${date}T00:00:00`)-new Date())/86400000);return days<0?`Expired ${date}`:days<=30?`Due soon ${date}`:date;}
function renderVehicles(){const q=(document.getElementById("vehicleSearch")?.value||"").trim().toLowerCase(),rows=allVehicles.filter(v=>!q||[v.registration,v.make,v.model].some(x=>String(x||"").toLowerCase().includes(q))),body=document.getElementById("vehiclesTableBody");body.innerHTML=rows.map(v=>`<tr><td><strong>${escapeHtml(v.registration)}</strong></td><td>${escapeHtml([v.colour,v.make,v.model].filter(Boolean).join(" ")||"-")}</td><td>${escapeHtml(v.passenger_seats)}</td><td>${escapeHtml(v.taxi_plate_number||"-")}<br><small>${escapeHtml(complianceLabel(v.taxi_plate_expiry))}</small></td><td>${escapeHtml(complianceLabel(v.mot_expiry))}</td><td>${escapeHtml(complianceLabel(v.insurance_expiry))}</td><td>${v.active?"Active":"Inactive"}</td><td><button type="button" data-edit-vehicle="${escapeHtml(v.id)}">Edit</button></td></tr>`).join("")||'<tr><td colspan="8">No vehicles found.</td></tr>';body.querySelectorAll("[data-edit-vehicle]").forEach(button=>button.onclick=()=>openVehicleForm(allVehicles.find(v=>String(v.id)===button.dataset.editVehicle)));}
function openVehicleForm(v=null){const set=(id,value)=>{document.getElementById(id).value=value??"";};set("vehicleId",v?.id);set("vehicleRegistration",v?.registration);set("vehicleActive",String(v?.active!==false));set("vehicleMake",v?.make);set("vehicleModel",v?.model);set("vehicleYear",v?.model_year);set("vehicleColour",v?.colour);set("vehicleSeats",v?.passenger_seats??4);set("vehicleType",v?.vehicle_type);set("vehiclePlate",v?.taxi_plate_number);set("vehiclePlateExpiry",v?.taxi_plate_expiry);set("vehicleMotExpiry",v?.mot_expiry);set("vehicleInsuranceExpiry",v?.insurance_expiry);set("vehicleInsuranceReference",v?.insurance_policy_reference);set("vehicleLicensingAuthority",v?.licensing_authority);setText("vehicleModalTitle",v?"Edit Vehicle":"Add Vehicle");document.getElementById("vehicleModalBackdrop").classList.add("open");}
function closeVehicleForm(){document.getElementById("vehicleModalBackdrop")?.classList.remove("open");document.getElementById("vehicleForm")?.reset();}
async function saveVehicle(event){event.preventDefault();const val=id=>document.getElementById(id).value.trim(),id=val("vehicleId"),payload={company_id:currentCompanyId,registration:val("vehicleRegistration").toUpperCase(),active:val("vehicleActive")==="true",make:val("vehicleMake")||null,model:val("vehicleModel")||null,model_year:val("vehicleYear")?Number(val("vehicleYear")):null,colour:val("vehicleColour")||null,passenger_seats:Number(val("vehicleSeats")),vehicle_type:val("vehicleType")||null,taxi_plate_number:val("vehiclePlate")||null,taxi_plate_expiry:val("vehiclePlateExpiry")||null,mot_expiry:val("vehicleMotExpiry")||null,insurance_expiry:val("vehicleInsuranceExpiry")||null,insurance_policy_reference:val("vehicleInsuranceReference")||null,licensing_authority:val("vehicleLicensingAuthority")||null,updated_at:new Date().toISOString()};const query=id?driversDb.from("vehicles").update(payload).eq("company_id",currentCompanyId).eq("id",id):driversDb.from("vehicles").insert(payload);const {error}=await query;if(error)return alert(error.message);closeVehicleForm();await loadVehicles();}

function getDisplayStatus(driver) {
    const status = String(driver.status || "").trim().toLowerCase();

    if (status === "on job" || status === "on_job" || status === "busy") return "On Job";
    if (Boolean(driver.online)) return "Online";
    return "Offline";
}

function statusHtml(driver) {
    const status = getDisplayStatus(driver);

    if (status === "Online") {
        return '<span><span class="status-dot status-online"></span>Online</span>';
    }

    if (status === "On Job") {
        return '<span><span class="status-dot status-onjob"></span>On Job</span>';
    }

    return '<span><span class="status-dot status-offline"></span>Offline</span>';
}

function licenceText(driver) {
    if (!driver.licence_expiry) return driver.licence_number ? "Valid" : "-";

    const expiry = new Date(`${driver.licence_expiry}T00:00:00`);
    const now = new Date();
    now.setHours(0, 0, 0, 0);

    const diffDays = Math.ceil((expiry - now) / 86400000);

    if (diffDays < 0) return "Expired";
    if (diffDays <= 30) return "Expires Soon";
    return "Valid";
}

function viewItem(label, value) {
    return `
        <div class="driver-view-item">
            <small>${escapeHtml(label)}</small>
            <strong>${escapeHtml(value)}</strong>
        </div>
    `;
}

function renderDriverError(message) {
    const body = document.getElementById("driversTableBody");
    if (body) {
        body.innerHTML = `<tr><td colspan="8" style="color:#b91c1c;">${escapeHtml(message)}</td></tr>`;
    }
}

function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
}

function escapeHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}
