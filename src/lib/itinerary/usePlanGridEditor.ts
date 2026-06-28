/**
 * A STAGED editing session for a saved plan being edited inline on the day
 * calendar (the grid's "focus mode").
 *
 * Unlike a live editor, nothing touches the saved plan until the user Confirms:
 * `begin` snapshots the plan into a working copy, every gesture applies an
 * `EditOp` to that copy (optimistic clock cascade + gap fit, then a background
 * route refresh), and only `confirm` persists it to `useSavedItineraries`.
 * `cancel` throws the working copy away — the permanent "revert" while editing.
 *
 * The calendar projects this staged copy (the host swaps it in for the saved
 * plan), so the grid reflects edits instantly while the stored plan — and every
 * other surface showing it — stays untouched until Confirm.
 *
 * A monotonic `editSeq` drops a slow recompute response once a newer edit, a
 * confirm, or a cancel has landed, so the staged day never jumps to a stale route.
 */
import { useCallback, useRef, useState } from 'react';
import * as Haptics from 'expo-haptics';
import type { Itinerary } from '@/types/itinerary';
import type { SchedulerContext } from '@/lib/ai/scheduler';
import { useHomeStore, selectEndOfDay } from '@/store/useHomeStore';
import { useProfileStore } from '@/store/useProfileStore';
import { usePlanSetupStore } from '@/store/usePlanSetupStore';
import { useSavedItineraries } from '@/store/useSavedItineraries';
import { recomputeItinerary } from '@/lib/ai/recomputeItinerary';
import {
  applyOp,
  applyRoutedLegs,
  fitGapsToAnchors,
  opNeedsRoute,
  type EditOp,
} from '@/lib/itinerary/edits';

export interface PlanGridSession {
  /** The plan being edited, or null when no session is active. */
  planId: string | null;
  /** The working copy reflecting all uncommitted edits, or null. */
  staged: Itinerary | null;
  /** True while a backend recompute is in flight. */
  busy: boolean;
  /** True once the staged copy diverges from the snapshot (enables Confirm). */
  dirty: boolean;
  /** Start a session: snapshot `itinerary` (already errand-link-stamped) as the copy. */
  begin: (planId: string, itinerary: Itinerary) => void;
  /** Apply ops to the staged copy (optimistic), then refresh routes in the background. */
  edit: (ops: EditOp[]) => void;
  /** Persist the staged copy to the saved plan and end the session. */
  confirm: () => void;
  /** Discard the staged copy and end the session (the permanent revert). */
  cancel: () => void;
}

/**
 * Hook exposing {@link PlanGridSession}. Reads the small slice of routing context
 * the recompute consumes (home, end-of-day, bedtime, car) from the profile/home/
 * plan stores; the plan's own baked `startLocation` supplies the day's origin.
 */
export function usePlanGridEditor(): PlanGridSession {
  const home = useHomeStore((s) => s.home);
  const endOfDay = useHomeStore((s) => selectEndOfDay(s));
  const bedTime = useProfileStore((s) => s.bedTime);
  const hasCar = useProfileStore((s) => s.hasCar);
  const useCarToday = usePlanSetupStore((s) => s.useCarToday);

  const [planId, setPlanId] = useState<string | null>(null);
  const [staged, setStaged] = useState<Itinerary | null>(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);

  // Refs mirror the latest state so the (stable) callbacks read fresh values and
  // rapid successive edits chain off the newest staged copy, not a stale render.
  const planIdRef = useRef<string | null>(null);
  planIdRef.current = planId;
  const stagedRef = useRef<Itinerary | null>(null);
  stagedRef.current = staged;
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  // Monotonic token: a recompute only "wins" while it's still the latest action.
  const editSeqRef = useRef(0);

  const buildContext = useCallback(
    (itin: Itinerary): SchedulerContext => ({
      home,
      endOfDay,
      bedTime,
      hasCar,
      useCarToday: useCarToday ?? hasCar ?? null,
      currentLocation: itin.startLocation
        ? {
            latitude: itin.startLocation.latitude,
            longitude: itin.startLocation.longitude,
            label: itin.startLocation.label ?? null,
          }
        : null,
    }),
    [home, endOfDay, bedTime, hasCar, useCarToday],
  );

  const begin = useCallback((id: string, itinerary: Itinerary) => {
    editSeqRef.current += 1; // drop any recompute from a previous session
    setPlanId(id);
    setStaged(itinerary);
    setDirty(false);
    setBusy(false);
  }, []);

  const edit = useCallback(
    async (ops: EditOp[]) => {
      const base = stagedRef.current;
      const id = planIdRef.current;
      if (!base || !id || ops.length === 0) return;
      const mySeq = ++editSeqRef.current;

      // 1) Optimistic: cascade each op on the WORKING copy, then fit gaps so no
      // fixed anchor is overrun. Nothing is persisted.
      let current = base;
      let needsRoute = false;
      for (const op of ops) {
        current = applyOp(current, op).itinerary;
        if (opNeedsRoute(op)) needsRoute = true;
      }
      current = fitGapsToAnchors(current).itinerary;
      stagedRef.current = current;
      setStaged(current);
      setDirty(true);
      Haptics.selectionAsync().catch(() => undefined);

      if (!needsRoute) return;

      // 2) Background re-route on the staged copy: keep the server's fresh legs,
      // restore client timing authority, re-fit. Still not persisted.
      setBusy(true);
      try {
        const { itinerary: refreshed } = await recomputeItinerary(current, buildContext(current));
        if (mySeq !== editSeqRef.current || planIdRef.current !== id) return;
        const merged = applyRoutedLegs(current, refreshed);
        const cascaded = fitGapsToAnchors(merged).itinerary;
        stagedRef.current = cascaded;
        setStaged(cascaded);
      } finally {
        if (mySeq === editSeqRef.current) setBusy(false);
      }
    },
    [buildContext],
  );

  const endSession = useCallback(() => {
    editSeqRef.current += 1; // any in-flight recompute is now stale
    setPlanId(null);
    setStaged(null);
    setDirty(false);
    setBusy(false);
  }, []);

  const confirm = useCallback(() => {
    const id = planIdRef.current;
    const itin = stagedRef.current;
    if (id && itin && dirtyRef.current) {
      useSavedItineraries.getState().update(id, itin);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(
        () => undefined,
      );
    }
    endSession();
  }, [endSession]);

  const cancel = useCallback(() => {
    Haptics.selectionAsync().catch(() => undefined);
    endSession();
  }, [endSession]);

  return { planId, staged, busy, dirty, begin, edit, confirm, cancel };
}
