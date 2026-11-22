import type { Incident } from "./types";
import { estimateFuelFromLocation } from "./landfire";

// CAL FIRE perimeters (FIRIS + NIFC layer); same source as the public CAL FIRE incident map.
const ARCGIS_PERIMETERS_URL =
  "https://services1.arcgis.com/jUJYIo9tSA7EHvfZ/arcgis/rest/services/CA_Perimeters_NIFC_FIRIS_public_view/FeatureServer/0/query";

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

const perimeterCache: Record<string, CacheEntry<unknown>> = {};
const CACHE_TTL_MS = 2 * 60 * 1000;

function getCached<T>(key: string): T | null {
  const entry = perimeterCache[key];
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    delete perimeterCache[key];
    return null;
  }
  return entry.data as T;
}

function setCache<T>(key: string, data: T): void {
  perimeterCache[key] = { data, timestamp: Date.now() };
}

interface ArcGisPerimeterAttributes {
  OBJECTID: number;
  GlobalID: string;
  type: string; // "Heat Perimeter", etc.
  source: string; // "FIRIS", "NIFC"
  poly_DateCurrent: number | null; // epoch ms
  mission: string | null;
  incident_name: string | null;
  incident_number: string | null;
  area_acres: number | null;
  description: string | null;
  FireDiscoveryDate: number | null; // epoch ms
  CreationDate: number | null; // epoch ms
  EditDate: number | null; // epoch ms
  displayStatus: string; // "Active", "Inactive"
}

interface ArcGisFeature {
  attributes: ArcGisPerimeterAttributes;
  geometry?: {
    // [lon, lat]
    rings: number[][][];
    spatialReference: { wkid: number };
  };
}

export interface ArcGisPerimeterResult {
  attributes: ArcGisPerimeterAttributes;
  geojsonGeometry: GeoJSON.Polygon | null;
  incident: Incident;
}

async function fetchArcGisPerimeters(options?: {
  activeOnly?: boolean;
  minAcres?: number;
}): Promise<ArcGisFeature[]> {
  const activeOnly = options?.activeOnly ?? false;
  const minAcres = options?.minAcres ?? 0;

  const cacheKey = `arcgis_perimeters_${activeOnly}_${minAcres}`;
  const cached = getCached<ArcGisFeature[]>(cacheKey);
  if (cached) return cached;

  const conditions: string[] = ["1=1"];
  if (activeOnly) {
    conditions.push("displayStatus='Active'");
  }
  if (minAcres > 0) {
    conditions.push(`area_acres>=${minAcres}`);
  }

  const params = new URLSearchParams({
    where: conditions.join(" AND "),
    outFields:
      "OBJECTID,GlobalID,type,source,poly_DateCurrent,mission,incident_name,incident_number,area_acres,description,FireDiscoveryDate,CreationDate,EditDate,displayStatus",
    f: "json",
    resultRecordCount: "200",
    returnGeometry: "true",
    orderByFields: "poly_DateCurrent DESC",
  });

  const url = `${ARCGIS_PERIMETERS_URL}?${params.toString()}`;
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(
      `ArcGIS perimeters API error: ${res.status} ${res.statusText}`
    );
  }

  const data = await res.json();
  const features: ArcGisFeature[] = data.features || [];

  setCache(cacheKey, features);
  return features;
}

function ringsToGeoJsonPolygon(
  rings: number[][][]
): GeoJSON.Polygon | null {
  if (!rings || rings.length === 0) return null;

  return {
    type: "Polygon",
    coordinates: rings,
  };
}

// Vertex average, not area-weighted centroid.
function computeCentroid(rings: number[][][]): {
  lat: number;
  lon: number;
} {
  let sumLon = 0;
  let sumLat = 0;
  let count = 0;

  for (const ring of rings) {
    for (const [lon, lat] of ring) {
      sumLon += lon;
      sumLat += lat;
      count++;
    }
  }

  if (count === 0) return { lat: 37.0, lon: -120.0 }; // CA default

  return {
    lat: sumLat / count,
    lon: sumLon / count,
  };
}

// Radius of a circle with the same area.
function acresToRadiusMeters(acres: number | null): number {
  if (!acres || acres <= 0) return 100;
  const areaM2 = acres * 4046.86; // m^2 per acre
  return Math.round(Math.sqrt(areaM2 / Math.PI));
}

function normalizeArcGisFeature(
  feature: ArcGisFeature
): ArcGisPerimeterResult | null {
  const { attributes, geometry } = feature;

  let lat: number;
  let lon: number;

  if (geometry?.rings && geometry.rings.length > 0) {
    const centroid = computeCentroid(geometry.rings);
    lat = centroid.lat;
    lon = centroid.lon;
  } else {
    return null;
  }

  const incident: Incident = {
    id: `arcgis_${attributes.OBJECTID}_${attributes.GlobalID}`,
    name:
      attributes.incident_name ||
      attributes.mission ||
      `Fire ${attributes.OBJECTID}`,
    lat,
    lon,
    startTimeISO: attributes.FireDiscoveryDate
      ? new Date(attributes.FireDiscoveryDate).toISOString()
      : attributes.CreationDate
        ? new Date(attributes.CreationDate).toISOString()
        : new Date().toISOString(),
    perimeter: {
      type: "Point",
      radiusMeters: acresToRadiusMeters(attributes.area_acres),
    },
    fuelProxy: estimateFuelFromLocation(lat, lon),
    notes: [
      attributes.area_acres
        ? `${attributes.area_acres.toFixed(1)} acres`
        : null,
      attributes.displayStatus,
      attributes.source ? `Source: ${attributes.source}` : null,
      attributes.description,
    ]
      .filter(Boolean)
      .join(" • "),
  };

  return {
    attributes,
    geojsonGeometry: geometry?.rings
      ? ringsToGeoJsonPolygon(geometry.rings)
      : null,
    incident,
  };
}

export async function getArcGisPerimeters(options?: {
  activeOnly?: boolean;
  minAcres?: number;
}): Promise<ArcGisPerimeterResult[]> {
  const features = await fetchArcGisPerimeters(options);

  return features
    .map(normalizeArcGisFeature)
    .filter((r): r is ArcGisPerimeterResult => r !== null);
}
