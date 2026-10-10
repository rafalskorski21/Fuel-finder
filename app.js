const API_BASE = "https://fuel-finder.rafal-skorski21.workers.dev/api/stations";
let fuel = "E10", lat = null, lon = null;
const $ = (id) => document.getElementById(id);

function fuelLabel(type) {
  return ({E5:"E5 Petrol", E10:"E10 Petrol", B7_STANDARD:"Diesel", B7_PREMIUM:"Premium Diesel", B10:"B10 Diesel", HVO:"HVO"})[type] || type;
}
function money(n) { return `£${Number(n).toFixed(2)}`; }
function escapeHtml(value) {
  return String(value ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;");
}
function getLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("Location isn't available on this device."));
    navigator.geolocation.getCurrentPosition(p => {
      lat = p.coords.latitude; lon = p.coords.longitude;
      if ($("locationText")) $("locationText").textContent = `Location found • ${lat.toFixed(3)}, ${lon.toFixed(3)}`;
      resolve({lat, lon});
    }, () => reject(new Error("Location permission was declined. Please allow location access and try again.")),
    {enableHighAccuracy:true, timeout:12000, maximumAge:300000});
  });
}
async function loadStations(routeMode = false) {
  const cards = $("cards"), results = $("results");
  if (!cards || !results) return;
  if (lat === null || lon === null) {
    try { await getLocation(); }
    catch(e) { if ($("locationText")) $("locationText").textContent = e.message; return; }
  }
  cards.innerHTML = `<article class="card"><div class="meta">Finding live fuel prices and calculating best value…</div></article>`;
  results.classList.remove("hidden");
  const params = new URLSearchParams({lat:String(lat), lon:String(lon), fuel, radiusKm:"10"});
  try {
    const response = await fetch(`${API_BASE}?${params}`);
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "Fuel price service unavailable.");
    const mpg = Math.max(1, Number($("mpg")?.value) || 45);
    const tank = Math.max(1, Number($("tank")?.value) || 50);
    const litresPerMile = 4.54609 / mpg;

    const stations = (data.stations || []).map(s => {
      const pricePpl = Number(s.pricePpl);
      if (!Number.isFinite(pricePpl) || pricePpl <= 0) return null;
      const pricePerLitre = pricePpl / 100;
      const distance = Math.max(0, Number(s.distanceMiles) || 0);
      const driveLitres = distance * litresPerMile;
      const driveCost = driveLitres * pricePerLitre;
      const fillCost = pricePerLitre * tank;
      const updatedMs = s.priceLastUpdated ? Date.parse(s.priceLastUpdated) : NaN;
      const ageHours = Number.isFinite(updatedMs) ? Math.max(0, (Date.now()-updatedMs)/3600000) : null;
      return {...s, pricePpl, pricePerLitre, distance, driveLitres, driveCost, fillCost,
        effectiveCost:fillCost+driveCost, ageHours};
    }).filter(Boolean);
    if (!stations.length) {
      cards.innerHTML = `<article class="card"><div class="meta">No ${fuelLabel(fuel)} stations found within 10 km. Try another fuel type or refresh.</div></article>`;
      return;
    }

    const cheapest = [...stations].sort((a,b)=>a.pricePpl-b.pricePpl || a.distance-b.distance)[0];
    const bestValue = [...stations].sort((a,b)=>a.effectiveCost-b.effectiveCost || a.pricePpl-b.pricePpl || a.distance-b.distance)[0];
    stations.sort((a,b)=>a.effectiveCost-b.effectiveCost || a.pricePpl-b.pricePpl || a.distance-b.distance);

    const updateText = s => {
      if (!s.priceLastUpdated) return "Price update time unavailable";
      const date = new Date(s.priceLastUpdated).toLocaleString("en-GB",{day:"numeric",month:"short",year:"numeric",hour:"2-digit",minute:"2-digit"});
      return s.ageHours !== null && s.ageHours > 24
        ? `⚠️ Price last updated ${date} (${Math.floor(s.ageHours/24)} days ago)`
        : `Updated ${date}`;
    };
    cards.innerHTML = `<article class="card"><div class="meta">Best value compares the estimated tank cost plus fuel used to reach the station. Drive cost uses the distance supplied by the price service, not a road-route calculation.</div></article>` +
      stations.map(s => {
        const isBest = bestValue.nodeId != null && s.nodeId != null ? String(s.nodeId)===String(bestValue.nodeId) : s===bestValue;
        const isCheapest = cheapest.nodeId != null && s.nodeId != null ? String(s.nodeId)===String(cheapest.nodeId) : s===cheapest;
        const address = [s.location?.addressLine1,s.location?.addressLine2,s.location?.city,s.location?.postcode]
          .filter(v=>v && typeof v==="string" && v!=="[object Object]").join(", ");
        const badges = `${isBest?'<span class="saving">BEST VALUE</span>':""}${isCheapest?'<span class="saving">LOWEST PUMP PRICE</span>':""}`;
        const destination = `${s.location?.latitude || ""},${s.location?.longitude || ""}`;
        return `<article class="card ${isBest?"best":""}">
          <div class="row"><span class="station">${isBest?"🟢 ":""}${escapeHtml(s.name||"Fuel station")}</span><span class="meta">${s.distance.toFixed(2)} mi away</span></div>
          <div class="price">£${s.pricePerLitre.toFixed(3)}<small>/L</small></div>
          <div class="meta">${fuelLabel(fuel)}${s.brand?` • ${escapeHtml(s.brand)}`:""}</div>
          ${address?`<div class="meta">${escapeHtml(address)}</div>`:""}
          <div class="meta">Estimated tank (${tank}L): ${money(s.fillCost)}</div>
          <div class="meta">Fuel to reach station: ${s.driveLitres.toFixed(2)}L • approx. ${money(s.driveCost)}</div>
          <div class="meta"><strong>Effective total: ${money(s.effectiveCost)}</strong></div>
          <div class="meta">${updateText(s)}</div>
          ${badges?`<div class="saving-row">${badges}</div>`:""}
          ${!isBest?`<div class="meta">${money(Math.max(0,s.effectiveCost-bestValue.effectiveCost))} more than the best-value option (estimate)</div>`:""}
          <button onclick="window.open('https://maps.apple.com/?daddr=${encodeURIComponent(destination)}','_blank')">Directions</button>
        </article>`;
      }).join("");
    if ($("findBtn")) $("findBtn").textContent = "Find best value";
  } catch(error) {
    cards.innerHTML = `<article class="card"><div class="meta">Couldn't load live fuel prices.</div><div class="meta">${escapeHtml(error.message||"Please try again.")}</div><button onclick="loadStations()">Try again</button></article>`;
  }
}

document.querySelectorAll(".chip").forEach(button=>button.addEventListener("click",()=>{
  document.querySelectorAll(".chip").forEach(b=>b.classList.remove("active"));
  button.classList.add("active"); fuel=button.dataset.fuel||"E10";
}));
$("findBtn")?.addEventListener("click",()=>loadStations(false));
$("locate")?.addEventListener("click",()=>getLocation().catch(e=>{if($("locationText"))$("locationText").textContent=e.message;}));
$("refresh")?.addEventListener("click",()=>loadStations(false));
$("routeBtn")?.addEventListener("click",()=>loadStations(true));
$("vehicleBtn")?.addEventListener("click",()=>$("vehiclePanel")?.classList.remove("hidden"));
$("navVehicle")?.addEventListener("click",()=>$("vehiclePanel")?.classList.remove("hidden"));
$("closeVehicle")?.addEventListener("click",()=>$("vehiclePanel")?.classList.add("hidden"));
$("lookup")?.addEventListener("click",()=>{
  const plate=$("plate")?.value.trim().toUpperCase();
  if($("vehicleResult")) $("vehicleResult").innerHTML=plate
    ? `<strong>${escapeHtml(plate)}</strong><br>Vehicle lookup isn't connected yet. You can edit MPG and tank size manually.`
    : "Enter a registration number.";
});
$("navMap")?.addEventListener("click",()=>$("results")?.scrollIntoView({behavior:"smooth"}));
