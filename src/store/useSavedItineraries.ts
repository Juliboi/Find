import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { Itinerary } from '@/types/itinerary';

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
  date?: string;
  origin?: string;
  city?: string;
  /** Number of located stops, for the card subtitle. */
  stopCount: number;
  /** First place photo, used as the card thumbnail. */
  thumbUrl?: string;
  itinerary: Itinerary;
}

interface SavedState {
  items: SavedItinerary[];
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

export const useSavedItineraries = create<SavedState>()(
  persist(
    (set) => ({
      items: [],
      save: (itinerary) => {
        const id = newId();
        const entry: SavedItinerary = {
          id,
          createdAt: Date.now(),
          itinerary,
          ...summarize(itinerary),
        };
        set((state) => ({ items: [entry, ...state.items].slice(0, MAX_SAVED) }));
        return id;
      },
      update: (id, itinerary) =>
        set((state) => ({
          items: state.items.map((entry) =>
            entry.id === id
              ? {
                  ...entry,
                  itinerary,
                  ...summarize(itinerary),
                }
              : entry,
          ),
        })),
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
          const entry: SavedItinerary = {
            id: createdId,
            createdAt: Date.now(),
            itinerary: cloned,
            ...summarize(cloned),
          };
          return { items: [entry, ...state.items].slice(0, MAX_SAVED) };
        });
        return createdId;
      },
      remove: (id) =>
        set((state) => ({ items: state.items.filter((i) => i.id !== id) })),
    }),
    {
      name: 'dayflow.saved-itineraries.v1',
      version: 1,
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
);
