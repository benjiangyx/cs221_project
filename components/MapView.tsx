"use client";

import { useEffect, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { GeoJsonLayer, ScatterplotLayer, TextLayer } from "@deck.gl/layers";
import type { Incident, SpreadEnvelope, Asset, EnrichedIncident } from "@/lib/types";

type IntensityLevel = 'low' | 'medium' | 'high' | 'critical';

const getMarkerColor = (intensity: IntensityLevel): string => {
  switch (intensity) {
    case 'critical': return '#FF6B00';
    case 'high': return '#FF4444';
    case 'medium': return '#FF8C00';
    case 'low': return '#00C2FF';
    default: return '#6b7280';
  }
};

const getMarkerSize = (intensity: IntensityLevel): number => {
  switch (intensity) {
    case 'critical': return 24;
    case 'high': return 20;
    case 'medium': return 16;
    case 'low': return 12;
    default: return 14;
  }
};

const getPulseSize = (intensity: IntensityLevel): number => {
  switch (intensity) {
    case 'critical': return 60;
    case 'high': return 50;
    case 'medium': return 40;
    case 'low': return 30;
    default: return 35;
  }
};

/** Intensity bucket from FRP relative to the brightest live incident. */
const getIntensityFromFRP = (frp: number, maxFrp: number): IntensityLevel => {
  if (maxFrp === 0) return 'low';
  const severity = frp / maxFrp;

  if (severity > 0.75) return 'critical';
  if (severity > 0.5) return 'high';
  if (severity > 0.25) return 'medium';
  return 'low';
};

// 1h yellow, 2h orange, 3h red
const ENVELOPE_COLORS: Record<number, [number, number, number, number]> = {
  1: [255, 235, 59, 80],
  2: [255, 152, 0, 100],
  3: [244, 67, 54, 120],
};

const ENVELOPE_LINE_COLORS: Record<number, [number, number, number]> = {
  1: [255, 235, 59],
  2: [255, 152, 0],
  3: [244, 67, 54],
};

/** Vertex of a ring ([lon, lat][]) whose bearing from the ring's centroid is closest to bearingDeg. */
function ringPointAtBearing(ring: number[][], bearingDeg: number): [number, number] {
  const cLon = ring.reduce((s, p) => s + p[0], 0) / ring.length;
  const cLat = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  const cosLat = Math.cos((cLat * Math.PI) / 180);
  let best = ring[0];
  let bestDiff = Infinity;
  for (const p of ring) {
    const b = (Math.atan2((p[0] - cLon) * cosLat, p[1] - cLat) * 180) / Math.PI;
    const diff = Math.abs((((b - bearingDeg) % 360) + 540) % 360 - 180);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = p;
    }
  }
  return [best[0], best[1]];
}

const PRIORITY_COLORS: Record<string, [number, number, number]> = {
  high: [244, 67, 54],
  medium: [255, 152, 0],
  low: [76, 175, 80],
};

interface PerimeterPolygon {
  type: "Polygon";
  coordinates: number[][][];
}

interface HotspotPoint {
  lat: number;
  lon: number;
  frp: number;
}

interface MapViewProps {
  incident: Incident | null;
  envelopes: SpreadEnvelope[];
  assets: Asset[];
  perimeterPolygon?: PerimeterPolygon | null;
  firmsHotspots?: HotspotPoint[];
  liveIncidents?: EnrichedIncident[];
  selectedIncidentId?: string;
  onIncidentSelect?: (incident: { id: string; name: string; lat: number; lon: number }) => void;
}

export default function MapView({ incident, envelopes, assets, perimeterPolygon, firmsHotspots, liveIncidents, selectedIncidentId, onIncidentSelect }: MapViewProps) {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const overlayRef = useRef<MapboxOverlay | null>(null);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  const markersRef = useRef<mapboxgl.Marker[]>([]);

  useEffect(() => {
    if (!mapContainer.current || mapRef.current) return;

    const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

    if (!token || token === "your_mapbox_token_here") {
      setMapError("Mapbox token not set. Add NEXT_PUBLIC_MAPBOX_TOKEN to .env.local");
      return;
    }

    try {
      mapboxgl.accessToken = token.trim();

      const map = new mapboxgl.Map({
        container: mapContainer.current,
        style: "mapbox://styles/mapbox/satellite-streets-v12",
        center: [-122.17, 37.42],
        zoom: 12,
        pitch: 0,
        bearing: 0,
      });

      map.addControl(new mapboxgl.NavigationControl(), "bottom-right");

      map.on("load", () => {
        try {
          const overlay = new MapboxOverlay({
            layers: [],
          });
          map.addControl(overlay as unknown as mapboxgl.IControl);
          overlayRef.current = overlay;
        } catch (e) {
          console.warn("[MapView] Deck.gl overlay failed, map will work without it:", e);
        }

        setMapLoaded(true);
      });

      map.on("error", (e) => {
        console.error("[MapView] Map error:", e);
        setMapError(`Map error: ${e.error?.message || "Unknown error"}`);
      });

      mapRef.current = map;
    } catch (e) {
      console.error("[MapView] Failed to create map:", e);
      setMapError(`Failed to create map: ${e instanceof Error ? e.message : String(e)}`);
    }

    return () => {
      markersRef.current.forEach(marker => marker.remove());
      markersRef.current = [];

      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
      overlayRef.current = null;
    };
  }, []);

  // Live incidents are native Mapbox markers (CSS pulse), not deck.gl layers.
  useEffect(() => {
    if (!mapRef.current || !mapLoaded || !liveIncidents || liveIncidents.length === 0) return;

    markersRef.current.forEach(marker => marker.remove());
    markersRef.current = [];

    const frpValues = liveIncidents.map((e) => e.firms?.maxFrp || 0);
    const maxFrp = Math.max(...frpValues, 1);

    liveIncidents.forEach((enriched) => {
      const { incident, firms } = enriched;
      const { lon, lat, id, name } = incident;

      if (typeof lon !== 'number' || typeof lat !== 'number') return;

      const frp = firms?.maxFrp || 0;
      const intensity = getIntensityFromFRP(frp, maxFrp);
      const isSelected = selectedIncidentId === id;

      const markerEl = document.createElement('div');
      markerEl.className = 'relative';
      markerEl.style.cursor = 'pointer';
      markerEl.style.zIndex = isSelected ? '200' : '100';

      const pulseEl = document.createElement('div');
      pulseEl.className = 'absolute rounded-full border-2 opacity-30 pulse-animation';
      pulseEl.style.width = `${getPulseSize(intensity)}px`;
      pulseEl.style.height = `${getPulseSize(intensity)}px`;
      pulseEl.style.borderColor = getMarkerColor(intensity);
      pulseEl.style.transform = 'translate(-50%, -50%)';
      pulseEl.style.top = '50%';
      pulseEl.style.left = '50%';
      pulseEl.style.position = 'absolute';
      pulseEl.style.zIndex = '1';
      markerEl.appendChild(pulseEl);

      const mainMarker = document.createElement('div');
      mainMarker.className = 'rounded-full border-2 border-white shadow-lg relative';
      mainMarker.style.width = `${getMarkerSize(intensity)}px`;
      mainMarker.style.height = `${getMarkerSize(intensity)}px`;
      mainMarker.style.backgroundColor = getMarkerColor(intensity);
      mainMarker.style.transform = 'translate(-50%, -50%)';
      mainMarker.style.position = 'absolute';
      mainMarker.style.top = '50%';
      mainMarker.style.left = '50%';
      mainMarker.style.zIndex = '100';
      mainMarker.style.boxShadow = `0 0 20px ${getMarkerColor(intensity)}40`;
      markerEl.appendChild(mainMarker);

      // Name label, visible only for the selected marker
      const labelEl = document.createElement('div');
      labelEl.className = 'absolute whitespace-nowrap fire-label';
      labelEl.style.left = '50%';
      labelEl.style.top = '100%';
      labelEl.style.transform = 'translateX(-50%)';
      labelEl.style.marginTop = '8px';
      labelEl.style.backgroundColor = 'rgba(0, 0, 0, 0.75)';
      labelEl.style.color = 'white';
      labelEl.style.padding = '4px 8px';
      labelEl.style.borderRadius = '6px';
      labelEl.style.fontSize = '11px';
      labelEl.style.fontWeight = '600';
      labelEl.style.border = `1px solid ${getMarkerColor(intensity)}`;
      labelEl.style.boxShadow = '0 2px 4px rgba(0,0,0,0.3)';
      labelEl.style.pointerEvents = 'none';
      labelEl.style.zIndex = '101';
      labelEl.style.display = isSelected ? 'block' : 'none';
      labelEl.textContent = name;
      labelEl.setAttribute('data-fire-id', id.toString());
      markerEl.appendChild(labelEl);

      markerEl.addEventListener('click', () => {
        document.querySelectorAll('.fire-label').forEach((label) => {
          (label as HTMLElement).style.display = 'none';
        });

        const label = markerEl.querySelector('.fire-label');
        if (label) {
          (label as HTMLElement).style.display = 'block';
        }

        if (onIncidentSelect) {
          onIncidentSelect({
            id: id.toString(),
            name: name,
            lat: lat,
            lon: lon,
          });
        }
      });

      const marker = new mapboxgl.Marker({ element: markerEl })
        .setLngLat([lon, lat])
        .addTo(mapRef.current!);

      markersRef.current.push(marker);
    });

  }, [liveIncidents, mapLoaded, selectedIncidentId, onIncidentSelect]);

  // Fit all live incidents when they load, unless one is selected
  useEffect(() => {
    if (!mapRef.current || !liveIncidents || liveIncidents.length === 0) return;
    if (incident) return;

    try {
      const bounds = new mapboxgl.LngLatBounds();
      liveIncidents.forEach((enriched) => {
        bounds.extend([enriched.incident.lon, enriched.incident.lat]);
      });

      mapRef.current.fitBounds(bounds, {
        padding: 100,
        maxZoom: 10,
        duration: 1000,
      });
    } catch (e) {
      console.error('[MapView] Error fitting bounds:', e);
    }
  }, [liveIncidents?.length, incident]);

  useEffect(() => {
    if (!mapRef.current || !incident) return;

    mapRef.current.flyTo({
      center: [incident.lon, incident.lat],
      zoom: 13,
      duration: 1500,
    });
  }, [incident?.id]);

  // deck.gl layers are static; rebuild only when their inputs change.
  useEffect(() => {
    if (!overlayRef.current || !mapLoaded) return;

    const layers: (GeoJsonLayer | ScatterplotLayer | TextLayer)[] = [];

    // Bottom to top: perimeter, FIRMS hotspots, envelopes (3h behind 1h), labels, assets
    if (perimeterPolygon) {
      layers.push(
        new GeoJsonLayer({
          id: "fire-perimeter",
          data: {
            type: "Feature",
            geometry: perimeterPolygon,
            properties: { type: "perimeter" },
          },
          filled: true,
          stroked: true,
          getFillColor: [255, 69, 0, 60],
          getLineColor: [255, 69, 0, 220],
          getLineWidth: 3,
          lineWidthUnits: "pixels",
          pickable: true,
        })
      );
    }

    if (firmsHotspots && firmsHotspots.length > 0) {
      const maxFrp = Math.max(...firmsHotspots.map((h) => h.frp), 1);

      layers.push(
        new ScatterplotLayer({
          id: "firms-hotspots",
          data: firmsHotspots,
          getPosition: (d: HotspotPoint) => [d.lon, d.lat],
          getRadius: 400,
          getFillColor: (d: HotspotPoint) => {
            // yellow (low FRP) to red, more opaque at higher FRP
            const t = Math.min(d.frp / maxFrp, 1);
            return [
              255,
              Math.round(200 * (1 - t)),
              0,
              Math.round(80 + 120 * t),
            ] as [number, number, number, number];
          },
          radiusUnits: "meters",
          pickable: false,
        })
      );
    }

    const sortedEnvelopes = [...envelopes].sort((a, b) => b.tHours - a.tHours);
    for (const env of sortedEnvelopes) {
      const fillColor = ENVELOPE_COLORS[env.tHours] || [200, 200, 200, 80];
      const lineColor = ENVELOPE_LINE_COLORS[env.tHours] || [200, 200, 200];

      layers.push(
        new GeoJsonLayer({
          id: `envelope-${env.tHours}h`,
          data: {
            type: "Feature",
            geometry: env.polygon,
            properties: { tHours: env.tHours },
          },
          filled: true,
          stroked: true,
          getFillColor: fillColor,
          getLineColor: [...lineColor, 200],
          getLineWidth: 2,
          lineWidthUnits: "pixels",
          pickable: true,
        })
      );
    }

    // Each label sits on its ring at a different bearing so they don't overlap
    if (envelopes.length > 0) {
      const labels = envelopes.map((env) => ({
        tHours: env.tHours,
        position: ringPointAtBearing(env.polygon.coordinates[0], 45 + (env.tHours - 1) * 40),
        text: `${env.tHours} h · 90%`,
      }));
      layers.push(
        new TextLayer({
          id: "envelope-labels",
          data: labels,
          getPosition: (d: { position: [number, number] }) => d.position,
          getText: (d: { text: string }) => d.text,
          getSize: 12,
          getColor: [255, 255, 255, 255],
          fontWeight: 600,
          background: true,
          getBackgroundColor: (d: { tHours: number }) =>
            [...(ENVELOPE_LINE_COLORS[d.tHours] || [200, 200, 200]).map((c) => Math.round(c * 0.45)), 230] as [number, number, number, number],
          backgroundPadding: [4, 2],
          getTextAnchor: "start",
          getAlignmentBaseline: "center",
          getPixelOffset: [6, 0],
        })
      );
    }

    if (assets.length > 0) {
      layers.push(
        new ScatterplotLayer({
          id: "assets",
          data: assets,
          getPosition: (d: Asset) => [d.lon, d.lat],
          getRadius: 200,
          getFillColor: (d: Asset) => [
            ...(PRIORITY_COLORS[d.priority] || [150, 150, 150]),
            180,
          ] as [number, number, number, number],
          getLineColor: [255, 255, 255, 255],
          getLineWidth: 2,
          stroked: true,
          lineWidthUnits: "pixels",
          radiusUnits: "meters",
          pickable: true,
        })
      );
    }

    overlayRef.current.setProps({ layers });
  }, [envelopes, assets, perimeterPolygon, firmsHotspots, mapLoaded]);

  if (mapError) {
    return (
      <div className="absolute inset-0 w-full h-full bg-zinc-950 flex items-center justify-center">
        <div className="text-center space-y-2 p-4">
          <p className="text-red-400 text-sm font-medium">Map Error</p>
          <p className="text-zinc-500 text-xs max-w-md">{mapError}</p>
        </div>
      </div>
    );
  }

  return (
    <div ref={mapContainer} className="absolute inset-0 w-full h-full" style={{ minHeight: "100%" }} />
  );
}
