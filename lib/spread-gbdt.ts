import fs from "fs";
import path from "path";
import { destinationPoint } from "./geo";
import type { Incident, SpreadEnvelope, SpreadResult, Weather } from "./types";

/**
 * Learned spread envelope (gbdt-conformal-v1). GBDT trained in ml/ predicts growth rate; the 90%
 * envelope at t hours is the footprint grown by a rear-focus ellipse with head distance
 * k90 * rate * t (k90 from split-conformal calibration on held-out fires). Default is a circle:
 * direction wasn't predictable from reanalysis winds and every calibrated ellipse was larger at
 * equal coverage. SPREAD_SHAPE=wind_ellipse switches to the head-rate + Anderson ellipse variant.
 */

type TreeNode =
  | { leaf: number }
  | { f: number; l: number; r: number; m: boolean; t?: number; cats?: number[] };

export interface GbdtModel {
  model: string;
  rate_eps: number;
  features: string[];
  fuel_classes: string[];
  baseline: number;
  trees: { nodes: TreeNode[] }[];
  k: Record<string, number>;
  eval: {
    calibration_fires: number;
    test_fires: number;
    test_coverage90: number;
    holdout_2025_fires: number;
    holdout_2025_coverage90: number;
    direction_median_err_deg_downwind: number;
  };
  /** Optional alternative envelope shapes (same features; own rate trees and calibration). */
  shapes?: {
    wind_ellipse?: {
      description: string;
      baseline: number;
      trees: { nodes: TreeNode[] }[];
      k: Record<string, number>;
      lb_max: number;
      midflame_factor: number;
      eval: {
        test_coverage90: number;
        holdout_2025_coverage90: number;
        test_area_vs_circle: number;
        holdout_2025_area_vs_circle: number;
      };
    };
  };
}

/** "circle" is the deployed model; "wind_ellipse" had ~2x the area at equal coverage in evaluation. */
export type SpreadShape = "circle" | "wind_ellipse";

export function defaultSpreadShape(): SpreadShape {
  return process.env.SPREAD_SHAPE === "wind_ellipse" ? "wind_ellipse" : "circle";
}

/** FRP and detection count from ONE satellite pass (the model's *_t0 features are per pass). */
export interface FirmsSummary {
  pointCount: number;
  maxFrp: number;
  totalFrp: number;
  satellite?: string;
  time?: string; // ISO time of the pass
}

export interface LearnedSpreadInput {
  incident: Incident;
  weather: Weather;
  firms?: FirmsSummary | null;
  /** Terrain rise/run along the downwind direction, if known. */
  slopeAlongWind?: number | null;
  horizonHours?: number;
  now?: Date;
  /** Envelope shape; defaults to defaultSpreadShape() (circle unless SPREAD_SHAPE is set). */
  shape?: SpreadShape;
}

const MODEL_PATH = path.join(process.cwd(), "data", "models", "spread_gbdt.json");
let cached: GbdtModel | null | undefined;

/** Load the exported model once; null if the file is missing or unreadable. */
export function loadGbdtModel(): GbdtModel | null {
  if (cached !== undefined) return cached;
  try {
    cached = JSON.parse(fs.readFileSync(MODEL_PATH, "utf8")) as GbdtModel;
  } catch {
    cached = null;
  }
  return cached;
}

/** Raw model output (log-rate) for one feature vector; null entries are missing values. */
export function predictRaw(
  model: { baseline: number; trees: { nodes: TreeNode[] }[] },
  x: (number | null)[]
): number {
  let out = model.baseline;
  for (const tree of model.trees) {
    const nodes = tree.nodes;
    let node = nodes[0];
    while (!("leaf" in node)) {
      const v = x[node.f];
      let goLeft: boolean;
      if (v === null || Number.isNaN(v)) goLeft = node.m;
      else if (node.cats) goLeft = node.cats.includes(Math.round(v));
      else goLeft = v <= (node.t as number);
      node = nodes[goLeft ? node.l : node.r];
    }
    out += node.leaf;
  }
  return out;
}

/** Fuel proxy -> training fuel class (grass / shrub / timber). */
const FUEL_CLASS: Record<Incident["fuelProxy"], string> = {
  grass: "grass",
  brush: "shrub",
  chaparral: "shrub",
  mixed: "timber",
};

/** Saturation vapor-pressure deficit (kPa) from temperature (C) and RH (%). */
function vpdKpa(tempC: number, rhPct: number): number {
  const es = 0.6108 * Math.exp((17.27 * tempC) / (tempC + 237.3));
  return es * (1 - rhPct / 100);
}

/** Feature vector in the model's order (see ml/common.py FEATURES). */
export function buildFeatures(
  model: GbdtModel,
  input: LearnedSpreadInput
): { x: (number | null)[]; missing: string[] } {
  const { incident, weather, firms } = input;
  const now = input.now ?? new Date();
  const localSolarHour =
    (((now.getUTCHours() + now.getUTCMinutes() / 60 + incident.lon / 15) % 24) + 24) % 24;
  const radiusKm = incident.perimeter.radiusMeters / 1000;

  const values: Record<string, number | null> = {
    wind_ms: weather.windSpeedMps,
    gust_max_ms: weather.windGustMps,
    rh_pct: weather.humidityPct,
    temp_c: weather.temperatureC,
    vpd_kpa: vpdKpa(weather.temperatureC, weather.humidityPct),
    slope_wind: input.slopeAlongWind ?? null,
    hour_sin: Math.sin((2 * Math.PI * localSolarHour) / 24),
    hour_cos: Math.cos((2 * Math.PI * localSolarHour) / 24),
    month: now.getUTCMonth() + 1,
    log_foot_area: Math.log1p(Math.PI * radiusKm * radiusKm),
    fuel_class: model.fuel_classes.indexOf(FUEL_CLASS[incident.fuelProxy] ?? "timber"),
    log_frp_sum: firms ? Math.log1p(firms.totalFrp) : null,
    frp_max_t0: firms ? firms.maxFrp : null,
    log_n_det: firms ? Math.log1p(firms.pointCount) : null,
    log_prev_rate: null, // last observed growth between passes: not tracked live yet
    night_t0: localSolarHour < 6 || localSolarHour >= 18 ? 1 : 0,
  };
  const x = model.features.map((f) => (f in values ? values[f] : null));
  const missing = model.features.filter((f) => values[f] === null || values[f] === undefined);
  return { x, missing };
}

/** Anderson (1983) length-to-breadth from 10 m wind (m/s); mirrors anderson_lb in ml/common.py. */
export function andersonLb(windMps: number, midflameFactor = 0.4, lbMax = 8): number {
  const u = windMps * 2.237 * midflameFactor; // midflame wind, mph
  const lb = 0.936 * Math.exp(0.2566 * u) + 0.461 * Math.exp(-0.1548 * u) - 0.397;
  return Math.min(Math.max(lb, 1), lbMax);
}

/**
 * Circular footprint (r0Km) grown by a rear-focus ellipse (headKm, lb, major axis toward
 * bearingDeg): the Minkowski sum from ml/ellipse.py, so it matches what was calibrated.
 * lb = 1 gives a circle of radius r0Km + headKm. Returns [lon, lat] rings.
 */
export function envelopePolygon(
  lat: number,
  lon: number,
  r0Km: number,
  headKm: number,
  lb = 1,
  bearingDeg = 0,
  n = 72
): number[][][] {
  const e = Math.sqrt(1 - 1 / (Math.max(lb, 1) ** 2));
  const a = headKm / (1 + e); // semi-major
  const b = a / Math.max(lb, 1); // semi-minor
  const c = a * e; // ellipse center sits c ahead of the rear focus
  const t = (bearingDeg * Math.PI) / 180;
  const u = [Math.sin(t), Math.cos(t)]; // major axis (east, north)
  const v = [u[1], -u[0]];

  const ring: number[][] = [];
  for (let i = 0; i <= n; i++) {
    const phi = (2 * Math.PI * i) / n;
    const nx = Math.sin(phi), ny = Math.cos(phi); // outward normal (east, north)
    const nu = nx * u[0] + ny * u[1];
    const nv = nx * v[0] + ny * v[1];
    const s = Math.sqrt(a * a * nu * nu + b * b * nv * nv) || 1;
    // support point of footprint disk + support point of the ellipse in direction n
    const east = r0Km * nx + c * u[0] + (a * a * nu * u[0] + b * b * nv * v[0]) / s;
    const north = r0Km * ny + c * u[1] + (a * a * nu * u[1] + b * b * nv * v[1]) / s;
    const dist = Math.hypot(east, north);
    const brg = (Math.atan2(east, north) * 180) / Math.PI;
    const [la, lo] = destinationPoint(lat, lon, (brg + 360) % 360, dist);
    ring.push([lo, la]);
  }
  return [ring];
}

const MISSING_LABEL: Record<string, string> = {
  slope_wind: "terrain slope",
  log_prev_rate: "last observed growth",
  log_frp_sum: "FIRMS fire intensity",
  frp_max_t0: "FIRMS fire intensity",
  log_n_det: "FIRMS detections",
};

/** Learned 1..H hour 90% envelopes; null if the model is missing or the prediction non-finite. */
export function computeLearnedEnvelopes(
  input: LearnedSpreadInput,
  model: GbdtModel | null = loadGbdtModel()
): SpreadResult | null {
  if (!model) return null;
  const { incident, weather } = input;
  const horizon = input.horizonHours ?? 3;
  const requested = input.shape ?? defaultSpreadShape();
  const ell = requested === "wind_ellipse" ? model.shapes?.wind_ellipse : undefined;
  const shape: SpreadShape = ell ? "wind_ellipse" : "circle"; // fall back if not exported
  const { x, missing } = buildFeatures(model, input);

  // Circle: radial rate trees + k. Ellipse: head-rate trees + its own k, Anderson L:B downwind.
  const rate = Math.max(Math.exp(predictRaw(ell ?? model, x)) - model.rate_eps, 1e-3); // km/h
  const k90 = (ell ?? model).k["0.9"];
  const lb = ell ? andersonLb(weather.windSpeedMps, ell.midflame_factor, ell.lb_max) : 1;
  const bearingDeg = ell ? (weather.windDirDeg + 180) % 360 : 0; // downwind; windDirDeg is "from"
  const r0 = incident.perimeter.radiusMeters / 1000;
  if (!Number.isFinite(rate) || !Number.isFinite(k90) || !Number.isFinite(lb)) return null;

  const envelopes: SpreadEnvelope[] = [];
  const radii: string[] = [];
  for (let t = 1; t <= horizon; t++) {
    const grow = k90 * rate * t; // radial growth (circle) or head distance (ellipse)
    radii.push(`+${grow.toFixed(2)}`);
    envelopes.push({
      tHours: t,
      polygon: {
        type: "Polygon",
        coordinates: envelopePolygon(incident.lat, incident.lon, r0, grow, lb, bearingDeg),
      },
    });
  }

  const ev = model.eval;
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const missingNames = [...new Set(missing.map((f) => MISSING_LABEL[f] ?? f))];
  const hours = envelopes.map((e) => `${e.tHours}h`).join(" / ");
  const notes = [
    ell
      ? `Learned head rate: ${rate.toFixed(2)} km/h (gradient-boosted trees on VIIRS satellite growth)`
      : `Learned growth rate: ${rate.toFixed(2)} km/h (gradient-boosted trees on VIIRS satellite growth)`,
    ell
      ? `90% envelope head grows ${radii.join(" / ")} km downwind at ${hours} (k90 = ${k90.toFixed(2)})`
      : `90% envelope grows ${radii.join(" / ")} km at ${hours} (k90 = ${k90.toFixed(2)})`,
    ell
      ? `Held-out coverage: ${pct(ell.eval.test_coverage90)} on ${ev.test_fires} test fires, ${pct(ell.eval.holdout_2025_coverage90)} on ${ev.holdout_2025_fires} fires from 2025`
      : `Held-out coverage: ${pct(ev.test_coverage90)} on ${ev.test_fires} test fires, ${pct(ev.holdout_2025_coverage90)} on ${ev.holdout_2025_fires} fires from 2025`,
    `Inputs: wind ${weather.windSpeedMps.toFixed(1)} m/s, RH ${Math.round(weather.humidityPct)}%, ${FUEL_CLASS[incident.fuelProxy]} fuel (${incident.fuelSource === "LANDFIRE" ? "LANDFIRE" : "estimated from location"})` +
      (input.firms
        ? `, FRP ${Math.round(input.firms.totalFrp)} MW from ${input.firms.pointCount} detections in the latest pass` +
          (input.firms.satellite && input.firms.time
            ? ` (${input.firms.satellite}, ${new Date(input.firms.time).toISOString().slice(11, 16)} UTC)`
            : "")
        : ""),
    ...(missingNames.length ? [`Not available (model uses typical values): ${missingNames.join(", ")}`] : []),
    ell
      ? `Wind-driven ellipse: L:B ${lb.toFixed(2)} toward ${Math.round(bearingDeg)}° (Anderson shape); about ${ell.eval.test_area_vs_circle.toFixed(1)}× the circle's area at equal coverage, and spread direction was ${Math.round(ev.direction_median_err_deg_downwind)}° off downwind (median)`
      : `Circular envelope: spread direction was not predictable from weather data (median ${Math.round(ev.direction_median_err_deg_downwind)}° off downwind)`,
    "Calibrated on ~12 h satellite pass pairs; 1-3 h radii are linear extrapolation",
  ];

  return {
    envelopes,
    explain: { model: model.model, shape, lengthToBreadth: lb, bearingDeg: ell ? bearingDeg : null, rateKmH: rate, notes },
  };
}
