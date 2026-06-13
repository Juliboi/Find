/**
 * Client-side wrapper for the `decompose-intent` Edge Function — the planning
 * BRAIN. It turns the planner's free-text field (and any vague / no-place
 * errands) into a small list of concrete, neighbourhood-aware ITEMS the rest of
 * the pipeline can resolve into real venues and schedule.
 *
 * Like {@link parseErrandRemote}, this ALWAYS resolves to a usable value: if
 * Supabase isn't configured, the function is down, or the model errors, it
 * returns an EMPTY item list so the caller falls back to today's behaviour
 * (free-text handed to the base planner as STYLE/NOTES). The brain is purely an
 * upgrade when it's available — never a hard dependency of planning.
 */
import { isSupabaseConfigured, supabase } from '@/lib/supabase';
import { todayISO } from '@/utils/time';
import { logTokenUsage, shapeUsage, type LlmTokenUsage } from '@/lib/usage';

/** How a decomposed item should get a location. */
export type DecomposePlacement = 'find' | 'colocate' | 'home';

/** One concrete stop / at-home activity the brain pulled out of the free text. */
export interface DecomposedItem {
  title: string;
  kind: string;
  /** Rough length in minutes from an explicit hint ("2 hours"), else null. */
  durationMin: number | null;
  /** Explicit clock time only; null lets the planner decide timing. */
  startTime: string | null;
  endTime: string | null;
  placement: DecomposePlacement;
  /** placement="find": a neighbourhood-aware search ("Max Fitness gym, Karlín"). */
  query: string | null;
  /** The area the brain clustered this into ("Karlín"), when known. */
  area: string | null;
  /** placement="colocate": the id of the located anchor to share a venue with. */
  colocateWith: string | null;
  /** Set when this item reformats an existing vague errand (its id). */
  sourceId: string | null;
  notes: string | null;
}

/** A located stop handed to the brain as fixed geography to cluster around. */
export interface DecomposeAnchor {
  id: string;
  title: string;
  area?: string;
  address?: string;
  latitude?: number;
  longitude?: number;
}

/** A vague / unplaced errand the brain should reformat into a better query. */
export interface DecomposeUnresolved {
  id: string;
  title: string;
  placeQuery?: string;
}

export interface DecomposeInput {
  /** The free-text field the user typed for the day. */
  intent: string;
  anchors?: DecomposeAnchor[];
  unresolved?: DecomposeUnresolved[];
  dayStart?: { time?: string; label?: string };
  dayEnd?: { time?: string; label?: string };
  /** Full profile context (the `buildContextPayload` output). */
  context?: Record<string, unknown>;
  home?: { label?: string; latitude?: number; longitude?: number };
  date?: string;
}

export interface DecomposeResult {
  items: DecomposedItem[];
  /** Token spend the function reported; null offline or when no model ran. */
  usage?: LlmTokenUsage | null;
}

const PLACEMENTS: DecomposePlacement[] = ['find', 'colocate', 'home'];

function isHHMM(v: unknown): v is string {
  return typeof v === 'string' && /^\d{1,2}:\d{2}$/.test(v.trim());
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/**
 * Validate the function's items into strict {@link DecomposedItem}s. The server
 * already shapes these, but we re-validate defensively (a server bug or an old
 * deploy must never feed React a malformed item) and keep the same
 * placement-consistency invariants the orchestrator relies on.
 */
function shapeItems(raw: unknown, anchorIds: Set<string>): DecomposedItem[] {
  if (!Array.isArray(raw)) return [];
  const out: DecomposedItem[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const rec = r as Record<string, unknown>;
    const title = str(rec.title);
    if (!title) continue;

    let placement: DecomposePlacement = PLACEMENTS.includes(
      rec.placement as DecomposePlacement,
    )
      ? (rec.placement as DecomposePlacement)
      : 'find';
    let query = str(rec.query);
    let colocateWith = str(rec.colocateWith);

    if (placement === 'colocate' && (!colocateWith || !anchorIds.has(colocateWith))) {
      placement = query ? 'find' : 'home';
      colocateWith = null;
    }
    if (placement === 'find' && !query) placement = 'home';
    if (placement !== 'colocate') colocateWith = null;
    if (placement !== 'find') query = null;

    const startTime = isHHMM(rec.startTime) ? (rec.startTime as string).trim() : null;
    const endTime = startTime && isHHMM(rec.endTime) ? (rec.endTime as string).trim() : null;

    out.push({
      title: title.slice(0, 120),
      kind: str(rec.kind) ?? 'other',
      durationMin: num(rec.durationMin),
      startTime,
      endTime,
      placement,
      query: query ? query.slice(0, 160) : null,
      area: str(rec.area),
      colocateWith,
      sourceId: str(rec.sourceId),
      notes: str(rec.notes),
    });
  }
  return out;
}

/**
 * Run the brain decompose. Resolves to `{ items: [] }` (never throws) whenever
 * the brain is unavailable or returns nothing useful, so planning degrades
 * gracefully to its pre-brain behaviour.
 */
export async function decomposeIntent(input: DecomposeInput): Promise<DecomposeResult> {
  const intent = (input.intent ?? '').trim();
  const anchors = input.anchors ?? [];
  const unresolved = input.unresolved ?? [];

  // Nothing for the brain to do — skip the call entirely.
  if (!intent && unresolved.length === 0) return { items: [] };
  if (!isSupabaseConfigured || !supabase) return { items: [] };

  const anchorIds = new Set(anchors.map((a) => a.id));

  try {
    const { data, error } = await supabase.functions.invoke('decompose-intent', {
      body: {
        intent,
        anchors,
        unresolved,
        dayStart: input.dayStart,
        dayEnd: input.dayEnd,
        context: input.context,
        home: input.home,
        date: input.date ?? todayISO(),
      },
    });
    if (!error && data && typeof data === 'object' && !('error' in (data as object))) {
      const items = shapeItems((data as Record<string, unknown>).items, anchorIds);
      const usage = shapeUsage((data as Record<string, unknown>).usage);
      logTokenUsage('decompose-intent', usage);
      return { items, usage };
    }
    if (error) {
      console.warn('[decompose-intent] function error, treating free-text as notes', error);
    }
  } catch (e) {
    console.warn('[decompose-intent] request failed, treating free-text as notes', e);
  }
  return { items: [] };
}
