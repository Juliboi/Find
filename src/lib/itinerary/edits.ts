/**
 * Pure, client-side itinerary editing helpers.
 *
 * These mirror the server's clock-cascade (see `routeAndSchedule` step 2 in
 * `supabase/functions/_shared/routing.ts`) so a user's tweak — a longer
 * lunch, a removed stop, a swapped venue — reflows the rest of the day
 * INSTANTLY, before any network round-trip. Place swaps still get their real
 * travel re-routed by the backend afterwards; everything here is the optimistic
 * first paint.
 *
 * The cascade is intentionally OPINIONATED in two ways the original wasn't:
 *
 *   1. `fixed` anchors are sacred. If a previous edit's cursor would push past
 *      one, we DO NOT silently move the anchor — we record a `CascadeConflict`
 *      and let the UI surface it. The user picks: shorten the offender, move
 *      the anchor explicitly, or leave the overlap.
 *
 *   2. Intended free-time gaps are PRESERVED. On the first cascade we capture
 *      each item's idle time before it (start − prevEnd − travel) into
 *      `gapBeforeMin`. Subsequent cascades re-inject those gaps instead of
 *      compacting the day into one back-to-back blob — so editing one block
 *      doesn't silently erase a coffee break two slots down.
 *
 * Every exported mutator returns a NEW `Itinerary` (never mutates its input) so
 * React state updates stay predictable.
 */

import { Itinerary, ItineraryItem, ItineraryPlace } from '@/types/itinerary';
import { minutesOfDay } from '@/utils/time';

/** Monotonic local id for blocks the client creates (gaps, splits). The
 * `gap-` prefix + timestamp + counter keeps it collision-free across a session
 * and distinct from server/planner ids, so React keys stay stable. */
let gapCounter = 0;
function newGapId(): string {
  gapCounter += 1;
  return `gap-${Date.now().toString(36)}-${gapCounter}`;
}

/** Title used for an unnamed gap. Merges prefer a real (user/AI) name over this. */
const DEFAULT_GAP_TITLE = 'Free time';

// Idle this long (or longer) before a fixed/window anchor becomes a visible
// free-time block instead of an invisible hole. Mirrors the server
// (supabase/functions/_shared/routing.ts) and the screen's GAP_MIN_MINUTES so
// the optimistic paint matches the routed result.
const GAP_FILL_MIN_MINUTES = 20;
// Id prefix for gaps SYNTHESIZED by the deterministic idle-fill (client or
// server). Lets each fill strip its own previous fillers and rebuild them,
// without ever touching user-made or AI-made gaps (which carry other ids).
const SYNTH_GAP_PREFIX = 'srv-gap-';

let synthGapCounter = 0;

/** True for an elastic free-time block (the user can name / split / resize it). */
export function isGap(item: ItineraryItem): boolean {
  return item.kind === 'gap';
}

/** True for a gap the deterministic idle-fill synthesized (vs. user/AI gaps). */
function isSyntheticGap(item: ItineraryItem): boolean {
  return (
    item.kind === 'gap' &&
    typeof item.id === 'string' &&
    item.id.startsWith(SYNTH_GAP_PREFIX)
  );
}

/** True when a gap still has the generic name (so it's safe to absorb/rename on merge). */
function isDefaultGapTitle(title: string | undefined): boolean {
  return !title || title.trim().toLowerCase() === DEFAULT_GAP_TITLE.toLowerCase();
}

/** A fresh gap block: placeless, flexible, its `durationMinutes` IS the free time. */
function makeGap(minutes: number, title?: string): ItineraryItem {
  return {
    id: newGapId(),
    title: title?.trim() || DEFAULT_GAP_TITLE,
    kind: 'gap',
    flexibility: 'flexible',
    durationMinutes: Math.max(5, Math.round(minutes)),
    // The block itself represents the free time, so it carries no extra
    // "gap before" (that would double-count) and never has a travel leg.
    gapBeforeMin: 0,
    orderIndex: 0,
  };
}

/**
 * Collapses the run of consecutive gap blocks that contains `gapId` into a
 * single gap (summed duration), keeping the first real (non-default) name so
 * freed time "adds to the nearest gap" — e.g. removing an event next to
 * "Evening Downtime" grows that block instead of leaving a stray "Free time"
 * sliver beside it. Only touches the run around `gapId`, so deliberately split
 * gaps elsewhere in the day are left intact.
 */
function mergeGapRunAround(itin: Itinerary, gapId: string): Itinerary {
  return {
    ...itin,
    sections: itin.sections.map((s) => {
      const idx = s.items.findIndex((it) => it.id === gapId);
      if (idx === -1 || !isGap(s.items[idx])) return s;
      let lo = idx;
      let hi = idx;
      while (lo - 1 >= 0 && isGap(s.items[lo - 1])) lo--;
      while (hi + 1 < s.items.length && isGap(s.items[hi + 1])) hi++;
      if (lo === hi) return s; // no adjacent gaps to merge
      const run = s.items.slice(lo, hi + 1);
      const totalDur = run.reduce((sum, g) => sum + itemDuration(g), 0);
      const named = run.find((g) => !isDefaultGapTitle(g.title));
      const merged: ItineraryItem = {
        ...run[0],
        title: named ? named.title : DEFAULT_GAP_TITLE,
        durationMinutes: totalDur,
        endTime: undefined,
        gapBeforeMin: 0,
      };
      return { ...s, items: [...s.items.slice(0, lo), merged, ...s.items.slice(hi + 1)] };
    }),
  };
}

/** "HH:MM" of a minutes-since-midnight value, wrapping across a day. */
function fmtHHMM(totalMin: number): string {
  const wrapped = ((Math.round(totalMin) % 1440) + 1440) % 1440;
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** A block's effective length, falling back to start→end then a default. */
export function itemDuration(item: ItineraryItem): number {
  const d = Number(item.durationMinutes);
  if (Number.isFinite(d) && d > 0) return Math.round(d);
  const s = minutesOfDay(item.startTime);
  const e = minutesOfDay(item.endTime);
  if (s != null && e != null && e > s) return e - s;
  return 30;
}

/** All items across all sections, in day order. */
export function flatten(itin: Itinerary): ItineraryItem[] {
  return itin.sections.flatMap((s) => s.items);
}

/** True for the synthetic zero-length "Back home" arrival block. */
function isArrival(item: ItineraryItem): boolean {
  return (item as { arrival?: boolean }).arrival === true || item.kind === 'travel';
}

/**
 * Surfaces a time clash the user should know about: a `fixed` appointment the
 * cascade can't honor because earlier blocks have eaten into its slot, or a
 * `window` block scheduled outside its allowed range. Reported on the cascade
 * result so the UI can render a non-blocking warning and let the user resolve
 * it (shorten the offender, move the anchor, or accept the overlap).
 */
export interface CascadeConflict {
  /** The item whose constraint was violated. */
  itemId: string;
  kind: 'fixedOverrun' | 'windowOverrun';
  /** The constraint the cascade tried to honor (e.g. fixed start "12:00"). */
  requiredStart: string;
  /** What the cascade actually proposed (e.g. "12:45"). */
  proposedStart: string;
  /** Positive minutes by which proposedStart overshoots requiredStart. */
  overrunMin: number;
}

export interface CascadeResult {
  itinerary: Itinerary;
  /** Empty when nothing's wrong. */
  conflicts: CascadeConflict[];
}

/**
 * Captures each item's idle time before it (start − prevEnd − travel) into
 * `gapBeforeMin` IF the field isn't already set. Called by the cascade so the
 * first run after a fresh plan or saved-itinerary load locks in the planner's
 * intended rhythm; later edits then reflow around those gaps instead of
 * compacting the day.
 */
function ensureGaps(items: ItineraryItem[]): ItineraryItem[] {
  let prevEnd: number | null = null;
  return items.map((item) => {
    let nextItem = item;
    if (isGap(item)) {
      // A gap block IS the free time; it must never carry its own "gap before"
      // (that would stack empty time in front of empty time — e.g. after a
      // reorder resets the field, or for an AI-emitted gap with stray slack).
      if (item.gapBeforeMin !== 0) nextItem = { ...item, gapBeforeMin: 0 };
    } else if (item.gapBeforeMin == null) {
      const s = minutesOfDay(item.startTime);
      const travel = Number(item.travelFromPrev?.minutes) || 0;
      let gap = 0;
      if (prevEnd != null && s != null) {
        gap = Math.max(0, Math.round(s - prevEnd - travel));
      }
      nextItem = { ...item, gapBeforeMin: gap };
    }
    const start = minutesOfDay(nextItem.startTime);
    const end =
      minutesOfDay(nextItem.endTime) ??
      (start != null ? start + itemDuration(nextItem) : null);
    if (end != null) prevEnd = end;
    return nextItem;
  });
}

/**
 * Re-time the whole day from the first item's start: every block lands at
 * `prevEnd + travel + gapBefore`, fixed anchors snap to (and hold) their hard
 * time, and any overruns are reported via `CascadeResult.conflicts` instead of
 * silently sliding the anchor. Returns a new itinerary with fresh start/end
 * times and the captured gap snapshot baked in.
 */
export function cascadeTimes(itin: Itinerary): CascadeResult {
  const flat = flatten(itin);
  if (flat.length === 0) return { itinerary: itin, conflicts: [] };

  const itemsWithGaps = ensureGaps(flat);
  const gapById = new Map<string, number>();
  for (const it of itemsWithGaps) gapById.set(it.id, it.gapBeforeMin ?? 0);

  let cursor: number = minutesOfDay(itemsWithGaps[0].startTime) ?? 8 * 60;

  const next: Record<
    string,
    { startTime?: string; endTime?: string | null; durationMinutes?: number | null }
  > = {};
  const conflicts: CascadeConflict[] = [];

  itemsWithGaps.forEach((item, idx) => {
    const legMin = Number(item.travelFromPrev?.minutes);
    if (Number.isFinite(legMin) && legMin > 0) cursor += legMin;
    // First item has no "before" — gap and travel are meaningless.
    const gap = idx === 0 ? 0 : gapById.get(item.id) ?? 0;
    cursor += gap;
    const proposed = cursor;
    let start = proposed;

    if (item.flexibility === 'fixed') {
      const fixed = minutesOfDay(item.startTime);
      if (fixed != null) {
        if (proposed > fixed) {
          // Earlier edits would push past this anchor. Hold the anchor (the
          // user said it's sacred) and tell the UI so it can offer a way out.
          conflicts.push({
            itemId: item.id,
            kind: 'fixedOverrun',
            requiredStart: fmtHHMM(fixed),
            proposedStart: fmtHHMM(proposed),
            overrunMin: proposed - fixed,
          });
        }
        // Always snap to the fixed time, whether we're early (wait) or late
        // (overlap reported above). Either way the anchor wins.
        start = fixed;
      }
    } else if (item.flexibility === 'window') {
      const ws = minutesOfDay(item.windowStart);
      if (ws != null && ws > proposed) start = ws;
      const we = minutesOfDay(item.windowEnd);
      if (we != null && start > we) {
        conflicts.push({
          itemId: item.id,
          kind: 'windowOverrun',
          requiredStart: fmtHHMM(we),
          proposedStart: fmtHHMM(start),
          overrunMin: start - we,
        });
      }
    }

    const dur = isArrival(item) ? 0 : itemDuration(item);
    if (dur > 0) {
      next[item.id] = {
        startTime: fmtHHMM(start),
        endTime: fmtHHMM(start + dur),
        durationMinutes: dur,
      };
    } else {
      next[item.id] = { startTime: fmtHHMM(start), endTime: null, durationMinutes: null };
    }
    cursor = start + dur;
  });

  const itinerary = mapItems(itin, (item) => {
    const n = next[item.id];
    const gap = gapById.get(item.id);
    const merged: ItineraryItem = { ...item };
    if (gap != null) merged.gapBeforeMin = gap;
    if (n) {
      merged.startTime = n.startTime;
      merged.endTime = n.endTime === null ? undefined : n.endTime;
      merged.durationMinutes = n.durationMinutes === null ? undefined : n.durationMinutes;
    }
    return merged;
  });

  return { itinerary, conflicts };
}

/** Maps every item through `fn`, preserving section structure. */
function mapItems(itin: Itinerary, fn: (item: ItineraryItem) => ItineraryItem): Itinerary {
  return {
    ...itin,
    sections: itin.sections.map((s) => ({ ...s, items: s.items.map(fn) })),
  };
}

/** Drops gaps a previous idle-fill synthesized, so refilling stays idempotent. */
function stripSyntheticGaps(itin: Itinerary): Itinerary {
  return {
    ...itin,
    sections: itin.sections
      .map((s) => ({ ...s, items: s.items.filter((it) => !isSyntheticGap(it)) }))
      .filter((s) => s.items.length > 0),
  };
}

/**
 * Mirrors the server's idle-fill (`fillIdleGaps` in
 * `supabase/functions/_shared/routing.ts`): turns unfilled idle before a
 * fixed/window anchor into a visible `gap` block so the optimistic paint matches
 * the routed result, with no invisible holes. Expects an ALREADY-CASCADED
 * itinerary (reads start/end times) and only fills empty space, so it shifts
 * nothing already placed. Idempotent — strips its own previous fillers first.
 *
 * Deliberately NOT folded into `cascadeTimes`: that runs inside the
 * `fitGapsToAnchors` shrink loop, where re-inserting full-size gaps each pass
 * would undo the shrink and never converge. This is a finalize-only step.
 */
export function fillIdleGaps(itin: Itinerary): Itinerary {
  const base = stripSyntheticGaps(itin);
  const items = flatten(base);
  if (items.length === 0) return base;

  const insertBeforeId = new Map<string, ItineraryItem>();
  let prevEnd: number | null = null;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const start = minutesOfDay(it.startTime);
    const isAnchor = it.flexibility === 'fixed' || it.flexibility === 'window';
    if (i > 0 && isAnchor && start != null && prevEnd != null) {
      const travel = Number(it.travelFromPrev?.minutes) || 0;
      const idle = start - travel - prevEnd;
      if (idle >= GAP_FILL_MIN_MINUTES) {
        synthGapCounter += 1;
        insertBeforeId.set(it.id, {
          id: `${SYNTH_GAP_PREFIX}${Date.now().toString(36)}-${synthGapCounter}`,
          title: DEFAULT_GAP_TITLE,
          kind: 'gap',
          flexibility: 'flexible',
          startTime: fmtHHMM(prevEnd),
          endTime: fmtHHMM(prevEnd + idle),
          durationMinutes: idle,
          gapBeforeMin: 0,
          orderIndex: 0,
        });
      }
    }
    const end =
      minutesOfDay(it.endTime) ?? (start != null ? start + itemDuration(it) : null);
    if (end != null) prevEnd = end;
  }

  if (insertBeforeId.size === 0) return base;
  return {
    ...base,
    sections: base.sections.map((s) => ({
      ...s,
      items: s.items.flatMap((it) => {
        const g = insertBeforeId.get(it.id);
        return g ? [g, it] : [it];
      }),
    })),
  };
}

/** Sets a block's planned duration, then reflows the rest of the day. */
export function setItemDuration(
  itin: Itinerary,
  id: string,
  minutes: number,
): CascadeResult {
  const clamped = Math.max(5, Math.round(minutes));
  const updated = mapItems(itin, (item) =>
    item.id === id ? { ...item, durationMinutes: clamped } : item,
  );
  return cascadeTimes(updated);
}

/** Nudges a block's duration by a signed delta (e.g. +15, -15). */
export function adjustItemDuration(
  itin: Itinerary,
  id: string,
  deltaMin: number,
): CascadeResult {
  const item = flatten(itin).find((i) => i.id === id);
  if (!item) return { itinerary: itin, conflicts: [] };
  return setItemDuration(itin, id, itemDuration(item) + deltaMin);
}

/** Gaps thinner than this are treated as spent and dropped from the day. */
const MIN_GAP_MINUTES = 5;

/** Index of the soonest FIXED anchor strictly after `from` (or items.length). */
function nextFixedIndex(items: ItineraryItem[], from: number): number {
  for (let j = from + 1; j < items.length; j++) {
    if (items[j].flexibility === 'fixed' && minutesOfDay(items[j].startTime) != null) return j;
  }
  return items.length;
}

/** Index of the latest FIXED anchor strictly before `before` (or -1). */
function prevFixedIndex(items: ItineraryItem[], before: number): number {
  for (let j = before - 1; j >= 0; j--) {
    if (items[j].flexibility === 'fixed' && minutesOfDay(items[j].startTime) != null) return j;
  }
  return -1;
}

/**
 * Rebuilds the itinerary applying new per-id durations, then DROPS any gap that
 * fell below `MIN_GAP_MINUTES` (a fully-absorbed gap disappears) along with any
 * section it leaves empty. Clears endTime on touched blocks so the next cascade
 * recomputes it.
 */
function applyDurations(itin: Itinerary, durById: Map<string, number>): Itinerary {
  return {
    ...itin,
    sections: itin.sections
      .map((s) => ({
        ...s,
        items: s.items
          .map((it) =>
            durById.has(it.id)
              ? { ...it, durationMinutes: Math.max(0, Math.round(durById.get(it.id)!)), endTime: undefined }
              : it,
          )
          .filter((it) => !(isGap(it) && (it.durationMinutes ?? 0) < MIN_GAP_MINUTES)),
      }))
      .filter((s) => s.items.length > 0),
  };
}

/**
 * Resize a block, ABSORBING the change into nearby free time so the rest of the
 * day holds its shape. This is the elastic core of the gap system:
 *
 *   - EXTENDING an activity pulls the extra minutes out of the soonest gap(s)
 *     BEFORE the next fixed anchor — so a longer skincare routine eats into the
 *     evening downtime instead of shoving "sleep at 22:30" later. Intervening
 *     blocks still slide (they genuinely happen later), but the gap soaks up the
 *     delay so the anchor stays put. If the gaps can't cover it (or a fixed item
 *     sits in the way), the leftover overflows and the cascade reports it.
 *   - SHORTENING hands the freed minutes back to the soonest gap, so the day
 *     keeps the same end and the downtime simply grows.
 *
 * Only meaningful when travel ISN'T affected (pure duration tweaks) — moving
 * places changes commutes and must go through the backend recompute instead.
 * Directly resizing a GAP skips absorption: the user is setting free time by
 * hand, so we let the day flex (and conflict) honestly.
 */
export function setItemDurationAbsorbing(
  itin: Itinerary,
  id: string,
  minutes: number,
): CascadeResult {
  const flat = flatten(itin);
  const i = flat.findIndex((it) => it.id === id);
  if (i === -1) return cascadeTimes(itin);
  const item = flat[i];
  const newDur = Math.max(MIN_GAP_MINUTES, Math.round(minutes));

  if (isGap(item)) return setItemDuration(itin, id, newDur);

  const oldDur = itemDuration(item);
  const delta = newDur - oldDur;
  const durById = new Map<string, number>();
  durById.set(id, newDur);

  // Absorb into gaps up to the next fixed anchor — or, if there's none, into
  // every gap before the day's end (so the closing wind-down / bedtime stays
  // roughly put even when it isn't a hard `fixed` block). Whether a leftover
  // becomes a CONFLICT vs. just pushes the day later is decided by the cascade:
  // only a real fixed anchor reports an overrun.
  const bound = nextFixedIndex(flat, i);
  if (delta !== 0) {
    const gapsAhead: number[] = [];
    for (let j = i + 1; j < bound; j++) if (isGap(flat[j])) gapsAhead.push(j);
    if (gapsAhead.length > 0) {
      if (delta > 0) {
        let need = delta;
        for (const j of gapsAhead) {
          if (need <= 0) break;
          const cur = itemDuration(flat[j]);
          const take = Math.min(cur, need);
          durById.set(flat[j].id, cur - take);
          need -= take;
        }
        // Leftover `need` (gaps exhausted) falls through to the cascade: it
        // reports an overrun if a fixed anchor is hit, else the day just ends
        // a little later.
      } else {
        // Hand the freed minutes (−delta) back to the soonest downstream gap.
        const j = gapsAhead[0];
        durById.set(flat[j].id, itemDuration(flat[j]) - delta);
      }
    }
  }

  return cascadeTimes(applyDurations(itin, durById));
}

/** Signed-delta wrapper around {@link setItemDurationAbsorbing}. */
export function adjustItemDurationAbsorbing(
  itin: Itinerary,
  id: string,
  deltaMin: number,
): CascadeResult {
  const item = flatten(itin).find((i) => i.id === id);
  if (!item) return cascadeTimes(itin);
  return setItemDurationAbsorbing(itin, id, itemDuration(item) + deltaMin);
}

/**
 * Re-fits the day so no FIXED anchor is overrun, by shrinking the gaps that sit
 * in front of each overflowing anchor (nearest the anchor first). Used after a
 * structural change whose commutes were just re-routed by the backend — the new
 * travel times may have pushed the day past "sleep at 22:30", and the elastic
 * free time should give way before we ever move a hard commitment.
 *
 * Runs cascade → find the first fixed overrun → shrink an upstream gap by the
 * overrun → repeat, to a fixed point. When no gap is left to give, the overrun
 * is a genuine conflict and is returned for the UI to surface.
 */
export function fitGapsToAnchors(itin: Itinerary): CascadeResult {
  let current = itin;
  for (let iter = 0; iter < 24; iter++) {
    const res = cascadeTimes(current);
    const overflow = res.conflicts.find((c) => c.kind === 'fixedOverrun');
    if (!overflow) return res;

    const flat = flatten(res.itinerary);
    const anchorIdx = flat.findIndex((it) => it.id === overflow.itemId);
    if (anchorIdx === -1) return res;
    const segStart = prevFixedIndex(flat, anchorIdx) + 1;

    let need = overflow.overrunMin;
    const durById = new Map<string, number>();
    for (let j = anchorIdx - 1; j >= segStart && need > 0; j--) {
      if (!isGap(flat[j])) continue;
      const cur = itemDuration(flat[j]);
      const take = Math.min(cur, need);
      if (take > 0) {
        durById.set(flat[j].id, cur - take);
        need -= take;
      }
    }
    if (durById.size === 0) return res; // nothing elastic left — real conflict
    current = applyDurations(res.itinerary, durById);
  }
  return cascadeTimes(current);
}

/**
 * Folds a backend recompute back onto the client's day. The server is
 * authoritative for the PRACTICAL layer it just computed — each
 * `travelFromPrev` (real minutes, transit steps, polyline) and any structural
 * block it appended (the synthetic "Back home") — but NOT for TIMING. Its
 * internal clock cascade slides fixed anchors to whatever time the day happens
 * to reach and can shrink durations to force a fit, which would erase exactly
 * the "this no longer fits" signal the conflict banner relies on.
 *
 * So we keep the server's structure + fresh legs, but restore the client's
 * timing-authority fields (flexibility, the fixed/window anchors, planned
 * duration, intended gap) by id, then let {@link cascadeTimes}/
 * {@link fitGapsToAnchors} decide the real schedule and surface any genuine
 * overrun. Items the server introduced (no id match) are kept verbatim.
 */
export function applyRoutedLegs(base: Itinerary, routed: Itinerary): Itinerary {
  const baseById = new Map(flatten(base).map((i) => [i.id, i]));
  return {
    ...routed,
    sections: routed.sections.map((s) => ({
      ...s,
      items: s.items.map((it) => {
        const b = baseById.get(it.id);
        if (!b) return it; // server-introduced block (e.g. "Back home")
        return {
          ...it,
          flexibility: b.flexibility,
          startTime: b.startTime ?? it.startTime,
          durationMinutes: b.durationMinutes,
          windowStart: b.windowStart,
          windowEnd: b.windowEnd,
          gapBeforeMin: b.gapBeforeMin,
        };
      }),
    })),
  };
}

/**
 * Removes a block, then reflows the day.
 *
 *   - Removing a real block (an event/meal/activity) leaves its time as
 *     reusable FREE TIME: the block is swapped for a gap of the same length in
 *     place, which then merges into any touching gap — so deleting something
 *     next to "Evening Downtime" grows that downtime instead of leaving a
 *     passive idle sliver. Travel to the next stop is refreshed by the backend
 *     recompute that `remove` triggers.
 *   - Removing a GAP itself just reclaims that free time (compacts the day) —
 *     otherwise "delete free time" would be a no-op.
 */
export function removeItem(itin: Itinerary, id: string): CascadeResult {
  const target = flatten(itin).find((i) => i.id === id);
  if (!target) return cascadeTimes(itin);

  if (isGap(target)) {
    const sections = itin.sections
      .map((s) => ({ ...s, items: s.items.filter((i) => i.id !== id) }))
      .filter((s) => s.items.length > 0);
    return cascadeTimes({ ...itin, sections });
  }

  const replacement = makeGap(itemDuration(target));
  const replaced: Itinerary = {
    ...itin,
    sections: itin.sections.map((s) => ({
      ...s,
      items: s.items.map((it) => (it.id === id ? replacement : it)),
    })),
  };
  return cascadeTimes(mergeGapRunAround(replaced, replacement.id));
}

/**
 * Cheap haversine in meters — used for the OPTIMISTIC travel estimate after a
 * place swap, so the local clock isn't wildly off until the backend re-routes.
 * Mirrors the version in `supabase/functions/_shared/routing.ts`.
 */
function haversineMeters(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const R = 6371000;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

const DETOUR_FACTOR = 1.3;

/** Rough mode pick + minutes, mirroring the server's pickMode/estimateMinutes. */
function estimateLeg(
  origin: { latitude: number; longitude: number },
  dest: { latitude: number; longitude: number },
): { mode: 'walk' | 'transit'; minutes: number; distanceMeters: number } {
  const straight = haversineMeters(origin, dest);
  const distance = Math.round(straight * DETOUR_FACTOR);
  const mode: 'walk' | 'transit' = distance <= 1300 ? 'walk' : 'transit';
  const speed = mode === 'walk' ? 80 : 200;
  const overhead = mode === 'walk' ? 1 : 4;
  return {
    mode,
    distanceMeters: distance,
    minutes: Math.max(1, Math.round(distance / speed + overhead)),
  };
}

/**
 * Replaces a block's venue. The OPTIMISTIC update also re-estimates the local
 * travel for the swapped block AND the one that follows (their coordinates
 * are now different), so the clock cascade is roughly right until the backend
 * `recompute-itinerary` returns a proper routed leg. Times still reflow so the
 * UI never shows a stale clock.
 */
export function replaceItemPlace(
  itin: Itinerary,
  id: string,
  place: ItineraryPlace,
): CascadeResult {
  const items = flatten(itin);
  const targetIdx = items.findIndex((i) => i.id === id);
  if (targetIdx === -1) return { itinerary: itin, conflicts: [] };

  const newCoords = place.coords;

  // Find the previous LOCATED stop to estimate "travel into" the swap target.
  let prevCoords: { latitude: number; longitude: number } | null = null;
  for (let i = targetIdx - 1; i >= 0; i--) {
    const c = items[i].place?.coords;
    if (c) {
      prevCoords = c;
      break;
    }
  }

  // Find the next LOCATED stop to estimate "travel out of" the swap target.
  let nextIdx = -1;
  for (let i = targetIdx + 1; i < items.length; i++) {
    if (items[i].place?.coords) {
      nextIdx = i;
      break;
    }
  }

  const updated = mapItems(itin, (item) => {
    if (item.id === id) {
      const draft: ItineraryItem = { ...item, place };
      if (newCoords && prevCoords) {
        const est = estimateLeg(prevCoords, newCoords);
        draft.travelFromPrev = {
          mode: est.mode,
          minutes: est.minutes,
          distanceMeters: est.distanceMeters,
          // Carry over the previous travel's `fromLabel` (e.g. "from Home") if
          // it described an anchor that didn't change.
          fromLabel: item.travelFromPrev?.fromLabel,
          estimated: true,
        };
      }
      return draft;
    }
    if (nextIdx !== -1 && item.id === items[nextIdx].id) {
      const c = item.place?.coords;
      if (newCoords && c) {
        const est = estimateLeg(newCoords, c);
        return {
          ...item,
          travelFromPrev: {
            mode: est.mode,
            minutes: est.minutes,
            distanceMeters: est.distanceMeters,
            fromLabel: item.travelFromPrev?.fromLabel,
            estimated: true,
          },
        };
      }
    }
    return item;
  });
  return cascadeTimes(updated);
}

/** Moves a flexible block to a specific start time by pinning it `fixed`. */
export function moveItemTime(
  itin: Itinerary,
  id: string,
  hhmm: string,
): CascadeResult {
  const updated = mapItems(itin, (item) =>
    item.id === id ? { ...item, flexibility: 'fixed' as const, startTime: hhmm } : item,
  );
  return cascadeTimes(updated);
}

/**
 * Sets a leg's transport mode (overwriting the auto-picked one). Travel
 * minutes are left for the backend recompute to refresh from real routing —
 * the optimistic cascade keeps the existing duration so the day's clock
 * doesn't jolt before the network catches up.
 */
export function setLegMode(
  itin: Itinerary,
  id: string,
  mode: 'walk' | 'bike' | 'transit' | 'drive',
): CascadeResult {
  const updated = mapItems(itin, (item) =>
    item.id === id && item.travelFromPrev
      ? {
          ...item,
          travelFromPrev: { ...item.travelFromPrev, mode, modeLocked: true, estimated: true },
        }
      : item,
  );
  return cascadeTimes(updated);
}

/**
 * Forces a single transport mode across every leg of the day — for the user
 * who says "I'm taking my car today" or "I'd rather walk everything". Same
 * caveat as `setLegMode`: minutes wait on backend recompute.
 */
export function setDayTransportMode(
  itin: Itinerary,
  mode: 'walk' | 'bike' | 'transit' | 'drive',
): CascadeResult {
  const updated = mapItems(itin, (item) =>
    item.travelFromPrev
      ? {
          ...item,
          travelFromPrev: { ...item.travelFromPrev, mode, modeLocked: true, estimated: true },
        }
      : item,
  );
  return cascadeTimes(updated);
}

/**
 * Reorders items inside the day. Accepts a flat array of item ids in the new
 * desired order; sections are rebuilt to keep their original titles but their
 * items repopulated by the new sequence (empty sections are dropped).
 *
 * The new sequence is COMPACTED: every block flows tight against the one before
 * it (`gapBeforeMin = 0`). This is the crux of correct reordering — free time
 * now lives in explicit gap BLOCKS that the user drags around, so a block must
 * NOT re-derive an implicit "gap before" from its own STALE start time. That
 * stale-derivation is what used to recreate a phantom wait: e.g. moving a
 * 1h30m free-time block below an activity left the activity pinned at its old
 * clock, opening a ghost hole before it and shoving the day's end past midnight.
 * Fixed anchors still snap on cascade, and travel is refreshed by the backend
 * recompute a reorder triggers.
 */
export function reorderItems(itin: Itinerary, orderedIds: string[]): CascadeResult {
  const flat = flatten(itin);
  // Anchor the day at its original start so re-sequencing — even dragging a new
  // block to the top — doesn't drift the whole day onto some block's stale clock.
  const dayStart = flat.length ? minutesOfDay(flat[0].startTime) : null;
  const oldIndex = new Map(flat.map((it, i) => [it.id, i]));
  const byId = new Map(flat.map((i) => [i.id, i]));
  const seen = new Set<string>();
  const reordered: ItineraryItem[] = [];
  const place = (item: ItineraryItem) => {
    const newIdx = reordered.length;
    // A manual rearrange is the user taking control of the SEQUENCE. If a block
    // they MOVED was pinned to a hard AI time, that pin is now stale — honoring
    // it would leave the block waiting at its old clock and tear a hole in the
    // day (e.g. a "fixed" 21:30 skincare that won't slide up when free time is
    // dragged below it). So we soften a moved block to flexible and let it flow
    // to where it was dropped. Blocks that DIDN'T move keep their pin, so a true
    // day-end anchor (sleep, still last) or an untouched reservation stays put.
    const moved = oldIndex.get(item.id) !== newIdx;
    const flexibility =
      moved && item.flexibility === 'fixed' ? 'flexible' : item.flexibility;
    reordered.push({ ...item, flexibility, gapBeforeMin: 0, orderIndex: newIdx });
  };
  for (const id of orderedIds) {
    if (seen.has(id)) continue;
    const item = byId.get(id);
    if (!item) continue;
    seen.add(id);
    place(item);
  }
  // Append any items the caller forgot — never silently drop blocks.
  for (const item of flat) {
    if (!seen.has(item.id)) place(item);
  }

  // Re-anchor the (possibly new) first block to the original day start so the
  // cascade's cursor begins at the right time regardless of what moved.
  if (reordered.length && dayStart != null) {
    reordered[0] = { ...reordered[0], startTime: fmtHHMM(dayStart) };
  }

  // Distribute the reordered items into the original section shells, in order.
  // Any leftover items spill into the last section so nothing is lost.
  let cursor = 0;
  const sections = itin.sections
    .map((s) => {
      const take = s.items.length;
      const slice = reordered.slice(cursor, cursor + take);
      cursor += take;
      return { ...s, items: slice };
    })
    .filter((s) => s.items.length > 0);
  if (cursor < reordered.length) {
    const tail = reordered.slice(cursor);
    if (sections.length > 0) {
      sections[sections.length - 1] = {
        ...sections[sections.length - 1],
        items: [...sections[sections.length - 1].items, ...tail],
      };
    } else {
      sections.push({ id: itin.sections[0]?.id ?? 'sec', title: 'Day', items: tail });
    }
  }

  return cascadeTimes({ ...itin, sections });
}

/**
 * What committing a sequence change will cost, mirroring the real edit pipeline
 * (optimistic cascade → backend re-route → fixed-anchor conflict surfaced). Lets
 * the reorder UI tell the user, BEFORE they drop, whether a move is safe.
 *
 *   - 'free'    : the order of DISTINCT venues is unchanged, so no commute can
 *                 change — times just reflow locally, no backend call.
 *   - 'reroute' : the venue sequence changed, so the affected commutes must be
 *                 re-priced by the backend. The day usually still fits, but the
 *                 real new leg lengths aren't known until that returns — so this
 *                 is also the honest ceiling for a travel-driven clash.
 *   - 'replan'  : even after shrinking every elastic gap a hard anchor is still
 *                 overrun (fixed or window), so only a Gemini rebalance can fit
 *                 it.
 */
export type ReorderImpact = 'free' | 'reroute' | 'replan';

/** Stable key for a LOCATED stop (name + coarse coords); null for blocks that
 *  don't move you (no coords) and so never generate a commute. */
function venueKeyOf(item: ItineraryItem): string | null {
  const c = item.place?.coords;
  if (!c) return null;
  const name = (item.place?.name ?? '').trim().toLowerCase();
  return `${name}|${c.latitude.toFixed(4)},${c.longitude.toFixed(4)}`;
}

/** The day's distinct venues in visit order. Two reorders that leave this
 *  identical cannot change any commute. */
export function locatedSequence(itin: Itinerary): string[] {
  const out: string[] = [];
  for (const it of flatten(itin)) {
    const k = venueKeyOf(it);
    if (k && out[out.length - 1] !== k) out.push(k);
  }
  return out;
}

/** Predicts the cost of applying `orderedIds`. Pure + synchronous so the drag
 *  layer can score every candidate drop-slot up front. */
export function classifyReorder(base: Itinerary, orderedIds: string[]): ReorderImpact {
  const beforeSeq = locatedSequence(base);
  const { itinerary: reordered } = reorderItems(base, orderedIds);
  // Re-time + absorb gaps exactly as the post-route step does; any conflict that
  // survives is one the day genuinely can't fit without a structural rebalance.
  const { conflicts } = fitGapsToAnchors(reordered);
  if (conflicts.length > 0) return 'replan';
  const afterSeq = locatedSequence(reordered);
  const venuesChanged =
    beforeSeq.length !== afterSeq.length || beforeSeq.some((k, i) => k !== afterSeq[i]);
  return venuesChanged ? 'reroute' : 'free';
}

/**
 * Inserts a new free-time gap block, anchored either AFTER `afterId` or BEFORE
 * `beforeId` (exactly one should be set; `afterId` wins if both are). The gap
 * lands in the same section as its anchor so it reads as "between these two
 * plans". When there's already idle slack before the following block, the gap
 * ABSORBS that slack first (we shrink the next block's `gapBeforeMin`) so
 * "add free time where the day already breathes" doesn't shove the whole
 * afternoon later — it only pushes for time beyond the existing slack.
 */
export function insertGap(
  itin: Itinerary,
  opts: { afterId?: string | null; beforeId?: string | null; minutes: number; title?: string },
): CascadeResult {
  const gap = makeGap(opts.minutes, opts.title);
  const flat = flatten(itin);

  // Resolve the flat index we're inserting AT (the gap takes this slot).
  let insertFlatIdx = flat.length;
  if (opts.afterId != null) {
    const i = flat.findIndex((it) => it.id === opts.afterId);
    if (i !== -1) insertFlatIdx = i + 1;
  } else if (opts.beforeId != null) {
    const i = flat.findIndex((it) => it.id === opts.beforeId);
    if (i !== -1) insertFlatIdx = i;
  }

  // Let the gap eat any existing slack in front of the block it now precedes,
  // so filling visible "free" time keeps the rest of the day put.
  const following = flat[insertFlatIdx];
  let sections = itin.sections;
  if (following && (following.gapBeforeMin ?? 0) > 0) {
    const absorbed = Math.min(following.gapBeforeMin ?? 0, gap.durationMinutes ?? 0);
    if (absorbed > 0) {
      sections = sections.map((s) => ({
        ...s,
        items: s.items.map((it) =>
          it.id === following.id
            ? { ...it, gapBeforeMin: (it.gapBeforeMin ?? 0) - absorbed }
            : it,
        ),
      }));
    }
  }

  // Splice the gap into the correct section by walking section boundaries.
  let cursor = 0;
  let placed = false;
  const withGap = sections.map((s) => {
    if (placed) {
      return s;
    }
    const start = cursor;
    const end = cursor + s.items.length;
    cursor = end;
    // Insert when the target slot falls inside this section (inclusive of its
    // trailing edge, so "after the last item" lands here rather than spilling).
    if (insertFlatIdx <= end) {
      const localIdx = Math.max(0, Math.min(s.items.length, insertFlatIdx - start));
      const items = [...s.items];
      items.splice(localIdx, 0, gap);
      placed = true;
      return { ...s, items };
    }
    return s;
  });
  if (!placed && withGap.length > 0) {
    const last = withGap[withGap.length - 1];
    withGap[withGap.length - 1] = { ...last, items: [...last.items, gap] };
  }

  return cascadeTimes({ ...itin, sections: withGap });
}

/**
 * Splits a gap into two adjacent gaps. `firstMinutes` is how long the leading
 * piece keeps (defaults to half); the remainder becomes a new gap right after
 * it, inheriting the same name. Net duration is unchanged, so nothing downstream
 * shifts — the user just gets two handles where there was one (e.g. to name and
 * reorder a "gym" slot out of a longer "free time" block).
 */
export function splitGap(itin: Itinerary, id: string, firstMinutes?: number): CascadeResult {
  const target = flatten(itin).find((i) => i.id === id);
  if (!target || !isGap(target)) return { itinerary: itin, conflicts: [] };
  const total = itemDuration(target);
  const first = Math.max(5, Math.min(total - 5, Math.round(firstMinutes ?? total / 2)));
  const second = total - first;
  if (second < 5) return { itinerary: itin, conflicts: [] };

  const secondGap = makeGap(second, target.title);
  const sections = itin.sections.map((s) => {
    const idx = s.items.findIndex((it) => it.id === id);
    if (idx === -1) return s;
    const items = [...s.items];
    items[idx] = { ...items[idx], durationMinutes: first, endTime: undefined };
    items.splice(idx + 1, 0, secondGap);
    return { ...s, items };
  });
  return cascadeTimes({ ...itin, sections });
}

/** Renames a block (used to label a gap, e.g. "Playing video games"). A title
 * has no effect on timing, so the cascade is idempotent here — we still run it
 * so any standing conflicts are recomputed accurately rather than blanked. */
export function renameItem(itin: Itinerary, id: string, title: string): CascadeResult {
  const clean = title.trim();
  if (!clean) return cascadeTimes(itin);
  const updated = mapItems(itin, (item) => (item.id === id ? { ...item, title: clean } : item));
  return cascadeTimes(updated);
}

// --- unified edit operations ----------------------------------------------
//
// Every editing surface (the floating adjust bar, the per-card menu, the
// place-swap sheet, the leg picker, the rearrange-mode reorder) produces one
// of these ops and feeds it to the screen's `applyEdit`. Keeping the op shapes
// here lets `applyOp` stay pure and lets the pipeline decide (via
// `opNeedsRoute`) whether a backend route refresh is warranted: only edits
// that change WHERE the day goes (places or sequence) actually do.

export type EditOp =
  | { type: 'setDuration'; id: string; minutes: number }
  | { type: 'adjustDuration'; id: string; deltaMin: number }
  | { type: 'moveTime'; id: string; hhmm: string }
  | { type: 'remove'; id: string }
  | { type: 'replacePlace'; id: string; place: ItineraryPlace }
  | { type: 'setLegMode'; id: string; mode: 'walk' | 'bike' | 'transit' | 'drive' }
  | { type: 'setDayTransportMode'; mode: 'walk' | 'bike' | 'transit' | 'drive' }
  | { type: 'reorder'; orderedIds: string[] }
  | {
      type: 'insertGap';
      afterId?: string | null;
      beforeId?: string | null;
      minutes: number;
      title?: string;
    }
  | { type: 'splitGap'; id: string; firstMinutes?: number }
  | { type: 'renameItem'; id: string; title: string }
  | { type: 'replaceItinerary'; itinerary: Itinerary };

/** Applies an op purely, returning the optimistic next itinerary + conflicts. */
export function applyOp(itin: Itinerary, op: EditOp): CascadeResult {
  switch (op.type) {
    case 'setDuration':
      return setItemDurationAbsorbing(itin, op.id, op.minutes);
    case 'adjustDuration':
      return adjustItemDurationAbsorbing(itin, op.id, op.deltaMin);
    case 'moveTime':
      return moveItemTime(itin, op.id, op.hhmm);
    case 'remove':
      return removeItem(itin, op.id);
    case 'replacePlace':
      return replaceItemPlace(itin, op.id, op.place);
    case 'setLegMode':
      return setLegMode(itin, op.id, op.mode);
    case 'setDayTransportMode':
      return setDayTransportMode(itin, op.mode);
    case 'reorder':
      return reorderItems(itin, op.orderedIds);
    case 'insertGap':
      return insertGap(itin, {
        afterId: op.afterId,
        beforeId: op.beforeId,
        minutes: op.minutes,
        title: op.title,
      });
    case 'splitGap':
      return splitGap(itin, op.id, op.firstMinutes);
    case 'renameItem':
      return renameItem(itin, op.id, op.title);
    case 'replaceItinerary': {
      // A wholesale replacement (used by AI replan today). Cascade it through
      // the same path so the new plan gets gap-tracking too, then surface any
      // idle before a fixed/window anchor as a visible gap block — matching the
      // server so a replan never paints invisible holes.
      const { itinerary, conflicts } = cascadeTimes(op.itinerary);
      return { itinerary: fillIdleGaps(itinerary), conflicts };
    }
  }
}

/**
 * True when an op warrants a backend re-route. This now covers TIMING edits too
 * (duration, move, gaps), not just place/sequence changes: routing is
 * departure-time-aware, so shifting the day later can land you on a different
 * transit run (or worse traffic), which only the backend can re-price. The
 * client cascade still paints the optimistic result instantly; the recompute
 * refreshes the commutes and, if they no longer fit, triggers the replan
 * escalation. Only `renameItem` (zero timing impact) stays purely local.
 */
export function opNeedsRoute(op: EditOp): boolean {
  return (
    op.type === 'remove' ||
    op.type === 'replacePlace' ||
    op.type === 'reorder' ||
    op.type === 'setLegMode' ||
    op.type === 'setDayTransportMode' ||
    op.type === 'replaceItinerary' ||
    op.type === 'setDuration' ||
    op.type === 'adjustDuration' ||
    op.type === 'moveTime' ||
    op.type === 'insertGap' ||
    op.type === 'splitGap'
  );
}

/** Short, human summary of an op for an undo toast. */
export function describeOp(itin: Itinerary, op: EditOp): string {
  const titleOf = (id: string) => flatten(itin).find((i) => i.id === id)?.title ?? 'block';
  switch (op.type) {
    case 'setDuration':
      return `Updated ${titleOf(op.id)}`;
    case 'adjustDuration':
      return `${op.deltaMin > 0 ? 'Lengthened' : 'Shortened'} ${titleOf(op.id)}`;
    case 'moveTime':
      return `Moved ${titleOf(op.id)} to ${op.hhmm}`;
    case 'remove':
      return `Removed ${titleOf(op.id)}`;
    case 'replacePlace':
      return `Swapped to ${op.place.name}`;
    case 'setLegMode':
      return `Travel to ${titleOf(op.id)} → ${op.mode}`;
    case 'setDayTransportMode':
      return `Travel mode → ${op.mode}`;
    case 'reorder':
      return 'Reordered your day';
    case 'insertGap':
      return `Added ${op.title?.trim() || 'free time'}`;
    case 'splitGap':
      return 'Split free time';
    case 'renameItem':
      return `Renamed to ${op.title.trim()}`;
    case 'replaceItinerary':
      return 'Updated your day';
  }
}
