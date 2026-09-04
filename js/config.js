(function initialisePublicCompanyConfig() {
    const existingConfig = window.PUBLIC_COMPANY_CONFIG || {};

    window.PUBLIC_COMPANY_CONFIG = {
        defaultCompanyCode: "0001",
        ...existingConfig
    };

    window.APP_CONFIG = window.APP_CONFIG || {
        companyCode: null,
        companyId: null,
        company: null,
        resolutionSource: null
    };

    let companyPromise = null;
    let publicDataPromise = null;

    function cleanCompanyCode(value) {
        const code = String(value || "").trim();
        return /^[a-z0-9_-]+$/i.test(code) ? code : "";
    }

    function codeFromPath() {
        const parts = window.location.pathname
            .split("/")
            .filter(Boolean)
            .map(part => decodeURIComponent(part));

        for (let index = 0; index < parts.length - 1; index += 1) {
            if (["company", "c"].includes(parts[index].toLowerCase())) {
                return cleanCompanyCode(parts[index + 1]);
            }
        }

        return "";
    }

    function codeFromHostname() {
        const hostname = window.location.hostname.toLowerCase();

        if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") ||
            hostname.endsWith(".github.io") || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) {
            return "";
        }

        const labels = hostname.split(".");
        if (labels.length < 3 || labels[0] === "www") return "";
        return cleanCompanyCode(labels[0]);
    }

    function resolvePublicCompanyCode() {
        const params = new URLSearchParams(window.location.search);
        const candidates = [
            [window.PUBLIC_COMPANY_CONFIG.companyCode, "runtime config"],
            [document.querySelector('meta[name="public-company-code"]')?.content, "page config"],
            [params.get("company") || params.get("company_code"), "URL query"],
            [codeFromPath(), "URL slug"],
            [codeFromHostname(), "hostname"],
            [window.PUBLIC_COMPANY_CONFIG.defaultCompanyCode, "default fallback"]
        ];

        for (const [candidate, source] of candidates) {
            const companyCode = cleanCompanyCode(candidate);
            if (companyCode) return { companyCode, source };
        }

        return { companyCode: "", source: "unresolved" };
    }

    async function loadCompanyConfig() {
        if (companyPromise) return companyPromise;

        companyPromise = (async () => {
            const resolution = resolvePublicCompanyCode();
            if (!resolution.companyCode) {
                console.error("No public company code could be resolved.");
                return null;
            }

            const db = getSupabase();
            const { data, error } = await db
                .from("companies")
                .select("id, company_code, name, trading_name")
                .eq("company_code", resolution.companyCode)
                .maybeSingle();

            if (error || !data) {
                console.error("Could not load public company:", error || "Company not found");
                return null;
            }

            Object.assign(window.APP_CONFIG, {
                companyCode: data.company_code,
                companyId: data.id,
                company: data,
                resolutionSource: resolution.source
            });
            return data;
        })();

        return companyPromise;
    }

    async function loadPublicCompanyData() {
        if (publicDataPromise) return publicDataPromise;

        publicDataPromise = (async () => {
            const company = await loadCompanyConfig();
            if (!company) return null;

            const db = getSupabase();
            const [settingsResult, airportsResult, areasResult] = await Promise.all([
                loadPublicSettings(db, company.id),
                db.from("airports").select("id,company_id,name,code,active,price_1_4_oneway,price_1_4_return,price_5_7_oneway,price_5_7_return,deposit_percent,sort_order").eq("company_id", company.id).eq("active", true).order("sort_order", { ascending: true }).order("name", { ascending: true }),
                db.from("service_areas").select("id,company_id,area_name,postcode_prefix,radius_miles,active,sort_order").eq("company_id", company.id).eq("active", true).order("sort_order", { ascending: true }).order("area_name", { ascending: true })
            ]);

            if (settingsResult.error) console.error("Public settings load error:", settingsResult.error);
            if (airportsResult.error) console.error("Public airports load error:", airportsResult.error);
            if (areasResult.error) console.error("Public service areas load error:", areasResult.error);

            const result = {
                company,
                settings: settingsResult.data || {},
                airports: airportsResult.data || [],
                serviceAreas: areasResult.data || []
            };

            window.PUBLIC_COMPANY_DATA = result;
            return result;
        })();

        return publicDataPromise;
    }

    window.resolvePublicCompanyCode = resolvePublicCompanyCode;
    window.loadCompanyConfig = loadCompanyConfig;
    window.loadPublicCompanyData = loadPublicCompanyData;

    async function loadPublicSettings(db, companyId) {
        const baseColumns = "company_id,companyname,tradingname,companyphone,companyemail,companyaddress,companylogo,currencysymbol,allowairportoutsidearea,primarycolour,secondarycolour,accentcolour,buttoncolour,buttontextcolour,businessstatus,holidayfrom,holidayto,websitenotice,acceptadvancebookings,bookwhileclosed,closedmessage,timezone";
        const closureColumns = `${baseColumns},holidayfromtime,holidaytotime`;
        const result = await db.from("settings")
            .select(`${closureColumns},googleanalyticsid,googleadsid,googleadsconversionlabel`)
            .eq("company_id", companyId)
            .maybeSingle();

        if (!result.error || result.error.code !== "42703") return result;

        const closureResult = await db.from("settings")
            .select(closureColumns)
            .eq("company_id", companyId)
            .maybeSingle();

        if (!closureResult.error || closureResult.error.code !== "42703") return closureResult;

        console.warn("Closure time columns are not installed yet; using date-only public settings.");
        return db.from("settings")
            .select(baseColumns)
            .eq("company_id", companyId)
            .maybeSingle();
    }
})();
