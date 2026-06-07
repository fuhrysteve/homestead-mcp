/**
 * Local forecast via Pirate Weather (Dark Sky-compatible API). Returns a concise,
 * homestead-relevant summary: current conditions, the next few days, and a frost
 * flag — so Claude can give actionable "cover the tomatoes tonight?" advice.
 */
import type { Env } from "./env.js";

export class WeatherError extends Error {}

interface DailyDatum {
  time: number;
  summary?: string;
  temperatureHigh?: number;
  temperatureLow?: number;
  precipProbability?: number;
  precipType?: string;
}
interface PirateResponse {
  currently?: { summary?: string; temperature?: number; apparentTemperature?: number; windSpeed?: number; precipProbability?: number };
  daily?: { summary?: string; data?: DailyDatum[] };
  alerts?: { title?: string }[];
}

const FROST_F = 36;

function round(n: number | undefined): string {
  return n === undefined ? "?" : String(Math.round(n));
}

function pct(p: number | undefined): string {
  return p === undefined ? "?" : `${Math.round(p * 100)}%`;
}

function weekday(unixSeconds: number, tz: string): string {
  return new Date(unixSeconds * 1000).toLocaleDateString("en-US", { weekday: "short", timeZone: tz });
}

export async function getWeatherSummary(env: Env): Promise<string> {
  const key = env.PIRATE_WEATHER_API_KEY;
  if (!key) throw new WeatherError("Weather is not configured (missing PIRATE_WEATHER_API_KEY).");
  const url =
    `https://api.pirateweather.net/forecast/${encodeURIComponent(key)}/${env.HOME_LAT},${env.HOME_LON}` +
    `?units=us&exclude=minutely,hourly`;
  const res = await fetch(url, { headers: { "User-Agent": "homestead-mcp" } });
  if (!res.ok) throw new WeatherError(`Pirate Weather request failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as PirateResponse;

  const tz = env.HOME_TZ || "America/New_York";
  const lines: string[] = [];
  const now = data.currently;
  if (now) {
    lines.push(
      `Now: ${round(now.temperature)}°F (feels ${round(now.apparentTemperature)}°F), ` +
        `${now.summary ?? "—"}; wind ${round(now.windSpeed)} mph, precip ${pct(now.precipProbability)}.`,
    );
  }

  const days = data.daily?.data ?? [];
  const frostNights: string[] = [];
  days.slice(0, 4).forEach((d, i) => {
    const label = i === 0 ? "Today" : weekday(d.time, tz);
    lines.push(
      `${label}: hi ${round(d.temperatureHigh)} / lo ${round(d.temperatureLow)}°F, ` +
        `precip ${pct(d.precipProbability)}${d.precipType ? ` (${d.precipType})` : ""}.`,
    );
    if (d.temperatureLow !== undefined && d.temperatureLow <= FROST_F) {
      frostNights.push(`${label} (low ${round(d.temperatureLow)}°F)`);
    }
  });

  if (frostNights.length) lines.push(`⚠️ Frost risk: ${frostNights.join(", ")}.`);
  const alerts = (data.alerts ?? []).map((a) => a.title).filter(Boolean);
  if (alerts.length) lines.push(`⚠️ Alerts: ${alerts.join("; ")}.`);
  if (data.daily?.summary) lines.push(`Outlook: ${data.daily.summary}`);

  return `Homestead weather (Huntsburg, OH):\n${lines.join("\n")}`;
}
