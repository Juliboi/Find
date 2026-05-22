import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { Plan } from '@/types/plan';
import {
  rescheduleDay,
  scheduleDay,
  type SchedulerContext,
} from '@/lib/ai/scheduler';
import { todayISO } from '@/utils/time';
import { uid } from '@/utils/id';
import { selectEndOfDay, useHomeStore } from '@/store/useHomeStore';
import { findPlaces, getCurrentCoords, type NearbyPlace } from '@/lib/places';
import { composeDayRemote } from '@/lib/ai/compose';

function currentSchedulerContext(): SchedulerContext {
  const s = useHomeStore.getState();
  return {
    home: s.home,
    work: s.work,
    endOfDay: selectEndOfDay(s),
  };
}

/**
 * Per-plan place-candidate fetch status. Lives next to the candidate
 * map so the UI can render the right state (skeleton vs error vs
 * picker) without inferring from cache emptiness.
 */
export type PlaceFetchStatus =
  | 'loading'
  | 'ready'
  | 'no_results'
  | 'error';

/**
 * Promises for in-flight place searches, keyed by planId. Lives
 * outside the store because zustand only holds serialisable state —
 * Promises aren't. Used by `ensurePlaceCandidates` to dedupe: two
 * callers asking for the same plan share one fetch.
 */
const inFlightPlaceFetches = new Map<string, Promise<NearbyPlace[]>>();

interface DayState {
  date: string;
  /** Raw plan strings that the user is currently drafting before AI runs. */
  draft: string[];
  /** Scheduled plans (after AI has structured + ordered them). */
  plans: Plan[];
  summary: string;
  isScheduling: boolean;
  needsClarification: boolean;
  usedAi: boolean;

  /**
   * Cached place candidates per plan, keyed by planId. Populated by
   * `ensurePlaceCandidates` (called both by the compose pass and by
   * PlanCard for the manual picker). We keep these in the store
   * rather than per-card so the compose pass can read them and pick
   * the chain without re-fetching.
   */
  placeCandidates: Record<string, NearbyPlace[]>;
  /** Fetch status per plan. */
  placeStatus: Record<string, PlaceFetchStatus | undefined>;
  /** Optional error detail per plan, surfaced in the UI. */
  placeError: Record<string, string | undefined>;
  /** True while the AI compose pass is running across all plans. */
  isComposing: boolean;
  /** Natural-language rationale the compose pass produced. */
  composeSummary?: string;

  addDraft: (text: string) => void;
  updateDraft: (index: number, text: string) => void;
  removeDraft: (index: number) => void;
  clearDraft: () => void;

  confirmDraft: (startTime?: string) => Promise<void>;
  reorderAndReschedule: () => Promise<void>;
  resolveClarification: (
    planId: string,
    answer: string,
    opts?: {
      startTime?: string;
      location?: string;
      locationCoords?: { latitude: number; longitude: number };
    },
  ) => Promise<void>;
  removePlan: (planId: string) => Promise<void>;
  resetDay: () => void;

  /**
   * Lightweight in-place location update — no LLM call, no reschedule.
   * Used by the "Where?" chips on scheduled plans that lack a
   * resolvable location: a single setState that lets travel rows
   * appear instantly. We deliberately don't run reorderAndReschedule
   * here; the user is just labelling an existing plan.
   */
  updatePlanLocation: (
    planId: string,
    label: string,
    coords?: { latitude: number; longitude: number },
  ) => void;

  /**
   * Fetch (and cache) place candidates for a single plan. Safe to call
   * concurrently: in-flight requests are deduped by planId so the
   * compose pass and the PlanCard picker never double-fetch.
   */
  ensurePlaceCandidates: (planId: string) => Promise<NearbyPlace[]>;
  /**
   * Cross-plan AI optimization: collects candidates for every
   * venue-required plan, asks the server to assemble the best chain
   * (proximity + open hours + day-end at home), then auto-resolves
   * each plan with its winning venue. Idempotent — calling it again
   * is a no-op when no plans need composing.
   */
  composeDay: () => Promise<void>;
  /** Clears the compose rationale so the banner hides. */
  dismissComposeSummary: () => void;
}

export const useDayStore = create<DayState>()(
  persist(
    (set, get) => ({
      date: todayISO(),
      draft: [],
      plans: [],
      summary: '',
      isScheduling: false,
      needsClarification: false,
      usedAi: false,
      placeCandidates: {},
      placeStatus: {},
      placeError: {},
      isComposing: false,
      composeSummary: undefined,

      addDraft: (text) => {
        const t = text.trim();
        if (!t) return;
        set({ draft: [...get().draft, t] });
      },
      updateDraft: (index, text) => {
        const next = [...get().draft];
        next[index] = text;
        set({ draft: next });
      },
      removeDraft: (index) => {
        const next = get().draft.filter((_, i) => i !== index);
        set({ draft: next });
      },
      clearDraft: () => set({ draft: [] }),

      confirmDraft: async (startTime) => {
        const drafts = get().draft;
        if (drafts.length === 0) return;
        set({ isScheduling: true });
        try {
          const result = await scheduleDay(drafts, {
            startTime,
            context: currentSchedulerContext(),
          });
          // Wipe stale candidate caches — old planIds may collide with
          // new ones, and even when they don't, stale candidates from
          // yesterday's intent are misleading.
          set({
            plans: result.plans,
            summary: result.summary,
            needsClarification: result.needsClarification,
            usedAi: result.usedAi,
            draft: [],
            date: todayISO(),
            placeCandidates: {},
            placeStatus: {},
            placeError: {},
            composeSummary: undefined,
          });
        } finally {
          set({ isScheduling: false });
        }
        // Kick off the compose pass once scheduling resolves. We
        // don't await it — the caller (the /add screen) returns to
        // the home screen immediately, and the home screen shows the
        // compose progress so the user doesn't sit on a spinner.
        void get().composeDay().catch((e) => {
          console.warn('[useDayStore] composeDay failed', e);
        });
      },

      reorderAndReschedule: async () => {
        set({ isScheduling: true });
        try {
          const existing = get().plans;
          const result = await rescheduleDay(existing, {
            context: currentSchedulerContext(),
          });
          // schedule-day doesn't know about client-only fields
          // (locationCoords, composeReasoning) — it only sees the
          // wire-shape PlanInput. Merge those back by id so a
          // reschedule doesn't wipe the user's resolved venues or
          // the compose pass's rationale.
          const existingById = new Map(existing.map((p) => [p.id, p]));
          const merged = result.plans.map((p) => {
            const e = existingById.get(p.id);
            if (!e) return p;
            return {
              ...p,
              locationCoords: p.locationCoords ?? e.locationCoords,
              composeReasoning: p.composeReasoning ?? e.composeReasoning,
            };
          });
          set({
            plans: merged,
            summary: result.summary,
            needsClarification: result.needsClarification,
            usedAi: result.usedAi,
          });
        } finally {
          set({ isScheduling: false });
        }
      },

      resolveClarification: async (planId, answer, opts) => {
        const plans = get().plans.map((p) => {
          if (p.id !== planId) return p;
          const question = p.clarificationQuestion;
          const isLocationAnswer = /where|which|location|nearby|spot|place|gym|store|cafe|restaurant|shop/i.test(
            question ?? '',
          );
          const nextLocation =
            opts?.location ?? (isLocationAnswer ? answer : p.location);
          const nextDescription =
            opts?.location || isLocationAnswer
              ? p.description
              : answer || p.description;
          // When the user picks a real place we get lat/lng. When
          // they type a free-text location or skip, we clear any
          // stale coords so we don't show a wrong travel time later.
          const nextCoords = opts?.locationCoords
            ?? (opts?.location ? undefined : p.locationCoords);
          return {
            ...p,
            location: nextLocation,
            locationCoords: nextCoords,
            description: nextDescription,
            startTime: opts?.startTime ?? p.startTime,
            status: 'scheduled' as const,
            clarificationQuestion: undefined,
            clarificationSuggestions: undefined,
            resolvedClarification: question
              ? { question, answer }
              : p.resolvedClarification,
          };
        });
        set({ plans });
        await get().reorderAndReschedule();
      },

      removePlan: async (planId) => {
        const { [planId]: _c, ...restCandidates } = get().placeCandidates;
        const { [planId]: _s, ...restStatus } = get().placeStatus;
        const { [planId]: _e, ...restError } = get().placeError;
        set({
          plans: get().plans.filter((p) => p.id !== planId),
          placeCandidates: restCandidates,
          placeStatus: restStatus,
          placeError: restError,
        });
        await get().reorderAndReschedule();
      },

      resetDay: () => {
        inFlightPlaceFetches.clear();
        set({
          date: todayISO(),
          draft: [],
          plans: [],
          summary: '',
          needsClarification: false,
          usedAi: false,
          placeCandidates: {},
          placeStatus: {},
          placeError: {},
          isComposing: false,
          composeSummary: undefined,
        });
      },

      updatePlanLocation: (planId, label, coords) => {
        set((s) => ({
          plans: s.plans.map((p) =>
            p.id === planId
              ? {
                  ...p,
                  location: label,
                  // If the caller didn't supply coords (e.g. user
                  // typed a free-text label), don't carry over a
                  // stale coord from a previous pick.
                  locationCoords: coords ?? undefined,
                  // Clear compose reasoning — it referenced the
                  // previous pick, which no longer applies.
                  composeReasoning: undefined,
                }
              : p,
          ),
        }));
      },

      ensurePlaceCandidates: async (planId) => {
        const existingPromise = inFlightPlaceFetches.get(planId);
        if (existingPromise) return existingPromise;
        const cached = get().placeCandidates[planId];
        if (cached && cached.length > 0) return cached;
        const plan = get().plans.find((p) => p.id === planId);
        if (!plan) return [];
        // Mirror PlanCard's fallback chain: prefer the LLM-rewritten
        // multi-query array, then the legacy single field, then the
        // user's raw text. Keeps the search aligned with whatever the
        // current scheduler version emitted.
        const queries =
          plan.placeSearchQueries && plan.placeSearchQueries.length > 0
            ? plan.placeSearchQueries
            : plan.placeSearchQuery
            ? [plan.placeSearchQuery]
            : [plan.title || plan.rawText];
        const intent = plan.title || plan.rawText;
        set((s) => ({
          placeStatus: { ...s.placeStatus, [planId]: 'loading' },
          placeError: { ...s.placeError, [planId]: undefined },
        }));
        const promise = findPlaces(queries, intent).then((result) => {
          if (result.places.length > 0) {
            set((s) => ({
              placeCandidates: {
                ...s.placeCandidates,
                [planId]: result.places,
              },
              placeStatus: { ...s.placeStatus, [planId]: 'ready' },
            }));
            return result.places;
          }
          set((s) => ({
            placeStatus: {
              ...s.placeStatus,
              [planId]: result.reason === 'no_results' ? 'no_results' : 'error',
            },
            placeError: { ...s.placeError, [planId]: result.detail },
          }));
          return [] as NearbyPlace[];
        });
        inFlightPlaceFetches.set(planId, promise);
        try {
          return await promise;
        } finally {
          inFlightPlaceFetches.delete(planId);
        }
      },

      dismissComposeSummary: () => set({ composeSummary: undefined }),

      composeDay: async () => {
        // Guard against overlapping compose calls. confirmDraft fires
        // this in the background, so a user who taps "Plan my day"
        // twice in quick succession could otherwise start two
        // parallel compose runs that race when they apply picks.
        if (get().isComposing) return;
        // Find every plan that still needs a venue. We deliberately
        // *don't* include already-located plans — those are user
        // commitments and we don't want compose to swap them out.
        const venuePlans = get().plans.filter((p) => {
          if (p.status !== 'needs_clarification') return false;
          if (p.location) return false;
          const hasQueries =
            (p.placeSearchQueries && p.placeSearchQueries.length > 0) ||
            !!p.placeSearchQuery;
          return hasQueries;
        });
        if (venuePlans.length === 0) return;
        set({ isComposing: true });
        try {
          // Parallel place search across all plans. ensurePlaceCandidates
          // dedupes with any picker-driven fetches already in flight,
          // so this is safe to call even mid-render.
          const allCandidates = await Promise.all(
            venuePlans.map((p) => get().ensurePlaceCandidates(p.id)),
          );
          // No plans had any candidates — nothing to compose. Leave
          // plans as needs_clarification so the manual picker can
          // still run.
          if (allCandidates.every((c) => c.length === 0)) return;
          const composeInput = venuePlans.map((p, i) => ({
            id: p.id,
            title: p.title,
            rawText: p.rawText,
            startTime: p.startTime,
            durationMinutes: p.durationMinutes,
            candidates: allCandidates[i],
          }));
          // Try to enrich context with the user's actual GPS. If
          // they haven't granted permission, the server falls back
          // to home — which is the right behavior for an at-home
          // start anyway.
          const currentLoc = await getCurrentCoords().catch(() => null);
          const ctx = currentSchedulerContext();
          const composed = await composeDayRemote({
            plans: composeInput,
            context: {
              home: ctx.home,
              work: ctx.work,
              endOfDay: ctx.endOfDay,
              currentLocation: currentLoc ?? undefined,
            },
          });
          if (!composed || composed.picks.length === 0) return;
          // Apply all picks in one batch, then reschedule once at the
          // end — avoids N round-trips through schedule-day.
          const picksByPlanId = new Map(
            composed.picks.map((p) => [p.planId, p]),
          );
          const updatedPlans = get().plans.map((p) => {
            const pick = picksByPlanId.get(p.id);
            if (!pick) return p;
            const candidate = (get().placeCandidates[p.id] ?? []).find(
              (c) => c.id === pick.placeId,
            );
            if (!candidate) return p;
            const question = p.clarificationQuestion;
            return {
              ...p,
              location: candidate.name,
              locationCoords: {
                latitude: candidate.latitude,
                longitude: candidate.longitude,
              },
              composeReasoning: pick.reasoning || undefined,
              status: 'scheduled' as const,
              clarificationQuestion: undefined,
              clarificationSuggestions: undefined,
              resolvedClarification: question
                ? { question, answer: candidate.name }
                : p.resolvedClarification,
            };
          });
          set({
            plans: updatedPlans,
            composeSummary: composed.summary || undefined,
          });
          await get().reorderAndReschedule();
        } finally {
          set({ isComposing: false });
        }
      },
    }),
    {
      name: 'dayflow.day-store.v1',
      storage: createJSONStorage(() => AsyncStorage),
      // We intentionally DON'T persist placeCandidates / placeStatus /
      // placeError / isComposing — candidate freshness matters (5 min
      // server cache) and the loading flags would otherwise rehydrate
      // as "loading" forever. composeSummary IS persisted so the user
      // sees the rationale when they reopen the app.
      partialize: (state) => ({
        date: state.date,
        draft: state.draft,
        plans: state.plans,
        summary: state.summary,
        needsClarification: state.needsClarification,
        usedAi: state.usedAi,
        composeSummary: state.composeSummary,
      }),
    },
  ),
);

export function emptyPlan(): Plan {
  return {
    id: uid('plan'),
    title: '',
    rawText: '',
    subtasks: [],
    durationMinutes: 30,
    orderIndex: 0,
    status: 'draft',
  };
}
