import { Weather } from "./types";

const OPEN_METEO_BASE = "https://api.open-meteo.com/v1/forecast";

/** Current conditions from Open-Meteo (no API key); falls back to fixed values on failure. */
export async function fetchWeather(
  lat: number,
  lon: number
): Promise<Weather> {
  const params = new URLSearchParams({
    latitude: lat.toString(),
    longitude: lon.toString(),
    current: [
      "wind_speed_10m",
      "wind_gusts_10m",
      "wind_direction_10m",
      "temperature_2m",
      "relative_humidity_2m",
    ].join(","),
    wind_speed_unit: "ms", // default is km/h; Weather uses m/s
  });

  const url = `${OPEN_METEO_BASE}?${params.toString()}`;

  try {
    const res = await fetch(url, { next: { revalidate: 60 } });

    if (!res.ok) {
      throw new Error(`Open-Meteo API error: ${res.status}`);
    }

    const data = await res.json();
    const current = data.current;

    return {
      windSpeedMps: current.wind_speed_10m ?? 5,
      windGustMps: current.wind_gusts_10m ?? 8,
      windDirDeg: current.wind_direction_10m ?? 245,
      temperatureC: current.temperature_2m ?? 25,
      humidityPct: current.relative_humidity_2m ?? 30,
    };
  } catch (error) {
    console.error("Failed to fetch weather, using fallback:", error);
    return {
      windSpeedMps: 8.2,
      windGustMps: 12.7,
      windDirDeg: 245,
      temperatureC: 29,
      humidityPct: 18,
    };
  }
}
