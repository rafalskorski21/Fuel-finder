const API_BASE = "https://fuel-finder.rafal-skorski21.workers.dev/api/stations";

let fuel = "E10";
let lat = null;
let lon = null;

const $ = (id) => document.getElementById(id);

function fuelLabel(type) {
  return type === "E5" ? "E5 Petrol"
    : type === "E10" ? "E10 Petrol"
    : type === "B7_STANDARD" ? "Diesel"
    : type === "B7_PREMIUM" ? "Premium Diesel"
    : type;
}

function money(n) {
  return `£${Number(n).toFixed(2)}`;
}

function getLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Location isn't available on this device."));
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (p) => {
        lat = p.coords.latitude;
        lon = p.coords.longitude;
        const text = $("locationText");
        if (text) text.textContent = `Location found • ${lat.toFixed(3)}, ${lon.toFixed(3)}`;
        resolve({ lat, lon });
      },
      () => reject(new Error("Location permission was declined."))
    );
  });
}

async function loadStations(routeMode = false) {
  const cards = $("cards");
  const results = $("results");

  if (!lat || !lon) {
    try {
      await getLocation();
    } catch (e) {
      if ($("locationText")) $("locationText").textContent = e.message;
      return;
    }
  }

  cards.innerHTML = `<article class="card"><div class="meta">Finding live fuel prices near you…</div></article>`;
  results.classList.remove("hidden");

  const params = new URLSearchParams({
    lat: String(lat),
    lon: String(lon),
    fuel,
    radiusKm: "10"
  });

  try {
    const response = await fetch(`${API_BASE}?${params.toString()}`);
    const data = await response.json();

    if (!response.ok || !data.ok) {
      throw new Error(data.error || "Fuel price service unavailable.");
    }

    const mpg = Number($("mpg")?.value) || 45;
    const tank = Number($("tank")?.value) || 50;

    const litresPerMile = 4.54609 / mpg;

    const stations = (data.stations || [])
      .map((s) => {
        const pricePerLitre = Number(s.pricePpl) / 100;
        const distance = Number(s.distanceMiles) || 0;
        const driveCost = distance * litresPerMile * pricePerLitre;
        const fillCost = pricePerLitre * tank;

        return {
          ...s,
          pricePerLitre,
          distance,
          driveCost,
          fillCost,
          totalCost: fillCost + driveCost
        };
      })
      .sort((a, b) => routeMode
        ? a.totalCost - b.totalCost
        : a.pricePerLitre - b.pricePerLitre);

    if (!stations.length) {
      cards.innerHTML = `<article class="card"><div class="meta">No ${fuelLabel(fuel)} stations found within 10 km.</div></article>`;
      return;
    }

    const best = stations[0];

    cards.innerHTML = stations.map((s, i) => {
      const updated = s.priceLastUpdated
        ? new Date(s.priceLastUpdated).toLocaleString("en-GB", {
            day: "numeric",
            month: "short",
            hour: "2-digit",
            minute: "2-digit"
          })
        : "update time unavailable";

      const address = [
        s.location?.addressLine1,
        s.location?.addressLine2,
        s.location?.city,
        s.location?.postcode
      ].filter(v => v && typeof v === "string" && v !== "[object Object]").join(", ");

      const savingVsBest = Math.max(0, s.fillCost - best.fillCost);

      return `
        <article class="card ${i === 0 ? "best" : ""}">
          <div class="row">
            <span class="station">${i === 0 ? "🟢 " : ""}${escapeHtml(s.name)}</span>
            <span class="meta">${s.distance.toFixed(2)} mi</span>
          </div>

          <div class="price">£${s.pricePerLitre.toFixed(3)}<small>/L</small></div>

          <div class="meta">
            ${fuelLabel(fuel)} • ${escapeHtml(s.brand || "")}
          </div>

          ${address ? `<div class="meta">${escapeHtml(address)}</div>` : ""}

          <div class="meta">
            Full tank ≈ ${money(s.fillCost)} • Drive cost ≈ ${money(s.driveCost)}
          </div>

          <div class="meta">Updated ${updated}</div>

          ${i === 0
            ? `<div class="saving">${routeMode ? "BEST TOTAL VALUE" : "CHEAPEST NEARBY"}</div>`
            : `<div class="meta">Up to ${money(savingVsBest)} more for a full tank</div>`
          }

          <button onclick="window.open('https://maps.apple.com/?daddr=${encodeURIComponent(
            `${s.location?.latitude || ""},${s.location?.longitude || ""}`
          )}','_blank')">Directions</button>
        </article>
      `;
    }).join("");

  } catch (error) {
    cards.innerHTML = `
      <article class="card">
        <div class="meta">Couldn't load live fuel prices.</div>
        <div class="meta">${escapeHtml(error.message)}</div>
      </article>
    `;
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

document.querySelectorAll(".chip").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".chip").forEach((b) => b.classList.remove("active"));
    button.classList.add("active");
    fuel = button.dataset.fuel;
  });
});

$("findBtn")?.addEventListener("click", () => loadStations(false));
$("locate")?.addEventListener("click", () => getLocation().catch(() => {}));
$("refresh")?.addEventListener("click", () => loadStations(false));
$("routeBtn")?.addEventListener("click", () => loadStations(true));

$("vehicleBtn")?.addEventListener("click", () => $("vehiclePanel")?.classList.remove("hidden"));
$("navVehicle")?.addEventListener("click", () => $("vehiclePanel")?.classList.remove("hidden"));
$("closeVehicle")?.addEventListener("click", () => $("vehiclePanel")?.classList.add("hidden"));

$("lookup")?.addEventListener("click", () => {
  const plate = $("plate")?.value.trim().toUpperCase();
  if ($("vehicleResult")) {
    $("vehicleResult").innerHTML = plate
      ? `<strong>${escapeHtml(plate)}</strong><br>Secure DVLA vehicle lookup will be connected in the next stage.`
      : "Enter a registration number.";
  }
});

$("navMap")?.addEventListener("click", () => {
  $("results")?.scrollIntoView({ behavior: "smooth" });
});
