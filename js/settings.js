/*
===========================================
TRANSPORT PLATFORM SETTINGS
Version: 1.0
===========================================
*/

window.SETTINGS = {

        /*
        ===========================================
        COMPANY
        ===========================================
        */
    
        company: {
            name: "Executive Travel",
            tradingName: "Executive Travel",
            website: "https://executivetravel.co.uk",
            address: "Vale of Glamorgan",
            companyType: "airport-transfer"
        },
    
        /*
        ===========================================
        BRANDING
        ===========================================
        */
    
        branding: {
            logo: "assets/logos/logo.png",
            heroImage: "assets/images/hero.jpg",
            favicon: "assets/icons/favicon.png",
    
            primaryColour: "#d4af37",
            secondaryColour: "#111111",
            accentColour: "#ffffff"
        },
    
        /*
        ===========================================
        CONTACT
        ===========================================
        */
    
        contact: {
            phone: "07791 650156",
            email: "exectravel1@hotmail.com",
            whatsapp: "",
            emergencyPhone: ""
        },
    
        /*
        ===========================================
        BUSINESS
        ===========================================
        */
    
        business: {
            localWork: false,
            airportTransfers: true,
            executiveTravel: true,
            corporateTravel: true,
            schoolRuns: false,
            courierWork: false
        },
    
        /*
        ===========================================
        PRICING
        ===========================================
        */
    
        pricing: {
            returnDiscount: 10,
            seasonalIncrease: 0,
            meetAndGreet: 0,
            childSeat: 0,
            boosterSeat: 0,
            waitingChargePerMinute: 0
        },
    
        /*
        ===========================================
        BOOKING
        ===========================================
        */
    
        booking: {
            nextBookingNumber: 1000,
            prefix: "ET",
            currency: "GBP",
            currencySymbol: "£"
        },
    
        /*
        ===========================================
        AIRPORTS
        ===========================================
        */
    
        airports: [
    
            {
                id: 1,
                name: "Cardiff Airport",
                passengers14: 120,
                passengers57: 170
            },
    
            {
                id: 2,
                name: "Bristol Airport",
                passengers14: 180,
                passengers57: 240
            },
    
            {
                id: 3,
                name: "Heathrow Airport",
                passengers14: 260,
                passengers57: 340
            },
    
            {
                id: 4,
                name: "Gatwick Airport",
                passengers14: 310,
                passengers57: 390
            }
    
        ],
    
        /*
        ===========================================
        GOOGLE CALENDAR
        ===========================================
        */
    
        calendar: {
            enabled: false,
            calendarId: "",
            apiKey: ""
        },
    
        /*
        ===========================================
        EMAIL
        ===========================================
        */
    
        email: {
            bookings: "exectravel1@hotmail.com",
            accounts: "",
            support: ""
        },
    
        /*
        ===========================================
        SMS
        ===========================================
        */
    
        sms: {
            enabled: false,
            provider: "",
            senderId: ""
        },
    
        /*
        ===========================================
        DRIVER SETTINGS
        ===========================================
        */
    
        drivers: {
            nextDriverNumber: 1,
            prefix: "DRV",
            defaultPassword: "ChangeMe123"
        },
    
        /*
        ===========================================
        INVOICES
        ===========================================
        */
    
        invoices: {
            prefix: "INV",
            nextInvoiceNumber: 1000
        },
    
        /*
        ===========================================
        AVAILABILITY
        ===========================================
        */
    
        availability: {
            closed: false,
            message: "We are currently closed.",
            closedFrom: "",
            closedTo: ""
        }
    
    };