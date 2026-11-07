import {
  applyDataQuery,
  clusterProperties,
  exportGeoJSON,
  mergeRecords,
  processRecords,
  recluster,
  state,
  updateClusterBiome,
  updateAoiCriticalAlarm,
  updateMapAndTelemetry,
} from "./harmonizer.js";
import {
  focusAOI,
  setMapLogger,
  setMapLayers,
  setMapOrbits,
  setMapSelectionHandler,
  setGibsDate,
  setGibsLayerMode,
  setTerrainEnabled,
  fetchIgbpLandCover,
  updateAOI,
} from "./map.js";
import {
  downloadHistoricalArchive,
  initCalendar,
  refreshActivityCalendar,
} from "./calendar.js";

const TURKEY_BOUNDS = { minLat: 35.8, maxLat: 42.1, minLon: 25.6, maxLon: 44.8 };
const FIRMS_PRODUCTS = ["MODIS_NRT", "VIIRS_SNPP_NRT", "VIIRS_NOAA20_NRT", "VIIRS_NOAA21_NRT"];
const MAX_GLOBAL_POINTS = 5000;
const CASE_STUDIES = {
  "mediterranean-2021": {
    label: "2021 Akdeniz mega yangını",
    bounds: { minLat: 35.8, maxLat: 40.2, minLon: 25.6, maxLon: 37.0 },
    startMonth: "2021-07",
    endMonth: "2021-09",
  },
  "canakkale-hatay-2023": {
    label: "2023 Çanakkale / Hatay",
    bounds: { minLat: 35.8, maxLat: 41.5, minLon: 25.6, maxLon: 37.0 },
    startMonth: "2023-07",
    endMonth: "2023-09",
  },
  "current-2026": {
    label: "2026 güncel sezon",
    bounds: TURKEY_BOUNDS,
    startMonth: "2026-01",
    endMonth: "2026-10",
  },
  "payas-sta": {
    label: "Payas / İskenderun STA kontrolü",
    bounds: { minLat: 36.55, maxLat: 36.90, minLon: 36.10, maxLon: 36.32 },
    startMonth: "2025-01",
    endMonth: "2026-10",
  },
};
const ORBIT_SATELLITES = [
  { name: "TERRA", norad: 25994, sensor: "MODIS" },
  { name: "AQUA", norad: 27424, sensor: "MODIS" },
  { name: "SUOMI-NPP", norad: 37849, sensor: "VIIRS" },
  { name: "NOAA-20", norad: 43013, sensor: "VIIRS" },
  { name: "NOAA-21", norad: 54234, sensor: "VIIRS" },
];
const NOMINATIM_ENDPOINT = "https://nominatim.openstreetmap.org/reverse";
const NEWS_RSS_PROXY = "https://api.rss2json.com/v1/api.json";
const orbitFeatures = { type: "FeatureCollection", features: [] };
const tleCache = new Map();
const TLE_CACHE_TTL_MS = 4 * 60 * 60 * 1000;
const TLE_STORAGE_KEY = "turqua-celestrak-tle-cache-v1";
const FALLBACK_TLES = {
  25994: {
    line1: "1 25994U 99068A   26310.93869816  .00000294  00000+0  68704-4 0  9996",
    line2: "2 25994  97.9279 354.6965 0003352 122.9272 313.4202 14.61190472430456",
  },
  27424: {
    line1: "1 27424U 02022A   26310.93029461  .00000629  00000+0  13468-3 0  9992",
    line2: "2 27424  98.4480 283.2154 0000971 104.9472 276.8476 14.62265510304136",
  },
  37849: {
    line1: "1 37849U 11061A   26310.93258102  .00000049  00000+0  44550-4 0  9996",
    line2: "2 37849  98.8103 250.9093 0000735 294.1881  65.9218 14.19541218778692",
  },
  43013: {
    line1: "1 43013U 17073A   26310.80557179  .00000064  00000+0  51592-4 0  9998",
    line2: "2 43013  98.7912 249.0698 0000867 136.3134 223.8111 14.19535302464701",
  },
  54234: {
    line1: "1 54234U 22150A   26310.90660153  .00000025  00000+0  32726-4 0  9990",
    line2: "2 54234  98.7192 247.3576 0002444 124.1364 236.0044 14.19557144206799",
  },
};
let nextSatellitePass = null;
let orbitRefreshTimer = null;
let orbitCountdownTimer = null;
let selectedEventRevision = 0;
let lastNominatimRequest = 0;
const locationCache = new Map();

function log(message, cls = "") {
  const badge = document.getElementById("sourceStatus");
  if (!badge) return;
  badge.textContent = String(message);
  badge.className = `source-status${cls ? ` ${cls}` : ""}`;
}

function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const parseLine = line => {
    const cells = [];
    let value = "";
    let quoted = false;
    for (let index = 0; index < line.length; index++) {
      const character = line[index];
      if (character === '"' && line[index + 1] === '"' && quoted) {
        value += '"';
        index++;
      } else if (character === '"') {
        quoted = !quoted;
      } else if (character === "," && !quoted) {
        cells.push(value.trim());
        value = "";
      } else {
        value += character;
      }
    }
    cells.push(value.trim());
    return cells;
  };
  const header = parseLine(lines[0]).map((name, index) =>
    (index === 0 ? name.replace(/^\uFEFF/, "") : name).toLowerCase()
  );
  return lines.slice(1).map(parseLine)
    .filter(cells => cells.length === header.length)
    .map(cells => Object.fromEntries(header.map((key, index) => [key, cells[index]])));
}

function readJSONRecords(data) {
  const records = Array.isArray(data) ? data : (data.features || data.points);
  if (!Array.isArray(records)) throw new Error("JSON içinde kayıt dizisi bulunamadı");
  return records;
}

async function loadLocalJSON() {
  log("Yerel /harmonized_fires.json okunuyor");
  try {
    const response = await fetch("/harmonized_fires.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const records = readJSONRecords(await response.json());
    const result = processRecords(records, "YEREL / JSON", { epsKm: currentEpsilon() });
    setGibsDateFromLatestData();
    selectLargestCluster();
    void refreshActivityCalendar({ focusLatestLocalMonth: true });
    log(`${result.validCount}/${records.length} geçerli tespit / ${result.displayedCount} gösteriliyor`,
      result.validCount === 0 ? "err" : result.validCount < records.length ? "warn" : "ok");
  } catch (error) {
    log(`Yerel veri yüklenemedi (${error.message}). API veya dosya kullanın.`, "warn");
  }
}

function currentEpsilon() {
  return Number(document.getElementById("epsSlider").value);
}

async function applyCaseStudy(id, { offerArchive = true } = {}) {
  const study = CASE_STUDIES[id];
  if (!study) return;
  const bounds = study.bounds;
  for (const [field, value] of Object.entries({
    minLat: bounds.minLat,
    maxLat: bounds.maxLat,
    minLon: bounds.minLon,
    maxLon: bounds.maxLon,
    startMonth: study.startMonth,
    endMonth: study.endMonth,
  })) {
    document.getElementById(field).value = String(value);
  }
  document.getElementById("globalMode").checked = false;
  applyDataQuery({
    bounds,
    startMonth: study.startMonth,
    endMonth: study.endMonth,
    epsKm: currentEpsilon(),
  });
  updateAOI(bounds);
  focusAOI(bounds);
  window.dispatchEvent(new CustomEvent("turqua:aoi-changed", { detail: { bounds } }));
  selectLargestCluster();
  void refreshActivityCalendar();

  const count = state.filteredPoints.length;
  const isHistoricalCase = id === "mediterranean-2021" || id === "canakkale-hatay-2023";
  if (!count && isHistoricalCase && offerArchive && window.confirm(
    `${study.label} için yerel kayıtta tespit yok. NASA FIRMS arşivinden gerçek kayıtlar indirilsin mi?`,
  )) {
    if (!document.getElementById("mapKey").value.trim()) {
      document.getElementById("settingsDialog").showModal();
      log("Arşiv indirmek için NASA FIRMS MAP_KEY girin; anahtar tarayıcı isteğinde görünür.", "warn");
      return;
    }
    log(`${study.label.toLocaleUpperCase("tr-TR")}: FIRMS arşiv kayıtları indiriliyor`, "warn");
    const records = await downloadHistoricalArchive({ includeRecords: true });
    if (records.length) mergeRecords(records, "FIRMS / TARİHSEL ARŞİV");
    await applyCaseStudy(id, { offerArchive: false });
    return;
  }
  log(count
    ? `${study.label.toLocaleUpperCase("tr-TR")}: ${count.toLocaleString("tr-TR")} yüklü tespit`
    : `${study.label.toLocaleUpperCase("tr-TR")}: seçili dönemde yüklü veri yok; FIRMS arşivini indirin`,
  count ? "ok" : "warn");
}

async function fetchProduct(product, area, key) {
  const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${key}/${product}/${area}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const text = await response.text();
  const header = text.split(/\r?\n/, 1)[0].replace(/^\uFEFF/, "").toLowerCase();
  if (!header.split(",").some(column => column.trim().replace(/^"|"$/g, "") === "latitude")) {
    throw new Error(text.slice(0, 80).trim());
  }
  return parseCSV(text);
}

async function loadLiveFIRMS(globalMode) {
  const key = document.getElementById("mapKey").value.trim();
  if (!key) {
    document.getElementById("globalMode").checked = false;
    document.getElementById("settingsDialog").showModal();
    log("CANLI VERİ İÇİN AYARLARA NASA FIRMS MAP_KEY GİRİN", "warn");
    return;
  }
  const bounds = globalMode ? null : TURKEY_BOUNDS;
  const area = globalMode ? "world/1" :
    `${bounds.minLon},${bounds.minLat},${bounds.maxLon},${bounds.maxLat}/3`;
  const modeName = globalMode ? "KÜRESEL" : "TÜRKİYE";
  const button = document.getElementById("btnLive");
  button.disabled = true;
  log(`NASA FIRMS VERİSİ ALINIYOR / ${modeName}`, "warn");
  log(`FIRMS API çağrısı başladı (${modeName})`);

  const results = await Promise.all(FIRMS_PRODUCTS.map(async product => {
    try {
      const records = await fetchProduct(product, area, key);
      log(`${product}: ${records.length} kayıt`, "ok");
      return { records: records.map(record => ({ ...record, _sensor: product })), error: null };
    } catch (error) {
      const message = `${product}: HATA - ${error.message}`;
      log(message, "err");
      return { records: [], error: message };
    }
  }));
  const records = results.flatMap(result => result.records);
  const errors = results.filter(result => result.error);
  button.disabled = false;
  if (records.length === 0) {
    log("FIRMS: kayıt alınamadı. Anahtarı ve modu kontrol edin.", "err");
    log("FIRMS HATASI / ANAHTARI VE AĞI KONTROL EDİN", "err");
    return;
  }

  const liveMonths = records.map(record => String(record.acq_date || "").match(/^(\d{4}-\d{2})-\d{2}$/)?.[1])
    .filter(Boolean)
    .sort();
  if (liveMonths.length) {
    const startMonth = liveMonths[0];
    const endMonth = liveMonths[liveMonths.length - 1];
    document.getElementById("startMonth").value = startMonth;
    document.getElementById("endMonth").value = endMonth;
    state.startMonth = startMonth;
    state.endMonth = endMonth;
  }
  document.getElementById("globalMode").checked = globalMode;
  applyDataQuery({
    bounds,
    startMonth: state.startMonth,
    endMonth: state.endMonth,
    epsKm: currentEpsilon(),
  });
  updateAOI(bounds);
  focusAOI(bounds);
  const result = processRecords(records, `FIRMS / ${modeName}`, {
    epsKm: currentEpsilon(),
    maxPoints: globalMode ? MAX_GLOBAL_POINTS : null,
  });
  setGibsDateFromLatestData();
  selectLargestCluster();
  void refreshActivityCalendar({ focusLatestLocalMonth: true });
  const notices = [];
  if (globalMode && result.validCount > MAX_GLOBAL_POINTS) {
    notices.push(`FRP değeri en yüksek ${MAX_GLOBAL_POINTS} küresel tespit gösteriliyor`);
  }
  if (errors.length) notices.push(`${errors.length} FIRMS ürünü yüklenemedi`);
  if (!result.validCount) {
    log("FIRMS yanıtları tanınan bir tespit içermiyor", "err");
  } else {
    const message = `${result.displayedCount} tespit / ${stateClusterCount()} küme işlendi`;
    log(notices.length ? `${message}; ${notices.join("; ")}` : message, notices.length ? "warn" : "ok");
  }
}

function stateClusterCount() {
  return document.getElementById("tmClusters").textContent;
}

function setGibsDateFromLatestData() {
  const latestDate = state.allPoints.reduce(
    (latest, point) => point.acq_date > latest ? point.acq_date : latest,
    "",
  );
  if (latestDate) setGibsDate(latestDate);
}

function renderFireIntelligence(intelligence) {
  const list = document.getElementById("probabilityList");
  list.replaceChildren();
  const rankedScores = intelligence?.rankedScores || [];
  const primary = rankedScores[0];
  document.getElementById("intelligenceLead").textContent = primary
    ? `${primary.relativeScore}/100 · ${primary.label}`
    : "Sınıflandırma verisi yok";
  for (const item of rankedScores) {
    const row = document.createElement("div");
    row.className = "probability-row";
    row.dataset.category = item.category || "unknown";
    const label = document.createElement("span");
    label.textContent = item.label;
    const value = document.createElement("b");
    value.textContent = `${item.relativeScore}/100`;
    const bar = document.createElement("progress");
    bar.max = 100;
    bar.value = item.relativeScore;
    bar.setAttribute("aria-label", `${item.label}: göreli sezgisel skor ${item.relativeScore}/100; kalibre edilmiş olasılık değildir`);
    row.append(label, value, bar);
    list.append(row);
  }
  document.getElementById("recurrenceSummary").textContent =
    intelligence?.recurrenceLabel || "Tekerrür verisi yok";
  const months = intelligence?.recurrenceMonths || [];
  document.getElementById("recurrenceMonths").textContent =
    `Mevsimsel tekerrür (yüklü kayıtlar): ${months.join(" / ")}`;
  document.getElementById("humanFactor").textContent = intelligence
    ? `${intelligence.humanFactorScore}/99 gösterge skoru (olasılık değildir)`
    : "Hesaplanamadı";
}

function renderBiome(biome) {
  document.getElementById("eventBiome").textContent = biome
    ? `${biome.label} | ${biome.source}`
    : "Arazi sınıfı belirlenemedi";
  document.getElementById("eventFuelLoad").textContent =
    biome?.fuelLoad || "Yanıcı madde tipi belirlenemedi";
}

function classifyLandType(data) {
  const type = `${data.category || ""} ${data.type || ""} ${data.addresstype || ""} ${data.name || ""} ${data.display_name || ""}`.toLowerCase();
  const address = data.address || {};
  const addressTypes = `${address.landuse || ""} ${address.natural || ""} ${address.leisure || ""} ${address.amenity || ""} ${address.industrial || ""} ${address.man_made || ""}`.toLowerCase();
  const tags = Object.values(data.extratags || {}).join(" ");
  const value = `${type} ${addressTypes} ${tags}`.toLowerCase();
  if (/industrial|port|harbou?r|dock|refinery|plant|works|quarry|mine|liman|tersane|rafineri|sanayi/.test(value)) return "LİMAN / ENDÜSTRİYEL TESİS (OSM)";
  if (/forest|wood|national_park|nature_reserve|orman|çam|koru/.test(value)) return "ORMAN ÖRTÜSÜ (OSM)";
  if (/scrub|heath|chaparral|makilik|çalılık|maki/.test(value)) return "AKDENİZ MAKİLİĞİ (OSM)";
  if (/farmland|farm|meadow|orchard|vineyard|field|tarla|çiftlik|bağ|bahçe/.test(value)) return "TARIM ARAZİSİ (OSM)";
  if (/grass|grassland|steppe|pasture|bozkır|mera|otlak/.test(value)) return "BOZKIR / MERA (OSM)";
  if (/residential|suburb|city|town|village|yerleşim|mahalle|köy|şehir/.test(value)) return "YERLEŞİM / KENTSEL ARA YÜZ (OSM)";
  return "ARAZİ SINIFI DOĞRULANAMADI";
}

function updateSelectedBiome(clusterId, context, revision) {
  if (revision !== selectedEventRevision || clusterId == null) return null;
  const cluster = updateClusterBiome(clusterId, context);
  if (!cluster) return null;
  renderBiome(cluster.biome);
  renderFireIntelligence(cluster.intelligence);
  document.getElementById("selectedRegime").textContent = cluster.regime;
  return cluster;
}

async function fetchElevation(lat, lon) {
  try {
    const zoom = 12;
    const xCount = 2 ** zoom;
    const mercatorLat = Math.max(-85.05112878, Math.min(85.05112878, lat));
    const latRad = mercatorLat * Math.PI / 180;
    const tileX = (lon + 180) / 360 * xCount;
    const tileY = (1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2 * xCount;
    const x = Math.max(0, Math.min(xCount - 1, Math.floor(tileX)));
    const y = Math.max(0, Math.min(xCount - 1, Math.floor(tileY)));
    const response = await fetch(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${zoom}/${x}/${y}.png`);
    if (!response.ok) throw new Error(`DEM HTTP ${response.status}`);
    const bitmap = await createImageBitmap(await response.blob());
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("DEM pikseli için canvas context açılamadı");
    const pixelX = Math.max(0, Math.min(255, Math.floor((tileX - x) * 256)));
    const pixelY = Math.max(0, Math.min(255, Math.floor((tileY - y) * 256)));
    context.drawImage(bitmap, pixelX, pixelY, 1, 1, 0, 0, 1, 1);
    bitmap.close();
    const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
    return (red * 256 + green + blue / 256) - 32768;
  } catch (error) {
    log(`RAKIM DEM SORGUSU BAŞARISIZ: ${error.message}`, "warn");
    return null;
  }
}

async function fetchNews(regionName, date, revision) {
  const fireQuery = `"${regionName}" (yangın OR wildfire OR fire)`;
  const eventDate = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T00:00:00Z`) : null;
  const dateQuery = eventDate && !Number.isNaN(eventDate.getTime())
    ? ` after:${new Date(eventDate.getTime() - 86400000).toISOString().slice(0, 10)} before:${new Date(eventDate.getTime() + 4 * 86400000).toISOString().slice(0, 10)}`
    : "";
  const query = `${fireQuery}${dateQuery}`;
  const searchUrl = `https://news.google.com/search?q=${encodeURIComponent(query)}&hl=tr`;
  const link = document.getElementById("newsLink");
  link.href = searchUrl;
  const summary = document.getElementById("newsSummary");
  try {
    const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=tr&gl=TR&ceid=TR:tr`;
    const response = await fetch(`${NEWS_RSS_PROXY}?rss_url=${encodeURIComponent(rssUrl)}`);
    if (!response.ok) throw new Error(`Haber RSS HTTP ${response.status}`);
    const payload = await response.json();
    if (revision !== selectedEventRevision) return;
    if (payload.status === "error") throw new Error(payload.message || "Haber RSS yanıtı hata bildirdi");
    const items = (Array.isArray(payload.items) ? payload.items : [])
      .filter(item => /yangın|alev|yanma|wildfire|wild\s*fire|fire|burn/i.test(
        `${item.title || ""} ${item.description || ""}`,
      ))
      .slice(0, 3);
    summary.textContent = items.length
      ? `Aday başlıklar (resmî doğrulama değildir): ${items.map(item => item.title).join(" | ")}`
      : "Bu tarih aralığında yangınla ilgili aday başlık bulunamadı; bu, olay/haber olmadığı anlamına gelmez.";
  } catch (error) {
    if (revision === selectedEventRevision) {
      summary.textContent = `Haber taraması başarısız (${error.message}); Google News arama bağlantısını kullanın.`;
    }
  }
}

async function resolveEventLocation(properties, revision) {
  const lat = Number(properties.lat);
  const lon = Number(properties.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
  const coordinates = `${lat.toFixed(5)},${lon.toFixed(5)}`;
  document.getElementById("eventLocation").textContent = `OSM konum sorgusu: ${coordinates}`;
  document.getElementById("eventElevation").textContent = "Rakım: DEM sorgulanıyor";
  const cached = locationCache.get(coordinates);
  let place;
  if (cached) {
    place = cached;
  } else {
    const wait = Math.max(0, 1100 - (Date.now() - lastNominatimRequest));
    if (wait) await new Promise(resolve => setTimeout(resolve, wait));
    lastNominatimRequest = Date.now();
    try {
      const url = `${NOMINATIM_ENDPOINT}?format=jsonv2&lat=${lat}&lon=${lon}&zoom=14&addressdetails=1&extratags=1&namedetails=1`;
      const response = await fetch(url, { headers: { "Accept-Language": "tr,en" } });
      if (!response.ok) throw new Error(`Nominatim HTTP ${response.status}`);
      const data = await response.json();
      const address = data.address || {};
      const locality = address.city || address.town || address.village ||
        address.municipality || address.county || address.state || "Yer adı bulunamadı";
      const stateName = address.state && address.state !== locality ? `, ${address.state}` : "";
      place = {
        regionName: `${locality}${stateName}`,
        terrain: classifyLandType(data),
        osmData: data,
      };
      locationCache.set(coordinates, place);
    } catch {
      place = {
        regionName: "Konum servisine erişilemedi",
        terrain: "ARAZİ SINIFI DOĞRULANAMADI",
        osmData: null,
      };
    }
  }
  if (revision !== selectedEventRevision) return;
  const initialBiome = updateSelectedBiome(properties.cluster_id, {
    osmData: place.osmData,
  }, revision);
  if (initialBiome) place.terrain = initialBiome.biome.label;
  const [elevation, landCover] = await Promise.all([
    fetchElevation(lat, lon),
    fetchIgbpLandCover(lat, lon).catch(error => {
      if (revision === selectedEventRevision) {
        log(`NASA GIBS IGBP örneği alınamadı: ${error.message}`, "warn");
      }
      return null;
    }),
  ]);
  if (revision !== selectedEventRevision) return;
  const refinedBiome = updateSelectedBiome(properties.cluster_id, {
    osmData: place.osmData,
    elevationM: elevation,
    igbpClass: landCover?.classCode,
  }, revision);
  if (refinedBiome) place.terrain = refinedBiome.biome.label;
  document.getElementById("eventLocation").textContent =
    `${place.regionName} | ${place.terrain} | ${coordinates}`;
  document.getElementById("eventElevation").textContent = elevation == null
    ? "Rakım: DEM değeri alınamadı"
    : `Rakım: ${Math.round(elevation).toLocaleString("tr-TR")} m (Terrarium DEM)`;
  await fetchNews(place.regionName, String(properties.acq_date || "").slice(0, 10), revision);
}

function showSelectedEvent(properties, { fromMap = false } = {}) {
  const panel = document.getElementById("selectedEvent");
  panel.hidden = false;
  document.getElementById("selectedRegime").textContent =
    properties.regime || "KARIŞIK / SINIFLANDIRILMAMIŞ";
  document.getElementById("selectedSensors").textContent =
    `${properties.modis_count ?? 0} / ${properties.viirs_count ?? 0}`;
  document.getElementById("selectedConfidence").textContent =
    properties.confidence_summary || "Kaynak confidence alanı yok";
  const bowTieExpansion = Number(properties.bow_tie_expansion);
  document.getElementById("selectedBowTie").textContent =
    Number.isFinite(bowTieExpansion) ? `${bowTieExpansion.toFixed(2)}× Nadir` : "VERİ YOK";
  const frp = Number(properties.cluster_frp);
  const deltaT = Number(properties.cluster_delta_t);
  document.getElementById("selectedThermal").textContent =
    `${Number.isFinite(frp) ? frp.toFixed(1) : "VERİ YOK"} MW / ${Number.isFinite(deltaT) ? deltaT.toFixed(1) : "VERİ YOK"} K`;
  const biomassRate = Number(properties.biomass_burn_rate_kg_s);
  const coEmission = Number(properties.co_emission_g_s);
  document.getElementById("selectedEmissions").textContent =
    `${Number.isFinite(biomassRate) ? biomassRate.toFixed(2) : "VERİ YOK"} kg/s biyokütle / ${Number.isFinite(coEmission) ? coEmission.toFixed(1) : "VERİ YOK"} g/s CO`;
  const intelligence = properties.fire_intelligence;
  renderFireIntelligence(intelligence);
  renderBiome(properties.biome || intelligence?.biome);
  const currentDate = properties.acq_date || state.clusters.find(cluster =>
    cluster.id === properties.cluster_id
  )?.members[0]?.acq_date || "";
  if (fromMap && /^\d{4}-\d{2}-\d{2}$/.test(currentDate)) {
    setGibsDate(currentDate);
  }
  document.getElementById("fieldValidation").textContent =
    `NASA FIRMS DETECTED (${currentDate || "tarih yok"}) / REPORTED: bu uygulamada resmi ihbar eşlemesi yok.`;
  document.getElementById("eventLocation").textContent = "OSM konum sorgusu bekleniyor";
  document.getElementById("eventElevation").textContent = "Rakım: DEM sorgulanıyor";
  document.getElementById("newsSummary").textContent = "Bölge haberleri sorgulanıyor";
  const revision = ++selectedEventRevision;
  void resolveEventLocation({ ...properties, acq_date: currentDate }, revision);
}

function selectLargestCluster() {
  const cluster = [...state.clusters].sort((a, b) =>
    b.members.length - a.members.length || b.harmonizedFrp - a.harmonizedFrp
  )[0];
  if (cluster) {
    showSelectedEvent(clusterProperties(cluster));
  } else {
    document.getElementById("selectedEvent").hidden = true;
    selectedEventRevision++;
  }
}

function tleEpochDate(line1) {
  const yearPart = Number(line1.slice(18, 20));
  const dayOfYear = Number(line1.slice(20, 32));
  if (!Number.isFinite(yearPart) || !Number.isFinite(dayOfYear)) return null;
  const year = yearPart < 57 ? 2000 + yearPart : 1900 + yearPart;
  return new Date(Date.UTC(year, 0, 1) + (dayOfYear - 1) * 86400000);
}

function readCachedTLE(norad) {
  try {
    const stored = JSON.parse(localStorage.getItem(TLE_STORAGE_KEY) || "{}");
    const entry = stored[norad];
    if (!entry || typeof entry.line1 !== "string" || typeof entry.line2 !== "string" ||
      !entry.line1.startsWith("1 ") || !entry.line2.startsWith("2 ") ||
      Number(entry.line1.slice(2, 7)) !== norad ||
      Number(entry.line2.slice(2, 7)) !== norad) return null;
    const epoch = tleEpochDate(entry.line1);
    if (!epoch || Number.isNaN(epoch.getTime())) return null;
    return { ...entry, epoch, source: "ÖNBELLEK TLE" };
  } catch (error) {
    log(`TLE ÖNBELLEĞİ OKUNAMADI: ${error.message}`, "warn");
    return null;
  }
}

function persistTLE(tle, norad) {
  try {
    const stored = JSON.parse(localStorage.getItem(TLE_STORAGE_KEY) || "{}");
    stored[norad] = {
      name: tle.name,
      line1: tle.line1,
      line2: tle.line2,
      fetchedAt: tle.fetchedAt,
    };
    localStorage.setItem(TLE_STORAGE_KEY, JSON.stringify(stored));
  } catch (error) {
    log(`TLE ÇEVRİMDIŞI ÖNBELLEĞE YAZILAMADI: ${error.message}`, "warn");
  }
}

async function getTLE(satelliteInfo) {
  const cached = tleCache.get(satelliteInfo.norad);
  if (cached && Date.now() - cached.fetchedAt < TLE_CACHE_TTL_MS) return cached;

  const fallback = FALLBACK_TLES[satelliteInfo.norad];
  const offlineFallback = cached || readCachedTLE(satelliteInfo.norad) || (fallback ? {
    ...fallback,
    name: satelliteInfo.name,
    epoch: tleEpochDate(fallback.line1),
    fetchedAt: Date.now(),
    source: "GÖMÜLÜ YEDEK TLE",
  } : null);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const url = `https://celestrak.org/NORAD/elements/gp.php?CATNR=${satelliteInfo.norad}&FORMAT=tle`;
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`CelesTrak HTTP ${response.status}`);
    const lines = (await response.text()).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const line1 = lines.find(line => line.startsWith("1 "));
    const line2 = lines.find(line => line.startsWith("2 "));
    if (!line1 || !line2) throw new Error("TLE yanıtı beklenen biçimde değil");
    if (Number(line1.slice(2, 7)) !== satelliteInfo.norad ||
      Number(line2.slice(2, 7)) !== satelliteInfo.norad) {
      throw new Error("TLE yanıtındaki NORAD kimliği eşleşmiyor");
    }
    const epoch = tleEpochDate(line1);
    if (!epoch || Number.isNaN(epoch.getTime())) throw new Error("TLE epoch tarihi okunamadı");
    const tle = {
      name: satelliteInfo.name,
      line1,
      line2,
      epoch,
      fetchedAt: Date.now(),
      source: "CELESTRAK",
    };
    tleCache.set(satelliteInfo.norad, tle);
    persistTLE(tle, satelliteInfo.norad);
    return tle;
  } catch (error) {
    if (offlineFallback) {
      return {
        ...offlineFallback,
        name: satelliteInfo.name,
        source: offlineFallback.source || "ÖNBELLEK TLE",
      };
    }
    throw new Error(`CelesTrak verisi alınamadı ve kullanılabilir TLE önbelleği yok: ${error.message}`);
  } finally {
    clearTimeout(timeout);
  }
}

function propagatedPosition(satelliteLibrary, satrec, date) {
  const propagated = satelliteLibrary.propagate(satrec, date);
  if (!propagated?.position) return null;
  const geodetic = satelliteLibrary.eciToGeodetic(
    propagated.position,
    satelliteLibrary.gstime(date),
  );
  const latitude = geodetic.latitude * 180 / Math.PI;
  const longitude = ((geodetic.longitude * 180 / Math.PI + 540) % 360) - 180;
  return { lat: latitude, lon: longitude };
}

function insideBounds(position, bounds) {
  return position && position.lat >= bounds.minLat && position.lat <= bounds.maxLat &&
    position.lon >= bounds.minLon && position.lon <= bounds.maxLon;
}

function orbitLine(satelliteLibrary, satrec, from, sampleCount = 61, stepMs = 120000) {
  const coordinates = [];
  for (let index = 0; index < sampleCount; index++) {
    const position = propagatedPosition(
      satelliteLibrary,
      satrec,
      new Date(from.getTime() + index * stepMs),
    );
    if (position) coordinates.push([position.lon, position.lat]);
  }
  return coordinates.length > 1 ? coordinates : null;
}

function nextAoiCrossing(satelliteLibrary, satrec, now, bounds) {
  const stepMs = 30000;
  const horizonMs = 72 * 60 * 60 * 1000;
  for (let offset = 0; offset <= horizonMs; offset += stepMs) {
    const at = new Date(now.getTime() + offset);
    if (insideBounds(propagatedPosition(satelliteLibrary, satrec, at), bounds)) return at;
  }
  return null;
}

function updatePassCountdown() {
  const badge = document.getElementById("passStatus");
  if (!nextSatellitePass) return;
  const remaining = Math.max(0, nextSatellitePass.at.getTime() - Date.now());
  const minutes = Math.ceil(remaining / 60000);
  const cachedLabel = nextSatellitePass.source === "CELESTRAK" ? "" : " · ÖNBELLEK TLE";
  badge.textContent = `SONRAKİ GEÇİŞ: ${nextSatellitePass.name} (${minutes} dk)${cachedLabel}`;
  badge.title = `Hesaplanan AOI geçişi: ${nextSatellitePass.at.toLocaleString("tr-TR")} — ${nextSatellitePass.source}; TLE tabanlı geometrik tahmin`;
}

async function refreshSatelliteTelemetry() {
  const badge = document.getElementById("passStatus");
  const satelliteLibrary = globalThis.satellite;
  if (!satelliteLibrary?.twoline2satrec) {
    badge.textContent = "UYDU GEÇİŞİ: SGP4 KÜTÜPHANESİ YÜKLENEMEDİ";
    log("UYDU TELEMETRİSİ: satellite.js kullanılamıyor", "warn");
    return;
  }

  badge.textContent = "UYDU GEÇİŞİ: TLE VERİSİ ALINIYOR";
  const bounds = state.bounds || TURKEY_BOUNDS;
  const now = new Date();
  const results = await Promise.allSettled(ORBIT_SATELLITES.map(async satelliteInfo => {
    const tle = await getTLE(satelliteInfo);
    const satrec = satelliteLibrary.twoline2satrec(tle.line1, tle.line2);
    const crossing = nextAoiCrossing(satelliteLibrary, satrec, now, bounds);
    return {
      name: satelliteInfo.name,
      tle,
      crossing,
      coordinates: orbitLine(satelliteLibrary, satrec, now),
      source: tle.source,
    };
  }));
  const satellites = results
    .filter(result => result.status === "fulfilled")
    .map(result => result.value);
  const failures = results.filter(result => result.status === "rejected");
  orbitFeatures.features = satellites
    .filter(item => item.coordinates)
    .map(item => ({
      type: "Feature",
      geometry: { type: "LineString", coordinates: item.coordinates },
      properties: {
        satellite: item.name,
        tle_source: item.source,
        tle_epoch: item.tle.epoch.toISOString(),
      },
    }));
  setMapOrbits(orbitFeatures, document.getElementById("orbitToggle").checked);

  const passes = satellites.filter(item => item.crossing).sort((a, b) =>
    a.crossing - b.crossing
  );
  nextSatellitePass = passes.length
    ? { name: passes[0].name, at: passes[0].crossing, source: passes[0].source }
    : null;
  if (nextSatellitePass) {
    updatePassCountdown();
  } else if (failures.length === ORBIT_SATELLITES.length) {
    badge.textContent = "UYDU GEÇİŞİ: TLE/ÖNBELLEK ERİŞİLEMİYOR";
  } else {
    badge.textContent = "SONRAKİ 72 SAATTE AOI GEÇİŞİ BULUNAMADI";
  }

  const staleTles = satellites.filter(item =>
    now.getTime() - item.tle.epoch.getTime() > 14 * 86400000
  );
  const warnings = [];
  if (failures.length) warnings.push(`${failures.length} uydu TLE'si alınamadı`);
  if (staleTles.length) warnings.push(`${staleTles.length} TLE 14 günden eski`);
  const cachedTles = satellites.filter(item => item.tle.source !== "CELESTRAK");
  if (cachedTles.length) warnings.push(`${cachedTles.length} yörünge önbellekteki referans TLE ile hesaplandı`);
  if (warnings.length) {
    badge.title = warnings.join("; ");
    log(`UYDU TELEMETRİSİ: ${warnings.join("; ")}`, "warn");
  }
}

function startSatelliteTelemetry() {
  void refreshSatelliteTelemetry();
  if (orbitRefreshTimer) clearInterval(orbitRefreshTimer);
  if (orbitCountdownTimer) clearInterval(orbitCountdownTimer);
  orbitRefreshTimer = setInterval(() => void refreshSatelliteTelemetry(), 15 * 60 * 1000);
  orbitCountdownTimer = setInterval(updatePassCountdown, 10000);
}

function loadFile(file) {
  const reader = new FileReader();
  reader.onload = event => {
    try {
      const isJSON = file.name.toLowerCase().endsWith(".json");
      const records = isJSON ? readJSONRecords(JSON.parse(event.target.result)) : parseCSV(event.target.result);
      const result = processRecords(records, `DOSYA: ${file.name.slice(0, 20)}`, {
        epsKm: currentEpsilon(),
      });
      setGibsDateFromLatestData();
      selectLargestCluster();
      void refreshActivityCalendar({ focusLatestLocalMonth: true });
      log(`Dosya: ${result.validCount}/${records.length} geçerli tespit`,
        result.validCount === 0 ? "err" : result.validCount < records.length ? "warn" : "ok");
    } catch (error) {
      log(`Dosya hatası: ${error.message}`, "err");
    }
  };
  reader.onerror = () => log(`Dosya okunamadı: ${file.name}`, "err");
  reader.readAsText(file);
}

function chooseLiveMode() {
  const dialog = document.getElementById("liveModeDialog");
  dialog.returnValue = "";
  dialog.showModal();
}

document.getElementById("btnLocal").addEventListener("click", loadLocalJSON);
document.getElementById("btnLive").addEventListener("click", chooseLiveMode);
document.querySelectorAll("[data-case-study]").forEach(button => {
  button.addEventListener("click", () => applyCaseStudy(button.dataset.caseStudy));
});
document.getElementById("fileInput").addEventListener("change", event => {
  const file = event.target.files?.[0];
  if (file) loadFile(file);
  event.target.value = "";
});

document.getElementById("liveModeDialog").addEventListener("click", event => {
  const button = event.target.closest("[data-live-mode]");
  if (!button) return;
  const globalMode = button.dataset.liveMode === "global";
  document.getElementById("globalMode").checked = globalMode;
  event.currentTarget.returnValue = "selected";
  document.getElementById("liveModeDialog").close();
  loadLiveFIRMS(globalMode);
});
document.getElementById("liveModeDialog").addEventListener("close", () => {
  if (document.getElementById("liveModeDialog").returnValue === "selected") return;
  if (!document.getElementById("globalMode").checked) return;
  document.getElementById("globalMode").checked = false;
});
document.getElementById("globalMode").addEventListener("change", event => {
  if (event.target.checked) {
    chooseLiveMode();
  }
});

document.getElementById("saveKey").addEventListener("click", () => {
  const key = document.getElementById("mapKey").value.trim();
  try {
    if (key) sessionStorage.setItem("turqua_firms_map_key", key);
    else sessionStorage.removeItem("turqua_firms_map_key");
    log(key ? "FIRMS ANAHTARI BU OTURUM İÇİN HAZIR" : "API ANAHTARI BOŞ", key ? "ok" : "warn");
  } catch (error) {
    log(`FIRMS ANAHTARI OTURUMDA SAKLANAMADI: ${error.message}`, "err");
  }
});
document.getElementById("settingsButton").addEventListener("click", () =>
  document.getElementById("settingsDialog").showModal()
);
document.getElementById("settingsLive").addEventListener("click", () => {
  document.getElementById("settingsDialog").close();
  chooseLiveMode();
});
document.getElementById("toggleAoi").addEventListener("click", event => {
  const panel = document.querySelector(".hud-tl");
  const expanded = panel.classList.toggle("drawer-hidden");
  event.currentTarget.setAttribute("aria-expanded", String(!expanded));
  if (!expanded && window.matchMedia("(max-width: 760px)").matches) {
    document.querySelector(".telemetry").classList.add("drawer-hidden");
    document.getElementById("toggleTelemetry").setAttribute("aria-expanded", "false");
  }
});
document.getElementById("toggleTelemetry").addEventListener("click", event => {
  const panel = document.querySelector(".telemetry");
  const expanded = panel.classList.toggle("drawer-hidden");
  event.currentTarget.setAttribute("aria-expanded", String(!expanded));
  if (!expanded && window.matchMedia("(max-width: 760px)").matches) {
    document.querySelector(".hud-tl").classList.add("drawer-hidden");
    document.getElementById("toggleAoi").setAttribute("aria-expanded", "false");
  }
});
document.getElementById("closeTelemetry").addEventListener("click", () => {
  document.querySelector(".telemetry").classList.add("drawer-hidden");
  document.getElementById("toggleTelemetry").setAttribute("aria-expanded", "false");
});
document.getElementById("openLegal").addEventListener("click", () =>
  document.getElementById("legalDialog").showModal()
);
document.getElementById("dTSlider").addEventListener("input", event => {
  document.getElementById("dTVal").textContent = `${event.target.value} K`;
  updateFilters();
});
document.getElementById("epsSlider").addEventListener("input", event => {
  const epsilon = Number(event.target.value);
  document.getElementById("epsVal").textContent = `${epsilon.toFixed(1)} km`;
  recluster(epsilon);
});
document.getElementById("epsSlider").addEventListener("change", selectLargestCluster);

function updateFilters() {
  updateMapAndTelemetry();
}

const layerControlIds = [
  "layerMODIS", "layerVIIRS", "layerClusters", "layerFootprints", "layerDensity",
  "layerLandCover", "layerTimeAge",
];
for (const id of layerControlIds) {
  document.getElementById(id).addEventListener("change", () => {
    setMapLayers({
      showMODIS: document.getElementById("layerMODIS").checked,
      showVIIRS: document.getElementById("layerVIIRS").checked,
      showClusters: document.getElementById("layerClusters").checked,
      showFootprints: document.getElementById("layerFootprints").checked,
      showDensity: document.getElementById("layerDensity").checked,
      showLandCover: document.getElementById("layerLandCover").checked,
      showTimeAge: document.getElementById("layerTimeAge").checked,
    });
  });
}

let terrainEnabled = false;
document.getElementById("terrainToggle").addEventListener("click", event => {
  terrainEnabled = !terrainEnabled;
  setTerrainEnabled(terrainEnabled);
  event.currentTarget.textContent =
    `3B ARAZİ / EĞİM: ${terrainEnabled ? "AÇIK" : "KAPALI"}`;
  if (terrainEnabled) log("3B ARAZİ ETKİN / TERRARIUM DEM", "ok");
});
document.getElementById("orbitToggle").addEventListener("change", event => {
  setMapOrbits(orbitFeatures, event.currentTarget.checked);
});
document.getElementById("exportGeoJSON").addEventListener("click", exportGeoJSON);
document.getElementById("gibsLayerMode").addEventListener("change", event => {
  setGibsLayerMode(event.currentTarget.value);
});
document.getElementById("gibsDate").addEventListener("change", event => {
  try {
    setGibsDate(event.currentTarget.value);
  } catch (error) {
    log(`GIBS TARİHİ GEÇERSİZ: ${error.message}`, "err");
  }
});
window.addEventListener("turqua:anomaly-updated", updateAoiCriticalAlarm);
window.addEventListener("turqua:aoi-changed", () => {
  selectLargestCluster();
  void refreshSatelliteTelemetry();
});
setInterval(() => {
  if (document.getElementById("layerTimeAge").checked) updateMapAndTelemetry();
}, 60 * 1000);

setMapLogger(log);
setMapSelectionHandler(showSelectedEvent);
log("TURQUA FIRE MAP ALARM / NASA FIRMS HAZIR", "ok");
try {
  document.getElementById("mapKey").value = sessionStorage.getItem("turqua_firms_map_key") || "";
} catch (error) {
  log(`FIRMS ANAHTARI OTURUMDAN OKUNAMADI: ${error.message}`, "warn");
}
initCalendar(log);
loadLocalJSON();
startSatelliteTelemetry();

const mobileDrawerQuery = window.matchMedia("(max-width: 760px)");
if (mobileDrawerQuery.matches) {
  document.querySelector(".telemetry").classList.add("drawer-hidden");
  document.getElementById("toggleTelemetry").setAttribute("aria-expanded", "false");
}
mobileDrawerQuery.addEventListener("change", event => {
  const telemetry = document.querySelector(".telemetry");
  telemetry.classList.toggle("drawer-hidden", event.matches);
  document.querySelector(".hud-tl").classList.remove("drawer-hidden");
  document.getElementById("toggleAoi").setAttribute("aria-expanded", "true");
  document.getElementById("toggleTelemetry").setAttribute("aria-expanded", String(!event.matches));
});
