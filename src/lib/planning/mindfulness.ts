/**
 * "Mindfulness" scoring for a day's plan.
 *
 * Given the day's usable window (wake → sleep, or a plan's start → end) and the
 * errands that fall on it, this answers one practical question: *does the day
 * breathe?* It does three things the planner cares about, all framework-free and
 * side-effect-free so the homepage widget, the plan drawer, and any future
 * surface can share one source of truth:
 *
 *   1. Fits the work into the window — sums every errand's length and checks it
 *      against the minutes between the day's start and the user's "sleep by".
 *   2. Estimates travel — when errands carry real coordinates, it walks them in
 *      time order (optionally bookended by where the day starts/ends) and adds a
 *      rough door-to-door estimate for each hop (see `@/lib/travel`).
 *   3. Rewards gaps — a day packed back-to-back reads as stressful; comfortable
 *      buffers between timed commitments read as calm.
 *
 * The result is a 0–100 score (higher = calmer), the leftover free time, and a
 * small breakdown the UI renders. Unticking an errand and re-scoring is how the
 * drawer lets the user feel whether a lighter day is "better".
 */
import type { Errand } from '@/store/useErrandsStore';
import { estimateTravel } from '@/lib/travel';
import { formatDuration, minutesOfDay } from '@/utils/time';

export interface Coords {
  latitude: number;
  longitude: number;
}

export interface DayScoreInput {
  /** Window start "HH:MM" (e.g. wake time, or now for today). */
  startTime: string | null | undefined;
  /** Window end "HH:MM" (e.g. the user's "sleep by" / plan end). */
  endTime: string | null | undefined;
  /** The day's errands (or the selected subset). Done ones are ignored. */
  errands: Errand[];
  /** Where the day starts — anchors the first travel hop. Usually home / GPS. */
  startAnchor?: Coords | null;
  /** Where the day ends — anchors the last travel hop back. Usually home. */
  endAnchor?: Coords | null;
}

/** Calmest → busiest. Drives the label + colour the UI shows. */
export type MindfulnessLevel =
  | 'serene'
  | 'balanced'
  | 'busy'
  | 'packed'
  | 'overloaded';

export interface DayScore {
  /** 0–100. Higher = more breathing room / a calmer day. */
  score: number;
  level: MindfulnessLevel;
  /** Minutes between the window's start and end (the usable day). */
  availableMin: number;
  /** Sum of every counted errand's length. */
  committedMin: number;
  /** Estimated travel minutes across located errands (+ anchors). */
  travelMin: number;
  /** `availableMin − committedMin − travelMin`. Negative ⇒ overbooked. */
  freeMin: number;
  /** True when commitments + travel fit inside the window. */
  fits: boolean;
  /** Errands that counted toward the load (not done). */
  errandCount: number;
  /** Located errands used for the travel estimate. */
  locatedCount: number;
  /** Timed transitions with little/no buffer (rushed or overlapping). */
  tightTransitions: number;
}

/** Length we assume for a timed errand that gave no end time or duration. */
const DEFAULT_TIMED_MIN = 60;
/** Length we assume for a loose "anytime" reminder with no duration. */
const DEFAULT_UNTIMED_MIN = 20;
/** A transition shorter than this (after travel) reads as rushed. */
const COMFORT_GAP_MIN = 15;
/**
 * Below this share of the window the day reads as fully serene; at/above a full
 * window it reads as 0 for the "fit" component. (35% busy ⇒ relaxed.)
 */
const SERENE_RATIO = 0.35;
/** Travel eating this share of your occupied time reads as a hectic day. */
const TRAVEL_HEAVY_SHARE = 0.5;

const W_FIT = 0.5;
const W_GAP = 0.3;
const W_TRAVEL = 0.2;

const DAY_MIN = 24 * 60;

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function clamp01(n: number): number {
  return clamp(n, 0, 1);
}

/**
 * How long one errand occupies the day. Prefers an explicit duration, then a
 * start→end span, then a sensible default by kind (a timed block vs a loose
 * reminder). For a "between" availability window this is the *work* length
 * (`durationMin`), not the width of the window.
 */
export function errandLoadMin(e: Errand): number {
  if (e.durationMin && e.durationMin > 0) return e.durationMin;
  const start = minutesOfDay(e.startTime);
  const end = minutesOfDay(e.endTime);
  if (start != null && end != null && end > start) return end - start;
  return start != null ? DEFAULT_TIMED_MIN : DEFAULT_UNTIMED_MIN;
}

function hasCoords(
  e: Errand,
): e is Errand & { latitude: number; longitude: number } {
  return e.latitude != null && e.longitude != null;
}

/**
 * Estimate total travel across the day's located errands, in time order, with
 * optional anchors for where the day starts and ends. A single located errand
 * with both anchors is a there-and-back trip; with none it's a free 0 (nothing
 * to travel between).
 */
function travelLoad(
  errands: Errand[],
  startAnchor?: Coords | null,
  endAnchor?: Coords | null,
): { travelMin: number; locatedCount: number } {
  const located = errands.filter(hasCoords).sort((a, b) => {
    const am = minutesOfDay(a.startTime) ?? Number.POSITIVE_INFINITY;
    const bm = minutesOfDay(b.startTime) ?? Number.POSITIVE_INFINITY;
    return am - bm;
  });
  if (located.length === 0) return { travelMin: 0, locatedCount: 0 };

  const stops: Coords[] = [];
  if (startAnchor) stops.push(startAnchor);
  for (const e of located) {
    stops.push({ latitude: e.latitude, longitude: e.longitude });
  }
  if (endAnchor) stops.push(endAnchor);

  let travelMin = 0;
  for (let i = 1; i < stops.length; i += 1) {
    travelMin += estimateTravel(stops[i - 1], stops[i]).minutes;
  }
  return { travelMin, locatedCount: located.length };
}

/**
 * Score the rhythm between timed errands: for each consecutive pair, how much
 * slack is left after the (estimated) travel between them. No slack — or an
 * overlap — is rushed; a comfortable buffer is calm. Returns the average
 * per-transition sub-score (0–1) plus a count of the rushed ones. Fewer than
 * two timed errands ⇒ nothing competes, so the rhythm is a clean 1.
 */
function gapStats(errands: Errand[]): {
  gapScore: number;
  tightTransitions: number;
} {
  const timed = errands
    .map((e) => {
      const startMin = minutesOfDay(e.startTime);
      if (startMin == null) return null;
      const endMin = startMin + errandLoadMin(e);
      const coords = hasCoords(e)
        ? { latitude: e.latitude, longitude: e.longitude }
        : null;
      return { startMin, endMin, coords };
    })
    .filter((x): x is NonNullable<typeof x> => x != null)
    .sort((a, b) => a.startMin - b.startMin);

  if (timed.length < 2) return { gapScore: 1, tightTransitions: 0 };

  let sum = 0;
  let tight = 0;
  let transitions = 0;
  for (let i = 1; i < timed.length; i += 1) {
    const prev = timed[i - 1];
    const cur = timed[i];
    const travel =
      prev.coords && cur.coords
        ? estimateTravel(prev.coords, cur.coords).minutes
        : 0;
    const slack = cur.startMin - prev.endMin - travel;
    transitions += 1;
    if (slack < COMFORT_GAP_MIN) tight += 1;
    sum += slack <= 0 ? 0 : slack >= COMFORT_GAP_MIN ? 1 : slack / COMFORT_GAP_MIN;
  }
  return { gapScore: sum / transitions, tightTransitions: tight };
}

function windowMinutes(
  startTime: string | null | undefined,
  endTime: string | null | undefined,
): number {
  const start = minutesOfDay(startTime);
  let end = minutesOfDay(endTime);
  if (start == null || end == null) return 0;
  // A "sleep by" past midnight (e.g. 00:30) wraps into the next day.
  if (end <= start) end += DAY_MIN;
  return Math.max(0, end - start);
}

function levelFor(score: number, fits: boolean): MindfulnessLevel {
  if (!fits) return 'overloaded';
  if (score >= 80) return 'serene';
  if (score >= 62) return 'balanced';
  if (score >= 42) return 'busy';
  if (score >= 22) return 'packed';
  return 'overloaded';
}

/**
 * Score a day. Pure: same inputs → same output, no clock/store reads. The
 * caller decides the window (wake→sleep on the homepage, the plan's start→end in
 * the drawer) and which errands to include (all of the day's, or just the
 * ticked ones), then re-scores whenever that selection changes.
 */
export function scoreDay(input: DayScoreInput): DayScore {
  const availableMin = windowMinutes(input.startTime, input.endTime);
  const active = input.errands.filter((e) => !e.done);

  let committedMin = 0;
  for (const e of active) committedMin += errandLoadMin(e);

  const { travelMin, locatedCount } = travelLoad(
    active,
    input.startAnchor,
    input.endAnchor,
  );

  const loadMin = committedMin + travelMin;
  const freeMin = availableMin - loadMin;
  const fits = availableMin > 0 ? loadMin <= availableMin : loadMin === 0;

  // Fit — how much of the window the work claims. ratio ≤ 0.35 ⇒ full marks,
  // a full (or over-full) window ⇒ 0.
  const ratio =
    availableMin > 0 ? loadMin / availableMin : loadMin > 0 ? 2 : 0;
  const fitScore = clamp01(1 - (ratio - SERENE_RATIO) / (1 - SERENE_RATIO));

  // Rhythm — comfortable buffers between timed errands.
  const { gapScore, tightTransitions } = gapStats(active);

  // Travel burden — time spent in transit vs actually doing things.
  const travelShare = loadMin > 0 ? travelMin / loadMin : 0;
  const travelScore = clamp01(1 - travelShare / TRAVEL_HEAVY_SHARE);

  let score = 100 * (W_FIT * fitScore + W_GAP * gapScore + W_TRAVEL * travelScore);
  // A day whose work can't fit the waking hours can never read as calm, no
  // matter how its gaps land — cap it firmly into the red.
  if (!fits && availableMin > 0) score = Math.min(score, 28);
  score = Math.round(clamp(score, 0, 100));

  return {
    score,
    level: levelFor(score, fits),
    availableMin,
    committedMin,
    travelMin,
    freeMin,
    fits,
    errandCount: active.length,
    locatedCount,
    tightTransitions,
  };
}

const LEVEL_LABEL: Record<MindfulnessLevel, string> = {
  serene: 'Serene',
  balanced: 'Balanced',
  busy: 'Busy',
  packed: 'Packed',
  overloaded: 'Overloaded',
};

export function levelLabel(level: MindfulnessLevel): string {
  return LEVEL_LABEL[level];
}

/**
 * The free-time chip text: "3h 20m free", "Just fits", or "1h over" when the
 * day is overbooked.
 */
export function formatLeftover(freeMin: number): string {
  if (freeMin < 0) return `${formatDuration(-freeMin)} over`;
  if (freeMin < 5) return 'Just fits';
  return `${formatDuration(freeMin)} free`;
}

/**
 * A one-line, human reason for the score — the "why" under the headline. Leans
 * on the most pressing fact: doesn't fit → busy travel → rushed gaps → roomy.
 */
export function scoreNote(s: DayScore): string {
  if (s.errandCount === 0) return 'A clear day — nothing scheduled yet.';
  if (!s.fits) return 'Your errands run past your day — drop or shorten a few.';
  if (s.availableMin <= 0) return 'No time left in the day for these.';
  if (s.tightTransitions > 0) {
    return s.tightTransitions === 1
      ? 'One stop is tight — leave a little more buffer.'
      : `${s.tightTransitions} stops are back-to-back — add some breathing room.`;
  }
  if (s.travelMin > 0 && s.travelMin >= s.committedMin) {
    return 'A lot of the day is travel — try grouping nearby stops.';
  }
  if (s.level === 'serene') return 'Plenty of breathing room — an easy pace.';
  if (s.level === 'balanced') return 'A comfortable day with room to spare.';
  return 'A full day — leave space to catch your breath.';
}
