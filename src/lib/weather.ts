/**
 * Weather data for the home screen widget.
 *
 * Primary source is the `weather` edge function, which uses Google's Weather
 * API when configured and otherwise Open-Meteo (free, no key). If the edge
 * function isn't reachable (not deployed yet, offline) we fall back to calling
 * Open-Meteo directly from the client — the same graceful-degradation pattern
 * as `geocoding.ts` (Google Places → Nominatim). The widget therefore works
 * out of the box and silently upgrades to Google once the function ships.
 */

import { isSupabaseConfigured, supabase } from '@/lib/supabase';
import type { Coords } from '@/lib/places';

export type WeatherCondition =
  | 'clear'
  | 'partly-cloudy'
  | 'cloudy'
  | 'fog'
  | 'rain'
  | 'snow'
  | 'thunderstorm'
  | 'unknown';

export interface WeatherNow {
  /** Temperature in Celsius (format with `formatTemp` for display). */
  tempC: number;
  feelsLikeC: number | null;
  condition: WeatherCondition;
  /** Human label, e.g. "Light rain" / "Sunny". */
  label: string;
  isDay: boolean;
  /** Chance of precipitation, 0–100, when known. */
  precipProbability: number | null;
  humidity: number | null;
}

export interface WeatherHour {
  /** ISO timestamp for the start of the hour. */
  time: string;
  tempC: number;
  condition: WeatherCondition;
  isDay: boolean;
}

export interface WeatherResult {
  provider: 'google' | 'open-meteo';
  current: WeatherNow;
  hourly: WeatherHour[];
}

export type TempUnit = 'C' | 'F';

const HOURS_AHEAD = 8;

// --------------------------------------------------------------- formatting

function toUnit(tempC: number, unit: TempUnit): number {
  return unit === 'F' ? tempC * (9 / 5) + 32 : tempC;
}

/** Rounded temperature with a degree sign, e.g. "21°". */
export function formatTemp(tempC: number, unit: TempUnit = 'C'): string {
  return `${Math.round(toUnit(tempC, unit))}°`;
}

/** A short hour label for a forecast slot, e.g. "15" in the device's hour. */
export function formatHour(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getHours()}h`;
}

// ----------------------------------------------------------- Open-Meteo (RN)
//
// Mirrors the edge function's normalization so the direct-from-client fallback
// produces the identical shape.

function wmoToCondition(code: number): WeatherCondition {
  if (code === 0 || code === 1) return 'clear';
  if (code === 2) return 'partly-cloudy';
  if (code === 3) return 'cloudy';
  if (code === 45 || code === 48) return 'fog';
  if (code >= 51 && code <= 67) return 'rain';
  if (code >= 71 && code <= 77) return 'snow';
  if (code >= 80 && code <= 82) return 'rain';
  if (code === 85 || code === 86) return 'snow';
  if (code >= 95) return 'thunderstorm';
  return 'unknown';
}

const WMO_LABELS: Record<number, string> = {
  0: 'Clear',
  1: 'Mainly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Rime fog',
  51: 'Light drizzle',
  53: 'Drizzle',
  55: 'Heavy drizzle',
  56: 'Freezing drizzle',
  57: 'Freezing drizzle',
  61: 'Light rain',
  63: 'Rain',
  65: 'Heavy rain',
  66: 'Freezing rain',
  67: 'Freezing rain',
  71: 'Light snow',
  73: 'Snow',
  75: 'Heavy snow',
  77: 'Snow grains',
  80: 'Light showers',
  81: 'Showers',
  82: 'Heavy showers',
  85: 'Snow showers',
  86: 'Snow showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm',
  99: 'Thunderstorm',
};

function wmoLabel(code: number): string {
  return WMO_LABELS[code] ?? 'Weather';
}

async function fetchOpenMeteoDirect(coords: Coords): Promise<WeatherResult | null> {
  const url =
    'https://api.open-meteo.com/v1/forecast' +
    `?latitude=${coords.latitude}&longitude=${coords.longitude}` +
    '&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,weather_code' +
    '&hourly=temperature_2m,weather_code,is_day,precipitation_probability' +
    '&forecast_days=2&timezone=auto';
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data: any = await res.json();
    const c = data?.current;
    const tempC = c?.temperature_2m;
    if (typeof tempC !== 'number') return null;
    const code = typeof c?.weather_code === 'number' ? c.weather_code : 0;

    const times: string[] = Array.isArray(data?.hourly?.time)
      ? data.hourly.time
      : [];
    const temps: number[] = data?.hourly?.temperature_2m ?? [];
    const codes: number[] = data?.hourly?.weather_code ?? [];
    const isDayArr: number[] = data?.hourly?.is_day ?? [];
    const pop: number[] = data?.hourly?.precipitation_probability ?? [];

    const nowKey = typeof c?.time === 'string' ? c.time.slice(0, 13) : '';
    let nowIdx = times.findIndex((t) => t.slice(0, 13) === nowKey);
    if (nowIdx < 0) {
      const nowMs = Date.now();
      nowIdx = times.findIndex((t) => new Date(t).getTime() >= nowMs);
    }
    if (nowIdx < 0) nowIdx = 0;

    const current: WeatherNow = {
      tempC,
      feelsLikeC:
        typeof c?.apparent_temperature === 'number'
          ? c.apparent_temperature
          : null,
      condition: wmoToCondition(code),
      label: wmoLabel(code),
      isDay: c?.is_day !== 0,
      precipProbability: typeof pop[nowIdx] === 'number' ? pop[nowIdx] : null,
      humidity:
        typeof c?.relative_humidity_2m === 'number'
          ? c.relative_humidity_2m
          : null,
    };

    const hourly: WeatherHour[] = [];
    for (let i = nowIdx; i < times.length && hourly.length < HOURS_AHEAD; i++) {
      if (typeof temps[i] !== 'number') continue;
      hourly.push({
        time: times[i],
        tempC: temps[i],
        condition: wmoToCondition(typeof codes[i] === 'number' ? codes[i] : 0),
        isDay: isDayArr[i] !== 0,
      });
    }

    return { provider: 'open-meteo', current, hourly };
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------- main API

function isValidResult(data: any): data is WeatherResult {
  return (
    data &&
    typeof data === 'object' &&
    data.current &&
    typeof data.current.tempC === 'number' &&
    Array.isArray(data.hourly)
  );
}

/**
 * Fetches current + hourly weather for `coords`. Tries the edge function
 * first (Google when configured, else its own Open-Meteo), then falls back to
 * a direct Open-Meteo call. Returns null only when every source fails.
 */
export async function getWeather(coords: Coords): Promise<WeatherResult | null> {
  if (isSupabaseConfigured && supabase) {
    try {
      const { data, error } = await supabase.functions.invoke('weather', {
        body: { latitude: coords.latitude, longitude: coords.longitude },
      });
      if (!error && isValidResult(data)) return data;
    } catch {
      // fall through to the direct call
    }
  }
  return fetchOpenMeteoDirect(coords);
}
