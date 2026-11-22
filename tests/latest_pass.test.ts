import { describe, it, expect } from "vitest";
import { latestPassSummary } from "@/lib/cluster";
import type { FirmsHotspot } from "@/lib/types";

function hs(date: string, time: string, satellite: string, frp: number): FirmsHotspot {
  return {
    latitude: 36, longitude: -119, brightness: 330, scan: 0.4, track: 0.4,
    acq_date: date, acq_time: time, satellite, instrument: "VIIRS", confidence: "n",
    version: "2", bright_t31: 290, frp, daynight: "D",
  };
}

describe("latestPassSummary", () => {
  it("keeps only the newest pass: same satellite, gaps <= 20 min", () => {
    const s = latestPassSummary([
      hs("2026-11-20", "2100", "N20", 500), // previous day: excluded
      hs("2026-11-21", "0900", "N", 300), // other satellite, earlier: excluded
      hs("2026-11-21", "2010", "N20", 40), // same satellite, 32 min before 2042: separate pass
      hs("2026-11-21", "2040", "N20", 10),
      hs("2026-11-21", "2042", "N20", 20),
    ]);
    expect(s.pointCount).toBe(2);
    expect(s.totalFrp).toBe(30);
    expect(s.maxFrp).toBe(20);
    expect(s.satellite).toBe("N20");
    expect(s.time).toBe("2026-11-21T20:42:00.000Z");
  });

  it("a single detection is its own pass", () => {
    const s = latestPassSummary([hs("2026-11-21", "1015", "N", 7)]);
    expect(s).toMatchObject({ pointCount: 1, totalFrp: 7, maxFrp: 7 });
  });
});
