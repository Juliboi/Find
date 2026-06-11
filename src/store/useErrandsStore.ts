import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { uid } from '@/utils/id';
import type { VenueOpeningHours } from '@/types/itinerary';
import {
  deleteErrandRemote,
  pullErrands,
  pushErrand,
  pushErrands,
} from '@/lib/sync/errandsRemote';

/**
 * An "errand" is a lightweight reminder / task the user jots down from the home
 * composer — "call mom", "dentist at 18:00", "visit dentist at Pirktova". Unlike
 * a planned day item it is NOT yet scheduled: any of its slots can be empty
 * (`undefined`), which the UI renders as "Anytime" / "Any day" / "Anywhere".
 *
 * Errands are stored locally-first (AsyncStorage), the same way saved
 * itineraries are. They'll later feed the planner as suggestions the user can
 * drop into gaps; for now we just create, store, and surface them on the home
 * screen.
 */
export interface Errand {
  id: string;
  /** Short imperative title, e.g. "Call mom", "Visit dentist". */
  title: string;
  /** "HH:MM" 24h start, or undefined for "Anytime". */
  startTime?: string;
  /** "HH:MM" 24h end, or undefined. */
  endTime?: string;
  /**
   * Rough length in minutes. Independent of the start/end slots so an UNTIMED
   * ("Anytime") errand can still carry a "how long" estimate the planner uses to
   * reserve a big-enough gap. For a timed errand it mirrors `endTime − startTime`;
   * undefined means "any length" (no estimate given).
   */
  durationMin?: number;
  /** "YYYY-MM-DD", or undefined for "Any day". */
  date?: string;
  /** Freeform place / address label, or undefined for "Anywhere". */
  address?: string;
  /**
   * Resolved coordinates for `address`, set when the user picks a real place
   * from search. Only ever present alongside `address`; when the address is a
   * raw, unconfirmed string (or cleared) these are undefined. The planner uses
   * them to route to / time-cost an errand suggestion.
   */
  latitude?: number;
  longitude?: number;
  /**
   * Rich venue metadata, present when the address was resolved to a real place
   * (Google provider). All optional and only meaningful alongside `address`.
   * `placeId` lets us re-fetch fresh details later; `openingHours` is the stable
   * weekly schedule (we derive open/closed at display time, never persist a
   * stale "open now").
   */
  placeId?: string;
  photoUrl?: string;
  rating?: number;
  ratingCount?: number;
  priceLevel?: number;
  openingHours?: VenueOpeningHours;
  /** Optional extra note the parser pulled out. */
  notes?: string;
  /** The raw text the user typed, kept so we can re-parse / show provenance. */
  rawText: string;
  /**
   * The day ("YYYY-MM-DD") this errand was folded into a plan, or undefined if
   * it hasn't been. Its presence flags the errand as "Planned" (see
   * `errandStatus`); once that day is in the past the errand reads as "Done".
   * Cleared by `reopen` to pull the errand back to the active list.
   */
  plannedDate?: string;
  done: boolean;
  createdAt: number;
  updatedAt: number;
}

/** The editable fields of an errand — what the drawer collects before saving. */
export type ErrandInput = Pick<
  Errand,
  | 'title'
  | 'startTime'
  | 'endTime'
  | 'durationMin'
  | 'date'
  | 'address'
  | 'latitude'
  | 'longitude'
  | 'placeId'
  | 'photoUrl'
  | 'rating'
  | 'ratingCount'
  | 'priceLevel'
  | 'openingHours'
  | 'notes'
  | 'rawText'
>;

interface ErrandsState {
  items: Errand[];
  /**
   * The auth user this local cache belongs to. Lets sync tell "same user, new
   * device / came back online" (→ merge) apart from "a different user signed in
   * on this device" (→ replace, never leak/upload the previous user's errands).
   */
  ownerId: string | null;
  /** Create an errand from the drawer's collected fields. Returns its id. */
  add: (input: ErrandInput) => string;
  /** Patch an existing errand in place (used by the edit drawer). */
  update: (id: string, patch: Partial<ErrandInput>) => void;
  /** Flip the done flag — the home list uses this for quick triage. */
  toggleDone: (id: string) => void;
  /**
   * Mark a batch of errands as folded into the plan for `date` (→ "Planned").
   * Called when the planner request is built from the chosen errands.
   */
  setPlanned: (ids: string[], date: string) => void;
  /** Pull an errand back to the active list: clears both `done` and `plannedDate`. */
  reopen: (id: string) => void;
  remove: (id: string) => void;
  clearCompleted: () => void;
  /**
   * Reconcile the local cache with Supabase for `userId`. Same user → merge
   * (last-write-wins by updatedAt) and flush any local-only rows up; different
   * user → replace local with theirs. No-ops offline / when sync is unavailable.
   */
  syncFromRemote: (userId: string) => Promise<void>;
  /** Drop everything (sign-out): clears the cache so the next user starts clean. */
  reset: () => void;
}

const MAX_ERRANDS = 200;

/** Normalise a possibly-empty string field to `undefined` (= "any"). */
function clean(value: string | undefined | null): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Keep only finite numbers; anything else (null/NaN/undefined) → undefined. */
function numOrUndef(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Keep opening hours only when they carry something usable. */
function cleanHours(
  v: VenueOpeningHours | null | undefined,
): VenueOpeningHours | undefined {
  if (!v) return undefined;
  const hasPeriods = Array.isArray(v.periods) && v.periods.length > 0;
  const hasDesc =
    Array.isArray(v.weekdayDescriptions) && v.weekdayDescriptions.length > 0;
  return hasPeriods || hasDesc ? v : undefined;
}

function normalizeInput(input: ErrandInput): ErrandInput {
  const address = clean(input.address);
  // All place metadata is meaningless without an address — drop it wholesale
  // when there's no place, so a cleared address can't leave a stale photo/pin.
  return {
    title: clean(input.title) ?? clean(input.rawText) ?? 'Untitled errand',
    startTime: clean(input.startTime),
    endTime: clean(input.endTime),
    durationMin: numOrUndef(input.durationMin),
    date: clean(input.date),
    address,
    latitude: address ? numOrUndef(input.latitude) : undefined,
    longitude: address ? numOrUndef(input.longitude) : undefined,
    placeId: address ? clean(input.placeId) : undefined,
    photoUrl: address ? clean(input.photoUrl) : undefined,
    rating: address ? numOrUndef(input.rating) : undefined,
    ratingCount: address ? numOrUndef(input.ratingCount) : undefined,
    priceLevel: address ? numOrUndef(input.priceLevel) : undefined,
    openingHours: address ? cleanHours(input.openingHours) : undefined,
    notes: clean(input.notes),
    rawText: clean(input.rawText) ?? clean(input.title) ?? '',
  };
}

/**
 * Merge a remote errand list into the local one for the SAME user: union by id,
 * keeping whichever copy was touched most recently (last-write-wins on the
 * client clock both sides write). Local-only rows survive (offline creations
 * pending upload); remote-only rows are pulled in.
 */
function mergeErrands(local: Errand[], remote: Errand[]): Errand[] {
  const byId = new Map<string, Errand>();
  for (const e of local) byId.set(e.id, e);
  for (const r of remote) {
    const l = byId.get(r.id);
    if (!l || r.updatedAt >= l.updatedAt) byId.set(r.id, r);
  }
  return [...byId.values()].slice(0, MAX_ERRANDS);
}

export const useErrandsStore = create<ErrandsState>()(
  persist(
    (set, get) => ({
      items: [],
      ownerId: null,
      add: (input) => {
        const id = uid('errand');
        const now = Date.now();
        const entry: Errand = {
          id,
          ...normalizeInput(input),
          done: false,
          createdAt: now,
          updatedAt: now,
        };
        set((state) => ({ items: [entry, ...state.items].slice(0, MAX_ERRANDS) }));
        const owner = get().ownerId;
        if (owner) pushErrand(entry, owner);
        return id;
      },
      update: (id, patch) => {
        set((state) => ({
          items: state.items.map((e) => {
            if (e.id !== id) return e;
            // Only overwrite keys the caller actually passed, running strings
            // through `clean` so blanking a field maps to undefined
            // ("Anytime"/"Anywhere") rather than an empty string.
            const next: Errand = { ...e, updatedAt: Date.now() };
            if ('title' in patch) next.title = clean(patch.title) ?? e.title;
            if ('startTime' in patch) next.startTime = clean(patch.startTime);
            if ('endTime' in patch) next.endTime = clean(patch.endTime);
            if ('durationMin' in patch) next.durationMin = numOrUndef(patch.durationMin);
            if ('date' in patch) next.date = clean(patch.date);
            if ('notes' in patch) next.notes = clean(patch.notes);
            if ('rawText' in patch) next.rawText = clean(patch.rawText) ?? e.rawText;
            // Address + place metadata move together: a new/blank address
            // resets coords, photo, rating, and hours.
            if ('address' in patch) {
              const addr = clean(patch.address);
              next.address = addr;
              next.latitude = addr ? numOrUndef(patch.latitude) : undefined;
              next.longitude = addr ? numOrUndef(patch.longitude) : undefined;
              next.placeId = addr ? clean(patch.placeId) : undefined;
              next.photoUrl = addr ? clean(patch.photoUrl) : undefined;
              next.rating = addr ? numOrUndef(patch.rating) : undefined;
              next.ratingCount = addr ? numOrUndef(patch.ratingCount) : undefined;
              next.priceLevel = addr ? numOrUndef(patch.priceLevel) : undefined;
              next.openingHours = addr ? cleanHours(patch.openingHours) : undefined;
            }
            return next;
          }),
        }));
        const owner = get().ownerId;
        const updated = get().items.find((e) => e.id === id);
        if (owner && updated) pushErrand(updated, owner);
      },
      toggleDone: (id) => {
        set((state) => ({
          items: state.items.map((e) =>
            e.id === id ? { ...e, done: !e.done, updatedAt: Date.now() } : e,
          ),
        }));
        const owner = get().ownerId;
        const updated = get().items.find((e) => e.id === id);
        if (owner && updated) pushErrand(updated, owner);
      },
      setPlanned: (ids, date) => {
        const idSet = new Set(ids);
        if (idSet.size === 0) return;
        const now = Date.now();
        set((state) => ({
          items: state.items.map((e) =>
            idSet.has(e.id) ? { ...e, plannedDate: date, updatedAt: now } : e,
          ),
        }));
        const owner = get().ownerId;
        if (owner) {
          const touched = get().items.filter((e) => idSet.has(e.id));
          if (touched.length) pushErrands(touched, owner);
        }
      },
      reopen: (id) => {
        set((state) => ({
          items: state.items.map((e) =>
            e.id === id
              ? { ...e, done: false, plannedDate: undefined, updatedAt: Date.now() }
              : e,
          ),
        }));
        const owner = get().ownerId;
        const updated = get().items.find((e) => e.id === id);
        if (owner && updated) pushErrand(updated, owner);
      },
      remove: (id) => {
        set((state) => ({ items: state.items.filter((e) => e.id !== id) }));
        if (get().ownerId) deleteErrandRemote(id);
      },
      clearCompleted: () => {
        const removed = get().items.filter((e) => e.done);
        set((state) => ({ items: state.items.filter((e) => !e.done) }));
        if (get().ownerId) removed.forEach((e) => deleteErrandRemote(e.id));
      },
      syncFromRemote: async (userId) => {
        const remote = await pullErrands(userId);
        if (!remote) return; // offline / not configured — keep local untouched
        const sameUser = get().ownerId === userId;
        if (sameUser) {
          set((state) => ({ items: mergeErrands(state.items, remote), ownerId: userId }));
          // Flush rows the server hasn't seen yet (created offline / pre-sign-in).
          const remoteIds = new Set(remote.map((e) => e.id));
          const localOnly = get().items.filter((e) => !remoteIds.has(e.id));
          if (localOnly.length) pushErrands(localOnly, userId);
        } else {
          // A different user owns this device now: adopt their errands wholesale
          // rather than merging (which would leak the previous user's rows).
          set({ items: remote.slice(0, MAX_ERRANDS), ownerId: userId });
        }
      },
      reset: () => set({ items: [], ownerId: null }),
    }),
    {
      name: 'dayflow.errands.v1',
      version: 1,
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
);

/**
 * Sort errands for display: not-done before done, then by date (undated last),
 * then by start time (untimed last within a day), then most-recently created.
 * Pure + exported so the home screen can memoize it.
 */
export function sortErrands(items: Errand[]): Errand[] {
  const dateKey = (e: Errand) => e.date ?? '9999-99-99';
  const timeKey = (e: Errand) => e.startTime ?? '99:99';
  return [...items].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    const dk = dateKey(a).localeCompare(dateKey(b));
    if (dk !== 0) return dk;
    const tk = timeKey(a).localeCompare(timeKey(b));
    if (tk !== 0) return tk;
    return b.createdAt - a.createdAt;
  });
}

/** An errand's lifecycle bucket, derived from `done` + `plannedDate`. */
export type ErrandStatus = 'open' | 'planned' | 'done';

/**
 * Derive an errand's bucket. `done` is terminal. Otherwise a `plannedDate`
 * means it's been folded into a plan: still upcoming → "planned", already in
 * the past → "done" (it's behind us). No `plannedDate` and not done → "open"
 * (an active candidate). Derived (never persisted) so the past-day promotion
 * needs no write, and a pull-back is just clearing `plannedDate`.
 */
export function errandStatus(e: Errand, todayIso: string): ErrandStatus {
  if (e.done) return 'done';
  if (e.plannedDate) return e.plannedDate < todayIso ? 'done' : 'planned';
  return 'open';
}

/** Display buckets for an errand list (see `groupErrands`). */
export interface ErrandGroups {
  /** Open + dated. The `focusDate` floats to the front, then chronological. */
  scheduled: Errand[];
  /** Open + undated ("Anytime"). Newest first. */
  anytime: Errand[];
  /** Planned or done. Most recently touched first. */
  completed: Errand[];
}

/**
 * Bucket errands for display. `today` drives status (open vs planned vs done);
 * `focusDate` — today on the home list, the day being planned in the drawer —
 * floats that day's errands to the front of the `scheduled` group so they read
 * first. Pure + exported so screens can memoize it.
 */
export function groupErrands(
  items: Errand[],
  { focusDate, today }: { focusDate: string; today: string },
): ErrandGroups {
  const scheduled: Errand[] = [];
  const anytime: Errand[] = [];
  const completed: Errand[] = [];
  for (const e of items) {
    const status = errandStatus(e, today);
    if (status !== 'open') completed.push(e);
    else if (e.date) scheduled.push(e);
    else anytime.push(e);
  }
  scheduled.sort((a, b) => {
    const af = a.date === focusDate ? 0 : 1;
    const bf = b.date === focusDate ? 0 : 1;
    if (af !== bf) return af - bf;
    const dk = (a.date ?? '').localeCompare(b.date ?? '');
    if (dk !== 0) return dk;
    return b.createdAt - a.createdAt;
  });
  anytime.sort((a, b) => b.createdAt - a.createdAt);
  completed.sort((a, b) => b.updatedAt - a.updatedAt);
  return { scheduled, anytime, completed };
}
