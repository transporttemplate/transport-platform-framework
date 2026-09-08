(function initialisePublicCompanyConfig() {
    const existingConfig = window.PUBLIC_COMPANY_CONFIG || {};

    const defaultHostnameCompanyCodes = {
        "transport-platform-framework.vercel.app": "0001",
        "etbm.co.uk": "0002",
        "www.etbm.co.uk": "0002",
        "jeffscars.com": "0003",
        "www.jeffscars.com": "0003"
    };

    window.PUBLIC_COMPANY_CONFIG = {
        defaultCompanyCode: "0001",
        ...existingConfig,
        hostnameCompanyCodes: {
            ...defaultHostnameCompanyCodes,
            ...(existingConfig.hostnameCompanyCodes || {})
        }
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

    function normalHostname(value) {
        return String(value || "").trim().toLowerCase().replace(/\.$/, "");
    }

    function codeFromHostname() {
        const hostname = normalHostname(window.location.hostname);
        const configured = window.PUBLIC_COMPANY_CONFIG.hostnameCompanyCodes || {};
        const mappedCode = cleanCompanyCode(configured[hostname]);
        if (mappedCode) return mappedCode;
        if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") ||
            hostname.endsWith(".github.io") || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) {
            return cleanCompanyCode(window.PUBLIC_COMPANY_CONFIG.defaultCompanyCode);
        }
        return "";
    }

    function isTestingHostname() {
        const hostname = normalHostname(window.location.hostname);
        return !hostname || hostname === "localhost" || hostname.endsWith(".localhost") ||
            hostname.endsWith(".vercel.app") || hostname.endsWith(".github.io") ||
            /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
    }

    function resolvePublicCompanyCode(options = {}) {
        const params = new URLSearchParams(window.location.search);
        const allowQuery = options.allowQuery ?? isTestingHostname();
        const companyCode = cleanCompanyCode(allowQuery ? params.get("company") || params.get("company_code") : "");
        return companyCode ? { companyCode, source: "URL query" } : { companyCode: "", source: "unresolved" };
    }

    function embeddedCompanyCode() {
        const candidates = [
            [codeFromPath(), "URL slug"],
            [window.PUBLIC_COMPANY_CONFIG.companyCode, "runtime config"],
            [document.querySelector('meta[name="public-company-code"]')?.content, "page config"]
        ];

        for (const [candidate, source] of candidates) {
            const companyCode = cleanCompanyCode(candidate);
            if (companyCode) return { companyCode, source };
        }

        return { companyCode: "", source: "unresolved" };
    }

    async function codeFromDomainMapping(db) {
        const hostname = normalHostname(window.location.hostname);
        if (!hostname) return "";
        const { data, error } = await db.from("company_domains")
            .select("company_id,companies!inner(company_code)")
            .eq("hostname", hostname)
            .eq("active", true)
            .maybeSingle();
        if (error) {
            console.warn("Company domain mapping is unavailable for this hostname.", { code: error.code || "unknown" });
            return "";
        }
        return cleanCompanyCode(data?.companies?.company_code);
    }

    async function loadCompanyConfig() {
        if (companyPromise) return companyPromise;

        companyPromise = (async () => {
            let resolution = resolvePublicCompanyCode();
            const db = getSupabase();
            if (!resolution.companyCode) {
                const mappedCode = await codeFromDomainMapping(db);
                if (mappedCode) resolution = { companyCode: mappedCode, source: "domain mapping" };
            }
            if (!resolution.companyCode) {
                const hostnameCode = codeFromHostname();
                if (hostnameCode) resolution = { companyCode: hostnameCode, source: "hostname fallback" };
            }
            if (!resolution.companyCode) resolution = embeddedCompanyCode();
            if (!resolution.companyCode) {
                console.error("No public company code could be resolved.");
                return null;
            }

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
            const [settingsResult, airportsResult, areasResult, fleetResult] = await Promise.all([
                loadPublicSettings(db, company.id),
                db.from("airports").select("id,company_id,name,code,active,price_1_4_oneway,price_1_4_return,price_5_7_oneway,price_5_7_return,deposit_percent,sort_order").eq("company_id", company.id).eq("active", true).order("sort_order", { ascending: true }).order("name", { ascending: true }),
                db.from("service_areas").select("id,company_id,area_name,postcode_prefix,radius_miles,active,sort_order").eq("company_id", company.id).eq("active", true).order("sort_order", { ascending: true }).order("area_name", { ascending: true }),
                db.from("fleet_items").select("id,company_id,active,title,description,image_url,image_position,sort_order,passenger_capacity,luggage_capacity").eq("company_id", company.id).eq("active", true).order("sort_order", { ascending: true }).order("title", { ascending: true })
            ]);

            if (settingsResult.error) console.error("Public settings load error:", settingsResult.error);
            if (airportsResult.error) console.error("Public airports load error:", airportsResult.error);
            if (areasResult.error) console.error("Public service areas load error:", areasResult.error);
            if (fleetResult.error) console.info("Public fleet items are not available yet; using the legacy fleet image.");

            const result = {
                company,
                settings: settingsResult.data || {},
                airports: airportsResult.data || [],
                serviceAreas: areasResult.data || [],
                fleetItems: fleetResult.data || []
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
        const publicThemeColumns = "publicbackgroundcolour,publiccardcolour,publicheadercolour,publictextcolour,publicmutedcolour,publicfootercolour";
        const hoursColumns = "monopen,monclose,monenabled,mon24hours,tueopen,tueclose,tueenabled,tue24hours,wedopen,wedclose,wedenabled,wed24hours,thuopen,thuclose,thuenabled,thu24hours,friopen,friclose,frienabled,fri24hours,satopen,satclose,satenabled,sat24hours,sunopen,sunclose,sunenabled,sun24hours";
        const homeColumns = "homeheroheading,homeherodescription,homeherobuttontext,homesellingpoint1enabled,homesellingpoint1text,homesellingpoint2enabled,homesellingpoint2text,homesellingpoint3enabled,homesellingpoint3text,homesellingpoint4enabled,homesellingpoint4text";
        const mediaColumns = `${baseColumns},homeheroimage,bookingheroimage,contactheroimage,fleetimage,${homeColumns},${publicThemeColumns},${hoursColumns}`;
        const closureColumns = `${mediaColumns},holidayfromtime,holidaytotime`;
        const result = await db.from("settings")
            .select(closureColumns)
            .eq("company_id", companyId)
            .maybeSingle();

        if (!result.error) return result;

        const closureResult = await db.from("settings")
            .select(`${baseColumns},holidayfromtime,holidaytotime`)
            .eq("company_id", companyId)
            .maybeSingle();

        if (!closureResult.error) return closureResult;

        console.warn("Closure time columns are not installed yet; using date-only public settings.");
        return db.from("settings")
            .select(baseColumns)
            .eq("company_id", companyId)
            .maybeSingle();
    }
})();
