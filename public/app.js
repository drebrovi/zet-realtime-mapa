// Inicijalizacija karte
const map = L.map("map").setView([45.815, 15.9819], 12);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors",
}).addTo(map);

// UI elementi
const filterTram = document.getElementById("filter-tram");
const filterBus = document.getElementById("filter-bus");
const btnNearestStop = document.getElementById("btn-nearest-stop");
const btnToggleLines = document.getElementById("btn-toggle-lines");
const linesPanel = document.getElementById("lines-panel");
const loaderOverlay = document.getElementById("loader-overlay");
const statusBadge = document.getElementById("status-badge");
const menuToggle = document.getElementById("menu-toggle");
const menuContent = document.getElementById("menu-content");


// Stanje vozila
const markers = new Map();
const lastPositions = new Map();
const animations = new Map();
const historyPoints = new Map();
const historyDots = new Map();
let currentRoutePolyline = null;
let lastVehicles = [];

// Linije
const allLines = new Set();
const activeLines = new Set();

// Stanice
let stopGroups = [];
const groupMarkers = new Map();

// Status feeda
let lastFeedUpdated = null;
let lastStatusMode = "unknown";

// --- Haversine & smjer --- //
const toRad = (d) => (d * Math.PI) / 180;

function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dφ = toRad(lat2 - lat1);
  const dλ = toRad(lon2 - lon1);
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);

  const a =
    Math.sin(dφ / 2) ** 2 +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function computeDirection(prevLat, prevLon, lat, lon) {
  const dLat = lat - prevLat;
  const dLon = lon - prevLon;

  const avgLatRad = toRad((lat + prevLat) / 2);
  const x = dLon * Math.cos(avgLatRad);
  const y = dLat;

  if (Math.abs(x) > Math.abs(y)) {
    return x > 0 ? "right" : "left";
  } else {
    return y > 0 ? "up" : "down";
  }
}

function updateLocalDirection(id, lat, lon) {
  const prev = lastPositions.get(id);
  let dir = "up";

  if (prev) {
    const dist = distanceMeters(prev.lat, prev.lon, lat, lon);
    if (dist > 5) {
      dir = computeDirection(prev.lat, prev.lon, lat, lon);
    } else {
      dir = prev.dir || "up";
    }
  }

  lastPositions.set(id, { lat, lon, dir });
  return dir;
}

// --- Loader overlay --- //
function showLoader(text) {
  if (!loaderOverlay) return;
  loaderOverlay.classList.remove("hidden");
  const t = loaderOverlay.querySelector(".loader-text");
  if (t && text) t.textContent = text;
}

function hideLoader() {
  if (!loaderOverlay) return;
  loaderOverlay.classList.add("hidden");
}

// --- Status badge --- //
function formatTimeFromUnix(unixSeconds) {
  const d = new Date(unixSeconds * 1000);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function setStatus(mode, updatedUnix) {
  if (!statusBadge) return;

  lastStatusMode = mode;
  statusBadge.classList.remove(
    "status-ok",
    "status-stale",
    "status-offline",
    "status-unknown"
  );

  let label = "";
  switch (mode) {
    case "ok":
      label = "🟢 ZET feed: online";
      statusBadge.classList.add("status-ok");
      break;
    case "stale":
      label = "🟡 ZET feed: kasni";
      statusBadge.classList.add("status-stale");
      break;
    case "offline":
      label = "🔴 ZET feed: offline";
      statusBadge.classList.add("status-offline");
      break;
    default:
      label = "⚪ ZET feed: nepoznato";
      statusBadge.classList.add("status-unknown");
  }

  if (updatedUnix) {
    label += ` (zadnji: ${formatTimeFromUnix(updatedUnix)})`;
  }

  statusBadge.textContent = label;
}

// --- Ikona krug + trokut --- //
function makeIcon(type, line, direction) {
  const colorClass = type === "bus" ? "bus-color" : "tram-color";
  const text = line ? String(line) : "";
  const dir = direction || "up";

  let html;

  if (dir === "left") {
    html = `
      <div class="layout-row ${colorClass}">
        <div class="triangle-left"></div>
        <div class="vehicle-circle">${text}</div>
      </div>
    `;
  } else if (dir === "right") {
    html = `
      <div class="layout-row ${colorClass}">
        <div class="vehicle-circle">${text}</div>
        <div class="triangle-right"></div>
      </div>
    `;
  } else if (dir === "down") {
    html = `
      <div class="layout-column ${colorClass}">
        <div class="vehicle-circle">${text}</div>
        <div class="triangle-down"></div>
      </div>
    `;
  } else {
    html = `
      <div class="layout-column ${colorClass}">
        <div class="triangle-up"></div>
        <div class="vehicle-circle">${text}</div>
      </div>
    `;
  }

  return L.divIcon({
    className: "vehicle-icon",
    html,
    iconSize: [44, 44],
    iconAnchor: [22, 22],
  });
}

// --- Smooth animacija --- //
function animateMarker(id, marker, fromLatLng, toLatLng, duration = 800) {
  if (!fromLatLng) {
    marker.setLatLng(toLatLng);
    return;
  }

  const animId = Symbol();
  animations.set(id, animId);

  const start = performance.now();

  function frame(now) {
    if (animations.get(id) !== animId) return;

    const t = Math.min(1, (now - start) / duration);
    const lat = fromLatLng.lat + (toLatLng.lat - fromLatLng.lat) * t;
    const lng = fromLatLng.lng + (toLatLng.lng - fromLatLng.lng) * t;

    marker.setLatLng([lat, lng]);

    if (t < 1) {
      requestAnimationFrame(frame);
    }
  }

  requestAnimationFrame(frame);
}

// --- Trail s točkicama --- //
function updateHistory(id, type, lat, lon) {
  let pts = historyPoints.get(id);
  if (!pts) {
    pts = [];
    historyPoints.set(id, pts);
  }

  const last = pts[pts.length - 1];
  if (!last || distanceMeters(last[0], last[1], lat, lon) > 5) {
    pts.push([lat, lon]);
    if (pts.length > 20) pts.shift();
  }

  const oldDots = historyDots.get(id) || [];
  oldDots.forEach((c) => map.removeLayer(c));

  const color = type === "bus" ? "#007bff" : "#28a745";
  const newDots = [];

  const len = pts.length;
  pts.forEach(([pLat, pLon], index) => {
    const factor = (index + 1) / len;
    const opacity = 0.1 + factor * 0.6;

    const circle = L.circleMarker([pLat, pLon], {
      radius: 3,
      stroke: false,
      fillColor: color,
      fillOpacity: opacity,
    }).addTo(map);

    newDots.push(circle);
  });

  historyDots.set(id, newDots);
}

// --- Panel linija --- //
function renderLinesPanel() {
  if (!linesPanel) return;

  const lines = Array.from(allLines);
  if (!lines.length) {
    linesPanel.innerHTML = "<em>Nema još linija u feedu...</em>";
    return;
  }

  lines.sort((a, b) => {
    const na = Number(a);
    const nb = Number(b);
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
    return String(a).localeCompare(String(b));
  });

  linesPanel.innerHTML = "";

  lines.forEach((line) => {
    const id = `line-${line}`;

    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.id = id;
    input.value = line;
    input.checked = activeLines.has(line);

    input.addEventListener("change", () => {
      if (input.checked) activeLines.add(line);
      else activeLines.delete(line);
      handleVehicles(lastVehicles);
    });

    label.appendChild(input);
    label.appendChild(document.createTextNode(" Linija " + line));
    linesPanel.appendChild(label);
  });
}

btnToggleLines.addEventListener("click", () => {
  linesPanel.classList.toggle("open");
});

if (menuToggle && menuContent) {
  // već smo u HTML-u stavili class="menu-content collapsed"
  // ali za svaki slučaj:
  menuContent.classList.add("collapsed");

  menuToggle.addEventListener("click", () => {
    menuContent.classList.toggle("collapsed");
  });
}


// --- Klik na vozilo: vozni red + trasa --- //
function attachTimetableHandler(marker, vehicle) {
  marker.off("click");

  marker.on("click", async () => {
    if (!vehicle.tripId) {
      marker
        .bindPopup("<b>Vozni red nije dostupan (nema tripId).</b>")
        .openPopup();
      return;
    }

    marker.bindPopup("Učitavam vozni red...").openPopup();
    showLoader("Učitavam vozni red...");

    try {
      const res = await fetch(
        `/api/timetable/${encodeURIComponent(vehicle.tripId)}`
      );

      if (!res.ok) {
        const msg =
          res.status === 404
            ? "Vozni red nije pronađen za ovu vožnju."
            : "Greška pri dohvaćanju voznog reda.";
        marker.setPopupContent(msg);
        return;
      }

      const data = await res.json();
      const stops = data.stops || [];
      const path = data.path || [];

      const rows = stops
        .map(
          (s) =>
            `<tr><td>${s.stopName}</td><td>${s.arrival || s.departure}</td></tr>`
        )
        .join("");

      const html = `
        <div style="font-size:13px; max-height:250px; overflow:auto;">
          <strong>Linija:</strong> ${vehicle.routeId || "-"}
          <hr/>
          <strong>Vozni red (stanice):</strong><br/>
          <table style="border-collapse:collapse; margin-top:4px;">
            <thead>
              <tr>
                <th style="text-align:left; padding-right:8px;">Stanica</th>
                <th style="text-align:left;">Vrijeme</th>
              </tr>
            </thead>
            <tbody>
              ${rows}
            </tbody>
          </table>
        </div>
      `;

      marker.setPopupContent(html);

      if (currentRoutePolyline) {
        map.removeLayer(currentRoutePolyline);
        currentRoutePolyline = null;
      }

      if (Array.isArray(path) && path.length > 1) {
        const color = "#ff0000";
        currentRoutePolyline = L.polyline(path, {
          color,
          weight: 4,
          opacity: 0.7,
        }).addTo(map);

        map.fitBounds(currentRoutePolyline.getBounds(), {
          padding: [40, 40],
        });
      }
    } catch (err) {
      console.error(err);
      marker.setPopupContent("Greška pri učitavanju voznog reda.");
    } finally {
      hideLoader();
    }
  });
}

// --- Obrada vozila --- //
function handleVehicles(list) {
  lastVehicles = list || [];

  const showTram = filterTram.checked;
  const showBus = filterBus.checked;
  const seen = new Set();

  list.forEach((v) => {
    if (!v.latitude || !v.longitude) return;

    const id = v.id || v.tripId;
    if (!id) return;

    const type = v.type;
    if (type === "tram" && !showTram) return;
    if (type === "bus" && !showBus) return;

    const lineId = v.routeId ? String(v.routeId) : null;
    if (lineId) allLines.add(lineId);

    if (activeLines.size > 0) {
      if (!lineId || !activeLines.has(lineId)) return;
    }

    const lat = v.latitude;
    const lon = v.longitude;

    const direction = updateLocalDirection(id, lat, lon);
    const icon = makeIcon(type, v.routeId, direction);

    seen.add(id);
    const targetLatLng = L.latLng(lat, lon);
    let marker = markers.get(id);

    if (!marker) {
      marker = L.marker(targetLatLng, { icon });
      marker.addTo(map);
      markers.set(id, marker);
    } else {
      const current = marker.getLatLng();
      animateMarker(id, marker, current, targetLatLng);
      marker.setIcon(icon);
    }

    attachTimetableHandler(marker, v);
    updateHistory(id, type, lat, lon);
  });

  renderLinesPanel();

  for (const [id, marker] of markers.entries()) {
    if (!seen.has(id)) {
      map.removeLayer(marker);
      markers.delete(id);
      animations.delete(id);

      const dots = historyDots.get(id) || [];
      dots.forEach((c) => map.removeLayer(c));
      historyDots.delete(id);
      historyPoints.delete(id);
      lastPositions.delete(id);
    }
  }
}

// --- Grupiranje stanica --- //
function buildStopGroups(stopsRaw) {
  const groups = [];
  const THRESHOLD = 40;

  for (const s of stopsRaw) {
    if (!s.lat || !s.lon) continue;
    let chosenIndex = -1;

    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      if (g.name !== s.name) continue;
      const dist = distanceMeters(g.lat, g.lon, s.lat, s.lon);
      if (dist <= THRESHOLD) {
        chosenIndex = i;
        break;
      }
    }

    if (chosenIndex === -1) {
      groups.push({
        id: s.id,
        name: s.name,
        lat: s.lat,
        lon: s.lon,
        stopIds: [s.id],
      });
    } else {
      const g = groups[chosenIndex];
      g.stopIds.push(s.id);
      const n = g.stopIds.length;
      g.lat = (g.lat * (n - 1) + s.lat) / n;
      g.lon = (g.lon * (n - 1) + s.lon) / n;
    }
  }

  return groups;
}

// --- Load stops --- //
async function loadStops() {
  try {
    const res = await fetch("/api/stops");
    if (!res.ok) {
      console.error("Greška pri dohvaćanju /api/stops");
      return;
    }

    const data = await res.json();
    const stopsRaw = data.stops || [];

    stopGroups = buildStopGroups(stopsRaw);

    stopGroups.forEach((g) => {
      const marker = L.circleMarker([g.lat, g.lon], {
        radius: 4,
        color: "#444",
        fillColor: "#fff",
        fillOpacity: 0.8,
        weight: 1,
      }).addTo(map);

      marker.on("click", () => showStopDepartures(marker, g));
      groupMarkers.set(g.id, marker);
    });
  } catch (err) {
    console.error("Greška loadStops:", err);
  }
}

// --- Brža varijanta: polasci s jednog perona --- //
async function showStopDepartures(marker, group) {
  marker.bindPopup("Učitavam polaske...").openPopup();
  showLoader("Učitavam polaske...");

  try {
    const primaryStopId = group.stopIds[0];

    const res = await fetch(
      `/api/stop-departures/${encodeURIComponent(primaryStopId)}`
    );

    if (!res.ok) {
      marker.setPopupContent("Greška pri dohvaćanju polazaka.");
      return;
    }

    const r = await res.json();
    const deps = r.departures || [];

    if (!deps.length) {
      marker.setPopupContent(
        `<strong>${group.name}</strong><br/>Nema nadolazećih polazaka u bliskoj budućnosti.`
      );
      return;
    }

    deps.sort((a, b) => a.etaMinutes - b.etaMinutes);
    const top = deps.slice(0, 8);

    const rows = top
      .map(
        (d) =>
          `<tr>
             <td>${d.routeId || "-"}</td>
             <td>${d.headsign || ""}</td>
             <td>${d.time}</td>
             <td>${d.etaMinutes} min</td>
           </tr>`
      )
      .join("");

    const html = `
      <div style="font-size:13px; max-height:260px; overflow:auto;">
        <strong>${group.name}</strong>
        <div style="font-size:11px; color:#666; margin-top:2px;">
          (prikaz s jednog perona ove stanice)
        </div>
        <hr/>
        <strong>Sljedeći polasci:</strong>
        <table style="border-collapse:collapse; margin-top:4px;">
          <thead>
            <tr>
              <th style="text-align:left; padding-right:8px;">Linija</th>
              <th style="text-align:left; padding-right:8px;">Smjer</th>
              <th style="text-align:left; padding-right:8px;">Vrijeme</th>
              <th style="text-align:left;">Za</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      </div>
    `;

    marker.setPopupContent(html);
  } catch (err) {
    console.error(err);
    marker.setPopupContent("Greška pri dohvaćanju polazaka.");
  } finally {
    hideLoader();
  }
}

// --- Najbliža stanica --- //
function findNearestGroup(lat, lon) {
  if (!stopGroups.length) return null;

  let best = null;
  let bestDist = Infinity;

  stopGroups.forEach((g) => {
    const d = distanceMeters(lat, lon, g.lat, g.lon);
    if (d < bestDist) {
      bestDist = d;
      best = g;
    }
  });

  return { group: best, distance: bestDist };
}

btnNearestStop.addEventListener("click", () => {
  if (!navigator.geolocation) {
    alert("Tvoj browser ne podržava geolokaciju.");
    return;
  }

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const lat = pos.coords.latitude;
      const lon = pos.coords.longitude;

      const result = findNearestGroup(lat, lon);
      if (!result || !result.group) {
        alert("Nije pronađena nijedna stanica.");
        return;
      }

      const { group, distance } = result;
      map.setView([group.lat, group.lon], 16);

      const marker = groupMarkers.get(group.id);
      if (marker) {
        showStopDepartures(marker, group);
      }

      console.log(
        "Najbliža grupa stanica:",
        group.name,
        "udaljena cca",
        Math.round(distance),
        "m"
      );
    },
    (err) => {
      console.error(err);
      alert("Ne mogu dohvatiti lokaciju (provjeri dozvolu za lokaciju).");
    }
  );
});

// --- WebSocket --- //
const socket = io();

socket.on("connect", () => {
  console.log("WebSocket povezan");
  if (lastFeedUpdated) {
    const ageMs = Date.now() - lastFeedUpdated * 1000;
    if (ageMs < 120000) setStatus("ok", lastFeedUpdated);
    else setStatus("stale", lastFeedUpdated);
  } else {
    setStatus("unknown", null);
  }
});

socket.on("disconnect", () => {
  console.log("WebSocket odspojen");
  setStatus("offline", lastFeedUpdated);
});

socket.on("connect_error", () => {
  console.log("WebSocket greška");
  setStatus("offline", lastFeedUpdated);
});

socket.on("vehicles", (payload) => {
  const vehicles = (payload && payload.vehicles) || [];
  handleVehicles(vehicles);

  const updated = payload && payload.updated;
  if (typeof updated === "number") {
    lastFeedUpdated = updated;
    const ageMs = Date.now() - updated * 1000;
    if (ageMs < 120000) setStatus("ok", updated);
    else setStatus("stale", updated);
  } else {
    setStatus("unknown", null);
  }
});

// inicijalno
loadStops();
filterTram.addEventListener("change", () => handleVehicles(lastVehicles));
filterBus.addEventListener("change", () => handleVehicles(lastVehicles));
