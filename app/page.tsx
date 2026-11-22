"use client";

import { useEffect, useState, useCallback } from "react";
import dynamic from "next/dynamic";
import type {
  Incident,
  Weather,
  Asset,
  SpreadEnvelope,
  SpreadResult,
  EnrichedIncident,
  NwsEnrichment,
} from "@/lib/types";
import IncidentPanel from "@/components/IncidentPanel";
import ExplainPanel from "@/components/ExplainPanel";
import ControlsBar from "@/components/ControlsBar";
import IncidentList from "@/components/IncidentList";

// mapbox-gl needs the browser
const MapView = dynamic(() => import("@/components/MapView"), {
  ssr: false,
  loading: () => (
    <div className="absolute inset-0 bg-zinc-950 flex items-center justify-center">
      <div className="text-zinc-500 text-sm">Loading map...</div>
    </div>
  ),
});

const POLL_INTERVAL_MS = 30000;

export default function Home() {
  const [liveIncidents, setLiveIncidents] = useState<EnrichedIncident[]>([]);
  const [selectedLiveIncident, setSelectedLiveIncident] = useState<EnrichedIncident | null>(null);
  const [liveLoading, setLiveLoading] = useState(false);

  const [incident, setIncident] = useState<Incident | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [weather, setWeather] = useState<Weather | null>(null);
  const [envelopes, setEnvelopes] = useState<SpreadEnvelope[]>([]);
  const [spreadExplain, setSpreadExplain] = useState<SpreadResult["explain"] | null>(null);

  const [liveCalfire, setLiveCalfire] = useState<EnrichedIncident["calfire"] | null>(null);
  const [liveNws, setLiveNws] = useState<NwsEnrichment | null>(null);
  const [livePerimeter, setLivePerimeter] = useState<EnrichedIncident["perimeter"] | null>(null);
  const [liveFirms, setLiveFirms] = useState<EnrichedIncident["firms"] | null>(null);
  const [firmsHotspots, setFirmsHotspots] = useState<{ lat: number; lon: number; frp: number }[]>([]);

  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const fetchLiveIncidents = useCallback(async () => {
    setLiveLoading(true);
    try {
      const res = await fetch("/api/fires/live?days=2&sources=VIIRS_SNPP_NRT,VIIRS_NOAA20_NRT&limit=20&nwsEnrich=3&bbox=-125.0,32.0,-114.0,42.5");
      const data = await res.json();
      const incidents: EnrichedIncident[] = data.incidents || [];
      setLiveIncidents(incidents);

      if (data.hotspotPoints) {
        setFirmsHotspots(data.hotspotPoints);
      }

      // Refresh the selected incident with the new data
      if (selectedLiveIncident) {
        const updated = incidents.find(
          (i) => i.incident.id === selectedLiveIncident.incident.id
        );
        if (updated) {
          setSelectedLiveIncident(updated);
          setIncident(updated.incident);
          setAssets(updated.assets);
          setLiveCalfire(updated.calfire);
          setLiveNws(updated.nws);
          setLivePerimeter(updated.perimeter);
          setLiveFirms(updated.firms);
        }
      }
    } catch (err) {
      console.error("Failed to fetch live incidents:", err);
    } finally {
      setLiveLoading(false);
    }
  }, [selectedLiveIncident]);

  useEffect(() => {
    fetchLiveIncidents();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSelectLiveIncident = useCallback(
    (enriched: EnrichedIncident) => {
      setSelectedLiveIncident(enriched);
      setIncident(enriched.incident);
      setAssets(enriched.assets);
      setLiveCalfire(enriched.calfire);
      setLiveNws(enriched.nws);
      setLivePerimeter(enriched.perimeter);
      setLiveFirms(enriched.firms);

      // Clear forecast computed for the previous incident
      setEnvelopes([]);
      setSpreadExplain(null);
      setWeather(null);
    },
    []
  );

  const handleMapMarkerClick = useCallback(
    (clickedIncident: { id: string; name: string; lat: number; lon: number }) => {
      const enriched = liveIncidents.find(
        (inc) => inc.incident.id === clickedIncident.id
      );
      if (enriched) {
        handleSelectLiveIncident(enriched);
      }
    },
    [liveIncidents, handleSelectLiveIncident]
  );

  const refreshData = useCallback(async () => {
    if (!incident) return;

    try {
      const weatherRes = await fetch(
        `/api/weather?lat=${incident.lat}&lon=${incident.lon}`
      );
      const weatherData: Weather = await weatherRes.json();
      setWeather(weatherData);

      const spreadRes = await fetch("/api/spread", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          incident,
          weather: weatherData,
          horizonHours: 3,
          // Latest pass only: the model was trained on per-pass FRP, not multi-day cluster totals.
          firms: liveFirms?.latestPass ?? null,
        }),
      });
      const spreadData: SpreadResult = await spreadRes.json();
      setEnvelopes(spreadData.envelopes);
      setSpreadExplain(spreadData.explain);

      setLastUpdated(new Date());
    } catch (err) {
      console.error("Error refreshing data:", err);
    }
  }, [incident, liveFirms]);

  useEffect(() => {
    if (incident) {
      refreshData();
    }
  }, [incident?.id, refreshData]);

  useEffect(() => {
    if (!incident) return;

    const timer = setInterval(() => {
      refreshData();
      fetchLiveIncidents();
    }, POLL_INTERVAL_MS);

    return () => clearInterval(timer);
  }, [incident?.id, refreshData, fetchLiveIncidents]);

  const handleRefresh = useCallback(() => {
    refreshData();
    fetchLiveIncidents();
  }, [refreshData, fetchLiveIncidents]);

  return (
    <div className="h-screen w-screen overflow-hidden bg-zinc-950 flex flex-col">
      <ControlsBar
        onRefresh={handleRefresh}
        lastUpdated={lastUpdated}
        liveIncidentCount={liveIncidents.length}
      />

      <div className="flex-1 relative">
        <MapView
          incident={incident}
          envelopes={envelopes}
          assets={assets}
          perimeterPolygon={livePerimeter?.geometry ?? null}
          firmsHotspots={firmsHotspots}
          liveIncidents={liveIncidents}
          selectedIncidentId={incident?.id}
          onIncidentSelect={handleMapMarkerClick}
        />

        <div className="absolute top-4 left-4 z-10 w-72 space-y-2 max-h-[calc(100vh-120px)] overflow-y-auto scrollbar-thin">
          <IncidentList
            incidents={liveIncidents}
            selectedId={incident?.id ?? null}
            onSelect={handleSelectLiveIncident}
            loading={liveLoading}
          />

          <IncidentPanel
            incident={incident}
            weather={weather}
            calfire={liveCalfire}
            nws={liveNws}
            perimeter={livePerimeter}
            firms={liveFirms}
          />

          <ExplainPanel spreadExplain={spreadExplain} />
        </div>
      </div>
    </div>
  );
}
