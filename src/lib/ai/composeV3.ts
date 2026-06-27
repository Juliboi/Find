/**
 * Client-side wrappers for the experimental **V3 planning pipeline** — a
 * deliberately staged alternative to the single-shot `compose-itinerary` brain,
 * wired behind the planner drawer's "V3" switch for testing.
 *
 * V3 splits the day-planning brain into TWO cheap, focused model calls with
 * deterministic work in between (mirroring the user's mental model):
 *
 *   Phase 2 — {@link orderDay}: a SMALL, token-light ordering pass. Given the
 *     bare list of errands (name, any fixed time, address/area/category) plus
 *     the day frame, it returns ONLY the best geographic ORDER (ids, earliest
 *     first) — no venues, no clock, no scaffolding. Cheapest model.
 *
 *   Phase 5 — {@link fillDay}: the heavy "make it a real day" pass. Given the
 *     already-ordered + located + routed stops (compact) plus the user's rhythm
 *     (wake/bed, meal windows, wind-down), it weaves in the NON-errand
 *     scaffolding (wake, get-ready, meals, wind-down, sleep), fills open
 *     stretches with gaps, and returns a full ORDERED block list in the SAME
 *     {@link ComposedBlock} shape the deterministic assembler already consumes.
 *
 * Like the other AI wrappers these ALWAYS resolve: on any failure they return
 * an empty result so the orchestrator can degrade gracefully (keep the prior
 * order / the un-filled routed day).
 */
import { isSupabaseConfigured, supabase } from '@/lib/supabase';
import { todayISO } from '@/utils/time';
import { logTokenUsage, shapeUsage, type LlmTokenUsage } from '@/lib/usage';
import { shapeBlocks, type ComposedBlock } from '@/lib/ai/composeItinerary';

// ----------------------------------------------------------------------------
// Phase 2 — order-day
// ----------------------------------------------------------------------------

/** One errand handed to the ordering brain, trimmed to the geography-relevant
 *  fields only (to keep the prompt — and the token bill — small). */
export interface OrderDayErrand {
  id: string;
  title: string;
  /** A hard pinned start, "HH:MM" — constrains the order (must stay ascending). */
  startTime?: string | null;
  endTime?: string | null;
  durationMin?: number | null;
  /** A short location label when the errand is placed ("Karlín", a street). */
  address?: string | null;
  /** True when the errand has real coordinates (fixed geography). */
  located: boolean;
}

export interface OrderDayInput {
  errands: OrderDayErrand[];
  dayStart?: { time?: string; label?: string };
  dayEnd?: { time?: string; label?: string };
  home?: { label?: string };
  date?: string;
}

export interface OrderDayResult {
  /** Errand ids, earliest-first. Always a permutation of the input ids. */
  order: string[];
  title: string;
  summary: string;
  city: string;
  usage?: LlmTokenUsage | null;
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}
function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * Reconcile the model's order against the real id set: keep only known ids (in
 * the model's order, de-duplicated), then APPEND any errand it forgot so the
 * order is always a complete permutation — nothing is ever dropped.
 */
function reconcileOrder(modelOrder: string[], known: string[]): string[] {
  const knownSet = new Set(known);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of modelOrder) {
    if (knownSet.has(id) && !seen.has(id)) {
      out.push(id);
      seen.add(id);
    }
  }
  for (const id of known) if (!seen.has(id)) out.push(id);
  return out;
}

/**
 * Run the ordering brain. Resolves to the INPUT order (a safe no-op) whenever
 * the brain is unavailable or returns nothing usable.
 */
export async function orderDay(input: OrderDayInput): Promise<OrderDayResult> {
  const errands = input.errands ?? [];
  const ids = errands.map((e) => e.id);
  const fallback: OrderDayResult = { order: ids, title: '', summary: '', city: '' };

  if (errands.length <= 1) return fallback;
  if (!isSupabaseConfigured || !supabase) return fallback;

  try {
    const { data, error } = await supabase.functions.invoke('order-day', {
      body: {
        errands,
        dayStart: input.dayStart,
        dayEnd: input.dayEnd,
        home: input.home,
        date: input.date ?? todayISO(),
      },
    });
    if (!error && data && typeof data === 'object' && !('error' in (data as object))) {
      const rec = data as Record<string, unknown>;
      const usage = shapeUsage(rec.usage);
      logTokenUsage('order-day', usage);
      return {
        order: reconcileOrder(strList(rec.order), ids),
        title: str(rec.title),
        summary: str(rec.summary),
        city: str(rec.city),
        usage,
      };
    }
    if (error) console.warn('[order-day] function error; keeping input order', error);
  } catch (e) {
    console.warn('[order-day] request failed; keeping input order', e);
  }
  return fallback;
}

// ----------------------------------------------------------------------------
// Phase 5 — fill-day
// ----------------------------------------------------------------------------

/** One already-resolved stop handed to the fill brain. Kept compact: the brain
 *  references it back by `ref` (anchorId for a located stop, taskId for an
 *  at-home one) and must NOT re-discover or move a fixed one. */
export interface FillStop {
  /** Stable id the brain echoes back to keep this stop (the source errand id). */
  ref: string;
  title: string;
  kind?: string;
  /** A hard pinned start the brain must preserve verbatim. */
  startTime?: string | null;
  endTime?: string | null;
  durationMin?: number | null;
  /** The resolved venue name, when the stop has a real place. */
  place?: string | null;
  /** True when the stop has a real venue/coords (→ reference via anchorId). */
  located: boolean;
  /** True for a hard user-pinned time (must not move). */
  fixed: boolean;
}

export interface FillDayInput {
  stops: FillStop[];
  dayStart?: { time?: string; label?: string };
  dayEnd?: { time?: string; label?: string };
  /** The `buildContextPayload` output (wake/bed, meals, wind-down, car…). */
  context?: Record<string, unknown>;
  home?: { label?: string; latitude?: number; longitude?: number };
  date?: string;
  /** "HH:MM" — pass only when planning today and already underway. */
  now?: string;
}

export interface FillDayResult {
  /** The full ordered day, scaffolding woven in (same shape as compose). */
  blocks: ComposedBlock[];
  title: string;
  summary: string;
  city: string;
  usage?: LlmTokenUsage | null;
}

/**
 * Run the gap-fill brain. Resolves to `{ blocks: [] }` (never throws) when the
 * brain is unavailable or returns nothing — the orchestrator then keeps the
 * un-filled (but ordered, located, routed) day from the earlier phases.
 */
export async function fillDay(input: FillDayInput): Promise<FillDayResult> {
  const stops = input.stops ?? [];
  const empty: FillDayResult = { blocks: [], title: '', summary: '', city: '' };
  if (!isSupabaseConfigured || !supabase) return empty;

  // The set of stop refs the brain may attach via `anchorId` (located stops).
  const anchorIds = new Set(stops.filter((s) => s.located).map((s) => s.ref));

  try {
    const { data, error } = await supabase.functions.invoke('fill-day', {
      body: {
        stops,
        dayStart: input.dayStart,
        dayEnd: input.dayEnd,
        context: input.context,
        home: input.home,
        date: input.date ?? todayISO(),
        now: input.now,
      },
    });
    if (!error && data && typeof data === 'object' && !('error' in (data as object))) {
      const rec = data as Record<string, unknown>;
      const usage = shapeUsage(rec.usage);
      logTokenUsage('fill-day', usage);
      return {
        blocks: shapeBlocks(rec.blocks, anchorIds),
        title: str(rec.title),
        summary: str(rec.summary),
        city: str(rec.city),
        usage,
      };
    }
    if (error) console.warn('[fill-day] function error; keeping routed day', error);
  } catch (e) {
    console.warn('[fill-day] request failed; keeping routed day', e);
  }
  return empty;
}
