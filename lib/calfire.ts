import type { CalFireRawIncident } from "./types";

const CALFIRE_API_BASE =
  "https://incidents.fire.ca.gov/umbraco/api/IncidentApi";

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

const cache: Record<string, CacheEntry<unknown>> = {};
const CACHE_TTL_MS = 2 * 60 * 1000;

function getCached<T>(key: string): T | null {
  const entry = cache[key];
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    delete cache[key];
    return null;
  }
  return entry.data as T;
}

function setCache<T>(key: string, data: T): void {
  cache[key] = { data, timestamp: Date.now() };
}

export async function fetchCalFireIncidents(options?: {
  year?: number;
  inactive?: boolean;
}): Promise<CalFireRawIncident[]> {
  const inactive = options?.inactive ?? true; // include recently contained incidents
  const year = options?.year;

  const cacheKey = `calfire_incidents_${year ?? "current"}_${inactive}`;
  const cached = getCached<CalFireRawIncident[]>(cacheKey);
  if (cached) return cached;

  const params = new URLSearchParams();
  params.set("inactive", String(inactive));
  if (year) params.set("year", String(year));

  const url = `${CALFIRE_API_BASE}/List?${params.toString()}`;
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
    },
    next: { revalidate: 120 },
  });

  if (!res.ok) {
    throw new Error(`CAL FIRE API error: ${res.status} ${res.statusText}`);
  }

  const raw: CalFireRawIncident[] = await res.json();
  setCache(cacheKey, raw);

  return raw;
}
