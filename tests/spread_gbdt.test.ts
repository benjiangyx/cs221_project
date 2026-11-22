import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import {
  buildFeatures,
  computeLearnedEnvelopes,
  loadGbdtModel,
  predictRaw,
  envelopePolygon,
  andersonLb,
  type GbdtModel,
} from "../lib/spread-gbdt";
import { distanceKm, pointInPolygon } from "../lib/geo";
import type { Incident, Weather } from "../lib/types";

const model = loadGbdtModel() as GbdtModel;
const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures", "gbdt_parity.json"), "utf8")
) as { features: string[]; rows: (number | null)[][]; predictions: number[] };

const weather: Weather = {
  windSpeedMps: 8.2,
  windGustMps: 12.7,
  windDirDeg: 245,
  temperatureC: 29,
  humidityPct: 18,
};
const incident: Incident = {
  id: "test_001",
  name: "Test Fire",
  lat: 37.42,
  lon: -122.17,
  startTimeISO: "2026-08-13T18:30:00Z",
  perimeter: { type: "Point", radiusMeters: 400 },
  fuelProxy: "grass",
  notes: "Test",
};
const firms = { pointCount: 12, maxFrp: 85, totalFrp: 340 };
const now = new Date("2026-08-13T21:00:00Z");

describe("gbdt-conformal-v1 model file", () => {
  it("loads the exported model with the training feature order", () => {
    expect(model).not.toBeNull();
    expect(model.features).toEqual(fixture.features);
    expect(model.trees.length).toBeGreaterThan(0);
    expect(model.k["0.9"]).toBeGreaterThan(0);
  });

  it("matches sklearn predictions exactly (including missing values)", () => {
    fixture.rows.forEach((row, i) => {
      expect(predictRaw(model, row)).toBeCloseTo(fixture.predictions[i], 9);
    });
  });
});

describe("buildFeatures", () => {
  it("fills every model feature and reports the missing ones", () => {
    const { x, missing } = buildFeatures(model, { incident, weather, firms, now });
    expect(x).toHaveLength(model.features.length);
    expect(missing).toEqual(expect.arrayContaining(["slope_wind", "log_prev_rate"]));
    expect(missing).not.toContain("log_frp_sum");
    expect(x[model.features.indexOf("fuel_class")]).toBe(model.fuel_classes.indexOf("grass"));
  });

  it("marks FIRMS features missing when no satellite summary is given", () => {
    const { missing } = buildFeatures(model, { incident, weather, now });
    expect(missing).toEqual(expect.arrayContaining(["log_frp_sum", "frp_max_t0", "log_n_det"]));
  });
});

describe("computeLearnedEnvelopes", () => {
  const result = computeLearnedEnvelopes({ incident, weather, firms, now }, model)!;

  it("returns 1/2/3 h envelopes labeled with the learned model", () => {
    expect(result.explain.model).toBe("gbdt-conformal-v1");
    expect(result.envelopes.map((e) => e.tHours)).toEqual([1, 2, 3]);
    expect(result.explain.rateKmH).toBeGreaterThan(0);
  });

  it("envelopes contain the incident and grow with time", () => {
    const radii = result.envelopes.map((e) => {
      const ring = e.polygon.coordinates[0];
      expect(pointInPolygon(incident.lat, incident.lon, e.polygon.coordinates)).toBe(true);
      return distanceKm(incident.lat, incident.lon, ring[0][1], ring[0][0]);
    });
    expect(radii[0]).toBeGreaterThan(incident.perimeter.radiusMeters / 1000);
    expect(radii[1]).toBeGreaterThan(radii[0]);
    expect(radii[2]).toBeGreaterThan(radii[1]);
    // radius = r0 + k90 * rate * t
    const expected = 0.4 + model.k["0.9"] * result.explain.rateKmH * 3;
    expect(radii[2]).toBeCloseTo(expected, 2);
  });

  it("explains its evidence and limitations", () => {
    const text = result.explain.notes.join(" ");
    expect(text).toMatch(/Held-out coverage/);
    expect(text).toMatch(/direction was not predictable/);
    expect(text).toMatch(/terrain slope/);
  });

  it("returns null without a model (the route returns a 500)", () => {
    expect(computeLearnedEnvelopes({ incident, weather }, null)).toBeNull();
  });
});

describe("envelopePolygon (rear-focus ellipse grown from a circular footprint)", () => {
  const lat = 36, lon = -119;
  const kmXY = (p: number[]) => {
    // local (east, north) km of a [lon, lat] vertex
    const north = distanceKm(lat, lon, p[1], lon) * Math.sign(p[1] - lat);
    const east = distanceKm(lat, lon, lat, p[0]) * Math.sign(p[0] - lon);
    return [east, north];
  };

  it("L:B = 1 is the circle r0 + head", () => {
    const ring = envelopePolygon(lat, lon, 0.5, 2, 1, 0)[0];
    for (const p of ring) expect(distanceKm(lat, lon, p[1], p[0])).toBeCloseTo(2.5, 3);
  });

  it("matches the ml/ellipse.py score: every boundary point is exactly head distance from the footprint", () => {
    const r0 = 0.8, head = 3, lb = 2.5, bearing = 60;
    const e = Math.sqrt(1 - 1 / lb ** 2);
    const u = [Math.sin((bearing * Math.PI) / 180), Math.cos((bearing * Math.PI) / 180)];
    // footprint: dense samples of the disk boundary (the interior never gives the min)
    const foot = Array.from({ length: 720 }, (_, i) => {
      const a = (2 * Math.PI * i) / 720;
      return [r0 * Math.sin(a), r0 * Math.cos(a)];
    });
    for (const p of envelopePolygon(lat, lon, r0, head, lb, bearing, 36)[0]) {
      const [x, y] = kmXY(p);
      const s = Math.min(
        ...foot.map(([fx, fy]) => {
          const dx = x - fx, dy = y - fy;
          return (Math.hypot(dx, dy) - e * (dx * u[0] + dy * u[1])) / (1 - e);
        })
      );
      expect(s).toBeCloseTo(head, 1);
    }
  });

  it("is elongated downwind: head reaches r0 + head, the rear much less", () => {
    const r0 = 0.5, head = 4, lb = 3;
    const ring = envelopePolygon(lat, lon, r0, head, lb, 90)[0].map(kmXY);
    const maxEast = Math.max(...ring.map((q) => q[0]));
    const minEast = Math.min(...ring.map((q) => q[0]));
    const e = Math.sqrt(1 - 1 / lb ** 2);
    expect(maxEast).toBeCloseTo(r0 + head, 1);
    expect(-minEast).toBeCloseTo(r0 + (head * (1 - e)) / (1 + e), 1);
  });
});

describe("wind_ellipse shape", () => {
  const ell = model.shapes!.wind_ellipse!;

  it("is exported with its own calibrated k and matches sklearn", () => {
    expect(ell.k["0.9"]).toBeGreaterThan(model.k["0.9"]);
    const preds = (fixture as unknown as { wind_ellipse_predictions: number[] }).wind_ellipse_predictions;
    fixture.rows.forEach((row, i) => expect(predictRaw(ell, row)).toBeCloseTo(preds[i], 9));
  });

  it("andersonLb mirrors ml/common.py and is 1 at calm", () => {
    expect(andersonLb(0)).toBeCloseTo(1, 6);
    // u = 8.2 m/s * 2.237 * 0.4 mph
    const u = 8.2 * 2.237 * 0.4;
    expect(andersonLb(8.2)).toBeCloseTo(0.936 * Math.exp(0.2566 * u) + 0.461 * Math.exp(-0.1548 * u) - 0.397, 9);
  });

  it("points downwind and reports its shape; default stays a circle", () => {
    const r = computeLearnedEnvelopes({ incident, weather, firms, now, shape: "wind_ellipse" }, model)!;
    expect(r.explain.shape).toBe("wind_ellipse");
    expect(r.explain.bearingDeg).toBe((weather.windDirDeg + 180) % 360);
    expect(r.explain.lengthToBreadth).toBeGreaterThan(1);
    expect(r.explain.notes.join(" ")).toMatch(/Wind-driven ellipse/);
    const circle = computeLearnedEnvelopes({ incident, weather, firms, now }, model)!;
    expect(circle.explain.shape).toBe("circle");
    expect(circle.explain.lengthToBreadth).toBe(1);
  });
});
