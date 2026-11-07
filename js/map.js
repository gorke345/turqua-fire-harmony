const emptyFeatureCollection = () => ({ type: "FeatureCollection", features: [] });
const hiddenFilter = ["==", ["get", "kind"], "__hidden__"];

let logger = () => {};
let latestMapData = {
  fires: emptyFeatureCollection(),
  footprints: emptyFeatureCollection(),
  hulls: emptyFeatureCollection(),
};
let latestAOI = emptyFeatureCollection();
let latestOrbits = emptyFeatureCollection();
let activeRamp = ["#F2C14E", "#D97724", "#C83E2B"];
let activeMetric = "count";
let selectionHandler = () => {};
let terrainEnabled = false;
let terrainRevision = 0;
let orbitVisible = false;
let orbitRevision = 0;
let gibsLayerMode = "standard";
let selectedGibsDate = "2026-07-12";
let gibsRevision = 0;
let activeLayers = {
  showMODIS: true,
  showVIIRS: true,
  showClusters: true,
  showFootprints: true,
  showDensity: false,
  showLandCover: false,
  showTimeAge: false,
};

const IGBP_ZOOM = 8;
const IGBP_TILE_SIZE = 256;
const IGBP_TILE_CACHE_LIMIT = 32;
const IGBP_RGB_TO_CLASS = new Map([
  ["33,138,33", 1],
  ["49,204,49", 2],
  ["152,204,49", 3],
  ["150,250,150", 4],
  ["141,186,141", 5],
  ["186,141,141", 6],
  ["245,222,179", 7],
  ["218,235,157", 8],
  ["255,213,0", 9],
  ["240,185,103", 10],
  ["71,131,181", 11],
  ["250,239,115", 12],
  ["255,0,0", 13],
  ["153,147,86", 14],
  ["255,255,255", 15],
  ["191,191,189", 16],
  ["134,202,227", 17],
]);
const igbpTileCache = new Map();

async function getIgbpTilePixels(tileX, tileY) {
  const key = `${tileX}/${tileY}`;
  if (igbpTileCache.has(key)) {
    const cached = igbpTileCache.get(key);
    igbpTileCache.delete(key);
    igbpTileCache.set(key, cached);
    return cached;
  }
  const request = (async () => {
    const url = `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Combined_L3_IGBP_Land_Cover_Type_Annual/default/2024-01-01/GoogleMapsCompatible_Level8/${IGBP_ZOOM}/${tileY}/${tileX}.png`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`NASA GIBS IGBP HTTP ${response.status}`);
    const bitmap = await createImageBitmap(await response.blob());
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = IGBP_TILE_SIZE;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) {
      bitmap.close();
      throw new Error("IGBP pikseli için canvas context açılamadı");
    }
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    return context.getImageData(0, 0, IGBP_TILE_SIZE, IGBP_TILE_SIZE).data;
  })();
  igbpTileCache.set(key, request);
  if (igbpTileCache.size > IGBP_TILE_CACHE_LIMIT) {
    igbpTileCache.delete(igbpTileCache.keys().next().value);
  }
  try {
    return await request;
  } catch (error) {
    igbpTileCache.delete(key);
    throw error;
  }
}

export async function fetchIgbpLandCover(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    throw new Error("IGBP sorgusu için koordinatlar geçersiz");
  }
  const boundedLatitude = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const worldSize = 2 ** IGBP_ZOOM;
  const latitudeRadians = boundedLatitude * Math.PI / 180;
  const tileX = Math.max(0, Math.min(worldSize - 1, Math.floor((lon + 180) / 360 * worldSize)));
  const tileY = Math.max(0, Math.min(
    worldSize - 1,
    Math.floor((1 - Math.asinh(Math.tan(latitudeRadians)) / Math.PI) / 2 * worldSize),
  ));
  const pixelX = Math.max(0, Math.min(
    IGBP_TILE_SIZE - 1,
    Math.floor((((lon + 180) / 360 * worldSize) - tileX) * IGBP_TILE_SIZE),
  ));
  const pixelY = Math.max(0, Math.min(
    IGBP_TILE_SIZE - 1,
    Math.floor(((1 - Math.asinh(Math.tan(latitudeRadians)) / Math.PI) / 2 * worldSize - tileY) * IGBP_TILE_SIZE),
  ));
  const pixels = await getIgbpTilePixels(tileX, tileY);
  const offset = (pixelY * IGBP_TILE_SIZE + pixelX) * 4;
  const classCode = IGBP_RGB_TO_CLASS.get(`${pixels[offset]},${pixels[offset + 1]},${pixels[offset + 2]}`);
  return classCode ? { classCode, rgb: `${pixels[offset]},${pixels[offset + 1]},${pixels[offset + 2]}` } : null;
}

export const map = new maplibregl.Map({
  container: "globe",
  style: {
    version: 8,
    projection: { type: "globe" },
    sources: {
      "nasa-blue-marble": {
        type: "raster",
        tiles: [
          "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg",
        ],
        tileSize: 256,
        maxzoom: 8,
        attribution: "NASA GIBS / Blue Marble",
      },
      "nasa-igbp-landcover": {
        type: "raster",
        tiles: [
          "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Combined_L3_IGBP_Land_Cover_Type_Annual/default/2024-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png",
        ],
        tileSize: 256,
        maxzoom: 8,
        attribution: "NASA GIBS / MODIS MCD12Q1 Land Cover",
      },
      "arcgis-world-imagery": {
        type: "raster",
        tiles: [
          "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        ],
        tileSize: 256,
        maxzoom: 17,
        attribution: "Esri, Maxar, Earthstar Geographics",
      },
      "arcgis-world-boundaries": {
        type: "raster",
        tiles: [
          "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
        ],
        tileSize: 256,
        maxzoom: 17,
        attribution: "Esri World Boundaries and Places",
      },
      "terrain-dem": {
        type: "raster-dem",
        tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"],
        encoding: "terrarium",
        tileSize: 256,
        maxzoom: 15,
        attribution: "AWS Terrain Tiles / Mapzen",
      },
      "hillshade-dem": {
        type: "raster-dem",
        tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"],
        encoding: "terrarium",
        tileSize: 256,
        maxzoom: 15,
        attribution: "AWS Terrain Tiles / Mapzen",
      },
      orbits: { type: "geojson", data: emptyFeatureCollection() },
      fires: { type: "geojson", data: emptyFeatureCollection() },
      footprints: { type: "geojson", data: emptyFeatureCollection() },
      hulls: { type: "geojson", data: emptyFeatureCollection() },
      aoi: { type: "geojson", data: emptyFeatureCollection() },
    },
    layers: [
      { id: "bg", type: "background", paint: { "background-color": "#070B1E" } },
      {
        id: "blue-marble",
        type: "raster",
        source: "nasa-blue-marble",
        paint: {
          "raster-brightness-min": 0.05,
          "raster-brightness-max": 0.85,
          "raster-saturation": -0.35,
          "raster-contrast": 0.1,
        },
      },
      {
        id: "world-imagery",
        type: "raster",
        source: "arcgis-world-imagery",
        minzoom: 6,
        paint: { "raster-opacity": 1 },
      },
      {
        id: "landcover-igbp",
        type: "raster",
        source: "nasa-igbp-landcover",
        layout: { visibility: "none" },
        paint: { "raster-opacity": 0.55 },
      },
      {
        id: "world-boundaries",
        type: "raster",
        source: "arcgis-world-boundaries",
        minzoom: 3,
        paint: { "raster-opacity": 0.85 },
      },
      {
        id: "terrain-hillshade",
        type: "hillshade",
        source: "hillshade-dem",
        minzoom: 4,
        paint: {
          "hillshade-exaggeration": 0.32,
          "hillshade-shadow-color": "#070B1E",
          "hillshade-highlight-color": "#94A3B8",
          "hillshade-accent-color": "#14B8A6",
        },
      },
      {
        id: "satellite-orbits",
        type: "line",
        source: "orbits",
        layout: { visibility: "none", "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#02D8E1", "line-width": 1, "line-opacity": 0.65 },
      },
      {
        id: "fire-density",
        type: "heatmap",
        source: "fires",
        filter: ["==", ["get", "kind"], "point"],
        layout: { visibility: "none" },
        paint: {
          "heatmap-weight": ["interpolate", ["linear"], ["get", "density_weight"], 0, 0, 1, 1],
          "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 0, 0.5, 9, 1.2],
          "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 0, 10, 9, 26],
          "heatmap-opacity": 0.72,
          "heatmap-color": [
            "interpolate", ["linear"], ["heatmap-density"],
            0, "rgba(7,11,30,0)",
            0.2, "#14B8A6",
            0.55, "#F59E0B",
            1, "#EF4444",
          ],
        },
      },
      {
        id: "cluster-hull-fill",
        type: "fill",
        source: "hulls",
        minzoom: 5.5,
        layout: { visibility: "visible" },
        paint: { "fill-color": "#EF4444", "fill-opacity": 0.12 },
      },
      {
        id: "cluster-hull-outline",
        type: "line",
        source: "hulls",
        minzoom: 5.5,
        layout: { visibility: "visible" },
        paint: { "line-color": "#EF4444", "line-width": 1.2, "line-opacity": 0.8 },
      },
      {
        id: "aoi-fill",
        type: "fill",
        source: "aoi",
        paint: { "fill-color": "#3B8EA5", "fill-opacity": 0.08 },
      },
      {
        id: "aoi-outline",
        type: "line",
        source: "aoi",
        paint: { "line-color": "#3B8EA5", "line-width": 1.5, "line-dasharray": [2, 1] },
      },
      {
        id: "pt-modis",
        type: "circle",
        source: "fires",
        filter: ["all", ["==", ["get", "kind"], "point"], ["==", ["get", "sensor"], "MODIS"]],
        layout: { visibility: "visible" },
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 1, 1.5, 5, 3, 9, 5],
          "circle-color": "#F59E0B",
          "circle-opacity": 0.85,
          "circle-stroke-width": 1,
          "circle-stroke-color": "#070B1E",
        },
      },
      {
        id: "pt-viirs",
        type: "circle",
        source: "fires",
        filter: ["all", ["==", ["get", "kind"], "point"], ["==", ["get", "sensor"], "VIIRS"]],
        layout: { visibility: "visible" },
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 1, 2.2, 5, 4.5, 9, 8],
          "circle-color": "#02D8E1",
          "circle-opacity": 0.85,
          "circle-stroke-width": 1,
          "circle-stroke-color": "#070B1E",
        },
      },
      {
        id: "pt-cluster",
        type: "circle",
        source: "fires",
        filter: ["==", ["get", "kind"], "cluster"],
        layout: { visibility: "visible" },
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 1, 2.5, 5, 5, 9, 9],
          "circle-color": "rgba(239,68,68,0.15)",
          "circle-stroke-width": 1.5,
          "circle-stroke-color": "#EF4444",
        },
      },
      {
        id: "fp-outline",
        type: "line",
        source: "footprints",
        minzoom: 7.5,
        layout: { visibility: "visible" },
        paint: {
          "line-color": ["case", ["==", ["get", "sensor"], "MODIS"], "#D97724", "#3B8EA5"],
          "line-width": 0.8,
          "line-opacity": 0.55,
        },
      },
    ],
  },
  center: [35, 39],
  zoom: 0.4,
  attributionControl: { compact: true },
});

export function setMapLogger(nextLogger) {
  logger = nextLogger;
}

export function setMapSelectionHandler(handler) {
  selectionHandler = handler;
}

export function setMapOrbits(featureCollection, visible) {
  latestOrbits = featureCollection || emptyFeatureCollection();
  orbitVisible = Boolean(visible);
  const revision = ++orbitRevision;
  const applyOrbits = () => {
    if (revision !== orbitRevision) return;
    if (!map.isStyleLoaded()) {
      map.once("idle", applyOrbits);
      return;
    }
    const source = map.getSource("orbits");
    if (source) source.setData(latestOrbits);
    if (map.getLayer("satellite-orbits")) {
      map.setLayoutProperty("satellite-orbits", "visibility", orbitVisible ? "visible" : "none");
    }
  };
  applyOrbits();
}

function applyTerrain() {
  const revision = terrainRevision;
  if (!map.isStyleLoaded()) {
    map.once("idle", () => {
      if (revision === terrainRevision) applyTerrain();
    });
    return;
  }
  map.setTerrain(terrainEnabled ? { source: "terrain-dem", exaggeration: 1.35 } : null);
  map.easeTo({ pitch: terrainEnabled ? 55 : 0, duration: 500 });
}

export function setTerrainEnabled(enabled) {
  terrainEnabled = enabled;
  terrainRevision++;
  applyTerrain();
}

export function updateMapData(fireFeatures, footprintFeatures, hullFeatures) {
  latestMapData = {
    fires: { type: "FeatureCollection", features: fireFeatures },
    footprints: { type: "FeatureCollection", features: footprintFeatures },
    hulls: { type: "FeatureCollection", features: hullFeatures },
  };
  if (!map.isStyleLoaded()) return;
  for (const [sourceId, data] of Object.entries(latestMapData)) {
    const source = map.getSource(sourceId);
    if (source) source.setData(data);
  }
}

export function setMapLayers(options) {
  activeLayers = { ...activeLayers, ...options };
  applyMapLayers();
}

const GIBS_LAYER_DEFINITIONS = {
  truecolor: {
    source: "gibs-viirs-truecolor",
    layer: "gibs-viirs-truecolor",
    product: "VIIRS_SNPP_CorrectedReflectance_TrueColor",
    extension: "jpg",
    maxzoom: 9,
  },
  thermal: {
    source: "gibs-viirs-thermal",
    layer: "gibs-viirs-thermal",
    product: "VIIRS_SNPP_CorrectedReflectance_BandsM11-I2-I1",
    extension: "jpg",
    maxzoom: 9,
  },
  ndvi: {
    source: "gibs-modis-ndvi",
    layer: "gibs-modis-ndvi",
    product: "MODIS_Terra_NDVI_8Day",
    extension: "png",
    maxzoom: 9,
  },
};

function gibsTileUrl(definition) {
  return `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${definition.product}/default/${selectedGibsDate}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.${definition.extension}`;
}

function ensureGibsLayers() {
  if (!map.isStyleLoaded()) return false;
  for (const definition of Object.values(GIBS_LAYER_DEFINITIONS)) {
    if (!map.getSource(definition.source)) {
      map.addSource(definition.source, {
        type: "raster",
        tiles: [gibsTileUrl(definition)],
        tileSize: 256,
        maxzoom: definition.maxzoom,
        attribution: "NASA GIBS",
      });
    }
    if (!map.getLayer(definition.layer)) {
      map.addLayer({
        id: definition.layer,
        type: "raster",
        source: definition.source,
        layout: { visibility: "none" },
        paint: { "raster-opacity": 1 },
      }, map.getLayer("fire-density") ? "fire-density" : undefined);
    }
  }
  applyGibsMode();
  return true;
}

function applyGibsMode() {
  if (!map.isStyleLoaded()) return;
  const layerByMode = {
    truecolor: "gibs-viirs-truecolor",
    thermal: "gibs-viirs-thermal",
    ndvi: "gibs-modis-ndvi",
  };
  for (const [mode, layerId] of Object.entries(layerByMode)) {
    if (map.getLayer(layerId)) {
      map.setLayoutProperty(layerId, "visibility", gibsLayerMode === mode ? "visible" : "none");
    }
  }
  if (map.getLayer("world-imagery")) {
    map.setLayoutProperty(
      "world-imagery",
      "visibility",
      gibsLayerMode === "standard" ? "visible" : "none",
    );
  }
  if (map.getLayer("landcover-igbp")) {
    const showIgbp = activeLayers.showLandCover || gibsLayerMode === "igbp";
    map.setLayoutProperty("landcover-igbp", "visibility", showIgbp ? "visible" : "none");
  }
}

export function setGibsLayerMode(mode) {
  gibsLayerMode = Object.hasOwn(GIBS_LAYER_DEFINITIONS, mode) || mode === "igbp"
    ? mode
    : "standard";
  const revision = ++gibsRevision;
  const apply = () => {
    if (revision !== gibsRevision) return;
    if (!ensureGibsLayers()) {
      map.once("idle", apply);
      return;
    }
  };
  apply();
}

export function setGibsDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new Error("GIBS tarihi YYYY-AA-GG biçiminde geçerli olmalı");
  }
  selectedGibsDate = date;
  const input = document.getElementById("gibsDate");
  if (input && input.value !== date) input.value = date;
  const revision = ++gibsRevision;
  const apply = () => {
    if (revision !== gibsRevision) return;
    if (!ensureGibsLayers()) {
      map.once("idle", apply);
      return;
    }
    for (const definition of Object.values(GIBS_LAYER_DEFINITIONS)) {
      const source = map.getSource(definition.source);
      if (!source) continue;
      map.removeLayer(definition.layer);
      map.removeSource(definition.source);
      map.addSource(definition.source, {
        type: "raster",
        tiles: [gibsTileUrl(definition)],
        tileSize: 256,
        maxzoom: definition.maxzoom,
        attribution: "NASA GIBS",
      });
      map.addLayer({
        id: definition.layer,
        type: "raster",
        source: definition.source,
        layout: { visibility: "none" },
        paint: { "raster-opacity": 1 },
      }, map.getLayer("fire-density") ? "fire-density" : undefined);
    }
    applyGibsMode();
  };
  apply();
}

function applyMapLayers() {
  if (!map.isStyleLoaded()) return;
  const {
    showMODIS,
    showVIIRS,
    showClusters,
    showFootprints,
    showDensity,
    showLandCover,
    showTimeAge,
  } = activeLayers;
  const filters = {
    "pt-modis": showMODIS
      ? ["all", ["==", ["get", "kind"], "point"], ["==", ["get", "sensor"], "MODIS"]]
      : hiddenFilter,
    "pt-viirs": showVIIRS
      ? ["all", ["==", ["get", "kind"], "point"], ["==", ["get", "sensor"], "VIIRS"]]
      : hiddenFilter,
    "pt-cluster": showClusters ? ["==", ["get", "kind"], "cluster"] : hiddenFilter,
    "cluster-hull-fill": showClusters ? null : hiddenFilter,
    "cluster-hull-outline": showClusters ? null : hiddenFilter,
    "fp-outline": showFootprints ? null : hiddenFilter,
  };
  if (map.getLayer("landcover-igbp")) {
    map.setLayoutProperty(
      "landcover-igbp",
      "visibility",
      showLandCover || gibsLayerMode === "igbp" ? "visible" : "none",
    );
  }
  if (map.getLayer("fire-density")) {
    map.setLayoutProperty("fire-density", "visibility", showDensity ? "visible" : "none");
  }
  const ageColor = [
    "case",
    ["<=", ["get", "age_hours"], 1], "#991B1B",
    ["<=", ["get", "age_hours"], 4], "#EF4444",
    ["<=", ["get", "age_hours"], 12], "#F59E0B",
    "#FDE047",
  ];
  if (map.getLayer("pt-modis")) {
    map.setPaintProperty("pt-modis", "circle-color", showTimeAge ? ageColor : "#F59E0B");
  }
  if (map.getLayer("pt-viirs")) {
    map.setPaintProperty("pt-viirs", "circle-color", showTimeAge ? ageColor : "#02D8E1");
  }
  for (const [layerId, filter] of Object.entries(filters)) {
    if (!map.getLayer(layerId)) continue;
    if (filter) map.setFilter(layerId, filter);
    else if (layerId.startsWith("cluster-hull")) {
      map.setFilter(layerId, ["has", "id"]);
    } else if (layerId === "fp-outline") {
      map.setFilter(layerId, ["has", "sensor"]);
    }
  }
}

export function setMapColorRamp(colors) {
  activeRamp = colors;
  if (!map.isStyleLoaded()) return;
  map.setPaintProperty("fire-density", "heatmap-color", [
    "interpolate", ["linear"], ["heatmap-density"],
    0, "rgba(7,11,30,0)",
    0.2, colors[0],
    0.55, colors[1],
    1, colors[2],
  ]);
}

export function setMapActivityMetric(metric) {
  activeMetric = metric === "frp" ? "frp" : "count";
  if (!map.isStyleLoaded()) return;
  map.setPaintProperty("fire-density", "heatmap-weight", activeMetric === "frp"
    ? ["interpolate", ["linear"], ["get", "density_weight"], 0, 0, 8, 1]
    : ["interpolate", ["linear"], ["get", "density_weight"], 0, 0, 1, 1]);
}

export function updateAOI(bounds) {
  const feature = bounds ? {
    type: "Feature",
    geometry: {
      type: "Polygon",
      coordinates: [[
        [bounds.minLon, bounds.minLat],
        [bounds.maxLon, bounds.minLat],
        [bounds.maxLon, bounds.maxLat],
        [bounds.minLon, bounds.maxLat],
        [bounds.minLon, bounds.minLat],
      ]],
    },
    properties: {},
  } : null;
  latestAOI = feature ? { type: "FeatureCollection", features: [feature] } : emptyFeatureCollection();
  if (!map.isStyleLoaded()) return;
  const source = map.getSource("aoi");
  if (source) source.setData(latestAOI);
}

export function focusAOI(bounds) {
  if (!bounds) {
    map.flyTo({ center: [0, 20], zoom: 0.6, duration: 650 });
    return;
  }
  map.fitBounds(
    [[bounds.minLon, bounds.minLat], [bounds.maxLon, bounds.maxLat]],
    { padding: 90, maxZoom: 5.5, duration: 650 },
  );
}

export function beginAoiDrawing(onBounds) {
  let start;
  let rectangle;
  const canvas = map.getCanvas();
  canvas.style.cursor = "crosshair";
  map.dragPan.disable();
  const cleanup = () => {
    map.off("mousedown", handleMouseDown);
    map.off("mousemove", move);
    map.off("mouseup", finish);
    map.dragPan.enable();
    canvas.style.cursor = "";
  };
  const finish = event => {
    const end = map.unproject(event.point);
    const bounds = {
      minLon: Math.min(start.lng, end.lng),
      maxLon: Math.max(start.lng, end.lng),
      minLat: Math.min(start.lat, end.lat),
      maxLat: Math.max(start.lat, end.lat),
    };
    cleanup();
    if (rectangle) updateAOI(null);
    if (bounds.maxLon - bounds.minLon >= 0.1 && bounds.maxLat - bounds.minLat >= 0.1) {
      onBounds(bounds);
    } else onBounds(null);
  };
  const move = event => {
    if (!start) return;
    const current = map.unproject(event.point);
    rectangle = true;
    updateAOI({
      minLon: Math.min(start.lng, current.lng),
      maxLon: Math.max(start.lng, current.lng),
      minLat: Math.min(start.lat, current.lat),
      maxLat: Math.max(start.lat, current.lat),
    });
  };
  const handleMouseDown = event => {
    start = map.unproject(event.point);
    map.off("mousedown", handleMouseDown);
    map.on("mousemove", move);
    map.on("mouseup", finish);
  };
  map.on("mousedown", handleMouseDown);
  return cleanup;
}

map.on("error", event => {
  const message = event.error?.message || "Bilinmeyen harita hatası";
  logger(`HARİTA: ${message}`, "err");
});

map.on("load", () => {
  try {
    if (terrainEnabled) map.setTerrain({ source: "terrain-dem", exaggeration: 1.35 });
  } catch (error) {
    logger(`3B ARAZİ ETKİNLEŞTİRİLEMEDİ: ${error.message}`, "warn");
  }
  for (const [sourceId, data] of Object.entries(latestMapData)) {
    const source = map.getSource(sourceId);
    if (source) source.setData(data);
  }
  map.getSource("aoi")?.setData(latestAOI);
  map.getSource("orbits")?.setData(latestOrbits);
  map.setLayoutProperty("satellite-orbits", "visibility", orbitVisible ? "visible" : "none");
  setMapColorRamp(activeRamp);
  setMapActivityMetric(activeMetric);
  applyMapLayers();
  ensureGibsLayers();

  const popup = new maplibregl.Popup({ closeButton: true, maxWidth: "260px" });
  for (const layerId of ["pt-modis", "pt-viirs", "pt-cluster"]) {
    map.on("click", layerId, event => {
      const feature = event.features?.[0];
      if (!feature) return;
      selectionHandler(feature.properties || {}, { fromMap: true });
      popup.setLngLat(feature.geometry.coordinates).setHTML(feature.properties.popup || "").addTo(map);
    });
    map.on("mouseenter", layerId, () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", layerId, () => { map.getCanvas().style.cursor = ""; });
  }

  map.on("move", () => {
    const center = map.getCenter();
    document.getElementById("hudCam").textContent =
      `lon ${center.lng.toFixed(2)} / lat ${center.lat.toFixed(2)} / z ${map.getZoom().toFixed(2)}`;
  });
});
