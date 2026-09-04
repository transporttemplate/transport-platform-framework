(function initialisePublicClosure() {
    const PUBLIC_PAGES = new Set(["", "index.html", "airports.html", "booking.html", "contact.html"]);
    let countdownTimer = null;

    document.addEventListener("DOMContentLoaded", checkPublicClosure);

    async function checkPublicClosure() {
        if (typeof window.loadPublicCompanyData !== "function") return;

        const data = await window.loadPublicCompanyData();
        if (!data) return;

        const closure = buildClosureState(data.settings || {});
        window.PUBLIC_CLOSURE_STATE = closure;
        window.validatePublicJourneyAgainstClosure = validateJourney;
        window.dispatchEvent(new CustomEvent("publicClosureReady", { detail: closure }));

        const page = window.location.pathname.split("/").pop() || "";
        const isClosedPage = page === "closed.html";

        if (isClosedPage) {
            if (!closure.active) {
                window.location.replace(publicUrl("index.html", data.company.company_code));
                return;
            }
            renderClosedPage(data, closure);
            return;
        }

        if (!PUBLIC_PAGES.has(page) || !closure.active) return;

        const advanceEntry = page === "booking.html" &&
            new URLSearchParams(window.location.search).get("after_closure") === "1";

        if (advanceEntry && closure.acceptAdvance && closure.endsAt) {
            constrainBookingDates(closure);
            return;
        }

        window.location.replace(publicUrl("closed.html", data.company.company_code));
    }

    function buildClosureState(settings, currentTime = new Date()) {
        const status = normaliseStatus(settings.businessstatus);
        const startsAt = combineDateTime(settings.holidayfrom, settings.holidayfromtime, false);
        const endsAt = combineDateTime(settings.holidayto, settings.holidaytotime, true);
        const now = currentTime instanceof Date ? currentTime : new Date(currentTime);
        const configuredClosed = ["closed", "holiday", "emergency"].includes(status);
        const active = configuredClosed && (!startsAt || now >= startsAt) && (!endsAt || now < endsAt);

        return {
            status,
            active,
            startsAt,
            endsAt,
            acceptAdvance: Boolean(settings.acceptadvancebookings || settings.bookwhileclosed),
            message: String(settings.closedmessage || "").trim(),
            notice: String(settings.websitenotice || "").trim(),
            theme: chooseTheme(status, `${settings.closedmessage || ""} ${settings.websitenotice || ""}`)
        };
    }

    function combineDateTime(dateValue, timeValue, endOfDay) {
        if (!dateValue) return null;
        const time = timeValue || (endOfDay ? "23:59:59" : "00:00:00");
        const result = new Date(`${dateValue}T${time}`);
        return Number.isNaN(result.getTime()) ? null : result;
    }

    function chooseTheme(status, copy) {
        const text = copy.toLowerCase();
        if (status === "emergency") return "emergency";
        if (/christmas|xmas|festive|santa/.test(text)) return "christmas";
        if (/new\s*year|nye/.test(text)) return "new-year";
        if (status === "holiday" || /holiday|vacation|summer|sun|beach|sea/.test(text)) return "holiday";
        return "generic";
    }

    function renderClosedPage({ company, settings }, closure) {
        const name = settings.tradingname || company.trading_name || settings.companyname || company.name || "Transport Company";
        document.body.dataset.closureTheme = closure.theme;
        setText("closedCompanyName", name);
        setText("closedTitle", themeTitle(closure.theme, closure.status));
        setText("closedMessage", closure.message || defaultMessage(closure.status));

        const notice = document.getElementById("closedNotice");
        if (notice) {
            notice.textContent = closure.notice;
            notice.hidden = !closure.notice;
        }

        const reopen = document.getElementById("reopeningAt");
        if (reopen) reopen.textContent = closure.endsAt
            ? new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "short" }).format(closure.endsAt)
            : "Please check back for an update";

        const book = document.getElementById("advanceBookingLink");
        if (book && closure.acceptAdvance && closure.endsAt) {
            book.hidden = false;
            book.href = publicUrl("booking.html", company.company_code, { after_closure: "1" });
        }

        renderCountdown(closure.endsAt, company.company_code);
    }

    function renderCountdown(endsAt, companyCode) {
        const box = document.getElementById("closureCountdown");
        if (!box) return;
        if (!endsAt) {
            box.textContent = "Reopening time to be confirmed";
            return;
        }

        const update = () => {
            const remaining = endsAt.getTime() - Date.now();
            if (remaining <= 0) {
                clearInterval(countdownTimer);
                window.location.replace(publicUrl("index.html", companyCode));
                return;
            }
            const days = Math.floor(remaining / 86400000);
            const hours = Math.floor((remaining % 86400000) / 3600000);
            const minutes = Math.floor((remaining % 3600000) / 60000);
            const seconds = Math.floor((remaining % 60000) / 1000);
            box.textContent = `${days}d ${hours}h ${minutes}m ${seconds}s`;
        };
        update();
        countdownTimer = setInterval(update, 1000);
    }

    function validateJourney(dateValue, timeValue, closureOverride) {
        const closure = closureOverride || window.PUBLIC_CLOSURE_STATE;
        if (!closure?.active) return true;
        if (!closure.acceptAdvance || !closure.endsAt) {
            alert("Online booking is currently closed.");
            return false;
        }
        const journey = new Date(`${dateValue}T${timeValue || "00:00"}`);
        if (Number.isNaN(journey.getTime()) || journey <= closure.endsAt) {
            alert(`Please choose a journey after ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(closure.endsAt)}.`);
            return false;
        }
        return true;
    }

    function constrainBookingDates(closure) {
        const minimumDate = localDate(closure.endsAt);
        for (const id of ["journeyDate", "returnDate"]) {
            const input = document.getElementById(id);
            if (input && (!input.min || input.min < minimumDate)) input.min = minimumDate;
        }
        const notice = document.getElementById("closureBookingNotice");
        if (notice) {
            notice.hidden = false;
            notice.textContent = `Bookings are available for journeys after ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(closure.endsAt)}.`;
        }
    }

    function publicUrl(path, companyCode, extra = {}) {
        const url = new URL(path, window.location.href);
        if (companyCode) url.searchParams.set("company", companyCode);
        Object.entries(extra).forEach(([key, value]) => url.searchParams.set(key, value));
        return `${url.pathname.split("/").pop()}${url.search}`;
    }

    function normaliseStatus(value) {
        const status = String(value || "open").trim().toLowerCase().replaceAll("_", " ");
        if (status.includes("emergency")) return "emergency";
        if (status.includes("holiday")) return "holiday";
        if (status.includes("closed")) return "closed";
        return "open";
    }

    function themeTitle(theme, status) {
        if (theme === "christmas") return "Merry Christmas";
        if (theme === "new-year") return "Happy New Year";
        if (theme === "holiday") return "We’re Taking a Break";
        if (theme === "emergency" || status === "emergency") return "Emergency Closure";
        return "We’re Currently Closed";
    }

    function defaultMessage(status) {
        return status === "emergency"
            ? "We are temporarily closed due to an emergency."
            : "Online booking is temporarily unavailable while we are closed.";
    }

    function localDate(date) {
        const offset = date.getTimezoneOffset() * 60000;
        return new Date(date.getTime() - offset).toISOString().slice(0, 10);
    }

    function setText(id, value) {
        const element = document.getElementById(id);
        if (element) element.textContent = value;
    }

    window.PublicClosure = Object.freeze({ buildClosureState, validateJourney, chooseTheme, normaliseStatus });
})();
