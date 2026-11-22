import { NwsForecastPeriod, NwsAlert, NwsEnrichment } from "./types";

// NWS requires an identifying User-Agent.
const NWS_USER_AGENT =
  process.env.NWS_USER_AGENT ??
  "(Flashpoint, contact@example.com)";

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

const nwsCache: Record<string, CacheEntry<unknown>> = {};
const NWS_CACHE_TTL_MS = 10 * 60 * 1000;

function getCached<T>(key: string): T | null {
  const entry = nwsCache[key];
  if (!entry) return null;
  if (Date.now() - entry.timestamp > NWS_CACHE_TTL_MS) {
    delete nwsCache[key];
    return null;
  }
  return entry.data as T;
}

function setNwsCache<T>(key: string, data: T): void {
  nwsCache[key] = { data, timestamp: Date.now() };
}

async function nwsFetch<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": NWS_USER_AGENT,
      Accept:
        "application/geo+json,application/ld+json;q=0.9,application/json;q=0.8",
    },
  });

  if (!res.ok) {
    throw new Error(`NWS ${res.status} ${url}`);
  }

  return res.json() as Promise<T>;
}

interface NwsPointProperties {
  forecast: string;
  forecastHourly: string;
  forecastZone: string;
  county: string;
  cwa: string;
  gridId: string;
  gridX: number;
  gridY: number;
}

async function getNwsPoint(
  lat: number,
  lon: number
): Promise<NwsPointProperties | null> {
  // NWS /points accepts at most 4 decimal places.
  const roundedLat = Math.round(lat * 10000) / 10000;
  const roundedLon = Math.round(lon * 10000) / 10000;

  const cacheKey = `nws_point_${roundedLat}_${roundedLon}`;
  const cached = getCached<NwsPointProperties>(cacheKey);
  if (cached) return cached;

  try {
    const data = await nwsFetch<{ properties: NwsPointProperties }>(
      `https://api.weather.gov/points/${roundedLat},${roundedLon}`
    );
    const props = data.properties;
    setNwsCache(cacheKey, props);
    return props;
  } catch (err) {
    console.error(`[NWS] Failed to get point data for ${lat},${lon}:`, err);
    return null;
  }
}

async function getNwsForecast(
  forecastUrl: string
): Promise<NwsForecastPeriod[]> {
  const cacheKey = `nws_forecast_${forecastUrl}`;
  const cached = getCached<NwsForecastPeriod[]>(cacheKey);
  if (cached) return cached;

  try {
    const data = await nwsFetch<{
      properties: { periods: NwsForecastPeriod[] };
    }>(forecastUrl);
    const periods = data.properties.periods || [];
    setNwsCache(cacheKey, periods);
    return periods;
  } catch (err) {
    console.error(`[NWS] Failed to get forecast:`, err);
    return [];
  }
}

async function getNwsAlertsByPoint(
  lat: number,
  lon: number
): Promise<NwsAlert[]> {
  const roundedLat = Math.round(lat * 10000) / 10000;
  const roundedLon = Math.round(lon * 10000) / 10000;

  const cacheKey = `nws_alerts_${roundedLat}_${roundedLon}`;
  const cached = getCached<NwsAlert[]>(cacheKey);
  if (cached) return cached;

  try {
    const point = await getNwsPoint(lat, lon);
    if (!point?.forecastZone) return [];

    const zoneId = point.forecastZone.split("/").pop();
    const data = await nwsFetch<{
      features: Array<{ properties: NwsAlert }>;
    }>(`https://api.weather.gov/alerts/active?zone=${zoneId}`);

    const alerts: NwsAlert[] = (data.features || []).map((f) => ({
      id: f.properties.id || "",
      event: f.properties.event || "",
      headline: f.properties.headline || "",
      severity: f.properties.severity || "",
      description: f.properties.description || "",
    }));

    setNwsCache(cacheKey, alerts);
    return alerts;
  } catch (err) {
    console.error(`[NWS] Failed to get alerts for ${lat},${lon}:`, err);
    return [];
  }
}

/** Forecast + alerts for a point; null if NWS has no data (e.g. outside the US). */
export async function getNwsEnrichment(
  lat: number,
  lon: number
): Promise<NwsEnrichment | null> {
  const cacheKey = `nws_enrichment_${Math.round(lat * 1000)}_${Math.round(lon * 1000)}`;
  const cached = getCached<NwsEnrichment>(cacheKey);
  if (cached) return cached;

  try {
    const point = await getNwsPoint(lat, lon);
    if (!point) return null;

    const [forecastPeriods, alerts] = await Promise.all([
      getNwsForecast(point.forecast),
      getNwsAlertsByPoint(lat, lon),
    ]);

    // Next 3 forecast periods (~12h each, so ~36h ahead).
    const next3 = forecastPeriods.slice(0, 3);
    const forecastSummary = next3
      .map(
        (p) =>
          `${p.name}: ${p.shortForecast}, ${p.temperature}°${p.temperatureUnit}, wind ${p.windSpeed} ${p.windDirection}`
      )
      .join(" | ");

    const alertEvents = alerts.map((a) => a.event.toLowerCase());
    const hasRedFlagWarning = alertEvents.some(
      (e) => e.includes("red flag") || e.includes("fire weather")
    );
    const hasWindAdvisory = alertEvents.some(
      (e) =>
        e.includes("wind advisory") ||
        e.includes("high wind") ||
        e.includes("extreme wind")
    );

    const enrichment: NwsEnrichment = {
      forecastPeriods: next3,
      alerts,
      forecastSummary,
      hasRedFlagWarning,
      hasWindAdvisory,
    };

    setNwsCache(cacheKey, enrichment);
    return enrichment;
  } catch (err) {
    console.error(`[NWS] Enrichment failed for ${lat},${lon}:`, err);
    return null;
  }
}
