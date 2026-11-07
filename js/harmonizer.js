import { updateMapData } from "./map.js";

const EARTH_RADIUS_KM = 6371;

export const state = {
  rawRecords: [],
  allPoints: [],
  rangePoints: [],
  filteredPoints: [],
  points: [],
  clusters: [],
  sourceLabel: "IDLE",
  maxPoints: null,
  epsKm: 0.8,
  bounds: null,
  startMonth: "2000-11",
  endMonth: "2026-10",
  selectedDate: null,
  activityMetric: "count",
};

function numericField(row, names) {
  for (const name of names) {
    const value = Number.parseFloat(row[name]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function confidenceField(row) {
  const raw = String(row.confidence ?? "").trim();
  if (!raw) return null;
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric >= 0 && numeric <= 100) {
    return { raw, kind: "numeric", category: null };
  }
  const category = raw.toLowerCase();
  if (["l", "n", "h", "low", "nominal", "high"].includes(category)) {
    return { raw, kind: "categorical", category };
  }
  return null;
}

function summarizeConfidence(members) {
  const categoryLabels = { l: "low", n: "nominal", h: "high" };
  return ["MODIS", "VIIRS"].flatMap(sensor => {
    const observations = members.filter(member => member.sensor === sensor);
    if (!observations.length) return [];
    const numeric = observations.filter(member => member.confidenceKind === "numeric");
    if (numeric.length === observations.length) {
      const values = numeric.map(member => Number(member.confidenceRaw));
      const min = Math.min(...values);
      const max = Math.max(...values);
      return [`${sensor} kaynak confidence alanı: ${min}${min === max ? "" : `–${max}`} (n=${values.length})`];
    }
    const categories = new Map();
    observations.forEach(member => {
      categories.set(member.confidenceRaw, (categories.get(member.confidenceRaw) || 0) + 1);
    });
    const values = [...categories].map(([value, count]) => {
      const label = categoryLabels[value.toLowerCase()];
      return `${value}${label ? ` (${label})` : ""} ×${count}`;
    });
    return [`${sensor} kaynak confidence alanı: ${values.join(", ")}`];
  }).join("; ") || "Kaynak confidence alanı yok";
}

function unwrapRecord(record) {
  if (record?.type !== "Feature") return record;
  const properties = record.properties || {};
  const coordinates = record.geometry?.type === "Point" ? record.geometry.coordinates : null;
  return coordinates
    ? {
        ...properties,
        longitude: properties.longitude ?? coordinates[0],
        latitude: properties.latitude ?? coordinates[1],
      }
    : properties;
}

function parseUTC(dateStr, hhmm) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr) || !/^\d{4}$/.test(hhmm)) return null;
  const [year, month, day] = dateStr.split("-").map(Number);
  const hour = Number(hhmm.slice(0, 2));
  const minute = Number(hhmm.slice(2, 4));
  if (hour > 23 || minute > 59) return null;
  const timestamp = Date.UTC(year, month - 1, day, hour, minute);
  const parsedDate = new Date(timestamp);
  return parsedDate.getUTCFullYear() === year &&
    parsedDate.getUTCMonth() === month - 1 &&
    parsedDate.getUTCDate() === day
    ? timestamp
    : null;
}

function normalizeRaw(input) {
  if (!input || typeof input !== "object") return null;
  const row = unwrapRecord(input);
  const sensorName = String(row._sensor || row.sensor || row.satellite || "").toUpperCase();
  const isVIIRS = "bright_ti4" in row || sensorName.startsWith("VIIRS");
  const sensor = isVIIRS ? "VIIRS" : "MODIS";
  const lat = numericField(row, ["latitude", "lat"]);
  const lon = numericField(row, ["longitude", "lon"]);
  if (lat == null || lon == null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;

  const temp_k = numericField(row, ["temp_k", "brightness", "bright_ti4"]);
  const temp_bg_k = numericField(row, ["temp_bg_k", "bright_t31", "bright_ti5"]);
  if (temp_k == null || temp_bg_k == null) return null;

  const confidence = confidenceField(row);
  if (!confidence) return null;

  const scan_km = numericField(row, ["scan_km", "scan"]);
  const track_km = numericField(row, ["track_km", "track"]);
  if (scan_km == null || track_km == null || scan_km <= 0 || track_km <= 0) return null;

  const acq_date = row.acq_date || "";
  const acq_time = String(row.acq_time ?? "").padStart(4, "0");
  const ts = parseUTC(acq_date, acq_time);
  if (ts == null) return null;

  const daynightValue = String(row.daynight || "").toUpperCase();
  const daynight = daynightValue === "N" || daynightValue === "D" ? daynightValue : null;
  const frp = numericField(row, ["frp", "frp_mw"]);
  if (frp == null) return null;

  const delta_t = temp_k - temp_bg_k;

  return {
    lat, lon, sensor,
    satellite: row.satellite || row.sensor || row._sensor || sensor,
    temp_k, temp_bg_k, delta_t,
    confidenceRaw: confidence.raw,
    confidenceKind: confidence.kind,
    confidenceCategory: confidence.category,
    scan_km, track_km,
    acq_date, acq_time, ts, daynight, frp,
  };
}

function haversineKm(a, b) {
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLon = (b.lon - a.lon) * Math.PI / 180;
  const latA = a.lat * Math.PI / 180;
  const latB = b.lat * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(latA) * Math.cos(latB) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

function gridCell(point, cellSizeKm) {
  const latitude = point.lat * Math.PI / 180;
  const longitude = point.lon * Math.PI / 180;
  return [
    Math.floor(EARTH_RADIUS_KM * Math.cos(latitude) * Math.cos(longitude) / cellSizeKm),
    Math.floor(EARTH_RADIUS_KM * Math.cos(latitude) * Math.sin(longitude) / cellSizeKm),
    Math.floor(EARTH_RADIUS_KM * Math.sin(latitude) / cellSizeKm),
  ];
}

function findNeighbors(index, points, epsKm, epsMs, grid) {
  const [x, y, z] = gridCell(points[index], epsKm);
  const neighbors = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        const bucket = grid.get(`${x + dx},${y + dy},${z + dz}`) || [];
        for (const candidate of bucket) {
          if (candidate === index || Math.abs(points[index].ts - points[candidate].ts) > epsMs) continue;
          if (haversineKm(points[index], points[candidate]) <= epsKm) neighbors.push(candidate);
        }
      }
    }
  }
  return neighbors;
}

function stDbscan(points, epsKm, epsMs = 4 * 60 * 60 * 1000) {
  const grid = new Map();
  points.forEach((point, index) => {
    const cell = gridCell(point, epsKm).join(",");
    if (!grid.has(cell)) grid.set(cell, []);
    grid.get(cell).push(index);
  });

  const visited = new Uint8Array(points.length);
  const assigned = new Uint8Array(points.length);
  const clusters = [];
  for (let index = 0; index < points.length; index++) {
    if (visited[index]) continue;
    visited[index] = 1;
    const neighbors = findNeighbors(index, points, epsKm, epsMs, grid);
    if (neighbors.length === 0) {
      clusters.push([index]);
      assigned[index] = 1;
      continue;
    }

    const cluster = [index];
    assigned[index] = 1;
    const queue = [...neighbors];
    const queued = new Uint8Array(points.length);
    neighbors.forEach(neighbor => { queued[neighbor] = 1; });
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const neighbor = queue[cursor];
      if (!visited[neighbor]) {
        visited[neighbor] = 1;
        const adjacent = findNeighbors(neighbor, points, epsKm, epsMs, grid);
        for (const candidate of adjacent) {
          if (!queued[candidate]) {
            queued[candidate] = 1;
            queue.push(candidate);
          }
        }
      }
      if (!assigned[neighbor]) {
        assigned[neighbor] = 1;
        cluster.push(neighbor);
      }
    }
    clusters.push(cluster);
  }
  return clusters;
}

function classifyError(members) {
  const flags = [];
  const sensors = new Set(members.map(member => member.sensor));
  const totalArea = members.reduce((sum, member) => sum + member.scan_km * member.track_km, 0);
  if (sensors.size === 1 && sensors.has("VIIRS") && totalArea < 0.5) {
    flags.push({ code: "OMISSION", text: "SUB-PIXEL DETECTION (MODIS Omission Yakalandı)", cls: "warn" });
  }
  if (members.length === 1 && members[0].daynight === "D" && members[0].delta_t < 12) {
    flags.push({ code: "COMMISSION", text: "LOW THERMAL ANOMALY / GLINT RISK (Commission Uyarısı)", cls: "err" });
  }
  return flags;
}

function weightedLongitude(points, weights) {
  let sinSum = 0;
  let cosSum = 0;
  points.forEach((point, index) => {
    const radians = point.lon * Math.PI / 180;
    sinSum += Math.sin(radians) * weights[index];
    cosSum += Math.cos(radians) * weights[index];
  });
  return Math.atan2(sinSum, cosSum) * 180 / Math.PI;
}

function footprintCorners(point) {
  const halfTrackDegrees = (point.track_km / 2) / 111.32;
  const longitudeScale = 111.32 * Math.max(0.000001, Math.abs(Math.cos(point.lat * Math.PI / 180)));
  const halfScanDegrees = (point.scan_km / 2) / longitudeScale;
  return [
    [point.lon - halfScanDegrees, point.lat - halfTrackDegrees],
    [point.lon + halfScanDegrees, point.lat - halfTrackDegrees],
    [point.lon + halfScanDegrees, point.lat + halfTrackDegrees],
    [point.lon - halfScanDegrees, point.lat + halfTrackDegrees],
  ];
}

function convexHull(members) {
  const points = [...new Map(members.flatMap(footprintCorners)
    .map(point => [`${point[0]},${point[1]}`, point])).values()]
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (points.length < 3) return [];
  const cross = (origin, a, b) =>
    (a[0] - origin[0]) * (b[1] - origin[1]) -
    (a[1] - origin[1]) * (b[0] - origin[0]);
  const lower = [];
  for (const point of points) {
    while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), point) <= 0) lower.pop();
    lower.push(point);
  }
  const upper = [];
  for (let index = points.length - 1; index >= 0; index--) {
    const point = points[index];
    while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), point) <= 0) upper.pop();
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  const hull = [...lower, ...upper];
  return hull.length >= 3 ? [...hull, hull[0]] : [];
}

function hullAreaKm2(hull) {
  if (hull.length < 4) return 0;
  const referenceLatitude = hull.reduce((sum, point) => sum + point[1], 0) / hull.length;
  const longitudeScale = 111.32 * Math.cos(referenceLatitude * Math.PI / 180);
  const projected = hull.map(([longitude, latitude]) => [
    longitude * longitudeScale,
    latitude * 111.32,
  ]);
  let twiceArea = 0;
  for (let index = 0; index < projected.length - 1; index++) {
    twiceArea += projected[index][0] * projected[index + 1][1] -
      projected[index + 1][0] * projected[index][1];
  }
  return Math.abs(twiceArea) / 2;
}

function classifyRegime(members, spreadAreaKm2) {
  const totalFrp = members.reduce((sum, member) => sum + member.frp, 0);
  const maxDT = Math.max(...members.map(member => member.delta_t));
  const hasNightDetection = members.some(member => member.daynight === "N");
  const isDaytimeCluster = members.every(member => member.daynight === "D");
  const averageFrp = members.reduce((sum, member) => sum + member.frp, 0) / members.length;
  if (totalFrp >= 40 || (hasNightDetection && maxDT >= 25)) {
    return "ORMAN / DOĞAL ÖRTÜ YANGINI";
  }
  if (isDaytimeCluster && members.length >= 2 && averageFrp < 25) {
    return "TARIMSAL ANIZ / ARAZİ YAKMA";
  }
  if (members.length === 1 || (spreadAreaKm2 < 0.35 && maxDT < 18)) {
    return "ENDÜSTRİYEL / STATİK TERMAL ANOMALİ";
  }
  return "KARIŞIK / SINIFLANDIRILMAMIŞ";
}

function footprintPolygon(point) {
  const dLat = (point.track_km / 2) / 111.32;
  const cosLat = Math.max(0.000001, Math.abs(Math.cos(point.lat * Math.PI / 180)));
  const dLon = (point.scan_km / 2) / (111.32 * cosLat);
  const ring = [
    [point.lon - dLon, point.lat - dLat],
    [point.lon + dLon, point.lat - dLat],
    [point.lon + dLon, point.lat + dLat],
    [point.lon - dLon, point.lat + dLat],
    [point.lon - dLon, point.lat - dLat],
  ];
  return { type: "Feature", geometry: { type: "Polygon", coordinates: [ring] }, properties: { sensor: point.sensor } };
}

function popupPoint(point) {
  const tag = point.delta_t < 12 && point.daynight === "D"
    ? `<div class="tag err">GLINT RİSK</div>`
    : "";
  const confidenceCategoryLabel = { l: "low", n: "nominal", h: "high" }[point.confidenceCategory];
  const confidenceDisplay = confidenceCategoryLabel
    ? `${point.confidenceRaw} (${confidenceCategoryLabel})`
    : point.confidenceRaw;
  return `
    <div class="ph">${point.sensor} / ${escapeHTML(point.satellite)}</div>
    <div class="pr"><span>TEMP_K</span><b>${point.temp_k.toFixed(1)} K</b></div>
    <div class="pr"><span>TEMP_BG_K</span><b>${point.temp_bg_k.toFixed(1)} K</b></div>
    <div class="pr"><span>ΔT</span><b>${point.delta_t.toFixed(1)} K</b></div>
    <div class="pr"><span>KAYNAK CONFIDENCE</span><b>${escapeHTML(confidenceDisplay)}</b></div>
    <div class="pr"><span>SCAN×TRACK</span><b>${point.scan_km}×${point.track_km} km</b></div>
    <div class="pr"><span>DAYNIGHT</span><b>${point.daynight}</b></div>
    <div class="pr"><span>FRP</span><b>${point.frp.toFixed(1)} MW</b></div>
    ${tag}
  `;
}

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  })[char]);
}

function popupCluster(cluster) {
  const tags = cluster.flags.map(flag => `<div class="tag ${flag.cls}">${flag.text}</div>`).join("");
  const primary = cluster.intelligence.rankedScores[0];
  return `
    <div class="ph">BİRLEŞİK KÜME #${String(cluster.id).padStart(3, "0")}</div>
    <div class="pr"><span>TESPİT DESTEĞİ</span><b>${cluster.members.length} tespit / ${cluster.sources.length} sensör</b></div>
    <div class="pr"><span>SENSÖR</span><b>${cluster.sources.join(" + ")}</b></div>
    <div class="pr"><span>ÜYE</span><b>${cluster.members.length}</b></div>
    <div class="pr"><span>YANGIN REJİMİ</span><b>${escapeHTML(cluster.regime)}</b></div>
    <div class="pr"><span>GÖRELİ HEURİSTİK SKOR (OLASILIK DEĞİL)</span><b>${primary.relativeScore}/100 ${escapeHTML(primary.label)}</b></div>
    <div class="pr"><span>ARAZİ / BİTKİ</span><b>${escapeHTML(cluster.biome.label)}</b></div>
    <div class="pr"><span>MODIS / VIIRS</span><b>${cluster.sensorCounts.MODIS} / ${cluster.sensorCounts.VIIRS}</b></div>
    <div class="pr"><span>10 KM TEKERRÜR</span><b>${cluster.intelligence.recurrenceCount} kayıt</b></div>
    <div class="pr"><span>MAKS ΔT</span><b>${cluster.maxDT.toFixed(1)} K</b></div>
    <div class="pr"><span>FRP TOPLAM</span><b>${cluster.members.reduce((sum, member) => sum + member.frp, 0).toFixed(1)} MW</b></div>
    ${tags}
  `;
}

export function clusterProperties(cluster) {
  const firstObservation = cluster.members.reduce(
    (first, member) => member.ts < first.ts ? member : first,
    cluster.members[0],
  );
  const bowTieExpansion = cluster.members.reduce((sum, member) => {
    const nadirAreaKm2 = member.sensor === "MODIS" ? 1 : 0.14;
    return sum + (member.scan_km * member.track_km) / nadirAreaKm2;
  }, 0) / cluster.members.length;
  return {
    cluster_id: cluster.id,
    lat: cluster.lat,
    lon: cluster.lon,
    regime: cluster.regime,
    modis_count: cluster.sensorCounts.MODIS,
    viirs_count: cluster.sensorCounts.VIIRS,
    detection_count: cluster.members.length,
    sensor_count: cluster.sources.length,
    multi_sensor_support: cluster.sources.length > 1,
    confidence_summary: summarizeConfidence(cluster.members),
    bow_tie_expansion: bowTieExpansion,
    cluster_frp: cluster.harmonizedFrp,
    raw_cluster_frp: cluster.rawFrp,
    biomass_burn_rate_kg_s: cluster.biomassBurnRateKgS,
    co_emission_g_s: cluster.coEmissionGS,
    cluster_delta_t: cluster.meanDT,
    fire_intelligence: cluster.intelligence,
    biome: cluster.biome,
    acq_date: firstObservation.acq_date,
    acq_time: firstObservation.acq_time,
  };
}

const MONTH_LABELS = ["OCAK", "ŞUBAT", "MART", "NİSAN", "MAYIS", "HAZİRAN", "TEMMUZ", "AĞUSTOS", "EYLÜL", "EKİM", "KASIM", "ARALIK"];
const FIRE_SOURCE_LABELS = [
  "ORMAN / DOĞAL ÖRTÜ YANGINI",
  "TARIMSAL ANIZ / ARAZİ YAKMA",
  "ENDÜSTRİYEL TESİS / LİMAN / GAZ BACASI (STA)",
  "İNSAN / LİMAN OPERASYONU",
  "ATIK / TERMAL ANOMALİ",
  "BOZKIR / ÇAYIR YANGINI",
];
const FIRE_SOURCE_CATEGORIES = [
  "forest", "agriculture", "industrial", "human", "waste", "grassland",
];
const STA_REGIONS = [
  {
    name: "İskenderun / Payas / Dörtyol liman ve demir-çelik hattı",
    minLat: 36.55, maxLat: 36.90, minLon: 36.10, maxLon: 36.32,
  },
  {
    name: "Aliağa rafineri ve gemi söküm sahası",
    minLat: 38.75, maxLat: 38.88, minLon: 26.88, maxLon: 27.02,
  },
  {
    name: "İzmit / Dilovası / Tüpraş sanayi sahası",
    minLat: 40.72, maxLat: 40.82, minLon: 29.50, maxLon: 29.80,
  },
  {
    name: "Zonguldak / Ereğli ağır sanayi sahası",
    minLat: 41.15, maxLat: 41.32, minLon: 31.38, maxLon: 32.68,
  },
  {
    name: "Ceyhan / Yumurtalık terminal sahası",
    minLat: 36.75, maxLat: 36.92, minLon: 35.80, maxLon: 36.00,
  },
  { name: "Basra Körfezi petrol ve gaz havzası", minLat: 24, maxLat: 30, minLon: 48, maxLon: 57 },
  { name: "Kuzey Denizi petrol ve gaz havzası", minLat: 51, maxLat: 62, minLon: -4, maxLon: 8 },
  { name: "Meksika Körfezi petrol ve gaz havzası", minLat: 18, maxLat: 30, minLon: -98, maxLon: -80 },
  { name: "Batı Sibirya petrol ve gaz havzası", minLat: 55, maxLat: 72, minLon: 60, maxLon: 90 },
];

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function inRegion(point, region) {
  return point.lat >= region.minLat && point.lat <= region.maxLat &&
    point.lon >= region.minLon && point.lon <= region.maxLon;
}

const persistenceIndexCache = new WeakMap();

function persistentDayIndex(points, radiusKm = 1.5) {
  let cached = persistenceIndexCache.get(points);
  if (cached?.radiusKm === radiusKm) return cached.index;
  const index = new Map();
  for (const point of points) {
    const key = gridCell(point, radiusKm).join(",");
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(point);
  }
  persistenceIndexCache.set(points, { radiusKm, index });
  return index;
}

function uniqueDetectionDaysWithin(cluster, points, radiusKm, index = null) {
  const days = new Set();
  if (index) {
    const [x, y, z] = gridCell(cluster, radiusKm);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          for (const point of index.get(`${x + dx},${y + dy},${z + dz}`) || []) {
            if (haversineKm(point, cluster) <= radiusKm) days.add(point.acq_date);
          }
        }
      }
    }
    return days.size;
  }
  for (const point of points) {
    if (haversineKm(point, cluster) <= radiusKm) days.add(point.acq_date);
  }
  return days.size;
}

function biomeRecord(code, label, vegetation, fuelLoad, source, extra = {}) {
  return { code, label, vegetation, fuelLoad, source, ...extra };
}

function classifyIgbpBiome(classCode) {
  const classNames = {
    1: "İğne yapraklı herdem yeşil orman",
    2: "Geniş yapraklı herdem yeşil orman",
    3: "Yaprak döken iğne yapraklı orman",
    4: "Yaprak döken geniş yapraklı orman",
    5: "Karışık orman",
    6: "Kapalı çalılık",
    7: "Açık çalılık",
    8: "Ağaçlı savan",
    9: "Savan",
    10: "Çayır",
    11: "Kalıcı sulak alan",
    12: "Ekili tarım alanı",
    13: "Kentsel / yapılaşmış alan",
    14: "Tarım-doğal bitki örtüsü mozaiği",
    15: "Kalıcı kar ve buz",
    16: "Çıplak / seyrek bitkili arazi",
    17: "Su kütlesi",
  };
  const className = classNames[classCode];
  if (!className) return null;
  const source = "NASA GIBS / MCD12Q1 IGBP 2024";
  const extra = { igbpClass: classCode };
  if (classCode >= 1 && classCode <= 5) {
    return biomeRecord(
      "FOREST_PINE_MIXED",
      `${className} (IGBP-${String(classCode).padStart(2, "0")})`,
      className,
      "Orman alt örtüsü; yakıt miktarı saha koşullarına bağlı",
      source,
      extra,
    );
  }
  if (classCode === 6 || classCode === 7) {
    return biomeRecord(
      "SHRUBLAND_MAQUIS",
      `${className} (Akdeniz makilik; IGBP-${String(classCode).padStart(2, "0")})`,
      className,
      "Kuru çalı ve makilik",
      source,
      extra,
    );
  }
  if (classCode >= 8 && classCode <= 11) {
    return biomeRecord(
      "GRASSLAND_STEPPE",
      `${className} (IGBP-${String(classCode).padStart(2, "0")})`,
      className,
      classCode === 11 ? "Sulak alan bitki örtüsü; yerel nem değişken" : "Kuru ot ve seyrek çalı",
      source,
      extra,
    );
  }
  if (classCode === 12 || classCode === 14) {
    return biomeRecord(
      "CROPLAND_AGRICULTURE",
      `${className} (IGBP-${String(classCode).padStart(2, "0")})`,
      className,
      "Ekili tarım alanı bağlamı; anız yakıldığı kanıtı değildir",
      source,
      extra,
    );
  }
  if (classCode === 13) {
    return biomeRecord(
      "WUI_URBAN_INTERFACE",
      `${className} (IGBP-13; sanayi etiketi değildir)`,
      className,
      "Kentsel mozaik; yanıcı örtü yerel ölçekte değişken",
      source,
      extra,
    );
  }
  return biomeRecord(
    "NON_FUEL_SURFACE",
    `${className} (IGBP-${String(classCode).padStart(2, "0")})`,
    className,
    "IGBP sınıfında düşük veya bulunmayan bitkisel yakıt",
    source,
    extra,
  );
}

function inferGeographicBiome(cluster, elevationM = null) {
  const { lat, lon } = cluster;
  if (lat >= 35.8 && lat <= 42.1 && lon >= 25.6 && lon <= 44.8) {
    const coastalForestBelt =
      (lat >= 35.8 && lat <= 38.5 && lon >= 26 && lon <= 36.5) ||
      (lat >= 38.5 && lat <= 41.8 && lon >= 26 && lon <= 30.5) ||
      (lat >= 40.5 && lat <= 42.1 && lon >= 29 && lon <= 42);
    if (coastalForestBelt && (elevationM == null || elevationM >= 150)) {
      if (elevationM == null || elevationM < 650) {
        return biomeRecord(
          "SHRUBLAND_MAQUIS",
          "Akdeniz Makilik / Çalılık (IGBP-06/07; coğrafi çıkarım)",
          "Makilik ve çalılık; IGBP sınıfı GIBS katmanıyla görsel olarak kontrol edilebilir",
          "Kuru, reçineli maki ve çalılık",
          "COĞRAFİ ÇIKARIM",
        );
      }
      return biomeRecord(
        "FOREST_PINE_MIXED",
        "Kızılçam / Karışık Orman (IGBP-01/05; coğrafi çıkarım)",
        "İbreli ve karışık orman; IGBP sınıfı GIBS katmanıyla görsel olarak kontrol edilebilir",
        "Yüksek reçineli ibreli orman / kuru orman alt örtüsü",
        "COĞRAFİ ÇIKARIM",
      );
    }
    const plateau = elevationM != null && elevationM >= 850;
    return plateau
      ? biomeRecord(
        "GRASSLAND_STEPPE",
        "İç Anadolu / Güneydoğu bozkır ve mera (IGBP-10/11; coğrafi çıkarım)",
        "Bozkır ve mera; IGBP sınıfı GIBS katmanıyla görsel olarak kontrol edilebilir",
        "Kuru ot ve seyrek çalı yakıtı",
        "COĞRAFİ ÇIKARIM",
      )
      : biomeRecord(
        "CROPLAND_AGRICULTURE",
        "Tarım Arazisi / Ekili Alan (IGBP-12/14; coğrafi çıkarım)",
        "Tarım ve ürün mozaiği; IGBP sınıfı GIBS katmanıyla görsel olarak kontrol edilebilir",
        "Kuru tahıl anızı ve tarla artığı",
        "COĞRAFİ ÇIKARIM",
      );
  }
  return biomeRecord(
    "UNKNOWN",
    "Arazi sınıfı doğrulanamadı (IGBP katmanı görsel referanstır)",
    "Uydu/OSM sınıfı doğrulanamadı",
    "Yanıcı madde tipi belirlenemedi",
    "SINIFLANDIRILAMADI",
  );
}

function classifyOsmBiome(data) {
  if (!data) return null;
  const address = data.address || {};
  const names = data.namedetails || {};
  const tags = data.extratags || {};
  const value = [
    data.category, data.type, data.addresstype, data.name, data.display_name,
    ...Object.values(names), ...Object.entries(tags).flat(),
    address.landuse, address.natural, address.leisure, address.amenity,
    address.industrial, address.man_made,
  ].filter(Boolean).join(" ").toLowerCase();
  if (/\b(industrial|port|harbour|harbor|dock|refinery|plant|works|quarry|mine|liman|tersane|rafineri|demir.?çelik|sanayi)\b/.test(value)) {
    return biomeRecord(
      "STA_INDUSTRIAL_PORT",
      "Liman & Ağır Sanayi Endüstriyel Alanı (OSM doğrulamalı)",
      "Yok (beton / çelik / endüstriyel yüzey)",
      "Yanıcı bitki örtüsü yok - endüstriyel ısı kaynağı",
      "OSM / NOMINATIM",
    );
  }
  if (/\b(forest|wood|national_park|nature_reserve|orman|çam|koru)\b/.test(value)) {
    return biomeRecord(
      "FOREST_PINE_MIXED",
      "Orman Örtüsü / Karışık Orman (OSM; IGBP-01/05 görsel referans)",
      "Orman örtüsü (OSM sınıfı)",
      "Yüksek reçineli ibreli orman / kuru orman alt örtüsü",
      "OSM / NOMINATIM",
    );
  }
  if (/\b(scrub|heath|chaparral|makilik|çalılık|maki)\b/.test(value)) {
    return biomeRecord(
      "SHRUBLAND_MAQUIS",
      "Akdeniz Makilik ve Çalılık Örtüsü (OSM; IGBP-06/07 görsel referans)",
      "Makilik ve çalılık (OSM sınıfı)",
      "Kuru, reçineli maki ve çalılık",
      "OSM / NOMINATIM",
    );
  }
  if (/\b(farmland|farm|meadow|orchard|vineyard|field|tarla|çiftlik|bağ|bahçe)\b/.test(value)) {
    return biomeRecord(
      "CROPLAND_AGRICULTURE",
      "Tarım Arazisi / Ekili Alan (OSM; IGBP-12/14 görsel referans)",
      "Tarım ve ürün mozaiği (OSM sınıfı)",
      "Kuru tahıl anızı ve tarla artığı",
      "OSM / NOMINATIM",
    );
  }
  if (/\b(grass|grassland|steppe|pasture|bozkır|mera|otlak)\b/.test(value)) {
    return biomeRecord(
      "GRASSLAND_STEPPE",
      "Bozkır / Mera Otlağı (OSM; IGBP-10/11 görsel referans)",
      "Bozkır ve mera (OSM sınıfı)",
      "Kuru ot ve seyrek çalı yakıtı",
      "OSM / NOMINATIM",
    );
  }
  if (/\b(residential|suburb|city|town|village|yerleşim|mahalle|köy|şehir)\b/.test(value)) {
    return biomeRecord(
      "WUI_URBAN_INTERFACE",
      "Yerleşim / Kentsel Ara Yüz (OSM doğrulamalı)",
      "Yerleşim ve parçalı bitki örtüsü",
      "Karışık kentsel / kırsal yanıcı madde",
      "OSM / NOMINATIM",
    );
  }
  return null;
}

export function detectBiomeAndLandCover(cluster, allPoints, context = {}) {
  const staRegion = STA_REGIONS.find(region => inRegion(cluster, region));
  const persistentDays = uniqueDetectionDaysWithin(
    cluster,
    allPoints,
    1.5,
    context.persistenceIndex,
  );
  if (staRegion) {
    return biomeRecord(
      "STA_INDUSTRIAL_PORT",
      "LİMAN / AĞIR SANAYİ TESİSİ (UYGULAMA İÇİ MASKE)",
      "Yok (Beton / Çelik / Endüstriyel Yüzey)",
      "Yanıcı Bitki Örtüsü Yok - Endüstriyel Isı",
      "YEREL SANAYİ COĞRAFİ SINIRI",
      { evidence: `Uygulama içi sanayi sınırı: ${staRegion.name}`, persistentDays },
    );
  }
  const osmBiome = classifyOsmBiome(context.osmData);
  if (osmBiome?.code === "STA_INDUSTRIAL_PORT") return { ...osmBiome, persistentDays };
  const igbpBiome = classifyIgbpBiome(context.igbpClass);
  const biome = igbpBiome || osmBiome || inferGeographicBiome(cluster, context.elevationM);
  if (persistentDays > 3) {
    return {
      ...biome,
      source: `${biome.source} / ${persistentDays} gün tekrar (STA adayı; sanayi doğrulanmadı)`,
      evidence: `${persistentDays} farklı tespit günü; uzun süren doğal yangınlar da tekrarlayabilir`,
      persistentDays,
    };
  }
  return { ...biome, persistentDays };
}

function normalizedPercentages(scores, agricultureIndex = -1, agricultureCap = null) {
  let shares = scores.map(score => Math.max(0, score));
  let sum = shares.reduce((total, score) => total + score, 0) || 1;
  shares = shares.map(score => score / sum);
  if (agricultureIndex >= 0 && agricultureCap != null && shares[agricultureIndex] > agricultureCap) {
    const remaining = 1 - agricultureCap;
    const otherTotal = 1 - shares[agricultureIndex];
    shares = shares.map((share, index) => index === agricultureIndex
      ? agricultureCap
      : otherTotal ? share / otherTotal * remaining : remaining / (shares.length - 1));
  }
  const exact = shares.map(share => share * 100);
  const result = exact.map(Math.floor);
  let remainder = 100 - result.reduce((total, value) => total + value, 0);
  const order = exact.map((value, index) => ({ index, fraction: value - result[index] }))
    .sort((a, b) => b.fraction - a.fraction);
  for (let index = 0; index < remainder; index++) result[order[index % order.length].index]++;
  return result;
}

export function analyzeFireIntelligence(cluster, allPoints, biomeOverride = null, context = {}) {
  const members = cluster.members;
  const biome = biomeOverride || detectBiomeAndLandCover(cluster, allPoints, context);
  const totalFrp = members.reduce((sum, member) => sum + member.frp, 0);
  const meanFrp = totalFrp / members.length;
  const maxDT = Math.max(...members.map(member => member.delta_t));
  const dayCount = members.filter(member => member.daynight === "D").length;
  const nightCount = members.filter(member => member.daynight === "N").length;
  const dayFraction = dayCount / members.length;
  const nightFraction = nightCount / members.length;
  const viirsCount = members.filter(member => member.sensor === "VIIRS").length;
  const firstTs = Math.min(...members.map(member => member.ts));
  const currentDates = new Set(members.map(member => member.acq_date));
  const recurrence = allPoints.filter(point =>
    !currentDates.has(point.acq_date) &&
    Math.abs(point.lat - cluster.lat) <= 10 / 111.32 &&
    Math.abs(point.lon - cluster.lon) <= 10 /
      (111.32 * Math.max(0.000001, Math.abs(Math.cos(cluster.lat * Math.PI / 180)))) &&
    haversineKm(point, cluster) <= 10
  );
  const recurrenceMonths = new Map();
  for (const point of recurrence) {
    const month = Number(point.acq_date.slice(5, 7));
    recurrenceMonths.set(month, (recurrenceMonths.get(month) || 0) + 1);
  }
  const recurrenceMonthSummary = [...recurrenceMonths.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([month, count]) => `${MONTH_LABELS[month - 1]} ${count}`);
  const industrialRepeat = allPoints.filter(point =>
    !currentDates.has(point.acq_date) &&
    Math.abs(point.lat - cluster.lat) <= 5 / 111.32 &&
    Math.abs(point.lon - cluster.lon) <= 5 /
      (111.32 * Math.max(0.000001, Math.abs(Math.cos(cluster.lat * Math.PI / 180)))) &&
    haversineKm(point, cluster) <= 5
  );
  const industrialDeltaValues = industrialRepeat.map(point => point.delta_t);
  const industrialDeltaMean = industrialDeltaValues.length
    ? industrialDeltaValues.reduce((sum, value) => sum + value, 0) / industrialDeltaValues.length
    : 0;
  const industrialDeltaDeviation = industrialDeltaValues.length
    ? Math.sqrt(industrialDeltaValues.reduce((sum, value) =>
      sum + (value - industrialDeltaMean) ** 2, 0) / industrialDeltaValues.length)
    : 0;
  const month = new Date(firstTs).getUTCMonth() + 1;
  const spreadArea = cluster.spreadAreaKm2;
  let forestScore = 0.12 +
    0.34 * clamp01((totalFrp - 12) / 70) +
    0.24 * clamp01((maxDT - 10) / 30) +
    0.15 * Number(dayCount > 0 && nightCount > 0) +
    0.15 * clamp01((spreadArea - 0.1) / 5);
  let agricultureScore = 0.08 +
    0.3 * dayFraction +
    0.22 * clamp01((28 - meanFrp) / 25) +
    0.2 * clamp01(viirsCount / 8) +
    0.2 * Number(month >= 6 && month <= 10);
  const industrialScore = 0.08 +
    0.36 * clamp01(industrialRepeat.length / 8) +
    0.22 * clamp01((0.6 - spreadArea) / 0.6) +
    0.18 * clamp01((8 - industrialDeltaDeviation) / 8) +
    0.16 * clamp01(industrialRepeat.length / 5);
  const wuiScore = 0.08 +
    0.25 * dayFraction +
    0.22 * clamp01((meanFrp - 5) / 25) +
    0.2 * clamp01(recurrence.length / 10) +
    0.25 * clamp01((spreadArea - 0.05) / 2);
  const wasteScore = 0.06 +
    0.3 * nightFraction +
    0.32 * clamp01((14 - meanFrp) / 14) +
    0.22 * Number(members.length === 1) +
    0.1 * clamp01((0.35 - spreadArea) / 0.35);
  const grasslandScore = 0.08 +
    0.2 * dayFraction +
    0.24 * clamp01((24 - maxDT) / 24) +
    0.3 * clamp01((spreadArea - 0.25) / 4) +
    0.18 * clamp01(viirsCount / 10);
  const isForestBiome = biome.code === "FOREST_PINE_MIXED" || biome.code === "SHRUBLAND_MAQUIS";
  if (isForestBiome) {
    forestScore *= 2.4;
    agricultureScore *= 0.05;
  } else if (biome.code === "CROPLAND_AGRICULTURE" && dayCount > 0) {
    agricultureScore *= 2.2;
  } else if (biome.code === "NON_FUEL_SURFACE") {
    forestScore *= 0.05;
    agricultureScore *= 0.05;
    grasslandScore *= 0.05;
  }
  const scores = [
    forestScore,
    agricultureScore,
    industrialScore,
    wuiScore,
    wasteScore,
    grasslandScore,
  ];
  let rounded;
  if (biome.code === "STA_INDUSTRIAL_PORT") {
    rounded = [1, 0, 92, 5, 2, 0];
  } else {
    const maxScore = Math.max(...scores);
    const expScores = scores.map(score => Math.exp((score - maxScore) / 0.22));
    rounded = normalizedPercentages(
      expScores,
      1,
      isForestBiome ? 0.05 : null,
    );
  }
  const rankedScores = FIRE_SOURCE_LABELS.map((label, index) => ({
    label,
    category: FIRE_SOURCE_CATEGORIES[index],
    relativeScore: rounded[index],
  })).sort((a, b) => b.relativeScore - a.relativeScore);
  const humanFactorScore = Math.max(0, Math.min(99, Math.round(
    99 * (
      dayFraction * 0.32 +
      (agricultureScore + industrialScore + wuiScore) / 3 * 0.48 +
      clamp01(recurrence.length / 20) * 0.2
    )
  )));
  return {
    rankedScores,
    biome,
    recurrenceCount: recurrence.length,
    recurrenceMonths: recurrenceMonthSummary.length ? recurrenceMonthSummary : ["Yoğun ay verisi yok"],
    recurrenceLabel: recurrence.length
      ? `YÜKLÜ VERİDE YÜKSEK TEKERRÜR (${recurrence.length} kayıt)`
      : "İLK KEZ / NADİR (yüklü veri içinde)",
    humanFactorScore,
    industrialRepeatCount: industrialRepeat.length,
    industrialDeltaDeviation,
    evidenceScope: "Mevcut tarayıcı veri kümesi",
    model: "TURQUA land-cover constrained heuristic relative-score ranking v2 (uncalibrated)",
  };
}

function updateTelemetry(sourceLabel) {
  const points = state.filteredPoints;
  const clusters = state.clusters;
  const normalizedIndex = points.reduce((sum, point) => {
    const sensorWeight = point.sensor === "MODIS" ? 1 : 0.14;
    return sum + sensorWeight / (point.scan_km * point.track_km);
  }, 0);
  const rawPointCount = points.length;
  const correctionPercent = rawPointCount
    ? ((rawPointCount - normalizedIndex) / rawPointCount) * 100
    : null;
  const counts = {
    tmRaw: points.length,
    tmClusters: clusters.length,
    tmMulti: clusters.filter(cluster => cluster.sources.length > 1).length,
  };
  for (const [id, value] of Object.entries(counts)) {
    const element = document.getElementById(id);
    if (element) element.textContent = value;
  }
  const normalizedElement = document.getElementById("sensorAdjustedIndex");
  if (normalizedElement) normalizedElement.textContent = normalizedIndex.toLocaleString("tr-TR", { maximumFractionDigits: 2 });
  const correctionElement = document.getElementById("sensorCorrection");
  if (correctionElement) correctionElement.textContent = correctionPercent == null
    ? "VERİ YOK"
    : `${correctionPercent >= 0 ? "+" : ""}${correctionPercent.toFixed(1)}%`;
  const bridgeNote = document.getElementById("sensorBridgeNote");
  if (bridgeNote) bridgeNote.textContent =
    "MODIS 1 km² ve VIIRS 0,14 km² ağırlığı piksel alanına göre normalize edilir; MODIS emekliliği sonrası VIIRS aynı eşdeğer indeksle izlenir.";
  updateAoiCriticalAlarm();
  const badge = document.getElementById("sourceStatus");
  if (badge) {
    const source = sourceLabel.toUpperCase().includes("FIRMS") ? "NASA FIRMS" : sourceLabel;
    badge.textContent = `${source} AKTİF / ${points.length.toLocaleString("tr-TR")} TESPİT`;
    badge.className = "source-status ok";
  }
}

export function updateAoiCriticalAlarm() {
  const anomalyText = document.getElementById("activityAnomaly")?.textContent || "";
  const anomalyMatch = anomalyText.match(/^\s*\+?(\d+(?:\.\d+)?)%/);
  const anomalyCritical = Number(anomalyMatch?.[1]) >= 25;
  const activeFoci = state.clusters.filter(cluster =>
    cluster.sensorCounts.MODIS > 0 &&
    cluster.sensorCounts.VIIRS > 0 &&
    (cluster.rawFrp > 50 || anomalyCritical)
  ).length;
  const alarm = document.getElementById("aoiCriticalAlarm");
  if (alarm) {
    alarm.hidden = activeFoci === 0;
    alarm.textContent = activeFoci
      ? `[! AOI KRİTİK ALARM: ${activeFoci} AKTİF ODAK]`
      : "";
    alarm.title = anomalyCritical
      ? "Çoklu sensör teyitli odaklar ve seçili AOI için +25% veya üzeri anomalide tetiklendi."
      : "Çoklu sensör teyitli ve FRP > 50 MW odaklarında tetiklendi.";
  }
  return activeFoci;
}

export function updateMapAndTelemetry(sourceLabel = state.sourceLabel) {
  state.sourceLabel = sourceLabel;
  const minDT = Number(document.getElementById("dTSlider").value);
  const fireFeatures = [];
  const footprintFeatures = [];
  const hullFeatures = [];
  const clusterByPoint = new Map();
  for (const cluster of state.clusters) {
    for (const member of cluster.members) clusterByPoint.set(member, cluster);
  }

  for (const point of state.points) {
    if (point.delta_t < minDT) continue;
    const cluster = clusterByPoint.get(point);
    fireFeatures.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [point.lon, point.lat] },
      properties: {
        kind: "point",
        sensor: point.sensor,
        confidence_raw: point.confidenceRaw,
        confidence_kind: point.confidenceKind,
        confidence_category: point.confidenceCategory,
        density_weight: state.activityMetric === "frp"
          ? (point.sensor === "MODIS" ? 1 : 0.14) * point.frp / (point.scan_km * point.track_km)
          : (point.sensor === "MODIS" ? 1 : 0.14) / (point.scan_km * point.track_km),
        cluster_id: cluster?.id ?? null,
        regime: cluster?.regime ?? "KARIŞIK / SINIFLANDIRILMAMIŞ",
        modis_count: cluster?.sensorCounts.MODIS ?? (point.sensor === "MODIS" ? 1 : 0),
        viirs_count: cluster?.sensorCounts.VIIRS ?? (point.sensor === "VIIRS" ? 1 : 0),
        detection_count: cluster?.members.length ?? 1,
        sensor_count: cluster?.sources.length ?? 1,
        multi_sensor_support: (cluster?.sources.length ?? 1) > 1,
        confidence_summary: cluster
          ? summarizeConfidence(cluster.members)
          : summarizeConfidence([point]),
        cluster_frp: cluster?.harmonizedFrp ?? point.frp,
        raw_cluster_frp: cluster?.rawFrp ?? point.frp,
        biomass_burn_rate_kg_s: cluster?.biomassBurnRateKgS ?? 0.368 * point.frp,
        co_emission_g_s: cluster?.coEmissionGS ?? 0.368 * point.frp * 104,
        cluster_delta_t: cluster?.meanDT ?? point.delta_t,
        fire_intelligence: cluster?.intelligence ?? null,
        biome: cluster?.biome ?? null,
        age_hours: Math.max(0, (Date.now() - point.ts) / 3600000),
        lat: point.lat,
        lon: point.lon,
        acq_date: point.acq_date,
        acq_time: point.acq_time,
        popup: popupPoint(point),
      },
    });
    footprintFeatures.push(footprintPolygon(point));
  }

  for (const cluster of state.clusters) {
    if (cluster.maxDT < minDT) continue;
    if (cluster.hull.length >= 4) {
      hullFeatures.push({
        type: "Feature",
        geometry: { type: "Polygon", coordinates: [cluster.hull] },
        properties: { id: cluster.id },
      });
    }
    fireFeatures.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [cluster.lon, cluster.lat] },
      properties: {
        ...clusterProperties(cluster),
        kind: "cluster",
        sensor: "MERGED",
        popup: popupCluster(cluster),
      },
    });
  }
  updateMapData(fireFeatures, footprintFeatures, hullFeatures);
  updateTelemetry(sourceLabel);
}

export function processRecords(records, sourceLabel, { epsKm = 0.8, maxPoints = null } = {}) {
  state.rawRecords = records;
  state.maxPoints = maxPoints;
  state.allPoints = records.map(normalizeRaw).filter(Boolean);
  state.epsKm = epsKm;
  state.sourceLabel = sourceLabel;
  const result = applyDataQuery();
  if (records.length > 0 && state.allPoints.length === 0) {
    const badge = document.getElementById("sourceStatus");
    if (badge) {
      badge.textContent = "VERİ ŞEMASI HATASI";
      badge.className = "source-status err";
    }
  }
  return { validCount: state.allPoints.length, displayedCount: state.points.length, filteredCount: result };
}

export function applyDataQuery({
  epsKm = state.epsKm,
  bounds = state.bounds,
  startMonth = state.startMonth,
  endMonth = state.endMonth,
  selectedDate = null,
  maxPoints = state.maxPoints,
} = {}) {
  state.epsKm = epsKm;
  state.bounds = bounds;
  state.startMonth = startMonth;
  state.endMonth = endMonth;
  state.selectedDate = selectedDate;
  state.maxPoints = maxPoints;
  const start = `${startMonth}-01`;
  const endDate = new Date(`${endMonth}-01T00:00:00Z`);
  endDate.setUTCMonth(endDate.getUTCMonth() + 1);
  endDate.setUTCDate(0);
  const end = endDate.toISOString().slice(0, 10);
  state.rangePoints = state.allPoints.filter(point =>
    point.acq_date >= start &&
    point.acq_date <= end &&
    (!bounds || (
      point.lon >= bounds.minLon &&
      point.lon <= bounds.maxLon &&
      point.lat >= bounds.minLat &&
      point.lat <= bounds.maxLat
    ))
  );
  state.filteredPoints = selectedDate
    ? state.rangePoints.filter(point => point.acq_date === selectedDate)
    : state.rangePoints;
  const rankedPoints = [...state.filteredPoints].sort((a, b) => b.frp - a.frp);
  state.points = maxPoints == null ? rankedPoints : rankedPoints.slice(0, maxPoints);
  recluster(epsKm);
  return state.filteredPoints.length;
}

export function mergeRecords(records, sourceLabel = state.sourceLabel) {
  state.rawRecords.push(...records);
  state.rawRecords = [...new Map(state.rawRecords.map(record => [recordKey(record), record])).values()];
  state.allPoints = state.rawRecords.map(normalizeRaw).filter(Boolean);
  state.sourceLabel = sourceLabel;
  applyDataQuery();
  return { uniqueCount: state.rawRecords.length, validCount: state.allPoints.length };
}

function recordKey(input) {
  const row = unwrapRecord(input);
  return [
    row._sensor || row.sensor || row.satellite || "",
    row.acq_date || "",
    String(row.acq_time || "").padStart(4, "0"),
    row.latitude ?? row.lat ?? "",
    row.longitude ?? row.lon ?? "",
  ].join("|");
}

export function setActivityMetric(metric) {
  state.activityMetric = metric === "frp" ? "frp" : "count";
  updateMapAndTelemetry();
}

export function recluster(epsKm = state.epsKm) {
  state.epsKm = epsKm;
  const persistenceIndex = persistentDayIndex(state.allPoints);
  const clusterIndexes = stDbscan(state.points, epsKm);
  state.clusters = clusterIndexes.map((indexes, id) => {
    const members = indexes.map(index => state.points[index]);
    const weights = members.map(() => 1);
    const lat = members.reduce((sum, member) => sum + member.lat, 0) / members.length;
    const lon = weightedLongitude(members, weights);
    const sources = [...new Set(members.map(member => member.sensor))].sort();
    const hull = convexHull(members);
    const spreadAreaKm2 = hullAreaKm2(hull);
    const intelligence = analyzeFireIntelligence(
      { lat, lon, members, spreadAreaKm2 },
      state.allPoints,
      null,
      { persistenceIndex },
    );
    return {
      id, lat, lon, members, sources,
      flags: classifyError(members),
      maxDT: Math.max(...members.map(member => member.delta_t)),
      hull,
      sensorCounts: {
        MODIS: members.filter(member => member.sensor === "MODIS").length,
        VIIRS: members.filter(member => member.sensor === "VIIRS").length,
      },
      harmonizedFrp: members.reduce((sum, member) =>
        sum + member.frp * (member.sensor === "MODIS" ? 1 : 0.14), 0),
      rawFrp: members.reduce((sum, member) => sum + member.frp, 0),
      biomassBurnRateKgS: 0.368 * members.reduce((sum, member) => sum + member.frp, 0),
      coEmissionGS: 0.368 * members.reduce((sum, member) => sum + member.frp, 0) * 104,
      meanDT: members.reduce((sum, member) => sum + member.delta_t, 0) / members.length,
      spreadAreaKm2,
      biome: intelligence.biome,
      intelligence,
      confidenceSummary: summarizeConfidence(members),
      regime: intelligence.rankedScores[0].label,
    };
  });
  updateMapAndTelemetry();
}

export function updateClusterBiome(clusterId, context = {}) {
  const cluster = state.clusters.find(item => item.id === Number(clusterId));
  if (!cluster) return null;
  cluster.intelligence = analyzeFireIntelligence(cluster, state.allPoints, null, {
    ...context,
    persistenceIndex: context.persistenceIndex || persistentDayIndex(state.allPoints),
  });
  cluster.biome = cluster.intelligence.biome;
  cluster.regime = cluster.intelligence.rankedScores[0].label;
  updateMapAndTelemetry();
  return cluster;
}

export function exportGeoJSON() {
  const minDT = Number(document.getElementById("dTSlider").value);
  const clusterByPoint = new Map();
  for (const cluster of state.clusters) {
    for (const point of cluster.members) clusterByPoint.set(point, cluster);
  }
  const features = state.points
    .filter(point => point.delta_t >= minDT)
    .map(point => {
      const cluster = clusterByPoint.get(point);
      return {
        type: "Feature",
        geometry: { type: "Point", coordinates: [point.lon, point.lat] },
        properties: {
          feature_type: "detection",
          sensor: point.sensor,
          acq_date: point.acq_date,
          acq_time_utc: point.acq_time,
          frp_mw: point.frp,
          delta_t_k: point.delta_t,
          confidence_raw: point.confidenceRaw,
          confidence_kind: point.confidenceKind,
          age_hours: Math.max(0, (Date.now() - point.ts) / 3600000),
          cluster_id: cluster?.id ?? null,
          fire_regime: cluster?.regime ?? null,
        },
      };
    });
  for (const cluster of state.clusters) {
    if (cluster.maxDT < minDT || cluster.hull.length < 4) continue;
    features.push({
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [cluster.hull] },
      properties: { feature_type: "cluster_hull", ...clusterProperties(cluster) },
    });
  }
  const collection = {
    type: "FeatureCollection",
    name: "TURQUA_FIRE_HARMONY",
    metadata: {
      source: state.sourceLabel,
      start_month: state.startMonth,
      end_month: state.endMonth,
      aoi: state.bounds,
      generated_at_utc: new Date().toISOString(),
    },
    features,
  };
  const blob = new Blob([JSON.stringify(collection)], { type: "application/geo+json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "turqua-fire-harmony.geojson";
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export { footprintPolygon };
