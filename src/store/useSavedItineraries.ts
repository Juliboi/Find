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
   * route recompute so the homepage card swaps to the routed version without
   * spawning a duplicate save (and without bumping createdAt — this is the
   * same trip, just refreshed).
   */
  update: (id: string, itinerary: Itinerary) => void;
  remove: (id: string) => void;
}

const MAX_SAVED = 20;

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
