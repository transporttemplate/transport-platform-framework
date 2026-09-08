const customerAuthDb = getSupabase();
let customerAuthMode = "login";
let customerCompany = null;

document.addEventListener("DOMContentLoaded", async () => {
    const publicData = await loadPublicCompanyData();
    customerCompany = publicData?.company || null;
    if (!customerCompany) {
        showMessage("This transport company could not be resolved. Check the website address and try again.", "error");
        disableAuthForm();
        return;
    }

    applyPortalBranding(publicData);
    document.querySelectorAll("[data-auth-view]").forEach(button => {
        button.addEventListener("click", () => setMode(button.dataset.authView));
    });
    document.getElementById("customerAuthForm").addEventListener("submit", submitCustomerAuth);
    document.getElementById("forgotCustomerPassword").addEventListener("click", forgotPassword);
    document.getElementById("toggleCustomerPassword").addEventListener("click", togglePassword);

    customerAuthDb.auth.onAuthStateChange(event => {
        if (event === "PASSWORD_RECOVERY") setMode("reset");
    });

    const recovery = new URLSearchParams(location.search).get("type") === "recovery" || location.hash.includes("type=recovery");
    if (recovery) setMode("reset");
    const { data: { session } } = await customerAuthDb.auth.getSession();
    if (session && !recovery) await finishAuth();
});

function setMode(mode) {
    customerAuthMode = mode;
    document.querySelectorAll("[data-auth-view]").forEach(button => {
        const active = button.dataset.authView === mode;
        button.classList.toggle("active", active);
        button.setAttribute("aria-selected", String(active));
    });
    const submit = document.getElementById("customerAuthSubmit");
    submit.textContent = mode === "signup" ? "Create Account" : mode === "reset" ? "Set New Password" : "Sign In";
    document.getElementById("customerPassword").autocomplete = mode === "login" ? "current-password" : "new-password";
    document.getElementById("forgotCustomerPassword").hidden = mode === "reset";
    clearMessage();
}

async function submitCustomerAuth(event) {
    event.preventDefault();
    const email = document.getElementById("customerEmail").value.trim();
    const password = document.getElementById("customerPassword").value;
    setBusy(true);
    try {
        if (customerAuthMode === "reset") {
            const { error } = await customerAuthDb.auth.updateUser({ password });
            if (error) throw error;
            showMessage("Your password has been updated. Opening My Bookings…", "success");
            return finishAuth();
        }

        const result = customerAuthMode === "signup"
            ? await customerAuthDb.auth.signUp({ email, password, options: { emailRedirectTo: authRedirectUrl(true) } })
            : await customerAuthDb.auth.signInWithPassword({ email, password });
        if (result.error) throw result.error;
        if (customerAuthMode === "signup" && !result.data.session) {
            showMessage("Check your email to verify your account. The confirmation link will return you to this company website.", "success");
            return;
        }
        await finishAuth();
    } catch (error) {
        showMessage(await friendlyPortalError(error, "Unable to sign in. Check your details and try again."), "error");
    } finally {
        setBusy(false);
    }
}

async function finishAuth() {
    const token = new URLSearchParams(location.search).get("claim");
    if (token) {
        try {
            await portalRequest("claim", { claim_token: token });
        } catch (error) {
            showMessage(await friendlyPortalError(error, "This booking has not yet been linked to your account."), "error");
            return;
        }
    } else {
        try {
            await portalRequest("profile");
        } catch (error) {
            showMessage(await friendlyPortalError(error, "Your account is not linked to this transport company."), "error");
            return;
        }
    }
    location.assign(companyPageUrl("customer-account.html"));
}

async function forgotPassword() {
    const email = document.getElementById("customerEmail").value.trim();
    if (!email) return showMessage("Enter your email address first.", "error");
    setBusy(true);
    const { error } = await customerAuthDb.auth.resetPasswordForEmail(email, { redirectTo: authRedirectUrl(false, "recovery") });
    setBusy(false);
    showMessage(error ? error.message : "Password reset email sent. Its link will return you to this company website.", error ? "error" : "success");
}

async function portalRequest(action, extra = {}) {
    const { data, error } = await customerAuthDb.functions.invoke("customer-portal", {
        body: { action, company_code: customerCompany.company_code, ...extra }
    });
    if (error || !data?.ok) {
        const failure = error || new Error(data?.error || "Customer portal request failed");
        failure.portalMessage = data?.error;
        throw failure;
    }
    return data;
}

function authRedirectUrl(preserveClaim, type = "confirmation") {
    const url = new URL("/customer-login.html", location.origin);
    url.searchParams.set("company", customerCompany.company_code);
    const claim = preserveClaim ? new URLSearchParams(location.search).get("claim") : "";
    if (claim) url.searchParams.set("claim", claim);
    if (type === "recovery") url.searchParams.set("type", "recovery");
    return url.href;
}

function companyPageUrl(page) {
    const url = new URL(page, location.origin + "/");
    url.searchParams.set("company", customerCompany.company_code);
    return url.href;
}

function applyPortalBranding({ company, settings = {} }) {
    const name = settings.tradingname || company.trading_name || settings.companyname || company.name;
    document.getElementById("portalCompanyName").textContent = name;
    document.getElementById("portalBackCompanyName").textContent = name;
    document.getElementById("customerBackHome").href = companyPageUrl("index.html");
    document.title = `Manage Your Bookings | ${name}`;
    applyPortalColours(settings);
    setPortalLogo(settings.companylogo, name);
}

function applyPortalColours(settings) {
    const root = document.documentElement.style;
    const accent = settings.primarycolour || settings.accentcolour || settings.buttoncolour;
    if (accent) root.setProperty("--portal-accent", accent);
    if (settings.buttontextcolour) root.setProperty("--portal-accent-contrast", settings.buttontextcolour);
    if (settings.publicbackgroundcolour) root.setProperty("--portal-bg", settings.publicbackgroundcolour);
}

function setPortalLogo(value, name) {
    const logo = document.getElementById("portalCompanyLogo");
    const fallback = document.getElementById("portalCompanyLogoFallback");
    fallback.textContent = String(name || "Company").split(/\s+/).slice(0, 2).map(word => word[0]).join("").toUpperCase();
    if (!value) return;
    try {
        const url = new URL(value, location.href);
        if (!/^https?:$/.test(url.protocol)) return;
        logo.alt = `${name} logo`;
        logo.onload = () => { logo.hidden = false; fallback.hidden = true; };
        logo.src = url.href;
    } catch {}
}

async function friendlyPortalError(error, fallback) {
    let text = error?.portalMessage || "";
    if (!text && error?.context?.json) {
        try { text = (await error.context.json())?.error || ""; } catch {}
    }
    text ||= error?.message || fallback;
    if (/No customer account is linked/i.test(text)) return `This account is not linked to ${customerCompany?.trading_name || customerCompany?.name || "this transport company"}. Use the secure link from your booking confirmation, or sign in on the company where your account was created.`;
    if (/invalid or expired/i.test(text)) return "This booking link is invalid or has expired. Please sign in using the email address used for this booking or contact the company.";
    if (/does not match|verified account/i.test(text)) return "Please sign in using the verified email address used for this booking.";
    if (/Customer login required|JWT|authorization/i.test(text)) return "Your sign-in session has expired. Please sign in again.";
    if (/Verify your email/i.test(text)) return "Verify your email before linking this booking.";
    return text || fallback;
}

function togglePassword() {
    const input = document.getElementById("customerPassword");
    const showing = input.type === "text";
    input.type = showing ? "password" : "text";
    this.textContent = showing ? "Show" : "Hide";
    this.setAttribute("aria-label", showing ? "Show password" : "Hide password");
}

function showMessage(text, kind = "info") {
    const target = document.getElementById("customerAuthMessage");
    target.textContent = text;
    target.dataset.kind = kind;
    target.hidden = !text;
}
function clearMessage() { showMessage(""); }
function setBusy(busy) { document.getElementById("customerAuthSubmit").disabled = busy; }
function disableAuthForm() { document.querySelectorAll("#customerAuthForm input,#customerAuthForm button").forEach(element => { element.disabled = true; }); }
