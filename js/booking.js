const bookingdb=getSupabase();

let bookingCompany=null;
let airportRows=[];
let pricingSettings={};
let publicStopCounters={pickup:0,dropoff:0};

let routeMap=null;
let routeRenderer=null;
let routeService=null;

let currentStep=1;
let liveRouteTimer=null;
let stripeClient=null;
let stripeElements=null;
let stripePaymentElement=null;
let pendingStripeBooking=null;

let currentRoute={
    miles:null,
    minutes:null,
    origin:"",
    destination:""
};

let currentPrices={
    car:null,
    mpv:null,
    selected:null,
    method:null
};


document.addEventListener("DOMContentLoaded",async()=>{

    bindPublicStopButtons();

    bookingCompany=await loadCompanyConfig();

    if(!bookingCompany){
        alert("Unable to identify company.");
        return;
    }

    bindSteps();
    bindControls();
    
    await Promise.all([
        loadAirports(),
        loadPricingSettings()
    ]);

    await initialiseGoogleMapsForCompany();
    setDateMinimums();


    document
        .getElementById("bookingForm")
        ?.addEventListener("submit",saveBooking);

    updateLiveJourneyTitle();
});


function bindPublicStopButtons(){
    document.getElementById("addPublicPickup")?.addEventListener("click",()=>addPublicStop("pickup"));
    document.getElementById("addPublicDropoff")?.addEventListener("click",()=>addPublicStop("dropoff"));
}


async function initialiseGoogleMapsForCompany(){

    const apiKey=
        pricingSettings.googlemapsapi || "";

    if(!apiKey){
        console.warn("Google Maps is not configured for this company.");
        return;
    }

    try{
        await window.TransportAddressAutocomplete.loadGoogleMaps(apiKey);
        await initGoogleAutocomplete();
        initMap();

        setTimeout(()=>{
            refreshMapViewport();
            scheduleLiveRoute();
        },300);
    }catch(error){
        console.error("Unable to load Google Maps:",error);
    }
}


async function loadAirports(){

    const {data,error}=await bookingdb
        .from("airports")
        .select("id,company_id,name,code,active,price_1_4_oneway,price_1_4_return,price_5_7_oneway,price_5_7_return,deposit_percent,sort_order")
        .eq("company_id",bookingCompany.id)
        .eq("active",true)
        .order("sort_order",{ascending:true})
        .order("name",{ascending:true});

    if(error){
        console.error("Airport load error:",error);
        return;
    }

    airportRows=data||[];

    const select=document.getElementById("airportSelect");

    select.innerHTML=
        '<option value="">Select Airport</option>';

    airportRows.forEach(airport=>{

        const option=
            document.createElement("option");

        option.value=airport.name;
        option.textContent=airport.name;

        select.appendChild(option);
    });

    const requestedAirport=
        new URLSearchParams(window.location.search).get("airport");

    const matchingAirport=airportRows.find(airport=>
        requestedAirport &&
        airport.name.toLowerCase()===requestedAirport.toLowerCase()
    );

    if(matchingAirport){
        select.value=matchingAirport.name;
        airportHint();
    }
}


async function loadPricingSettings(){

    const {data,error}=await bookingdb
        .from("settings")
        .select("company_id,airportpricing,distancecalculator,maxadvancedays,minimumnotice,timezone,googlemapsapi,minimumfare,firstmile,mileband1,mileband2,mileband3,mileband4,mileband5,mileband6,bookingfee,returndiscount,currencysymbol,returnbookings,multiplestops,allowcash,allowcard,enablecash,enablestripe,allowaccounts,enableaccounts,requiredeposit,airportdepositrequired,depositpercent")
        .eq("company_id",bookingCompany.id)
        .maybeSingle();

    if(error){
        console.error("Pricing settings error:",error);
        return;
    }

    pricingSettings=data||{};

    const optionalSurcharge=await bookingdb.from("settings")
        .select("airportviasurcharge")
        .eq("company_id",bookingCompany.id)
        .maybeSingle();
    if(!optionalSurcharge.error && optionalSurcharge.data){
        pricingSettings.airportviasurcharge=optionalSurcharge.data.airportviasurcharge;
    }else{
        pricingSettings.airportviasurcharge=0;
        if(optionalSurcharge.error) console.info("Airport Via surcharge is not available yet; using £0.");
    }
    
    applyBookingRules();

    console.log(
        "Loaded booking pricing settings:",
        pricingSettings
    );
}

function applyBookingRules(){

    const airportEnabled =
        pricingSettings.airportpricing === true;

    const distanceEnabled =
        pricingSettings.distancecalculator === true;

    const airportButton =
        document.querySelector('.journey-choice[data-mode="airport"]');

    const distanceButton =
        document.querySelector('.journey-choice[data-mode="distance"]');

    const modeInput =
        document.getElementById("journeyMode");

    const returnCard=document.querySelector(".return-card");
    const returnInput=document.getElementById("returnJourney");
    const returnAllowed=pricingSettings.returnbookings===true;
    returnCard?.classList.toggle("hidden",!returnAllowed);
    if(!returnAllowed && returnInput){
        returnInput.checked=false;
        document.getElementById("returnFields")?.classList.add("hidden");
    }

    const stopsAllowed=pricingSettings.multiplestops===true;
    document.getElementById("addPublicPickup")?.classList.toggle("hidden",!stopsAllowed);
    document.getElementById("addPublicDropoff")?.classList.toggle("hidden",!stopsAllowed);
    if(!stopsAllowed){
        document.getElementById("publicPickupStops")?.replaceChildren();
        document.getElementById("publicDropoffStops")?.replaceChildren();
    }

    renderPublicPaymentOptions();

    // Show / hide booking types
    if(airportButton){
        airportButton.classList.toggle(
            "hidden",
            !airportEnabled
        );
    }

    if(distanceButton){
        distanceButton.classList.toggle(
            "hidden",
            !distanceEnabled
        );
    }

    // Airport only
    if(airportEnabled && !distanceEnabled){

        modeInput.value="airport";

        document
            .querySelectorAll(".journey-choice")
            .forEach(x=>x.classList.remove("active"));

        airportButton?.classList.add("active");
    }

    // Distance only
    if(!airportEnabled && distanceEnabled){

        modeInput.value="distance";

        document
            .querySelectorAll(".journey-choice")
            .forEach(x=>x.classList.remove("active"));

        distanceButton?.classList.add("active");
    }

    // Both enabled
    if(airportEnabled && distanceEnabled){

        if(
            modeInput.value!=="airport" &&
            modeInput.value!=="distance"
        ){
            modeInput.value="airport";
        }
    }

    updateMode();
}

function bindSteps(){

    document
        .querySelectorAll("[data-next]")
        .forEach(button=>
            button.addEventListener(
                "click",
                async()=>{

                    if(!validateStep(currentStep)){
                        return;
                    }

                    if(currentStep===1){
                        await calculateRoute(true);
                    }

                    if(currentStep===2){
                        calculatePrices();
                    }

                    const next=
                        Number(button.dataset.next);

                    if(next===5){
                        buildSummary();
                    }

                    showStep(next);
                }
            )
        );


    document
        .querySelectorAll("[data-back]")
        .forEach(button=>
            button.addEventListener(
                "click",
                ()=>showStep(
                    Number(button.dataset.back)
                )
            )
        );
}


function showStep(step){

    currentStep=step;

    document
        .querySelectorAll(".booking-step")
        .forEach(section=>
            section.classList.toggle(
                "active",
                Number(section.dataset.step)===step
            )
        );


    document
        .querySelectorAll(".progress-step")
        .forEach(button=>{

            const number=
                Number(button.dataset.stepButton);

            button.classList.toggle(
                "active",
                number===step
            );

            button.classList.toggle(
                "done",
                number<step
            );
        });


    setTimeout(()=>{
        refreshMapViewport();
        updateLiveJourneyTitle();
        updateLiveFare();
    },100);


    window.scrollTo({
        top:0,
        behavior:"smooth"
    });
}


function bindControls(){

    document.getElementById("validateAccount")?.addEventListener("click",validatePublicAccount);
    for(const id of ["accountCode","accountVerification"]){
        document.getElementById(id)?.addEventListener("input",()=>setAccountValidationStatus(""));
    }

    document
        .querySelectorAll(".journey-choice")
        .forEach(button=>
            button.addEventListener(
                "click",
                ()=>{

                    document
                        .querySelectorAll(".journey-choice")
                        .forEach(item=>
                            item.classList.remove("active")
                        );

                    button.classList.add("active");

                    document
                        .getElementById("journeyMode")
                        .value=
                        button.dataset.mode;

                    updateMode();
                    resetPrice();
                    updateLiveJourneyTitle();
                    scheduleLiveRoute();
                }
            )
        );


    document
        .getElementById("airportDirection")
        .addEventListener(
            "change",
            ()=>{
                updateMode();
                resetPrice();
                updateLiveJourneyTitle();
                scheduleLiveRoute();
            }
        );


    document
        .getElementById("airportSelect")
        .addEventListener(
            "change",
            ()=>{
                airportHint();
                resetPrice();
                updateLiveJourneyTitle();
                scheduleLiveRoute();
            }
        );


    document
        .getElementById("returnJourney")
        .addEventListener(
            "change",
            event=>{

                document
                    .getElementById("returnFields")
                    .classList.toggle(
                        "hidden",
                        !event.target.checked
                    );

                calculatePrices();
                updateLiveFare();
            }
        );


    document
        .getElementById("passengers")
        .addEventListener(
            "input",
            ()=>{
                calculatePrices();
                updateLiveFare();
            }
        );


    document
        .querySelectorAll(".vehicle-card")
        .forEach(card=>
            card.addEventListener(
                "click",
                ()=>{

                    if(
                        card.classList.contains("disabled")
                    ){
                        return;
                    }

                    document
                        .querySelectorAll(".vehicle-card")
                        .forEach(item=>
                            item.classList.remove("active")
                        );

                    card.classList.add("active");

                    document
                        .getElementById("vehicleType")
                        .value=
                        card.dataset.vehicle;

                    selectPrice();
                    updateLiveFare();
                    buildSummary();
                }
            )
        );


    updateMode();
}

function updatePublicAccountFields(){
    const selected=document.getElementById("paymentMethod")?.value==="Account";
    const section=document.getElementById("accountValidation");
    if(section) section.hidden=!selected;
    for(const id of ["accountCode","accountVerification"]){
        const field=document.getElementById(id);
        if(field) field.required=selected;
    }
    setAccountValidationStatus("");
}

function renderPublicPaymentOptions(){
    const payment=document.getElementById("paymentMethod");
    if(!payment) return;
    const previous=payment.value;
    const cardAllowed=pricingSettings.allowcard===true||pricingSettings.enablestripe===true;
    const cashAllowed=pricingSettings.allowcash===true||pricingSettings.enablecash===true;
    const accountAllowed=pricingSettings.allowaccounts===true||pricingSettings.enableaccounts===true;
    const airportPickup=document.getElementById("journeyMode")?.value==="airport"&&document.getElementById("airportDirection")?.value==="from_airport";
    const depositRequired=pricingSettings.requiredeposit===true||(airportPickup&&pricingSettings.airportdepositrequired===true);
    const airportNotice=document.getElementById("airportPaymentNotice");
    if(airportNotice) airportNotice.hidden=!(airportPickup&&pricingSettings.airportdepositrequired===true);
    const choices=[];
    if(cashAllowed&&!depositRequired) choices.push(["Pay in Car","Pay in Car"]);
    if(cardAllowed) choices.push(["Pay Now","Pay full amount now"]);
    if(cardAllowed&&depositRequired) choices.push(["Deposit",`Pay deposit (${publicDepositPercent()}%)`]);
    if(accountAllowed) choices.push(["Account","Account / invoice"]);
    payment.replaceChildren(...choices.map(([value,label])=>Object.assign(document.createElement("option"),{value,textContent:label})));
    payment.disabled=!choices.length;
    if(!choices.length) payment.appendChild(Object.assign(document.createElement("option"),{textContent:"Online booking unavailable — contact us"}));
    if(choices.some(([value])=>value===previous)) payment.value=previous;
    if(payment.dataset.paymentBound!=="true"){
        payment.dataset.paymentBound="true";
        payment.addEventListener("change",()=>{updatePublicAccountFields();updatePaymentBreakdown();});
    }
    updatePublicAccountFields();
    updatePaymentBreakdown();
}

function updatePaymentBreakdown(){
    const box=document.getElementById("paymentBreakdown");
    if(!box) return;
    const total=Number(currentPrices.selected);
    const method=document.getElementById("paymentMethod")?.value;
    if(!Number.isFinite(total)||!["Pay Now","Deposit"].includes(method)){box.hidden=true;box.textContent="";return;}
    const percent=publicDepositPercent();
    const due=method==="Deposit"?Math.round(total*percent)/100:total;
    box.hidden=false;
    box.innerHTML=`<strong>Journey total: ${esc(money(total))}</strong><br>Due now: ${esc(money(due))}${method==="Deposit"?`<br>Remaining balance: ${esc(money(Math.max(0,total-due)))}`:""}`;
}

function publicDepositPercent(){
    const airportPickup=document.getElementById("journeyMode")?.value==="airport"&&document.getElementById("airportDirection")?.value==="from_airport";
    const airportPercent=airportPickup?Number(findAirport()?.deposit_percent):NaN;
    const configured=Number.isFinite(airportPercent)&&airportPercent>0?airportPercent:Number(pricingSettings.depositpercent)||0;
    return Math.min(100,Math.max(0,configured));
}

async function validatePublicAccount(){
    const code=document.getElementById("accountCode")?.value.trim();
    const verification=document.getElementById("accountVerification")?.value.trim();
    if(!code || !verification){
        setAccountValidationStatus("Enter the account code and verification detail.",true);
        return;
    }
    setAccountValidationStatus("Checking account…");
    const {data,error}=await bookingdb.functions.invoke("public-booking-create",{
        body:{
            action:"validate_account",
            company_code:bookingCompany.company_code,
            booking:{account_code:code,account_verification:verification,account_po_reference:document.getElementById("accountPoReference")?.value.trim()||null}
        }
    });
    if(error || !data?.ok || !data?.valid){
        setAccountValidationStatus(data?.error || "Account details are invalid or unavailable.",true);
        return;
    }
    setAccountValidationStatus(`Validated: ${data.business_name}`);
}

function setAccountValidationStatus(message,error=false){
    const status=document.getElementById("accountValidationStatus");
    if(!status) return;
    status.textContent=message;
    status.style.color=error?"#b91c1c":"#166534";
}


function updateMode(){

    const mode=
        document.getElementById("journeyMode").value;

    const direction=
        document.getElementById("airportDirection").value;


    document
        .getElementById("airportJourneyFields")
        .classList.toggle(
            "hidden",
            mode!=="airport"
        );


    document
        .getElementById("flightField")
        .classList.toggle(
            "hidden",
            mode!=="airport"
        );


    document
        .getElementById("pickupAddressFields")
        .classList.toggle(
            "hidden",
            mode==="airport" &&
            direction==="from_airport"
        );


    document
        .getElementById("dropoffAddressFields")
        .classList.toggle(
            "hidden",
            mode==="airport" &&
            direction==="to_airport"
        );

    renderPublicPaymentOptions();
}


function validateStep(step){

    if(step===1){

        if(
            !document.getElementById("journeyDate").value ||
            !document.getElementById("journeyTime").value
        ){
            alert("Please enter date and time.");
            return false;
        }

        refreshPublicDateTimeLimits();
        if(!publicJourneyMeetsNotice(document.getElementById("journeyDate").value,document.getElementById("journeyTime").value)){
            alert("This journey needs more notice. Please choose a later date or time.");
            return false;
        }

        if (typeof window.validatePublicJourneyAgainstClosure === "function" &&
            !window.validatePublicJourneyAgainstClosure(
                document.getElementById("journeyDate").value,
                document.getElementById("journeyTime").value
            )) {
            return false;
        }

        const mode=
            document.getElementById("journeyMode").value;

        if(mode==="airport"){

            if(
                !document.getElementById("airportSelect").value
            ){
                alert("Please select an airport.");
                return false;
            }

            const direction=
                document.getElementById("airportDirection").value;

            if(
                direction==="to_airport" &&
                !document.getElementById("pickupAddress").value.trim()
            ){
                alert("Please select pickup address.");
                return false;
            }

            if(
                direction==="from_airport" &&
                !document.getElementById("dropoffAddress").value.trim()
            ){
                alert("Please select destination.");
                return false;
            }

        }else if(
            !document.getElementById("pickupAddress").value.trim() ||
            !document.getElementById("dropoffAddress").value.trim()
        ){
            alert("Please select pickup and destination.");
            return false;
        }


        if(
            document.getElementById("returnJourney").checked &&
            (
                !document.getElementById("returnDate").value ||
                !document.getElementById("returnTime").value
            )
        ){
            alert("Please enter return date and time.");
            return false;
        }

        if(document.getElementById("returnJourney").checked && !publicJourneyMeetsNotice(document.getElementById("returnDate").value,document.getElementById("returnTime").value)){
            alert("The return journey needs more notice. Please choose a later date or time.");
            return false;
        }

        if (document.getElementById("returnJourney").checked &&
            typeof window.validatePublicJourneyAgainstClosure === "function" &&
            !window.validatePublicJourneyAgainstClosure(
                document.getElementById("returnDate").value,
                document.getElementById("returnTime").value
            )) {
            return false;
        }
    }


    if(step===2){

        const passengers=
            Number(
                document.getElementById("passengers").value
            );

        if(
            passengers<1 ||
            passengers>7
        ){
            alert("Passengers must be between 1 and 7.");
            return false;
        }
    }


    if(
        step===3 &&
        !Number.isFinite(currentPrices.selected)
    ){
        alert(
            "Please select a vehicle with a valid price."
        );

        return false;
    }


    if(
        step===4 &&
        (
            !document.getElementById("customerName").value.trim() ||
            !document.getElementById("customerPhone").value.trim()
        )
    ){
        alert("Please enter name and mobile number.");
        return false;
    }

    if(step===4 && document.getElementById("paymentMethod")?.value==="Account" &&
        (!document.getElementById("accountCode")?.value.trim() || !document.getElementById("accountVerification")?.value.trim())){
        alert("Enter your account code and authorised email or billing postcode.");
        return false;
    }


    return true;
}


function setDateMinimums(){
    const journeyDate=document.getElementById("journeyDate");
    const journeyTime=document.getElementById("journeyTime");
    const returnDate=document.getElementById("returnDate");
    const returnTime=document.getElementById("returnTime");
    if(!journeyDate || !journeyTime || !returnDate || !returnTime) return;

    const refresh=()=>refreshPublicDateTimeLimits();
    journeyDate.addEventListener("change",refresh);
    journeyTime.addEventListener("change",refresh);
    returnDate.addEventListener("change",refresh);
    for(const input of [journeyDate,journeyTime,returnDate,returnTime]) input.addEventListener("focus",refresh);
    refresh();
}

function refreshPublicDateTimeLimits(){
    const journeyDate=document.getElementById("journeyDate");
    const journeyTime=document.getElementById("journeyTime");
    const returnDate=document.getElementById("returnDate");
    const returnTime=document.getElementById("returnTime");
    if(!journeyDate || !journeyTime || !returnDate || !returnTime) return;

    const limit=publicBookingLimits();
    journeyDate.min=limit.earliestDate;
    journeyDate.max=limit.latestDate;
    returnDate.min=journeyDate.value && journeyDate.value>limit.earliestDate?journeyDate.value:limit.earliestDate;
    returnDate.max=limit.latestDate;

    journeyTime.min=journeyDate.value===limit.earliestDate?limit.earliestTime:"00:00";
    returnTime.min=returnDate.value===limit.earliestDate?limit.earliestTime:"00:00";
    if(returnDate.value && journeyDate.value && returnDate.value===journeyDate.value && journeyTime.value){
        returnTime.min=journeyTime.value;
    }

    if(journeyDate.value && journeyDate.value<journeyDate.min) journeyDate.value="";
    if(journeyDate.value===limit.earliestDate && journeyTime.value && journeyTime.value<limit.earliestTime) journeyTime.value="";
    if(returnDate.value && returnDate.value<returnDate.min){returnDate.value="";returnTime.value="";}
    if(returnDate.value===limit.earliestDate && returnTime.value && returnTime.value<limit.earliestTime) returnTime.value="";

    const hint=document.getElementById("earliestBookingHint");
    if(hint) hint.textContent=`Earliest available: ${formatCompanyDate(limit.earliest)} at ${limit.earliestTime}`;
}

function publicBookingLimits(){
    const notice=Math.max(0,Number(pricingSettings.minimumnotice)||0);
    const maxDays=Math.max(0,Number(pricingSettings.maxadvancedays)||365);
    const stepMilliseconds=5*60*1000;
    let earliest=new Date(Math.ceil((Date.now()+notice*60000)/stepMilliseconds)*stepMilliseconds);
    const closureEnd=window.PUBLIC_CLOSURE_STATE?.active && window.PUBLIC_CLOSURE_STATE?.acceptAdvance
        ?window.PUBLIC_CLOSURE_STATE.endsAt:null;
    if(closureEnd instanceof Date && closureEnd>earliest){
        earliest=new Date((Math.floor(closureEnd.getTime()/stepMilliseconds)+1)*stepMilliseconds);
    }
    const latest=new Date(Date.now()+maxDays*86400000);
    const timezone=companyBookingTimezone();
    return{
        earliest,
        earliestDate:companyDateKey(earliest,timezone),
        earliestTime:companyTimeKey(earliest,timezone),
        latestDate:companyDateKey(latest,timezone)
    };
}

function companyBookingTimezone(){
    const candidate=String(pricingSettings.timezone||"Europe/London");
    try{new Intl.DateTimeFormat("en-GB",{timeZone:candidate}).format();return candidate;}catch{return "Europe/London";}
}

function companyDateTimeParts(date,timezone=companyBookingTimezone()){
    const parts=new Intl.DateTimeFormat("en-GB",{timeZone:timezone,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(date);
    return Object.fromEntries(parts.filter(part=>part.type!=="literal").map(part=>[part.type,part.value]));
}

function companyDateKey(date,timezone){
    const parts=companyDateTimeParts(date,timezone);
    return `${parts.year}-${parts.month}-${parts.day}`;
}

function companyTimeKey(date,timezone){
    const parts=companyDateTimeParts(date,timezone);
    return `${parts.hour}:${parts.minute}`;
}

function formatCompanyDate(date){
    return new Intl.DateTimeFormat("en-GB",{timeZone:companyBookingTimezone(),day:"numeric",month:"short"}).format(date);
}

function publicJourneyMeetsNotice(dateValue,timeValue){
    if(!dateValue || !timeValue) return false;
    const limit=publicBookingLimits();
    return dateValue>limit.earliestDate || (dateValue===limit.earliestDate && timeValue>=limit.earliestTime);
}


function airportHint(){

    const airport=
        findAirport();

    const hint=
        document.getElementById("airportPriceHint");

    if(!airport){

        hint.textContent="";
        return;
    }


    const prices=[
        airport.price_1_4_oneway,
        airport.price_1_4_return,
        airport.price_5_7_oneway,
        airport.price_5_7_return
    ]
        .map(Number)
        .filter(value=>value>0);


    hint.textContent=
        prices.length
            ?`Prices from ${currencySymbol()}${Math.min(...prices).toFixed(2)}`
            :"Contact us for price.";
}


async function initGoogleAutocomplete(){

    try{

        setupPublicAddressAutocomplete("pickupAddress");
        setupPublicAddressAutocomplete("dropoffAddress");

        document.querySelectorAll(".journey-stop-row").forEach(setupStopAutocomplete);

        console.log("Classic Google Places autocomplete loaded");

    }catch(error){

        console.error(
            "Google autocomplete:",
            error
        );
    }
}


function setupPublicAddressAutocomplete(id){
    window.TransportAddressAutocomplete.attach(id,{
        placeholder:"Search address, postcode or place",
        onSelect:()=>{
            resetPrice();
            updateLiveJourneyTitle();
            scheduleLiveRoute(150);
        },
        onInput:()=>{
            resetPrice();
            scheduleLiveRoute();
        }
    });
}


function addPublicStop(kind,value={}){
    const container=document.getElementById(kind==="pickup"?"publicPickupStops":"publicDropoffStops");
    if(!container) return;

    publicStopCounters[kind]+=1;
    const row=document.createElement("div");
    row.className="journey-stop-row";
    row.dataset.stopKind=kind;
    row.innerHTML=`<label>${kind==="pickup"?"Additional Pickup":"Additional Drop-off"} ${publicStopCounters[kind]}</label><input class="stop-address" placeholder="Search address, postcode or place" value="${esc(value.formatted_address||"")}" autocomplete="off"><button type="button" class="secondary-btn stop-remove">Remove</button>`;
    const stopInput=row.querySelector(".stop-address");
    if(value.address_name) stopInput.dataset.placeName=value.address_name;
    if(value.postcode) stopInput.dataset.postcode=value.postcode;
    row.querySelector(".stop-remove").onclick=()=>{
        row.remove();
        relabelPublicStops(kind);
        resetPrice();
        scheduleLiveRoute(150);
    };
    container.appendChild(row);
    relabelPublicStops(kind);
    if(window.google?.maps?.places) setupStopAutocomplete(row);
}


function setupStopAutocomplete(row){
    if(row.dataset.autocompleteBound==="true") return;
    row.dataset.autocompleteBound="true";
    const input=row.querySelector(".stop-address");
    window.TransportAddressAutocomplete.attach(input,{onSelect:()=>{resetPrice();scheduleLiveRoute(150);},onInput:()=>{resetPrice();scheduleLiveRoute();}});
}


function relabelPublicStops(kind){
    const container=document.getElementById(kind==="pickup"?"publicPickupStops":"publicDropoffStops");
    container?.querySelectorAll(".journey-stop-row").forEach((row,index)=>{
        const label=row.querySelector("label");
        if(label) label.textContent=`${kind==="pickup"?"Additional Pickup":"Additional Drop-off"} ${index+1}`;
    });
}


function collectPublicViaStops(){
    const rows=[...document.querySelectorAll("#publicPickupStops .journey-stop-row"),...document.querySelectorAll("#publicDropoffStops .journey-stop-row")];
    return rows.map((row,index)=>{const input=row.querySelector(".stop-address");const address=window.TransportAddressAutocomplete.metadata(input);return{stop_order:index+1,label:row.dataset.stopKind==="pickup"?"Additional Pickup":"Additional Drop-off",address_name:address.placeName,formatted_address:address.formattedAddress,postcode:address.postcode,latitude:address.latitude,longitude:address.longitude,place_id:address.placeId};}).filter(stop=>stop.formatted_address);
}


function initMap(){

    const element=
        document.getElementById("routeMap");

    if(
        !element ||
        !window.google?.maps
    ){
        return;
    }


    routeMap=
        new google.maps.Map(
            element,
            {
                center:{
                    lat:51.4816,
                    lng:-3.1791
                },

                zoom:9,

                mapTypeControl:false,
                streetViewControl:false,

                fullscreenControl:true
            }
        );


    routeService=
        new google.maps.DirectionsService();


    routeRenderer=
        new google.maps.DirectionsRenderer({
            map:routeMap,

            preserveViewport:true
        });
}


function endpoints(){

    const mode=
        document.getElementById("journeyMode").value;

    const pickup=
        document.getElementById("pickupAddress").value.trim();

    const dropoff=
        document.getElementById("dropoffAddress").value.trim();


    if(mode==="distance"){

        return{
            origin:pickup,
            destination:dropoff
        };
    }


    const airport=
        findAirport();

    if(!airport){
        return null;
    }


    const airportAddress=
        `${airport.name}, UK`;


    return document
        .getElementById("airportDirection")
        .value==="to_airport"

        ?{
            origin:pickup,
            destination:airportAddress
        }

        :{
            origin:airportAddress,
            destination:dropoff
        };
}


function scheduleLiveRoute(delay=350){

    clearTimeout(liveRouteTimer);

    liveRouteTimer=
        setTimeout(
            ()=>calculateRoute(false),
            delay
        );
}


async function calculateRoute(showError=false){

    const endpoint=
        endpoints();


    if(
        !endpoint?.origin ||
        !endpoint?.destination
    ){
        return;
    }


    if(!routeService){
        initMap();
    }


    if(!routeService){
        return;
    }


    const result=
        await new Promise(resolve=>
            routeService.route(
                {
                    origin:endpoint.origin,

                    destination:endpoint.destination,

                    waypoints:collectPublicViaStops().map(stop=>({location:stop.formatted_address,stopover:true})),

                    travelMode:
                        google.maps.TravelMode.DRIVING,

                    region:"GB"
                },

                (response,status)=>
                    resolve(
                        status==="OK"
                            ?response
                            :null
                    )
            )
        );


    if(!result){

        if(showError){
            alert(
                "Unable to calculate route."
            );
        }

        return;
    }


    document.getElementById("routeCard")?.classList.add("has-route");
    google.maps.event.trigger(routeMap,"resize");
    routeRenderer.setDirections(result);


    const legs=result.routes[0].legs;
    const leg=legs[0];
    const lastLeg=legs[legs.length-1];


    currentRoute={
        miles:
            legs.reduce((sum,item)=>sum+item.distance.value,0) /
            1609.344,

        minutes:
            legs.reduce((sum,item)=>sum+item.duration.value,0) /
            60,

        origin:
            leg.start_address,

        destination:
            lastLeg.end_address
    };


    document
        .getElementById("routeDistance")
        .textContent=
        `${currentRoute.miles.toFixed(1)} miles`;


    document
        .getElementById("routeDuration")
        .textContent=
        formatDuration(
            currentRoute.minutes
        );


    fitRouteToMap(
        leg
    );


    calculatePrices();

    updateLiveJourneyTitle();

    buildSummary();
}


function fitRouteToMap(leg){

    if(
        !routeMap ||
        !leg
    ){
        return;
    }


    const bounds=
        new google.maps.LatLngBounds();


    bounds.extend(
        leg.start_location
    );


    bounds.extend(
        leg.end_location
    );


    routeMap.fitBounds(
        bounds,
        55
    );


    setTimeout(()=>{

        const zoom=
            routeMap.getZoom();

        if(
            zoom &&
            zoom>13
        ){
            routeMap.setZoom(13);
        }

    },100);
}


function refreshMapViewport(){

    if(!routeMap){
        return;
    }


    google.maps.event.trigger(
        routeMap,
        "resize"
    );


    const directions=
        routeRenderer?.getDirections();


    const leg=
        directions
            ?.routes?.[0]
            ?.legs?.[0];


    if(leg){
        fitRouteToMap(leg);
    }
}


function calculatePrices(){

    const mode=
        document.getElementById("journeyMode").value;

    const isReturn=
        document.getElementById("returnJourney").checked;

    let car=null;
    let mpv=null;


    if(mode==="airport"){

        const airport=
            findAirport();

        if(airport){

            car=
                Number(
                    isReturn
                        ?airport.price_1_4_return
                        :airport.price_1_4_oneway
                );


            mpv=
                Number(
                    isReturn
                        ?airport.price_5_7_return
                        :airport.price_5_7_oneway
                );

            const passengerUplift=settingNumber(["bookingfee","booking_fee","bookingFee"],0);
            const passengers=Number(document.getElementById("passengers")?.value||0);
            if(passengers>=5 && Number.isFinite(car)) car*=1+passengerUplift/100;
            if(passengers>=5 && Number.isFinite(mpv)) mpv*=1+passengerUplift/100;

            const viaSurcharge=Math.max(0,settingNumber(["airportviasurcharge"],0));
            const viaTotal=collectPublicViaStops().length*viaSurcharge;
            if(Number.isFinite(car)) car+=viaTotal;
            if(Number.isFinite(mpv)) mpv+=viaTotal;
        }


        currentPrices.method=
            "Airport fixed price";


        document
            .getElementById("routePricingType")
            .textContent=
            "Airport fixed";

    }else{

        car=
            distanceFare(
                currentRoute.miles
            );


        const multiplier=
            settingNumber(
                [
                    "mpvmultiplier",
                    "mpv_multiplier",
                    "mpvMultiplier"
                ],
                1
            );


        mpv=
            Number.isFinite(car)
                ?round(
                    car *
                    (
                        multiplier>0
                            ?multiplier
                            :1
                    )
                )
                :null;


        currentPrices.method=
            "Distance price";


        document
            .getElementById("routePricingType")
            .textContent=
            "Distance";
    }


    currentPrices.car=
        positive(car);


    currentPrices.mpv=
        positive(mpv);


    updateVehicleCards();

    selectPrice();

    updateLiveFare();
}


function distanceFare(miles){

    if(
        !Number.isFinite(miles) ||
        miles<=0
    ){
        return null;
    }


    const minimumFare=
        settingNumber(
            [
                "minimumfare",
                "minimum_fare",
                "minimumFare"
            ],
            0
        );


    const firstMile=
        settingNumber(
            [
                "firstmile",
                "first_mile",
                "first_mile_price",
                "firstMile"
            ],
            0
        );


    const bookingFee=
        settingNumber(
            [
                "bookingfee",
                "booking_fee",
                "bookingFee"
            ],
            0
        );


    const rates=[
        settingNumber([
            "mileband1",
            "mile_band_1",
            "mile_band1",
            "band1_rate",
            "band_1_rate"
        ],0),

        settingNumber([
            "mileband2",
            "mile_band_2",
            "mile_band2",
            "band2_rate",
            "band_2_rate"
        ],0),

        settingNumber([
            "mileband3",
            "mile_band_3",
            "mile_band3",
            "band3_rate",
            "band_3_rate"
        ],0),

        settingNumber([
            "mileband4",
            "mile_band_4",
            "mile_band4",
            "band4_rate",
            "band_4_rate"
        ],0),

        settingNumber([
            "mileband5",
            "mile_band_5",
            "mile_band5",
            "band5_rate",
            "band_5_rate"
        ],0),

        settingNumber([
            "mileband6",
            "mile_band_6",
            "mile_band6",
            "band6_rate",
            "band_6_rate"
        ],0)
    ];


    const configured=
        firstMile>0 ||
        rates.some(rate=>rate>0);


    if(!configured){

        console.warn(
            "No distance pricing values found in settings:",
            pricingSettings
        );

        return null;
    }


    const ends=[
        10,
        30,
        80,
        150,
        500,
        1000
    ];


    let total=
        firstMile;


    let remaining=
        Math.max(
            0,
            miles-1
        );


    let start=1;


    for(
        let index=0;
        index<ends.length &&
        remaining>0;
        index++
    ){

        const width=
            ends[index]-start;


        const milesInBand=
            Math.min(
                remaining,
                width
            );


        total+=
            milesInBand *
            rates[index];


        remaining-=
            milesInBand;


        start=
            ends[index];
    }


    if(remaining>0){

        total+=
            remaining *
            rates[5];
    }


    const passengers =
    Number(document.getElementById("passengers")?.value || 0);

if (passengers >= 5 && passengers <= 7) {
    total += total * (bookingFee / 100);
};


    if(
        document
            .getElementById("returnJourney")
            .checked
    ){

        total*=2;


        const discount=
            settingNumber(
                [
                    "returndiscount",
                    "return_discount",
                    "returnDiscount"
                ],
                0
            );


        if(discount>0){

            total*=
                1-discount/100;
        }
    }


    return Math.floor(
        Math.max(
            minimumFare,
            total
        ) * 2
    ) / 2;
}


function settingNumber(
    names,
    fallback=0
){

    for(const name of names){

        if(
            pricingSettings &&
            pricingSettings[name]!==undefined &&
            pricingSettings[name]!==null &&
            pricingSettings[name]!==""
        ){

            const value=
                Number(
                    pricingSettings[name]
                );


            if(
                Number.isFinite(value)
            ){
                return value;
            }
        }
    }


    return fallback;
}


function updateVehicleCards(){

    document
        .getElementById("carPrice")
        .textContent=
        money(currentPrices.car);


    document
        .getElementById("mpvPrice")
        .textContent=
        money(currentPrices.mpv);


    const passengers=
        Number(
            document.getElementById("passengers").value
        );


    const carCard=
        document.querySelector(
            '[data-vehicle="car"]'
        );


    carCard.classList.toggle(
        "disabled",
        passengers>4
    );


    if(
        passengers>4 &&
        document.getElementById("vehicleType").value==="car"
    ){

        document.getElementById("vehicleType").value=
            "mpv";


        document
            .querySelectorAll(".vehicle-card")
            .forEach(card=>
                card.classList.toggle(
                    "active",
                    card.dataset.vehicle==="mpv"
                )
            );
    }


    document
        .getElementById("vehiclePriceNote")
        .textContent=
        (
            !currentPrices.car &&
            !currentPrices.mpv
        )
            ?"A price has not been configured for this journey. Please contact us."
            :"Select a vehicle to continue.";
}


function selectPrice(){

    currentPrices.selected=
        document
            .getElementById("vehicleType")
            .value==="mpv"

        ?currentPrices.mpv
        :currentPrices.car;


    document
        .getElementById("finalPrice")
        .textContent=
        money(currentPrices.selected);


    updateLiveFare();
}


function updateLiveFare(){

    const liveFare=
        document.getElementById("liveFare");

    const routeFare=
        document.getElementById("routeFare");


    const value=
        currentPrices.selected ??
        currentPrices.car ??
        currentPrices.mpv;


    const display=
        money(value);


    if(liveFare){
        liveFare.textContent=display;
    }


    if(routeFare){
        routeFare.textContent=display;
    }

    updatePaymentBreakdown();
}


function updateLiveJourneyTitle(){

    const element=
        document.getElementById("liveJourneyTitle");

    if(!element){
        return;
    }


    const pickup=
        savedPickup();

    const dropoff=
        savedDropoff();


    if(
        pickup &&
        dropoff
    ){

        element.textContent=
            `${shortPlace(pickup)} → ${shortPlace(dropoff)}`;

    }else{

        element.textContent=
            "Choose your pickup and destination";
    }
}


function shortPlace(value){

    return String(value||"")
        .split(",")[0]
        .trim();
}


function buildSummary(){

    const summary=
        document.getElementById("bookingSummary");

    if(!summary){
        return;
    }


    const mode=
        document.getElementById("journeyMode").value;


    const direction=
        document.getElementById("airportDirection").value;


    const airport=
        document.getElementById("airportSelect").value;


    const passengers=
        document.getElementById("passengers").value;


    const suitcases=
        document.getElementById("suitcases").value;


    const handLuggage=
        document.getElementById("handLuggage").value;


    const flightNumber=
        document.getElementById("flightNumber").value.trim();


    const vehicle=
        document.getElementById("vehicleType").value==="mpv"
            ?"MPV"
            :"Car";


    const returnJourney=
        document.getElementById("returnJourney").checked;


    let journeyDescription=
        "Standard Journey";


    if(mode==="airport"){

        journeyDescription=
            direction==="from_airport"

            ?`Airport Pickup — ${airport}`

            :`Airport Transfer — ${airport}`;
    }


    let returnDescription=
        "No";


    if(returnJourney){

        returnDescription=
            `${formatDate(
                document.getElementById("returnDate").value
            )} at ${
                document.getElementById("returnTime").value
            }`;
    }


    const rows=[
        [
            "Journey",
            journeyDescription
        ],

        [
            "Route",
            `${displayPublicAddress("pickupName",savedPickup())} → ${displayPublicAddress("dropoffName",savedDropoff())}`
        ],

        [
            "Date & time",
            `${formatDate(
                document.getElementById("journeyDate").value
            )} at ${
                document.getElementById("journeyTime").value
            }`
        ],

        [
            "Return",
            returnDescription
        ],

        [
            "Passengers",
            `${passengers} passenger${
                Number(passengers)===1
                    ?""
                    :"s"
            }`
        ],

        [
            "Luggage",
            `${suitcases} suitcase${
                Number(suitcases)===1
                    ?""
                    :"s"
            }, ${handLuggage} hand luggage`
        ],

        [
            "Vehicle",
            vehicle
        ],

        [
            "Distance",
            Number.isFinite(currentRoute.miles)
                ?`${currentRoute.miles.toFixed(1)} miles`
                :"—"
        ],

        [
            "Journey time",
            Number.isFinite(currentRoute.minutes)
                ?formatDuration(currentRoute.minutes)
                :"—"
        ],

        [
            "Payment",
            document.getElementById("paymentMethod").value
        ]
    ];


    if(
        mode==="airport" &&
        flightNumber
    ){

        rows.splice(
            4,
            0,
            [
                "Flight number",
                flightNumber
            ]
        );
    }


    summary.innerHTML=
        rows
            .map(
                ([label,value])=>`
                    <div class="review-row">
                        <span>${esc(label)}</span>
                        <strong>${esc(value)}</strong>
                    </div>
                `
            )
            .join("");


    selectPrice();
}


async function saveBooking(event){

    event.preventDefault();

    if(pendingStripeBooking){
        await confirmPendingStripePayment();
        return;
    }

    const cashAllowed=pricingSettings.allowcash===true || pricingSettings.enablecash===true;
    const cardAllowed=pricingSettings.allowcard===true || pricingSettings.enablestripe===true;
    const accountAllowed=pricingSettings.allowaccounts===true || pricingSettings.enableaccounts===true;
    if(!cashAllowed && !cardAllowed && !accountAllowed){
        alert("Online booking is unavailable because no payment method is enabled.");
        return;
    }

    if (typeof window.validatePublicJourneyAgainstClosure === "function" &&
        !window.validatePublicJourneyAgainstClosure(
            document.getElementById("journeyDate").value,
            document.getElementById("journeyTime").value
        )) {
        return;
    }

    if (document.getElementById("returnJourney").checked &&
        typeof window.validatePublicJourneyAgainstClosure === "function" &&
        !window.validatePublicJourneyAgainstClosure(
            document.getElementById("returnDate").value,
            document.getElementById("returnTime").value
        )) {
        return;
    }


    if(
        !validateStep(4) ||
        !Number.isFinite(currentPrices.selected)
    ){

        alert(
            "Please complete the booking."
        );

        return;
    }


    const company=
        bookingCompany;


    const phone=
        document.getElementById("customerPhone").value.trim();


    try{
        const pickupAddress=window.TransportAddressAutocomplete.metadata("pickupAddress");
        const dropoffAddress=window.TransportAddressAutocomplete.metadata("dropoffAddress");
        const record={

            customer_name:
                document.getElementById("customerName").value.trim(),

            pickup_address:
                savedPickup(),

            pickup_name:publicPropertyDetail("pickup"),
            pickup_postcode:pickupAddress.postcode,
            pickup_place_id:pickupAddress.placeId,
            pickup_lat:pickupAddress.latitude,
            pickup_lng:pickupAddress.longitude,

            dropoff_address:
                savedDropoff(),

            dropoff_name:publicPropertyDetail("dropoff"),
            dropoff_postcode:dropoffAddress.postcode,
            dropoff_place_id:dropoffAddress.placeId,
            dropoff_lat:dropoffAddress.latitude,
            dropoff_lng:dropoffAddress.longitude,

            airport:
                document.getElementById("journeyMode").value==="airport"
                    ?document.getElementById("airportSelect").value
                    :"",

            flight_number:
                document.getElementById("flightNumber").value.trim(),

            journey_type:
                document.getElementById("journeyMode").value,

            journey_date:
                document.getElementById("journeyDate").value,

            journey_time:
                document.getElementById("journeyTime").value,

            return_journey:
                document.getElementById("returnJourney").checked,

            return_date:
                document.getElementById("returnDate").value ||
                null,

            return_time:
                document.getElementById("returnTime").value ||
                null,

            phone,

            email:
                document.getElementById("customerEmail").value.trim(),

            passengers:
                Number(
                    document.getElementById("passengers").value
                ),

            suitcases:
                Number(
                    document.getElementById("suitcases").value
                ),

            hand_luggage:
                Number(
                    document.getElementById("handLuggage").value
                ),

            vehicle_type:
                document.getElementById("vehicleType").value,

            notes:
                document.getElementById("notes").value.trim(),

            payment_method:
                document.getElementById("paymentMethod").value,

            account_code: document.getElementById("accountCode")?.value.trim() || null,
            account_verification: document.getElementById("accountVerification")?.value.trim() || null,
            account_po_reference: document.getElementById("accountPoReference")?.value.trim() || null,

            status:
                "Waiting"
        };


        const {data:created,error}=await bookingdb.functions.invoke("public-booking-create",{
            body:{company_code:company.company_code,booking:record,stops:collectPublicViaStops()}
        });
        if(error||!created?.ok) throw new Error(await publicBookingErrorMessage(error,created));

        if(created.stripe){
            await prepareStripePayment(created);
            return;
        }

        await Promise.all((created.bookings||[]).map(booking => requestPublicGoogleCalendarSync(company.id, booking.id)));

        const firstBooking=created.bookings?.[0];
        const emailResult=firstBooking?await bookingdb.functions.invoke("send-booking-email",{body:{company_id:company.id,booking_id:firstBooking.id,template_key:"booking_confirmation"}}):{error:null};
        if(emailResult.error) console.error("Booking saved but confirmation email could not be sent:",emailResult.error);


        alert(
            `Booking created successfully!\n\nReference: ${created.reference}`
        );

    }catch(error){

        console.error(error);

        alert(
            "Unable to save booking.\n\n"+
            error.message
        );
    }
}

async function prepareStripePayment(created){
    if(!window.Stripe) throw new Error("Stripe payment controls could not be loaded.");
    stripeClient=window.Stripe(created.stripe.publishable_key);
    stripeElements=stripeClient.elements({clientSecret:created.stripe.client_secret,appearance:{theme:"stripe"}});
    stripePaymentElement=stripeElements.create("payment",{layout:"tabs"});
    stripePaymentElement.mount("#stripePaymentElement");
    pendingStripeBooking=created;
    const panel=document.getElementById("stripePaymentPanel");
    if(panel) panel.hidden=false;
    const breakdown=document.getElementById("paymentBreakdown");
    if(breakdown){breakdown.hidden=false;breakdown.innerHTML=`<strong>Journey total: ${esc(money(created.authoritative_price))}</strong><br>Due now: ${esc(money(created.stripe.amount_due))}${created.stripe.payment_type==="deposit"?`<br>Remaining balance: ${esc(money(created.stripe.balance_due))}`:""}`;}
    const button=document.getElementById("confirmBookingButton");
    if(button) button.textContent="Complete secure payment";
    document.querySelector('[data-back="4"]')?.setAttribute("disabled","");
    document.getElementById("paymentMethod")?.setAttribute("disabled","");
    document.getElementById("stripePaymentPanel")?.scrollIntoView({behavior:"smooth",block:"center"});
}

async function confirmPendingStripePayment(){
    const button=document.getElementById("confirmBookingButton");
    const message=document.getElementById("stripePaymentMessage");
    if(button) button.disabled=true;
    if(message) message.textContent="Processing payment…";
    const result=await stripeClient.confirmPayment({elements:stripeElements,redirect:"if_required",confirmParams:{return_url:window.location.href}});
    if(button) button.disabled=false;
    if(result.error){if(message) message.textContent=result.error.message||"Payment was not completed.";return;}
    const status=String(result.paymentIntent?.status||"");
    if(status && !["succeeded","processing"].includes(status)){
        if(message) message.textContent="Your payment needs further action. Please follow the payment instructions above.";
        return;
    }
    showStripePaymentConfirmation(pendingStripeBooking,status);
}

function showStripePaymentConfirmation(created,paymentIntentStatus){
    const isDeposit=created.stripe?.payment_type==="deposit";
    const email=document.getElementById("customerEmail")?.value.trim()||"";
    const processing=paymentIntentStatus==="processing";

    stripePaymentElement?.unmount();
    stripePaymentElement=null;
    stripeElements=null;
    stripeClient=null;

    const checkout=document.getElementById("bookingCheckoutContent");
    const confirmation=document.getElementById("bookingPaymentConfirmation");
    if(checkout) checkout.hidden=true;
    if(confirmation) confirmation.hidden=false;
    document.querySelector(".booking-progress")?.setAttribute("hidden","");

    setConfirmationText("paymentConfirmationLead",processing
        ?"Your payment was submitted successfully and is processing."
        :isDeposit?"Your deposit payment was successful.":"Your payment was successful.");
    setConfirmationText("confirmationReference",created.reference||"—");
    setConfirmationText("confirmationJourneyTotal",money(created.authoritative_price));
    setConfirmationText("confirmationPaidLabel",isDeposit?"Deposit paid":"Amount paid");
    setConfirmationText("confirmationAmountPaid",money(created.stripe?.amount_due));
    setConfirmationText("confirmationBalance",money(created.stripe?.balance_due||0));
    setConfirmationText("confirmationEmail",email);
    const emailRow=document.getElementById("confirmationEmailRow");
    if(emailRow) emailRow.hidden=!email;

    const companyCode=bookingCompany?.company_code;
    const companyQuery=companyCode?`?company=${encodeURIComponent(companyCode)}`:"";
    const homeLink=document.getElementById("confirmationHomeLink");
    const anotherLink=document.getElementById("confirmationAnotherLink");
    if(homeLink) homeLink.href=`index.html${companyQuery}`;
    if(anotherLink) anotherLink.href=`booking.html${companyQuery}`;

    pendingStripeBooking=null;
    confirmation?.scrollIntoView({behavior:"smooth",block:"start"});
}

function setConfirmationText(id,value){
    const element=document.getElementById(id);
    if(element) element.textContent=value;
}

async function publicBookingErrorMessage(error,data){
    let message=String(data?.error||"");
    if(!message && error?.context instanceof Response){
        try{
            const payload=await error.context.clone().json();
            message=String(payload?.error||"");
        }catch{
            try{message=await error.context.clone().text();}catch{}
        }
    }
    if(!message) message=String(error?.message||"Unable to create booking");
    if(/minimum notice|does not meet the minimum notice|needs more notice/i.test(message)){
        return "This journey needs more notice. Please choose a later date or time.";
    }
    return message;
}

async function requestPublicGoogleCalendarSync(companyId, bookingId) {
    const { data, error } = await bookingdb.functions.invoke("google-calendar-sync", {
        body: { company_id: companyId, booking_id: bookingId }
    });

    if (error || !data?.ok) {
        console.error("Google Calendar sync failed", {
            company_id: companyId,
            booking_id: bookingId,
            stage: data?.stage,
            error: data?.error || error?.message || "Unknown Edge Function error"
        });
        return false;
    }

    console.info("Google Calendar sync completed", data);
    return true;
}


function findAirport(){

    const name=
        document.getElementById("airportSelect").value;


    return airportRows.find(
        airport=>airport.name===name
    ) || null;
}


function savedPickup(){

    if(
        document.getElementById("journeyMode").value==="airport" &&
        document.getElementById("airportDirection").value==="from_airport"
    ){

        return document
            .getElementById("airportSelect")
            .value;
    }


    return document
        .getElementById("pickupAddress")
        .value
        .trim();
}

function displayPublicAddress(detailId,address){
    const detail=publicPropertyDetail(detailId.startsWith("pickup")?"pickup":"dropoff");
    return [detail,address].filter(Boolean).join(", ");
}

function publicPropertyDetail(endpoint){
    const airportMode=document.getElementById("journeyMode")?.value==="airport";
    const direction=document.getElementById("airportDirection")?.value;
    if(airportMode && ((endpoint==="pickup" && direction==="from_airport") || (endpoint==="dropoff" && direction==="to_airport"))) return null;
    return document.getElementById(endpoint==="pickup"?"pickupName":"dropoffName")?.value.trim()||null;
}


function savedDropoff(){

    if(
        document.getElementById("journeyMode").value==="airport" &&
        document.getElementById("airportDirection").value==="to_airport"
    ){

        return document
            .getElementById("airportSelect")
            .value;
    }


    return document
        .getElementById("dropoffAddress")
        .value
        .trim();
}


function resetPrice(){

    currentRoute={
        miles:null,
        minutes:null,
        origin:"",
        destination:""
    };


    currentPrices={
        car:null,
        mpv:null,
        selected:null,
        method:null
    };

    document.getElementById("routeCard")?.classList.remove("has-route");
    routeRenderer?.set("directions",null);


    [
        "routeDistance",
        "routeDuration"
    ].forEach(
        id=>
            document
                .getElementById(id)
                .textContent="—"
    );


    document
        .getElementById("routePricingType")
        .textContent=
        "Waiting";


    document
        .getElementById("carPrice")
        .textContent=
        "£—";


    document
        .getElementById("mpvPrice")
        .textContent=
        "£—";


    updateLiveFare();
}


function positive(value){

    value=
        Number(value);


    return(
        Number.isFinite(value) &&
        value>0
    )
        ?round(value)
        :null;
}


function round(value){

    return(
        Math.round(
            Number(value)*100
        )/100
    );
}


function money(value){

    return Number.isFinite(value)
        ?`${currencySymbol()}${Number(value).toFixed(2)}`
        :`${currencySymbol()}—`;
}

function currencySymbol(){
    return pricingSettings.currencysymbol || "£";
}


function formatDuration(minutes){

    const hours=
        Math.floor(minutes/60);


    const remaining=
        Math.round(minutes%60);


    return hours

        ?`${hours} hr${
            remaining
                ?` ${remaining} min`
                :""
        }`

        :`${remaining} min`;
}


function formatDate(value){

    if(!value){
        return "—";
    }


    const parts=
        value.split("-");


    if(parts.length!==3){
        return value;
    }


    return(
        `${parts[2]}/${parts[1]}/${parts[0]}`
    );
}


function esc(value){

    return String(value??"")
        .replaceAll("&","&amp;")
        .replaceAll("<","&lt;")
        .replaceAll(">","&gt;")
        .replaceAll('"',"&quot;")
        .replaceAll("'","&#039;");
}
