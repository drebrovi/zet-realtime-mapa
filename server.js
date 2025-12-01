const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { parse: parseSync } = require("csv-parse/sync");
//const { parse } = require("csv-parse");
const GtfsRealtimeBindings = require("gtfs-realtime-bindings");

const app = express();
const PORT = process.env.PORT || 3000;

// HTTP server + WebSocket
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server, {
  cors: { origin: "*" },
});

// ZET GTFS-RT endpoint
const ZET_RT_URL = "https://www.zet.hr/gtfs-rt-protobuf";

// GTFS static TXT direktorij (unzipani fileovi)
const GTFS_TXT_DIR = path.join(__dirname, "data");
const STOP_TIMES_PATH = path.join(GTFS_TXT_DIR, "stop_times.txt");

// --- GTFS static strukture u memoriji (manje, bez stop_times) --- //
let stopsById = new Map();            // stopId -> { id, name, lat, lon }
let tripInfo = new Map();             // tripId -> { routeId, serviceId, headsign }
let calendarByService = new Map();    // serviceId -> { days:{mon..sun}, startDate, endDate }
let calendarDatesByService = new Map(); // serviceId -> [ { dateInt, exceptionType } ]

// --- Pomocne za vrijeme --- //
function timeToSeconds(str) {
  if (!str) return null;
  const parts = str.split(":").map(Number);
  if (parts.length < 2 || parts.some((x) => Number.isNaN(x))) return null;
  const [h, m, s = 0] = parts;
  return h * 3600 + m * 60 + s;
}

function secondsToTime(sec) {
  sec = Math.round(sec);
  let h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  h = h % 24;
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}`;
}

// Pomocna: odredi tip vozila iz routeId
function getVehicleType(routeId) {
  if (!routeId) return null;
  const num = parseInt(String(routeId), 10);
  if (!Number.isNaN(num) && num <= 35) return "tram";
  return "bus";
}

// --- Učitaj GTFS static podatke (bez stop_times) --- //
function loadGtfsStatic() {
  try {
    const readTxt = (name) =>
      fs.readFileSync(path.join(GTFS_TXT_DIR, name), "utf8");

    if (
      !fs.existsSync(path.join(GTFS_TXT_DIR, "stops.txt")) ||
      !fs.existsSync(path.join(GTFS_TXT_DIR, "trips.txt")) ||
      !fs.existsSync(path.join(GTFS_TXT_DIR, "calendar.txt"))
    ) {
      console.warn(
        "Nedostaju stops.txt/trips.txt/calendar.txt u data/ direktoriju – otpakiraj GTFS ZIP."
      );
      return;
    }

    const stopsTxt = readTxt("stops.txt");
    const tripsTxt = readTxt("trips.txt");
    const calendarTxt = readTxt("calendar.txt");
    const calendarDatesTxtPath = path.join(GTFS_TXT_DIR, "calendar_dates.txt");
    const hasCalendarDates = fs.existsSync(calendarDatesTxtPath);
    const calendarDatesTxt = hasCalendarDates
      ? readTxt("calendar_dates.txt")
      : null;

    // trips.txt -> tripInfo
    const tripsRecords = parseSync(tripsTxt, {
      columns: true,
      skip_empty_lines: true,
    });
    tripInfo = new Map();
    for (const r of tripsRecords) {
      tripInfo.set(r.trip_id, {
        routeId: r.route_id,
        serviceId: r.service_id,
        headsign: r.trip_headsign || "",
      });
    }

    // calendar.txt -> osnovni kalendar
    const calRecords = parseSync(calendarTxt, {
      columns: true,
      skip_empty_lines: true,
    });
    calendarByService = new Map();
    for (const r of calRecords) {
      const serviceId = r.service_id;
      const startDate = Number(r.start_date); // YYYYMMDD
      const endDate = Number(r.end_date);
      calendarByService.set(serviceId, {
        startDate,
        endDate,
        days: {
          monday: r.monday === "1",
          tuesday: r.tuesday === "1",
          wednesday: r.wednesday === "1",
          thursday: r.thursday === "1",
          friday: r.friday === "1",
          saturday: r.saturday === "1",
          sunday: r.sunday === "1",
        },
      });
    }

    // calendar_dates.txt -> exceptioni
    calendarDatesByService = new Map();
    if (calendarDatesTxt) {
      const cdRecords = parseSync(calendarDatesTxt, {
        columns: true,
        skip_empty_lines: true,
      });
      for (const r of cdRecords) {
        const serviceId = r.service_id;
        const dateInt = Number(r.date); // YYYYMMDD
        const exType = Number(r.exception_type); // 1=add, 2=remove
        if (!calendarDatesByService.has(serviceId)) {
          calendarDatesByService.set(serviceId, []);
        }
        calendarDatesByService.get(serviceId).push({
          dateInt,
          exceptionType: exType,
        });
      }
    }

    // stops.txt -> stopsById
    const stopsRecords = parseSync(stopsTxt, {
      columns: true,
      skip_empty_lines: true,
    });
    stopsById = new Map();
    for (const r of stopsRecords) {
      stopsById.set(r.stop_id, {
        id: r.stop_id,
        name: r.stop_name,
        lat: Number(r.stop_lat),
        lon: Number(r.stop_lon),
      });
    }

    console.log(
      `GTFS static učitan: ${stopsById.size} stanica, ${tripInfo.size} tripova, ${calendarByService.size} servisa.`
    );
  } catch (err) {
    console.error("Greška pri učitavanju GTFS static podataka:", err);
  }
}

loadGtfsStatic();

// --- Kalendar logika (full GTFS) --- //

// weekdayIndex: 0=pon,1=uto,...,6=ned
function isServiceActiveOnDate(serviceId, yyyymmdd, weekdayIndex) {
  const base = calendarByService.get(serviceId);
  let active = false;

  if (base) {
    if (yyyymmdd >= base.startDate && yyyymmdd <= base.endDate) {
      const dayNames = [
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
        "sunday",
      ];
      const dayName = dayNames[weekdayIndex];
      if (base.days[dayName]) {
        active = true;
      }
    }
  }

  const exList = calendarDatesByService.get(serviceId) || [];
  for (const ex of exList) {
    if (ex.dateInt === yyyymmdd) {
      if (ex.exceptionType === 1) active = true; // dodatni dan
      if (ex.exceptionType === 2) active = false; // ukinut dan
    }
  }

  return active;
}

// --- Express middlewares --- //
app.use(cors());
app.use(express.static("public"));

// --- GTFS-RT dohvat --- //

let lastVehiclesPayload = null;

async function fetchVehiclesFromZet() {
  const response = await fetch(ZET_RT_URL, {
    headers: { "Cache-Control": "no-cache" },
  });

  if (!response.ok) {
    throw new Error("Ne mogu dohvatiti GTFS-RT feed od ZET-a");
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const feed =
    GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(buffer);

  const vehicles = [];

  for (const entity of feed.entity) {
    if (!entity.vehicle || !entity.vehicle.position) continue;

    const v = entity.vehicle;
    const pos = v.position;

    const routeId = (v.trip && v.trip.routeId) || null;
    const type = getVehicleType(routeId);

    vehicles.push({
      id: (v.vehicle && v.vehicle.id) || entity.id || null,
      label: (v.vehicle && v.vehicle.label) || null,
      routeId: routeId,
      tripId: (v.trip && v.trip.tripId) || null,
      latitude: pos.latitude,
      longitude: pos.longitude,
      bearing: pos.bearing || null,
      speed: pos.speed || null,
      timestamp: v.timestamp ? Number(v.timestamp) : null,
      type: type,
    });
  }

  const headerTs = feed.header && feed.header.timestamp;
  const updated = headerTs ? Number(headerTs) : null;

  return { updated, vehicles };
}

// periodicno azuriranje + slanje preko websockets
async function updateVehiclesLoop() {
  try {
    const payload = await fetchVehiclesFromZet();
    lastVehiclesPayload = payload;
    io.emit("vehicles", payload);
  } catch (err) {
    console.error("Greška pri updateVehiclesLoop:", err);
  } finally {
    setTimeout(updateVehiclesLoop, 10000); // svakih 10 s
  }
}
updateVehiclesLoop();

// na novi websocket client: pošalji zadnje stanje
io.on("connection", (socket) => {
  console.log("WebSocket klijent spojen");
  if (lastVehiclesPayload) {
    socket.emit("vehicles", lastVehiclesPayload);
  }
});

// fallback HTTP endpoint ako treba
app.get("/api/vehicles", async (req, res) => {
  try {
    if (!lastVehiclesPayload) {
      lastVehiclesPayload = await fetchVehiclesFromZet();
    }
    res.json(lastVehiclesPayload);
  } catch (err) {
    console.error("Greška u /api/vehicles:", err);
    res.status(500).json({ error: "Greška pri dohvaćanju vozila." });
  }
});

//
// --- HELPER: čitanje stop_times.txt ručno (linija po linija) --- //

function normalizeHeaderName(name) {
  // makni BOM ako postoji i whitespace oko imena stupca
  return name.replace(/^\uFEFF/, "").trim();
}


function readTripStopTimes(tripId) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(STOP_TIMES_PATH)) {
      return resolve(null);
    }

    const stream = fs.createReadStream(STOP_TIMES_PATH, { encoding: "utf8" });

    let buffer = "";
    let headerParsed = false;
    let colIndex = {};

    const results = [];

    stream.on("data", (chunk) => {
      buffer += chunk;
      let lines = buffer.split("\n");
      buffer = lines.pop(); // zadnja (možda nepotpuna) linija

      for (let line of lines) {
        line = line.trim();
        if (!line) continue;

		if (!headerParsed) {
		  const cols = line.split(",");
		  cols.forEach((name, idx) => {
			colIndex[normalizeHeaderName(name)] = idx;
		  });
		  headerParsed = true;
		  continue;
		}


        const cols = line.split(",");
        const id = cols[colIndex["trip_id"]];
        if (id !== tripId) continue;

        const stopId = cols[colIndex["stop_id"]];
        const seq = Number(cols[colIndex["stop_sequence"]]);
        const arrival =
          cols[colIndex["arrival_time"]] || cols[colIndex["departure_time"]];
        const depart =
          cols[colIndex["departure_time"]] || cols[colIndex["arrival_time"]];

        results.push({ stopId, stopSequence: seq, arrival, departure: depart });
      }
    });

    stream.on("end", () => {
      if (!results.length) return resolve(null);

      results.sort((a, b) => a.stopSequence - b.stopSequence);

      const stops = results.map((s) => ({
        stopId: s.stopId,
        stopName: (stopsById.get(s.stopId) || {}).name || s.stopId,
        arrival: s.arrival,
        departure: s.departure,
      }));

      const pathCoords = [];
      for (const s of results) {
        const st = stopsById.get(s.stopId);
        if (st && st.lat && st.lon) {
          pathCoords.push([st.lat, st.lon]);
        }
      }

      resolve({ stops, path: pathCoords });
    });

    stream.on("error", (err) => reject(err));
  });
}

function readDeparturesForStop(stopId, nowSec, yyyymmdd, weekdayIndex) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(STOP_TIMES_PATH)) {
      return resolve([]);
    }

    const stream = fs.createReadStream(STOP_TIMES_PATH, { encoding: "utf8" });

    let buffer = "";
    let headerParsed = false;
    let colIndex = {};

    const departures = [];

    stream.on("data", (chunk) => {
      buffer += chunk;
      let lines = buffer.split("\n");
      buffer = lines.pop();

      for (let line of lines) {
        line = line.trim();
        if (!line) continue;

		if (!headerParsed) {
		  const cols = line.split(",");
		  cols.forEach((name, idx) => {
			colIndex[normalizeHeaderName(name)] = idx;
		  });
		  headerParsed = true;
		  continue;
		}


        const cols = line.split(",");
        const sId = cols[colIndex["stop_id"]];
        if (sId !== stopId) continue;

        const tripId = cols[colIndex["trip_id"]];
        const info = tripInfo.get(tripId);
        if (!info || !info.serviceId) continue;

        if (!isServiceActiveOnDate(info.serviceId, yyyymmdd, weekdayIndex))
          continue;

        const arrival =
          cols[colIndex["arrival_time"]] || cols[colIndex["departure_time"]];
        const arrivalSec = timeToSeconds(arrival);
        if (arrivalSec == null || arrivalSec < nowSec) continue;

        departures.push({
          routeId: info.routeId,
          tripId,
          headsign: info.headsign || "",
          arrivalSec,
        });
      }
    });

    stream.on("end", () => {
      departures.sort((a, b) => a.arrivalSec - b.arrivalSec);
      resolve(departures);
    });

    stream.on("error", (err) => reject(err));
  });
}


// --- API: vozni red za trip + trasa (path) --- //
app.get("/api/timetable/:tripId", async (req, res) => {
  const tripId = req.params.tripId;

  if (!tripId) {
    return res.status(400).json({ error: "Nedostaje tripId." });
  }

  try {
    const data = await readTripStopTimes(tripId);
    if (!data) {
      return res
        .status(404)
        .json({ error: "Nije pronađen vozni red za zadani tripId." });
    }

    res.json({
      tripId,
      stops: data.stops,
      path: data.path,
    });
  } catch (err) {
    console.error("Greška u /api/timetable:", err);
    res.status(500).json({ error: "Greška pri dohvaćanju voznog reda." });
  }
});

// --- API: lista stanica --- //
app.get("/api/stops", (req, res) => {
  const stops = Array.from(stopsById.values());
  res.json({ stops });
});

// --- API: nadolazeći polasci za stanicu (full GTFS kalendar + headsign) --- //
app.get("/api/stop-departures/:stopId", async (req, res) => {
  const stopId = req.params.stopId;

  if (!stopsById.has(stopId)) {
    return res.status(404).json({ error: "Nepoznata stanica." });
  }

  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  const d = now.getDate();
  const yyyymmdd = Number(`${y}${pad(m)}${pad(d)}`);

  // weekdayIndex: 0=pon, ..., 6=ned
  const jsDay = now.getDay(); // 0=ned ... 6=sub
  const weekdayIndex = (jsDay + 6) % 7;

  const nowSec =
    now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();

  try {
    const rawDeps = await readDeparturesForStop(
      stopId,
      nowSec,
      yyyymmdd,
      weekdayIndex
    );

    const filtered = rawDeps.slice(0, 5);

    const departures = filtered.map((d) => {
      const etaMin = Math.round((d.arrivalSec - nowSec) / 60);
      return {
        routeId: d.routeId,
        tripId: d.tripId,
        headsign: d.headsign || "",
        time: secondsToTime(d.arrivalSec),
        etaMinutes: etaMin,
      };
    });

    res.json({
      stopId,
      stopName: stopsById.get(stopId).name,
      departures,
    });
  } catch (err) {
    console.error("Greška u /api/stop-departures:", err);
    res.status(500).json({ error: "Greška pri dohvaćanju polazaka." });
  }
});

// --- Start servera --- //
server.listen(PORT, () => {
  console.log(`Server radi na portu ${PORT}`);
});
