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
    body.now = new Date().toISOString();
    const { data, error } = await supabase.functions.invoke('recompute-itinerary', {
      body,
    });
    if (error || !data || typeof data !== 'object' || !Array.isArray((data as any).sections)) {
      return { itinerary, refreshed: false };
    }
    // The edge function strips stray AI-emitted travel cards and appends a
    // synthetic "Back home" item without an id. Run the same sanitiser the
    // planner uses so every new section/item gets a stable id, types are
    // validated, and a server bug can't put the renderer into a bad shape.
    const cleaned = sanitizeItinerary(data);
    if (!cleaned) return { itinerary, refreshed: false };
    return {
      itinerary: { ...itinerary, ...cleaned, id: itinerary.id },
      refreshed: true,
    };
  } catch {
    return { itinerary, refreshed: false };
  }
}
