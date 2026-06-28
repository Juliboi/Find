/**
 * Projects the day's active saved plan onto the calendar.
 *
 * The calendar is errand-centric, but a day usually also has a *plan* (a saved
 * itinerary). Rather than duplicate that plan into the errands store (which would
 * need fragile two-way sync), we project its timed stops into READ-ONLY pseudo-
 * errands at render time. Because the source of truth stays the saved itinerary —
 * which `itinerary.tsx` edits and persists into the reactive `useSavedItineraries`
 * store — any change there flows straight onto the calendar with no extra wiring.
 *
 * The projected errands carry a `planRef` so every surface can tell them apart:
 * the editor locks them (no drag/resize/delete) and a tap opens the plan.
 */
import type { Errand } from '@/store/useErrandsStore';
import {
  activePlanForDate,
  type SavedItinerary,
} from '@/store/useSavedItineraries';
import type { Itinerary, ItineraryItem, ItineraryItemKind } from '@/types/itinerary';
import { minutesOfDay } from '@/utils/time';

/** Kinds that are spacing/commute rather than a place you'd block out time at. */
const SKIPPED_KINDS: ReadonlySet<ItineraryItemKind> = new Set(['travel', 'gap']);

const DAY_MIN = 24 * 60;

function toHHMM(total: number): string {
  const m = ((Math.round(total) % DAY_MIN) + DAY_MIN) % DAY_MIN;
  const h = Math.floor(m / 60);
  return `${String(h).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/**
 * Turn one itinerary item into a read-only pseudo-errand, or null when it has no
 * start time / isn't a real stop (travel legs, elastic gaps). The end falls back
 * through explicit end → duration → a 60-minute default, mirroring
 * `errandToCalEvent` so plan blocks size the same way errands do.
 */
function itemToErrand(
  item: ItineraryItem,
  plan: SavedItinerary,
  date: string,
): Errand | null {
  if (SKIPPED_KINDS.has(item.kind)) return null;
  const startMin = minutesOfDay(item.startTime);
  if (startMin == null) return null;

  const explicitEnd = minutesOfDay(item.endTime);
  let endMin: number;
  if (explicitEnd != null && explicitEnd > startMin) endMin = explicitEnd;
  else if (item.durationMinutes && item.durationMinutes > 0) endMin = startMin + item.durationMinutes;
  else endMin = startMin + 60;
  endMin = Math.min(DAY_MIN, endMin);

  const place = item.place;
  return {
    id: `plan:${plan.id}:${item.id}`,
    title: item.title || place?.name || 'Plan stop',
    startTime: toHHMM(startMin),
    endTime: toHHMM(endMin),
    durationMin: Math.max(1, endMin - startMin),
    date,
    address: place?.address ?? place?.name,
    latitude: place?.coords?.latitude,
    longitude: place?.coords?.longitude,
    photoUrl: place?.photoUrl,
    planRef: { planId: plan.id, itemId: item.id },
    rawText: '',
    done: false,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
  };
}

function normalizeTitle(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * The errand a plan stop represents purely by TITLE (+ time overlap when both
 * are timed), for legacy plans saved before `errandId` existed or stops the
 * planner didn't link. A timed errand must overlap the stop; an UNTIMED errand
 * (a reminder with no slot the plan scheduled) matches on title alone, so it
 * folds into the plan instead of also sitting in the "Unscheduled" tray.
 * Skips errands already claimed by an id link so an unlinked stop can't steal
 * an errand another stop owns.
 */
function findTitleMatch(
  item: ItineraryItem,
  dayErrands: Errand[],
  claimed: Set<string>,
): Errand | undefined {
  const title = normalizeTitle(item.title);
  if (!title) return undefined;
  const is = minutesOfDay(item.startTime);
  const ie =
    is != null ? minutesOfDay(item.endTime) ?? is + (item.durationMinutes ?? 60) : null;
  return dayErrands.find((e) => {
    if (claimed.has(e.id)) return false;
    if (normalizeTitle(e.title) !== title) return false;
    const es = minutesOfDay(e.startTime);
    if (es == null || is == null || ie == null) return true; // either side untimed → title is enough
    const ee = minutesOfDay(e.endTime) ?? es + (e.durationMin ?? 60);
    return is < ee && es < ie; // any overlap
  });
}

/**
 * The active plan projected onto the calendar's errand layer for `date`:
 *  - `planErrands`: every timed stop as a read-only pseudo-errand (in plan
 *    order), carrying the source errand's recurring identity when known so the
 *    block can still show a repeat marker.
 *  - `shadowed`: the ids of real errands this plan already represents. Callers
 *    HIDE these from the errand layer so each activity is drawn once — as the
 *    plan's block, edited in the planner — instead of also appearing as a loose,
 *    movable errand. The plan is authoritative.
 *
 * Matching is by the persisted `errandId` link first, then a title(+time)
 * fallback for legacy plans. A loose errand the plan never folded in stays out
 * of `shadowed` and keeps its normal free-form behaviour.
 */
export interface PlanLayer {
  planErrands: Errand[];
  shadowed: Set<string>;
}

export function planLayer(
  savedTrips: SavedItinerary[],
  date: string,
  errands: Errand[] = [],
): PlanLayer {
  const plan = activePlanForDate(savedTrips, date);
  if (!plan) return { planErrands: [], shadowed: new Set() };

  const dayErrands = errands.filter(
    (x) => x.date === date && !x.done && x.planRef == null,
  );
  const byId = new Map(dayErrands.map((e) => [e.id, e] as const));

  const items: ItineraryItem[] = [];
  for (const section of plan.itinerary.sections) {
    for (const item of section.items) items.push(item);
  }

  const shadowed = new Set<string>();
  // item.id → the real errand it represents (for the recurring marker below).
  const srcByItemId = new Map<string, Errand>();

  // Pass 1 — the reliable persisted link.
  for (const it of items) {
    if (it.errandId && byId.has(it.errandId)) {
      const src = byId.get(it.errandId)!;
      shadowed.add(src.id);
      srcByItemId.set(it.id, src);
    }
  }
  // Pass 2 — title(+time) fallback for unlinked stops / legacy plans.
  for (const it of items) {
    if (srcByItemId.has(it.id)) continue;
    const match = findTitleMatch(it, dayErrands, shadowed);
    if (match) {
      shadowed.add(match.id);
      srcByItemId.set(it.id, match);
    }
  }

  const planErrands: Errand[] = [];
  for (const it of items) {
    const e = itemToErrand(it, plan, date);
    if (!e) continue;
    const src = srcByItemId.get(it.id);
    if (src?.recurringId) e.recurringId = src.recurringId;
    planErrands.push(e);
  }
  return { planErrands, shadowed };
}

/**
 * The day's real errands MERGED with the active plan: errands the plan already
 * represents are dropped and the plan's blocks added in their place, so every
 * surface (day grid, week strip, mini timeline, the Unscheduled tray) shows one
 * coherent picture. Returns the input array unchanged when there is no plan, so
 * memoized callers don't re-render needlessly.
 */
export function dayErrandsWithPlan(
  savedTrips: SavedItinerary[],
  date: string,
  errands: Errand[],
): Errand[] {
  const { planErrands, shadowed } = planLayer(savedTrips, date, errands);
  if (planErrands.length === 0 && shadowed.size === 0) return errands;
  return [...errands.filter((e) => !shadowed.has(e.id)), ...planErrands];
}

/** True for an errand that is actually a projected plan stop (see above). */
export function isPlanErrand(errand: Errand): boolean {
  return errand.planRef != null;
}

/**
 * Stamps the persisted `errandId` link onto any plan stop that currently matches
 * one of the day's errands by title(+time) but has no link yet — "healing" legacy
 * plans (saved before `errandId` existed). Done once when the user starts editing
 * a plan on the grid so the dedup becomes id-based (stable) instead of time-based:
 * otherwise dragging a stop off its errand's slot breaks the title+time match and
 * the folded-in errand pops back as a loose blue block. Returns the input
 * unchanged when nothing needs linking, so callers can compare by reference.
 */
export function stampErrandLinks(
  itin: Itinerary,
  date: string,
  errands: Errand[],
): Itinerary {
  const dayErrands = errands.filter(
    (x) => x.date === date && !x.done && x.planRef == null,
  );
  if (dayErrands.length === 0) return itin;
  const byId = new Map(dayErrands.map((e) => [e.id, e] as const));

  // Errands already owned by an explicit link can't be claimed again.
  const claimed = new Set<string>();
  for (const s of itin.sections) {
    for (const it of s.items) {
      if (it.errandId && byId.has(it.errandId)) claimed.add(it.errandId);
    }
  }

  let changed = false;
  const sections = itin.sections.map((s) => ({
    ...s,
    items: s.items.map((it) => {
      if (it.errandId || SKIPPED_KINDS.has(it.kind)) return it;
      const match = findTitleMatch(it, dayErrands, claimed);
      if (!match) return it;
      claimed.add(match.id);
      changed = true;
      return { ...it, errandId: match.id };
    }),
  }));
  return changed ? { ...itin, sections } : itin;
}
