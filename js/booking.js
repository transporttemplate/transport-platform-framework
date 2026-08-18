const bookingdb=getSupabase();
let bookingCompany=null,airportRows=[],pricingSettings={},routeMap=null,routeRenderer=null,routeService=null,currentStep=1;
let currentRoute={miles:null,minutes:null};
let currentPrices={car:null,mpv:null,selected:null,method:null};

document.addEventListener("DOMContentLoaded",async()=>{
 bookingCompany=await loadCompanyConfig();
 if(!bookingCompany){alert("Unable to identify company.");return;}
 setDateMinimums(); bindSteps(); bindControls();
 await Promise.all([loadAirports(),loadPricingSettings()]);
 document.getElementById("bookingForm")?.addEventListener("submit",saveBooking);
});
window.addEventListener("load",async()=>{await initGoogleAutocomplete();initMap();});

async function loadAirports(){
 const {data,error}=await bookingdb.from("airports").select("*").eq("company_id",bookingCompany.id).eq("active",true).order("sort_order",{ascending:true}).order("name",{ascending:true});
 if(error){console.error(error);return;} airportRows=data||[];
 const s=document.getElementById("airportSelect"); s.innerHTML='<option value="">Select Airport</option>';
 airportRows.forEach(a=>{const o=document.createElement("option");o.value=a.name;o.textContent=a.name;s.appendChild(o);});
}
async function loadPricingSettings(){
 const {data,error}=await bookingdb.from("settings").select("*").eq("company_id",bookingCompany.id).maybeSingle();
 if(error)console.error("Pricing settings:",error); else pricingSettings=data||{};
}
function bindSteps(){
 document.querySelectorAll("[data-next]").forEach(b=>b.addEventListener("click",async()=>{
  if(!validateStep(currentStep))return;
  if(currentStep===1)await calculateRoute();
  if(currentStep===2)calculatePrices();
  const n=Number(b.dataset.next); if(n===5)buildSummary(); showStep(n);
 }));
 document.querySelectorAll("[data-back]").forEach(b=>b.addEventListener("click",()=>showStep(Number(b.dataset.back))));
}
function showStep(n){
 currentStep=n;
 document.querySelectorAll(".booking-step").forEach(s=>s.classList.toggle("active",Number(s.dataset.step)===n));
 document.querySelectorAll(".progress-step").forEach(b=>{const x=Number(b.dataset.stepButton);b.classList.toggle("active",x===n);b.classList.toggle("done",x<n);});
 window.scrollTo({top:0,behavior:"smooth"});
}
function bindControls(){
 document.querySelectorAll(".journey-choice").forEach(b=>b.addEventListener("click",()=>{
  document.querySelectorAll(".journey-choice").forEach(x=>x.classList.remove("active"));b.classList.add("active");
  document.getElementById("journeyMode").value=b.dataset.mode;updateMode();resetPrice();
 }));
 document.getElementById("airportDirection").addEventListener("change",()=>{updateMode();resetPrice();});
 document.getElementById("airportSelect").addEventListener("change",()=>{airportHint();resetPrice();});
 document.getElementById("returnJourney").addEventListener("change",e=>{document.getElementById("returnFields").classList.toggle("hidden",!e.target.checked);calculatePrices();});
 document.getElementById("passengers").addEventListener("input",calculatePrices);
 document.querySelectorAll(".vehicle-card").forEach(c=>c.addEventListener("click",()=>{
  if(c.classList.contains("disabled"))return;
  document.querySelectorAll(".vehicle-card").forEach(x=>x.classList.remove("active"));c.classList.add("active");
  document.getElementById("vehicleType").value=c.dataset.vehicle;selectPrice();
 }));
 updateMode();
}
function updateMode(){
 const mode=document.getElementById("journeyMode").value, dir=document.getElementById("airportDirection").value;
 document.getElementById("airportJourneyFields").classList.toggle("hidden",mode!=="airport");
 document.getElementById("flightField").classList.toggle("hidden",mode!=="airport");
 document.getElementById("pickupWrap").classList.toggle("hidden",mode==="airport"&&dir==="from_airport");
 document.getElementById("dropoffWrap").classList.toggle("hidden",mode==="airport"&&dir==="to_airport");
}
function validateStep(s){
 if(s===1){
  if(!document.getElementById("journeyDate").value||!document.getElementById("journeyTime").value){alert("Please enter date and time.");return false;}
  const mode=document.getElementById("journeyMode").value;
  if(mode==="airport"){
   if(!document.getElementById("airportSelect").value){alert("Please select an airport.");return false;}
   const d=document.getElementById("airportDirection").value;
   if(d==="to_airport"&&!document.getElementById("pickupAddress").value.trim()){alert("Please select pickup address.");return false;}
   if(d==="from_airport"&&!document.getElementById("dropoffAddress").value.trim()){alert("Please select destination.");return false;}
  }else if(!document.getElementById("pickupAddress").value.trim()||!document.getElementById("dropoffAddress").value.trim()){alert("Please select pickup and destination.");return false;}
  if(document.getElementById("returnJourney").checked&&(!document.getElementById("returnDate").value||!document.getElementById("returnTime").value)){alert("Please enter return date and time.");return false;}
 }
 if(s===2){const p=Number(document.getElementById("passengers").value);if(p<1||p>7){alert("Passengers must be between 1 and 7.");return false;}}
 if(s===3&&!Number.isFinite(currentPrices.selected)){alert("Please select a vehicle with a valid price.");return false;}
 if(s===4&&(!document.getElementById("customerName").value.trim()||!document.getElementById("customerPhone").value.trim())){alert("Please enter name and mobile number.");return false;}
 return true;
}
function setDateMinimums(){
 const t=new Date().toISOString().slice(0,10);document.getElementById("journeyDate").min=t;document.getElementById("returnDate").min=t;
 document.getElementById("journeyDate").addEventListener("change",e=>document.getElementById("returnDate").min=e.target.value||t);
}
function airportHint(){
 const a=findAirport(),h=document.getElementById("airportPriceHint");if(!a){h.textContent="";return;}
 const p=[a.price_1_4_oneway,a.price_1_4_return,a.price_5_7_oneway,a.price_5_7_return].map(Number).filter(x=>x>0);
 h.textContent=p.length?`Prices from £${Math.min(...p).toFixed(2)}`:"Contact us for price.";
}
async function initGoogleAutocomplete(){
 try{
  const {PlaceAutocompleteElement}=await google.maps.importLibrary("places");
  setupAutocomplete(PlaceAutocompleteElement,"pickupAddress","Enter pickup address");
  setupAutocomplete(PlaceAutocompleteElement,"dropoffAddress","Enter destination");
 }catch(e){console.error("Google autocomplete:",e);}
}
function setupAutocomplete(P,id,placeholder){
 const input=document.getElementById(id);if(!input)return;const a=new P({includedRegionCodes:["gb"]});a.placeholder=placeholder;input.style.display="none";input.parentNode.insertBefore(a,input.nextSibling);
 a.addEventListener("gmp-select",async e=>{const p=e.placePrediction.toPlace();await p.fetchFields({fields:["formattedAddress","location"]});input.value=p.formattedAddress||"";input.dataset.lat=p.location?.lat()??"";input.dataset.lng=p.location?.lng()??"";resetPrice();});
}
function initMap(){
 const el=document.getElementById("routeMap");if(!el||!window.google?.maps)return;
 routeMap=new google.maps.Map(el,{center:{lat:51.445,lng:-3.235},zoom:9,mapTypeControl:false,streetViewControl:false});
 routeService=new google.maps.DirectionsService();routeRenderer=new google.maps.DirectionsRenderer({map:routeMap});
}
function endpoints(){
 const mode=document.getElementById("journeyMode").value,p=document.getElementById("pickupAddress").value.trim(),d=document.getElementById("dropoffAddress").value.trim();
 if(mode==="distance")return{origin:p,destination:d};
 const a=findAirport();if(!a)return null;const airport=`${a.name}, UK`;
 return document.getElementById("airportDirection").value==="to_airport"?{origin:p,destination:airport}:{origin:airport,destination:d};
}
async function calculateRoute(){
 const e=endpoints();if(!e?.origin||!e?.destination)return;if(!routeService)initMap();if(!routeService)return;
 const r=await new Promise(resolve=>routeService.route({origin:e.origin,destination:e.destination,travelMode:google.maps.TravelMode.DRIVING,region:"GB"},(res,status)=>resolve(status==="OK"?res:null)));
 if(!r){alert("Unable to calculate route.");return;}routeRenderer.setDirections(r);const l=r.routes[0].legs[0];
 currentRoute.miles=l.distance.value/1609.344;currentRoute.minutes=l.duration.value/60;
 document.getElementById("routeDistance").textContent=`${currentRoute.miles.toFixed(1)} miles`;
 document.getElementById("routeDuration").textContent=formatDuration(currentRoute.minutes);calculatePrices();
}
function calculatePrices(){
 const mode=document.getElementById("journeyMode").value,ret=document.getElementById("returnJourney").checked;let car=null,mpv=null;
 if(mode==="airport"){const a=findAirport();if(a){car=Number(ret?a.price_1_4_return:a.price_1_4_oneway);mpv=Number(ret?a.price_5_7_return:a.price_5_7_oneway);}currentPrices.method="Airport fixed price";document.getElementById("routePricingType").textContent="Airport fixed";}
 else{car=distanceFare(currentRoute.miles);const mult=Number(pricingSettings.mpvmultiplier??pricingSettings.mpv_multiplier??1);mpv=Number.isFinite(car)?round(car*(mult>0?mult:1)):null;currentPrices.method="Distance price";document.getElementById("routePricingType").textContent="Distance";}
 currentPrices.car=positive(car);currentPrices.mpv=positive(mpv);updateVehicleCards();selectPrice();
}
function distanceFare(m){
 if(!Number.isFinite(m)||m<=0)return null;
 const min=n(pricingSettings.minimumfare),first=n(pricingSettings.firstmile),rates=[n(pricingSettings.mileband1),n(pricingSettings.mileband2),n(pricingSettings.mileband3),n(pricingSettings.mileband4),n(pricingSettings.mileband5),n(pricingSettings.mileband6)],ends=[10,30,80,150,500,1000];
 let total=first,remaining=Math.max(0,m-1),start=1;
 for(let i=0;i<ends.length&&remaining>0;i++){const width=ends[i]-start,take=Math.min(remaining,width);total+=take*rates[i];remaining-=take;start=ends[i];}
 if(remaining>0)total+=remaining*rates[5];total+=n(pricingSettings.bookingfee);
 if(document.getElementById("returnJourney").checked){total*=2;const disc=n(pricingSettings.returndiscount);if(disc>0)total*=1-disc/100;}
 return round(Math.max(min,total));
}
function updateVehicleCards(){
 document.getElementById("carPrice").textContent=money(currentPrices.car);document.getElementById("mpvPrice").textContent=money(currentPrices.mpv);
 const p=Number(document.getElementById("passengers").value),car=document.querySelector('[data-vehicle="car"]');car.classList.toggle("disabled",p>4);
 if(p>4&&document.getElementById("vehicleType").value==="car"){document.getElementById("vehicleType").value="mpv";document.querySelectorAll(".vehicle-card").forEach(x=>x.classList.toggle("active",x.dataset.vehicle==="mpv"));}
 document.getElementById("vehiclePriceNote").textContent=(!currentPrices.car&&!currentPrices.mpv)?"A price has not been configured for this journey. Please contact us.":"Select a vehicle to continue.";
}
function selectPrice(){currentPrices.selected=document.getElementById("vehicleType").value==="mpv"?currentPrices.mpv:currentPrices.car;document.getElementById("finalPrice").textContent=money(currentPrices.selected);}
function buildSummary(){
 const rows=[["Journey",document.getElementById("journeyMode").value==="airport"?`Airport Transfer — ${document.getElementById("airportSelect").value}`:"Standard Journey"],["Route",`${savedPickup()} → ${savedDropoff()}`],["Date & time",`${document.getElementById("journeyDate").value} ${document.getElementById("journeyTime").value}`],["Passengers",document.getElementById("passengers").value],["Vehicle",document.getElementById("vehicleType").value==="mpv"?"MPV":"Car"],["Distance",Number.isFinite(currentRoute.miles)?`${currentRoute.miles.toFixed(1)} miles`:"—"],["Payment",document.getElementById("paymentMethod").value]];
 document.getElementById("bookingSummary").innerHTML=rows.map(r=>`<div class="review-row"><span>${esc(r[0])}</span><strong>${esc(r[1])}</strong></div>`).join("");selectPrice();
}
async function saveBooking(e){
 e.preventDefault();if(!validateStep(4)||!Number.isFinite(currentPrices.selected)){alert("Please complete the booking.");return;}
 const company=bookingCompany,phone=document.getElementById("customerPhone").value.trim(),ref=generateBookingReference();
 try{
  let customerId=null;const {data:existing,error:lookupError}=await bookingdb.from("customers").select("id").eq("company_id",company.id).eq("phone",phone).limit(1);if(lookupError)throw lookupError;
  if(existing?.length)customerId=existing[0].id;else{const {data:newCustomer,error}=await bookingdb.from("customers").insert({company_id:company.id,full_name:document.getElementById("customerName").value.trim(),email:document.getElementById("customerEmail").value.trim(),phone}).select().single();if(error)throw error;customerId=newCustomer.id;}
  const record={company_id:company.id,booking_reference:ref,customer_id:customerId,customer_name:document.getElementById("customerName").value.trim(),pickup_address:savedPickup(),dropoff_address:savedDropoff(),airport:document.getElementById("journeyMode").value==="airport"?document.getElementById("airportSelect").value:"",flight_number:document.getElementById("flightNumber").value.trim(),journey_type:document.getElementById("journeyMode").value,journey_date:document.getElementById("journeyDate").value,journey_time:document.getElementById("journeyTime").value,return_journey:document.getElementById("returnJourney").checked,return_date:document.getElementById("returnDate").value||null,return_time:document.getElementById("returnTime").value||null,phone,email:document.getElementById("customerEmail").value.trim(),passengers:Number(document.getElementById("passengers").value),suitcases:Number(document.getElementById("suitcases").value),hand_luggage:Number(document.getElementById("handLuggage").value),vehicle_type:document.getElementById("vehicleType").value,notes:document.getElementById("notes").value.trim(),payment_method:document.getElementById("paymentMethod").value,price:currentPrices.selected,route_distance_miles:Number.isFinite(currentRoute.miles)?round(currentRoute.miles):null,route_duration_minutes:Number.isFinite(currentRoute.minutes)?Math.round(currentRoute.minutes):null,pricing_method:currentPrices.method,status:"Waiting"};
  const {error}=await bookingdb.from("bookings").insert(record);if(error)throw error;alert(`Booking created successfully!\n\nReference: ${ref}`);
 }catch(err){console.error(err);alert("Unable to save booking.\n\n"+err.message);}
}
function findAirport(){const name=document.getElementById("airportSelect").value;return airportRows.find(a=>a.name===name)||null;}
function savedPickup(){if(document.getElementById("journeyMode").value==="airport"&&document.getElementById("airportDirection").value==="from_airport")return document.getElementById("airportSelect").value;return document.getElementById("pickupAddress").value.trim();}
function savedDropoff(){if(document.getElementById("journeyMode").value==="airport"&&document.getElementById("airportDirection").value==="to_airport")return document.getElementById("airportSelect").value;return document.getElementById("dropoffAddress").value.trim();}
function resetPrice(){currentRoute={miles:null,minutes:null};currentPrices={car:null,mpv:null,selected:null,method:null};["routeDistance","routeDuration"].forEach(id=>document.getElementById(id).textContent="—");document.getElementById("carPrice").textContent="£—";document.getElementById("mpvPrice").textContent="£—";}
function generateBookingReference(){const d=new Date(),y=String(d.getFullYear()).slice(-2),m=String(d.getMonth()+1).padStart(2,"0"),day=String(d.getDate()).padStart(2,"0");return`BK${y}${m}${day}-${Math.floor(1000+Math.random()*9000)}`;}
function positive(v){v=Number(v);return Number.isFinite(v)&&v>0?round(v):null;}function n(v){v=Number(v);return Number.isFinite(v)?v:0;}function round(v){return Math.round(Number(v)*100)/100;}function money(v){return Number.isFinite(v)?`£${Number(v).toFixed(2)}`:"Contact us";}
function formatDuration(m){const h=Math.floor(m/60),x=Math.round(m%60);return h?`${h} hr${x?` ${x} min`:""}`:`${x} min`;}
function esc(v){return String(v??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;");}
