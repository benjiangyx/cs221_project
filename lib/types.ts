// ===== Core Data Types =====

export interface Incident {
  id: string;
  name: string;
  lat: number;
  lon: number;
  startTimeISO: string;
  perimeter: {
    type: "Point";
    radiusMeters: number;
  };
  fuelProxy: "grass" | "brush" | "mixed" | "chaparral";
  /** Where fuelProxy came from: LANDFIRE raster lookup, or a location-based estimate. */
  fuelSource?: "LANDFIRE" | "estimated";
  notes: string;
}

export interface Weather {
  windSpeedMps: number;
  windGustMps: number;
  windDirDeg: number;
  temperatureC: number;
  humidityPct: number;
}

export interface Asset {
  id: string;
  type: "community" | "infrastructure" | "school" | "hospital";
  name: string;
  lat: number;
  lon: number;
  priority: "high" | "medium" | "low";
}

// ===== Spread Types =====

export interface SpreadEnvelope {
  tHours: number;
  polygon: {
    type: "Polygon";
    coordinates: number[][][];
  };
}

export interface SpreadResult {
  envelopes: SpreadEnvelope[];
  explain: {
    model: string;
    /** Envelope shape; a circle is an ellipse with lengthToBreadth = 1. */
    shape: "circle" | "wind_ellipse";
    lengthToBreadth: number;
    /** Major-axis bearing (deg clockwise from north), null for a circle. */
    bearingDeg: number | null;
    rateKmH: number;
    notes: string[];
  };
}

// ===== CAL FIRE Types =====

export interface CalFireRawIncident {
  UniqueId: string;
  Name: string;
  Location: string;
  Latitude: number;
  Longitude: number;
  AcresBurned: number | null;
  PercentContained: number | null;
  Started: string;
  Updated: string;
  AdminUnit: string;
  County: string;
  ConditionStatement: string | null;
  SearchDescription: string | null;
  IsActive: boolean;
  Url: string;
  // There may be additional fields; these are the ones we use
  [key: string]: unknown;
}

// ===== NWS Types =====

export interface NwsForecastPeriod {
  number: number;
  name: string;
  startTime: string;
  endTime: string;
  isDaytime: boolean;
  temperature: number;
  temperatureUnit: string;
  windSpeed: string;
  windDirection: string;
  shortForecast: string;
  detailedForecast: string;
  relativeHumidity?: { value: number };
}

export interface NwsAlert {
  id: string;
  event: string;
  headline: string;
  severity: string;
  description: string;
}

export interface NwsEnrichment {
  forecastPeriods: NwsForecastPeriod[];
  alerts: NwsAlert[];
  forecastSummary: string;
  hasRedFlagWarning: boolean;
  hasWindAdvisory: boolean;
}

// ===== NASA FIRMS Types =====

export interface FirmsHotspot {
  latitude: number;
  longitude: number;
  brightness: number;
  scan: number;
  track: number;
  acq_date: string; // "YYYY-MM-DD"
  acq_time: string; // "HHMM"
  satellite: string;
  instrument: string;
  confidence: string; // "nominal", "high", "low" or numeric
  version: string;
  bright_t31: number;
  frp: number; // Fire Radiative Power (MW)
  daynight: string; // "D" or "N"
}

export interface FireCluster {
  id: string;
  centroidLat: number;
  centroidLon: number;
  pointCount: number;
  maxFrp: number;
  totalFrp: number;
  lastSeen: string; // ISO string
  radiusMeters: number;
  hotspots: FirmsHotspot[];
  /** Detections from the most recent satellite pass only (model inputs; matches training). */
  latestPass: FirmsPassSummary;
}

/** One satellite pass over a fire: same satellite, consecutive detections <= 20 min apart. */
export interface FirmsPassSummary {
  pointCount: number;
  maxFrp: number;
  totalFrp: number;
  satellite: string;
  time: string; // ISO, newest detection in the pass
}

// ===== Enriched Incident (CAL FIRE + NWS + FIRMS) =====

export interface EnrichedIncident {
  incident: Incident;
  /** Source of this incident data */
  source: "calfire" | "arcgis" | "merged" | "firms";
  calfire: {
    acres: number | null;
    containmentPct: number | null;
    county: string;
    isActive: boolean;
    url: string;
    updatedAt: string;
  } | null;
  /** ArcGIS perimeter data (when available from FIRIS/WFIGS) */
  perimeter: {
    geometry: {
      type: "Polygon";
      coordinates: number[][][];
    } | null;
    acres: number | null;
    displayStatus: string;
    source: string;
    incidentNumber: string | null;
  } | null;
  /** NASA FIRMS cluster metadata (when source is "firms") */
  firms: {
    pointCount: number;
    maxFrp: number;
    totalFrp: number;
    lastSeen: string;
    satellites: string[];
    /** Most recent pass only; this (not the multi-day totals above) feeds the spread model. */
    latestPass: FirmsPassSummary;
  } | null;
  nws: NwsEnrichment | null;
  /** Nearby assets (not yet populated; always empty) */
  assets: Asset[];
}
