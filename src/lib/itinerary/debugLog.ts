/**
 * Dev-only STRUCTURED edit trace for the itinerary.
 *
 * The full-day JSON snapshot (in `app/itinerary.tsx`) is great for "share the
 * whole thing", but useless for the question we actually keep asking while
 * debugging: *what did this one edit do?* When ordering "behaves weirdly" — a
 * `fixed` plan clashing with the block dragged in front of it, a commute that
 * didn't update after a reorder, a gap that grew where it shouldn't — you need
 * to see the OP that ran, the resulting ordered blocks, and the precise DELTA
 * (who moved, who got re-timed, whose travel changed) without scrolling past
 * descriptions, photos and polylines.
 *
 * So every edit prints two things, sentinel-wrapped for easy copy/grep:
 *   1. `changes` — a compact diff of before → after (moved / retimed /
 *      travelChanged / flexChanged / added / removed), plus any conflicts.
 *   2. `day`     — the whole day as one compact row per block (time, flex,
 *      gap, travel), so the full ordered state is always right there.
 *
 * Each edit also logs TWICE when it touches places/sequence: once for the
 * instant optimistic cascade (`phase: 'optimistic'`) and again after the
 * backend re-routes (`phase: 'after-route'`). Diffing those two is how you
 * catch "the commute didn't update" — the after-route `travelChanged` list is
 * empty when the backend left a leg untouched.
 *
 * Entirely inert outside `__DEV__`.
 */

import { Itinerary, ItineraryItem } from '@/types/itinerary';
import { CascadeConflict, EditOp, describeOp, flatten } from './edits';

/** One compact row per block — only the fields that drive ordering/timing. */
export interface ItineraryDebugRow {
  /** Flat position in the day (0-based), so reorders are obvious. */
  i: number;
  id: string;
  /** "HH:MM-HH:MM", "HH:MM", or "--:--" when untimed. */
  time: string;
  /** Planned minutes, when known. */
  dur: number | null;
  /** "fixed" | "flexible" | "window[lo-hi]" — the reflow-driving field. */
  flex: string;
  kind: string;
  title: string;
  /** Intended idle minutes captured before this block. */
  gap: number;
  /** "walk 12m" / "transit 25m~" (~ = optimistic estimate), or null. */
  travel: string | null;
}

function timeLabel(item: ItineraryItem): string {
  if (item.startTime && item.endTime) return `${item.startTime}-${item.endTime}`;
  if (item.startTime) return item.startTime;
  return '--:--';
}

function flexLabel(item: ItineraryItem): string {
  if (item.flexibility === 'window') {
    return `window[${item.windowStart ?? '?'}-${item.windowEnd ?? '?'}]`;
  }
  return item.flexibility;
}

/** "<mode> <min>m" with a trailing `~` when the leg is still an estimate. */
function travelLabel(item: ItineraryItem): string | null {
  const t = item.travelFromPrev;
  if (!t) return null;
  const min = Number.isFinite(t.minutes) ? `${Math.round(t.minutes)}m` : '?';
  return `${t.mode} ${min}${t.estimated ? '~' : ''}`;
}

/** Compact, ordered rows for the whole day — the heart of the edit trace. */
export function compactItinerary(itin: Itinerary): ItineraryDebugRow[] {
  return flatten(itin).map((it, i) => ({
    i,
    id: it.id,
    time: timeLabel(it),
    dur: it.durationMinutes ?? null,
    flex: flexLabel(it),
    kind: it.kind,
    title: it.title,
    gap: it.gapBeforeMin ?? 0,
    travel: travelLabel(it),
  }));
}

/** Per-field change records, keyed by what the user cares about while debugging. */
export interface ItineraryDiff {
  added: { id: string; title: string; at: number }[];
  removed: { id: string; title: string }[];
  moved: { id: string; title: string; from: number; to: number }[];
  retimed: { id: string; title: string; from: string; to: string }[];
  travelChanged: { id: string; title: string; from: string | null; to: string | null }[];
  flexChanged: { id: string; title: string; from: string; to: string }[];
}

/** True when a diff found nothing — lets the logger label "no structural change". */
export function isEmptyDiff(d: ItineraryDiff): boolean {
  return (
    d.added.length === 0 &&
    d.removed.length === 0 &&
    d.moved.length === 0 &&
    d.retimed.length === 0 &&
    d.travelChanged.length === 0 &&
    d.flexChanged.length === 0
  );
}

/**
 * Compares two itineraries block-by-block (matched by stable id) and reports
 * only what differs. This is the signal you read first: did the block I touched
 * actually move? did the anchor I expected to hold get re-timed? did the
 * commute refresh after the swap?
 */
export function diffItineraries(before: Itinerary, after: Itinerary): ItineraryDiff {
  const a = new Map(flatten(before).map((it, i) => [it.id, { it, i }]));
  const b = new Map(flatten(after).map((it, i) => [it.id, { it, i }]));

  const diff: ItineraryDiff = {
    added: [],
    removed: [],
    moved: [],
    retimed: [],
    travelChanged: [],
    flexChanged: [],
  };

  for (const [id, { it, i }] of b) {
    const prev = a.get(id);
    if (!prev) {
      diff.added.push({ id, title: it.title, at: i });
      continue;
    }
    if (prev.i !== i) diff.moved.push({ id, title: it.title, from: prev.i, to: i });

    const tOld = timeLabel(prev.it);
    const tNew = timeLabel(it);
    if (tOld !== tNew) diff.retimed.push({ id, title: it.title, from: tOld, to: tNew });

    const trOld = travelLabel(prev.it);
    const trNew = travelLabel(it);
    if (trOld !== trNew) {
      diff.travelChanged.push({ id, title: it.title, from: trOld, to: trNew });
    }

    const fOld = flexLabel(prev.it);
    const fNew = flexLabel(it);
    if (fOld !== fNew) diff.flexChanged.push({ id, title: it.title, from: fOld, to: fNew });
  }

  for (const [id, { it }] of a) {
    if (!b.has(id)) diff.removed.push({ id, title: it.title });
  }

  return diff;
}

/** A raw op, with the bulky `replaceItinerary` payload reduced to a reference. */
function opShape(op: EditOp): Record<string, unknown> {
  if (op.type === 'replaceItinerary') {
    return {
      type: op.type,
      itineraryId: op.itinerary.id,
      title: op.itinerary.title,
      blocks: flatten(op.itinerary).length,
    };
  }
  return op as unknown as Record<string, unknown>;
}

/** Which stage of the pipeline produced this state — see file header. */
export type EditPhase = 'optimistic' | 'after-route' | 'route-skipped' | 'replan' | 'undo';

export interface EditLogInput {
  phase: EditPhase;
  /** The op(s) that ran (omit for undo / load). */
  ops?: EditOp[];
  /** State BEFORE this phase; enables the `changes` diff when provided. */
  before?: Itinerary | null;
  /** State AFTER this phase — always dumped as the compact `day`. */
  after: Itinerary;
  /** Constraint violations the cascade surfaced (fixed/window overruns). */
  conflicts?: CascadeConflict[];
  /** Whether this edit will (optimistic) / did (after-route) hit the backend. */
  needsRoute?: boolean;
  /** Free-form note, e.g. why a route refresh was skipped. */
  note?: string;
}

let editCounter = 0;

/**
 * Prints one structured edit record. Pairs with the existing full-day snapshot
 * but stays focused on ordering + timing so a debugging session reads cleanly.
 * No-op outside `__DEV__`.
 */
export function logItineraryEdit(input: EditLogInput): void {
  if (!__DEV__) return;
  const { phase, ops, before, after, conflicts, needsRoute, note } = input;
  editCounter += 1;

  const changes = before ? diffItineraries(before, after) : undefined;
  const stamp = new Date().toISOString();
  const payload = {
    phase,
    note,
    needsRoute,
    ops: ops?.map((op) => ({ ...opShape(op), label: describeOp(before ?? after, op) })),
    conflicts: conflicts && conflicts.length > 0 ? conflicts : undefined,
    changes: changes && !isEmptyDiff(changes) ? changes : changes ? 'no structural change' : undefined,
    day: compactItinerary(after),
  };

  const tag = `[itin-edit #${editCounter} ${phase}]`;
  console.log(`──────────── ${tag} ${stamp} ────────────`);
  console.log(JSON.stringify(payload, null, 2));
  console.log(`──────────── [itin-edit/end #${editCounter}] ────────────`);
}
