/**
 * Live fuel lookup from LANDFIRE LF2016 FBFM40, the same raster the spread model was
 * trained on (ml/build_dataset.py, stage_landfire). Samples the incident center plus a
 * 1 km ring and takes the majority fuel group.
 */
import type { Incident } from "@/lib/types";
import { TTLCache } from "@/lib/cache";

const LF_FUEL_URL =
  "https://lfps.usgs.gov/arcgis/rest/services/Landfire_LF2016/LF2016_FBFM40_CONUS/ImageServer/getSamples";

type FuelGroup = "grass" | "shrub" | "timber";

/** FBFM40 code ranges, matching FUEL_GROUPS in ml/build_dataset.py (GS 121-124 -> grass). */
function fbfm40Group(code: number): FuelGroup | null {
  if (code >= 101 && code <= 124) return "grass";
  if (code >= 141 && code <= 149) return "shrub";
  if (code >= 161 && code <= 189) return "timber";
  return null; // non-burnable, slash, or no data
}

/** Model fuel group -> Incident.fuelProxy (inverse of FUEL_CLASS in lib/spread-gbdt.ts). */
const GROUP_TO_PROXY: Record<FuelGroup, Incident["fuelProxy"]> = {
  grass: "grass",
  shrub: "brush",
  timber: "mixed",
};

const cache = new TTLCache<Incident["fuelProxy"] | null>(24 * 60 * 60 * 1000);

function samplePoints(lat: number, lon: number): [number, number][] {
  const pts: [number, number][] = [[lon, lat]];
  const dLat = 1 / 111.32; // 1 km
  const dLon = dLat / Math.cos((lat * Math.PI) / 180);
  for (let b = 0; b < 360; b += 45) {
    const r = (b * Math.PI) / 180;
    pts.push([lon + dLon * Math.sin(r), lat + dLat * Math.cos(r)]);
  }
  return pts;
}

/** Majority LANDFIRE fuel at (lat, lon), or null if the service fails or nothing is burnable. */
export async function fetchLandfireFuel(
  lat: number,
  lon: number
): Promise<Incident["fuelProxy"] | null> {
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  const hit = cache.get(key);
  if (hit !== null) return hit;

  try {
    const body = new URLSearchParams({
      geometry: JSON.stringify({ points: samplePoints(lat, lon), spatialReference: { wkid: 4326 } }),
      geometryType: "esriGeometryMultipoint",
      returnFirstValueOnly: "true",
      f: "json",
    });
    const res = await fetch(LF_FUEL_URL, {
      method: "POST",
      body,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const js = (await res.json()) as { samples?: { value?: string }[] };

    const counts: Record<FuelGroup, number> = { grass: 0, shrub: 0, timber: 0 };
    for (const s of js.samples ?? []) {
      const g = fbfm40Group(Number(s.value));
      if (g) counts[g]++;
    }
    const [best, n] = (Object.entries(counts) as [FuelGroup, number][]).sort((a, b) => b[1] - a[1])[0];
    const proxy = n > 0 ? GROUP_TO_PROXY[best] : null;
    if (proxy) cache.set(key, proxy);
    return proxy;
  } catch (err) {
    console.warn(`[LANDFIRE] fuel lookup failed at ${key}:`, err);
    return null;
  }
}

/**
 * Rough fallback when LANDFIRE is unavailable. Grass only on the Central Valley floor
 * (west of the Sierra foothills, whose edge runs ~119.4W at 35.5N to ~120.4W at 38N).
 */
export function estimateFuelFromLocation(lat: number, lon: number): Incident["fuelProxy"] {
  if (lat < 35.5) return "chaparral";
  const foothillLon = -119.4 - (lat - 35.5) * 0.4;
  if (lat < 38 && lon > -122.3 && lon < foothillLon) return "grass";
  return "mixed";
}

/** Display label matching the model's fuel classes. */
export function fuelLabel(proxy: Incident["fuelProxy"]): string {
  return { grass: "grass", brush: "shrub", chaparral: "shrub", mixed: "timber" }[proxy];
}
