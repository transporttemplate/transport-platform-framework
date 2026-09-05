const bookingdb=getSupabase();

let bookingCompany=null;
let airportRows=[];
let pricingSettings={};
let publicViaCounter=0;

let routeMap=null;
let routeRenderer=null;
let routeService=null;

let currentStep=1;
let liveRouteTimer=null;

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

    bindPublicViaButton();

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


function bindPublicViaButton(){
    const button=document.getElementById("addPublicVia");
    if(!button || button.dataset.bound==="true") return;

    button.dataset.bound="true";
    button.addEventListener("click",()=>addPublicViaStop());
}


async function initialiseGoogleMapsForCompany(){

    const apiKey=
        pricingSettings.googlemapsapi || "";

    if(!apiKey){
        console.warn("Google Maps is not configured for this company.");
        return;
    }

    try{
        await loadGoogleMapsBrowserApi(apiKey);
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


function loadGoogleMapsBrowserApi(apiKey){

    if(window.google?.maps?.places?.Autocomplete){
        return Promise.resolve();
    }

    return new Promise((resolve,reject)=>{
        const callbackName="__publicBookingGoogleMapsLoaded";
        window[callbackName]=()=>{
            delete window[callbackName];
            resolve();
        };

        const script=document.createElement("script");
        script.src=
            "https://maps.googleapis.com/maps/api/js?key="+
            encodeURIComponent(apiKey)+
            "&libraries=places&loading=async&callback="+
            callbackName;
        script.async=true;
        script.onerror=()=>{
            delete window[callbackName];
            reject(new Error("Google Maps JavaScript API failed to load."));
        };
        document.head.appendChild(script);
    });
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
        .select("company_id,airportpricing,distancecalculator,maxadvancedays,minimumnotice,googlemapsapi,minimumfare,firstmile,mileband1,mileband2,mileband3,mileband4,mileband5,mileband6,bookingfee,returndiscount,currencysymbol,returnbookings,multiplestops,allowcash,allowcard,enablecash,enablestripe,allowaccounts,enableaccounts,requiredeposit,airportdepositrequired,depositpercent")
        .eq("company_id",bookingCompany.id)
        .maybeSingle();

    if(error){
        console.error("Pricing settings error:",error);
        return;
    }

    pricingSettings=data||{};
    
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

    const viaButton=document.getElementById("addPublicVia");
    const stopsAllowed=pricingSettings.multiplestops===true;
    viaButton?.classList.toggle("hidden",!stopsAllowed);
    if(!stopsAllowed) document.getElementById("publicViaStops")?.replaceChildren();

    const payment=document.getElementById("paymentMethod");
    if(payment){
        const choices=[];
        // Card is deliberately unavailable until a verified Stripe flow exists.
        const cardAllowed=false;
        const cashAllowed=pricingSettings.allowcash===true || pricingSettings.enablecash===true;
        const accountAllowed=pricingSettings.allowaccounts===true || pricingSettings.enableaccounts===true;
        if(cardAllowed) choices.push(["Pay Now","Card / prepaid"]);
        if(cashAllowed) choices.push(["Pay in Car","Pay in Car"]);
        if(accountAllowed) choices.push(["Account","Account / invoice"]);
        payment.replaceChildren(...choices.map(([value,label])=>{
            const option=document.createElement("option");
            option.value=value;
            option.textContent=label;
            return option;
        }));
        payment.disabled=choices.length===0;
        if(!choices.length){
            const option=document.createElement("option");
            option.textContent=(pricingSettings.allowcard===true || pricingSettings.enablestripe===true)
                ?"Card payments are not available online yet — contact us"
                :"Online booking unavailable — contact us";
            payment.appendChild(option);
        }
        payment.addEventListener("change",updatePublicAccountFields);
        updatePublicAccountFields();
    }

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
        .getElementById("pickupWrap")
        .classList.toggle(
            "hidden",
            mode==="airport" &&
            direction==="from_airport"
        );


    document
        .getElementById("dropoffWrap")
        .classList.toggle(
            "hidden",
            mode==="airport" &&
            direction==="to_airport"
        );
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

    const journeyDate =
        document.getElementById("journeyDate");

    const returnDate =
        document.getElementById("returnDate");

    const now = new Date();

    const minimumNoticeMinutes =
        Number(pricingSettings.minimumnotice || 0);

    const maxAdvanceDays =
        Number(pricingSettings.maxadvancedays || 365);

    let earliest =
        new Date(
            now.getTime() +
            minimumNoticeMinutes * 60 * 1000
        );

    const closureEnd = window.PUBLIC_CLOSURE_STATE?.active &&
        window.PUBLIC_CLOSURE_STATE?.acceptAdvance
        ? window.PUBLIC_CLOSURE_STATE.endsAt
        : null;

    if (closureEnd instanceof Date && closureEnd > earliest) earliest = closureEnd;

    const latest =
        new Date(
            now.getTime() +
            maxAdvanceDays * 24 * 60 * 60 * 1000
        );

    const earliestDate =
        earliest.toISOString().slice(0,10);

    const latestDate =
        latest.toISOString().slice(0,10);

    journeyDate.min = earliestDate;
    journeyDate.max = latestDate;

    returnDate.min = earliestDate;
    returnDate.max = latestDate;

    journeyDate.addEventListener("change",event=>{

        returnDate.min =
            event.target.value || earliestDate;

    });
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

        // Keep the existing real HTML inputs.
        // This avoids Google's new full-screen/top-layer autocomplete on mobile.
        setupClassicAutocomplete(
            "pickupAddress",
            "Enter pickup address"
        );

        setupClassicAutocomplete(
            "dropoffAddress",
            "Enter destination"
        );

        document.querySelectorAll("#publicViaStops .via-stop-row").forEach(setupViaAutocomplete);

        console.log("Classic Google Places autocomplete loaded");

    }catch(error){

        console.error(
            "Google autocomplete:",
            error
        );
    }
}


function setupClassicAutocomplete(
    id,
    placeholder
){

    const input=
        document.getElementById(id);

    if(!input){
        return;
    }


    // Important: make sure the original input remains visible.
    input.style.display="block";
    input.placeholder=placeholder;


    const autocomplete=
        new google.maps.places.Autocomplete(
            input,
            {
                componentRestrictions:{
                    country:"gb"
                },

                fields:[
                    "formatted_address",
                    "geometry",
                    "name",
                    "place_id",
                    "address_components"
                ]
            }
        );


    autocomplete.addListener(
        "place_changed",
        ()=>{

            const place=
                autocomplete.getPlace();


            if(
                !place ||
                !place.geometry ||
                !place.geometry.location
            ){
                return;
            }


            input.value=
                place.formatted_address ||
                place.name ||
                "";


            input.dataset.lat=
                place.geometry.location.lat();


            input.dataset.lng=
                place.geometry.location.lng();

            input.dataset.placeId=place.place_id || "";

            const postcode=(place.address_components||[]).find(component=>component.types.includes("postal_code"))?.long_name || "";
            const postcodeInput=document.getElementById(id==="pickupAddress"?"pickupPostcode":"dropoffPostcode");
            if(postcodeInput && postcode) postcodeInput.value=postcode;


            // Keep all of the existing booking logic unchanged.
            resetPrice();

            updateLiveJourneyTitle();

            scheduleLiveRoute(150);
        }
    );
}


function addPublicViaStop(value={}){
    const container=document.getElementById("publicViaStops");
    if(!container) return;

    publicViaCounter+=1;
    const row=document.createElement("div");
    row.className="via-stop-row";
    row.dataset.viaId=String(publicViaCounter);
    row.innerHTML=`<label>Via ${publicViaCounter}</label><input class="via-name" placeholder="House name, hotel or business (optional)" value="${esc(value.address_name||"")}"><input class="via-address" placeholder="Search or enter via address" value="${esc(value.formatted_address||"")}"><input class="via-postcode" placeholder="Postcode (optional)" value="${esc(value.postcode||"")}"><button type="button" class="secondary-btn via-remove">Remove</button>`;
    row.querySelector(".via-remove").onclick=()=>{
        row.remove();
        relabelPublicViaStops();
        resetPrice();
        scheduleLiveRoute(150);
    };
    container.appendChild(row);
    relabelPublicViaStops();
    if(window.google?.maps?.places) setupViaAutocomplete(row);
}


function setupViaAutocomplete(row){
    if(row.dataset.autocompleteBound==="true") return;
    row.dataset.autocompleteBound="true";
    const input=row.querySelector(".via-address");
    const autocomplete=new google.maps.places.Autocomplete(input,{componentRestrictions:{country:"gb"},fields:["formatted_address","geometry","name","place_id","address_components"]});
    autocomplete.addListener("place_changed",()=>{const place=autocomplete.getPlace();if(!place?.geometry?.location)return;input.value=place.formatted_address||place.name||"";input.dataset.lat=place.geometry.location.lat();input.dataset.lng=place.geometry.location.lng();input.dataset.placeId=place.place_id||"";const postcode=(place.address_components||[]).find(c=>c.types.includes("postal_code"))?.long_name||"";if(postcode)row.querySelector(".via-postcode").value=postcode;resetPrice();scheduleLiveRoute(150);});
}


function relabelPublicViaStops(){
    document.querySelectorAll("#publicViaStops .via-stop-row").forEach((row,index)=>{
        const label=row.querySelector("label");
        if(label) label.textContent=`Via ${index+1}`;
    });
}


function collectPublicViaStops(){
    return [...document.querySelectorAll("#publicViaStops .via-stop-row")].map((row,index)=>{const input=row.querySelector(".via-address");return{stop_order:index+1,label:"Via",address_name:row.querySelector(".via-name").value.trim()||null,formatted_address:input.value.trim(),postcode:row.querySelector(".via-postcode").value.trim()||null,latitude:input.dataset.lat?Number(input.dataset.lat):null,longitude:input.dataset.lng?Number(input.dataset.lng):null,place_id:input.dataset.placeId||null};}).filter(stop=>stop.formatted_address);
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
            `${savedPickup()} → ${savedDropoff()}`
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

    const cashAllowed=pricingSettings.allowcash===true || pricingSettings.enablecash===true;
    // The server rejects Card until a verified payment flow is deployed.
    const cardAllowed=false;
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
        const record={

            customer_name:
                document.getElementById("customerName").value.trim(),

            pickup_address:
                savedPickup(),

            pickup_name:document.getElementById("pickupName").value.trim()||null,
            pickup_postcode:document.getElementById("pickupPostcode").value.trim()||null,
            pickup_place_id:document.getElementById("pickupAddress").dataset.placeId||null,
            pickup_lat:document.getElementById("pickupAddress").dataset.lat?Number(document.getElementById("pickupAddress").dataset.lat):null,
            pickup_lng:document.getElementById("pickupAddress").dataset.lng?Number(document.getElementById("pickupAddress").dataset.lng):null,

            dropoff_address:
                savedDropoff(),

            dropoff_name:document.getElementById("dropoffName").value.trim()||null,
            dropoff_postcode:document.getElementById("dropoffPostcode").value.trim()||null,
            dropoff_place_id:document.getElementById("dropoffAddress").dataset.placeId||null,
            dropoff_lat:document.getElementById("dropoffAddress").dataset.lat?Number(document.getElementById("dropoffAddress").dataset.lat):null,
            dropoff_lng:document.getElementById("dropoffAddress").dataset.lng?Number(document.getElementById("dropoffAddress").dataset.lng):null,

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
        if(error||!created?.ok) throw new Error(created?.error||error?.message||"Unable to create booking");

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
