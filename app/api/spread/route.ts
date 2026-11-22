import { NextRequest, NextResponse } from "next/server";
import { computeLearnedEnvelopes, type FirmsSummary, type SpreadShape } from "@/lib/spread-gbdt";
import { Incident, Weather } from "@/lib/types";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      incident,
      weather,
      horizonHours = 3,
      firms,
      shape,
    }: {
      incident: Incident;
      weather: Weather;
      horizonHours?: number;
      firms?: FirmsSummary | null;
      shape?: SpreadShape;
    } = body;

    if (!incident || !weather) {
      return NextResponse.json(
        { error: "Missing incident or weather data" },
        { status: 400 }
      );
    }

    // No fallback: null means the model file is missing or the prediction was non-finite.
    const result = computeLearnedEnvelopes({
      incident,
      weather,
      firms,
      horizonHours,
      // Per-request override; else SPREAD_SHAPE env var, default circle.
      shape: shape === "wind_ellipse" || shape === "circle" ? shape : undefined,
    });
    if (!result) {
      console.error("Spread model unavailable or produced a non-finite prediction");
      return NextResponse.json(
        { error: "Spread model unavailable" },
        { status: 500 }
      );
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error("Error computing spread:", error);
    return NextResponse.json(
      { error: "Failed to compute spread" },
      { status: 500 }
    );
  }
}
