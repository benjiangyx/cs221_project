import { describe, it, expect } from "vitest";
import { attachCalFireData, pointInRings, distToRingsKm } from "@/lib/incident-match";
import type { ArcGisPerimeterResult } from "@/lib/arcgis-perimeters";
import type { CalFireRawIncident, EnrichedIncident } from "@/lib/types";

const NOW = Date.parse("2026-11-22T00:00:00Z");
const DAY = 86_400_000;

// ~2 km square around (36.0, -119.0)
const SQUARE = [[[-119.01, 35.99], [-118.99, 35.99], [-118.99, 36.01], [-119.01, 36.01], [-119.01, 35.99]]];

function perimeter(name: string, rings: number[][][], status: string, updated: number): ArcGisPerimeterResult {
  return {
    attributes: {
      OBJECTID: 1, GlobalID: "g", type: "Heat Perimeter", source: "FIRIS",
      poly_DateCurrent: updated, mission: null, incident_name: name, incident_number: "CA-1",
      area_acres: 900, description: null, FireDiscoveryDate: null, CreationDate: null,
      EditDate: null, displayStatus: status,
    },
    geojsonGeometry: { type: "Polygon", coordinates: rings },
    incident: {} as ArcGisPerimeterResult["incident"],
  };
}

function record(name: string, lat: number, lon: number, updated: number, active = true): CalFireRawIncident {
  return {
    UniqueId: name, Name: name, Location: "", Latitude: lat, Longitude: lon, AcresBurned: 1000,
    PercentContained: 40, Started: "", Updated: new Date(updated).toISOString(), AdminUnit: "",
    County: "Tulare", ConditionStatement: null, SearchDescription: null, IsActive: active, Url: "https://x",
  };
}

function cluster(lat: number, lon: number): EnrichedIncident {
  return {
    incident: {
      id: "c", name: "N20 Detection 1", lat, lon, startTimeISO: "", notes: "",
      perimeter: { type: "Point", radiusMeters: 500 }, fuelProxy: "mixed",
    },
    source: "firms", calfire: null, perimeter: null, firms: null, nws: null,
    assets: [],
  };
}

describe("geometry helpers", () => {
  it("point in polygon", () => {
    expect(pointInRings(36.0, -119.0, SQUARE)).toBe(true);
    expect(pointInRings(36.05, -119.0, SQUARE)).toBe(false);
  });
  it("distance to edge", () => {
    // 0.02 deg north of the top edge ~ 2.2 km
    expect(distToRingsKm(36.03, -119.0, SQUARE)).toBeCloseTo(2.21, 1);
  });
});

describe("attachCalFireData", () => {
  it("matches a containing perimeter and the same-named CAL FIRE record", () => {
    const inc = cluster(36.0, -119.0);
    attachCalFireData(
      [inc],
      [perimeter("RIDGE", SQUARE, "Active", NOW - DAY)],
      [record("Other Fire", 36.0, -119.0, NOW), record("Ridge Fire", 36.2, -119.3, NOW)],
      NOW
    );
    expect(inc.perimeter?.acres).toBe(900);
    expect(inc.calfire?.county).toBe("Tulare");
    expect(inc.incident.name).toBe("Ridge Fire");
    expect(inc.source).toBe("merged");
  });

  it("falls back to the nearest CAL FIRE record within 5 km", () => {
    const inc = cluster(36.1, -119.1);
    attachCalFireData([inc], [], [record("Creek Fire", 36.12, -119.1, NOW)], NOW);
    expect(inc.perimeter).toBeNull();
    expect(inc.calfire?.containmentPct).toBe(40);
    expect(inc.incident.name).toBe("Creek Fire");
  });

  it("ignores stale or distant official data", () => {
    const inc = cluster(36.0, -119.0);
    attachCalFireData(
      [inc],
      [perimeter("OLD", SQUARE, "Inactive", NOW - 60 * DAY)],
      [record("Far Fire", 36.5, -119.0, NOW), record("Old Fire", 36.0, -119.0, NOW - 60 * DAY, false)],
      NOW
    );
    expect(inc.perimeter).toBeNull();
    expect(inc.calfire).toBeNull();
    expect(inc.incident.name).toBe("N20 Detection 1");
    expect(inc.source).toBe("firms");
  });
});
