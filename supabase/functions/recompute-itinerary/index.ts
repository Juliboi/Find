// Supabase Edge Function: recompute-itinerary
//
// Takes an itinerary the user just EDITED on the client (a swapped venue, a
// longer block, a removed stop) and refreshes the practical layer the client
// can't compute itself: real door-to-door travel legs (with transit step
// breakdowns + map polylines) between the new coordinates, and the clock
// cascaded around fixed anchors. Same routing/scheduling core as the fresh
// planner — see `../_shared/routing.ts`.
//
// Request body:
//   { itinerary: Itinerary, context?: Context }
//
// Returns the updated Itinerary. When GOOGLE_PLACES_API_KEY is unset it still
// re-cascades the clock from existing leg durations so the day stays coherent.

// deno-lint-ignore-file no-explicit-any
// @ts-nocheck Deno runtime - types resolved by Supabase tooling at deploy time.

import { routeAndSchedule, type Context } from '../_shared/routing.ts';

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

function normalizePin(input: any) {
  if (!input || typeof input !== 'object') return undefined;
  const lat = Number(input.latitude);
  const lon = Number(input.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return undefined;
  return {
    label: typeof input.label === 'string' ? input.label : 'Pin',
    latitude: lat,
    longitude: lon,
  };
}

function normalizeContext(input: any): Context {
  if (!input || typeof input !== 'object') return {};
  const ctx: Context = {};
  const home = normalizePin(input.home);
  if (home) ctx.home = home;
  const work = normalizePin(input.work);
  if (work) ctx.work = work;
  const endOfDay = normalizePin(input.endOfDay);
  if (endOfDay) ctx.endOfDay = endOfDay;
  if (input.currentLocation && typeof input.currentLocation === 'object') {
    const lat = Number(input.currentLocation.latitude);
    const lon = Number(input.currentLocation.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      ctx.currentLocation = {
        latitude: lat,
        longitude: lon,
        label:
          typeof input.currentLocation.label === 'string'
            ? input.currentLocation.label
            : undefined,
      };
    }
  }
  if (input.car && typeof input.car === 'object') {
    ctx.car = {
      owns: input.car.owns === true,
      useToday: input.car.useToday !== false,
    };
  }
  if (typeof input.dayStart === 'string' && /^\d{1,2}:\d{2}$/.test(input.dayStart)) {
    ctx.dayStart = input.dayStart;
  }
  if (typeof input.bedTime === 'string' && /^\d{1,2}:\d{2}$/.test(input.bedTime)) {
    ctx.bedTime = input.bedTime;
  }
  return ctx;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders() });
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  let payload: { itinerary?: any; context?: any; timezone?: any; now?: any };
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  const itinerary = payload.itinerary;
  if (!itinerary || !Array.isArray(itinerary.sections)) {
    return jsonResponse({ error: 'Missing or malformed `itinerary`.' }, 400);
  }
  const context = normalizeContext(payload.context);
  const googleKey = Deno.env.get('GOOGLE_PLACES_API_KEY');

  // Time-aware routing inputs (optional): the client's IANA zone + "now" let us
  // price each transit/driving leg for its real departure slot instead of the
  // moment the request happens to fire.
  const timezone = typeof payload.timezone === 'string' ? payload.timezone : undefined;
  const nowDate = typeof payload.now === 'string' ? new Date(payload.now) : undefined;
  // ROUTE_DEBUG: collect each leg's ground-truth trace so we can echo it back in
  // the response (read in Metro) instead of only the dashboard logs.
  const debugSink: string[] = [];
  const timing = {
    timezone,
    now: nowDate && !Number.isNaN(nowDate.getTime()) ? nowDate : undefined,
    debugSink,
  };

  // Re-route every hop against the (possibly changed) coordinates and cascade
  // the clock. `stripTravel`/`appendBackHome` keep the synthetic "Back home"
  // block idempotent: the previous one is dropped and regenerated only if the
  // day still ends away from home. Best-effort — never fail the request.
  try {
    await routeAndSchedule(
      itinerary,
      context,
      googleKey,
      { stripTravel: true, appendBackHome: true },
      timing,
    );
  } catch (e) {
    return jsonResponse({ error: 'Recompute failed', detail: String(e) }, 500);
  }

  // Attach the ROUTE_DEBUG trace (when enabled) on a throwaway field; the client
  // logs it then drops it via sanitizeItinerary, so it never persists.
  if (debugSink.length) (itinerary as any).__routeDebug = debugSink;
  return jsonResponse(itinerary);
});
