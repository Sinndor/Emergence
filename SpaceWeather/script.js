// Kp index -> approximate lowest latitude the aurora becomes visible at.
// This uses the searched location's geographic latitude as a stand-in for
// magnetic latitude, which is a simplification (fine for most of the US,
// less accurate near the poles or far east/west). Good enough for a v1
// go/no-go call; a real aurora-oval overlay on a map is the natural
// next step once we add the map view.
const KP_TO_LATITUDE = {
  0: 66.5, 1: 64.5, 2: 62.4, 3: 60.4, 4: 58.3,
  5: 56.3, 6: 54.2, 7: 52.2, 8: 50.1, 9: 48.1,
};

const form = document.getElementById("query-form");
const placeInput = document.getElementById("place");
const submitBtn = document.getElementById("submit-btn");
const statusLine = document.getElementById("status-line");
const panels = document.getElementById("panels");
const verdict = document.getElementById("verdict");
const verdictText = document.getElementById("verdict-text");
const updatedAt = document.getElementById("updated-at");

function setAmbient(hue) {
  document.documentElement.style.setProperty("--current-hue", hue);
}

function setStatus(msg, isError = false) {
  statusLine.textContent = msg;
  statusLine.classList.toggle("is-error", isError);
}

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

async function getKpIndex() {
  const res = await fetch("https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json");
  if (!res.ok) throw new Error("NOAA space weather data unavailable right now.");
  const rows = await res.json();
  const header = rows[0];
  const kpIdx = header.findIndex((h) => h.toLowerCase().includes("kp"));
  const last = rows[rows.length - 1];
  return parseFloat(last[kpIdx >= 0 ? kpIdx : 1]);
}

async function getCloudCover(lat, lon) {
  const res = await fetch(
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=cloud_cover&forecast_days=2&timezone=auto`
  );
  if (!res.ok) throw new Error("Weather forecast unavailable right now.");
  const data = await res.json();
  const times = data.hourly.time;
  const clouds = data.hourly.cloud_cover;

  // "tonight" = 8pm through 4am local time, whichever falls soonest
  const tonightValues = times
    .map((t, i) => ({ hour: new Date(t).getHours(), value: clouds[i] }))
    .filter(({ hour }) => hour >= 20 || hour <= 4)
    .slice(0, 8)
    .map((x) => x.value);

  if (tonightValues.length === 0) return null;
  return Math.round(tonightValues.reduce((a, b) => a + b, 0) / tonightValues.length);
}

function kpCategory(kp) {
  if (kp < 4) return { label: "Quiet", tier: "unlikely" };
  if (kp < 5) return { label: "Unsettled", tier: "unlikely" };
  if (kp < 6) return { label: "Active", tier: "possible" };
  if (kp < 7) return { label: "Minor storm", tier: "likely" };
  return { label: "Major storm", tier: "excellent" };
}

function cloudCategory(pct) {
  if (pct <= 25) return { label: "Clear", tier: "excellent" };
  if (pct <= 50) return { label: "Partly cloudy", tier: "likely" };
  if (pct <= 75) return { label: "Mostly cloudy", tier: "possible" };
  return { label: "Overcast", tier: "unlikely" };
}

function tierHue(tier) {
  return { unlikely: 205, possible: 150, likely: 155, excellent: 130 }[tier] ?? 200;
}

function buildVerdict(kp, lat, cloudPct) {
  const thresholdLat = KP_TO_LATITUDE[Math.min(9, Math.floor(kp))] ?? 66.5;
  const geomagneticallyInRange = lat >= thresholdLat - 3; // small buffer

  if (cloudPct != null && cloudPct > 75) {
    return "Skies are too overcast to see much of anything tonight, regardless of activity.";
  }
  if (!geomagneticallyInRange) {
    return `Kp ${kp} isn't strong enough to push the aurora down to your latitude tonight -- this one's more likely visible further north.`;
  }
  if (cloudPct != null && cloudPct > 50) {
    return `Geomagnetic activity is in range for your latitude, but partial cloud cover may block the view. Worth a look if it clears.`;
  }
  return `Good conditions -- active geomagnetic activity in range for your latitude, with clear-enough skies. Worth stepping outside after dark, away from city lights.`;
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const query = placeInput.value.trim();
  if (!query) return;

  submitBtn.disabled = true;
  setStatus(`Looking up ${query}...`);

  try {
    const { lat, lon, label } = await resolveLocation(query);
    const [kp, cloudPct] = await Promise.all([getKpIndex(), getCloudCover(lat, lon)]);

    const kpCat = kpCategory(kp);
    const cloudCat = cloudCategory(cloudPct ?? 100);

    document.getElementById("kp-value").textContent = kp.toFixed(1);
    document.getElementById("kp-category").textContent = kpCat.label;
    document.getElementById("kp-category").className = `panel-category tier-${kpCat.tier}`;
    document.getElementById("kp-detail").textContent =
      "Higher Kp pushes the aurora oval further from the poles.";

    document.getElementById("cloud-value").textContent = cloudPct != null ? cloudPct : "--";
    document.getElementById("cloud-category").textContent = cloudCat.label;
    document.getElementById("cloud-category").className = `panel-category tier-${cloudCat.tier}`;
    document.getElementById("cloud-detail").textContent = "Average forecast, tonight's viewing window.";

    verdictText.textContent = buildVerdict(kp, lat, cloudPct);
    verdict.hidden = false;
    panels.hidden = false;

    const worseTier = [kpCat.tier, cloudCat.tier].includes("unlikely") ? "unlikely" : kpCat.tier;
    setAmbient(tierHue(worseTier));

    setStatus(`Showing ${label}.`);
    updatedAt.textContent = `Updated ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  } catch (err) {
    setStatus(err.message || "Something went wrong.", true);
  } finally {
    submitBtn.disabled = false;
  }
});
