/**
 * Attach official CAL FIRE data to satellite (FIRMS) incidents:
 *   - FIRIS/NIFC perimeter polygon: cluster center inside it, or within PERIMETER_NEAR_KM of an edge
 *   - CAL FIRE incident record: by the matched perimeter's name, else nearest point within CALFIRE_NEAR_KM
 * Only recent official data is used (active, or updated within RECENT_DAYS), so a new
 * detection inside an old burn scar isn't labeled as that old fire.
 */
import type { CalFireRawIncident, EnrichedIncident } from "@/lib/types";
import type { ArcGisPerimeterResult } from "@/lib/arcgis-perimeters";

export const PERIMETER_NEAR_KM = 2;
export const CALFIRE_NEAR_KM = 5;
export const RECENT_DAYS = 14;

type Ring = number[][]; // [lon, lat][]

function distKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r;
  const dLon = (lon2 - lon1) * r;
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Even-odd point-in-polygon over all rings (handles holes and multi-part rings). */
export function pointInRings(lat: number, lon: number, rings: Ring[]): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
  }
  return inside;
}

/** Approximate distance (km) from a point to the nearest polygon edge. */
export function distToRingsKm(lat: number, lon: number, rings: Ring[]): number {
  const kx = 111.32 * Math.cos((lat * Math.PI) / 180); // km per degree lon
  const ky = 110.57; // km per degree lat
  let best = Infinity;
  for (const ring of rings) {
    for (let i = 0; i + 1 < ring.length; i++) {
      const ax = (ring[i][0] - lon) * kx, ay = (ring[i][1] - lat) * ky;
      const bx = (ring[i + 1][0] - lon) * kx, by = (ring[i + 1][1] - lat) * ky;
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
      best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
    }
  }
  return best;
}

function isRecent(epochMs: number | null | undefined, now: number): boolean {
  return epochMs != null && now - epochMs <= RECENT_DAYS * 86_400_000;
}

const normName = (s: string) => s.toLowerCase().replace(/\bfire\b/g, "").replace(/[^a-z0-9]/g, "");

/** Mutates each incident in place, filling `perimeter`, `calfire`, name and source when matched. */
export function attachCalFireData(
  incidents: EnrichedIncident[],
  perimeters: ArcGisPerimeterResult[],
  calfire: CalFireRawIncident[],
  now: number = Date.now()
): void {
  const perims = perimeters.filter(
    (p) =>
      p.geojsonGeometry &&
      (p.attributes.displayStatus === "Active" ||
        isRecent(p.attributes.poly_DateCurrent ?? p.attributes.EditDate, now))
  );
  const records = calfire.filter(
    (c) => c.Latitude && c.Longitude && (c.IsActive || isRecent(Date.parse(c.Updated), now))
  );

  for (const item of incidents) {
    const { lat, lon } = item.incident;

    // Perimeter: containing polygon first, else nearest edge within range.
    let perim: ArcGisPerimeterResult | null = null;
    let bestKm = PERIMETER_NEAR_KM;
    for (const p of perims) {
      const rings = p.geojsonGeometry!.coordinates;
      if (pointInRings(lat, lon, rings)) {
        perim = p;
        break;
      }
      const d = distToRingsKm(lat, lon, rings);
      if (d <= bestKm) {
        bestKm = d;
        perim = p;
      }
    }

    // CAL FIRE record: same name as the perimeter, else nearest within range.
    let record: CalFireRawIncident | null = null;
    const perimName = perim?.attributes.incident_name ? normName(perim.attributes.incident_name) : null;
    if (perimName) record = records.find((c) => normName(c.Name) === perimName) ?? null;
    if (!record) {
      let best = CALFIRE_NEAR_KM;
      for (const c of records) {
        const d = distKm(lat, lon, c.Latitude, c.Longitude);
        if (d <= best) {
          best = d;
          record = c;
        }
      }
    }

    if (perim) {
      item.perimeter = {
        geometry: perim.geojsonGeometry as NonNullable<EnrichedIncident["perimeter"]>["geometry"],
        acres: perim.attributes.area_acres,
        displayStatus: perim.attributes.displayStatus,
        source: perim.attributes.source,
        incidentNumber: perim.attributes.incident_number,
      };
    }
    if (record) {
      item.calfire = {
        acres: record.AcresBurned,
        containmentPct: record.PercentContained,
        county: record.County,
        isActive: record.IsActive,
        url: record.Url,
        updatedAt: record.Updated,
      };
    }

    const officialName = record?.Name || perim?.attributes.incident_name;
    if (officialName) {
      let base = officialName.trim().replace(/\s+fire$/i, "");
      if (base === base.toUpperCase()) {
        base = base.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()); // "POLLY" -> "Polly"
      }
      item.incident.name = `${base} Fire`;
    }
    if (perim || record) item.source = "merged";
  }
}
