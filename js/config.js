window.APP_CONFIG = {
        companyCode: "0001",
        companyId: null
    };
    
    async function loadCompanyConfig() {
        const db = getSupabase();
    
        const { data, error } = await db
            .from("companies")
            .select("id, company_code, name, trading_name")
            .eq("company_code", window.APP_CONFIG.companyCode)
            .single();
    
        if (error) {
            console.error("Could not load company:", error);
            return null;
        }
    
        window.APP_CONFIG.companyId = data.id;
        window.APP_CONFIG.company = data;
    
        console.log(
            "Company loaded:",
            data.company_code,
            data.trading_name
        );
    
        return data;
    }