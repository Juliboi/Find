/**
 * Client wrapper around the `adjust-itinerary` edge function.
 *
 * Where `planItinerary` produces a whole new Itinerary from scratch, this call
 * asks the model for a SHORT LIST OF EDIT OPS that realize a user-typed
 * adjustment ("make lunch 30 min longer", "drinks before dinner"). The screen
 * then runs each op through the regular `applyEdit` pipeline so:
 *   - in-place manual edits aren't erased,
 *   - the undo stack covers AI edits the same way it covers manual ones,
 *   - cascading clock / route refresh happens once at the end, not per op.
 *
 * Degrades gracefully: if Supabase isn't configured or the function 501s
 * (missing OPENAI_API_KEY), the result is `{ ops: [], unavailable: true }`
 * so the screen can fall back to the heavier `planItinerary` replan.
 */

import { Itinerary, ItineraryPlace } from '@/types/itinerary';
import { isSupabaseConfigured, supabase } from '@/lib/supabase';
import type { EditOp } from '@/lib/itinerary/edits';

export interface AdjustResult {
  ops: EditOp[];
  /** Optional one-liner the model can include explaining what changed. */
  explanation?: string;
  /** True when the backend wasn't reachable / configured; caller should fall back. */
  unavailable?: boolean;
}

/** Mirrors the edge function's validation; defensive duplicate here so a
 * compromised server can't make the client apply junk ops. */
const ALLOWED_MODES = new Set(['walk', 'bike', 'transit', 'drive']);
const HHMM_RE = /^\d{1,2}:\d{2}$/;

function sanitizeOps(raw: unknown, validIds: Set<string>): EditOp[] {
  if (!Array.isArray(raw)) return [];
  const out: EditOp[] = [];
  for (const op of raw) {
    if (!op || typeof op !== 'object') continue;
    const type = (op as any).type;
    switch (type) {
      case 'setDuration': {
        const id = (op as any).id;
        const minutes = Math.round(Number((op as any).minutes));
        if (typeof id !== 'string' || !validIds.has(id)) break;
        if (!Number.isFinite(minutes) || minutes < 5) break;
        out.push({ type, id, minutes });
        break;
      }
      case 'adjustDuration': {
        const id = (op as any).id;
        const delta = Math.round(Number((op as any).deltaMin));
        if (typeof id !== 'string' || !validIds.has(id)) break;
        if (!Number.isFinite(delta) || delta === 0) break;
        out.push({ type, id, deltaMin: delta });
        break;
      }
      case 'moveTime': {
        const id = (op as any).id;
        const hhmm = (op as any).hhmm;
        if (typeof id !== 'string' || !validIds.has(id)) break;
        if (typeof hhmm !== 'string' || !HHMM_RE.test(hhmm)) break;
        out.push({ type, id, hhmm });
        break;
      }
      case 'remove': {
        const id = (op as any).id;
        if (typeof id !== 'string' || !validIds.has(id)) break;
        out.push({ type, id });
        break;
      }
      case 'setLegMode': {
        const id = (op as any).id;
        const mode = (op as any).mode;
        if (typeof id !== 'string' || !validIds.has(id)) break;
        if (typeof mode !== 'string' || !ALLOWED_MODES.has(mode)) break;
        out.push({ type, id, mode: mode as 'walk' | 'bike' | 'transit' | 'drive' });
        break;
      }
      case 'setDayTransportMode': {
        const mode = (op as any).mode;
        if (typeof mode !== 'string' || !ALLOWED_MODES.has(mode)) break;
        out.push({ type, mode: mode as 'walk' | 'bike' | 'transit' | 'drive' });
        break;
      }
      case 'reorder': {
        const ids = (op as any).orderedIds;
        if (!Array.isArray(ids)) break;
        const cleaned: string[] = [];
        const seen = new Set<string>();
        for (const id of ids) {
          if (typeof id !== 'string' || !validIds.has(id) || seen.has(id)) continue;
          seen.add(id);
          cleaned.push(id);
        }
        if (cleaned.length !== validIds.size) break;
        out.push({ type, orderedIds: cleaned });
        break;
      }
    }
  }
  return out;
}

/**
 * Asks the backend for the ops that satisfy `adjustment` against the current
 * `itinerary`. NEVER throws — returns `unavailable: true` instead so the
 * caller can fall back to the heavier replan path.
 */
export async function requestAdjustOps(
  itinerary: Itinerary,
  adjustment: string,
): Promise<AdjustResult> {
  if (!isSupabaseConfigured || !supabase) {
    return { ops: [], unavailable: true };
  }
  try {
    const { data, error } = await supabase.functions.invoke('adjust-itinerary', {
      body: { itinerary, adjustment },
    });
    if (error || !data || typeof data !== 'object') {
      return { ops: [], unavailable: true };
    }
    const validIds = new Set(
      itinerary.sections.flatMap((s) => s.items.map((i) => i.id)),
    );
    const ops = sanitizeOps((data as { ops?: unknown }).ops, validIds);
    const explanation =
      typeof (data as { explanation?: unknown }).explanation === 'string'
        ? ((data as { explanation: string }).explanation)
        : undefined;
    return { ops, explanation };
  } catch {
    return { ops: [], unavailable: true };
  }
}

// Re-exporting the place type keeps the editing surfaces' imports tidy.
export type { ItineraryPlace };
