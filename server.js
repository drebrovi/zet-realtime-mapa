const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const http = require("http");
const AdmZip = require("adm-zip");
const { parse } = require("csv-parse/sync");
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

// GTFS static ZIP
const GTFS_ZIP_PATH = path.join(__dirname, "data", "zet-gtfs.zip");

// --- GTFS static strukture --- //
let tripStopTimes = new Map();   // tripId -> [ { stopId, stopSequence, arrival, departure } ]
let stopsById = new Map();       // stopId -> { id, name, lat, lon }
let stopDepartures = new Map();  // stopId -> [ { routeId, tripId, serviceId, headsign, arrivalSec } ]

let calendarByService = new Map();      // serviceId -> { days:{mon..sun}, startDate, endDate }
let calendarDatesByService = new Map(); // serviceId -> [ { dateInt, exceptionType } ] 1=add,2=remove

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

// --- Učitaj GTFS static podatke --- //
function loadGtfsStatic() {
  try {
    if (!fs.existsSync(GTFS_ZIP_PATH)) {
      console.warn("GTFS ZIP nije pronađen na:", GTFS_ZIP_PATH);
      return;
    }

    const zip = new AdmZip(GTFS_ZIP_PATH);
    const getEntryText = (name) => {
      const entry = zip.getEntry(name);
      if (!entry) return null;
      return entry.getData().toString("utf8");
    };

    const stopsTxt = getEntryText("stops.txt");
    const stopTimesTxt = getEntryText("stop_times.txt");
    const tripsTxt = getEntryText("trips.txt");
    const calendarTxt = getEntryText("calendar.txt");
    const calendarDatesTxt = getEntryText("calendar_dates.txt");

    if (!stopsTxt || !stopTimesTxt || !tripsTxt || !calendarTxt) {
      console.warn(
        "Nedostaje stops.txt ili stop_times.txt ili trips.txt ili calendar.txt u ZIP-u"
      );
      return;
    }

    // trips.txt -> tripId -> { routeId, serviceId, headsign }
    const tripsRecords = parse(tripsTxt, {
      columns: true,
      skip_empty_lines: true,
    });
    const tripInfo = new Map(); // tripId -> { routeId, serviceId, headsign }
    for (const r of tripsRecords) {
      tripInfo.set(r.trip_id, {
        routeId: r.route_id,
        serviceId: r.service_id,
        headsign: r.trip_headsign || "",
      });
    }

    // calendar.txt -> serviceId -> osnovni kalendar
    const calRecords = parse(calendarTxt, {
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
      const cdRecords = parse(calendarDatesTxt, {
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

    // stops.txt -> stopId -> (name, lat, lon)
    const stopsRecords = parse(stopsTxt, {
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

    // stop_times.txt -> tripStopTimes + stopDepartures
    const stRecords = parse(stopTimesTxt, {
      columns: true,
      skip_empty_lines: true,
    });

    tripStopTimes = new Map();
    stopDepartures = new Map();

    for (const r of stRecords) {
      const tripId = r.trip_id;
      const stopId = r.stop_id;
      const seq = Number(r.stop_sequence);
      const arrival = r.arrival_time || r.departure_time;
      const depart = r.departure_time || r.arrival_time;
      const arrivalSec = timeToSeconds(arrival);

      const info = tripInfo.get(tripId) || {};
      const routeId = info.routeId || null;
      const serviceId = info.serviceId || null;
      const headsign = info.headsign || "";

      // za vozni red po tripu
      if (!tripStopTimes.has(tripId)) tripStopTimes.set(tripId, []);
      tripStopTimes.get(tripId).push({
        stopId,
        stopSequence: seq,
        arrival,
        departure: depart,
      });

      // za nadolazeće polaske po stanici (pohranjujemo i serviceId & headsign!)
      if (arrivalSec != null && serviceId) {
        if (!stopDepartures.has(stopId)) stopDepartures.set(stopId, []);
        stopDepartures.get(stopId).push({
          routeId,
          tripId,
          serviceId,
          headsign,
          arrivalSec,
        });
      }
    }

    // sortiraj po redoslijedu
    for (const arr of tripStopTimes.values()) {
      arr.sort((a, b) => a.stopSequence - b.stopSequence);
    }
    for (const arr of stopDepartures.values()) {
      arr.sort((a, b) => a.arrivalSec - b.arrivalSec);
    }

    console.log(
      `GTFS static učitan: ${stopsById.size} stanica, ${tripStopTimes.size} tripova, ${calendarByService.size} servisa.`
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
      if (ex.exceptionType === 1) active = true;   // dodatni dan
      if (ex.exceptionType === 2) active = false;  // ukinut dan
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

// --- API: vozni red za trip + trasa (path) --- //
app.get("/api/timetable/:tripId", (req, res) => {
  const tripId = req.params.tripId;

  if (!tripId) {
    return res.status(400).json({ error: "Nedostaje tripId." });
  }

  if (!tripStopTimes || tripStopTimes.size === 0) {
    return res
      .status(503)
      .json({ error: "GTFS static podaci nisu učitani na serveru." });
  }

  const list = tripStopTimes.get(tripId);
  if (!list) {
    return res
      .status(404)
      .json({ error: "Nije pronađen vozni red za zadani tripId." });
  }

  const stops = list.map((s) => ({
    stopId: s.stopId,
    stopName: (stopsById.get(s.stopId) || {}).name || s.stopId,
    arrival: s.arrival,
    departure: s.departure,
  }));

  // trasa: niz [lat, lon] po redoslijedu stanica
  const pathCoords = [];
  for (const s of list) {
    const st = stopsById.get(s.stopId);
    if (st && st.lat && st.lon) {
      pathCoords.push([st.lat, st.lon]);
    }
  }

  res.json({ tripId, stops, path: pathCoords });
});

// --- API: lista stanica --- //
app.get("/api/stops", (req, res) => {
  const stops = Array.from(stopsById.values());
  res.json({ stops });
});

// --- API: nadolazeći polasci za stanicu (full GTFS kalendar + headsign) --- //
app.get("/api/stop-departures/:stopId", (req, res) => {
  const stopId = req.params.stopId;

  if (!stopsById.has(stopId)) {
    return res.status(404).json({ error: "Nepoznata stanica." });
  }

  const list = stopDepartures.get(stopId) || [];

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

  const filtered = list
    .filter((x) => {
      if (!x.serviceId) return false;
      if (!isServiceActiveOnDate(x.serviceId, yyyymmdd, weekdayIndex))
        return false;
      return x.arrivalSec >= nowSec;
    })
    .slice(0, 5);

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
});

// --- Start servera --- //
server.listen(PORT, () => {
  console.log(`Server radi na portu ${PORT}`);
});
