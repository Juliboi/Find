import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { Itinerary } from '@/types/itinerary';
import {
  deleteItineraryRemote,
  pullItineraries,
  pushItineraries,
  pushItinerary,
} from '@/lib/sync/itinerariesRemote';

/**
 * A planned day saved for later. Stores the full itinerary (so it can be
 * re-opened and previewed offline, with its travel legs and map data intact)
 * plus a light summary used to render the homepage card without walking the
 * whole object.
 */
export interface SavedItinerary {
  id: string;
  title: string;
  /** Epoch ms when it was saved. */
  createdAt: number;
  /** Epoch ms of the last in-place change (route refresh, edit). Drives
   *  last-write-wins when syncing across devices. */
  updatedAt: number;
  date?: string;
  origin?: string;
  city?: string;
  /** Number of located stops, for the card subtitle. */
  stopCount: number;
  /** First place photo, used as the card thumbnail. */
  thumbUrl?: string;
  /**
   * Marks this entry as the chosen plan for its `date`. At most one entry
   * per day carries this (the store enforces it on `activate`). When no
   * entry for a day is flagged, the day's active plan defaults to the
   * earliest-created one — see `activePlanForDate`.
   */
  isActive?: boolean;
  itinerary: Itinerary;
}

interface SavedState {
  items: SavedItinerary[];
  /** The auth user this local cache belongs to (see useErrandsStore for why). */
  ownerId: string | null;
  /** Persist a freshly planned itinerary; returns its saved id. */
  save: (itinerary: Itinerary) => string;
  /**
   * Replace the itinerary on an existing saved entry in-place. Used after a
   * route recompute or live edit so the homepage card swaps to the new version
   * without spawning a duplicate save (and without bumping createdAt — this is
   * the same trip, just refreshed).
   */
  update: (id: string, itinerary: Itinerary) => void;
  /**
   * Duplicate a saved entry. Returns the new saved id, or null when the
   * source doesn't exist. The clone gets fresh internal ids (itinerary,
   * section, item) so live edits on one copy never accidentally mutate the
   * other; the title is suffixed with " (copy)" so the two are distinguishable
   * on the homepage.
   */
  duplicate: (id: string) => string | null;
  remove: (id: string) => void;
  /**
   * Pin `id` as the active plan for its day. Sets `isActive` on it and
   * clears the flag on every other saved entry sharing the same `date`
   * (one active plan per day), bumping `updatedAt` on the changed rows so
   * the choice wins on cross-device merge. Pushes the changed rows remote.
   */
  activate: (id: string) => void;
  /**
   * Reconcile with Supabase for `userId`. Same user → merge (last-write-wins)
   * and flush local-only rows; different user → adopt theirs. No-ops offline.
   */
  syncFromRemote: (userId: string) => Promise<void>;
  /** Drop everything on sign-out. */
  reset: () => void;
}

const MAX_SAVED = 20;

/**
 * Deep-clones an itinerary and re-stamps every id (top-level, section, item)
 * so the copy is fully independent of its source. Travel legs, places,
 * descriptions etc. are kept by value via JSON round-trip, which is fine
 * because everything in `Itinerary` is JSON-safe by design (it persists
 * through AsyncStorage too).
 */
function cloneItinerary(itin: Itinerary): Itinerary {
  const base = JSON.parse(JSON.stringify(itin)) as Itinerary;
  const stamp = Date.now().toString(36);
  let n = 0;
  const nid = (kind: string) => `dup-${stamp}-${kind}-${++n}`;
  base.id = nid('it');
  base.sections = base.sections.map((s) => ({
    ...s,
    id: nid('sec'),
    items: s.items.map((it) => ({ ...it, id: nid('item') })),
  }));
  return base;
}

function summarize(
  itinerary: Itinerary,
): Pick<SavedItinerary, 'title' | 'date' | 'origin' | 'city' | 'stopCount' | 'thumbUrl'> {
  let stopCount = 0;
  let thumbUrl: string | undefined;
  for (const section of itinerary.sections) {
    for (const item of section.items) {
      if (item.place?.coords) stopCount += 1;
      if (!thumbUrl && item.place?.photoUrl) thumbUrl = item.place.photoUrl;
    }
  }
  return {
    title: itinerary.title,
    date: itinerary.date,
    origin: itinerary.origin,
    city: itinerary.city,
    stopCount,
    thumbUrl,
  };
}

let counter = 0;
function newId(): string {
  counter += 1;
  return `saved-${Date.now().toString(36)}-${counter}`;
}

/**
 * Merge a remote saved-itinerary list into the local one for the SAME user:
 * union by id, newest (updatedAt) wins. Local-only entries survive (offline
 * saves pending upload); remote-only entries are pulled in.
 */
function mergeSaved(local: SavedItinerary[], remote: SavedItinerary[]): SavedItinerary[] {
  const byId = new Map<string, SavedItinerary>();
  for (const s of local) byId.set(s.id, s);
  for (const r of remote) {
    const l = byId.get(r.id);
    if (!l || (r.updatedAt ?? r.createdAt) >= (l.updatedAt ?? l.createdAt)) {
      byId.set(r.id, r);
    }
  }
  // Keep the homepage's "newest first" feel after a merge.
  return [...byId.values()]
    .sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt))
    .slice(0, MAX_SAVED);
}

export const useSavedItineraries = create<SavedState>()(
  persist(
    (set, get) => ({
      items: [],
      ownerId: null,
      save: (itinerary) => {
        const id = newId();
        const now = Date.now();
        const entry: SavedItinerary = {
          id,
          createdAt: now,
          updatedAt: now,
          itinerary,
          ...summarize(itinerary),
        };
        set((state) => ({ items: [entry, ...state.items].slice(0, MAX_SAVED) }));
        const owner = get().ownerId;
        if (owner) pushItinerary(entry, owner);
        return id;
      },
      update: (id, itinerary) => {
        set((state) => ({
          items: state.items.map((entry) =>
            entry.id === id
              ? {
                  ...entry,
                  itinerary,
                  updatedAt: Date.now(),
                  ...summarize(itinerary),
                }
              : entry,
          ),
        }));
        const owner = get().ownerId;
        const updated = get().items.find((i) => i.id === id);
        if (owner && updated) pushItinerary(updated, owner);
      },
      duplicate: (id) => {
        let createdId: string | null = null;
        set((state) => {
          const source = state.items.find((i) => i.id === id);
          if (!source) return state;
          const cloned = cloneItinerary(source.itinerary);
          // Distinguish the copy on the homepage. Keeping the suffix in the
          // itinerary itself (not just the saved entry) means it also shows
          // in the itinerary screen header when the user opens the duplicate.
          cloned.title = `${source.itinerary.title} (copy)`;
          createdId = newId();
          const now = Date.now();
          const entry: SavedItinerary = {
            id: createdId,
            createdAt: now,
            updatedAt: now,
            itinerary: cloned,
            ...summarize(cloned),
          };
          return { items: [entry, ...state.items].slice(0, MAX_SAVED) };
        });
        const owner = get().ownerId;
        const created = createdId ? get().items.find((i) => i.id === createdId) : null;
        if (owner && created) pushItinerary(created, owner);
        return createdId;
      },
      remove: (id) => {
        set((state) => ({ items: state.items.filter((i) => i.id !== id) }));
        if (get().ownerId) deleteItineraryRemote(id);
      },
      activate: (id) => {
        const target = get().items.find((i) => i.id === id);
        if (!target || target.isActive) return;
        const day = target.date;
        const now = Date.now();
        set((state) => ({
          items: state.items.map((entry) => {
            if (entry.id === id) return { ...entry, isActive: true, updatedAt: now };
            // Only same-day siblings lose the flag — other days keep theirs.
            if (entry.date === day && entry.isActive) {
              return { ...entry, isActive: false, updatedAt: now };
            }
            return entry;
          }),
        }));
        const owner = get().ownerId;
        if (owner) {
          const changed = get().items.filter((i) => i.date === day);
          if (changed.length) pushItineraries(changed, owner);
        }
      },
      syncFromRemote: async (userId) => {
        const remote = await pullItineraries(userId);
        if (!remote) return; // offline / not configured — keep local untouched
        const sameUser = get().ownerId === userId;
        if (sameUser) {
          set((state) => ({ items: mergeSaved(state.items, remote), ownerId: userId }));
          const remoteIds = new Set(remote.map((s) => s.id));
          const localOnly = get().items.filter((s) => !remoteIds.has(s.id));
          if (localOnly.length) pushItineraries(localOnly, userId);
        } else {
          set({ items: remote.slice(0, MAX_SAVED), ownerId: userId });
        }
      },
      reset: () => set({ items: [], ownerId: null }),
    }),
    {
      name: 'dayflow.saved-itineraries.v1',
      version: 2,
      storage: createJSONStorage(() => AsyncStorage),
      // v1 entries predate `updatedAt`; backfill from createdAt so merges have a
      // clock to compare and old saves don't all look "epoch 0".
      migrate: (persisted: any) => {
        if (persisted?.items) {
          persisted.items = persisted.items.map((it: SavedItinerary) => ({
            ...it,
            updatedAt: it.updatedAt ?? it.createdAt ?? Date.now(),
          }));
        }
        return persisted;
      },
    },
  ),
);

/**
 * All saved plans dated `date`, oldest first. "Oldest first" puts the
 * earliest-created plan at index 0 — both the default active one (see
 * below) and the natural reading order for a day's plan list.
 */
export function plansForDate(items: SavedItinerary[], date: string): SavedItinerary[] {
  return items
    .filter((i) => i.date === date)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * The active plan for `date`: the explicitly-activated entry if there is
 * one, otherwise the earliest-created plan for that day. Undefined when the
 * day has no saved plans.
 */
export function activePlanForDate(
  items: SavedItinerary[],
  date: string,
): SavedItinerary | undefined {
  const forDay = plansForDate(items, date);
  return forDay.find((i) => i.isActive) ?? forDay[0];
}
