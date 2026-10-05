import { z } from "zod";
import { SkillError, type Skill } from "../skill.js";

type Place = { name: string; country?: string; latitude: number; longitude: number };

/** WMO weather codes, as words she can say. */
const CODES: Record<number, string> = {
  0: "clear sky",
  1: "mostly clear",
  2: "partly cloudy",
  3: "overcast",
  45: "fog",
  48: "freezing fog",
  51: "light drizzle",
  53: "drizzle",
  55: "heavy drizzle",
  56: "freezing drizzle",
  57: "freezing drizzle",
  61: "light rain",
  63: "rain",
  65: "heavy rain",
  66: "freezing rain",
  67: "freezing rain",
  71: "light snow",
  73: "snow",
  75: "heavy snow",
  77: "snow grains",
  80: "light showers",
  81: "showers",
  82: "violent showers",
  85: "snow showers",
  86: "heavy snow showers",
  95: "thunderstorm",
  96: "thunderstorm with hail",
  99: "thunderstorm with heavy hail",
};

/**
 * Weather from Open-Meteo (free, no key). Tier 0: information only. Only the place name
 * leaves the machine.
 */
export function weatherSkill(options: {
  defaultPlace?: string | undefined;
  fetch?: typeof fetch;
}): Skill<{ place?: string | undefined }> {
  const get = options.fetch ?? fetch;
  const places = new Map<string, Place>();

  async function geocode(name: string): Promise<Place> {
    const key = name.toLowerCase().trim();
    const cached = places.get(key);
    if (cached) return cached;
    const url = `https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&format=json&name=${encodeURIComponent(name)}`;
    const res = await get(url);
    if (!res.ok) throw new SkillError("The weather service isn't answering right now.");
    const place = ((await res.json()) as { results?: Place[] }).results?.[0];
    if (!place)
      throw new SkillError(`Couldn't find a place called "${name}". Ask where they mean.`);
    places.set(key, place);
    return place;
  }

  return {
    name: "weather.get",
    description:
      "Current weather plus today's and tomorrow's forecast. Leave `place` out for where the person lives.",
    riskTier: 0,
    schema: z.object({ place: z.string().max(100).optional().describe("City or town") }),
    async execute(args) {
      const name = args.place?.trim() || options.defaultPlace;
      if (!name) throw new SkillError("You don't know where they are yet. Ask which city.");
      const place = await geocode(name);
      const url =
        `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
        "&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m" +
        "&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code" +
        "&timezone=auto&forecast_days=2";
      const res = await get(url);
      if (!res.ok) throw new SkillError("The weather service isn't answering right now.");
      const w = (await res.json()) as {
        current: {
          temperature_2m: number;
          apparent_temperature: number;
          relative_humidity_2m: number;
          weather_code: number;
          wind_speed_10m: number;
        };
        daily: {
          temperature_2m_max: number[];
          temperature_2m_min: number[];
          precipitation_probability_max: number[];
          weather_code: number[];
        };
      };
      const day = (i: number) => ({
        conditions: CODES[w.daily.weather_code[i]!] ?? "mixed",
        high_c: Math.round(w.daily.temperature_2m_max[i]!),
        low_c: Math.round(w.daily.temperature_2m_min[i]!),
        chance_of_rain_percent: w.daily.precipitation_probability_max[i] ?? 0,
      });
      return {
        place: [place.name, place.country].filter(Boolean).join(", "),
        now: {
          conditions: CODES[w.current.weather_code] ?? "mixed",
          temperature_c: Math.round(w.current.temperature_2m),
          feels_like_c: Math.round(w.current.apparent_temperature),
          humidity_percent: Math.round(w.current.relative_humidity_2m),
          wind_kmh: Math.round(w.current.wind_speed_10m),
        },
        today: day(0),
        tomorrow: day(1),
      };
    },
  };
}
