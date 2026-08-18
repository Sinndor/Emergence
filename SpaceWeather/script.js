async function resolveLocation(query) {
  if (/^\d{5}$/.test(query)) {
    const res = await fetch(`https://api.zippopotam.us/us/${query}`);
    if (!res.ok) throw new Error(`Unknown zip code: ${query}`);
    const data = await res.json();
    const place = data.places?.[0];
    if (!place) throw new Error(`Unknown zip code: ${query}`);
    return {
      lat: parseFloat(place.latitude),
      lon: parseFloat(place.longitude),
      label: `${place["place name"]}, ${place["state abbreviation"]}`,
    };
  }

  const res = await fetch(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=1&language=en&format=json`
  );
  const data = await res.json();
  const hit = data.results?.[0];
  if (!hit) throw new Error(`Couldn't find "${query}". Try a zip code instead.`);
  return {
    lat: hit.latitude,
    lon: hit.longitude,
    label: [hit.name, hit.admin1, hit.country].filter(Boolean).join(", "),
  };
}

async function getGardenData(lat, lon) {
  const params = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    daily: "precipitation_sum,et0_fao_evapotranspiration,temperature_2m_min,uv_index_max,wind_speed_10m_max",
    hourly: "soil_temperature_6cm,soil_moisture_1_to_3cm",
    past_days: "1",
    forecast_days: "2",
    temperature_unit: "fahrenheit",
    wind_speed_unit: "mph",
    precipitation_unit: "inch",
    timezone: "auto",
  });
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
  if (!res.ok) throw new Error("Weather data unavailable right now.");
  return res.json();
}

function nearestHourlyIndex(times) {
  const now = Date.now();
  let bestIdx = 0;
  let bestDiff = Infinity;
  times.forEach((t, i) => {
    const diff = Math.abs(new Date(t).getTime() - now);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIdx = i;
    }
  });
  return bestIdx;
}

function waterCategory(deficitIn) {
  if (deficitIn <= 0.05) return { tier: "good", label: "No watering needed" };
  if (deficitIn <= 0.2) return { tier: "caution", label: "Light watering helps" };
  return { tier: "action", label: "Water today" };
}

function frostCategory(lowF) {
  if (lowF <= 28) return { tier: "action", label: "Hard freeze" };
  if (lowF <= 36) return { tier: "caution", label: "Frost possible" };
  return { tier: "good", label: "No frost risk" };
}

function soilCategory(tempF) {
  if (tempF < 50) return { tier: "action", label: "Too cold to plant" };
  if (tempF < 60) return { tier: "caution", label: "Cool-season only" };
  return { tier: "good", label: "Warm enough" };
}

function windCategory(maxMph) {
  if (maxMph >= 20) return { tier: "caution", label: "Stake tender plants" };
  return { tier: "good", label: "Calm enough" };
}

function tierHue(tier) {
  return { good: 95, caution: 42, action: 14 }[tier] ?? 95;
}

function worstTier(tiers) {
  if (tiers.includes("action")) return "action";
  if (tiers.includes("caution")) return "caution";
  return "good";
}

const form = document.getElementById("query-form");
const placeInput = document.getElementById("place");
const submitBtn = document.getElementById("submit-btn");
const statusLine = document.getElementById("status-line");
const panels = document.getElementById("panels");
const verdict = document.getElementById("verdict");
const verdictList = document.getElementById("verdict-list");
const updatedAt = document.getElementById("updated-at");

function setAmbient(hue) {
  document.documentElement.style.setProperty("--current-hue", hue);
}

function setStatus(msg, isError = false) {
  statusLine.textContent = msg;
  statusLine.classList.toggle("is-error", isError);
}

function setPanel(prefix, value, unit, cat, detail) {
  document.getElementById(`${prefix}-value`).textContent = value;
  const catEl = document.getElementById(
    prefix === "sun" ? "sun-category" : `${prefix}-category`
  );
  catEl.textContent = cat.label;
  catEl.className = `panel-category tier-${cat.tier}`;
  document.getElementById(`${prefix}-detail`).textContent = detail;
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const query = placeInput.value.trim();
  if (!query) return;

  submitBtn.disabled = true;
  setStatus(`Looking up ${query}...`);

  try {
    const { lat, lon, label } = await resolveLocation(query);
    const data = await getGardenData(lat, lon);

    const yesterdayPrecip = data.daily.precipitation_sum[0] ?? 0;
    const todayEt0 = data.daily.et0_fao_evapotranspiration[1] ?? 0;
    const deficit = Math.max(0, todayEt0 - yesterdayPrecip);
    const waterCat = waterCategory(deficit);

    const tonightLow = data.daily.temperature_2m_min[2] ?? data.daily.temperature_2m_min[1];
    const frostCat = frostCategory(tonightLow);

    const hIdx = nearestHourlyIndex(data.hourly.time);
    const soilTemp = data.hourly.soil_temperature_6cm[hIdx];
    const soilMoisture = data.hourly.soil_moisture_1_to_3cm[hIdx];
    const soilCat = soilCategory(soilTemp);

    const uvMax = data.daily.uv_index_max[1];
    const windMax = data.daily.wind_speed_10m_max[1];
    const windCat = windCategory(windMax);

    setPanel(
      "water",
      deficit.toFixed(2),
      "in",
      waterCat,
      `Yesterday: ${yesterdayPrecip.toFixed(2)}in rain. Today's ET₀: ${todayEt0.toFixed(2)}in.`
    );
    setPanel(
      "frost",
      Math.round(tonightLow),
      "°F",
      frostCat,
      "Overnight low, approximate."
    );
    setPanel(
      "soil",
      Math.round(soilTemp),
      "°F",
      soilCat,
      `Moisture at 1-3cm: ${(soilMoisture ?? 0).toFixed(2)} m³/m³.`
    );
    setPanel(
      "uv",
      uvMax.toFixed(1),
      "index",
      windCat,
      `Wind gusting to ${Math.round(windMax)} mph today.`
    );

    const actions = [];
    if (waterCat.tier !== "good") {
      actions.push(`Water today — about ${deficit.toFixed(2)}in needed to keep up with evapotranspiration.`);
    }
    if (frostCat.tier === "action") {
      actions.push(`Hard freeze tonight (${Math.round(tonightLow)}°F) — bring in or cover tender plants.`);
    } else if (frostCat.tier === "caution") {
      actions.push(`Frost possible tonight (${Math.round(tonightLow)}°F) — protect anything tender.`);
    }
    if (soilCat.tier === "action") {
      actions.push(`Soil's only ${Math.round(soilTemp)}°F — hold off on warm-season planting.`);
    } else if (soilCat.tier === "caution") {
      actions.push(`Soil's ${Math.round(soilTemp)}°F — fine for cool-season crops, still cool for warm-season.`);
    }
    if (windCat.tier === "caution") {
      actions.push(`Wind gusting to ${Math.round(windMax)} mph — stake or hold off on spraying.`);
    }
    if (actions.length === 0) {
      actions.push("Conditions are steady — no action needed today.");
    }

    verdictList.innerHTML = "";
    actions.forEach((a) => {
      const li = document.createElement("li");
      li.textContent = a;
      verdictList.appendChild(li);
    });

    verdict.hidden = false;
    panels.hidden = false;
    setAmbient(tierHue(worstTier([waterCat.tier, frostCat.tier, soilCat.tier, windCat.tier])));

    setStatus(`Showing ${label}.`);
    updatedAt.textContent = `Updated ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  } catch (err) {
    setStatus(err.message || "Something went wrong.", true);
  } finally {
    submitBtn.disabled = false;
  }
});
