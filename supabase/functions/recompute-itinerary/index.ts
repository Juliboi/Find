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
      ctx.currentLocation = { latitude: lat, longitude: lon };
    }
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

  let payload: { itinerary?: any; context?: any };
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

  // Re-route every hop against the (possibly changed) coordinates and cascade
  // the clock. `stripTravel`/`appendBackHome` keep the synthetic "Back home"
  // block idempotent: the previous one is dropped and regenerated only if the
  // day still ends away from home. Best-effort — never fail the request.
  try {
    await routeAndSchedule(itinerary, context, googleKey, {
      stripTravel: true,
      appendBackHome: true,
    });
  } catch (e) {
    return jsonResponse({ error: 'Recompute failed', detail: String(e) }, 500);
  }

  return jsonResponse(itinerary);
});
