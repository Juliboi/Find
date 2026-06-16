import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { uid } from '@/utils/id';
import {
  deleteRecurringErrandRemote,
  pullRecurringErrands,
  pushRecurringErrand,
  pushRecurringErrands,
} from '@/lib/sync/recurringErrandsRemote';

/**
 * A recurring errand TEMPLATE — the definition the user sets up in onboarding /
 * Settings ("every Monday ping pong at 18:00"). The app materializes a real
 * `Errand` (an editable, skippable instance) for each matching day; see
 * `src/lib/recurring.ts`. The template only stores the rule + defaults.
 *
 * `weekdays` are JS weekday numbers (0 = Sunday … 6 = Saturday). `skippedDates`
 * is the exception list — dates ("YYYY-MM-DD") the user chose to skip, so the
 * template does NOT regenerate an instance for them. Place fields mirror the
 * errand model: a pinned venue (address + coords) OR an auto-place ("let Diem
 * find it") with a category query.
 */
export interface RecurringErrand {
  id: string;
  title: string;
  /** JS weekday numbers 0..6 (0 = Sunday). Empty = never fires. */
  weekdays: number[];
  startTime?: string;
  durationMin?: number;
  address?: string;
  latitude?: number;
  longitude?: number;
  placeId?: string;
  autoPlace?: boolean;
  placeQuery?: string;
  notes?: string;
  /** Dates ("YYYY-MM-DD") the user skipped this occurrence on. */
  skippedDates: string[];
  createdAt: number;
  updatedAt: number;
}

/** The editable fields of a recurring errand — what the editor collects. */
export type RecurringErrandInput = Pick<
  RecurringErrand,
  | 'title'
  | 'weekdays'
  | 'startTime'
  | 'durationMin'
  | 'address'
  | 'latitude'
  | 'longitude'
  | 'placeId'
  | 'autoPlace'
  | 'placeQuery'
  | 'notes'
>;

interface RecurringErrandsState {
  items: RecurringErrand[];
  /** The auth user this local cache belongs to (see errands store for why). */
  ownerId: string | null;
  add: (input: RecurringErrandInput) => string;
  update: (id: string, patch: Partial<RecurringErrandInput>) => void;
  remove: (id: string) => void;
  /** Mark a single occurrence date as skipped, so it won't regenerate. */
  skipOccurrence: (id: string, date: string) => void;
  /** Undo a skip (the occurrence will regenerate on the next pass). */
  unskipOccurrence: (id: string, date: string) => void;
  syncFromRemote: (userId: string) => Promise<void>;
  reset: () => void;
}

const MAX_RECURRING = 100;

function clean(value: string | undefined | null): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function numOrUndef(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Keep only valid, unique JS weekday numbers (0..6), sorted. */
function cleanWeekdays(list: number[] | undefined | null): number[] {
  if (!Array.isArray(list)) return [];
  const set = new Set<number>();
  for (const n of list) {
    if (typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 6) set.add(n);
  }
  return [...set].sort((a, b) => a - b);
}

function normalizeInput(input: RecurringErrandInput): RecurringErrandInput {
  const address = clean(input.address);
  // Auto-place ("Let Diem find it") only applies when no real place is pinned.
  const autoPlace = !address && input.autoPlace === true;
  return {
    title: clean(input.title) ?? 'Untitled',
    weekdays: cleanWeekdays(input.weekdays),
    startTime: clean(input.startTime),
    durationMin: numOrUndef(input.durationMin),
    address,
    latitude: address ? numOrUndef(input.latitude) : undefined,
    longitude: address ? numOrUndef(input.longitude) : undefined,
    placeId: address ? clean(input.placeId) : undefined,
    autoPlace: autoPlace ? true : undefined,
    placeQuery: autoPlace ? clean(input.placeQuery) ?? clean(input.title) : undefined,
    notes: clean(input.notes),
  };
}

/** Union by id, keeping whichever copy was touched most recently. */
function mergeRecurring(
  local: RecurringErrand[],
  remote: RecurringErrand[],
): RecurringErrand[] {
  const byId = new Map<string, RecurringErrand>();
  for (const e of local) byId.set(e.id, e);
  for (const r of remote) {
    const l = byId.get(r.id);
    if (!l || r.updatedAt >= l.updatedAt) byId.set(r.id, r);
  }
  return [...byId.values()].slice(0, MAX_RECURRING);
}

export const useRecurringErrandsStore = create<RecurringErrandsState>()(
  persist(
    (set, get) => ({
      items: [],
      ownerId: null,
      add: (input) => {
        const id = uid('rcr');
        const now = Date.now();
        const entry: RecurringErrand = {
          id,
          ...normalizeInput(input),
          skippedDates: [],
          createdAt: now,
          updatedAt: now,
        };
        set((state) => ({ items: [entry, ...state.items].slice(0, MAX_RECURRING) }));
        const owner = get().ownerId;
        if (owner) pushRecurringErrand(entry, owner);
        return id;
      },
      update: (id, patch) => {
        set((state) => ({
          items: state.items.map((e) => {
            if (e.id !== id) return e;
            const next: RecurringErrand = { ...e, updatedAt: Date.now() };
            if ('title' in patch) next.title = clean(patch.title) ?? e.title;
            if ('weekdays' in patch) next.weekdays = cleanWeekdays(patch.weekdays);
            if ('startTime' in patch) next.startTime = clean(patch.startTime);
            if ('durationMin' in patch) next.durationMin = numOrUndef(patch.durationMin);
            if ('notes' in patch) next.notes = clean(patch.notes);
            // Address + auto-place + place metadata move together (see errands).
            if ('address' in patch || 'autoPlace' in patch || 'placeQuery' in patch) {
              const addr = clean(patch.address);
              const auto = !addr && patch.autoPlace === true;
              next.address = addr;
              next.latitude = addr ? numOrUndef(patch.latitude) : undefined;
              next.longitude = addr ? numOrUndef(patch.longitude) : undefined;
              next.placeId = addr ? clean(patch.placeId) : undefined;
              next.autoPlace = auto ? true : undefined;
              next.placeQuery = auto
                ? clean(patch.placeQuery) ?? next.placeQuery ?? clean(next.title)
                : undefined;
            }
            return next;
          }),
        }));
        const owner = get().ownerId;
        const updated = get().items.find((e) => e.id === id);
        if (owner && updated) pushRecurringErrand(updated, owner);
      },
      remove: (id) => {
        set((state) => ({ items: state.items.filter((e) => e.id !== id) }));
        if (get().ownerId) deleteRecurringErrandRemote(id);
      },
      skipOccurrence: (id, date) => {
        set((state) => ({
          items: state.items.map((e) =>
            e.id === id && !e.skippedDates.includes(date)
              ? { ...e, skippedDates: [...e.skippedDates, date], updatedAt: Date.now() }
              : e,
          ),
        }));
        const owner = get().ownerId;
        const updated = get().items.find((e) => e.id === id);
        if (owner && updated) pushRecurringErrand(updated, owner);
      },
      unskipOccurrence: (id, date) => {
        set((state) => ({
          items: state.items.map((e) =>
            e.id === id && e.skippedDates.includes(date)
              ? {
                  ...e,
                  skippedDates: e.skippedDates.filter((d) => d !== date),
                  updatedAt: Date.now(),
                }
              : e,
          ),
        }));
        const owner = get().ownerId;
        const updated = get().items.find((e) => e.id === id);
        if (owner && updated) pushRecurringErrand(updated, owner);
      },
      syncFromRemote: async (userId) => {
        const remote = await pullRecurringErrands(userId);
        if (!remote) return; // offline / not configured — keep local untouched
        const sameUser = get().ownerId === userId;
        if (sameUser) {
          set((state) => ({
            items: mergeRecurring(state.items, remote),
            ownerId: userId,
          }));
          const remoteIds = new Set(remote.map((e) => e.id));
          const localOnly = get().items.filter((e) => !remoteIds.has(e.id));
          if (localOnly.length) pushRecurringErrands(localOnly, userId);
        } else {
          set({ items: remote.slice(0, MAX_RECURRING), ownerId: userId });
        }
      },
      reset: () => set({ items: [], ownerId: null }),
    }),
    {
      name: 'dayflow.recurring-errands.v1',
      version: 1,
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
);
