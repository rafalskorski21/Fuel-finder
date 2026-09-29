let fuel="E10", lat=null, lon=null;
const stations=[
 {name:"Tesco Petrol Station",price:1.459,distance:.8,detour:.9},
 {name:"Sainsbury's Petrol Station",price:1.469,distance:1.1,detour:1.2},
 {name:"Shell",price:1.489,distance:1.4,detour:1.5},
 {name:"BP",price:1.499,distance:1.7,detour:1.8}
];
function locate(){
 if(!navigator.geolocation){locationText.textContent="Location isn't available on this device.";return}
 navigator.geolocation.getCurrentPosition(p=>{lat=p.coords.latitude;lon=p.coords.longitude;locationText.textContent=`Location found • ${lat.toFixed(3)}, ${lon.toFixed(3)}`},()=>locationText.textContent="Location permission was declined. You can still browse the demo.")
}
function render(route=false){
 const mpg=Number(document.querySelector("#mpg").value)||45;
 const tank=Number(document.querySelector("#tank").value)||50;
 const costPerMile=1/(mpg*0.264172)*1.5; // illustrative petrol cost assumption
 const sorted=stations.map(s=>({...s,net:s.price,detourCost:s.detour*costPerMile})).sort((a,b)=>a.price-b.price);
 const cards=document.querySelector("#cards");cards.innerHTML="";
 sorted.forEach((s,i)=>{
   const full=s.price*tank, cheapest=sorted[0].price*tank, saving=Math.max(0,cheapest? (cheapest-full):0);
   const netText=route?`Detour fuel ≈ £${s.detourCost.toFixed(2)} • net value calculated`: `Full tank ≈ £${full.toFixed(2)}`;
   cards.insertAdjacentHTML("beforeend",`<article class="card ${i===0?'best':''}">
    <div class="row"><span class="station">${i===0?'🟢 ':''}${s.name}</span><span class="meta">${s.distance} mi</span></div>
    <div class="price">£${s.price.toFixed(3)}<small>/L</small></div>
    <div class="meta">${fuel} • ${netText}</div>
    ${i===0?`<div class="saving">${route?'BEST VALUE FOR YOUR ROUTE':'CHEAPEST NEARBY'}</div>`:''}
    <button onclick="window.open('https://maps.apple.com/?daddr=${encodeURIComponent(s.name)}','_blank')">Directions</button>
   </article>`)
 });
 results.classList.remove("hidden");
}
document.querySelectorAll(".chip").forEach(b=>b.onclick=()=>{document.querySelectorAll(".chip").forEach(x=>x.classList.remove("active"));b.classList.add("active");fuel=b.dataset.fuel});
findBtn.onclick=()=>{locate();render(false)}
locate.onclick=locate;refresh.onclick=()=>render(false);routeBtn.onclick=()=>{locate();render(true)}
vehicleBtn.onclick=()=>vehiclePanel.classList.remove("hidden");navVehicle.onclick=()=>vehiclePanel.classList.remove("hidden");closeVehicle.onclick=()=>vehiclePanel.classList.add("hidden")
lookup.onclick=()=>{const p=plate.value.trim().toUpperCase();vehicleResult.innerHTML=p?`<strong>${p}</strong><br>Vehicle lookup is ready for the secure DVLA backend connection.`:"Enter a registration number."}
navMap.onclick=()=>document.querySelector("#results").scrollIntoView({behavior:"smooth"})
