import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  LayoutChangeEvent,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import Animated, {
  measure,
  runOnJS,
  scrollTo,
  useAnimatedRef,
  useAnimatedStyle,
  useFrameCallback,
  useScrollViewOffset,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useTheme } from '@/theme/useTheme';
import { Text } from './Text';
import { ErrandDrawer } from './ErrandDrawer';
import { useErrandsStore, type Errand, type ErrandInput } from '@/store/useErrandsStore';
import type { ErrandDraft } from '@/lib/ai/parseErrand';
import { skipRecurringOccurrence } from '@/lib/recurring';
import { uid } from '@/utils/id';
import { dayWindow, hourLabel } from '@/lib/calendar/dayCalendar';
import {
  baseStartMin,
  buildDayDraft,
  commuteSegments,
  minutesToHHMM,
  workMinutes,
  SNAP_MIN,
  type CommuteSegment,
  type DraftEvent,
  type PendingPlacements,
} from '@/lib/calendar/dragSchedule';
import { formatDuration, formatTime } from '@/utils/time';
import { moveOrReorderFromDrag, type EditOp } from '@/lib/itinerary/edits';
import type { Itinerary } from '@/types/itinerary';

interface Props {
  date: string;
  errands: Errand[];
  /**
   * `view` renders the read-only day (tap a block to open it); a long-press lifts
   * a block and asks the host to flip to `edit` so the same gesture keeps
   * dragging. `edit` shows the full drag-to-schedule chrome.
   */
  mode?: 'view' | 'edit';
  /** Current time (minutes from midnight) for the "now" line, or null when not today. */
  nowMin?: number | null;
  /** A long-press in `view` asks the host to enter edit mode (the drag continues). */
  onRequestEdit?: () => void;
  /** Tap a block in `view` to open it (the host's edit drawer). */
  onPressEvent?: (errand: Errand) => void;
  /** The active plan's title, for the plan-group label / accessibility. */
  planTitle?: string;
  /** Open the plan in the planner (the explicit "edit this plan" affordance). */
  onOpenPlan?: () => void;

  // ----- Plan focus mode (inline plan editing on the grid) -----
  /**
   * The id of the plan currently in FOCUS, or null. While set, that plan's
   * blocks become live-editable on the grid (drag to retime/reorder, stretch,
   * tap to delete) and everything else dims + locks. Entering focus is a tap on
   * a plan block; the heavier planner stays one tap away on the Day-plan card.
   */
  focusPlanId?: string | null;
  /** The focused plan's itinerary — needed to turn a drag into a move-vs-reorder op. */
  focusPlanItinerary?: Itinerary | null;
  /** Tapping a plan block asks the host to focus that plan (enter/switch focus). */
  onFocusPlan?: (planId: string) => void;
  /** A staged plan edit from the grid — the host applies it to a working copy. */
  onPlanEdit?: (ops: EditOp[]) => void;
  /** Commit the staged plan edits (persist) and leave focus. */
  onConfirmPlan?: () => void;
  /** Discard the staged plan edits (the permanent revert) and leave focus. */
  onCancelPlan?: () => void;
  /** Open the host's "add a stop" composer for the focused plan. */
  onAddPlanStop?: () => void;
  /** True while the focused plan is re-routing in the background. */
  planBusy?: boolean;
  /** True once the staged plan diverges from its saved version (enables Confirm). */
  planDirty?: boolean;

  /** Leave edit mode. The editor has already persisted on Confirm / discarded on Cancel. */
  onClose: () => void;
}

/** A blank create-drawer seed pinned to the day being edited. */
const ADD_SEED: Omit<ErrandDraft, 'date'> = {
  title: '',
  startTime: null,
  endTime: null,
  address: null,
  notes: null,
};

/** Map a (possibly virtual) errand back to the store's create/patch input shape. */
function errandToInput(e: Errand): ErrandInput {
  return {
    title: e.title,
    startTime: e.startTime,
    endTime: e.endTime,
    durationMin: e.durationMin,
    date: e.date,
    address: e.address,
    latitude: e.latitude,
    longitude: e.longitude,
    placeId: e.placeId,
    photoUrl: e.photoUrl,
    rating: e.rating,
    ratingCount: e.ratingCount,
    priceLevel: e.priceLevel,
    openingHours: e.openingHours,
    travelMode: e.travelMode,
    notes: e.notes,
    source: e.source,
    rawText: e.rawText,
  };
}

const HOUR_HEIGHT = 80;
const PXPM = HOUR_HEIGHT / 60;
const GUTTER_W = 56;
const BLOCK_GAP = 4;
const MIN_BLOCK_H = 44;
/** Floor for a STATIC block's drawn height — small enough that a 15-min stop
 *  reads as short (and doesn't overlap the next), big enough to stay tappable.
 *  The larger {@link MIN_BLOCK_H} is only the floor while a block is dragged. */
const MIN_DRAW_H = 20;
/** Below this drawn height a block can't fit a second line cleanly — show title
 *  only (its short height already conveys a brief stop; tap opens the details). */
const META_MIN_H = 36;
const BOTTOM_PAD = 140;
/** Distance from a viewport edge where a held drag starts auto-scrolling. */
const EDGE = 84;
const MAX_AUTO = 13;
/** Local mirror of the snap step so the worklets close over a plain constant. */
const SNAP_STEP = SNAP_MIN;
/** Shortest a block can be stretched/shrunk to (one snap step). */
const MIN_WORK = SNAP_MIN;
/** Height of the bottom grab strip that turns a block drag into a resize. */
const RESIZE_ZONE = 22;
/** Soft purple fill for read-only plan blocks (theme-agnostic; reads on both). */
const PLAN_TINT = 'rgba(175, 82, 222, 0.16)';

/** 0 = nothing held, 1 = a block being moved, 2 = a tray chip flying in, 3 = a block being stretched. */
const KIND_NONE = 0;
const KIND_BLOCK = 1;
const KIND_CHIP = 2;
const KIND_RESIZE = 3;

/** Auto-scroll direction (-1…1) for a finger at `screenY` within the viewport (worklet). */
function autoDirFor(screenY: number, viewportH: number) {
  'worklet';
  if (screenY < EDGE) return -Math.min(Math.max((EDGE - screenY) / EDGE, 0), 1);
  if (screenY > viewportH - EDGE) {
    return Math.min(Math.max((screenY - (viewportH - EDGE)) / EDGE, 0), 1);
  }
  return 0;
}

/** Snap + clamp a raw target minute to the grid and the visible window (worklet). */
function snapClampMin(raw: number, work: number, winStart: number, winEnd: number) {
  'worklet';
  const snapped = Math.round(raw / SNAP_STEP) * SNAP_STEP;
  const hi = Math.max(winStart, winEnd - work);
  return Math.min(Math.max(snapped, winStart), hi);
}

/** The bundle of shared values the gesture worklets + children all read/write. */
interface DragSV {
  scrollY: SharedValue<number>;
  viewportH: SharedValue<number>;
  originY: SharedValue<number>;
  contentH: SharedValue<number>;
  winStart: SharedValue<number>;
  winEnd: SharedValue<number>;
  dragId: SharedValue<string | null>;
  dragKind: SharedValue<number>;
  dragWork: SharedValue<number>;
  previewMin: SharedValue<number>;
  /** Live stretched length (minutes) while a block is being resized. */
  previewDur: SharedValue<number>;
  lastTransY: SharedValue<number>;
  blockStartTop: SharedValue<number>;
  blockStartScroll: SharedValue<number>;
  fingerY: SharedValue<number>;
  ghostX: SharedValue<number>;
  ghostY: SharedValue<number>;
  /** Window offset of the editor root, so the screen-space ghost lands under the finger. */
  rootX: SharedValue<number>;
  rootY: SharedValue<number>;
  autoDir: SharedValue<number>;
  /** True while the canvas is read-only — a block long-press then requests edit mode. */
  isView: SharedValue<boolean>;
  /** True while a plan is in focus — focused plan blocks drag/resize even from `view`. */
  isFocus: SharedValue<boolean>;
}

/** Live JS mirror of the in-flight drag, for the bits worklets can't draw (text, commute). */
interface DragState {
  errandId: string;
  kind: 'block' | 'chip' | 'resize';
  title: string;
  previewMin: number;
  workMin: number;
}

/** The JS bridges the gesture worklets call back into (lift/move/stretch/place/select). */
interface EditorCallbacks {
  lift: (id: string, kind: 'block' | 'chip' | 'resize', startMin: number, work: number) => void;
  preview: (min: number) => void;
  previewResize: (dur: number) => void;
  place: (id: string, min: number) => void;
  commitResize: (id: string, dur: number) => void;
  cancelDrag: () => void;
  select: (id: string) => void;
  /** A `view`-mode long-press asks the host to enter edit mode (drag continues). */
  requestEdit: () => void;
  /** A `view`-mode tap opens the block in the host's drawer. */
  openEvent: (id: string) => void;
  /** A tap on a plan block enters/switches focus for that plan. */
  focusPlan: (planId: string) => void;
}

/**
 * The day-calendar's EDIT mode: a drag-to-schedule canvas. Existing timed blocks
 * can be lifted (long-press) and slid to a new time; unscheduled errands sit in a
 * bottom tray and can be dragged up onto the timeline to give them one. While
 * anything is held, the commute between consecutive located stops is drawn live —
 * so dropping an errand between two plans shows the travel it implies — and a
 * "between" errand's availability window is highlighted as the region it's meant
 * to land in (you may still drop outside it). Nothing persists until Confirm.
 */
export function DayEditor({
  date,
  errands,
  mode = 'edit',
  nowMin = null,
  onRequestEdit,
  onPressEvent,
  planTitle,
  onOpenPlan,
  focusPlanId = null,
  focusPlanItinerary = null,
  onFocusPlan,
  onPlanEdit,
  onConfirmPlan,
  onCancelPlan,
  onAddPlanStop,
  planBusy = false,
  planDirty = false,
  onClose,
}: Props) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const isEdit = mode === 'edit';
  // Focus mode: a specific plan's blocks are live-editable on the grid. It is
  // orthogonal to errand edit mode (it can be entered straight from `view`).
  const focusActive = focusPlanId != null;
  const addErrand = useErrandsStore((s) => s.add);
  const updateErrand = useErrandsStore((s) => s.update);
  const removeErrand = useErrandsStore((s) => s.remove);

  // Stable mirrors so the gesture callbacks (kept dep-free to avoid stale
  // worklet closures) can read the latest focus props at drop time.
  const focusPlanIdRef = useRef(focusPlanId);
  focusPlanIdRef.current = focusPlanId;
  const focusPlanItinRef = useRef(focusPlanItinerary);
  focusPlanItinRef.current = focusPlanItinerary;
  const onPlanEditRef = useRef(onPlanEdit);
  onPlanEditRef.current = onPlanEdit;
  const onFocusPlanRef = useRef(onFocusPlan);
  onFocusPlanRef.current = onFocusPlan;

  const [pending, setPending] = useState<PendingPlacements>({});
  const [drag, setDrag] = useState<DragState | null>(null);
  const [laneW, setLaneW] = useState(0);
  // Brand-new errands created in this session — held as virtual errands so the
  // canvas can show + place them, and only written to the store on Confirm.
  const [added, setAdded] = useState<Errand[]>([]);
  // The block whose contextual actions (delete) are showing, or null.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addSeedKey, setAddSeedKey] = useState('add-0');

  const addedIds = useMemo(() => new Set(added.map((e) => e.id)), [added]);
  // The full working set the canvas reasons about: stored errands + this
  // session's not-yet-saved additions.
  const allErrands = useMemo(() => [...errands, ...added], [errands, added]);

  const errandsById = useMemo(() => {
    const m = new Map<string, Errand>();
    for (const e of allErrands) m.set(e.id, e);
    return m;
  }, [allErrands]);
  // A stable lookup for the gesture callbacks (so they never go stale or churn).
  const errandsByIdRef = useRef(errandsById);
  errandsByIdRef.current = errandsById;

  const draft = useMemo(
    () => buildDayDraft(allErrands, date, pending),
    [allErrands, date, pending],
  );

  // The vertical extent of the active plan's blocks, so we can draw ONE
  // continuous rail behind them — a plan reads as a single object, not a scatter
  // of separate purple blocks. Null when the day has no plan blocks.
  const planSpan = useMemo(() => {
    let topMin = Infinity;
    let bottomMin = -Infinity;
    for (const ev of draft.events) {
      if (ev.errand.planRef == null) continue;
      topMin = Math.min(topMin, ev.startMin);
      bottomMin = Math.max(bottomMin, ev.endMin);
    }
    return bottomMin > topMin ? { topMin, bottomMin } : null;
  }, [draft.events]);

  // A comfortable, stable canvas: fit the events but never tighter than 6 AM–11 PM
  // so there's always room to drag earlier or later.
  const win = useMemo(() => {
    const base = dayWindow(draft.events);
    return {
      startMin: Math.min(base.startMin, 6 * 60),
      endMin: Math.max(base.endMin, 23 * 60),
    };
  }, [draft.events]);

  const timelineH = (win.endMin - win.startMin) * PXPM;

  // Open scrolled to the day's first block (or ~8 AM), computed once so later
  // re-renders never yank the canvas back.
  const initialY = useRef<number | null>(null);
  if (initialY.current == null) {
    const first = draft.events.reduce((m, e) => Math.min(m, e.startMin), 24 * 60);
    let anchor = draft.events.length > 0 ? first : 8 * 60;
    if (nowMin != null && nowMin >= win.startMin && nowMin <= win.endMin) anchor = nowMin;
    initialY.current = Math.max(0, (anchor - win.startMin) * PXPM - 80);
  }

  // Commute connectors: the live preview folds the held errand in at its current
  // target minute so the travel around the drop updates as you move.
  const segments = useMemo<CommuteSegment[]>(() => {
    if (!drag || drag.kind === 'resize') return commuteSegments(draft.events);
    const previewDraft = buildDayDraft(allErrands, date, {
      ...pending,
      [drag.errandId]: { ...pending[drag.errandId], startMin: drag.previewMin },
    });
    return commuteSegments(previewDraft.events);
  }, [drag, draft.events, allErrands, date, pending]);

  const rootRef = useAnimatedRef<Animated.View>();
  const scrollRef = useAnimatedRef<Animated.ScrollView>();
  // Seed the offset with our initial scroll so the drop math is correct before
  // the first scroll event fires (the hook otherwise starts at 0).
  const scrollY = useSharedValue(initialY.current ?? 0);
  useScrollViewOffset(scrollRef, scrollY);
  const sv: DragSV = {
    scrollY,
    viewportH: useSharedValue(0),
    originY: useSharedValue(0),
    contentH: useSharedValue(0),
    winStart: useSharedValue(win.startMin),
    winEnd: useSharedValue(win.endMin),
    dragId: useSharedValue<string | null>(null),
    dragKind: useSharedValue(KIND_NONE),
    dragWork: useSharedValue(60),
    previewMin: useSharedValue(0),
    previewDur: useSharedValue(60),
    lastTransY: useSharedValue(0),
    blockStartTop: useSharedValue(0),
    blockStartScroll: useSharedValue(0),
    fingerY: useSharedValue(0),
    ghostX: useSharedValue(0),
    ghostY: useSharedValue(0),
    rootX: useSharedValue(0),
    rootY: useSharedValue(0),
    autoDir: useSharedValue(0),
    isView: useSharedValue(mode === 'view'),
    isFocus: useSharedValue(focusPlanId != null),
  };

  useEffect(() => {
    sv.winStart.value = win.startMin;
    sv.winEnd.value = win.endMin;
    sv.contentH.value = timelineH + BOTTOM_PAD;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [win.startMin, win.endMin, timelineH]);

  useEffect(() => {
    sv.isView.value = mode === 'view';
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  useEffect(() => {
    sv.isFocus.value = focusActive;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusActive]);

  // ----- JS bridges the worklets call -----
  const lift = useCallback(
    (errandId: string, kind: 'block' | 'chip' | 'resize', startMin: number, work: number) => {
      const e = errandsById.get(errandId);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
      setSelectedId(null);
      setDrag({ errandId, kind, title: e?.title ?? '', previewMin: startMin, workMin: work });
    },
    [errandsById],
  );

  const preview = useCallback((min: number) => {
    setDrag((d) => (d && d.previewMin !== min ? { ...d, previewMin: min } : d));
  }, []);

  // Live duration mirror while stretching, so the end-time label tracks the grip.
  const previewResize = useCallback((dur: number) => {
    setDrag((d) => (d && d.workMin !== dur ? { ...d, workMin: dur } : d));
  }, []);

  const place = useCallback((errandId: string, startMin: number) => {
    const e = errandsByIdRef.current.get(errandId);
    // Focused-plan block: a drag is a STAGED plan edit (move, or reorder when it
    // crosses other stops) — dispatch to the working copy and bail. It's the
    // host's Confirm, not this gesture, that persists it.
    if (
      e?.planRef &&
      e.planRef.planId === focusPlanIdRef.current &&
      focusPlanItinRef.current &&
      onPlanEditRef.current
    ) {
      // A hold-and-release in place is not a move — don't pin/re-route the stop.
      if (baseStartMin(e) === startMin) {
        setDrag(null);
        return;
      }
      const ops = moveOrReorderFromDrag(focusPlanItinRef.current, e.planRef.itemId, startMin);
      Haptics.selectionAsync().catch(() => undefined);
      onPlanEditRef.current(ops);
      setDrag(null);
      return;
    }
    Haptics.selectionAsync().catch(() => undefined);
    setPending((p) => {
      const cur = p[errandId];
      // Holding a card to enter edit (no real move) shouldn't stage a phantom change.
      if (e && startMin === baseStartMin(e) && cur?.durationMin == null && !cur?.deleted) {
        if (!cur) return p;
        const { [errandId]: _drop, ...rest } = p;
        return rest;
      }
      return { ...p, [errandId]: { ...cur, startMin } };
    });
    setDrag(null);
  }, []);

  const commitResize = useCallback((errandId: string, durationMin: number) => {
    const e = errandsByIdRef.current.get(errandId);
    // Focused-plan block: stretching is a staged setDuration on the plan stop.
    if (
      e?.planRef &&
      e.planRef.planId === focusPlanIdRef.current &&
      onPlanEditRef.current
    ) {
      // Released at the same length → not a stretch; skip the edit + re-route.
      if (durationMin === workMinutes(e)) {
        setDrag(null);
        return;
      }
      Haptics.selectionAsync().catch(() => undefined);
      onPlanEditRef.current([{ type: 'setDuration', id: e.planRef.itemId, minutes: durationMin }]);
      setDrag(null);
      return;
    }
    Haptics.selectionAsync().catch(() => undefined);
    setPending((p) => {
      const cur = p[errandId];
      if (e && durationMin === workMinutes(e) && cur?.startMin == null && !cur?.deleted) {
        if (!cur) return p;
        const { [errandId]: _drop, ...rest } = p;
        return rest;
      }
      return { ...p, [errandId]: { ...cur, durationMin } };
    });
    setDrag(null);
  }, []);

  const cancelDrag = useCallback(() => setDrag(null), []);

  const select = useCallback((id: string) => {
    Haptics.selectionAsync().catch(() => undefined);
    setSelectedId((cur) => (cur === id ? null : id));
  }, []);

  // A long-press on a read-only block asks the host to enter edit mode; the same
  // gesture keeps dragging because the canvas + block view stay mounted.
  const requestEdit = useCallback(() => {
    onRequestEdit?.();
  }, [onRequestEdit]);

  // A tap on a read-only block opens it in the host's drawer.
  const openEvent = useCallback((id: string) => {
    const e = errandsByIdRef.current.get(id);
    if (e) onPressEvent?.(e);
  }, [onPressEvent]);

  // A tap on a plan block enters (or switches) focus for that plan.
  const focusPlan = useCallback((planId: string) => {
    Haptics.selectionAsync().catch(() => undefined);
    setSelectedId(null);
    onFocusPlanRef.current?.(planId);
  }, []);

  // Trash the selected block — a session-only deletion (Cancel restores it). A
  // brand-new errand is simply dropped; a stored one is flagged for removal.
  const deleteSelected = useCallback(() => {
    const id = selectedId;
    if (!id) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Rigid).catch(() => undefined);
    const sel = errandsById.get(id);
    // Focused-plan block: removing it is a live plan edit (the day re-cascades).
    if (sel?.planRef && sel.planRef.planId === focusPlanId && onPlanEdit) {
      onPlanEdit([{ type: 'remove', id: sel.planRef.itemId }]);
      setSelectedId(null);
      return;
    }
    if (addedIds.has(id)) {
      setAdded((a) => a.filter((e) => e.id !== id));
      setPending((p) => {
        const next = { ...p };
        delete next[id];
        return next;
      });
    } else {
      setPending((p) => ({ ...p, [id]: { ...p[id], deleted: true } }));
    }
    setSelectedId(null);
  }, [selectedId, addedIds, errandsById, focusPlanId, onPlanEdit]);

  const openAdd = useCallback(() => {
    Haptics.selectionAsync().catch(() => undefined);
    setSelectedId(null);
    setAddSeedKey(`add-${Date.now()}`);
    setAddOpen(true);
  }, []);

  const onAddSave = useCallback(
    (input: ErrandInput) => {
      const now = Date.now();
      setAdded((a) => [
        ...a,
        {
          ...input,
          id: uid('new'),
          date: input.date ?? date,
          rawText: input.rawText ?? input.title,
          done: false,
          createdAt: now,
          updatedAt: now,
        },
      ]);
      setAddOpen(false);
    },
    [date],
  );

  const selected = selectedId ? errandsById.get(selectedId) ?? null : null;
  const selectedEvent = selectedId
    ? draft.events.find((ev) => ev.id === selectedId) ?? null
    : null;

  // Each placed/resized stored errand and each new errand counts once.
  const realChanges = Object.keys(pending).filter((id) => !addedIds.has(id)).length;
  const changeCount = realChanges + added.length;

  const confirm = () => {
    for (const e of allErrands) {
      if (e.planRef) continue; // read-only plan projection — never persisted
      const edit = pending[e.id];
      const isAdded = addedIds.has(e.id);
      if (edit?.deleted) {
        if (!isAdded) {
          if (e.recurringId && e.date) skipRecurringOccurrence(e.recurringId, e.date);
          else removeErrand(e.id);
        }
        continue;
      }
      const start = edit?.startMin != null ? edit.startMin : baseStartMin(e);
      const dur = edit?.durationMin != null ? edit.durationMin : workMinutes(e);
      const timed =
        start != null
          ? {
              startTime: minutesToHHMM(start),
              endTime: minutesToHHMM(start + dur),
              durationMin: dur,
            }
          : null;
      if (isAdded) {
        addErrand({ ...errandToInput(e), ...(timed ?? {}) });
      } else if (edit && (edit.startMin != null || edit.durationMin != null) && timed) {
        updateErrand(e.id, timed);
      }
    }
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(
      () => undefined,
    );
    resetSession();
    onClose();
  };

  // The editor stays mounted across the view⇄edit flip, so a confirm/cancel must
  // clear this session's unsaved state itself (no unmount to do it for us).
  const resetSession = useCallback(() => {
    setPending({});
    setAdded([]);
    setSelectedId(null);
    setDrag(null);
  }, []);

  // Returning to read-only (Confirm, Cancel, or the header Back) always discards
  // any uncommitted staging — view mode must reflect the saved schedule only.
  useEffect(() => {
    if (mode === 'view') resetSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const cancel = () => {
    Haptics.selectionAsync().catch(() => undefined);
    resetSession();
    onClose();
  };

  // Continuous edge auto-scroll while a drag is held near the top/bottom, with the
  // target minute re-resolved each frame so the drop preview tracks the moving canvas.
  useFrameCallback(() => {
    if (sv.dragKind.value === KIND_NONE || sv.autoDir.value === 0) return;
    const max = Math.max(0, sv.contentH.value - sv.viewportH.value);
    const next = Math.min(Math.max(scrollY.value + sv.autoDir.value * MAX_AUTO, 0), max);
    if (next === scrollY.value) {
      sv.autoDir.value = 0;
      return;
    }
    scrollTo(scrollRef, 0, next, false);
    let contentTop: number;
    if (sv.dragKind.value === KIND_BLOCK) {
      contentTop = sv.blockStartTop.value + sv.lastTransY.value + (next - sv.blockStartScroll.value);
    } else {
      contentTop = sv.fingerY.value - sv.originY.value + next;
    }
    const raw = sv.winStart.value + contentTop / PXPM;
    const clamped = snapClampMin(raw, sv.dragWork.value, sv.winStart.value, sv.winEnd.value);
    if (clamped !== sv.previewMin.value) {
      sv.previewMin.value = clamped;
      runOnJS(preview)(clamped);
    }
  });

  const cb = useMemo(
    () => ({
      lift,
      preview,
      previewResize,
      place,
      commitResize,
      cancelDrag,
      select,
      requestEdit,
      openEvent,
      focusPlan,
    }),
    [lift, preview, previewResize, place, commitResize, cancelDrag, select, requestEdit, openEvent, focusPlan],
  );

  const firstHour = Math.ceil(win.startMin / 60);
  const lastHour = Math.floor(win.endMin / 60);
  const hours: number[] = [];
  for (let h = firstHour; h <= lastHour; h += 1) hours.push(h);

  return (
    <Animated.View ref={rootRef} style={styles.fill}>
      <Animated.ScrollView
        ref={scrollRef}
        style={styles.fill}
        showsVerticalScrollIndicator={false}
        scrollEventThrottle={16}
        contentOffset={{ x: 0, y: initialY.current ?? 0 }}
        onLayout={(e) => {
          sv.viewportH.value = e.nativeEvent.layout.height;
        }}
        contentContainerStyle={{ height: timelineH + BOTTOM_PAD }}
      >
        <View
          style={styles.canvas}
          onLayout={(e: LayoutChangeEvent) =>
            setLaneW(Math.max(0, e.nativeEvent.layout.width - GUTTER_W))
          }
        >
          {/* Hour gridlines + gutter labels */}
          {hours.map((h) => {
            const y = (h * 60 - win.startMin) * PXPM;
            return (
              <View key={`l-${h}`} pointerEvents="none">
                <View style={[styles.hourLine, { top: y, backgroundColor: t.colors.separator }]} />
                <Text
                  variant="micro"
                  tone="secondary"
                  weight="semibold"
                  style={[styles.hourLabel, { top: y - 7 }]}
                >
                  {hourLabel(h)}
                </Text>
              </View>
            );
          })}

          {/* Plan rail — groups the day's plan blocks into one object, with an
              explicit tap-to-edit-in-the-planner cap. */}
          {planSpan ? (
            <PlanSpine
              winStart={win.startMin}
              topMin={planSpan.topMin}
              bottomMin={planSpan.bottomMin}
              title={planTitle}
              onOpen={onOpenPlan}
            />
          ) : null}

          {/* Now line */}
          {nowMin != null && nowMin >= win.startMin && nowMin <= win.endMin ? (
            <>
              <View
                pointerEvents="none"
                style={[
                  styles.nowLine,
                  { top: (nowMin - win.startMin) * PXPM - 0.75, backgroundColor: t.colors.danger },
                ]}
              />
              <View
                pointerEvents="none"
                style={[
                  styles.nowDot,
                  { top: (nowMin - win.startMin) * PXPM - 4, backgroundColor: t.colors.danger },
                ]}
              />
            </>
          ) : null}

          {/* "Between" availability windows — the highlighted allowed regions (edit only) */}
          {isEdit
            ? draft.events.map((ev) =>
                ev.window ? (
                  <WindowBand
                    key={`w-${ev.id}`}
                    event={ev}
                    winStart={win.startMin}
                    laneW={laneW}
                    active={drag?.errandId === ev.id}
                  />
                ) : null,
              )
            : null}

          {/* Commute connectors between consecutive located stops (edit + focus) */}
          {(isEdit || focusActive) && laneW > 0
            ? segments.map((seg) => (
                <CommuteConnector key={seg.key} seg={seg} winStart={win.startMin} />
              ))
            : null}

          {/* The live drop preview (snapped slot outline + gutter time label) */}
          {drag && drag.kind !== 'resize' ? (
            <DropPreview sv={sv} laneW={laneW} drag={drag} />
          ) : null}
          {/* While stretching, a gutter label tracks the new end time */}
          {drag?.kind === 'resize' ? (
            <ResizeEndLabel sv={sv} drag={drag} winStart={win.startMin} />
          ) : null}

          {/* Draft blocks */}
          {laneW > 0
            ? draft.events.map((ev) => (
                <DraftBlock
                  key={ev.id}
                  event={ev}
                  winStart={win.startMin}
                  laneW={laneW}
                  sv={sv}
                  scrollRef={scrollRef}
                  cb={cb}
                  selected={selectedId === ev.id}
                  editing={isEdit}
                  focusPlanId={focusPlanId}
                />
              ))
            : null}

          {/* Empty day (view mode) */}
          {!isEdit && draft.events.length === 0 ? (
            <View pointerEvents="none" style={[styles.viewEmpty, { left: GUTTER_W }]}>
              <Ionicons name="time-outline" size={16} color={t.colors.textTertiary} />
              <Text variant="caption" tone="tertiary">
                No timed errands yet. Hold one to reschedule.
              </Text>
            </View>
          ) : null}
        </View>
      </Animated.ScrollView>

      {/* Contextual delete for the tapped (editable) block — shared by errand
          edit and plan focus, since both can select a block to remove it. */}
      {(isEdit || focusActive) && selected ? (
        <SelectedBar
          title={selected.title}
          subtitle={
            selectedEvent
              ? `${formatTime(minutesToHHMM(selectedEvent.startMin))} · ${formatDuration(selectedEvent.workMin)} · drag edge to stretch`
              : 'drag onto the timeline to schedule'
          }
          accent={!!selected.planRef}
          onClose={() => setSelectedId(null)}
          onDelete={deleteSelected}
        />
      ) : null}

      {/* Plan focus chrome (live edits, no Confirm) takes over the bottom bar
          while a plan is focused; otherwise the errand edit chrome shows. */}
      {focusActive ? (
        <FocusBar
          title={planTitle}
          busy={planBusy}
          dirty={planDirty}
          onAddStop={onAddPlanStop}
          onConfirm={onConfirmPlan}
          onCancel={onCancelPlan}
          bottomInset={insets.bottom}
        />
      ) : isEdit ? (
        <>
      {/* Unscheduled tray — drag a chip up onto the timeline to schedule it */}
      <View style={[styles.tray, { borderTopColor: t.colors.separator, backgroundColor: t.colors.background }]}>
        <View style={styles.trayHead}>
          <Text variant="micro" uppercase weight="bold" tone="secondary" style={styles.trayHeadText}>
            {draft.unscheduled.length > 0
              ? `Drag to schedule · ${draft.unscheduled.length}`
              : 'Tap a block to edit · drag to retime'}
          </Text>
          {drag?.kind === 'chip' ? (
            <Text variant="micro" weight="semibold" tone="accent">
              {formatTime(minutesToHHMM(drag.previewMin))}
            </Text>
          ) : (
            <Pressable
              onPress={openAdd}
              hitSlop={8}
              style={({ pressed }) => [
                styles.addBtn,
                { backgroundColor: t.colors.accentSoft },
                pressed && { opacity: 0.7 },
              ]}
              accessibilityRole="button"
              accessibilityLabel="Add a new errand"
            >
              <Ionicons name="add" size={15} color={t.colors.accentText} />
              <Text variant="micro" weight="bold" style={{ color: t.colors.accentText }}>
                Add
              </Text>
            </Pressable>
          )}
        </View>
        {draft.unscheduled.length > 0 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.trayChips}
          >
            {draft.unscheduled.map((errand) => (
              <TrayChip
                key={errand.id}
                errand={errand}
                sv={sv}
                scrollRef={scrollRef}
                rootRef={rootRef}
                cb={cb}
                hidden={drag?.errandId === errand.id}
              />
            ))}
          </ScrollView>
        ) : (
          <View style={styles.trayEmpty}>
            <Ionicons name="bulb-outline" size={16} color={t.colors.textTertiary} />
            <Text variant="caption" tone="tertiary">
              Tap a block for options · pull its bottom edge to stretch.
            </Text>
          </View>
        )}
      </View>

      {/* Confirm / Cancel — the edit only lands on Confirm */}
      <View
        style={[
          styles.bar,
          {
            borderTopColor: t.colors.separator,
            backgroundColor: t.colors.background,
            paddingBottom: Math.max(10, insets.bottom),
          },
        ]}
      >
        <Pressable
          onPress={cancel}
          style={({ pressed }) => [
            styles.barBtn,
            { backgroundColor: t.colors.fill1 },
            pressed && { opacity: 0.7 },
          ]}
          accessibilityRole="button"
          accessibilityLabel="Cancel edits"
        >
          <Text variant="bodySm" weight="semibold">
            Cancel
          </Text>
        </Pressable>
        <Pressable
          onPress={confirm}
          style={({ pressed }) => [
            styles.barBtn,
            styles.barConfirm,
            { backgroundColor: t.colors.accent },
            pressed && { opacity: 0.85 },
          ]}
          accessibilityRole="button"
          accessibilityLabel={
            changeCount > 0 ? `Confirm ${changeCount} changes` : 'Confirm'
          }
        >
          <Ionicons name="checkmark" size={17} color={t.colors.textOnAccent} />
          <Text variant="bodySm" weight="bold" style={{ color: t.colors.textOnAccent }}>
            {changeCount > 0 ? `Confirm · ${changeCount}` : 'Confirm'}
          </Text>
        </Pressable>
      </View>

      {/* Floating ghost that follows the finger while a tray chip is in flight */}
      {drag?.kind === 'chip' ? <ChipGhost sv={sv} title={drag.title} /> : null}

      {/* Create-a-new-errand drawer — the app's standard composer, saved into the session */}
      <ErrandDrawer
        open={addOpen}
        onClose={() => setAddOpen(false)}
        draft={{ ...ADD_SEED, date }}
        rawText=""
        parsing={false}
        seedKey={addSeedKey}
        mode="create"
        onSave={onAddSave}
      />
        </>
      ) : null}
    </Animated.View>
  );
}

/** A "between" errand's availability window, drawn as a soft band behind its block. */
function WindowBand({
  event,
  winStart,
  laneW,
  active,
}: {
  event: DraftEvent;
  winStart: number;
  laneW: number;
  active: boolean;
}) {
  const t = useTheme();
  if (!event.window) return null;
  const top = (event.window.startMin - winStart) * PXPM;
  const height = Math.max(8, (event.window.endMin - event.window.startMin) * PXPM);
  return (
    <View
      pointerEvents="none"
      style={[
        styles.band,
        {
          top,
          height,
          left: GUTTER_W,
          width: laneW,
          backgroundColor: active ? t.colors.successSoft : t.colors.accentSoft,
          borderColor: active ? t.colors.success : t.colors.accent,
        },
      ]}
    >
      <Text
        variant="micro"
        weight="bold"
        style={[styles.bandLabel, { color: active ? t.colors.success : t.colors.accentText }]}
      >
        {`Anytime ${formatTime(minutesToHHMM(event.window.startMin))}–${formatTime(minutesToHHMM(event.window.endMin))}`}
      </Text>
    </View>
  );
}

/** A commute estimate drawn in the rail just right of the gutter, spanning its gap. */
function CommuteConnector({ seg, winStart }: { seg: CommuteSegment; winStart: number }) {
  const t = useTheme();
  const top = (seg.fromEndMin - winStart) * PXPM;
  const height = Math.max(14, (seg.toStartMin - seg.fromEndMin) * PXPM);
  const mid = top + height / 2;
  const color = seg.tight ? t.colors.danger : t.colors.textSecondary;
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <View
        style={[
          styles.commuteLine,
          { top, height, left: GUTTER_W + 11, borderColor: color },
        ]}
      />
      <View
        style={[
          styles.commutePill,
          {
            top: mid - 10,
            backgroundColor: t.colors.surface1,
            borderColor: seg.tight ? t.colors.danger : t.colors.separator,
          },
        ]}
      >
        <Ionicons name={seg.icon as keyof typeof Ionicons.glyphMap} size={11} color={color} />
        <Text variant="micro" weight="bold" style={{ color }}>
          {`${seg.minutes}m`}
        </Text>
      </View>
    </View>
  );
}

/** The snapped drop target: a dashed outline at the slot + a gutter time label. */
function DropPreview({ sv, laneW, drag }: { sv: DragSV; laneW: number; drag: DragState }) {
  const t = useTheme();
  const outline = useAnimatedStyle(() => ({
    transform: [{ translateY: (sv.previewMin.value - sv.winStart.value) * PXPM }],
    height: Math.max(MIN_BLOCK_H, sv.dragWork.value * PXPM) - BLOCK_GAP,
  }));
  const label = useAnimatedStyle(() => ({
    transform: [{ translateY: (sv.previewMin.value - sv.winStart.value) * PXPM - 7 }],
  }));
  const endMin = drag.previewMin + drag.workMin;
  return (
    <>
      <Animated.View
        pointerEvents="none"
        style={[
          styles.dropOutline,
          { left: GUTTER_W + BLOCK_GAP, width: laneW - BLOCK_GAP * 2, borderColor: t.colors.accent },
          outline,
        ]}
      >
        <Text variant="caption" weight="bold" numberOfLines={1} style={{ color: t.colors.accentText }}>
          {drag.title}
        </Text>
        <Text variant="micro" style={{ color: t.colors.accentText }}>
          {`${formatTime(minutesToHHMM(drag.previewMin))} – ${formatTime(minutesToHHMM(endMin))}`}
        </Text>
      </Animated.View>
      <Animated.View pointerEvents="none" style={[styles.dropLabel, label]}>
        <Text variant="micro" weight="bold" style={{ color: t.colors.accent }}>
          {formatTime(minutesToHHMM(drag.previewMin))}
        </Text>
      </Animated.View>
    </>
  );
}

/** While stretching a block, a moving end line + gutter time label track the new end. */
function ResizeEndLabel({ sv, drag, winStart }: { sv: DragSV; drag: DragState; winStart: number }) {
  const t = useTheme();
  const line = useAnimatedStyle(() => ({
    transform: [{ translateY: (sv.previewMin.value + sv.previewDur.value - winStart) * PXPM }],
  }));
  const label = useAnimatedStyle(() => ({
    transform: [{ translateY: (sv.previewMin.value + sv.previewDur.value - winStart) * PXPM - 7 }],
  }));
  return (
    <>
      <Animated.View
        pointerEvents="none"
        style={[styles.resizeLine, { backgroundColor: t.colors.accent }, line]}
      />
      <Animated.View pointerEvents="none" style={[styles.dropLabel, label]}>
        <Text variant="micro" weight="bold" style={{ color: t.colors.accent }}>
          {formatTime(minutesToHHMM(drag.previewMin + drag.workMin))}
        </Text>
      </Animated.View>
    </>
  );
}

/**
 * A timed/flexible block on the canvas. Tap to reveal its actions (delete);
 * long-press the body and drag to retime; long-press the bottom grip and drag to
 * stretch its duration. The bottom strip of the block is the resize zone.
 */
function DraftBlock({
  event,
  winStart,
  laneW,
  sv,
  scrollRef,
  cb,
  selected,
  editing,
  focusPlanId,
}: {
  event: DraftEvent;
  winStart: number;
  laneW: number;
  sv: DragSV;
  scrollRef: ReturnType<typeof useAnimatedRef<Animated.ScrollView>>;
  cb: EditorCallbacks;
  selected: boolean;
  editing: boolean;
  focusPlanId?: string | null;
}) {
  const t = useTheme();
  const { errand } = event;
  // A projected plan stop. Normally read-only (a tap focuses the plan), but the
  // FOCUSED plan's stops become live-editable on the grid. Tinted purple to read
  // as "your plan", distinct from errands.
  const isPlan = errand.planRef != null;
  const planId = errand.planRef?.planId ?? null;
  const focusActive = focusPlanId != null;
  // This block IS part of the plan currently in focus → drag/resize/delete it.
  const isFocusBlock = focusActive && planId === focusPlanId;
  // Interactive (pan attached): a focused-plan block in focus mode, or any errand
  // when not focusing (errands pan in both view — to enter edit — and edit).
  const editableHere = focusActive ? isFocusBlock : !isPlan;
  // Resizable: a focused-plan block, or an errand in edit mode (never in view).
  const resizable = focusActive ? isFocusBlock : editing && !isPlan;
  // Everything that isn't the focused plan dims + locks while focusing.
  const dim = focusActive && !isFocusBlock;
  const realWork = event.workMin;
  const baseTop = (event.startMin - winStart) * PXPM;
  // Draw to the TRUE duration (with a small floor), so a 15-min stop is a short
  // block sitting flush before the next — never padded into a fake overlap.
  const height = Math.max(MIN_DRAW_H, realWork * PXPM) - BLOCK_GAP;
  // Too short for the start–end line? Then show the title alone (compact).
  const showMeta = height >= META_MIN_H;
  const colW = laneW / event.cols;
  const left = GUTTER_W + event.col * colW + BLOCK_GAP;
  const blockW = colW - BLOCK_GAP * 2;
  const located = errand.latitude != null && errand.longitude != null;

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .activateAfterLongPress(160)
        .maxPointers(1)
        .onStart((e) => {
          const m = measure(scrollRef);
          if (m) {
            sv.originY.value = m.pageY;
            sv.viewportH.value = m.height;
          }
          // Holding an ERRAND in read-only view flips the host to edit mode; this
          // same gesture keeps going because the block view never unmounts. A
          // focused-plan block edits in place, so it never requests errand edit.
          if (sv.isView.value && !sv.isFocus.value) runOnJS(cb.requestEdit)();
          sv.dragId.value = event.id;
          sv.blockStartTop.value = baseTop;
          sv.blockStartScroll.value = sv.scrollY.value;
          sv.lastTransY.value = 0;
          sv.previewMin.value = event.startMin;
          // A press starting in the bottom grip strip stretches instead of moves —
          // but a hold from read-only errand always moves (the grip isn't shown
          // there yet), and a block too short to show a grip (compact) only moves.
          // Focus blocks always allow resize (they show a grip even from `view`).
          const grip = Math.min(RESIZE_ZONE, height * 0.45);
          if ((!sv.isView.value || sv.isFocus.value) && showMeta && e.y >= height - grip) {
            sv.dragKind.value = KIND_RESIZE;
            sv.previewDur.value = realWork;
            runOnJS(cb.lift)(event.id, 'resize', event.startMin, realWork);
          } else {
            sv.dragKind.value = KIND_BLOCK;
            sv.dragWork.value = Math.max(MIN_BLOCK_H / PXPM, realWork);
            runOnJS(cb.lift)(event.id, 'block', event.startMin, realWork);
          }
        })
        .onUpdate((e) => {
          if (sv.dragKind.value === KIND_RESIZE) {
            const delta = (e.translationY + (sv.scrollY.value - sv.blockStartScroll.value)) / PXPM;
            const snapped = Math.round((realWork + delta) / SNAP_STEP) * SNAP_STEP;
            const hi = Math.max(MIN_WORK, sv.winEnd.value - event.startMin);
            const dur = Math.min(Math.max(snapped, MIN_WORK), hi);
            if (dur !== sv.previewDur.value) {
              sv.previewDur.value = dur;
              runOnJS(cb.previewResize)(dur);
            }
            return;
          }
          sv.lastTransY.value = e.translationY;
          const contentTop = baseTop + e.translationY + (sv.scrollY.value - sv.blockStartScroll.value);
          const raw = sv.winStart.value + contentTop / PXPM;
          const clamped = snapClampMin(raw, sv.dragWork.value, sv.winStart.value, sv.winEnd.value);
          if (clamped !== sv.previewMin.value) {
            sv.previewMin.value = clamped;
            runOnJS(cb.preview)(clamped);
          }
          sv.autoDir.value = autoDirFor(contentTop - sv.scrollY.value, sv.viewportH.value);
        })
        .onEnd(() => {
          if (sv.dragKind.value === KIND_RESIZE) {
            runOnJS(cb.commitResize)(event.id, sv.previewDur.value);
          } else {
            runOnJS(cb.place)(event.id, sv.previewMin.value);
          }
        })
        .onFinalize(() => {
          sv.dragId.value = null;
          sv.dragKind.value = KIND_NONE;
          sv.autoDir.value = 0;
        }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [event.id, event.startMin, realWork, baseTop, colW, height],
  );

  const tap = useMemo(
    () =>
      Gesture.Tap()
        .maxDuration(220)
        .onEnd((_e, ok) => {
          if (!ok) return;
          if (focusActive) {
            // In focus: tap the focused plan's stop to select (then delete);
            // tap ANOTHER plan to switch focus to it; errands are locked.
            if (isFocusBlock) runOnJS(cb.select)(event.id);
            else if (isPlan && planId != null) runOnJS(cb.focusPlan)(planId);
            return;
          }
          if (isPlan && planId != null) {
            // From view, a plan tap enters inline focus; mid errand-edit it opens
            // the planner instead, so staged errand changes aren't dropped.
            if (editing) runOnJS(cb.openEvent)(event.id);
            else runOnJS(cb.focusPlan)(planId);
            return;
          }
          // Read-only errand opens; an errand in edit selects.
          if (sv.isView.value) runOnJS(cb.openEvent)(event.id);
          else runOnJS(cb.select)(event.id);
        }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [event.id, isPlan, planId, focusActive, isFocusBlock, editing],
  );

  // Interactive blocks get drag+tap; locked ones (errands while focusing, plan
  // blocks while not focusing) get only a tap (focus/open/switch).
  const gesture = useMemo(
    () => (editableHere ? Gesture.Exclusive(pan, tap) : tap),
    [editableHere, pan, tap],
  );

  const animStyle = useAnimatedStyle(() => {
    const active = sv.dragId.value === event.id;
    if (active && sv.dragKind.value === KIND_RESIZE) {
      return {
        height: Math.max(MIN_BLOCK_H, sv.previewDur.value * PXPM) - BLOCK_GAP,
        transform: [{ translateY: 0 }, { scale: 1 }],
        zIndex: 999,
        opacity: 0.99,
        shadowOpacity: 0.28,
      };
    }
    if (active) {
      const ty = sv.lastTransY.value + (sv.scrollY.value - sv.blockStartScroll.value);
      return {
        height,
        transform: [{ translateY: ty }, { scale: 1.03 }],
        zIndex: 999,
        opacity: 0.97,
        shadowOpacity: 0.28,
      };
    }
    return {
      height,
      transform: [{ translateY: 0 }, { scale: 1 }],
      zIndex: selected ? 998 : 1,
      opacity: 1,
      shadowOpacity: selected ? 0.2 : 0,
    };
  });

  return (
    <Animated.View
      style={[
        styles.block,
        {
          top: baseTop,
          left,
          width: blockW,
          height,
          backgroundColor: isPlan
            ? PLAN_TINT
            : event.flexible && !selected
            ? t.colors.surface1
            : t.colors.accentSoft,
          borderColor: isPlan ? t.colors.highlightPurple : t.colors.accent,
          borderStyle: !isPlan && event.flexible && !selected ? 'dashed' : 'solid',
          borderWidth: isFocusBlock
            ? selected
              ? 2
              : 1.5
            : isPlan
            ? StyleSheet.hairlineWidth
            : selected
            ? 2
            : event.flexible
            ? StyleSheet.hairlineWidth
            : 0,
          shadowColor: t.colors.shadow,
        },
        animStyle,
        // Non-focused blocks fade back while a plan is being edited.
        dim ? styles.dimmed : null,
      ]}
    >
      <GestureDetector gesture={gesture}>
        <View style={styles.blockInner}>
          <View
            style={[
              styles.blockBar,
              { backgroundColor: isPlan ? t.colors.highlightPurple : t.colors.accent },
            ]}
          />
          <View style={styles.blockBody}>
            <View style={styles.blockTitleRow}>
              <Text
                variant="caption"
                weight="bold"
                numberOfLines={1}
                style={[
                  styles.blockTitle,
                  { color: isPlan ? t.colors.textPrimary : t.colors.accentText },
                ]}
              >
                {errand.title}
              </Text>
              {isPlan ? (
                <Ionicons
                  name={event.recurring ? 'repeat' : 'map'}
                  size={11}
                  color={t.colors.highlightPurple}
                />
              ) : event.recurring ? (
                <Ionicons name="repeat" size={11} color={t.colors.accentText} />
              ) : located ? (
                <Ionicons name="location" size={11} color={t.colors.accentText} />
              ) : null}
            </View>
            {showMeta ? (
              <Text
                variant="micro"
                numberOfLines={1}
                style={{
                  color: isPlan ? t.colors.textSecondary : t.colors.accentText,
                  opacity: isPlan ? 1 : 0.85,
                }}
              >
                {`${formatTime(minutesToHHMM(event.startMin))} – ${formatTime(minutesToHHMM(event.startMin + realWork))}`}
              </Text>
            ) : null}
          </View>
          {!showMeta ? null : isFocusBlock ? (
            <Ionicons
              name={selected ? 'ellipsis-horizontal' : 'reorder-two'}
              size={16}
              color={t.colors.highlightPurple}
              style={{ opacity: 0.75 }}
            />
          ) : isPlan ? (
            <Ionicons
              name="chevron-forward"
              size={14}
              color={t.colors.highlightPurple}
              style={{ opacity: 0.8 }}
            />
          ) : editing ? (
            <Ionicons
              name={selected ? 'ellipsis-horizontal' : 'reorder-two'}
              size={16}
              color={t.colors.accentText}
              style={{ opacity: 0.55 }}
            />
          ) : null}
        </View>
      </GestureDetector>
      {/* Stretch grip — the bottom strip resizes the block's duration (editable
          blocks tall enough to grab: errands in edit, or a focused plan stop) */}
      {resizable && showMeta ? (
        <View pointerEvents="none" style={styles.grip}>
          <View
            style={[
              styles.gripBar,
              { backgroundColor: isFocusBlock ? t.colors.highlightPurple : t.colors.accent },
            ]}
          />
        </View>
      ) : null}
    </Animated.View>
  );
}

/** An unscheduled errand in the tray. Long-press to lift it onto the timeline. */
function TrayChip({
  errand,
  sv,
  scrollRef,
  rootRef,
  cb,
  hidden,
}: {
  errand: Errand;
  sv: DragSV;
  scrollRef: ReturnType<typeof useAnimatedRef<Animated.ScrollView>>;
  rootRef: ReturnType<typeof useAnimatedRef<Animated.View>>;
  cb: EditorCallbacks;
  hidden: boolean;
}) {
  const t = useTheme();
  const located = errand.latitude != null && errand.longitude != null;
  // Real duration drives the committed time + preview label; the drawn block is
  // never shorter than a min-height block (matches the read-only timeline).
  const realWork = workMinutes(errand);
  const drawWork = Math.max(MIN_BLOCK_H / PXPM, realWork);

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .activateAfterLongPress(160)
        .maxPointers(1)
        .onStart((e) => {
          const m = measure(scrollRef);
          if (m) {
            sv.originY.value = m.pageY;
            sv.viewportH.value = m.height;
          }
          const r = measure(rootRef);
          if (r) {
            sv.rootX.value = r.pageX;
            sv.rootY.value = r.pageY;
          }
          sv.dragId.value = errand.id;
          sv.dragKind.value = KIND_CHIP;
          sv.dragWork.value = drawWork;
          sv.fingerY.value = e.absoluteY;
          sv.ghostX.value = e.absoluteX;
          sv.ghostY.value = e.absoluteY;
          // Best-effort first guess; refined on the first move.
          const contentY = e.absoluteY - sv.originY.value + sv.scrollY.value;
          const clamped = snapClampMin(
            sv.winStart.value + contentY / PXPM,
            drawWork,
            sv.winStart.value,
            sv.winEnd.value,
          );
          sv.previewMin.value = clamped;
          runOnJS(cb.lift)(errand.id, 'chip', clamped, realWork);
        })
        .onUpdate((e) => {
          sv.fingerY.value = e.absoluteY;
          sv.ghostX.value = e.absoluteX;
          sv.ghostY.value = e.absoluteY;
          const contentY = e.absoluteY - sv.originY.value + sv.scrollY.value;
          const clamped = snapClampMin(
            sv.winStart.value + contentY / PXPM,
            drawWork,
            sv.winStart.value,
            sv.winEnd.value,
          );
          if (clamped !== sv.previewMin.value) {
            sv.previewMin.value = clamped;
            runOnJS(cb.preview)(clamped);
          }
          sv.autoDir.value = autoDirFor(e.absoluteY - sv.originY.value, sv.viewportH.value);
        })
        .onEnd(() => {
          const overTimeline =
            sv.fingerY.value >= sv.originY.value &&
            sv.fingerY.value <= sv.originY.value + sv.viewportH.value;
          if (overTimeline) runOnJS(cb.place)(errand.id, sv.previewMin.value);
          else runOnJS(cb.cancelDrag)();
        })
        .onFinalize(() => {
          sv.dragId.value = null;
          sv.dragKind.value = KIND_NONE;
          sv.autoDir.value = 0;
        }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [errand.id, realWork, drawWork],
  );

  return (
    <GestureDetector gesture={pan}>
      <View
        style={[
          styles.chip,
          {
            backgroundColor: t.colors.surface1,
            borderColor: t.colors.separator,
            opacity: hidden ? 0.35 : 1,
          },
        ]}
      >
        {errand.photoUrl ? (
          <Image source={{ uri: errand.photoUrl }} style={[styles.chipThumb, { backgroundColor: t.colors.fill2 }]} />
        ) : (
          <Ionicons
            name={errand.recurringId ? 'repeat' : located ? 'location' : 'ellipse-outline'}
            size={13}
            color={t.colors.textSecondary}
          />
        )}
        <Text variant="caption" weight="semibold" numberOfLines={1} style={styles.chipText}>
          {errand.title}
        </Text>
        <Text variant="micro" tone="tertiary">
          {`~${formatDuration(workMinutes(errand))}`}
        </Text>
        <Ionicons name="reorder-two" size={15} color={t.colors.textTertiary} />
      </View>
    </GestureDetector>
  );
}

/**
 * A continuous rail down the left of the plan's blocks that ties them into one
 * object (so a plan reads as a single thing, not a scatter of purple blocks),
 * capped by a tappable badge that opens the plan in the planner — the explicit
 * "this is your plan; edit it there" affordance. The rail itself is inert; only
 * the cap takes a tap, and it sits in the gutter so it never blocks a drag.
 */
function PlanSpine({
  winStart,
  topMin,
  bottomMin,
  title,
  onOpen,
}: {
  winStart: number;
  topMin: number;
  bottomMin: number;
  title?: string;
  onOpen?: () => void;
}) {
  const t = useTheme();
  const top = (topMin - winStart) * PXPM;
  const height = Math.max(2, (bottomMin - topMin) * PXPM);
  return (
    <>
      <View
        pointerEvents="none"
        style={[
          styles.planSpine,
          { top, height, backgroundColor: t.colors.highlightPurple },
        ]}
      />
      <Pressable
        onPress={onOpen}
        disabled={!onOpen}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel={
          title ? `Edit plan ${title} in the planner` : 'Edit the plan in the planner'
        }
        style={({ pressed }) => [
          styles.planCap,
          { top: Math.max(0, top - 7), backgroundColor: t.colors.highlightPurple },
          pressed && { opacity: 0.7 },
        ]}
      >
        <Ionicons name="sparkles" size={9} color={t.colors.textOnAccent} />
      </Pressable>
    </>
  );
}

/** The card that rides under the finger while a tray chip is being dragged up. */
function ChipGhost({ sv, title }: { sv: DragSV; title: string }) {
  const t = useTheme();
  const style = useAnimatedStyle(() => ({
    transform: [
      { translateX: sv.ghostX.value - sv.rootX.value - 70 },
      { translateY: sv.ghostY.value - sv.rootY.value - 22 },
    ],
  }));
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.ghost,
        { backgroundColor: t.colors.accent, shadowColor: t.colors.shadow },
        style,
      ]}
    >
      <Ionicons name="time" size={13} color={t.colors.textOnAccent} />
      <Text variant="caption" weight="bold" numberOfLines={1} style={{ color: t.colors.textOnAccent }}>
        {title}
      </Text>
    </Animated.View>
  );
}

/**
 * The contextual action bar for a tapped, editable block — its identity + time
 * and a Delete. Shared by errand edit and plan focus; `accent` flags a plan stop
 * so it reads as "your plan" rather than a loose errand.
 */
function SelectedBar({
  title,
  subtitle,
  accent,
  onClose,
  onDelete,
}: {
  title: string;
  subtitle: string;
  accent?: boolean;
  onClose: () => void;
  onDelete: () => void;
}) {
  const t = useTheme();
  return (
    <View
      style={[
        styles.selBar,
        { borderTopColor: t.colors.separator, backgroundColor: t.colors.surface1 },
      ]}
    >
      <Pressable
        onPress={onClose}
        hitSlop={8}
        style={[styles.selClose, { backgroundColor: t.colors.fill1 }]}
        accessibilityLabel="Done editing this block"
      >
        <Ionicons name="close" size={15} color={t.colors.textSecondary} />
      </Pressable>
      <View style={styles.selInfo}>
        <View style={styles.selTitleRow}>
          {accent ? (
            <Ionicons name="sparkles" size={11} color={t.colors.highlightPurple} />
          ) : null}
          <Text variant="caption" weight="bold" numberOfLines={1} style={styles.selTitle}>
            {title}
          </Text>
        </View>
        <Text variant="micro" tone="tertiary" numberOfLines={1}>
          {subtitle}
        </Text>
      </View>
      <Pressable
        onPress={onDelete}
        hitSlop={6}
        style={({ pressed }) => [
          styles.selDelete,
          { backgroundColor: t.colors.dangerSoft },
          pressed && { opacity: 0.7 },
        ]}
        accessibilityRole="button"
        accessibilityLabel={`Delete ${title}`}
      >
        <Ionicons name="trash-outline" size={15} color={t.colors.danger} />
        <Text variant="micro" weight="bold" style={{ color: t.colors.danger }}>
          Delete
        </Text>
      </Pressable>
    </View>
  );
}

/**
 * The bottom chrome while a plan is in focus. Edits are STAGED, so this mirrors
 * the errand-edit bar: a routing spinner + "Add stop", then a persistent
 * Cancel (the permanent revert — discards every staged change) and Confirm (the
 * only thing that writes the plan). Confirm enables once something's changed.
 */
function FocusBar({
  title,
  busy,
  dirty,
  onAddStop,
  onConfirm,
  onCancel,
  bottomInset,
}: {
  title?: string;
  busy?: boolean;
  dirty?: boolean;
  onAddStop?: () => void;
  onConfirm?: () => void;
  onCancel?: () => void;
  bottomInset: number;
}) {
  const t = useTheme();
  return (
    <>
      <View
        style={[
          styles.focusHead,
          { backgroundColor: t.colors.surface1, borderTopColor: t.colors.separator },
        ]}
      >
        <View style={styles.focusInfo}>
          {busy ? (
            <ActivityIndicator size="small" color={t.colors.highlightPurple} />
          ) : (
            <Ionicons name="sparkles" size={15} color={t.colors.highlightPurple} />
          )}
          <View style={styles.focusInfoText}>
            <Text variant="micro" uppercase weight="bold" tone="tertiary" style={styles.focusKicker}>
              {busy ? 'Re-routing…' : 'Editing plan'}
            </Text>
            {title ? (
              <Text variant="caption" weight="bold" numberOfLines={1}>
                {title}
              </Text>
            ) : null}
          </View>
        </View>
        <Pressable
          onPress={onAddStop}
          disabled={!onAddStop}
          hitSlop={6}
          style={({ pressed }) => [
            styles.addBtn,
            { backgroundColor: t.colors.accentSoft },
            pressed && { opacity: 0.7 },
          ]}
          accessibilityRole="button"
          accessibilityLabel="Add a stop to the plan"
        >
          <Ionicons name="add" size={15} color={t.colors.accentText} />
          <Text variant="micro" weight="bold" style={{ color: t.colors.accentText }}>
            Add stop
          </Text>
        </Pressable>
      </View>
      <View
        style={[
          styles.bar,
          {
            borderTopColor: t.colors.separator,
            backgroundColor: t.colors.background,
            paddingBottom: Math.max(10, bottomInset),
          },
        ]}
      >
        <Pressable
          onPress={onCancel}
          style={({ pressed }) => [
            styles.barBtn,
            { backgroundColor: t.colors.fill1 },
            pressed && { opacity: 0.7 },
          ]}
          accessibilityRole="button"
          accessibilityLabel="Discard plan changes"
        >
          <Text variant="bodySm" weight="semibold">
            {dirty ? 'Revert' : 'Cancel'}
          </Text>
        </Pressable>
        <Pressable
          onPress={onConfirm}
          disabled={!dirty}
          style={({ pressed }) => [
            styles.barBtn,
            styles.barConfirm,
            { backgroundColor: dirty ? t.colors.accent : t.colors.fill1 },
            pressed && { opacity: 0.85 },
          ]}
          accessibilityRole="button"
          accessibilityState={{ disabled: !dirty }}
          accessibilityLabel="Confirm plan changes"
        >
          <Ionicons
            name="checkmark"
            size={17}
            color={dirty ? t.colors.textOnAccent : t.colors.textTertiary}
          />
          <Text
            variant="bodySm"
            weight="bold"
            style={{ color: dirty ? t.colors.textOnAccent : t.colors.textTertiary }}
          >
            Confirm
          </Text>
        </Pressable>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  canvas: {
    flex: 1,
    paddingHorizontal: 16,
  },
  hourLine: {
    position: 'absolute',
    left: GUTTER_W,
    right: 0,
    height: StyleSheet.hairlineWidth,
  },
  hourLabel: {
    position: 'absolute',
    left: 0,
    width: GUTTER_W - 12,
    textAlign: 'right',
    fontVariant: ['tabular-nums'],
  },
  band: {
    position: 'absolute',
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderStyle: 'dashed',
    paddingHorizontal: 8,
    paddingTop: 4,
    justifyContent: 'flex-start',
  },
  bandLabel: {
    opacity: 0.9,
  },
  commuteLine: {
    position: 'absolute',
    width: 0,
    borderLeftWidth: 1.5,
    borderStyle: 'dotted',
  },
  commutePill: {
    position: 'absolute',
    left: GUTTER_W + 2,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 6,
    height: 20,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    zIndex: 4,
  },
  dropOutline: {
    position: 'absolute',
    top: 0,
    borderRadius: 10,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    paddingHorizontal: 8,
    paddingVertical: 3,
    justifyContent: 'center',
    zIndex: 5,
  },
  dropLabel: {
    position: 'absolute',
    left: 0,
    top: 0,
    width: GUTTER_W - 12,
    alignItems: 'flex-end',
  },
  block: {
    position: 'absolute',
    borderRadius: 10,
    overflow: 'hidden',
    shadowOffset: { width: 0, height: 6 },
    shadowRadius: 12,
    shadowOpacity: 0,
  },
  dimmed: {
    opacity: 0.4,
  },
  blockInner: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  blockBar: {
    width: 3,
    alignSelf: 'stretch',
  },
  blockBody: {
    flex: 1,
    paddingVertical: 3,
    paddingHorizontal: 8,
    gap: 1,
  },
  blockTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  blockTitle: {
    flexShrink: 1,
  },
  tray: {
    paddingTop: 10,
    paddingBottom: 6,
    paddingHorizontal: 16,
    gap: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  trayHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  trayHeadText: {
    letterSpacing: 1.1,
  },
  trayChips: {
    gap: 8,
    paddingRight: 8,
    paddingBottom: 2,
  },
  trayEmpty: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 6,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    maxWidth: 220,
  },
  chipThumb: {
    width: 22,
    height: 22,
    borderRadius: 7,
    marginLeft: -4,
  },
  chipText: {
    flexShrink: 1,
  },
  bar: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  barBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    height: 46,
    borderRadius: 14,
  },
  barConfirm: {
    flex: 1.4,
  },
  ghost: {
    position: 'absolute',
    top: 0,
    left: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    maxWidth: 180,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 999,
    shadowOffset: { width: 0, height: 8 },
    shadowRadius: 16,
    shadowOpacity: 0.3,
    elevation: 12,
    zIndex: 1000,
  },
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 10,
    height: 26,
    borderRadius: 13,
  },
  grip: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 1,
    height: 11,
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingBottom: 2,
  },
  planSpine: {
    position: 'absolute',
    left: GUTTER_W - 11,
    width: 3,
    borderRadius: 2,
    opacity: 0.45,
    zIndex: 2,
  },
  planCap: {
    position: 'absolute',
    left: GUTTER_W - 16,
    width: 14,
    height: 14,
    borderRadius: 7,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 3,
  },
  gripBar: {
    width: 24,
    height: 3,
    borderRadius: 2,
    opacity: 0.45,
  },
  resizeLine: {
    position: 'absolute',
    left: GUTTER_W,
    right: 0,
    top: 0,
    height: 2,
    borderRadius: 1,
    opacity: 0.85,
    zIndex: 5,
  },
  nowLine: {
    position: 'absolute',
    left: GUTTER_W,
    right: 0,
    height: 1.5,
    zIndex: 4,
  },
  nowDot: {
    position: 'absolute',
    left: GUTTER_W - 4,
    width: 8,
    height: 8,
    borderRadius: 4,
    zIndex: 6,
  },
  viewEmpty: {
    position: 'absolute',
    top: 28,
    right: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  selBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  selClose: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  selInfo: {
    flex: 1,
    gap: 1,
  },
  selTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  selTitle: {
    flexShrink: 1,
  },
  selDelete: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 12,
    height: 32,
    borderRadius: 16,
  },
  focusHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  focusInfo: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  focusInfoText: {
    flexShrink: 1,
    gap: 1,
  },
  focusKicker: {
    letterSpacing: 1,
  },
});
