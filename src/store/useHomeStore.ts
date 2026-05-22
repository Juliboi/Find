import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

export interface LocationPin {
  /** Human-readable label, e.g. "Home", "Pařížská 30, Praha". */
  label: string;
  latitude: number;
  longitude: number;
}

interface HomeState {
  /** Where the user lives — primary anchor for planning. */
  home: LocationPin | null;
  /**
   * Where the user works — secondary anchor. Plans that mention
   * "office", "work", or that the LLM classifies as work-context
   * (poker with colleagues, meeting at office) resolve their coords
   * from this pin. Optional — the app works fine without it; we just
   * can't show travel times for office plans.
   */
  work: LocationPin | null;
  /**
   * Where the user wants to finish their day. Defaults to home. Can be
   * overridden per-day (we still persist this so the next day starts with
   * the user's last preference).
   */
  endOfDay: LocationPin | null;

  setHome: (pin: LocationPin) => void;
  setWork: (pin: LocationPin | null) => void;
  setEndOfDay: (pin: LocationPin | null) => void;
  clearHome: () => void;
  clearWork: () => void;
}

/**
 * Tiny persisted store for the user's anchor locations. Separated from
 * `useDayStore` so that home survives across day resets.
 */
export const useHomeStore = create<HomeState>()(
  persist(
    (set, get) => ({
      home: null,
      work: null,
      endOfDay: null,
      setHome: (home) =>
        set({ home, endOfDay: get().endOfDay ?? home }),
      setWork: (work) => set({ work }),
      setEndOfDay: (endOfDay) => set({ endOfDay }),
      clearHome: () => set({ home: null, endOfDay: null }),
      clearWork: () => set({ work: null }),
    }),
    {
      // Keep the same storage key — bumping it would drop existing
      // users' home pin. Instead we use zustand's `version` migrate
      // hook to graft on the new `work` slot for old entries.
      name: 'dayflow.home-store.v1',
      version: 2,
      migrate: (persistedState, fromVersion) => {
        const s = (persistedState as Partial<HomeState>) ?? {};
        if (fromVersion < 2 && !('work' in s)) {
          return { ...s, work: null } as HomeState;
        }
        return s as HomeState;
      },
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
);

/**
 * Returns the resolved end-of-day location. Falls back to `home` when no
 * explicit end has been set for the current day.
 */
export function selectEndOfDay(s: {
  home: LocationPin | null;
  endOfDay: LocationPin | null;
}): LocationPin | null {
  return s.endOfDay ?? s.home;
}

/**
 * Light snapshot of all anchor pins. Pulled together so the rest of
 * the app can ask "what coordinates does this label resolve to?"
 * with a single store read.
 */
export interface AnchorSnapshot {
  home: LocationPin | null;
  work: LocationPin | null;
  endOfDay: LocationPin | null;
}

export function selectAnchors(s: HomeState): AnchorSnapshot {
  return {
    home: s.home,
    work: s.work,
    endOfDay: s.endOfDay ?? s.home,
  };
}

/**
 * Common label aliases for the home and work anchors. The LLM emits
 * any of these strings (sometimes pulled from the user's own phrasing
 * — "the office", "my place") and we want them to all map to the
 * same coords. Compared case-insensitively.
 */
const HOME_ALIASES = [
  'home',
  'my home',
  'house',
  'at home',
  'my place',
  'apartment',
  'flat',
];

const WORK_ALIASES = [
  'office',
  'work',
  'the office',
  'my office',
  'workplace',
  'at office',
  'at work',
];

/**
 * Given a free-text location label (set either by the LLM or the
 * user), return the matching anchor pin if any. The match is intent-
 * based, not exact — "the office", "at office", or the literal
 * `work.label` all resolve to the work pin.
 *
 * Returns null when the label is missing or doesn't look like a
 * known anchor. Callers fall back to `plan.locationCoords` (the
 * lat/lng captured at place-pick time) before resorting to this
 * helper.
 */
export function resolveAnchor(
  label: string | null | undefined,
  anchors: AnchorSnapshot,
): LocationPin | null {
  if (!label) return null;
  const norm = label.trim().toLowerCase();
  if (!norm) return null;
  if (anchors.home) {
    if (norm === anchors.home.label.toLowerCase()) return anchors.home;
    if (HOME_ALIASES.includes(norm)) return anchors.home;
  }
  if (anchors.work) {
    if (norm === anchors.work.label.toLowerCase()) return anchors.work;
    if (WORK_ALIASES.includes(norm)) return anchors.work;
  }
  return null;
}

/**
 * Convenience: given a plan-like object with optional `location`
 * label and optional `locationCoords`, return the best coordinates
 * we can give it. Used to compute travel rows even when the user
 * hasn't picked a venue (HOME-STATIONARY plans, plans labelled
 * "Office", etc.).
 */
export function effectiveCoords(
  plan: {
    location?: string | null;
    locationCoords?: { latitude: number; longitude: number };
  },
  anchors: AnchorSnapshot,
): { latitude: number; longitude: number } | null {
  if (plan.locationCoords) return plan.locationCoords;
  const anchor = resolveAnchor(plan.location, anchors);
  if (anchor) {
    return { latitude: anchor.latitude, longitude: anchor.longitude };
  }
  return null;
}
