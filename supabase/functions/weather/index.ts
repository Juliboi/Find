// Supabase Edge Function: weather
//
// Current conditions + a short hourly forecast for a coordinate, used by the
// home screen's weather widget.
//
// Provider strategy (mirrors `search-places` → Nominatim):
//   1. Google Weather API (Maps Platform) when a key is configured. This is
//      the same Maps Platform you already use for Places — enable "Weather API"
//      on the project and the existing key works.
//   2. Open-Meteo otherwise (free, no key, no billing). Also used as an
//      automatic fallback if the Google call fails, so the widget never breaks.
//
// Request body:  { latitude: number, longitude: number }
// Response:      { provider, current, hourly } — a provider-agnostic shape the
//                client renders directly (see src/lib/weather.ts).
//
// Secrets (first match wins): GOOGLE_WEATHER_API_KEY, GOOGLE_MAPS_API_KEY,
// GOOGLE_PLACES_API_KEY. When none is set we transparently use Open-Meteo.

// deno-lint-ignore-file no-explicit-any
// @ts-nocheck Deno runtime - types resolved by Supabase tooling at deploy time.

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers':
      'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

// ------------------------------------------------------------ shared shape

type WeatherCondition =
  | 'clear'
  | 'partly-cloudy'
  | 'cloudy'
  | 'fog'
  | 'rain'
  | 'snow'
  | 'thunderstorm'
  | 'unknown';

interface WeatherNow {
  tempC: number;
  feelsLikeC: number | null;
  condition: WeatherCondition;
  label: string;
  isDay: boolean;
  precipProbability: number | null;
  humidity: number | null;
}

interface WeatherHour {
  time: string;
  tempC: number;
  condition: WeatherCondition;
  isDay: boolean;
}

interface WeatherResult {
  provider: 'google' | 'open-meteo';
  current: WeatherNow;
  hourly: WeatherHour[];
}

const HOURS_AHEAD = 8;

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

function labelFor(condition: WeatherCondition): string {
  switch (condition) {
    case 'clear':
      return 'Clear';
    case 'partly-cloudy':
      return 'Partly cloudy';
    case 'cloudy':
      return 'Cloudy';
    case 'fog':
      return 'Fog';
    case 'rain':
      return 'Rain';
    case 'snow':
      return 'Snow';
    case 'thunderstorm':
      return 'Thunderstorm';
    default:
      return 'Weather';
  }
}

// ------------------------------------------------------------------ Google

/** Map Google's rich WeatherCondition.Type enum onto our small set. */
function googleTypeToCondition(type: string | undefined): WeatherCondition {
  const t = (type ?? '').toUpperCase();
  if (!t || t === 'TYPE_UNSPECIFIED') return 'unknown';
  if (t.includes('THUNDERSTORM')) return 'thunderstorm';
  if (t.includes('SNOW') || t.includes('SLEET') || t.includes('FLURRIES'))
    return 'snow';
  if (t.includes('RAIN') || t.includes('SHOWERS') || t.includes('DRIZZLE'))
    return 'rain';
  if (t.includes('FOG') || t.includes('HAZE') || t.includes('MIST'))
    return 'fog';
  if (t === 'CLEAR' || t === 'MOSTLY_CLEAR') return 'clear';
  if (t.includes('CLOUDY') || t === 'WINDY' || t === 'WIND')
    return t === 'PARTLY_CLOUDY' ? 'partly-cloudy' : 'cloudy';
  return 'unknown';
}

function googleDegrees(temp: any): number | null {
  const d = temp?.degrees;
  return typeof d === 'number' ? d : null;
}

async function fetchGoogle(
  lat: number,
  lon: number,
  apiKey: string,
): Promise<WeatherResult> {
  const loc = `location.latitude=${lat}&location.longitude=${lon}`;
  const currentUrl =
    `https://weather.googleapis.com/v1/currentConditions:lookup?key=${apiKey}&${loc}&unitsSystem=METRIC`;
  const hoursUrl =
    `https://weather.googleapis.com/v1/forecast/hours:lookup?key=${apiKey}&${loc}` +
    `&unitsSystem=METRIC&hours=${HOURS_AHEAD}&pageSize=${HOURS_AHEAD}`;

  const [curRes, hourRes] = await Promise.all([
    fetch(currentUrl),
    fetch(hoursUrl),
  ]);
  if (!curRes.ok) {
    const detail = await curRes.text();
    throw new Error(`Google currentConditions ${curRes.status}: ${detail.slice(0, 200)}`);
  }
  const cur = await curRes.json();

  const tempC = googleDegrees(cur?.temperature);
  if (typeof tempC !== 'number') {
    throw new Error('Google currentConditions: missing temperature');
  }
  const condition = googleTypeToCondition(cur?.weatherCondition?.type);
  const description =
    typeof cur?.weatherCondition?.description?.text === 'string'
      ? cur.weatherCondition.description.text
      : labelFor(condition);

  const current: WeatherNow = {
    tempC,
    feelsLikeC: googleDegrees(cur?.feelsLikeTemperature),
    condition,
    label: description,
    isDay: cur?.isDaytime !== false,
    precipProbability:
      typeof cur?.precipitation?.probability?.percent === 'number'
        ? cur.precipitation.probability.percent
        : null,
    humidity:
      typeof cur?.relativeHumidity === 'number' ? cur.relativeHumidity : null,
  };

  const hourly: WeatherHour[] = [];
  if (hourRes.ok) {
    const data = await hourRes.json();
    const rows: any[] = Array.isArray(data?.forecastHours)
      ? data.forecastHours
      : [];
    for (const row of rows) {
      const t = googleDegrees(row?.temperature);
      const start = row?.interval?.startTime;
      if (typeof t !== 'number' || typeof start !== 'string') continue;
      hourly.push({
        time: start,
        tempC: t,
        condition: googleTypeToCondition(row?.weatherCondition?.type),
        isDay: row?.isDaytime !== false,
      });
    }
  }

  return { provider: 'google', current, hourly };
}

// --------------------------------------------------------------- Open-Meteo

/** WMO weather interpretation codes → our condition set. */
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

/** Human label that keeps WMO nuances Google would phrase ("Light rain"). */
function wmoLabel(code: number): string {
  const map: Record<number, string> = {
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
  return map[code] ?? titleCase(labelFor(wmoToCondition(code)));
}

async function fetchOpenMeteo(
  lat: number,
  lon: number,
): Promise<WeatherResult> {
  const url =
    'https://api.open-meteo.com/v1/forecast' +
    `?latitude=${lat}&longitude=${lon}` +
    '&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,weather_code' +
    '&hourly=temperature_2m,weather_code,is_day,precipitation_probability' +
    '&forecast_days=2&timezone=auto';

  const res = await fetch(url);
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Open-Meteo ${res.status}: ${detail.slice(0, 200)}`);
  }
  const data = await res.json();
  const c = data?.current;
  const tempC = c?.temperature_2m;
  if (typeof tempC !== 'number') {
    throw new Error('Open-Meteo: missing current temperature');
  }
  const code = typeof c?.weather_code === 'number' ? c.weather_code : 0;

  const times: string[] = Array.isArray(data?.hourly?.time)
    ? data.hourly.time
    : [];
  const temps: number[] = data?.hourly?.temperature_2m ?? [];
  const codes: number[] = data?.hourly?.weather_code ?? [];
  const isDayArr: number[] = data?.hourly?.is_day ?? [];
  const pop: number[] = data?.hourly?.precipitation_probability ?? [];

  // Align the hourly arrays to "now": Open-Meteo's current.time is rounded to
  // the hour, so we find the matching hour and read upcoming entries after it.
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
    precipProbability:
      typeof pop[nowIdx] === 'number' ? pop[nowIdx] : null,
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
}

// -------------------------------------------------------- handler entrypoint

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders() });
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  let payload: { latitude?: number; longitude?: number };
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  const lat = Number(payload.latitude);
  const lon = Number(payload.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return jsonResponse({ error: 'latitude and longitude are required' }, 400);
  }

  const apiKey =
    Deno.env.get('GOOGLE_WEATHER_API_KEY') ||
    Deno.env.get('GOOGLE_MAPS_API_KEY') ||
    Deno.env.get('GOOGLE_PLACES_API_KEY');

  if (apiKey) {
    try {
      return jsonResponse(await fetchGoogle(lat, lon, apiKey));
    } catch (_e) {
      // Google failed (key not enabled for Weather, quota, upstream error) —
      // fall through to the free provider so the widget still renders.
    }
  }

  try {
    return jsonResponse(await fetchOpenMeteo(lat, lon));
  } catch (e) {
    return jsonResponse({ error: 'Weather lookup failed', detail: String(e) }, 502);
  }
});
