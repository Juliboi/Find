/**
 * Client-side wrapper for the `plan-day-v4` Edge Function — the V4 planning
 * brain. ISOLATED, single-call experiment: ONE grounded, high-thinking Gemini
 * pass returns the WHOLE day as a small flat list of blocks already carrying
 * ORDER, TIMES, GAPS, and (for place-less errands) a REAL venue name it found
 * via Google Search.
 *
 * Unlike the v3 compose brain (which stays venue-agnostic and emits placement
 * INTENTS), V4 proposes concrete venues so the order can reason about what's
 * nearby. Those names are still GEOCODED deterministically on the client
 * (`find-places`) — model coordinates are never trusted — and the commute is
 * computed afterward by the routing engine. Like the other AI wrappers this
 * ALWAYS resolves: any failure yields an empty block list so the caller can
 * fall back to another pipeline.
 */
import { isSupabaseConfigured, supabase } from '@/lib/supabase';
import { todayISO } from '@/utils/time';
import { logTokenUsage, shapeUsage, type LlmTokenUsage } from '@/lib/usage';
import type { ComposeAnchorInput, ComposeTaskInput } from '@/lib/ai/composeItinerary';

/** One block of the V4 day — compact on purpose (small token output). */
export interface V4Block {
  /** The source errand id this block IS (anchor or task), else null for a
   *  block the brain generated from free text / daily routine. */
  ref: string | null;
  title: string;
  kind: string;
  /** The brain's intended clock — "HH:MM". The router refines these with real
   *  travel afterward, preserving the spacing the brain laid down. */
  start: string | null;
  end: string | null;
  /** A hard pin (appointment / pinned time / the closing sleep). */
  fixed: boolean;
  /** A REAL venue the brain chose for a place-less errand (geocoded later), else
   *  null for anchors (we keep their place), at-home/online, meals at home, gaps. */
  place: string | null;
  /** The venue's neighbourhood/district, when the brain named one. */
  area: string | null;
  /** Up to 2 other real nearby venues the brain considered — kept for the
   *  "let the user pick later" mode and as swap suggestions. */
  alts: string[];
}

export interface PlanDayV4Input {
  intent: string;
  anchors?: ComposeAnchorInput[];
  tasks?: ComposeTaskInput[];
  dayStart?: { time?: string; label?: string };
  dayEnd?: { time?: string; label?: string };
  /** Full profile context (the `buildContextPayload` output). */
  context?: Record<string, unknown>;
  home?: { label?: string; latitude?: number; longitude?: number };
  date?: string;
  /** "HH:MM" current local time — pass ONLY when the day is today & underway. */
  now?: string;
}

export interface PlanDayV4Result {
  blocks: V4Block[];
  title: string;
  summary: string;
  city: string;
  usage?: LlmTokenUsage | null;
}

function isHHMM(v: unknown): v is string {
  return typeof v === 'string' && /^\d{1,2}:\d{2}$/.test(v.trim());
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/**
 * Re-validate the function's blocks into strict {@link V4Block}s. The server
 * already shapes these; we re-validate defensively so a bad deploy can never
 * feed the assembler a malformed block. `validRefs` is the set of real errand
 * ids — an unknown ref is dropped to null (treated as a generated block).
 */
/**
 * A gap the brain mislabelled as travel ("Travel to Vinohrady", "Commute home",
 * "Drive back", …). The router draws every real door-to-door commute itself, so
 * keeping these would DOUBLE-count travel time. We drop them here as a guardrail
 * (the prompt also forbids them) — genuine free-time gaps ("Coffee break",
 * "Relax", "Free time", "Freshen up") never match and are kept.
 */
const TRAVEL_GAP_RE =
  /\b(travel|commut|transit|en route|on the way|drive (to|home|back)|walk (to|home|back)|head(ing)? (to|home|back)|getting (to|home|around)|trip (to|home|back))\b/i;

/**
 * Same intent for a NON-gap block the brain wrongly emits as a real stop
 * ("Commute home" as kind:"activity", "Travel to the office", "Head back", …).
 * The old filter only caught gap-kind travel, so one of these slipped through
 * and rendered RIGHT BEFORE the router's real homeward leg — the "commute home
 * next to the commute from the gym" double-plan. Tighter than the gap regex on
 * purpose so it can't eat genuine activities: it needs an explicit commute word
 * (commute/en route/in transit), a leading travel verb ("Travel/Drive to …"),
 * or a movement verb aimed straight home/back ("head home", "walk back"). Plain
 * activities like "Head to bed" or "Walk to clear my head" never match.
 */
const TRAVEL_BLOCK_RE =
  /\bcommut\w*\b|\ben route\b|\bin transit\b|\bhomeward\b|\bback home\b|^\s*(?:travel|transit|drive|driving)\b|\b(?:head(?:ing)?|walk(?:ing)?|driv(?:e|ing)|cycl(?:e|ing)|bik(?:e|ing)|go(?:ing)?|return(?:ing)?|travel(?:l?ing)?|mak(?:e|ing)\s+(?:my|your|the)\s+way)\s+(?:home|back)\b/i;

export function shapeV4Blocks(raw: unknown, validRefs: Set<string>): V4Block[] {
  if (!Array.isArray(raw)) return [];
  const out: V4Block[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const rec = r as Record<string, unknown>;
    const title = str(rec.title);
    if (!title) continue;

    const kind = str(rec.kind) ?? 'other';
    const isGap = kind === 'gap';
    const ref = str(rec.ref);
    const place = isGap ? null : str(rec.place);
    // Drop any block that's really a COMMUTE the router will draw itself, so the
    // day never double-plans travel (a "Commute home" card next to the real
    // homeward leg). Only GENERATED blocks (no ref) with no real destination
    // (no place) qualify: a gap that reads as travel, or a non-gap whose title
    // is an unmistakable commute. A real errand/stop is always kept.
    if (!ref && !place) {
      if (isGap && TRAVEL_GAP_RE.test(title)) continue;
      if (!isGap && TRAVEL_BLOCK_RE.test(title)) continue;
    }
    const start = isHHMM(rec.start) ? (rec.start as string).trim() : null;
    let end = isHHMM(rec.end) ? (rec.end as string).trim() : null;
    if (start && end && end < start) end = null;
    const alts: string[] = [];
    if (place && Array.isArray(rec.alts)) {
      for (const a of rec.alts) {
        const s = str(a);
        if (s && s.toLowerCase() !== place.toLowerCase()) alts.push(s.slice(0, 120));
        if (alts.length >= 2) break;
      }
    }

    out.push({
      ref: ref && validRefs.has(ref) ? ref : null,
      title: title.slice(0, 120),
      kind,
      start,
      end,
      fixed: rec.fixed === true,
      place: place ? place.slice(0, 120) : null,
      area: place ? str(rec.area) : null,
      alts,
    });
  }
  return out;
}

/**
 * Run the V4 brain. Resolves to `{ blocks: [] }` (never throws) whenever the
 * brain is unavailable or returns nothing useful, so the caller can fall back.
 */
export async function planDayV4(input: PlanDayV4Input): Promise<PlanDayV4Result> {
  const intent = (input.intent ?? '').trim();
  const anchors = input.anchors ?? [];
  const tasks = input.tasks ?? [];
  const empty: PlanDayV4Result = { blocks: [], title: '', summary: '', city: '' };

  if (!intent && anchors.length === 0 && tasks.length === 0) return empty;
  if (!isSupabaseConfigured || !supabase) return empty;

  const validRefs = new Set<string>([...anchors.map((a) => a.id), ...tasks.map((t) => t.id)]);

  // The grounded full-day call is inherently slow: ~60–90s for a simple day, and
  // a PACKED day with several venue searches climbs toward Supabase's own hard
  // ceiling. That ceiling is the binding constraint: an Edge Function MUST send a
  // response within the platform's 150s request idle-timeout or the gateway
  // returns 504 (see supabase.com/docs/guides/functions/limits). So we sit just
  // UNDER it — waiting the full window because a real V4 plan beats silently
  // degrading to the compose pipeline (the "I picked v4 but got the zig-zag /
  // 5-minute day" bug: the client used to abort at 120s, BEFORE v4 even finished,
  // and fall back). Do NOT raise past ~148s — beyond 150s the platform 504s
  // anyway; if v4 genuinely can't finish in time, make it FASTER (lower
  // GEMINI_V4_THINKING_LEVEL) or move it off the request path (stream / background
  // job), don't grow this number.
  const TIMEOUT_MS = 145_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const startedAt = Date.now();
  const secs = () => ((Date.now() - startedAt) / 1000).toFixed(1);

  try {
    const { data, error } = await supabase.functions.invoke('plan-day-v4', {
      body: {
        intent,
        anchors,
        tasks,
        dayStart: input.dayStart,
        dayEnd: input.dayEnd,
        context: input.context,
        home: input.home,
        date: input.date ?? todayISO(),
        now: input.now,
      },
      signal: controller.signal,
    });
    if (!error && data && typeof data === 'object' && !('error' in (data as object))) {
      const rec = data as Record<string, unknown>;
      const usage = shapeUsage(rec.usage);
      logTokenUsage('plan-day-v4', usage);
      const blocks = shapeV4Blocks(rec.blocks, validRefs);
      const model = (rec.usage as { model?: string } | undefined)?.model ?? '?';
      console.log(`[plan-day-v4] ok in ${secs()}s — ${blocks.length} blocks (model=${model})`);
      return {
        blocks,
        title: str(rec.title) ?? '',
        summary: str(rec.summary) ?? '',
        city: str(rec.city) ?? '',
        usage,
      };
    }
    if (error) {
      // Surface the edge function's actual error body (Gemini detail, missing
      // key, WORKER_RESOURCE_LIMIT timeout, …) so a silent fall-back to v2 is
      // debuggable. supabase-js hangs the Response off `error.context`.
      let detail = '';
      try {
        const ctx = (error as { context?: { text?: () => Promise<string> } }).context;
        if (ctx && typeof ctx.text === 'function') detail = (await ctx.text()).slice(0, 600);
      } catch {
        // best-effort only
      }
      console.warn(
        `[plan-day-v4] function error after ${secs()}s; falling back to v2:`,
        (error as Error)?.message ?? error,
        detail,
      );
    }
  } catch (e) {
    if (controller.signal.aborted) {
      console.warn(
        `[plan-day-v4] TIMED OUT after ${secs()}s (>${TIMEOUT_MS / 1000}s); falling back to v2. ` +
          'The server call is too slow — set GEMINI_V4_THINKING_LEVEL=minimal.',
      );
    } else {
      console.warn(`[plan-day-v4] request failed after ${secs()}s; falling back to v2`, e);
    }
  } finally {
    clearTimeout(timer);
  }
  return empty;
}
