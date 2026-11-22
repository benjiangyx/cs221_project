import { NextResponse } from "next/server";
import { fetchFirmsHotspots, type FirmsSource } from "@/lib/firms";
import { clusterHotspots, clusterToEnrichedIncident } from "@/lib/cluster";
import { getNwsEnrichment } from "@/lib/nws";
import { isInCalifornia } from "@/lib/ca-boundary";
import { fetchLandfireFuel } from "@/lib/landfire";
import { getArcGisPerimeters } from "@/lib/arcgis-perimeters";
import { fetchCalFireIncidents } from "@/lib/calfire";
import { attachCalFireData } from "@/lib/incident-match";
import type { FirmsHotspot } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

/** GET /api/fires/live?days&sources&limit&nwsEnrich&bbox: clustered CA FIRMS hotspots as EnrichedIncident[]. */
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const bbox = searchParams.get("bbox") || undefined;
    const daysParam = searchParams.get("days");
    const sourcesParam = searchParams.get("sources");
    const limitParam = searchParams.get("limit");
    const nwsEnrichParam = searchParams.get("nwsEnrich");

    const days = daysParam ? parseInt(daysParam, 10) : 1;
    const limit = limitParam ? parseInt(limitParam, 10) : 20;
    const nwsEnrichCount = nwsEnrichParam ? parseInt(nwsEnrichParam, 10) : 3;

    let sources: FirmsSource[] | undefined;
    if (sourcesParam) {
      sources = sourcesParam
        .split(",")
        .map((s) => s.trim()) as FirmsSource[];
    }

    const allHotspots = await fetchFirmsHotspots({ bbox, days, sources });

    // The FIRMS bbox also covers parts of NV/OR/Mexico.
    const hotspots = allHotspots.filter((hs) =>
      isInCalifornia(hs.latitude, hs.longitude)
    );

    const clusters = clusterHotspots(hotspots);
    const topClusters = clusters.slice(0, limit);

    const enriched = topClusters.map((cluster, idx) =>
      clusterToEnrichedIncident(cluster, idx)
    );

    // Public keyless endpoints; a failure just leaves incidents unmatched.
    const [perimeters, calfireRecords] = await Promise.all([
      getArcGisPerimeters().catch((err) => {
        console.error("[Live] ArcGIS perimeters failed:", err);
        return [];
      }),
      fetchCalFireIncidents({ inactive: true }).catch((err) => {
        console.error("[Live] CAL FIRE incidents failed:", err);
        return [];
      }),
    ]);
    attachCalFireData(enriched, perimeters, calfireRecords);

    // LANDFIRE is the raster the spread model trained on; keep the location estimate if unavailable.
    await Promise.all(
      enriched.map(async (item) => {
        const fuel = await fetchLandfireFuel(item.incident.lat, item.incident.lon);
        if (fuel) {
          item.incident.fuelProxy = fuel;
          item.incident.fuelSource = "LANDFIRE";
        }
      })
    );

    const nwsTargets = enriched.slice(0, nwsEnrichCount);
    await Promise.all(
      nwsTargets.map(async (item) => {
        try {
          item.nws = await getNwsEnrichment(
            item.incident.lat,
            item.incident.lon
          );
        } catch (err) {
          console.error(
            `[Live] NWS enrichment failed for ${item.incident.name}:`,
            err
          );
        }
      })
    );

    // Raw points for the map heat layer.
    const hotspotPoints: { lat: number; lon: number; frp: number }[] =
      hotspots.map((hs: FirmsHotspot) => ({
        lat: hs.latitude,
        lon: hs.longitude,
        frp: hs.frp,
      }));

    return NextResponse.json({
      incidents: enriched,
      hotspotPoints,
    });
  } catch (err) {
    console.error("[API /fires/live] Error:", err);
    return NextResponse.json(
      {
        error: "Failed to fetch live fires",
        details: err instanceof Error ? err.message : String(err),
      },
      { status: 502 }
    );
  }
}
