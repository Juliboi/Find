/**
 * Client-side wrapper for the `compose-day` Edge Function. Keeps the
 * store free of Supabase plumbing and gives us a single place to
 * shape / type the request and response.
 *
 * The function is forgiving: it falls back to a deterministic
 * heuristic on the server when OpenAI isn't configured. From the
 * client's perspective, both paths return the same shape — we just
 * apply the picks. If the server itself is unreachable (function not
 * deployed, network error), this returns `null` and the store
 * gracefully degrades to PlanCard's per-card manual picker.
 */
import { isSupabaseConfigured, supabase } from '@/lib/supabase';
import type { NearbyPlace } from '@/lib/places';
import type { LocationPin } from '@/store/useHomeStore';

export interface ComposeDayPlanInput {
  id: string;
  title: string;
  rawText: string;
  startTime?: string;
  durationMinutes: number;
  candidates: NearbyPlace[];
}

export interface ComposeDayRequest {
  plans: ComposeDayPlanInput[];
  context?: {
    home?: LocationPin | null;
    work?: LocationPin | null;
    endOfDay?: LocationPin | null;
    currentLocation?: { latitude: number; longitude: number } | null;
  };
}

export interface ComposeDayPick {
  planId: string;
  placeId: string;
  reasoning: string;
}

export interface ComposeDayResult {
  summary: string;
  picks: ComposeDayPick[];
}

/**
 * Calls the `compose-day` edge function. Returns `null` when the call
 * couldn't be made or the server returned no picks — the store treats
 * either case as "leave plans as-is so the manual picker can run".
 */
export async function composeDayRemote(
  req: ComposeDayRequest,
): Promise<ComposeDayResult | null> {
  if (!isSupabaseConfigured || !supabase) return null;
  // Drop the heavy `debug` payload on each candidate, plus any keys
  // the server doesn't need. Smaller bodies = faster round-trip.
  const trimmed: ComposeDayRequest = {
    plans: req.plans.map((p) => ({
      id: p.id,
      title: p.title,
      rawText: p.rawText,
      startTime: p.startTime,
      durationMinutes: p.durationMinutes,
      candidates: p.candidates.map((c) => ({
        id: c.id,
        name: c.name,
        latitude: c.latitude,
        longitude: c.longitude,
        rating: c.rating,
        ratingCount: c.ratingCount,
        openNow: c.openNow,
        address: c.address,
        types: c.types,
        distanceM: c.distanceM,
        photoUrl: null,
        priceLevel: null,
      })),
    })),
    context: req.context
      ? {
          home: req.context.home
            ? {
                label: req.context.home.label,
                latitude: req.context.home.latitude,
                longitude: req.context.home.longitude,
              }
            : null,
          work: req.context.work
            ? {
                label: req.context.work.label,
                latitude: req.context.work.latitude,
                longitude: req.context.work.longitude,
              }
            : null,
          endOfDay: req.context.endOfDay
            ? {
                label: req.context.endOfDay.label,
                latitude: req.context.endOfDay.latitude,
                longitude: req.context.endOfDay.longitude,
              }
            : null,
          currentLocation: req.context.currentLocation
            ? {
                latitude: req.context.currentLocation.latitude,
                longitude: req.context.currentLocation.longitude,
              }
            : null,
        }
      : undefined,
  };

  try {
    const { data, error } = await supabase.functions.invoke('compose-day', {
      body: trimmed,
    });
    if (error || !data) return null;
    if (typeof data !== 'object') return null;
    const anyData = data as Record<string, unknown>;
    if (!Array.isArray(anyData.picks)) return null;
    const picks: ComposeDayPick[] = [];
    for (const p of anyData.picks as unknown[]) {
      if (!p || typeof p !== 'object') continue;
      const pp = p as Record<string, unknown>;
      if (typeof pp.planId !== 'string') continue;
      if (typeof pp.placeId !== 'string') continue;
      picks.push({
        planId: pp.planId,
        placeId: pp.placeId,
        reasoning: typeof pp.reasoning === 'string' ? pp.reasoning : '',
      });
    }
    return {
      summary: typeof anyData.summary === 'string' ? anyData.summary : '',
      picks,
    };
  } catch (e) {
    console.warn('[compose-day] request failed', e);
    return null;
  }
}
