/**
 * Shared time-axis helpers for an itinerary.
 *
 * Both the full planner screen and the homepage "where am I right now" peek
 * need to reason about a day's wall-clock progress: which block is happening
 * now, whether you're mid-commute, what's up next — all while staying correct
 * for a plan that crosses midnight. That logic used to live inside the planner
 * screen; it's lifted here so the homepage card can render an accurate quick
 * peek without duplicating (and drifting from) the same subtle math.
 */
import type { Itinerary, ItineraryItem, TravelLeg } from '@/types/itinerary';
import { minutesOfDay } from '@/utils/time';

/**
 * Absolute (midnight-unwrapped) start/end for one block, in minutes measured
 * from the plan's first morning. Times after midnight keep climbing past 1440
 * so a late-night plan that rolls over (22:20 → 01:00) stays monotonic instead
 * of wrapping the after-midnight blocks back to tiny morning minutes.
 */
export interface AbsSpan {
  start: number | null;
  end: number;
}

export interface AbsTimeline {
  byId: Record<string, AbsSpan>;
  /** Absolute minute the day starts (first block's start); null if untimed. */
  dayStart: number | null;
  /** Absolute minute the day ends (latest block end); equals dayStart if empty. */
  dayEnd: number;
}

/**
 * Lift a plan's "HH:MM" times onto one continuous timeline so a day that
 * crosses midnight stays ordered. Walking blocks in order, any start that
 * reads EARLIER than the previous one means the clock rolled past midnight, so
 * every time from there on gains a full day (+1440). A same-day plan never
 * trips the rollover, so its absolute minutes equal its raw minutes — behaviour
 * is unchanged for the common case.
 */
export function buildAbsoluteTimeline(items: ItineraryItem[]): AbsTimeline {
  const byId: Record<string, AbsSpan> = {};
  let prevStart: number | null = null;
  let dayStart: number | null = null;
  let dayEnd = Number.NEGATIVE_INFINITY;
  for (const it of items) {
    const rawStart = minutesOfDay(it.startTime);
    let start: number | null = null;
    if (rawStart != null) {
      let s = rawStart;
      while (prevStart != null && s < prevStart) s += 1440;
      start = s;
      prevStart = s;
      if (dayStart == null) dayStart = s;
    }
    const rawEnd = minutesOfDay(it.endTime);
    let end: number;
    if (rawEnd != null) {
      let e = rawEnd;
      // Anchor the end to its own start so a block that itself spans midnight
      // (23:50 → 00:10) reads as 10 minutes, not a day backwards.
      const base = start ?? prevStart;
      while (base != null && e < base) e += 1440;
      end = e;
    } else if (start != null) {
      end = start + (it.durationMinutes ?? 0);
    } else {
      end = Number.POSITIVE_INFINITY;
    }
    if (Number.isFinite(end)) dayEnd = Math.max(dayEnd, end);
    byId[it.id] = { start, end };
  }
  return {
    byId,
    dayStart,
    dayEnd: Number.isFinite(dayEnd) ? dayEnd : dayStart ?? 0,
  };
}

/**
 * Place the live wall clock on the same unwrapped axis as `buildAbsoluteTimeline`.
 *
 * A plan stored as bare "HH:MM" carries no date, so a time like "01:00" is
 * ambiguous: it could be the small hours of a night that's still unfolding, or
 * roughly a day away. We resolve it by snapping `now` to whichever 24h cycle
 * sits CLOSEST to the plan's [dayStart, dayEnd] window — if the clock already
 * falls inside the plan we take it verbatim, otherwise we try ±a day and keep
 * the nearest. Two cases this gets right that a naive raw compare didn't:
 *   - A plan living ENTIRELY after midnight (a 00:30 → 03:00 night out) reads as
 *     UPCOMING while it's still 22:xx the evening before, instead of 22:xx >
 *     03:00 wrongly marking the whole thing finished (→ every block greyed).
 *   - It still flips to "done" once the clock genuinely passes the plan.
 */
export function toAbsoluteNow(
  rawNow: number,
  dayStart: number | null,
  dayEnd: number,
): number {
  if (dayStart == null) return rawNow;
  const distToPlan = (x: number) =>
    x < dayStart ? dayStart - x : x > dayEnd ? x - dayEnd : 0;
  let best = rawNow;
  let bestDist = distToPlan(rawNow);
  // A plan never spans more than a day, so the right cycle is at most ±1 away.
  for (const shift of [-1440, 1440]) {
    const d = distToPlan(rawNow + shift);
    if (d < bestDist) {
      best = rawNow + shift;
      bestDist = d;
    }
  }
  return best;
}

/**
 * The router appends a synthetic "Back home" block when the day ends away from
 * home. Its `startTime` is the ARRIVAL time, not a departure — the opposite of
 * a real `travel` block (a train ride where startTime is when you board). We
 * key off the explicit `arrival` flag on fresh plans, and fall back to the
 * shape (a travel item carrying a leg but no end/duration) so trips saved
 * before the flag existed still render correctly on reload.
 */
export function isArrivalMarker(it: ItineraryItem): boolean {
  if (it.arrival) return true;
  return (
    it.kind === 'travel' &&
    !!it.travelFromPrev &&
    !it.endTime &&
    !it.durationMinutes
  );
}

/**
 * The window you are actually IN TRANSIT on the leg feeding `item`, in ABSOLUTE
 * (midnight-unwrapped) minutes `[depart, arrive]`. This is what lets the
 * progress head track the commute and the active hop glow while you're en
 * route, exactly like a normal block does — and it stays correct across
 * midnight because `arrive` comes from the unwrapped timeline.
 *
 * Returns null when the item has no incoming leg, no known start, or IS itself
 * the journey (a real `kind: 'travel'` ride) — there the card, not the
 * connector, represents the trip. Arrival markers ("Back home") keep a window
 * because their leg home is a connector and their `startTime` is the arrival.
 */
export function absCommuteWindow(
  item: ItineraryItem,
  byId: Record<string, AbsSpan>,
): { depart: number; arrive: number } | null {
  const leg = item.travelFromPrev;
  if (!leg) return null;
  if (item.kind === 'travel' && !isArrivalMarker(item)) return null;
  const arrive = byId[item.id]?.start;
  if (arrive == null) return null;
  const depart = arrive - leg.minutes;
  if (!(depart < arrive)) return null;
  return { depart, arrive };
}

/** One row of the homepage "where am I" peek. */
export interface PeekRow {
  /** `commute` → you're mid-journey; `item` → a regular block. */
  kind: 'commute' | 'item';
  /** For `commute` this is the DESTINATION you're heading to; else the block itself. */
  item: ItineraryItem;
  /** The leg you're travelling, present only when `kind === 'commute'`. */
  leg?: TravelLeg;
}

/**
 * A compact snapshot of where the day is right now, for the homepage card.
 *
 *   - status 'commuting' → `now` is the leg you're on (heading to `now.item`).
 *   - status 'active'    → `now` is the block currently underway.
 *   - status 'before'    → the day hasn't started; `now` is the first block up.
 *   - status 'done'      → everything is behind the clock; `now`/`next` null.
 *
 * `next` is the next real (non-gap) block after the current focus, so the card
 * can show "what's now / what's next" at a glance.
 */
export interface DayPeek {
  status: 'commuting' | 'active' | 'before' | 'done';
  now: PeekRow | null;
  next: PeekRow | null;
}

/** Next non-gap block strictly after `idx`, or null when none remains. */
function nextRealItem(items: ItineraryItem[], idx: number): ItineraryItem | null {
  for (let i = idx + 1; i < items.length; i++) {
    if (items[i].kind !== 'gap') return items[i];
  }
  return null;
}

/**
 * Resolve the live "now / next" peek for `itinerary` at `nowMin` (minutes since
 * midnight). Mirrors the planner screen's now/commute logic so the homepage
 * stays in lock-step with what the full timeline shows.
 */
export function getDayPeek(itinerary: Itinerary, nowMin: number): DayPeek {
  const items = itinerary.sections.flatMap((s) => s.items);
  if (items.length === 0) return { status: 'done', now: null, next: null };

  const { byId, dayStart, dayEnd } = buildAbsoluteTimeline(items);
  const nowAbs = toAbsoluteNow(nowMin, dayStart, dayEnd);

  // Focus = the first block whose end is still in the future (the one the
  // planner screen glows). Nothing left → the day is done.
  const focusIdx = items.findIndex(
    (it) => (byId[it.id]?.end ?? Number.POSITIVE_INFINITY) > nowAbs,
  );
  if (focusIdx === -1) return { status: 'done', now: null, next: null };

  const focus = items[focusIdx];
  const after = nextRealItem(items, focusIdx);
  const nextRow: PeekRow | null = after ? { kind: 'item', item: after } : null;

  // Mid-commute toward the focus? Show the leg as "now"; what's after the
  // arrival becomes "next".
  const window = absCommuteWindow(focus, byId);
  if (window && nowAbs >= window.depart && nowAbs < window.arrive && focus.travelFromPrev) {
    return {
      status: 'commuting',
      now: { kind: 'commute', item: focus, leg: focus.travelFromPrev },
      next: nextRow,
    };
  }

  const focusStart = byId[focus.id]?.start;
  const started = focusStart == null || nowAbs >= focusStart;
  return {
    status: started ? 'active' : 'before',
    now: { kind: 'item', item: focus },
    next: nextRow,
  };
}
