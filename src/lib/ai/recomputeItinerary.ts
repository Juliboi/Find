/**
 * Client wrapper around the `recompute-itinerary` edge function.
 *
 * After a user edits the day on-device (swap a venue, lengthen a block), the
 * client already shows an optimistic result via `src/lib/itinerary/edits.ts`.
 * This call refreshes the parts only the backend can compute accurately — real
 * door-to-door travel legs, transit step breakdowns, and map polylines — and
 * re-cascades the clock around them.
 *
 * It degrades gracefully: if Supabase isn't configured or the call fails, it
 * returns the optimistic itinerary unchanged so the edit still "sticks".
 */

import { Itinerary } from '@/types/itinerary';
import { isSupabaseConfigured, supabase } from '@/lib/supabase';
import type { SchedulerContext } from '@/lib/ai/scheduler';
import { sanitizeItinerary } from '@/lib/ai/itinerary';
import { devNow } from '@/store/useDevClockStore';

/**
 * Instant kill-switch. Set `EXPO_PUBLIC_DISABLE_ROUTING=1` in the .env (then
 * reload the app) to skip every recompute call — useful if the routing layer
 * starts misbehaving in production and we need to fall back to the model's
 * estimates without redeploying. Default is "routing on".
 */
const ROUTING_DISABLED = process.env.EXPO_PUBLIC_DISABLE_ROUTING === '1';

function buildContextPayload(
  ctx?: SchedulerContext,
): Record<string, unknown> | undefined {
  if (!ctx) return undefined;
  const out: Record<string, unknown> = {};
  if (ctx.home) {
    out.home = {
      label: ctx.home.label,
      latitude: ctx.home.latitude,
      longitude: ctx.home.longitude,
    };
  }
  if (ctx.work) {
    out.work = {
      label: ctx.work.label,
      latitude: ctx.work.latitude,
      longitude: ctx.work.longitude,
    };
  }
  if (ctx.endOfDay) {
    out.endOfDay = {
      label: ctx.endOfDay.label,
      latitude: ctx.endOfDay.latitude,
      longitude: ctx.endOfDay.longitude,
    };
  }
  // The day's real starting point (picked in the planner setup drawer). Without
  // it the router anchors the first leg to home, so a day that starts elsewhere
  // (a hotel, a friend's place) mis-times its opening commute.
  if (ctx.currentLocation) {
    out.currentLocation = {
      latitude: ctx.currentLocation.latitude,
      longitude: ctx.currentLocation.longitude,
      label: ctx.currentLocation.label ?? undefined,
    };
  }
  // The day's planned opening hour. Seeds the clock cascade when the first block
  // has no time yet (a fresh compose's morning), so the day opens at the user's
  // chosen start instead of the cascade's 08:00 default.
  if (ctx.dayStartTime) out.dayStart = ctx.dayStartTime;
  // The user's sleep time — the day's hard end. Lets the router push an
  // early-landing "Sleep" block to bedtime and fill the evening with wind-down,
  // instead of wrapping the day hours before the user actually goes to bed.
  if (ctx.bedTime) out.bedTime = ctx.bedTime;
  // Car availability today, so the router never forces a car-mode leg the user
  // can't take (and honours a "drive" lock only when it's actually drivable).
  out.car = {
    owns: ctx.hasCar === true,
    useToday: ctx.hasCar === true && ctx.useCarToday !== false,
  };
  return Object.keys(out).length > 0 ? out : undefined;
}

export interface RecomputeResult {
  itinerary: Itinerary;
  /** True when the backend successfully refreshed routes/timing. */
  refreshed: boolean;
}

/**
 * Sends the edited itinerary to the backend for accurate route + clock refresh.
 * Preserves the itinerary's `id` (the edge function only re-routes/re-times).
 * Always resolves — never throws — returning the optimistic input on failure.
 */
export async function recomputeItinerary(
  itinerary: Itinerary,
  context?: SchedulerContext,
): Promise<RecomputeResult> {
  if (ROUTING_DISABLED || !isSupabaseConfigured || !supabase) {
    return { itinerary, refreshed: false };
  }
  try {
    const body: Record<string, unknown> = { itinerary };
    const ctx = buildContextPayload(context);
    if (ctx) body.context = ctx;
    // Let the backend price transit/driving legs for their real departure slot.
    // The device zone is the right one for a "today" plan; guard in case a
    // runtime lacks full Intl tz support.
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (tz) body.timezone = tz;
    } catch {
      // no tz available — backend falls back to time-agnostic routing
    }
    body.now = devNow().toISOString();
    const { data, error } = await supabase.functions.invoke('recompute-itinerary', {
      body,
    });
    if (error || !data || typeof data !== 'object' || !Array.isArray((data as any).sections)) {
      return { itinerary, refreshed: false };
    }
    // ROUTE_DEBUG echo: the backend attaches a per-leg ground-truth trace (exact
    // departure sent to Google, returned duration, and Google's REAL scheduled
    // board/alight times). Surface it in Metro, then it's dropped by sanitize.
    if (__DEV__) {
      const dbg = (data as any).__routeDebug;
      if (Array.isArray(dbg) && dbg.length) {
        console.log(`[route-debug] recompute legs (${dbg.length}):`);
        for (const line of dbg) console.log(`  ${String(line)}`);
      }
    }
    // The edge function strips stray AI-emitted travel cards and appends a
    // synthetic "Back home" item without an id. Run the same sanitiser the
    // planner uses so every new section/item gets a stable id, types are
    // validated, and a server bug can't put the renderer into a bad shape.
    const cleaned = sanitizeItinerary(data);
    if (!cleaned) return { itinerary, refreshed: false };
    return {
      // The server never echoes the plan's baked start, so carry it across
      // explicitly — otherwise the merge would drop where the day begins and
      // the next recompute would fall back to home.
      itinerary: {
        ...itinerary,
        ...cleaned,
        id: itinerary.id,
        startLocation: itinerary.startLocation ?? cleaned.startLocation,
      },
      refreshed: true,
    };
  } catch {
    return { itinerary, refreshed: false };
  }
}
