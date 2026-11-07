import { applyDataQuery, setActivityMetric, state } from "./harmonizer.js";
import { beginAoiDrawing, focusAOI, setMapActivityMetric, setMapColorRamp, updateAOI } from "./map.js";

const YEARS = Array.from({ length: 27 }, (_, index) => 2000 + index);
const MONTHS = ["OCAK", "ŞUBAT", "MART", "NİSAN", "MAYIS", "HAZİRAN", "TEMMUZ", "AĞUSTOS", "EYLÜL", "EKİM", "KASIM", "ARALIK"];
const PRODUCTS = [
  { id: "MODIS_SP", from: "2000-11-01" },
  { id: "VIIRS_SNPP_SP", from: "2012-01-20" },
  { id: "VIIRS_NOAA20_SP", from: "2020-01-01" },
  { id: "VIIRS_NOAA21_NRT", from: "2024-01-17" },
];
const PRESETS = {
  turkey: { minLat: 35.8, maxLat: 42.1, minLon: 25.6, maxLon: 44.8 },
  mediterranean: { minLat: 30, maxLat: 47, minLon: -6, maxLon: 37 },
  amazon: { minLat: -18, maxLat: 5, minLon: -75, maxLon: -44 },
};
const PALETTES = {
  ylorrd: ["#FACC15", "#F59E0B", "#EF4444"],
  viridis: ["#1E3A5F", "#14B8A6", "#FACC15"],
  inferno: ["#7F1D1D", "#EF4444", "#F59E0B"],
};
const DB_NAME = "fireharmony-historical";
const COVERAGE_STORE = "coverage";
const DB_VERSION = 2;
const MAX_RETRIES = 2;

let logger = () => {};
let archiveController = null;
let cancelAoiDrawing = null;
let nextRequestAt = 0;
let currentMonths = new Map();
let archiveCoverage = [];
let refreshRevision = 0;
let coverageByProduct = new Map();
let coverageMonthCache = new Map();
let databasePromise;
let selectedPalette = "ylorrd";
let calendarExpanded = true;
let activeYearsOnly = false;
let playbackDates = [];
let playbackTimer = null;

function log(message, cls = "") {
  logger(message, cls);
}

function stopPlayback() {
  if (playbackTimer) clearInterval(playbackTimer);
  playbackTimer = null;
  const button = document.getElementById("playbackToggle");
  if (button) {
    button.textContent = "OYNAT";
    button.setAttribute("aria-pressed", "false");
  }
}

function syncPlaybackControls() {
  const slider = document.getElementById("playbackRange");
  const dateLabel = document.getElementById("playbackDate");
  const button = document.getElementById("playbackToggle");
  if (!slider || !dateLabel || !button) return;
  playbackDates = [...new Set(state.rangePoints.map(point => point.acq_date))].sort();
  const selectedIndex = state.selectedDate ? playbackDates.indexOf(state.selectedDate) : -1;
  slider.min = "0";
  slider.max = String(Math.max(0, playbackDates.length - 1));
  slider.value = String(selectedIndex >= 0 ? selectedIndex : 0);
  slider.disabled = playbackDates.length === 0;
  button.disabled = playbackDates.length < 2;
  dateLabel.textContent = selectedIndex >= 0
    ? `${state.selectedDate} · ${selectedIndex + 1}/${playbackDates.length}`
    : playbackDates.length
      ? `TÜMÜ · ${playbackDates.length} TESPİT GÜNÜ`
      : "VERİ YOK";
}

function selectPlaybackDate(index) {
  const date = playbackDates[index];
  if (!date) return;
  applyDataQuery({
    bounds: state.bounds,
    startMonth: state.startMonth,
    endMonth: state.endMonth,
    epsKm: state.epsKm,
    selectedDate: date,
  });
  syncPlaybackControls();
}

function advancePlayback() {
  const selectedIndex = playbackDates.indexOf(state.selectedDate);
  const nextIndex = selectedIndex < 0 ? 0 : (selectedIndex + 1) % playbackDates.length;
  selectPlaybackDate(nextIndex);
}

function openDatabase() {
  if (!("indexedDB" in window)) return Promise.reject(new Error("Tarayıcı IndexedDB desteği yok"));
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(COVERAGE_STORE)) {
        const store = database.createObjectStore(COVERAGE_STORE, { keyPath: "key" });
        store.createIndex("areaKey", "areaKey", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Arşiv veritabanı açılamadı"));
  });
  return databasePromise;
}

async function putCache(coverageEntry) {
  return openDatabase().then(database => new Promise((resolve, reject) => {
    const transaction = database.transaction(COVERAGE_STORE, "readwrite");
    transaction.objectStore(COVERAGE_STORE).put(coverageEntry);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error("Arşiv veritabanı işlemi başarısız"));
    transaction.onabort = () => reject(transaction.error || new Error("Arşiv veritabanı işlemi iptal edildi"));
  }));
}

async function getAreaCache(areaKey) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(COVERAGE_STORE, "readonly");
    const request = transaction.objectStore(COVERAGE_STORE).index("areaKey").getAll(IDBKeyRange.only(areaKey));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Önbellek okunamadı"));
  });
}

function readBoundsFromInputs() {
  const read = id => {
    const raw = document.getElementById(id).value.trim();
    if (!raw) throw new Error("AOI koordinat alanları boş bırakılamaz");
    return Number(raw);
  };
  const bounds = {
    minLat: read("minLat"),
    maxLat: read("maxLat"),
    minLon: read("minLon"),
    maxLon: read("maxLon"),
  };
  if (Object.values(bounds).some(value => !Number.isFinite(value))) throw new Error("AOI koordinatları sayısal olmalı");
  if (bounds.minLat < -90 || bounds.maxLat > 90 || bounds.minLat >= bounds.maxLat) {
    throw new Error("Enlem sınırları -90 ile 90 arasında ve min < max olmalı");
  }
  if (bounds.minLon < -180 || bounds.maxLon > 180 || bounds.minLon >= bounds.maxLon) {
    throw new Error("Boylam sınırları -180 ile 180 arasında ve min < max olmalı");
  }
  return bounds;
}

function updateQuery({ redraw = true } = {}) {
  stopPlayback();
  const startMonth = document.getElementById("startMonth").value;
  const endMonth = document.getElementById("endMonth").value;
  if (!startMonth || !endMonth || startMonth > endMonth) {
    throw new Error("Başlangıç ayı bitiş ayından önce veya aynı olmalı");
  }
  const bounds = document.getElementById("globalMode").checked ? null : readBoundsFromInputs();
  applyDataQuery({ bounds, startMonth, endMonth, epsKm: state.epsKm });
  updateAOI(bounds);
  focusAOI(bounds);
  window.dispatchEvent(new CustomEvent("turqua:aoi-changed", { detail: { bounds } }));
  if (redraw) void refreshCalendar();
}

function dateString(date) {
  return date.toISOString().slice(0, 10);
}

function monthRange(month) {
  const [year, monthNumber] = month.split("-").map(Number);
  const start = new Date(Date.UTC(year, monthNumber - 1, 1));
  const end = new Date(Date.UTC(year, monthNumber, 0));
  return { start: dateString(start), end: dateString(end) };
}

function monthOf(date) {
  return String(date).slice(0, 7);
}

function monthIndexFor(month) {
  const [year, monthNumber] = month.split("-").map(Number);
  return year * 12 + monthNumber - 1;
}

function monthFromIndex(index) {
  const year = Math.floor(index / 12);
  const month = index % 12 + 1;
  return `${year}-${String(month).padStart(2, "0")}`;
}

function areaKey(bounds) {
  if (!bounds) return "world";
  return [
    bounds.minLon, bounds.minLat, bounds.maxLon, bounds.maxLat,
  ].map(value => Number(value).toFixed(6)).join(",");
}

function csvRows(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const split = line => {
    const cells = [];
    let cell = "";
    let quoted = false;
    for (let index = 0; index < line.length; index++) {
      const char = line[index];
      if (char === '"' && line[index + 1] === '"' && quoted) {
        cell += '"';
        index++;
      } else if (char === '"') quoted = !quoted;
      else if (char === "," && !quoted) {
        cells.push(cell.trim());
        cell = "";
      } else cell += char;
    }
    cells.push(cell.trim());
    return cells;
  };
  const headers = split(lines[0]).map((header, index) =>
    (index === 0 ? header.replace(/^\uFEFF/, "") : header).toLowerCase()
  );
  return lines.slice(1).map(split).filter(row => row.length === headers.length)
    .map(row => Object.fromEntries(headers.map((header, index) => [header, row[index]])));
}

function makeJobs(startMonth, endMonth, area) {
  const rangeStart = monthRange(startMonth).start;
  const requestedEnd = monthRange(endMonth).end;
  const today = dateString(new Date());
  const rangeEnd = requestedEnd < today ? requestedEnd : today;
  if (rangeStart > rangeEnd) return [];
  const jobs = [];
  const firstMonth = new Date(`${startMonth}-01T00:00:00Z`);
  const lastMonth = new Date(`${endMonth}-01T00:00:00Z`);
  for (const monthCursor = firstMonth; monthCursor <= lastMonth; monthCursor.setUTCMonth(monthCursor.getUTCMonth() + 1)) {
    const month = monthCursor.toISOString().slice(0, 7);
    const { start: monthStart, end: monthEnd } = monthRange(month);
    const lastDay = monthEnd < rangeEnd ? monthEnd : rangeEnd;
    for (const product of PRODUCTS) {
      const firstDay = product.from > monthStart ? product.from : monthStart;
      if (firstDay > lastDay) continue;
      let cursor = new Date(`${firstDay}T00:00:00Z`);
      const last = new Date(`${lastDay}T00:00:00Z`);
      while (cursor <= last) {
        const chunkStart = new Date(cursor);
        const chunkEnd = new Date(Math.min(last.getTime(), cursor.getTime() + 9 * 86400000));
        const days = Math.round((chunkEnd - chunkStart) / 86400000) + 1;
        jobs.push({
          product: product.id,
          start: dateString(chunkStart),
          end: dateString(chunkEnd),
          days,
          area,
        });
        cursor = new Date(chunkEnd.getTime() + 86400000);
      }
    }
  }
  return jobs;
}

function cachedKey(area, product, end, days) {
  return `${area}|${product}|${end}|${days}`;
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function fetchArchiveJob(job, key, signal, includeRecords = false) {
  const areaPath = job.area === "world" ? "world" : job.area;
  const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${encodeURIComponent(key)}/${job.product}/${areaPath}/${job.days}/${job.end}`;
  let lastError;
  let text;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (signal.aborted) throw new DOMException("İndirme durduruldu", "AbortError");
    const now = Date.now();
    const wait = Math.max(0, nextRequestAt - now);
    nextRequestAt = Math.max(now, nextRequestAt) + 150;
    if (wait) await delay(wait);
    if (signal.aborted) throw new DOMException("İndirme durduruldu", "AbortError");
    try {
      const response = await fetch(url, { signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const responseText = await response.text();
      if (/^(invalid|error)/i.test(responseText.trim())) throw new Error("FIRMS API isteği reddetti");
      text = responseText;
      break;
    } catch (error) {
      lastError = error;
      if (error.name === "AbortError") throw error;
      if (attempt < MAX_RETRIES) await delay(700 * (attempt + 1));
    }
  }
  if (text == null) throw lastError || new Error("FIRMS arşiv yanıtı alınamadı");
  const records = csvRows(text).map(row => ({ ...row, _sensor: job.product }));
  const monthTotals = monthIndex(records);
  const keyId = cachedKey(job.area, job.product, job.end, job.days);
  const downloadedAt = new Date().toISOString();
  const metadata = {
    key: keyId,
    areaKey: job.area,
    product: job.product,
    start: job.start,
    end: job.end,
    monthly: [...monthTotals].map(([month, values]) => ({ month, ...values })),
    recordCount: records.length,
    downloadedAt,
    ...(includeRecords ? { records } : {}),
  };
  await putCache(metadata);
  return { recordCount: records.length, records: includeRecords ? records : [] };
}

function normalizeActivityRow(row) {
  const value = row?.raw ? row.raw : row;
  const sensorValue = String(row.sensor || value._sensor || value.sensor || value.satellite || "").toUpperCase();
  const sensor = sensorValue.includes("MODIS") ? "MODIS" : "VIIRS";
  const date = row.acq_date || value.acq_date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) return null;
  const scan = Number(row.scan_km ?? value.scan_km ?? value.scan);
  const track = Number(row.track_km ?? value.track_km ?? value.track);
  const frp = Number(row.frp ?? value.frp ?? value.frp_mw);
  const lat = Number(row.lat ?? value.latitude ?? value.lat);
  const lon = Number(row.lon ?? value.longitude ?? value.lon);
  if (![scan, track, frp, lat, lon].every(Number.isFinite) || scan <= 0 || track <= 0) return null;
  const bounds = state.bounds;
  if (bounds && (lat < bounds.minLat || lat > bounds.maxLat || lon < bounds.minLon || lon > bounds.maxLon)) return null;
  const factor = sensor === "MODIS" ? 1 : 0.14;
  const area = scan * track;
  return {
    date: String(date),
    sensor,
    countDensity: factor / area,
    frpDensity: factor * frp / area,
  };
}

function monthIndex(rows) {
  const aggregate = new Map();
  for (const row of rows) {
    const normalized = normalizeActivityRow(row);
    if (!normalized) continue;
    const key = monthOf(normalized.date);
    const value = aggregate.get(key) || { countDensity: 0, frpDensity: 0, detections: 0 };
    value.countDensity += normalized.countDensity;
    value.frpDensity += normalized.frpDensity;
    value.detections += 1;
    aggregate.set(key, value);
  }
  return aggregate;
}

function intervalsCover(product, start, end) {
  const intervals = coverageByProduct.get(product) || [];
  let cursor = start;
  for (const [intervalStart, intervalEnd] of intervals) {
    if (intervalEnd < cursor) continue;
    if (intervalStart > cursor) return false;
    if (intervalEnd >= end) return true;
    const next = new Date(`${intervalEnd}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    cursor = dateString(next);
  }
  return false;
}

function fullyCoveredMonth(month) {
  if (coverageMonthCache.has(month)) return coverageMonthCache.get(month);
  const { start, end } = monthRange(month);
  const year = Number(month.slice(0, 4));
  const requiredProducts = PRODUCTS.filter(product => product.from.slice(0, 4) <= String(year));
  const covered = requiredProducts.every(product => {
    const requiredStart = product.from > start ? product.from : start;
    return intervalsCover(product.id, requiredStart, end);
  });
  coverageMonthCache.set(month, covered);
  return covered;
}

function selectedMetric(activity) {
  return document.getElementById("activityMetric").value === "frp"
    ? activity?.frpDensity || 0
    : activity?.countDensity || 0;
}

function historicalValues(monthNumber, referenceYear = null) {
  const sameMonth = [];
  for (const year of YEARS) {
    if (referenceYear != null && year >= referenceYear) continue;
    const month = `${year}-${String(monthNumber).padStart(2, "0")}`;
    const activity = currentMonths.get(month);
    const complete = fullyCoveredMonth(month);
    if (complete || activity?.detections > 0) {
      sameMonth.push({ year, month, value: selectedMetric(activity), complete });
    }
  }
  const covered20Years = sameMonth.filter(row =>
    row.year >= 2006 && row.year <= 2025 && row.complete
  );
  const hasFull20YearBaseline = covered20Years.length === 20;
  if (sameMonth.length || hasFull20YearBaseline) {
    return {
      rows: hasFull20YearBaseline ? covered20Years : sameMonth,
      full20YearBaseline: hasFull20YearBaseline,
      label: hasFull20YearBaseline
        ? "20 YILLIK TARİHSEL MEDYAN"
        : `MEVCUT ARŞİV MEDYANI (${sameMonth.length} AY)`,
    };
  }

  const excludedMonth = referenceYear == null
    ? null
    : `${referenceYear}-${String(monthNumber).padStart(2, "0")}`;
  const loadedMonths = [...currentMonths.entries()]
    .filter(([month, activity]) => month !== excludedMonth && activity.detections > 0)
    .map(([month, activity]) => ({
      year: Number(month.slice(0, 4)),
      month,
      value: selectedMetric(activity),
      complete: false,
    }));
  if (loadedMonths.length) {
    return {
      rows: loadedMonths,
      full20YearBaseline: false,
      label: `YÜKLÜ DÖNEM AYLIK MEDYANI (${loadedMonths.length} AY)`,
    };
  }

  return {
    rows: [],
    full20YearBaseline: false,
    label: "AYNI AY İÇİN KARŞILAŞTIRILABİLİR ARŞİV YOK",
  };
}

function baselineFor(monthNumber, excludedYear = null) {
  const history = historicalValues(monthNumber, excludedYear);
  return {
    ...history,
    value: history.rows.length ? median(history.rows.map(row => row.value)) : null,
  };
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function fmt(value) {
  if (value == null || !Number.isFinite(value)) return "VERİ YOK";
  return value.toLocaleString("tr-TR", { maximumFractionDigits: 3 });
}

function anomalyFor(value, baseline) {
  if (value == null || baseline == null || baseline === 0) return null;
  return ((value - baseline) / baseline) * 100;
}

function anomalyLabel(anomaly, loadedPeriodBaseline = false) {
  if (anomaly == null) return "KAPSAMA YETERSİZ";
  if (loadedPeriodBaseline) {
    return `YÜKLÜ DÖNEM KIYASI: ${anomaly >= 0 ? "+" : ""}${anomaly.toFixed(1)}% [MEVSİMSEL ANOMALİ DEĞİL]`;
  }
  if (anomaly >= 25) return `+${anomaly.toFixed(1)}% [KRİTİK DÖNEM]`;
  if (anomaly <= -20) return `${anomaly.toFixed(1)}% [NORMAL ALTI]`;
  return `${anomaly >= 0 ? "+" : ""}${anomaly.toFixed(1)}% [ARALIK İÇİNDE]`;
}

function paletteColor(value, max) {
  if (!max || value <= 0) return "transparent";
  const colors = PALETTES[selectedPalette];
  const ratio = Math.min(1, value / max);
  const index = Math.min(2, Math.floor(ratio * 3));
  return colors[index];
}

function renderCalendar() {
  const grid = document.getElementById("calendarGrid");
  if (!grid) return;
  grid.replaceChildren();
  const activeYears = YEARS.filter(year => [...currentMonths.entries()].some(([month, activity]) =>
    Number(month.slice(0, 4)) === year && activity.detections > 0
  ));
  const displayedYears = activeYearsOnly ? activeYears : YEARS;
  grid.classList.toggle("active-years", activeYearsOnly);
  grid.style.gridTemplateRows = activeYearsOnly
    ? `15px repeat(${displayedYears.length}, minmax(28px, 1fr))`
    : "";
  const heading = document.createElement("div");
  heading.className = "calendar-cell calendar-corner";
  heading.textContent = "YIL";
  grid.append(heading);
  for (const month of MONTHS) {
    const cell = document.createElement("div");
    cell.className = "calendar-cell calendar-month";
    cell.textContent = month.slice(0, 3);
    grid.append(cell);
  }
  const values = [...currentMonths.values()].map(selectedMetric).filter(value => value > 0);
  const max = values.length ? Math.max(...values) : 0;
  document.getElementById("colorbarMax").textContent = fmt(max);
  updateColorbars();
  for (const year of displayedYears) {
    const yearCell = document.createElement("div");
    yearCell.className = "calendar-cell calendar-year";
    yearCell.textContent = String(year);
    grid.append(yearCell);
    for (let monthNumber = 1; monthNumber <= 12; monthNumber++) {
      const month = `${year}-${String(monthNumber).padStart(2, "0")}`;
      const activity = currentMonths.get(month);
      const complete = fullyCoveredMonth(month);
      const value = activity ? selectedMetric(activity) : complete ? 0 : null;
      const isSelectedYear = year === Number(document.getElementById("endMonth").value.slice(0, 4));
      const history = baselineFor(monthNumber, year);
      const baseline = history.value;
      const anomaly = value != null ? anomalyFor(value, baseline) : null;
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = `calendar-cell calendar-value${complete ? " covered" : ""}${isSelectedYear ? " selected-year" : ""}`;
      cell.style.backgroundColor = paletteColor(value || 0, max);
      if (activeYearsOnly && value != null) cell.textContent = fmt(value);
      cell.setAttribute("role", "gridcell");
      const loadedPeriodBaseline = history.label.startsWith("YÜKLÜ DÖNEM");
      cell.title = `${year} ${MONTHS[monthNumber - 1]} | Uyumlaştırılmış yoğunluk: ${fmt(value)} | ${history.label}: ${fmt(baseline)} | Anomali: ${anomalyLabel(anomaly, loadedPeriodBaseline)} | Kayıt: ${activity?.detections || 0}${complete ? " | TAM ARŞİV" : activity ? " | KISMİ / YEREL" : " | VERİ YOK"}`;
      cell.setAttribute("aria-label", cell.title);
      cell.classList.toggle("no-data", value == null);
      cell.addEventListener("click", () => {
        const monthText = `${year}-${String(monthNumber).padStart(2, "0")}`;
        document.getElementById("startMonth").value = monthText;
        document.getElementById("endMonth").value = monthText;
        try {
          updateQuery();
        } catch (error) {
          log(error.message, "err");
        }
      });
      grid.append(cell);
    }
  }
  document.getElementById("calendarStatus").textContent =
    `AOI ${state.bounds ? "seçili alan" : "küresel"} | ${activeYears.length} aktif yıl | ${archiveCoverage.length} arşiv aralığı | Eksik aylar sıfır aktivite olarak yorumlanmaz.`;
  renderAnomalyChart();
  syncPlaybackControls();
}

function renderAnomalyChart() {
  const canvas = document.getElementById("monthlyChart");
  const context = canvas?.getContext("2d");
  if (!context) return;
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(220, canvas.clientWidth);
  const height = 118;
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  context.scale(ratio, ratio);
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#070B1E";
  context.fillRect(0, 0, width, height);
  const selectedYear = Number(document.getElementById("endMonth").value.slice(0, 4));
  const series = Array.from({ length: 12 }, (_, index) => {
    const month = index + 1;
    const history = baselineFor(month, selectedYear);
    const baseline = history.value;
    const monthKey = `${selectedYear}-${String(month).padStart(2, "0")}`;
    const selected = currentMonths.get(monthKey);
    const selectedValue = selected
      ? selectedMetric(selected)
      : fullyCoveredMonth(monthKey) ? 0 : null;
    return { baseline, selected: selectedValue };
  });
  const max = Math.max(1, ...series.flatMap(item => [item.baseline || 0, item.selected || 0]));
  const pad = 12;
  const groupWidth = (width - 2 * pad) / 12;
  const chartHeight = height - 31;
  context.strokeStyle = "#2C3239";
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(pad, chartHeight + 0.5);
  context.lineTo(width - pad, chartHeight + 0.5);
  context.stroke();
  series.forEach((item, index) => {
    const center = pad + index * groupWidth + groupWidth / 2;
    const barWidth = Math.max(2, groupWidth * 0.28);
    for (const [offset, value, color] of [
      [-barWidth / 2, item.baseline, "#14B8A6"],
      [barWidth / 2, item.selected, PALETTES[selectedPalette][1]],
    ]) {
      if (value == null || value <= 0) continue;
      const barHeight = Math.max(1, (value / max) * (chartHeight - 4));
      context.fillStyle = color;
      context.fillRect(center + offset, chartHeight - barHeight, barWidth, barHeight);
    }
    context.fillStyle = "#8C959F";
    context.font = "8px IBM Plex Mono, monospace";
    context.textAlign = "center";
    context.fillText(MONTHS[index].slice(0, 3), center, height - 8);
  });
  context.fillStyle = "#14B8A6";
  context.fillRect(pad, 4, 6, 6);
  context.fillStyle = "#8C959F";
  context.textAlign = "left";
  context.fillText("MEDYAN", pad + 9, 10);
  context.fillStyle = PALETTES[selectedPalette][1];
  context.fillRect(pad + 58, 4, 6, 6);
  context.fillStyle = "#8C959F";
  context.fillText(String(selectedYear), pad + 67, 10);

  const focusMonth = Number(document.getElementById("endMonth").value.slice(5, 7));
  const focusKey = `${selectedYear}-${String(focusMonth).padStart(2, "0")}`;
  const current = currentMonths.get(focusKey);
  const currentIsComplete = fullyCoveredMonth(focusKey);
  const history = baselineFor(focusMonth, selectedYear);
  const baseline = history.value;
  const actual = current ? selectedMetric(current) : currentIsComplete ? 0 : null;
  const anomaly = actual != null ? anomalyFor(actual, baseline) : null;
  const currentElement = document.getElementById("currentActivity");
  const medianElement = document.getElementById("historicalMedian");
  const anomalyElement = document.getElementById("activityAnomaly");
  document.getElementById("historicalMedianLabel").textContent = history.label;
  currentElement.textContent = fmt(actual);
  medianElement.textContent = baseline == null
    ? `KAPSAMA YETERSİZ (${history.rows.length} ay)`
    : fmt(baseline);
  const loadedPeriodBaseline = history.label.startsWith("YÜKLÜ DÖNEM");
  anomalyElement.textContent = anomalyLabel(anomaly, loadedPeriodBaseline);
  anomalyElement.className = !loadedPeriodBaseline && anomaly != null && anomaly >= 25 ? "warn" : "";
  window.dispatchEvent(new CustomEvent("turqua:anomaly-updated"));
}

async function refreshCalendar({ focusLatestLocalMonth = false } = {}) {
  stopPlayback();
  const revision = ++refreshRevision;
  try {
    const bounds = state.bounds;
    const key = areaKey(bounds);
    const cachedEntries = await getAreaCache(key);
    if (revision !== refreshRevision) return;
    archiveCoverage = cachedEntries.map(({ product, start, end }) => ({ product, start, end }));
    coverageByProduct = new Map();
    for (const product of PRODUCTS) {
      coverageByProduct.set(product.id, archiveCoverage
        .filter(entry => entry.product === product.id)
        .map(entry => [entry.start, entry.end])
        .sort((a, b) => a[0].localeCompare(b[0])));
    }
    coverageMonthCache = new Map();
    const archiveMonths = new Map();
    for (const entry of cachedEntries) {
      for (const item of entry.monthly) {
        const total = archiveMonths.get(item.month) || { countDensity: 0, frpDensity: 0, detections: 0 };
        total.countDensity += item.countDensity;
        total.frpDensity += item.frpDensity;
        total.detections += item.detections;
        archiveMonths.set(item.month, total);
      }
    }
    const localAllRows = state.allPoints.map(point => ({
      lat: point.lat,
      lon: point.lon,
      acq_date: point.acq_date,
      acq_time: point.acq_time,
      sensor: point.sensor,
      scan_km: point.scan_km,
      track_km: point.track_km,
      frp: point.frp,
    }));
    const localMonths = monthIndex(localAllRows);
    const isLocalSource = state.sourceLabel.startsWith("YEREL") || state.sourceLabel.startsWith("DOSYA");
    const endMonthControl = document.getElementById("endMonth");
    if (focusLatestLocalMonth && isLocalSource &&
      !localMonths.has(endMonthControl.value) && !archiveMonths.has(endMonthControl.value)) {
      const latestMonth = [...localMonths.keys()]
        .filter(month => !endMonthControl.max || month <= endMonthControl.max)
        .sort()
        .at(-1);
      if (latestMonth) {
        const startMonthControl = document.getElementById("startMonth");
        if (startMonthControl.value > latestMonth) startMonthControl.value = latestMonth;
        endMonthControl.value = latestMonth;
        applyDataQuery({
          bounds: state.bounds,
          startMonth: startMonthControl.value,
          endMonth: latestMonth,
          epsKm: state.epsKm,
        });
      }
    }
    const localRows = state.rangePoints.map(point => ({
      lat: point.lat,
      lon: point.lon,
      acq_date: point.acq_date,
      acq_time: point.acq_time,
      sensor: point.sensor,
      scan_km: point.scan_km,
      track_km: point.track_km,
      frp: point.frp,
    }));
    currentMonths = archiveMonths;
    for (const [month, activity] of monthIndex(localRows)) {
      if (!currentMonths.has(month)) currentMonths.set(month, activity);
    }
    renderCalendar();
  } catch (error) {
    if (revision !== refreshRevision) return;
    log(`Takvim önbelleği okunamadı: ${error.message}`, "err");
    document.getElementById("calendarStatus").textContent = `ARŞİV HATASI: ${error.message}`;
  }
}

export async function downloadHistoricalArchive({ includeRecords = false } = {}) {
  if (archiveController) return;
  const button = document.getElementById("loadArchive");
  const stopButton = document.getElementById("stopArchive");
  const progress = document.getElementById("archiveProgress");
  const progressText = document.getElementById("archiveProgressText");
  button.disabled = true;
  try {
    updateQuery({ redraw: false });
    const startInput = document.getElementById("startMonth");
    const endMonth = document.getElementById("endMonth").value;
    let startMonth = startInput.value;
    const startIndex = monthIndexFor(startMonth);
    const endIndex = monthIndexFor(endMonth);
    if (endIndex - startIndex >= 12) {
      const requestedStart = startMonth;
      startMonth = monthFromIndex(endIndex - 11);
      startInput.value = startMonth;
      updateQuery({ redraw: false });
      const rangeNotice = `Geniş tarih aralığı kota koruması için son 12 aya indirildi: ${startMonth}–${endMonth}`;
      log(rangeNotice, "warn");
      document.getElementById("calendarStatus").textContent = rangeNotice;
      progressText.textContent = `ARŞİV: ${startMonth}–${endMonth} (son 12 ay; seçim ${requestedStart}–${endMonth} idi)`;
    }
    const area = areaKey(state.bounds);
    const jobs = makeJobs(startMonth, endMonth, area);
    if (!jobs.length) {
      log("Seçili zaman aralığı henüz gerçekleşmedi; gelecek dönemler indirilemez", "warn");
      return;
    }
    const cache = await getAreaCache(area);
    const cacheByKey = new Map(cache.map(entry => [entry.key, entry]));
    const pending = jobs.filter(job => {
      const entry = cacheByKey.get(cachedKey(job.area, job.product, job.end, job.days));
      return !entry || (includeRecords && !Array.isArray(entry.records));
    });
    if (!pending.length) {
      log("Seçili NASA FIRMS tarih aralığı tarayıcı önbelleğinde mevcut", "ok");
      await refreshCalendar();
      return includeRecords
        ? cache.flatMap(entry => Array.isArray(entry.records) ? entry.records : [])
        : [];
    }
    const key = document.getElementById("mapKey").value.trim();
    if (!key) {
      document.getElementById("settingsDialog").showModal();
      throw new Error("Tarihsel FIRMS arşivi için ayarlara NASA MAP_KEY girin");
    }
    archiveController = new AbortController();
    stopButton.hidden = false;
    progress.max = pending.length;
    progress.value = 0;
    let downloadedRecords = 0;
    const downloadedRows = [];
    let failures = 0;
    let fatalError = null;
    let cursor = 0;
    let completed = 0;
    const worker = async () => {
      while (!archiveController.signal.aborted) {
        const index = cursor++;
        if (index >= pending.length) return;
        const job = pending[index];
        try {
          const result = await fetchArchiveJob(job, key, archiveController.signal, includeRecords);
          downloadedRecords += result.recordCount;
          downloadedRows.push(...result.records);
        } catch (error) {
          if (error.name === "AbortError") return;
          failures++;
          log(`${job.product} ${job.start}..${job.end}: ${error.message}`, "err");
          if (error.name === "QuotaExceededError") {
            fatalError = error;
            archiveController.abort();
            return;
          }
        }
        completed++;
        progress.value = completed;
        progressText.textContent = `ARŞİV: ${completed}/${pending.length} İSTEK | ${downloadedRecords} TESPİT | ${failures} HATA`;
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, pending.length) }, () => worker()));
    const stopped = archiveController.signal.aborted && !fatalError;
    if (failures) log(`${failures} tarih aralığı indirilemedi; başarısız aralıklar tekrar çalıştırılabilir`, "warn");
    const archiveStatus = fatalError ? "YEREL DEPOLAMA HATASI" : stopped ? "DURDURULDU" : failures ? "KISMİ" : "TAMAMLANDI";
    log(
      `Tarihsel arşiv ${archiveStatus.toLowerCase()}: ${downloadedRecords} kayıt`,
      fatalError ? "err" : stopped || failures ? "warn" : "ok",
    );
    progressText.textContent = `ARŞİV: ${archiveStatus} | ${downloadedRecords} TESPİT | ${failures} HATA`;
    await refreshCalendar();
    if (includeRecords) {
      const updatedCache = await getAreaCache(area);
      return updatedCache.flatMap(entry => Array.isArray(entry.records) ? entry.records : []);
    }
    return downloadedRows;
  } catch (error) {
    log(`Tarihsel arşiv başlatılamadı: ${error.message}`, "err");
    progressText.textContent = `ARŞİV HATASI: ${error.message}`;
    return [];
  } finally {
    archiveController = null;
    button.disabled = false;
    stopButton.hidden = true;
  }
}

function escapeCSV(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function downloadCSV(filename, headers, rows) {
  const content = [headers, ...rows].map(row => row.map(escapeCSV).join(",")).join("\r\n");
  const blob = new Blob(["\uFEFF", content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function exportCalendarCSV() {
  const selected = document.getElementById("activityMetric").value;
  const rows = [];
  for (const year of YEARS) {
    for (let month = 1; month <= 12; month++) {
      const monthKey = `${year}-${String(month).padStart(2, "0")}`;
      const activity = currentMonths.get(monthKey);
      const complete = fullyCoveredMonth(monthKey);
      const value = activity ? selectedMetric(activity) : complete ? 0 : null;
      const history = baselineFor(month, year);
      const baseline = history.value;
      const anomaly = value != null ? anomalyFor(value, baseline) : null;
      rows.push([
        year,
        String(month).padStart(2, "0"),
        selected,
        value ?? "",
        activity?.countDensity ?? "",
        activity?.frpDensity ?? "",
        activity?.detections ?? 0,
        baseline ?? "",
        anomaly ?? "",
        complete ? "COMPLETE" : activity ? "PARTIAL" : "NO_DATA",
        history.rows.length,
        history.label,
      ]);
    }
  }
  downloadCSV("turqua-fire-map-alarm-calendar-2000-2026.csv", [
    "year", "month", "selected_metric", "harmonized_index", "detection_density_km2",
    "frp_density_mw_km2", "detections", "historical_median",
    "anomaly_percent", "coverage", "baseline_sample_count", "baseline_label",
  ], rows);
}

export function exportResultsCSV() {
  const minDT = Number(document.getElementById("dTSlider").value);
  const rows = state.clusters
    .filter(cluster => cluster.maxDT >= minDT)
    .map(cluster => {
    const members = cluster.members;
    const date = members.reduce((earliest, point) => point.acq_date < earliest ? point.acq_date : earliest, members[0].acq_date);
    const time = members.find(point => point.acq_date === date)?.acq_time || "";
    const area = members.reduce((sum, point) => sum + point.scan_km * point.track_km, 0);
    const frp = members.reduce((sum, point) =>
      sum + point.frp * (point.sensor === "MODIS" ? 1 : 0.14), 0);
    const delta = members.reduce((sum, point) => sum + point.delta_t, 0) / members.length;
    const key = date.slice(0, 7);
    const month = Number(key.slice(5, 7));
    const history = baselineFor(month, Number(date.slice(0, 4)));
    const baseline = history.value;
    const activity = currentMonths.get(key);
    const currentValue = activity ? selectedMetric(activity) : fullyCoveredMonth(key) ? 0 : null;
    const anomaly = currentValue == null ? null : anomalyFor(currentValue, baseline);
    const flags = cluster.flags.map(flag => flag.code).join("|");
    return [
      cluster.id,
      cluster.lat,
      cluster.lon,
      date,
      time,
      cluster.sources.join("|"),
      members.length,
      cluster.sources.length,
      cluster.confidenceSummary,
      frp,
      delta,
      area,
      anomalyLabel(anomaly, history.label.startsWith("YÜKLÜ DÖNEM")),
      cluster.regime,
    ];
  });
  downloadCSV("turqua-fire-map-alarm-results.csv", [
    "cluster_id", "lat", "lon", "acq_date", "acq_time", "sensors_merged",
    "detection_count", "sensor_count", "confidence_source_values",
    "harmonized_frp_mw", "delta_t_k", "pixel_area_km2", "anomaly_status",
    "fire_regime",
  ], rows);
}

function applyPreset(name) {
  if (name === "global") {
    document.getElementById("globalMode").checked = true;
    updateQuery();
    return;
  }
  document.getElementById("globalMode").checked = false;
  const bounds = PRESETS[name];
  for (const [key, value] of Object.entries(bounds)) {
    const input = document.getElementById(key);
    input.value = value;
  }
  updateQuery();
}

export function initCalendar(setLogger) {
  logger = setLogger;
  const endMonthControl = document.getElementById("endMonth");
  const currentMonth = new Date().toISOString().slice(0, 7);
  if (endMonthControl.value > currentMonth) endMonthControl.value = currentMonth;
  for (const button of document.querySelectorAll("[data-aoi-preset]")) {
    button.addEventListener("click", () => {
      try {
        applyPreset(button.dataset.aoiPreset);
      } catch (error) {
        log(error.message, "err");
      }
    });
  }
  const drawButton = document.getElementById("drawAoi");
  drawButton.addEventListener("click", () => {
    if (cancelAoiDrawing) {
      cancelAoiDrawing();
      cancelAoiDrawing = null;
      drawButton.textContent = "HARİTADA ALAN ÇİZ";
      updateAOI(state.bounds);
      return;
    }
    log("Haritada başlangıç ve bitiş noktalarını seçerek dikdörtgen AOI çizin", "warn");
    drawButton.textContent = "ÇİZİMİ İPTAL ET";
    cancelAoiDrawing = beginAoiDrawing(bounds => {
      cancelAoiDrawing = null;
      drawButton.textContent = "HARİTADA ALAN ÇİZ";
      if (!bounds) {
        updateAOI(state.bounds);
        log("AOI dikdörtgeni en az 0.1 derece olmalı", "warn");
        return;
      }
      document.getElementById("globalMode").checked = false;
      document.getElementById("minLat").value = bounds.minLat.toFixed(2);
      document.getElementById("maxLat").value = bounds.maxLat.toFixed(2);
      document.getElementById("minLon").value = bounds.minLon.toFixed(2);
      document.getElementById("maxLon").value = bounds.maxLon.toFixed(2);
      try {
        updateQuery();
      } catch (error) {
        log(error.message, "err");
      }
    });
  });
  for (const id of ["minLat", "maxLat", "minLon", "maxLon", "startMonth", "endMonth"]) {
    document.getElementById(id).addEventListener("change", () => {
      try {
        updateQuery();
      } catch (error) {
        log(error.message, "err");
      }
    });
  }
  document.getElementById("globalMode").addEventListener("change", event => {
    if (!event.target.checked) {
      try {
        updateQuery();
      } catch (error) {
        log(error.message, "err");
      }
    }
  });
  document.getElementById("loadArchive").addEventListener("click", downloadHistoricalArchive);
  document.getElementById("stopArchive").addEventListener("click", () => archiveController?.abort());
  document.getElementById("exportResults").addEventListener("click", exportResultsCSV);
  document.getElementById("exportCalendar").addEventListener("click", exportCalendarCSV);
  document.getElementById("playbackRange").addEventListener("input", event => {
    stopPlayback();
    selectPlaybackDate(Number(event.currentTarget.value));
  });
  document.getElementById("playbackToggle").addEventListener("click", event => {
    if (playbackTimer) {
      stopPlayback();
      return;
    }
    if (playbackDates.length < 2) return;
    event.currentTarget.textContent = "DURAKLAT";
    event.currentTarget.setAttribute("aria-pressed", "true");
    advancePlayback();
    playbackTimer = setInterval(advancePlayback, 1200);
  });
  document.getElementById("activityMetric").addEventListener("change", event => {
    setActivityMetric(event.target.value);
    setMapActivityMetric(event.target.value);
    renderCalendar();
  });
  document.getElementById("colorPalette").addEventListener("change", event => {
    selectedPalette = event.target.value;
    setMapColorRamp(PALETTES[selectedPalette]);
    renderCalendar();
    updateColorbars();
  });
  document.getElementById("toggleCalendar").addEventListener("click", event => {
    calendarExpanded = !calendarExpanded;
    document.getElementById("calendarBody").hidden = !calendarExpanded;
    document.querySelector(".calendar-panel").classList.toggle("collapsed", !calendarExpanded);
    event.target.textContent = calendarExpanded ? "DARALT" : "BÜYÜT";
    event.target.setAttribute("aria-expanded", String(calendarExpanded));
  });
  document.getElementById("toggleCalendarScope").addEventListener("click", event => {
    activeYearsOnly = !activeYearsOnly;
    event.currentTarget.setAttribute("aria-pressed", String(activeYearsOnly));
    event.currentTarget.textContent = activeYearsOnly ? "TÜM YILLAR" : "AKTİF YILLAR";
    renderCalendar();
  });
  window.addEventListener("resize", renderAnomalyChart);
  document.getElementById("colorPalette").dispatchEvent(new Event("change"));
  try {
    updateQuery({ redraw: false });
  } catch (error) {
    log(error.message, "err");
  }
  void refreshCalendar();
}

function updateColorbars() {
  const colors = PALETTES[selectedPalette];
  const gradient = `linear-gradient(to right, ${colors.join(", ")})`;
  document.getElementById("colorbar").style.background = gradient;
  document.getElementById("mapColorbar").style.background = gradient;
  const isFrp = document.getElementById("activityMetric").value === "frp";
  const mapMaximum = state.filteredPoints.reduce((maximum, point) => {
    const weight = point.sensor === "MODIS" ? 1 : 0.14;
    const pixelArea = point.scan_km * point.track_km;
    const value = isFrp ? weight * point.frp / pixelArea : weight / pixelArea;
    return Math.max(maximum, value);
  }, 0);
  document.getElementById("mapColorbarMax").textContent = fmt(mapMaximum);
}

export function refreshActivityCalendar(options) {
  return refreshCalendar(options);
}
