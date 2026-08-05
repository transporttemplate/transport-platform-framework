/*
=========================================
TRANSPORT PLATFORM
MAIN.JS
=========================================
*/

document.addEventListener("DOMContentLoaded", () => {

        loadCompanyInformation();
    
    });
    
    /*
    =========================================
    LOAD COMPANY INFORMATION
    =========================================
    */
    
    function loadCompanyInformation() {
    
        if (!window.SETTINGS) return;
    
        setText("companyName", SETTINGS.company.name);
        setText("companyTradingName", SETTINGS.company.tradingName);
    
        setText("companyPhone", SETTINGS.contact.phone);
        setText("companyEmail", SETTINGS.contact.email);
        setText("companyAddress", SETTINGS.company.address);
    
        setLogo();
    
        applyBrandColours();
    
    }
    
    /*
    =========================================
    CHANGE TEXT
    =========================================
    */
    
    function setText(id, value) {
    
        const element = document.getElementById(id);
    
        if (element) {
    
            element.textContent = value;
    
        }
    
    }
    
    /*
    =========================================
    CHANGE LOGO
    =========================================
    */
    
    function setLogo() {
    
        const logo = document.getElementById("companyLogo");
    
        if (logo) {
    
            logo.src = SETTINGS.branding.logo;
    
            logo.alt = SETTINGS.company.name;
    
        }
    
    }
    
    /*
    =========================================
    APPLY BRAND COLOURS
    =========================================
    */
    
    function applyBrandColours() {
    
        document.documentElement.style.setProperty(
            "--primary",
            SETTINGS.branding.primaryColour
        );
    
        document.documentElement.style.setProperty(
            "--secondary",
            SETTINGS.branding.secondaryColour
        );
    
        document.documentElement.style.setProperty(
            "--accent",
            SETTINGS.branding.accentColour
        );
    
    }
    
    /*
    =========================================
    GET AIRPORT BY ID
    =========================================
    */
    
    function getAirport(id) {
    
        return SETTINGS.airports.find(
            airport => airport.id === id
        );
    
    }
    
    /*
    =========================================
    FORMAT MONEY
    =========================================
    */
    
    function money(value) {
    
        return SETTINGS.booking.currencySymbol + Number(value).toFixed(2);
    
    }