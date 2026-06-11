import { AppState } from 'react-native';
import { create } from 'zustand';
import type { SchedulerContext } from '@/lib/ai/scheduler';
import { planItinerary } from '@/lib/ai/itinerary';
import { recomputeItinerary } from '@/lib/ai/recomputeItinerary';
import { useSavedItineraries } from '@/store/useSavedItineraries';
import { useErrandsStore } from '@/store/useErrandsStore';
import {
  ensureNotificationPermission,
  notifyPlanReady,
} from '@/lib/notifications';
import { uid } from '@/utils/id';

/**
 * Status copy cycled under the homepage skeleton (and the itinerary screen)
 * while a day is being built, so the wait reads as motion instead of a frozen
 * spinner. Advanced by the store on a timer, so every surface that renders a
 * job stays in lock-step.
 */
export const PLANNING_PHASES = [
  'Drafting your day…',
  'Finding the best places…',
  'Mapping your route…',
  'Polishing the details…',
] as const;

/** Lifecycle of a single background plan build. */
export type PlanJobStatus = 'building' | 'done' | 'error';

export interface PlanJob {
  id: string;
  /** The day this plan is for ("YYYY-MM-DD") — used to scope the home card. */
  date: string;
  /** A best-effort label from the user's prompt, shown while building. */
  provisionalTitle: string;
  /** The real itinerary title, once the build resolves. */
  title?: string;
  status: PlanJobStatus;
  /** Index into PLANNING_PHASES — the rotating status line. */
  phase: number;
  /** Saved-store id of the finished itinerary (set when status === 'done'). */
  savedId?: string;
  /** First place photo of the built day, for the toast / card thumbnail. */
  thumbUrl?: string;
  stopCount?: number;
  error?: string;
  createdAt: number;
}

/**
 * The in-app "your plan is ready" toast payload. Populated only when a job
 * finishes while Diem is foregrounded; the backgrounded case posts an OS
 * notification instead (see notifyPlanReady), so the user never gets both.
 */
export interface ReadyToast {
  jobId: string;
  savedId?: string;
  title: string;
  subtitle: string;
  thumbUrl?: string;
  /** 'done' shows the celebratory ready toast; 'error' the failure nudge. */
  tone: 'done' | 'error';
}

/** Everything the runner needs to build a day, handed over from the screen. */
export interface StartPlanInput {
  request: string;
  date: string;
  now?: string;
  context: SchedulerContext;
  startLocation?: { label?: string | null; latitude: number; longitude: number } | null;
  /** Errands the user folded in — marked "planned" once the day is saved. */
  errandIds?: string[];
  provisionalTitle: string;
}

interface PlanJobsState {
  jobs: PlanJob[];
  toast: ReadyToast | null;
  /**
   * Kick off a background plan build. Returns the job id immediately so the
   * caller can navigate away (e.g. back home) and still reference it. The
   * actual planning + routing happens here, decoupled from any screen, so it
   * survives navigation and unmounts.
   */
  startPlan: (input: StartPlanInput) => string;
  /** The active (still-building) job for a given day, if any. */
  activeJobForDate: (date: string) => PlanJob | undefined;
  getJob: (id: string) => PlanJob | undefined;
  dismissToast: () => void;
  clearJob: (id: string) => void;
}

// Phase tickers live outside the store (zustand only holds serialisable
// state). Keyed by job id so a finishing build can stop exactly its own timer.
const phaseTimers = new Map<string, ReturnType<typeof setInterval>>();

const PHASE_INTERVAL_MS = 1600;
// Keep a little history so a tap on a just-finished card can still resolve the
// job, but don't let stale entries pile up across a long session.
const MAX_JOBS = 8;

function stopPhaseTimer(id: string): void {
  const timer = phaseTimers.get(id);
  if (timer) {
    clearInterval(timer);
    phaseTimers.delete(id);
  }
}

export const usePlanJobsStore = create<PlanJobsState>((set, get) => {
  const patchJob = (id: string, patch: Partial<PlanJob>) =>
    set((s) => ({
      jobs: s.jobs.map((j) => (j.id === id ? { ...j, ...patch } : j)),
    }));

  /**
   * Resolve a finished build into the right "tell the user" surface: an in-app
   * toast when Diem is foreground, an OS notification when it isn't — never
   * both. Read AppState synchronously at completion so a user who just
   * backgrounded the app gets the phone notification they'd expect.
   */
  const announce = (job: PlanJob, tone: 'done' | 'error') => {
    const foreground = AppState.currentState === 'active';
    if (tone === 'done') {
      const name = job.title || job.provisionalTitle;
      if (foreground) {
        set({
          toast: {
            jobId: job.id,
            savedId: job.savedId,
            title: name,
            subtitle:
              job.stopCount && job.stopCount > 0
                ? `Your day is ready · ${job.stopCount} stop${
                    job.stopCount === 1 ? '' : 's'
                  }`
                : 'Your day is ready — tap to take a look',
            thumbUrl: job.thumbUrl,
            tone: 'done',
          },
        });
      } else {
        void notifyPlanReady({ title: name, savedId: job.savedId });
      }
      return;
    }
    // Failure path — surface it the same foreground/background way so the user
    // isn't left staring at a skeleton that never resolves.
    if (foreground) {
      set({
        toast: {
          jobId: job.id,
          title: job.provisionalTitle,
          subtitle: "Couldn't build your plan — tap to try again",
          tone: 'error',
        },
      });
    } else {
      void notifyPlanReady({
        title: job.provisionalTitle,
        savedId: undefined,
      });
    }
  };

  return {
    jobs: [],
    toast: null,

    startPlan: (input) => {
      const id = uid('planjob');
      const job: PlanJob = {
        id,
        date: input.date,
        provisionalTitle: input.provisionalTitle.trim() || 'Your day plan',
        status: 'building',
        phase: 0,
        createdAt: Date.now(),
      };
      // Prepend the new job and trim history (keeping it small).
      set((s) => ({ jobs: [job, ...s.jobs].slice(0, MAX_JOBS) }));

      // Ask for notification permission now (not at finish) so a plan that
      // completes while backgrounded can actually post. No-ops if already
      // decided; never blocks the build.
      void ensureNotificationPermission();

      // Rotate the status copy while we work. Once we reach the last phase we
      // stop patching (no-op tick) so a slow build doesn't re-render its
      // watchers every interval for nothing.
      const timer = setInterval(() => {
        const current = get().jobs.find((j) => j.id === id);
        if (!current || current.status !== 'building') {
          stopPhaseTimer(id);
          return;
        }
        if (current.phase >= PLANNING_PHASES.length - 1) return;
        patchJob(id, { phase: current.phase + 1 });
      }, PHASE_INTERVAL_MS);
      phaseTimers.set(id, timer);

      // The build pipeline, decoupled from any screen lifecycle.
      void (async () => {
        try {
          const result = await planItinerary(input.request, {
            context: input.context,
            date: input.date,
            now: input.now,
          });
          const itin = result.itinerary;
          if (!itin) {
            stopPhaseTimer(id);
            patchJob(id, { status: 'error', error: 'No itinerary produced' });
            announce({ ...get().getJob(id)!, status: 'error' }, 'error');
            return;
          }

          // Bake the chosen start so reopening/re-routing the day always
          // anchors its first leg to where it was planned to begin.
          if (input.startLocation) {
            itin.startLocation = {
              label: input.startLocation.label ?? 'Start',
              latitude: input.startLocation.latitude,
              longitude: input.startLocation.longitude,
            };
          }

          // Persist immediately — the day is "done" for the user the moment
          // the model returns; routing refinement happens silently after.
          const savedId = useSavedItineraries.getState().save(itin);
          if (input.errandIds && input.errandIds.length > 0) {
            useErrandsStore.getState().setPlanned(input.errandIds, input.date);
          }
          const saved = useSavedItineraries
            .getState()
            .items.find((i) => i.id === savedId);

          stopPhaseTimer(id);
          patchJob(id, {
            status: 'done',
            savedId,
            title: saved?.title || itin.title,
            thumbUrl: saved?.thumbUrl,
            stopCount: saved?.stopCount,
          });
          announce(get().getJob(id)!, 'done');

          // Background route refinement: real travel legs + re-cascaded clock.
          // Updates the saved entry in place so the homepage card and a later
          // open both pick up the routed version; failures keep the optimistic
          // plan untouched.
          const routeCtx: SchedulerContext = {
            ...input.context,
            currentLocation: itin.startLocation
              ? {
                  latitude: itin.startLocation.latitude,
                  longitude: itin.startLocation.longitude,
                  label: itin.startLocation.label ?? null,
                }
              : null,
          };
          const refreshed = await recomputeItinerary(itin, routeCtx, {
            optimize: true,
          }).catch(() => null);
          if (refreshed?.refreshed) {
            useSavedItineraries.getState().update(savedId, refreshed.itinerary);
            const updated = useSavedItineraries
              .getState()
              .items.find((i) => i.id === savedId);
            if (updated) {
              patchJob(id, {
                thumbUrl: updated.thumbUrl,
                stopCount: updated.stopCount,
                title: updated.title,
              });
            }
          }
        } catch (e: any) {
          stopPhaseTimer(id);
          patchJob(id, {
            status: 'error',
            error: String(e?.message ?? e),
          });
          const failed = get().getJob(id);
          if (failed) announce(failed, 'error');
        }
      })();

      return id;
    },

    activeJobForDate: (date) =>
      get().jobs.find((j) => j.status === 'building' && j.date === date),

    getJob: (id) => get().jobs.find((j) => j.id === id),

    dismissToast: () => set({ toast: null }),

    clearJob: (id) => {
      stopPhaseTimer(id);
      set((s) => ({
        jobs: s.jobs.filter((j) => j.id !== id),
        toast: s.toast?.jobId === id ? null : s.toast,
      }));
    },
  };
});
