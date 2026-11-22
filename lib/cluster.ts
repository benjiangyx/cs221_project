import type { FirmsHotspot, FireCluster, FirmsPassSummary, Incident, EnrichedIncident, Asset } from "./types";
import { estimateFuelFromLocation } from "./landfire";

// DBSCAN clustering of FIRMS hotspots into fire events.

function haversineMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371000; // m
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// acq_date "2026-02-14", acq_time "0642" (HHMM, UTC)
function parseFirmsDateTime(acq_date: string, acq_time: string): Date {
  const hh = acq_time.padStart(4, "0").substring(0, 2);
  const mm = acq_time.padStart(4, "0").substring(2, 4);
  return new Date(`${acq_date}T${hh}:${mm}:00Z`);
}

const EPS_METERS = 1500;
const MIN_POINTS = 1; // a single detection is still a fire

interface ClusterAssignment {
  clusterId: number;
  hotspot: FirmsHotspot;
}

function dbscan(hotspots: FirmsHotspot[], eps: number, minPts: number): ClusterAssignment[] {
  const n = hotspots.length;
  const labels = new Int32Array(n).fill(-1); // -1 unvisited, -2 noise
  let clusterId = 0;

  function regionQuery(idx: number): number[] {
    const neighbors: number[] = [];
    const p = hotspots[idx];
    for (let j = 0; j < n; j++) {
      if (j === idx) continue;
      const dist = haversineMeters(
        p.latitude,
        p.longitude,
        hotspots[j].latitude,
        hotspots[j].longitude
      );
      if (dist <= eps) {
        neighbors.push(j);
      }
    }
    return neighbors;
  }

  for (let i = 0; i < n; i++) {
    if (labels[i] !== -1) continue;

    const neighbors = regionQuery(i);

    if (neighbors.length + 1 < minPts) {
      labels[i] = -2;
      continue;
    }

    labels[i] = clusterId;
    const queue = [...neighbors];
    const visited = new Set<number>([i]);

    while (queue.length > 0) {
      const j = queue.shift()!;
      if (visited.has(j)) continue;
      visited.add(j);

      if (labels[j] === -2) {
        labels[j] = clusterId; // noise -> border point
      }

      if (labels[j] !== -1) continue;
      labels[j] = clusterId;

      const jNeighbors = regionQuery(j);
      if (jNeighbors.length + 1 >= minPts) {
        queue.push(...jNeighbors);
      }
    }

    clusterId++;
  }

  // Noise points become single-point clusters.
  for (let i = 0; i < n; i++) {
    if (labels[i] === -2) {
      labels[i] = clusterId++;
    }
  }

  return hotspots.map((hs, i) => ({
    clusterId: labels[i],
    hotspot: hs,
  }));
}

/** Matches PASS_GAP_MIN in ml/build_dataset.py: same-satellite detections this close in time = one pass. */
const PASS_GAP_MIN = 20;

/**
 * Summary of the most recent satellite pass, matching how training computed the per-pass
 * features (frp_sum_t0, frp_max_t0, n_det_t0).
 */
export function latestPassSummary(hotspots: FirmsHotspot[]): FirmsPassSummary {
  const timed = hotspots
    .map((hs) => ({ hs, t: parseFirmsDateTime(hs.acq_date, hs.acq_time).getTime() }))
    .sort((a, b) => b.t - a.t);
  const sat = timed[0].hs.satellite;
  const pass = [timed[0]];
  for (const cur of timed.slice(1).filter((x) => x.hs.satellite === sat)) {
    if (pass[pass.length - 1].t - cur.t > PASS_GAP_MIN * 60_000) break;
    pass.push(cur);
  }
  return {
    pointCount: pass.length,
    maxFrp: Math.max(...pass.map((p) => p.hs.frp)),
    totalFrp: pass.reduce((s, p) => s + p.hs.frp, 0),
    satellite: sat,
    time: new Date(timed[0].t).toISOString(),
  };
}

function buildCluster(id: string, hotspots: FirmsHotspot[]): FireCluster {
  let sumLat = 0;
  let sumLon = 0;
  let maxFrp = 0;
  let totalFrp = 0;
  let latestDate = new Date(0);

  for (const hs of hotspots) {
    sumLat += hs.latitude;
    sumLon += hs.longitude;
    if (hs.frp > maxFrp) maxFrp = hs.frp;
    totalFrp += hs.frp;
    const dt = parseFirmsDateTime(hs.acq_date, hs.acq_time);
    if (dt > latestDate) latestDate = dt;
  }

  const centroidLat = sumLat / hotspots.length;
  const centroidLon = sumLon / hotspots.length;

  let maxDist = 100; // m, floor
  for (const hs of hotspots) {
    const dist = haversineMeters(centroidLat, centroidLon, hs.latitude, hs.longitude);
    if (dist > maxDist) maxDist = dist;
  }

  return {
    id,
    centroidLat,
    centroidLon,
    pointCount: hotspots.length,
    maxFrp,
    totalFrp,
    lastSeen: latestDate.toISOString(),
    radiusMeters: Math.round(maxDist + 375), // + VIIRS pixel half-width (~375m)
    hotspots,
    latestPass: latestPassSummary(hotspots),
  };
}

export function clusterHotspots(
  hotspots: FirmsHotspot[],
  options?: { eps?: number; minPts?: number }
): FireCluster[] {
  if (hotspots.length === 0) return [];

  const eps = options?.eps ?? EPS_METERS;
  const minPts = options?.minPts ?? MIN_POINTS;

  const assignments = dbscan(hotspots, eps, minPts);

  const groups = new Map<number, FirmsHotspot[]>();
  for (const { clusterId, hotspot } of assignments) {
    if (!groups.has(clusterId)) groups.set(clusterId, []);
    groups.get(clusterId)!.push(hotspot);
  }

  const clusters: FireCluster[] = [];
  let idx = 0;
  for (const [, groupHotspots] of groups) {
    clusters.push(buildCluster(`firms_cluster_${idx}`, groupHotspots));
    idx++;
  }

  clusters.sort((a, b) => b.totalFrp - a.totalFrp);
  return clusters;
}

function generateClusterName(cluster: FireCluster, index: number): string {
  const satCounts = new Map<string, number>();
  for (const hs of cluster.hotspots) {
    const sat = hs.satellite || "Unknown";
    satCounts.set(sat, (satCounts.get(sat) || 0) + 1);
  }
  const dominantSat = [...satCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "Satellite";

  const latDir = cluster.centroidLat >= 0 ? "N" : "S";
  const lonDir = cluster.centroidLon >= 0 ? "E" : "W";

  return `${dominantSat} Detection ${index + 1} (${Math.abs(cluster.centroidLat).toFixed(2)}${latDir}, ${Math.abs(cluster.centroidLon).toFixed(2)}${lonDir})`;
}

export function clusterToEnrichedIncident(
  cluster: FireCluster,
  index: number
): EnrichedIncident {
  const satellites = [...new Set(cluster.hotspots.map((h) => h.satellite).filter(Boolean))];

  const incident: Incident = {
    id: cluster.id,
    name: generateClusterName(cluster, index),
    lat: cluster.centroidLat,
    lon: cluster.centroidLon,
    startTimeISO: cluster.lastSeen,
    perimeter: {
      type: "Point",
      radiusMeters: cluster.radiusMeters,
    },
    // Location estimate; /api/fires/live replaces it with a LANDFIRE lookup when available.
    fuelProxy: estimateFuelFromLocation(cluster.centroidLat, cluster.centroidLon),
    fuelSource: "estimated",
    notes: [
      `${cluster.pointCount} satellite detections`,
      `Max FRP: ${cluster.maxFrp.toFixed(1)} MW`,
      `Last seen: ${new Date(cluster.lastSeen).toLocaleString()}`,
      satellites.length > 0 ? `Satellites: ${satellites.join(", ")}` : null,
    ]
      .filter(Boolean)
      .join(" • "),
  };

  return {
    incident,
    source: "firms",
    calfire: null,
    perimeter: null,
    firms: {
      pointCount: cluster.pointCount,
      maxFrp: cluster.maxFrp,
      totalFrp: cluster.totalFrp,
      lastSeen: cluster.lastSeen,
      satellites,
      latestPass: cluster.latestPass,
    },
    nws: null,
    assets: [] as Asset[],
  };
}
