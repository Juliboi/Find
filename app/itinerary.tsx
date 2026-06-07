import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  type DimensionValue,
  Image,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text as RNText,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import Animated, {
  FadeIn,
  FadeInDown,
  FadeOut,
  runOnJS,
  type SharedValue,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useTheme } from '@/theme/useTheme';
import type { ThemeColors } from '@/theme/colors';
import { useHomeStore, selectEndOfDay } from '@/store/useHomeStore';
import { useSavedItineraries } from '@/store/useSavedItineraries';
import { HomePicker } from '@/components/HomePicker';
import { Card } from '@/components/Card';
import { Text } from '@/components/Text';
import { Button } from '@/components/Button';
import { TripMap, type LatLng, type TripStop } from '@/components/TripMap';
import { planItinerary, type ItineraryDebug } from '@/lib/ai/itinerary';
import { recomputeItinerary } from '@/lib/ai/recomputeItinerary';
import { requestAdjustOps } from '@/lib/ai/adjustItinerary';
import {
  applyOp,
  applyRoutedLegs,
  cascadeTimes,
  classifyReorder,
  describeOp,
  fitGapsToAnchors,
  flatten,
  opNeedsRoute,
  type CascadeConflict,
  type EditOp,
  type ReorderImpact,
} from '@/lib/itinerary/edits';
import { parseAdjustCommand } from '@/lib/itinerary/adjustCommand';
import { compactItinerary, logItineraryEdit } from '@/lib/itinerary/debugLog';
import { AdjustBar } from '@/components/AdjustBar';
import { PlaceSwapSheet } from '@/components/PlaceSwapSheet';
import { ItemActionsSheet } from '@/components/ItemActionsSheet';
import { GapActionsSheet } from '@/components/GapActionsSheet';
import { LegModeSheet } from '@/components/LegModeSheet';
import { ReorderableList, type ReorderRow } from '@/components/ReorderableList';
import {
  Itinerary,
  ItineraryItem,
  ItinerarySection,
  ItineraryPlace,
  ItineraryTravelMode,
  KIND_EMOJI,
  TimeFlexibility,
  TravelLeg,
  TravelStep,
  TravelStepMode,
} from '@/types/itinerary';
import type { SchedulerContext } from '@/lib/ai/scheduler';
import {
  addMinutes,
  currentHHMM,
  formatDuration,
  minutesOfDay,
  todayISO,
} from '@/utils/time';

/**
 * Temporarily surfaces a small Fixed / Window / Flexible label on each plan
 * block so the item's `flexibility` is visible at a glance. Flip back to
 * `false` to hide the pills again; the field stays in the data model.
 */
const SHOW_FLEX_BADGES = true;

/**
 * Dev logging verbosity for the `[day-snapshot]` dump. `false` (default) logs
 * the compact one-row-per-block view so the focused `itin-edit` edit trace
 * stays visible in Metro's scrollback. Flip to `true` only when you need the
 * raw itinerary JSON (polylines, photos, descriptions) — it's ~300 lines per
 * snapshot and will bury everything else.
 */
const SNAPSHOT_VERBOSE = false;

const SAMPLE_PROMPT =
  "It's a day trip to Olomouc and I'm starting from home at Pekařova 859/12, " +
  'Bohnice. I wake up around 6:30, get ready and have breakfast, then head ' +
  'out. I want 1–2 hours of deep work after I arrive, then meet my friend to ' +
  'sightsee the historic centre, watch the afternoon show-jumping competition, ' +
  'and find a great place for drinks before the train home.';

const SPRING = { damping: 22, stiffness: 220, mass: 0.7 };

/**
 * Geometry for the left timeline rail. Everything in the itinerary list is laid
 * out around a single continuous vertical line at `center` (measured from the
 * scroll content's left edge), with cards/text indented to `contentLeft` so the
 * rail, its glowing progress head, and the travel/free-time nodes live in the
 * gutter to their left.
 */
const RAIL = {
  /** Distance the active "playhead" sits below the top of the scroll viewport. */
  focus: 110,
  edge: 16,
  center: 24,
  track: 3,
  node: 22,
  head: 12,
  halo: 24,
  contentLeft: 44,
} as const;

/** Matches the card radius (radii.lg) so the active-glow ring hugs the card. */
const CARD_RADIUS = 18;

/** How dim a past (already-elapsed) block is rendered. */
const PAST_OPACITY = 0.4;

/**
 * The minute-of-day a block ends. Falls back to start (+duration) when no
 * explicit end is given, so the time logic still works for partial entries.
 */
function itemEndMin(it: ItineraryItem): number {
  const e = minutesOfDay(it.endTime);
  if (e != null) return e;
  const s = minutesOfDay(it.startTime);
  if (s != null) return s + (it.durationMinutes ?? 0);
  return Number.POSITIVE_INFINITY;
}

/**
 * The router appends a synthetic "Back home" block when the day ends away from
 * home. Its `startTime` is the ARRIVAL time, not a departure — the opposite of
 * a real `travel` block (a train ride where startTime is when you board). We
 * key off the explicit `arrival` flag on fresh plans, and fall back to the
 * shape (a travel item carrying a leg but no end/duration) so trips saved
 * before the flag existed still render correctly on reload.
 */
function isArrivalMarker(it: ItineraryItem): boolean {
  if (it.arrival) return true;
  return (
    it.kind === 'travel' &&
    !!it.travelFromPrev &&
    !it.endTime &&
    !it.durationMinutes
  );
}

const PLANNING_PHASES = [
  'Drafting your day…',
  'Finding the best places…',
  'Mapping your route…',
  'Polishing the details…',
];

const HOME_ID = '__home__';

// Don't flag tiny slivers as "free time" — only gaps worth noticing.
const GAP_MIN_MINUTES = 20;

// Default length for a gap the user adds by hand (between two plans, etc.).
const DEFAULT_GAP_MINUTES = 30;

const HOME_NAME_RE = /^(home|my home|house|residence)$/i;

function normalisePlaceName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .trim();
}

function haversineM(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const R = 6371000;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.latitude)) *
      Math.cos(toRad(b.latitude)) *
      Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * Mirrors the server's `scrubHomePlaces`: when a saved itinerary carries
 * a place block whose name is literally "Home" / equals the home label /
 * sits on top of the home pin, drop that place block. Catches itineraries
 * saved before the server filter existed (the ALZHEIMER-HOME photo on a
 * "Languages at home" card).
 */
function scrubHomePlacesFromSaved(
  itin: Itinerary,
  home: { latitude: number; longitude: number; label?: string } | null | undefined,
): Itinerary {
  const homeLabelNorm = home?.label ? normalisePlaceName(home.label) : '';
  const looksLikeHome = (
    name: string,
    coords?: { latitude: number; longitude: number },
  ): boolean => {
    if (HOME_NAME_RE.test(name.trim())) return true;
    if (homeLabelNorm && normalisePlaceName(name) === homeLabelNorm) return true;
    if (home && coords && haversineM(home, coords) <= 75) return true;
    return false;
  };
  let changed = false;
  const sections = itin.sections.map((section) => ({
    ...section,
    items: section.items.map((item) => {
      const p = item.place;
      if (!p?.name) return item;
      if (looksLikeHome(p.name, p.coords)) {
        changed = true;
        return { ...item, place: undefined };
      }
      return item;
    }),
  }));
  return changed ? { ...itin, sections } : itin;
}

/** Decodes a Google-encoded polyline into lat/lng points for the map line. */
function decodePolyline(encoded: string): LatLng[] {
  const points: LatLng[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < encoded.length) {
    let b: number;
    let shift = 0;
    let result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    shift = 0;
    result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;
    points.push({ latitude: lat / 1e5, longitude: lng / 1e5 });
  }
  return points;
}

/**
 * Builds a compact natural-language description of the current day for the AI
 * re-plan path. Prefers the user's original prompt; otherwise reconstructs the
 * gist from the itinerary so a saved plan (no prompt on hand) can still be
 * adjusted contextually rather than re-planned from nothing.
 */
function describeItineraryForReplan(itin: Itinerary, originalPrompt?: string): string {
  if (originalPrompt && originalPrompt.trim() && originalPrompt.trim() !== SAMPLE_PROMPT) {
    return `My current plan: ${originalPrompt.trim()}`;
  }
  const lines = itin.sections.flatMap((s) =>
    s.items.map((it) => {
      const time = it.startTime ? `${it.startTime}${it.endTime ? `–${it.endTime}` : ''} ` : '';
      const where = it.place?.name ? ` at ${it.place.name}` : '';
      return `- ${time}${it.title}${where}`;
    }),
  );
  const head = `Here is my planned day "${itin.title}"${
    itin.origin ? ` starting from ${itin.origin}` : ''
  }${itin.city ? ` in ${itin.city}` : ''}:`;
  return `${head}\n${lines.join('\n')}`;
}

export default function ItineraryScreen() {
  const router = useRouter();
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { height: screenH } = useWindowDimensions();

  const home = useHomeStore((s) => s.home);
  const endOfDay = useHomeStore((s) => selectEndOfDay(s));
  const saveItinerary = useSavedItineraries((s) => s.save);
  const updateSavedItinerary = useSavedItineraries((s) => s.update);

  // Opening a saved plan from the homepage: hydrate it (once) so the screen
  // shows the preview straight away with the drawer already collapsed.
  // We also defensively scrub "Home"-looking place blocks (the
  // ALZHEIMER-HOME / Sevt-Inc doppelgängers an earlier build let through)
  // so old saves heal themselves on the next open instead of carrying that
  // stale enrichment forever.
  const params = useLocalSearchParams<{ id?: string }>();
  const preloaded = useMemo(() => {
    if (!params.id) return null;
    const saved = useSavedItineraries
      .getState()
      .items.find((i) => i.id === params.id)?.itinerary;
    if (!saved) return null;
    return scrubHomePlacesFromSaved(saved, home);
  }, [params.id, home]);

  const [input, setInput] = useState(SAMPLE_PROMPT);
  const [itinerary, setItinerary] = useState<Itinerary | null>(preloaded);
  const [usedAi, setUsedAi] = useState(!!preloaded);
  // `loading` covers the BLOCKING planning call only — while it's true the
  // screen shows the planning skeleton. `routesRefining` is for the silent
  // routing pass that happens AFTER the plan lands or when an existing
  // saved trip auto-heals: the day is already visible, and we only flash a
  // subtle pill to hint that times may shift in a beat.
  const [loading, setLoading] = useState(false);
  const [routesRefining, setRoutesRefining] = useState(false);
  // Tracks the saved-store id for the currently-shown itinerary. Populated
  // when opening a saved trip OR when a fresh plan lands. The recompute call
  // uses it to overwrite the same saved entry with the routed version instead
  // of spawning a duplicate.
  const [savedId, setSavedId] = useState<string | null>(params.id ?? null);
  // Monotonic plan/refresh sequence. Bumped on every fresh plan and on
  // reset(); a routing recompute that resolves AFTER a newer plan was kicked
  // off is dropped, so a slow refresh can't overwrite a newer itinerary.
  const planSeqRef = useRef(0);
  const [debug, setDebug] = useState<ItineraryDebug | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [showDebug, setShowDebug] = useState(false);
  const [activeSectionIndex, setActiveSectionIndex] = useState(0);
  const [activeStopId, setActiveStopId] = useState<string | null>(null);
  // Current wall-clock time (minutes since midnight). Drives the time-based
  // progress fill, the glowing "now / next" card, and greying-out of the past.
  const [nowMin, setNowMin] = useState(() => minutesOfDay(currentHHMM()) ?? 0);
  const [sheetExpanded, setSheetExpanded] = useState(!preloaded);
  const [phase, setPhase] = useState(0);
  // Keep the home anchor collapsed so the prompt field leads (and isn't pushed
  // under the keyboard). Auto-expand only when there's no home set yet.
  const [homeExpanded, setHomeExpanded] = useState(!home);

  // --- live editing state ---------------------------------------------------
  // True while an edit is being applied (route refresh / AI re-plan in flight).
  const [editBusy, setEditBusy] = useState(false);
  // The block whose venue the user is browsing alternatives for (place swap).
  const [swapItem, setSwapItem] = useState<ItineraryItem | null>(null);
  // Conflicts surfaced by the last cascade — e.g. an edit pushed past a fixed
  // anchor. Rendered as a non-blocking banner; user picks how to resolve.
  const [conflicts, setConflicts] = useState<CascadeConflict[]>([]);
  // One-tap undo: snapshot of the itinerary before the last edit + a label.
  const [undo, setUndo] = useState<{ itinerary: Itinerary; label: string } | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Monotonically incremented for every edit; recompute responses that arrive
  // after a newer edit was dispatched are dropped instead of clobbering it.
  const editSeqRef = useRef(0);
  // Items the user has explicitly opened a quick-action menu on. Independent
  // of "now/next" so any card can be tweaked.
  const [menuItemId, setMenuItemId] = useState<string | null>(null);
  // The travel leg the user tapped to change its mode.
  const [legMenuId, setLegMenuId] = useState<string | null>(null);
  // True while the day is in "rearrange" mode (long-press to enter).
  const [rearrangeMode, setRearrangeMode] = useState(false);
  // Live "what will this move cost" readout while a row is lifted (null at rest).
  const [dragImpact, setDragImpact] = useState<ReorderImpact | null>(null);

  // Cycle the status copy while planning so the wait feels alive.
  useEffect(() => {
    if (!loading) {
      setPhase(0);
      return;
    }
    const id = setInterval(
      () => setPhase((p) => Math.min(p + 1, PLANNING_PHASES.length - 1)),
      1500,
    );
    return () => clearInterval(id);
  }, [loading]);

  // Drawer snap positions, expressed as the sheet's top edge (Y from top).
  // Collapsed rests higher up (~60% of the screen) so the list leads and the
  // map stays a compact strip up top.
  const expandedTop = insets.top + 56;
  const collapsedTop = Math.round(screenH * 0.4);
  const sheetTop = useSharedValue(preloaded ? collapsedTop : expandedTop);
  const dragStart = useSharedValue(0);

  // `timeFillY` is the rail's glowing fill height in content coordinates — the
  // y the current time maps to. `glowPulse` drives the slow neon breathing
  // applied to the playhead, the active card border, and the active node.
  const timeFillY = useSharedValue(0);
  const contentH = useSharedValue(screenH);
  const glowPulse = useSharedValue(0);
  const nowRef = useRef(nowMin);

  // A single, ever-running pulse shared by every glowing element so the whole
  // timeline breathes in sync rather than each piece animating on its own.
  useEffect(() => {
    glowPulse.value = withRepeat(withTiming(1, { duration: 1500 }), -1, true);
  }, [glowPulse]);

  const listRef = useRef<ScrollView>(null);
  const tabsRef = useRef<ScrollView>(null);
  const sectionOffsetsRef = useRef<number[]>([]);
  const itemOffsetsRef = useRef<Record<string, number>>({});
  // Each card's offset/height *within its wrapper* — combined with the wrapper
  // offset above, this gives the card's absolute top/bottom for time mapping.
  const cardRawRef = useRef<Record<string, { relY: number; h: number }>>({});
  const tabOffsetsRef = useRef<number[]>([]);

  // Memoised so it's stable across renders — effects that depend on `context`
  // (auto-refresh, log dumper) only re-fire when the underlying pins actually
  // change, not on every parent re-render.
  const context = useMemo<SchedulerContext>(
    () => ({ home, endOfDay }),
    [home, endOfDay],
  );

  // Saved trips planned BEFORE real routing existed (everything in the body
  // is `estimated: true` with no polylines) get one auto-refresh per session
  // the first time the user opens them. Heals existing broken trips like the
  // one with Petřiny ⇄ Pekařova nonsense without forcing a delete+regenerate
  // dance. Keyed by saved id so it only fires once per trip per session.
  const autoRefreshedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const id = params.id;
    if (!id || !preloaded || !home) return;
    if (autoRefreshedRef.current.has(id)) return;
    const legs: TravelLeg[] = [];
    for (const s of preloaded.sections) {
      for (const it of s.items) {
        if (it.travelFromPrev) legs.push(it.travelFromPrev);
      }
    }
    if (legs.length === 0) return;
    const allEstimated = legs.every(
      (leg) => leg.estimated === true && !leg.polyline,
    );
    if (!allEstimated) return;

    autoRefreshedRef.current.add(id);
    const seq = ++planSeqRef.current;
    // `routesRefining` instead of `loading` — the saved day is already on
    // screen and we don't want a full planning skeleton to flash over it.
    setRoutesRefining(true);
    recomputeItinerary(preloaded, context)
      .then((result) => {
        if (planSeqRef.current !== seq) return;
        if (result.refreshed) {
          setItinerary(result.itinerary);
          updateSavedItinerary(id, result.itinerary);
        }
      })
      .finally(() => {
        if (planSeqRef.current === seq) setRoutesRefining(false);
      });
  }, [params.id, preloaded, home, context, updateSavedItinerary]);

  // Dev-only snapshot dumper. Fires whenever the day loads or any edit
  // reshapes the itinerary, so you can read the structured state from Metro
  // when reporting a bug.
  //
  // It logs the COMPACT day by default (one row per block: time / flex / gap /
  // travel) — the full JSON dump (with polylines, photos, descriptions) is
  // ~300 lines per snapshot and floods Metro's scrollback, burying the focused
  // `itin-edit` trace that's the actual signal during a debugging session. Flip
  // SNAPSHOT_VERBOSE to true only when you specifically need the raw payload.
  useEffect(() => {
    if (!__DEV__ || !itinerary) return;
    const stamp = new Date().toISOString();
    console.log(`══════════ [day-snapshot] ${stamp} ══════════`);
    if (SNAPSHOT_VERBOSE) {
      console.log(
        JSON.stringify(
          { savedId: params.id ?? null, usedAi, context: { home, endOfDay }, itinerary, debug },
          null,
          2,
        ),
      );
    } else {
      console.log(
        JSON.stringify(
          {
            savedId: params.id ?? null,
            usedAi,
            home: home?.label ?? null,
            endOfDay,
            day: compactItinerary(itinerary),
          },
          null,
          2,
        ),
      );
    }
    console.log(`══════════ [day-snapshot/end] ${stamp} ══════════`);
  }, [itinerary, debug, usedAi, home, endOfDay, params.id]);

  const flatItems = useMemo(
    () => (itinerary ? itinerary.sections.flatMap((s) => s.items) : []),
    [itinerary],
  );
  const flatItemsRef = useRef(flatItems);
  flatItemsRef.current = flatItems;

  // Compact rows for the long-press drag-and-drop rearrange view. Each row also
  // carries the commute INTO it (so you can see where travel sits + how long)
  // and whether it's a pinned anchor (dragging it unpins it).
  const reorderRows = useMemo<ReorderRow[]>(
    () =>
      flatItems.map((it) => {
        const leg = it.travelFromPrev;
        const legMin = leg ? Math.round(leg.minutes) : 0;
        return {
          id: it.id,
          emoji: it.place?.emoji || KIND_EMOJI[it.kind] || '•',
          title: it.title,
          subtitle:
            it.startTime && it.endTime
              ? `${it.startTime} – ${it.endTime}`
              : it.startTime
                ? it.startTime
                : it.durationMinutes
                  ? formatDuration(it.durationMinutes)
                  : undefined,
          isGap: it.kind === 'gap',
          fixed: it.flexibility === 'fixed',
          commute:
            leg && legMin > 0
              ? {
                  icon: TRAVEL_MODE_ICON[leg.mode] ?? 'navigate',
                  label:
                    legMin < 60
                      ? `${legMin}m`
                      : `${Math.floor(legMin / 60)}h${legMin % 60 ? legMin % 60 : ''}`,
                  estimated: leg.estimated,
                }
              : undefined,
        };
      }),
    [flatItems],
  );

  // Pure, synchronous predictor the drag layer scores every drop-slot against.
  const classifyMove = useCallback(
    (orderedIds: string[]): ReorderImpact =>
      itinerary ? classifyReorder(itinerary, orderedIds) : 'free',
    [itinerary],
  );

  // Copy/color for the rearrange banner — default prompt at rest, live verdict
  // while a row is lifted.
  const bannerInfo = useMemo(() => {
    switch (dragImpact) {
      case 'free':
        return { color: t.colors.success, icon: 'checkmark-circle' as const, text: 'Reflows freely' };
      case 'reroute':
        return { color: t.colors.warning, icon: 'navigate' as const, text: 'Re-checks travel times' };
      case 'replan':
        return { color: t.colors.danger, icon: 'sparkles' as const, text: 'May need a replan' };
      default:
        return {
          color: t.colors.accent,
          icon: 'swap-vertical' as const,
          text: 'Hold & drag to reorder',
        };
    }
  }, [dragImpact, t]);

  // Item IDs that are "continuations" — the previous item in the day was at
  // the SAME venue (matched by name + rounded coords). The card render uses
  // this to suppress the duplicate place block / photo / category chip, so a
  // run like "Run to pull-up bar" → "Pull-up workout" reads as one venue
  // visited continuously instead of repeating the photo three times.
  const continuationIds = useMemo(() => {
    const ids = new Set<string>();
    const venueKey = (it: ItineraryItem): string | null => {
      const p = it.place;
      if (!p?.name) return null;
      const c = p.coords;
      const cKey = c
        ? `${c.latitude.toFixed(4)},${c.longitude.toFixed(4)}`
        : '';
      return `${p.name.toLowerCase()}|${cKey}`;
    };
    for (let i = 1; i < flatItems.length; i++) {
      const prev = venueKey(flatItems[i - 1]);
      const cur = venueKey(flatItems[i]);
      if (cur && prev && cur === prev) ids.add(flatItems[i].id);
    }
    return ids;
  }, [flatItems]);

  // The block happening now (or the next one up if we're between blocks): the
  // first whose end is still in the future. This is the one that glows.
  const nowItemId = useMemo(() => {
    for (const it of flatItems) if (itemEndMin(it) > nowMin) return it.id;
    return null;
  }, [flatItems, nowMin]);

  // Lookups keyed on the latest conflict set / open menus, so the renderer
  // doesn't have to walk the array per card.
  const conflictIds = useMemo(
    () => new Set(conflicts.map((c) => c.itemId)),
    [conflicts],
  );
  const menuItem = useMemo(
    () => (menuItemId ? flatItems.find((i) => i.id === menuItemId) ?? null : null),
    [menuItemId, flatItems],
  );
  const legMenuItem = useMemo(
    () => (legMenuId ? flatItems.find((i) => i.id === legMenuId) ?? null : null),
    [legMenuId, flatItems],
  );

  const nowSectionIndex = useMemo(() => {
    if (!itinerary || !nowItemId) return -1;
    return itinerary.sections.findIndex((s) => s.items.some((it) => it.id === nowItemId));
  }, [itinerary, nowItemId]);

  // Map the current time onto the rail by interpolating between each card's
  // measured top/bottom and its start/end time, so the glowing head sits right
  // on the block that's happening now. Reads refs only (never triggers render).
  const recomputeTimeFill = useCallback(() => {
    const anchors: { t: number; y: number }[] = [];
    for (const it of flatItemsRef.current) {
      const wrapY = itemOffsetsRef.current[it.id];
      const raw = cardRawRef.current[it.id];
      if (wrapY == null || raw == null) continue;
      const top = wrapY + raw.relY;
      const s = minutesOfDay(it.startTime);
      const e = itemEndMin(it);
      if (s != null) anchors.push({ t: s, y: top });
      if (Number.isFinite(e) && (s == null || e > s)) anchors.push({ t: e, y: top + raw.h });
    }
    if (anchors.length === 0) return;
    anchors.sort((a, b) => a.t - b.t);
    const now = nowRef.current;
    const first = anchors[0];
    const last = anchors[anchors.length - 1];
    let y = last.y;
    if (now <= first.t) y = first.y;
    else if (now < last.t) {
      for (let i = 1; i < anchors.length; i++) {
        const a = anchors[i - 1];
        const b = anchors[i];
        if (now <= b.t) {
          const f = b.t === a.t ? 1 : (now - a.t) / (b.t - a.t);
          y = a.y + f * (b.y - a.y);
          break;
        }
      }
    }
    timeFillY.value = withTiming(y, { duration: 700 });
  }, [timeFillY]);

  // Tick the clock so the progress advances on its own, in real time.
  useEffect(() => {
    if (!itinerary) return;
    const tick = () => {
      const m = minutesOfDay(currentHHMM()) ?? 0;
      nowRef.current = m;
      setNowMin(m);
      recomputeTimeFill();
    };
    tick();
    const id = setInterval(tick, 30000);
    return () => clearInterval(id);
  }, [itinerary, recomputeTimeFill]);

  // Idle "free time" between two blocks = next.start − prev.end − travel.
  // Surfacing these gaps tells the user where the day breathes (and shows
  // when a block could move earlier). Keyed by the item the gap precedes.
  const gapsById = useMemo(() => {
    const map: Record<string, number> = {};
    for (let i = 1; i < flatItems.length; i++) {
      const prev = flatItems[i - 1];
      const cur = flatItems[i];
      const prevEnd = minutesOfDay(prev.endTime) ?? minutesOfDay(prev.startTime);
      const curStart = minutesOfDay(cur.startTime);
      if (prevEnd == null || curStart == null) continue;
      const travel = Number(cur.travelFromPrev?.minutes) || 0;
      const gap = curStart - prevEnd - travel;
      if (gap >= GAP_MIN_MINUTES) map[cur.id] = gap;
    }
    return map;
  }, [flatItems]);

  // Everything the map draws: the home pin, numbered activity stops, the
  // transit stations along the way (waypoints), and the real route line
  // traced from each leg's decoded polyline.
  const mapData = useMemo(() => {
    const pins: TripStop[] = [];
    const routeCoords: LatLng[] = [];
    const seen = new Set<string>();
    const key = (c: LatLng) => `${c.latitude.toFixed(4)},${c.longitude.toFixed(4)}`;
    const addPin = (pin: TripStop) => {
      const k = key(pin);
      if (seen.has(k)) return;
      seen.add(k);
      pins.push(pin);
    };

    const homeCoord = home ? { latitude: home.latitude, longitude: home.longitude } : null;
    if (homeCoord) {
      addPin({ id: HOME_ID, kind: 'home', title: 'Home', ...homeCoord });
      routeCoords.push(homeCoord);
    }

    let n = 0;
    let wp = 0;
    for (const item of flatItems) {
      const leg = item.travelFromPrev;
      if (leg?.steps) {
        for (const st of leg.steps) {
          if (st.mode === 'walk') continue;
          if (st.fromCoords) {
            addPin({ id: `wp-${wp++}`, kind: 'waypoint', title: st.from ?? 'Stop', ...st.fromCoords });
          }
          if (st.toCoords) {
            addPin({ id: `wp-${wp++}`, kind: 'waypoint', title: st.to ?? 'Stop', ...st.toCoords });
          }
        }
      }
      if (leg?.polyline) {
        for (const c of decodePolyline(leg.polyline)) routeCoords.push(c);
      }
      const c = item.place?.coords;
      if (c) {
        const k = key(c);
        // Dedupe by coordinate: when a run of items happens at the same venue
        // (e.g. "Run to pull-up bar" + "Pull-up workout"), they collapse into
        // ONE numbered pin instead of stacking 5 invisible markers on top of
        // each other. Also skips items whose coords match the home pin so
        // "Languages at home" doesn't pin on top of Home.
        if (seen.has(k)) {
          if (!leg?.polyline) routeCoords.push(c);
          continue;
        }
        n += 1;
        seen.add(k);
        pins.push({
          id: item.id,
          kind: 'stop',
          label: n,
          title: item.title,
          latitude: c.latitude,
          longitude: c.longitude,
        });
        if (!leg?.polyline) routeCoords.push(c);
      }
    }
    return { pins, routeCoords };
  }, [flatItems, home]);

  const snapTo = (top: number) => {
    sheetTop.value = withSpring(top, SPRING);
    setSheetExpanded(top <= expandedTop + 1);
  };

  const resetTracking = () => {
    sectionOffsetsRef.current = [];
    itemOffsetsRef.current = {};
    cardRawRef.current = {};
    tabOffsetsRef.current = [];
    setActiveSectionIndex(0);
    setActiveStopId(null);
    timeFillY.value = 0;
  };

  const planIt = async () => {
    const text = input.trim();
    if (!text || loading) return;
    Haptics.selectionAsync().catch(() => undefined);
    // Anything that was already in flight is no longer relevant; bump the seq
    // so a slow recompute from a previous plan can't slot itself in after
    // this one has rendered.
    const seq = ++planSeqRef.current;
    setLoading(true);
    setErrorMsg(null);
    setSavedId(null);
    resetTracking();
    snapTo(expandedTop); // show the skeleton full-height while we work
    try {
      const result = await planItinerary(text, {
        context,
        date: todayISO(),
        debug: true,
      });
      if (planSeqRef.current !== seq) return; // user reset / planned again
      const itin = result.itinerary;
      setUsedAi(result.usedAi);
      setDebug(result.debug ?? null);
      if (!itin) {
        setItinerary(null);
        setErrorMsg('No itinerary was produced. Check the debug section.');
        return;
      }

      // OPTIMISTIC SHOW. Save and render the model output the instant Gemini
      // returns, so the user sees their day 2-5 seconds sooner. Routing then
      // runs in the BACKGROUND (no await on this code path — see below) and
      // swaps real Google Routes data into the same itinerary id when it's
      // done. The cards may shift slightly when that happens (travel stubs
      // strip, clock re-cascades) — the `routesRefining` pill hints at that.
      const id = saveItinerary(itin);
      setSavedId(id);
      setItinerary(itin);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(
        () => undefined,
      );
      // Let the day fade in expanded for a beat, then ease the drawer down
      // to reveal the mapped route — a small reveal beats a hard cut.
      setTimeout(() => snapTo(collapsedTop), 520);

      // Drop the blocking spinner now — the rest is silent. Anyone watching
      // the seq guard knows to bail if a newer plan started while we wait.
      setLoading(false);
      setRoutesRefining(true);
      void recomputeItinerary(itin, context)
        .then((refreshed) => {
          if (planSeqRef.current !== seq) return;
          if (!refreshed.refreshed) return;
          setItinerary(refreshed.itinerary);
          updateSavedItinerary(id, refreshed.itinerary);
        })
        .finally(() => {
          if (planSeqRef.current === seq) setRoutesRefining(false);
        });
    } catch (e: any) {
      if (planSeqRef.current !== seq) return;
      setErrorMsg(String(e?.message ?? e));
      setLoading(false);
    }
  };

  const reset = () => {
    // Invalidate any in-flight jobs so their resolutions are dropped instead of
    // repopulating the cleared screen: planSeqRef guards background plan/route
    // jobs, editSeqRef guards live-edit cascades.
    planSeqRef.current += 1;
    editSeqRef.current += 1;
    setItinerary(null);
    setDebug(null);
    setErrorMsg(null);
    setUsedAi(false);
    setSavedId(null);
    setRoutesRefining(false);
    setUndo(null);
    setConflicts([]);
    setReplanPrompt(null);
    setMenuItemId(null);
    setLegMenuId(null);
    setRearrangeMode(false);
    resetTracking();
    snapTo(expandedTop);
  };

  // Persist the latest itinerary to the saved store, updating in place when we
  // already have an id so the homepage card and a re-open both stay current.
  const persist = useCallback(
    (itin: Itinerary) => {
      if (savedId) {
        updateSavedItinerary(savedId, itin);
      } else {
        setSavedId(saveItinerary(itin));
      }
    },
    [savedId, saveItinerary, updateSavedItinerary],
  );

  const showUndo = useCallback((snapshot: Itinerary, label: string) => {
    setUndo({ itinerary: snapshot, label });
    if (undoTimer.current) clearTimeout(undoTimer.current);
    undoTimer.current = setTimeout(() => setUndo(null), 5000);
  }, []);

  /**
   * Resourceful escalation. When a re-routed day no longer fits a FIXED anchor
   * (the real, time-aware commutes ate ALL the downstream slack), a pure clock
   * cascade can't rescue it — shrinking gaps already failed. So we hand the day
   * to the planner to genuinely rebalance it (shorten / reorder / drop), tell
   * it exactly which commitment overran and by how much, then route the result
   * for real time-aware legs before showing it. Auto-applied but fully
   * undoable: `before` is the PRE-edit day, so a single Undo rolls back the
   * edit AND the replan. `mySeq` guard drops the result if a newer edit landed.
   */
  const escalateReplan = useCallback(
    async (
      before: Itinerary,
      routed: Itinerary,
      conflicts: CascadeConflict[],
      mySeq: number,
    ) => {
      const overrun = conflicts.find((c) => c.kind === 'fixedOverrun') ?? conflicts[0];
      const blocking = overrun
        ? flatten(routed).find((i) => i.id === overrun.itemId)
        : undefined;
      const basis = describeItineraryForReplan(routed, input);
      const constraint = overrun
        ? `Important: after my latest change the day no longer fits. "${
            blocking?.title ?? 'a fixed commitment'
          }" gets pushed to ${overrun.proposedStart} but it is fixed at ${
            overrun.requiredStart
          } (about ${overrun.overrunMin} minutes too late), because the real travel time between places is longer than the free time allows. Re-plan the day so everything fits: keep the fixed commitments at their exact times, and shorten, reorder, or drop the flexible activities as needed. Keep the same overall intent of the day.`
        : 'Important: after my latest change the day no longer fits its real travel times. Re-plan it so everything fits, keeping the fixed commitments at their exact times.';
      const request = `${basis}\n\n${constraint}`;

      const result = await planItinerary(request, {
        context,
        date: routed.date ?? todayISO(),
      });
      if (mySeq !== editSeqRef.current) return;
      if (!result.itinerary) return;

      // Route the fresh plan for real (time-aware) legs before it lands, then
      // re-cascade on the client (keeping the planner's anchors authoritative).
      const { itinerary: rerouted } = await recomputeItinerary(result.itinerary, context);
      if (mySeq !== editSeqRef.current) return;
      const cascaded = fitGapsToAnchors(applyRoutedLegs(result.itinerary, rerouted));
      setItinerary(cascaded.itinerary);
      setConflicts(cascaded.conflicts);
      setUsedAi(result.usedAi);
      persist(cascaded.itinerary);
      logItineraryEdit({
        phase: 'replan',
        before,
        after: cascaded.itinerary,
        conflicts: cascaded.conflicts,
        note: 'escalated replan — re-routed commutes did not fit the fixed anchors',
      });
      showUndo(before, 'Replanned around the longer commute');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(
        () => undefined,
      );
    },
    [context, input, persist, showUndo],
  );

  /**
   * The single edit pipeline used by every editing surface. Each op is
   * applied optimistically (instant time cascade), any constraint violations
   * (fixed-anchor overruns, window overruns) are surfaced as conflicts, and
   * — only when at least one op moved a place or changed the stop sequence —
   * we make ONE backend recompute call at the end so an AI-suggested batch
   * (e.g. "swap lunch + reorder + drop the museum") doesn't trigger three
   * separate route refreshes. A monotonic `editSeq` token guards against late
   * recompute responses overwriting a newer edit. Persists + offers undo.
   */
  const applyOps = useCallback(
    async (ops: EditOp[]) => {
      if (!itinerary || ops.length === 0) return;
      const before = itinerary;
      const mySeq = ++editSeqRef.current;
      let current = itinerary;
      let needsRoute = false;
      for (const op of ops) {
        const { itinerary: next } = applyOp(current, op);
        current = next;
        if (opNeedsRoute(op)) needsRoute = true;
      }
      // Final pass: shrink elastic gaps so no fixed anchor (sleep, a meeting)
      // is overrun. Duration edits already absorbed their delta, so this is a
      // no-op for them; for structural edits it keeps the day's end honest
      // before the backend even responds.
      const fitted = fitGapsToAnchors(current);
      current = fitted.itinerary;
      const allConflicts = fitted.conflicts;
      setItinerary(current);
      setConflicts(allConflicts);
      persist(current);
      // Structured trace of the INSTANT result: the op(s), the before→after
      // delta (who moved / got re-timed / clashed), and the full compact day.
      logItineraryEdit({
        phase: 'optimistic',
        ops,
        before,
        after: current,
        conflicts: allConflicts,
        needsRoute,
      });
      // Undo always rolls back to the state BEFORE the whole batch, so AI
      // edits feel atomic from the user's POV.
      const label =
        ops.length === 1 ? describeOp(before, ops[0]) : `Applied ${ops.length} changes`;
      showUndo(before, label);
      Haptics.selectionAsync().catch(() => undefined);

      if (!needsRoute) return;

      const optimistic = current;
      setEditBusy(true);
      try {
        const { itinerary: refreshed, refreshed: didRefresh } = await recomputeItinerary(
          current,
          context,
        );
        // Drop the response if a newer edit has been dispatched in the
        // meantime; otherwise we'd silently undo the user's latest tweak.
        if (mySeq !== editSeqRef.current) {
          logItineraryEdit({
            phase: 'route-skipped',
            after: optimistic,
            note: 'superseded by a newer edit before the backend responded',
          });
          return;
        }
        // Keep the server's fresh legs + structure but restore the client's
        // anchors/durations/gaps (the server cascade slides fixed anchors to
        // force a fit, which would hide the overrun); then re-fit gaps around
        // the real travel so the day's end anchor stays honest.
        const merged = applyRoutedLegs(optimistic, refreshed);
        const cascaded = fitGapsToAnchors(merged);
        // Decision point ("reroute if there's slack, else replan"): if the
        // real, time-aware commutes still overrun a FIXED anchor after gaps
        // were shrunk, the day genuinely doesn't fit — hand it to the planner.
        // We only escalate when the backend actually re-routed (`didRefresh`);
        // otherwise the overrun is just the optimistic estimate and we keep the
        // existing non-blocking conflict banner.
        const hardOverrun = cascaded.conflicts.some((c) => c.kind === 'fixedOverrun');
        if (didRefresh && hardOverrun) {
          logItineraryEdit({
            phase: 'after-route',
            before: optimistic,
            after: cascaded.itinerary,
            conflicts: cascaded.conflicts,
            note: 'fixed-anchor overrun after reroute -> escalating to a planner rebalance',
          });
          await escalateReplan(before, cascaded.itinerary, cascaded.conflicts, mySeq);
          return;
        }
        setItinerary(cascaded.itinerary);
        setConflicts(cascaded.conflicts);
        persist(cascaded.itinerary);
        // Diff against the OPTIMISTIC state so the trace shows exactly what the
        // backend touched — an empty `travelChanged` here is the smoking gun
        // when "the commute didn't update" after a reorder/swap.
        logItineraryEdit({
          phase: didRefresh ? 'after-route' : 'route-skipped',
          before: optimistic,
          after: cascaded.itinerary,
          conflicts: cascaded.conflicts,
          note: didRefresh
            ? undefined
            : 'backend returned no refresh (routing disabled / unconfigured / failed) — legs kept their optimistic estimate',
        });
      } finally {
        if (mySeq === editSeqRef.current) setEditBusy(false);
      }
    },
    [itinerary, persist, showUndo, context, escalateReplan],
  );
  /** Convenience: most callers only have one op. */
  const applyEdit = useCallback((op: EditOp) => applyOps([op]), [applyOps]);

  /**
   * The "replan from scratch" escape hatch: an explicit user choice (chip in
   * the AdjustBar) when the local parser couldn't confidently match the input.
   * Replaces the whole itinerary via the full planner — drops gap snapshots
   * and any in-place edits, on purpose, because the user asked for a redo.
   */
  const runReplan = useCallback(
    async (text: string) => {
      if (!itinerary) return;
      const before = itinerary;
      const mySeq = ++editSeqRef.current;
      setEditBusy(true);
      Haptics.selectionAsync().catch(() => undefined);
      try {
        const basis = describeItineraryForReplan(itinerary, input);
        const request = `${basis}\n\nAdjustment requested: ${text}`;
        const result = await planItinerary(request, { context, date: todayISO() });
        if (mySeq !== editSeqRef.current) return;
        if (result.itinerary) {
          const cascaded = cascadeTimes(result.itinerary);
          setItinerary(cascaded.itinerary);
          setConflicts(cascaded.conflicts);
          setUsedAi(result.usedAi);
          persist(cascaded.itinerary);
          logItineraryEdit({
            phase: 'replan',
            before,
            after: cascaded.itinerary,
            conflicts: cascaded.conflicts,
            note: `full replan from prompt: ${text}`,
          });
          showUndo(before, 'Updated your day');
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(
            () => undefined,
          );
        }
      } finally {
        if (mySeq === editSeqRef.current) setEditBusy(false);
      }
    },
    [itinerary, input, context, persist, showUndo],
  );

  // Free-text adjustments — three-stage funnel:
  //   1. Confident local parse  → applyEdit immediately (zero latency).
  //   2. Ambiguous              → ask the AI op-resolver for a small batch of
  //                               ops; apply them through the same pipeline.
  //   3. AI returns nothing     → surface an explicit "Ask the planner →"
  //                               chip; full replan only happens if the user
  //                               taps it (so manual edits don't get nuked).
  const [replanPrompt, setReplanPrompt] = useState<string | null>(null);
  const submitAdjust = useCallback(
    async (text: string) => {
      if (!itinerary) return;
      const parsed = parseAdjustCommand(itinerary, text);
      if (parsed.kind === 'empty') return;
      if (parsed.kind === 'op') {
        await applyEdit(parsed.op);
        return;
      }
      setEditBusy(true);
      try {
        const result = await requestAdjustOps(itinerary, text);
        if (result.ops.length > 0) {
          await applyOps(result.ops);
          return;
        }
        // The AI couldn't translate this into ops (or the backend isn't
        // configured). Hand off to the explicit replan chip — never silently
        // rewrite the whole day.
        setReplanPrompt(text);
      } finally {
        setEditBusy(false);
      }
    },
    [itinerary, applyEdit, applyOps],
  );

  const confirmReplan = useCallback(async () => {
    const text = replanPrompt;
    if (!text) return;
    setReplanPrompt(null);
    await runReplan(text);
  }, [replanPrompt, runReplan]);

  const cancelReplan = useCallback(() => setReplanPrompt(null), []);

  const doUndo = useCallback(() => {
    if (!undo) return;
    // Bumping the sequence makes any in-flight recompute response from the
    // edit we're undoing a no-op when it lands.
    editSeqRef.current += 1;
    logItineraryEdit({
      phase: 'undo',
      before: itinerary,
      after: undo.itinerary,
      note: `rolled back: ${undo.label}`,
    });
    setItinerary(undo.itinerary);
    setConflicts([]);
    persist(undo.itinerary);
    setUndo(null);
    if (undoTimer.current) clearTimeout(undoTimer.current);
    Haptics.selectionAsync().catch(() => undefined);
  }, [undo, itinerary, persist]);

  // Long-press on a card -> enter rearrange mode. We don't ship a true
  // drag-and-drop (Reanimated 4 + a nested scroll view is fiddly to get right
  // and adds a dep); instead each card sprouts up/down arrows and the user
  // taps to shuffle. Works great for ~5-12 blocks, which is what a day is.
  const enterRearrange = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
    setDragImpact(null);
    setRearrangeMode(true);
  }, []);
  const exitRearrange = useCallback(() => {
    Haptics.selectionAsync().catch(() => undefined);
    setDragImpact(null);
    setRearrangeMode(false);
  }, []);
  // Drop a fresh free-time gap into the day. `beforeId` fills the slack in
  // front of a block (tapping the "free" connector); `afterId` slots one in
  // right behind a block ("add free time after this"). `minutes` defaults to
  // the slack being filled, or DEFAULT_GAP_MINUTES when there's none to absorb.
  const addGap = useCallback(
    (opts: { afterId?: string; beforeId?: string; minutes?: number }) => {
      applyEdit({
        type: 'insertGap',
        afterId: opts.afterId ?? null,
        beforeId: opts.beforeId ?? null,
        minutes: opts.minutes && opts.minutes > 0 ? opts.minutes : DEFAULT_GAP_MINUTES,
      });
    },
    [applyEdit],
  );

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (!itinerary) return;
    const probe = e.nativeEvent.contentOffset.y + RAIL.focus;

    let sec = 0;
    for (let i = 0; i < itinerary.sections.length; i++) {
      const off = sectionOffsetsRef.current[i];
      if (off == null) continue;
      if (off <= probe) sec = i;
      else break;
    }
    if (sec !== activeSectionIndex) {
      setActiveSectionIndex(sec);
      scrollTabsTo(sec);
      Haptics.selectionAsync().catch(() => undefined);
    }

    // Track which anchor is in view: a located stop focuses its own pin; any
    // placeless block (the at-home morning, cooking after the walk, the evening
    // wind-down, the "Back home" arrival) focuses the home pin — so the map
    // follows you back home exactly when the cards do.
    let stopId: string | null = home ? HOME_ID : null;
    for (const item of flatItems) {
      const off = itemOffsetsRef.current[item.id];
      if (off == null || off > probe) continue;
      stopId = item.place?.coords ? item.id : home ? HOME_ID : stopId;
    }
    if (stopId !== activeStopId) setActiveStopId(stopId);
  };

  const scrollTabsTo = (i: number) => {
    const x = tabOffsetsRef.current[i];
    if (x != null) tabsRef.current?.scrollTo({ x: Math.max(x - 16, 0), animated: true });
  };

  const goToSection = (i: number) => {
    Haptics.selectionAsync().catch(() => undefined);
    setActiveSectionIndex(i);
    scrollTabsTo(i);
    snapTo(expandedTop);
    const y = sectionOffsetsRef.current[i] ?? 0;
    listRef.current?.scrollTo({ y: Math.max(y - 12, 0), animated: true });
  };

  const goToStop = (id: string) => {
    if (id === HOME_ID) {
      setActiveStopId(HOME_ID);
      if (sheetTop.value > collapsedTop) snapTo(collapsedTop);
      listRef.current?.scrollTo({ y: 0, animated: true });
      return;
    }
    const y = itemOffsetsRef.current[id];
    if (y != null) {
      setActiveStopId(id);
      if (sheetTop.value > collapsedTop) snapTo(collapsedTop);
      listRef.current?.scrollTo({ y: Math.max(y - 12, 0), animated: true });
    }
  };

  const pan = Gesture.Pan()
    // Only claim vertical drags, and bail on horizontal ones so the tab
    // strip can still scroll sideways and tabs stay tappable.
    .activeOffsetY([-12, 12])
    .failOffsetX([-20, 20])
    .onStart(() => {
      dragStart.value = sheetTop.value;
    })
    .onUpdate((e) => {
      const next = dragStart.value + e.translationY;
      sheetTop.value = Math.min(Math.max(next, expandedTop), collapsedTop);
    })
    .onEnd((e) => {
      const mid = (expandedTop + collapsedTop) / 2;
      const projected = sheetTop.value + e.velocityY * 0.12;
      const target = projected < mid ? expandedTop : collapsedTop;
      sheetTop.value = withSpring(target, SPRING);
      runOnJS(setSheetExpanded)(target === expandedTop);
    });

  const sheetStyle = useAnimatedStyle(() => ({ height: screenH - sheetTop.value }));

  const sections = itinerary?.sections ?? [];

  // The rail only makes sense once a real plan is on screen (not while the
  // prompt form or the loading skeleton is showing).
  const showRail = !!itinerary && !loading;

  // Expanded → the general AI trip title; collapsed → the section you're on
  // (so peeking at the drawer tells you where you are as you scroll).
  const headerTitle = loading
    ? 'Planning your day'
    : !itinerary
    ? 'Plan your day'
    : sheetExpanded
    ? itinerary.title
    : sections[activeSectionIndex]?.title ?? itinerary.title;

  return (
    <View style={[styles.container, { backgroundColor: t.colors.background }]}>
      <TripMap
        stops={mapData.pins}
        routeCoords={mapData.routeCoords}
        activeId={activeStopId}
        onSelectStop={goToStop}
        fallbackCenter={home ? { latitude: home.latitude, longitude: home.longitude } : null}
        bottomInset={screenH - collapsedTop}
        topInset={insets.top + 52}
      />

      <Animated.View
        style={[
          styles.sheet,
          sheetStyle,
          { backgroundColor: t.colors.surface1, borderColor: t.colors.separator },
        ]}
      >
        <GestureDetector gesture={pan}>
          <View style={styles.handleArea}>
            <View style={[styles.grabber, { backgroundColor: t.colors.separator }]} />
            <View style={styles.sheetHeader}>
              <View style={{ flex: 1 }}>
                <Text variant="micro" tone="tertiary" uppercase weight="bold">
                  {loading ? 'Planning' : 'Sandbox · v2'}
                </Text>
                <Text variant="title3" weight="bold" tight numberOfLines={1}>
                  {headerTitle}
                </Text>
                {loading ? (
                  <Animated.View key={phase} entering={FadeIn.duration(220)}>
                    <Text variant="bodySm" tone="secondary" style={{ marginTop: 2 }}>
                      {PLANNING_PHASES[phase]}
                    </Text>
                  </Animated.View>
                ) : null}
              </View>
              {loading ? (
                <ActivityIndicator color={t.colors.accent} />
              ) : routesRefining && itinerary ? (
                // Background routing is in flight — the day is already on
                // screen but real travel legs will swap in any second. Pill
                // is intentionally subtle (matches the accent badge style)
                // so it reads as a status hint, not a blocker.
                <Animated.View
                  entering={FadeIn.duration(180)}
                  exiting={FadeOut.duration(220)}
                  style={[styles.refiningPill, { backgroundColor: t.colors.accentSoft }]}
                >
                  <ActivityIndicator size="small" color={t.colors.accent} />
                  <RNText style={[styles.refiningText, { color: t.colors.accent }]}>
                    Refining routes…
                  </RNText>
                </Animated.View>
              ) : itinerary ? (
                <View
                  style={[
                    styles.badge,
                    { backgroundColor: usedAi ? t.colors.accentSoft : t.colors.fill1 },
                  ]}
                >
                  <Text
                    variant="micro"
                    weight="bold"
                    uppercase
                    tone={usedAi ? 'accent' : 'secondary'}
                    style={usedAi ? { color: t.colors.accent } : undefined}
                  >
                    {usedAi ? 'AI' : 'Sample'}
                  </Text>
                </View>
              ) : null}
            </View>

            {sections.length > 0 ? (
              <ScrollView
                ref={tabsRef}
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.tabs}
                keyboardShouldPersistTaps="handled"
              >
                {sections.map((s, i) => {
                  const active = i === activeSectionIndex;
                  return (
                    <Pressable
                      key={s.id}
                      onPress={() => goToSection(i)}
                      onLayout={(e) => {
                        tabOffsetsRef.current[i] = e.nativeEvent.layout.x;
                      }}
                      style={[
                        styles.tab,
                        {
                          backgroundColor: active ? t.colors.accentSoft : t.colors.fill1,
                        },
                      ]}
                    >
                      <RNText
                        style={[
                          styles.tabText,
                          { color: active ? t.colors.accent : t.colors.textSecondary },
                        ]}
                        numberOfLines={1}
                      >
                        {s.title}
                      </RNText>
                    </Pressable>
                  );
                })}
              </ScrollView>
            ) : null}
          </View>
        </GestureDetector>

        {rearrangeMode && itinerary && !loading ? (
          <ReorderableList
            rows={reorderRows}
            onReorder={(orderedIds) => applyEdit({ type: 'reorder', orderedIds })}
            classify={classifyMove}
            onImpact={setDragImpact}
            topInset={8}
            bottomInset={insets.bottom + 132}
          />
        ) : (
        <ScrollView
          ref={listRef}
          contentContainerStyle={{
            paddingHorizontal: showRail ? 0 : t.spacing.lg,
            paddingTop: 8,
            // Leave room for the floating adjust bar so the last card clears it.
            paddingBottom: insets.bottom + (itinerary ? 132 : 80),
          }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          onScroll={onScroll}
          onContentSizeChange={(_w, h) => {
            contentH.value = h;
          }}
          scrollEventThrottle={16}
        >
          {loading ? (
            <PlanningSkeleton />
          ) : !itinerary ? (
            <View style={{ gap: 16 }}>
              <Card padded>
                {homeExpanded ? (
                  <View style={{ gap: 12 }}>
                    <HomePicker title="Home" flat />
                    <Button
                      title="Done"
                      variant="tonal"
                      size="md"
                      onPress={() => setHomeExpanded(false)}
                    />
                  </View>
                ) : (
                  <Pressable
                    onPress={() => setHomeExpanded(true)}
                    style={({ pressed }) => [
                      styles.homeSummary,
                      pressed && { opacity: 0.6 },
                    ]}
                  >
                    <Ionicons name="location" size={18} color={t.colors.accent} />
                    <View style={{ flex: 1 }}>
                      <Text variant="caption" tone="tertiary" uppercase weight="bold">
                        Starting from
                      </Text>
                      <Text variant="bodySm" weight="semibold" numberOfLines={1}>
                        {home?.label ?? 'Tap to set your home'}
                      </Text>
                    </View>
                    <Ionicons
                      name="settings-outline"
                      size={18}
                      color={t.colors.textSecondary}
                    />
                  </Pressable>
                )}
              </Card>
              <Card padded>
           
                <TextInput
                  style={[
                    styles.input,
                    {
                      backgroundColor: t.colors.fill1,
                      color: t.colors.textPrimary,
                      borderRadius: t.radii.md,
                      marginTop: 12,
                    },
                  ]}
                  placeholder="e.g. day trip to Olomouc: deep work, meet a friend, the horses, drinks"
                  placeholderTextColor={t.colors.textTertiary}
                  value={input}
                  onChangeText={setInput}
                  multiline
                  textAlignVertical="top"
                />
                <Button
                  title="Plan my day"
                  onPress={planIt}
                  loading={loading}
                  disabled={input.trim().length === 0}
                  style={{ marginTop: 12 }}
                  fullWidth
                />
              </Card>
              {errorMsg ? (
                <Card padded style={{ borderColor: t.colors.danger, borderWidth: 1 }}>
                  <Text variant="bodySm" tone="danger">
                    {errorMsg}
                  </Text>
                </Card>
              ) : null}
            </View>
          ) : (
            <View style={styles.timeline}>
              <TimelineRail timeFillY={timeFillY} contentH={contentH} glow={glowPulse} />

              {itinerary.summary ? (
                <Text
                  variant="bodySm"
                  tone="secondary"
                  style={[styles.timelineText, { marginBottom: 2 }]}
                >
                  {itinerary.summary}
                </Text>
              ) : null}
              {itinerary.origin ? (
                <Text
                  variant="caption"
                  tone="tertiary"
                  style={[styles.timelineText, { marginTop: 4 }]}
                >
                  From {itinerary.origin}
                </Text>
              ) : null}

              {sections.map((section, si) => (
                <SectionBlock
                  key={section.id}
                  section={section}
                  first={si === 0}
                  index={si}
                  gapsById={gapsById}
                  continuationIds={continuationIds}
                  conflictIds={conflictIds}
                  glow={glowPulse}
                  nowItemId={nowItemId}
                  nowMin={nowMin}
                  sectionActive={si === nowSectionIndex}
                  sectionPast={
                    section.items.length > 0 &&
                    section.items.every((it) => itemEndMin(it) <= nowMin)
                  }
                  rearrangeMode={rearrangeMode}
                  onEnterRearrange={enterRearrange}
                  onPressPlace={(it) => setSwapItem(it)}
                  onOpenMenu={(it) => setMenuItemId(it.id)}
                  onPressLeg={(it) => setLegMenuId(it.id)}
                  onAddGap={(beforeId, minutes) => addGap({ beforeId, minutes })}
                  onSectionLayout={(y) => {
                    sectionOffsetsRef.current[si] = y;
                  }}
                  onItemLayout={(id, y) => {
                    itemOffsetsRef.current[id] = y;
                    recomputeTimeFill();
                  }}
                  onCardLayout={(id, relY, h) => {
                    cardRawRef.current[id] = { relY, h };
                    recomputeTimeFill();
                  }}
                />
              ))}

              {debug ? (
                <Card padded style={{ marginTop: 18, marginLeft: RAIL.contentLeft }}>
                  <Pressable
                    onPress={() => setShowDebug((v) => !v)}
                    style={({ pressed }) => [pressed && { opacity: 0.6 }]}
                  >
                    <View style={styles.debugHeader}>
                      <Text variant="subhead" weight="bold" tight>
                        Debug
                      </Text>
                      <Ionicons
                        name={showDebug ? 'chevron-down' : 'chevron-forward'}
                        size={18}
                        color={t.colors.textSecondary}
                      />
                    </View>
                  </Pressable>
                  {showDebug ? (
                    <View
                      style={[
                        styles.debugBox,
                        { backgroundColor: t.colors.fill1, borderRadius: t.radii.sm },
                      ]}
                    >
                      <RNText
                        style={[styles.debugText, { color: t.colors.textPrimary }]}
                        selectable
                      >
                        {JSON.stringify(debug.response, null, 2)}
                      </RNText>
                    </View>
                  ) : null}
                </Card>
              ) : null}
            </View>
          )}
        </ScrollView>
        )}
      </Animated.View>

      <View style={[styles.floatingBar, { top: insets.top + 8 }]} pointerEvents="box-none">
        <RoundButton icon="chevron-back" label="Back" onPress={() => router.back()} />
        {itinerary ? (
          <RoundButton icon="refresh" label="Reset" onPress={reset} />
        ) : null}
      </View>

      {rearrangeMode ? (
        <Animated.View
          entering={FadeInDown.duration(180)}
          style={[styles.rearrangeBanner, { top: insets.top + 8 }]}
          pointerEvents="box-none"
        >
          <View
            style={[
              styles.rearrangeChip,
              { backgroundColor: bannerInfo.color, shadowColor: bannerInfo.color },
            ]}
          >
            <Ionicons name={bannerInfo.icon} size={14} color={t.colors.textOnAccent} />
            <Text
              variant="caption"
              weight="bold"
              style={{ color: t.colors.textOnAccent }}
            >
              {bannerInfo.text}
            </Text>
            <Pressable
              onPress={exitRearrange}
              hitSlop={8}
              style={({ pressed }) => [styles.rearrangeDone, pressed && { opacity: 0.7 }]}
            >
              <Text
                variant="caption"
                weight="bold"
                style={{ color: t.colors.textOnAccent }}
              >
                Done
              </Text>
            </Pressable>
          </View>
        </Animated.View>
      ) : null}

      {undo ? (
        <Animated.View
          entering={FadeInDown.duration(200)}
          style={[
            styles.undoToast,
            {
              bottom: insets.bottom + (sheetExpanded && itinerary && !loading ? 92 : 24),
              backgroundColor: t.colors.surface2,
              borderColor: t.colors.separator,
            },
          ]}
          pointerEvents="box-none"
        >
          <Ionicons name="checkmark-circle" size={18} color={t.colors.accent} />
          <Text variant="bodySm" weight="medium" numberOfLines={1} style={{ flex: 1 }}>
            {undo.label}
          </Text>
          <Pressable onPress={doUndo} hitSlop={8}>
            <Text variant="bodySm" weight="bold" tone="accent" style={{ color: t.colors.accent }}>
              Undo
            </Text>
          </Pressable>
        </Animated.View>
      ) : null}

      {replanPrompt && itinerary && !loading && sheetExpanded ? (
        <ReplanChip
          text={replanPrompt}
          bottomInset={insets.bottom}
          onConfirm={confirmReplan}
          onDismiss={cancelReplan}
        />
      ) : conflicts.length > 0 && itinerary && !loading && sheetExpanded ? (
        <ConflictBanner
          conflicts={conflicts}
          itinerary={itinerary}
          bottomInset={insets.bottom}
          onResolve={(c) => {
            applyEdit({ type: 'moveTime', id: c.itemId, hhmm: c.proposedStart });
          }}
          onDismiss={() => setConflicts([])}
        />
      ) : null}

      <AdjustBar
        visible={!!itinerary && !loading && sheetExpanded}
        busy={editBusy}
        bottomInset={insets.bottom}
        onSubmit={submitAdjust}
      />

      <PlaceSwapSheet
        item={swapItem}
        city={itinerary?.city}
        onClose={() => setSwapItem(null)}
        onPick={(place: ItineraryPlace) => {
          const target = swapItem;
          setSwapItem(null);
          if (target) applyEdit({ type: 'replacePlace', id: target.id, place });
        }}
      />

      {/* One "..." entry point, two sheets: gaps get the gap-specific actions
          (name / resize / split), every other block gets the standard ones. */}
      <ItemActionsSheet
        item={menuItem && menuItem.kind !== 'gap' ? menuItem : null}
        onClose={() => setMenuItemId(null)}
        onAdjustDuration={(deltaMin) => {
          if (!menuItem) return;
          applyEdit({ type: 'adjustDuration', id: menuItem.id, deltaMin });
        }}
        onMoveTime={(hhmm) => {
          if (!menuItem) return;
          setMenuItemId(null);
          applyEdit({ type: 'moveTime', id: menuItem.id, hhmm });
        }}
        onSwapPlace={() => {
          if (!menuItem) return;
          setSwapItem(menuItem);
        }}
        onAddGapAfter={() => {
          if (!menuItem) return;
          setMenuItemId(null);
          addGap({ afterId: menuItem.id });
        }}
        onRemove={() => {
          if (!menuItem) return;
          applyEdit({ type: 'remove', id: menuItem.id });
        }}
      />

      <GapActionsSheet
        item={menuItem && menuItem.kind === 'gap' ? menuItem : null}
        onClose={() => setMenuItemId(null)}
        onRename={(title) => {
          if (!menuItem) return;
          applyEdit({ type: 'renameItem', id: menuItem.id, title });
        }}
        onAdjustDuration={(deltaMin) => {
          if (!menuItem) return;
          applyEdit({ type: 'adjustDuration', id: menuItem.id, deltaMin });
        }}
        onSplit={() => {
          if (!menuItem) return;
          setMenuItemId(null);
          applyEdit({ type: 'splitGap', id: menuItem.id });
        }}
        onRemove={() => {
          if (!menuItem) return;
          applyEdit({ type: 'remove', id: menuItem.id });
        }}
      />

      <LegModeSheet
        item={legMenuItem}
        onClose={() => setLegMenuId(null)}
        onPickLegMode={(mode) => {
          if (!legMenuItem) return;
          setLegMenuId(null);
          applyEdit({ type: 'setLegMode', id: legMenuItem.id, mode });
        }}
        onPickDayMode={(mode) => {
          setLegMenuId(null);
          applyEdit({ type: 'setDayTransportMode', mode });
        }}
      />
    </View>
  );
}

/**
 * One-line warning above the AdjustBar when the latest cascade couldn't
 * honour a constraint (a fixed appointment got squeezed by an earlier
 * edit, a window block fell outside its open hours). The user picks
 * between "Reschedule" (pins the item at the proposed time so the
 * conflict clears) or "Dismiss" (accept the overlap and move on).
 */
function ConflictBanner({
  conflicts,
  itinerary,
  bottomInset,
  onResolve,
  onDismiss,
}: {
  conflicts: CascadeConflict[];
  itinerary: Itinerary;
  bottomInset: number;
  onResolve: (conflict: CascadeConflict) => void;
  onDismiss: () => void;
}) {
  const t = useTheme();
  // Show the earliest unresolved conflict first; the rest get a "+N more"
  // tail so the banner never grows past a single line.
  const head = conflicts[0];
  const extra = conflicts.length - 1;
  const item = itinerary.sections
    .flatMap((s) => s.items)
    .find((i) => i.id === head.itemId);
  if (!item) return null;
  const action =
    head.kind === 'fixedOverrun'
      ? `Move ${item.title} to ${head.proposedStart}`
      : `Move ${item.title} to ${head.proposedStart}`;
  const message =
    head.kind === 'fixedOverrun'
      ? `${item.title} can't start at ${head.requiredStart} — your earlier blocks run until ${head.proposedStart}.`
      : `${item.title} would land at ${head.proposedStart}, after its ${head.requiredStart} window.`;
  return (
    <Animated.View
      entering={FadeInDown.duration(180)}
      style={[
        styles.conflictWrap,
        {
          bottom: bottomInset + 84,
          backgroundColor: t.colors.warningSoft,
          borderColor: t.colors.warning,
        },
      ]}
      pointerEvents="box-none"
    >
      <Ionicons name="warning" size={18} color={t.colors.warning} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="caption" weight="bold" style={{ color: t.colors.warning }}>
          {extra > 0 ? `Timing conflict (+${extra} more)` : 'Timing conflict'}
        </Text>
        <Text variant="caption" tone="secondary" numberOfLines={2}>
          {message}
        </Text>
      </View>
      <View style={styles.conflictActions}>
        <Pressable onPress={() => onResolve(head)} hitSlop={6}>
          <Text variant="caption" weight="bold" style={{ color: t.colors.warning }}>
            {action}
          </Text>
        </Pressable>
        <Pressable onPress={onDismiss} hitSlop={8} style={styles.conflictDismiss}>
          <Ionicons name="close" size={16} color={t.colors.textSecondary} />
        </Pressable>
      </View>
    </Animated.View>
  );
}

/**
 * "Ask the planner →" chip shown above the AdjustBar when the local parser
 * AND the lightweight op-resolver both came up empty. The user has to TAP
 * it to actually trigger a full replan, because a full replan rewrites the
 * whole day and would erase any earlier in-place edits — never the right
 * thing to do silently from a typo or a vague phrase.
 */
function ReplanChip({
  text,
  bottomInset,
  onConfirm,
  onDismiss,
}: {
  text: string;
  bottomInset: number;
  onConfirm: () => void;
  onDismiss: () => void;
}) {
  const t = useTheme();
  return (
    <Animated.View
      entering={FadeInDown.duration(180)}
      style={[
        styles.conflictWrap,
        {
          bottom: bottomInset + 84,
          backgroundColor: t.colors.accentSoft,
          borderColor: t.colors.accent,
        },
      ]}
      pointerEvents="box-none"
    >
      <Ionicons name="sparkles" size={18} color={t.colors.accent} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="caption" weight="bold" style={{ color: t.colors.accent }}>
          Need a full rewrite?
        </Text>
        <Text variant="caption" tone="secondary" numberOfLines={2}>
          {`"${text}"`}
        </Text>
      </View>
      <View style={styles.conflictActions}>
        <Pressable onPress={onConfirm} hitSlop={6}>
          <Text variant="caption" weight="bold" style={{ color: t.colors.accent }}>
            Ask the planner →
          </Text>
        </Pressable>
        <Pressable onPress={onDismiss} hitSlop={8} style={styles.conflictDismiss}>
          <Ionicons name="close" size={16} color={t.colors.textSecondary} />
        </Pressable>
      </View>
    </Animated.View>
  );
}

function RoundButton({
  icon,
  label,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
}) {
  const t = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityLabel={label}
      hitSlop={8}
      style={({ pressed }) => [
        styles.roundBtn,
        { backgroundColor: t.colors.surface1, borderColor: t.colors.separator },
        pressed && { opacity: 0.7 },
      ]}
    >
      <Ionicons name={icon} size={20} color={t.colors.textPrimary} />
    </Pressable>
  );
}

function SectionBlock({
  section,
  first,
  continuationIds,
  index,
  gapsById,
  conflictIds,
  glow,
  nowItemId,
  nowMin,
  sectionActive,
  sectionPast,
  rearrangeMode,
  onEnterRearrange,
  onPressPlace,
  onOpenMenu,
  onPressLeg,
  onAddGap,
  onSectionLayout,
  onItemLayout,
  onCardLayout,
}: {
  section: ItinerarySection;
  first: boolean;
  continuationIds: Set<string>;
  index: number;
  gapsById: Record<string, number>;
  /** Item ids the latest cascade flagged as conflicting (fixed-anchor overrun, etc.). */
  conflictIds: Set<string>;
  glow: SharedValue<number>;
  nowItemId: string | null;
  nowMin: number;
  sectionActive: boolean;
  sectionPast: boolean;
  /** True only in rearrange mode; here it just suppresses card taps (the drag
   *  view itself is rendered separately by the parent). */
  rearrangeMode: boolean;
  /** Long-press a card -> enter rearrange mode. */
  onEnterRearrange: () => void;
  onPressPlace: (item: ItineraryItem) => void;
  /** Tap the "..." on a card → open the per-card actions sheet. */
  onOpenMenu: (item: ItineraryItem) => void;
  /** Tap a travel connector → open the mode picker for that leg. */
  onPressLeg: (item: ItineraryItem) => void;
  /** Tap a "free time" connector → fill it with a named gap before that item. */
  onAddGap: (beforeId: string, minutes: number) => void;
  onSectionLayout: (y: number) => void;
  onItemLayout: (id: string, y: number) => void;
  onCardLayout: (id: string, relY: number, h: number) => void;
}) {
  const t = useTheme();
  const base = Math.min(index * 50, 150);
  return (
    <>
      <Animated.View
        entering={FadeInDown.duration(280).delay(base)}
        style={{ marginTop: first ? 12 : 20 }}
        onLayout={(e) => onSectionLayout(e.nativeEvent.layout.y)}
      >
        <View style={styles.sectionRow}>
          <SectionNode active={sectionActive} past={sectionPast} glow={glow} />
          <View style={[styles.timelineText, sectionPast && styles.pastDim]}>
            <SectionHeader period={section.period} title={section.title} active={sectionActive} />
          </View>
        </View>
      </Animated.View>
      {section.items.map((item, i) => {
        const active = item.id === nowItemId;
        const past = itemEndMin(item) <= nowMin;
        const leg = item.travelFromPrev;
        const isGapItem = item.kind === 'gap';
        // "Leave by HH:MM" semantics depend on what kind of item the leg
        // is feeding:
        //   - Normal item (meal, work, meetup, …): item.startTime is when
        //     you ARRIVE on-site, so leaveBy = startTime − leg.minutes.
        //   - Arrival marker ("Back home"): item.startTime is the ARRIVAL
        //     time too, so leaveBy = startTime − leg.minutes. Treating it as
        //     a departure (below) showed "Leave by 19:30" for a trip you
        //     actually start at 18:55 — the bug this branch fixes.
        //   - Real kind="travel" block (the train ride): item.startTime is
        //     when you DEPART (board the train), so leaveBy ≡ startTime.
        //     Subtracting the journey length from boarding time is what
        //     produced the "Leave by 06:25" for a 08:45 train.
        const leaveBy =
          leg && item.startTime
            ? item.kind === 'travel' && !isArrivalMarker(item)
              ? item.startTime
              : addMinutes(item.startTime, -leg.minutes)
            : undefined;
        return (
          <Animated.View
            key={item.id}
            entering={FadeInDown.duration(280).delay(Math.min(base + (i + 1) * 40, 360))}
            style={{ marginTop: 8 }}
            onLayout={(e) => onItemLayout(item.id, e.nativeEvent.layout.y)}
          >
            <View style={past && styles.pastDim}>
              {!isGapItem && gapsById[item.id] ? (
                <GapRow
                  minutes={gapsById[item.id]}
                  onPress={
                    rearrangeMode ? undefined : () => onAddGap(item.id, gapsById[item.id])
                  }
                />
              ) : null}
              {leg ? (
                <TravelLegRow
                  leg={leg}
                  leaveBy={leaveBy}
                  onPress={rearrangeMode ? undefined : () => onPressLeg(item)}
                />
              ) : null}
              <Pressable
                onLongPress={rearrangeMode ? undefined : onEnterRearrange}
                delayLongPress={350}
                style={styles.cardWrap}
                onLayout={(e) =>
                  onCardLayout(item.id, e.nativeEvent.layout.y, e.nativeEvent.layout.height)
                }
              >
                {isGapItem ? (
                  <GapCard
                    item={item}
                    onOpenMenu={rearrangeMode ? undefined : () => onOpenMenu(item)}
                  />
                ) : (
                  <ItemCard
                    item={item}
                    isContinuation={continuationIds.has(item.id)}
                    onPressPlace={rearrangeMode ? undefined : () => onPressPlace(item)}
                    onOpenMenu={rearrangeMode ? undefined : () => onOpenMenu(item)}
                    hasConflict={conflictIds.has(item.id)}
                  />
                )}
                {active && !rearrangeMode ? <CardGlow glow={glow} /> : null}
              </Pressable>
            </View>
          </Animated.View>
        );
      })}
    </>
  );
}

/** Shimmering placeholder shown while the day is being planned. */
function PlanningSkeleton() {
  const t = useTheme();
  const pulse = useSharedValue(0.4);
  useEffect(() => {
    pulse.value = withRepeat(withTiming(0.9, { duration: 750 }), -1, true);
  }, [pulse]);
  const pulseStyle = useAnimatedStyle(() => ({ opacity: pulse.value }));

  const bar = (w: DimensionValue, h: number, mt = 0) => (
    <Animated.View
      style={[
        { width: w, height: h, borderRadius: 7, marginTop: mt, backgroundColor: t.colors.fill1 },
        pulseStyle,
      ]}
    />
  );

  return (
    <Animated.View entering={FadeIn.duration(220)}>
      {[0, 1, 2].map((s) => (
        <View key={s} style={{ marginTop: s === 0 ? 10 : 22 }}>
          {bar(80, 9)}
          {bar('55%', 18, 6)}
          <View style={[styles.skelCard, { borderColor: t.colors.separator }]}>
            {bar(110, 11)}
            {bar('72%', 15, 10)}
            <View style={{ flexDirection: 'row', gap: 12, marginTop: 12 }}>
              <Animated.View
                style={[
                  { width: 70, height: 70, borderRadius: 12, backgroundColor: t.colors.fill1 },
                  pulseStyle,
                ]}
              />
              <View style={{ flex: 1, justifyContent: 'center' }}>
                {bar('80%', 11)}
                {bar('45%', 11, 8)}
                {bar('90%', 11, 8)}
              </View>
            </View>
          </View>
        </View>
      ))}
    </Animated.View>
  );
}

function SectionHeader({
  period,
  title,
  active,
}: {
  period?: string;
  title: string;
  active?: boolean;
}) {
  const t = useTheme();
  return (
    <View style={styles.sectionHeader}>
      {period ? (
        <Text
          variant="micro"
          tone={active ? 'accent' : 'tertiary'}
          uppercase
          weight="bold"
          style={active ? { color: t.colors.accent } : undefined}
        >
          {period}
        </Text>
      ) : null}
      <Text variant="subhead" weight="bold" tight>
        {title}
      </Text>
    </View>
  );
}

/**
 * The continuous, glowing progress line down the left of the itinerary.
 *
 * A dim full-height `track` shows the whole day; a neon `fill` grows from the
 * top down to wherever the *current time* maps onto the timeline, capped by a
 * glowing `head` (the "playhead" = now). It's anchored to the content, so the
 * marker stays glued to its time-spot as the day scrolls — and it creeps down
 * on its own as real time passes.
 */
function TimelineRail({
  timeFillY,
  contentH,
  glow,
}: {
  timeFillY: SharedValue<number>;
  contentH: SharedValue<number>;
  glow: SharedValue<number>;
}) {
  const t = useTheme();
  const trackStyle = useAnimatedStyle(() => ({ height: Math.max(contentH.value, 0) }));
  const fillStyle = useAnimatedStyle(() => {
    const h = Math.max(0, Math.min(timeFillY.value, contentH.value));
    return { height: h, shadowOpacity: 0.35 + glow.value * 0.4 };
  });
  const headStyle = useAnimatedStyle(() => ({
    opacity: 0.85 + glow.value * 0.15,
    shadowOpacity: 0.5 + glow.value * 0.5,
    transform: [{ scale: 0.92 + glow.value * 0.22 }],
  }));
  const haloStyle = useAnimatedStyle(() => ({
    opacity: 0.1 + glow.value * 0.22,
    transform: [{ scale: 0.7 + glow.value * 0.6 }],
  }));
  return (
    <View pointerEvents="none" style={styles.railContainer}>
      <Animated.View
        style={[styles.railTrack, { backgroundColor: t.colors.separator }, trackStyle]}
      />
      <Animated.View
        style={[
          styles.railFill,
          { backgroundColor: t.colors.accent, shadowColor: t.colors.accent },
          fillStyle,
        ]}
      >
        <Animated.View
          style={[styles.railHalo, { backgroundColor: t.colors.accent }, haloStyle]}
        />
        <Animated.View
          style={[
            styles.railHead,
            { backgroundColor: t.colors.accent, shadowColor: t.colors.accent },
            headStyle,
          ]}
        />
      </Animated.View>
    </View>
  );
}

/**
 * A ring node on the rail marking a section. Lights up (glowing accent ring)
 * while it's the current section, shows a filled accent dot once it's behind
 * us, and sits as a quiet hollow ring for sections still ahead.
 */
function SectionNode({
  active,
  past,
  glow,
}: {
  active: boolean;
  past?: boolean;
  glow: SharedValue<number>;
}) {
  const t = useTheme();
  const aStyle = useAnimatedStyle(() =>
    active
      ? { shadowOpacity: 0.4 + glow.value * 0.5, transform: [{ scale: 1 + glow.value * 0.1 }] }
      : { shadowOpacity: 0, transform: [{ scale: 1 }] },
  );
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.sectionNode,
        {
          backgroundColor: past && !active ? t.colors.accent : t.colors.surface1,
          borderColor: active || past ? t.colors.accent : t.colors.separator,
          shadowColor: t.colors.accent,
          opacity: past && !active ? 0.6 : 1,
        },
        aStyle,
      ]}
    />
  );
}

/** Pulsing neon ring drawn over the card the playhead is currently on. */
function CardGlow({ glow }: { glow: SharedValue<number> }) {
  const t = useTheme();
  const aStyle = useAnimatedStyle(() => ({
    opacity: 0.7 + glow.value * 0.3,
    shadowOpacity: 0.3 + glow.value * 0.45,
  }));
  return (
    <Animated.View
      pointerEvents="none"
      entering={FadeIn.duration(200)}
      style={[
        styles.cardGlow,
        { borderColor: t.colors.accent, shadowColor: t.colors.accent },
        aStyle,
      ]}
    />
  );
}

function FlexBadge({ flexibility }: { flexibility: TimeFlexibility }) {
  const t = useTheme();
  const map: Record<
    TimeFlexibility,
    { label: string; bg: string; color: string; icon: keyof typeof Ionicons.glyphMap }
  > = {
    fixed: { label: 'Fixed', bg: t.colors.warningSoft, color: t.colors.warning, icon: 'lock-closed' },
    window: { label: 'Window', bg: t.colors.infoSoft, color: t.colors.info, icon: 'time-outline' },
    flexible: {
      label: 'Flexible',
      bg: t.colors.successSoft,
      color: t.colors.success,
      icon: 'swap-vertical',
    },
  };
  const cfg = map[flexibility];
  return (
    <View style={[styles.flexBadge, { backgroundColor: cfg.bg }]}>
      <Ionicons name={cfg.icon} size={11} color={cfg.color} />
      <RNText style={[styles.flexBadgeText, { color: cfg.color }]}>{cfg.label}</RNText>
    </View>
  );
}

function OpenStatus({ status }: { status: string }) {
  const t = useTheme();
  const parts = status.split(/\s*·\s*/);
  const head = parts[0] ?? '';
  const rest = parts.slice(1).join(' · ');
  const headColor = /^\s*open\b/i.test(head)
    ? t.colors.success
    : /clos|open(s|ing)\b/i.test(head)
    ? t.colors.danger
    : t.colors.textSecondary;
  return (
    <RNText style={styles.openStatus}>
      <RNText style={{ color: headColor, fontWeight: '500' }}>{head}</RNText>
      {rest ? (
        <RNText style={{ color: t.colors.textTertiary }}>{`  ·  ${rest}`}</RNText>
      ) : null}
    </RNText>
  );
}

const TRAVEL_MODE_LABEL: Record<ItineraryTravelMode, string> = {
  walk: 'walk',
  bike: 'bike',
  transit: 'transit',
  drive: 'drive',
};

/** Ionicon for the coarse leg mode, shown as the timeline rail node. */
const TRAVEL_MODE_ICON: Record<ItineraryTravelMode, keyof typeof Ionicons.glyphMap> = {
  walk: 'walk',
  bike: 'bicycle',
  transit: 'subway',
  drive: 'car',
};

/** Ionicon per concrete transit sub-mode, shown in the per-step badge. */
const TRAVEL_STEP_ICON: Record<TravelStepMode, keyof typeof Ionicons.glyphMap> = {
  walk: 'walk',
  bus: 'bus',
  tram: 'train',
  subway: 'subway',
  train: 'train',
  ferry: 'boat',
  transit: 'navigate',
};

/** #RRGGBB -> rgba() so we can derive a soft tint for a step's icon badge. */
function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Per-mode accent drawn from OUR palette (not a transit operator's livery):
 * walk reads neutral, every ride gets a distinct-but-on-brand hue so two
 * consecutive legs are easy to tell apart at a glance.
 */
function stepStyle(mode: TravelStepMode, c: ThemeColors): { color: string; badge: string } {
  switch (mode) {
    case 'walk':
      return { color: c.textSecondary, badge: c.fill2 };
    case 'bus':
      return { color: c.warning, badge: hexToRgba(c.warning, 0.16) };
    case 'tram':
      return { color: c.highlightPurple, badge: hexToRgba(c.highlightPurple, 0.16) };
    case 'subway':
      return { color: c.accent, badge: hexToRgba(c.accent, 0.16) };
    case 'train':
      return { color: c.highlightRed, badge: hexToRgba(c.highlightRed, 0.16) };
    case 'ferry':
      return { color: c.info, badge: hexToRgba(c.info, 0.16) };
    default:
      return { color: c.accent, badge: hexToRgba(c.accent, 0.16) };
  }
}

/** Same palette treatment as `stepStyle`, keyed by the coarse leg mode. */
function legStyle(mode: ItineraryTravelMode, c: ThemeColors): { color: string; badge: string } {
  switch (mode) {
    case 'walk':
      return { color: c.textSecondary, badge: c.fill2 };
    case 'bike':
      return { color: c.success, badge: hexToRgba(c.success, 0.16) };
    case 'drive':
      return { color: c.info, badge: hexToRgba(c.info, 0.16) };
    default:
      return { color: c.accent, badge: hexToRgba(c.accent, 0.16) };
  }
}

function formatLegMinutes(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h} hr` : `${h} hr ${m} min`;
}

/** Collapse back-to-back walk steps (Google often splits them) into one. */
function mergeWalkSteps(steps: TravelStep[]): TravelStep[] {
  const out: TravelStep[] = [];
  for (const s of steps) {
    const last = out[out.length - 1];
    if (s.mode === 'walk' && last && last.mode === 'walk') {
      out[out.length - 1] = {
        ...last,
        durationMinutes: (last.durationMinutes ?? 0) + (s.durationMinutes ?? 0),
      };
    } else {
      out.push(s);
    }
  }
  return out;
}

/** A light connector marking idle/free time the user has between two blocks. */
function GapRow({ minutes, onPress }: { minutes: number; onPress?: () => void }) {
  const t = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      style={({ pressed }) => [
        styles.connRow,
        styles.connRowCenter,
        pressed && onPress && { opacity: 0.6 },
      ]}
    >
      <View style={styles.connRail} accessibilityElementsHidden>
        <View
          style={[
            styles.connDotSm,
            { backgroundColor: t.colors.surface1, borderColor: t.colors.separator },
          ]}
        >
          <RNText style={styles.connDotEmojiSm}>⏳</RNText>
        </View>
      </View>
      <View style={[styles.connBody, styles.gapRowBody]}>
        <RNText style={[styles.gapText, { color: t.colors.textTertiary }]}>
          {`${formatDuration(minutes)} free`}
        </RNText>
        {onPress ? (
          <View style={[styles.gapAddPill, { borderColor: t.colors.separator }]}>
            <Ionicons name="add" size={12} color={t.colors.accent} />
            <RNText style={[styles.gapAddText, { color: t.colors.accent }]}>Add gap</RNText>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

/**
 * A free-time GAP rendered as its own card — elastic, nameable time the user
 * owns (vs a real activity). Visually lighter than an ItemCard (dashed border,
 * muted fill) so the day's "open" stretches read as breathing room, but it
 * still carries a time range, a duration pill, and the "..." actions entry.
 */
function GapCard({
  item,
  onOpenMenu,
}: {
  item: ItineraryItem;
  onOpenMenu?: () => void;
}) {
  const t = useTheme();
  const timeRange =
    item.startTime && item.endTime
      ? `${item.startTime} – ${item.endTime}`
      : item.startTime ?? '';
  return (
    <View
      style={[
        styles.gapCard,
        { borderColor: t.colors.separator, backgroundColor: t.colors.fill1 },
      ]}
    >
      <View style={styles.itemTopRow}>
        <View style={styles.timeWrap}>
          <RNText style={styles.gapCardEmoji}>{KIND_EMOJI.gap}</RNText>
          <Text variant="caption" tone="tertiary" weight="semibold" style={styles.timeText}>
            {timeRange ? `Free · ${timeRange}` : 'Free time'}
          </Text>
        </View>
        {item.durationMinutes ? (
          <View style={[styles.durationPill, { backgroundColor: t.colors.surface1 }]}>
            <Ionicons name="time-outline" size={12} color={t.colors.textSecondary} />
            <Text variant="micro" tone="secondary" weight="semibold">
              {formatDuration(item.durationMinutes)}
            </Text>
          </View>
        ) : null}
        {onOpenMenu ? (
          <Pressable
            onPress={onOpenMenu}
            accessibilityLabel="Edit free time"
            hitSlop={10}
            style={({ pressed }) => [
              styles.menuBtn,
              { backgroundColor: t.colors.surface1 },
              pressed && { opacity: 0.6 },
            ]}
          >
            <Ionicons name="ellipsis-horizontal" size={15} color={t.colors.textSecondary} />
          </Pressable>
        ) : null}
      </View>
      <Text variant="body" weight="semibold" style={{ marginTop: 6 }}>
        {item.title}
      </Text>
    </View>
  );
}

/**
 * One ride/walk inside the commute panel, styled like a maps-app transit row:
 * a tinted mode badge on the left, the line name (or "Walk …") up top, and the
 * boarding / alighting stops with their times stacked beneath it.
 */
function CommuteStep({
  step,
  startTime,
  endTime,
  fromLabel,
  colors,
}: {
  step: TravelStep;
  /** Cascaded boarding clock, "HH:MM", when the leg's leave-by is known. */
  startTime?: string;
  /** Cascaded alighting clock, "HH:MM". */
  endTime?: string;
  /** Origin label, only for the very first (walk-from-home) step. */
  fromLabel?: string;
  colors: ThemeColors;
}) {
  const isWalk = step.mode === 'walk';
  const sc = stepStyle(step.mode, colors);
  const icon = TRAVEL_STEP_ICON[step.mode] ?? 'navigate';
  const hasStops = !isWalk && (!!step.from || !!step.to);

  // Walk title: name the origin on the first hop, else the destination.
  const walkTitle = fromLabel
    ? `Walk from ${fromLabel}`
    : step.to
      ? `Walk to ${step.to}`
      : 'Walk';
  const title = isWalk ? walkTitle : step.line ?? 'Transit';

  // Right-aligned meta on the title row: stop count when known, else duration.
  const titleMeta = isWalk
    ? step.durationMinutes
      ? formatDuration(step.durationMinutes)
      : ''
    : step.numStops
      ? `${step.numStops} ${step.numStops === 1 ? 'stop' : 'stops'}`
      : step.durationMinutes
        ? formatDuration(step.durationMinutes)
        : '';

  return (
    <View style={[styles.stepBlock, !hasStops && styles.stepBlockCenter]}>
      <View style={[styles.stepBadge, { backgroundColor: sc.badge }]}>
        <Ionicons name={icon} size={17} color={sc.color} />
      </View>
      <View style={styles.stepMain}>
        <View style={styles.stepTitleRow}>
          <RNText
            style={[
              styles.stepTitle,
              { color: isWalk ? colors.textPrimary : sc.color },
              isWalk && styles.stepTitleWalk,
            ]}
            numberOfLines={1}
          >
            {title}
          </RNText>
          {titleMeta ? (
            <RNText style={[styles.stepMeta, { color: colors.textTertiary }]}>
              {titleMeta}
            </RNText>
          ) : null}
        </View>
        {hasStops ? (
          <View style={styles.stepStops}>
            {step.from ? (
              <CommuteStop name={step.from} time={startTime} colors={colors} />
            ) : null}
            {step.to ? (
              <CommuteStop name={step.to} time={endTime} colors={colors} alight />
            ) : null}
          </View>
        ) : null}
      </View>
    </View>
  );
}

/** A single boarding/alighting stop line: hollow→filled dot, name, time. */
function CommuteStop({
  name,
  time,
  colors,
  alight,
}: {
  name: string;
  time?: string;
  colors: ThemeColors;
  alight?: boolean;
}) {
  return (
    <View style={styles.stopRow}>
      <View
        style={[
          styles.stopDot,
          {
            borderColor: colors.textTertiary,
            backgroundColor: alight ? colors.textTertiary : 'transparent',
          },
        ]}
      />
      <RNText style={[styles.stopName, { color: colors.textSecondary }]} numberOfLines={1}>
        {name}
      </RNText>
      {time ? (
        <RNText style={[styles.stopTime, { color: colors.textSecondary }]}>{time}</RNText>
      ) : null}
    </View>
  );
}

/**
 * Connector that sits BETWEEN two place cards and shows how you get from one
 * to the next, restyled as a clean "commute panel": a tinted rail node, an
 * optional "Leave by HH:MM" header, then each hop (🚶/🚌/🚇/🚆) as its own
 * row with a mode badge, line name and timed stops — maps-app style. Tap the
 * panel to swap transport modes (walk/bike/transit/drive) for this leg.
 */
function TravelLegRow({
  leg,
  leaveBy,
  onPress,
}: {
  leg: TravelLeg;
  leaveBy?: string;
  onPress?: () => void;
}) {
  const t = useTheme();
  const c = t.colors;
  const steps = leg.steps ? mergeWalkSteps(leg.steps) : [];
  const hasSteps = steps.length > 0;
  const label = TRAVEL_MODE_LABEL[leg.mode] ?? 'travel';

  // Cascade a clock across the steps from the leave-by time so every hop can
  // show realistic board/alight times. Durations don't include platform waits,
  // so these land a touch early — fine for planning, and only shown when we
  // actually have a leave-by anchor to count from.
  let clock = leaveBy;
  const stepTimes = steps.map((s) => {
    const start = clock;
    const end = clock && s.durationMinutes ? addMinutes(clock, s.durationMinutes) : clock;
    if (clock && s.durationMinutes) clock = addMinutes(clock, s.durationMinutes);
    return { start, end };
  });

  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      style={({ pressed }) => [
        styles.connRow,
        pressed && onPress && { opacity: 0.7 },
      ]}
    >
      <View style={styles.connRail} accessibilityElementsHidden>
        <View
          style={[
            styles.connDot,
            { backgroundColor: c.surface1, borderColor: c.separator },
          ]}
        >
          <Ionicons
            name={TRAVEL_MODE_ICON[leg.mode] ?? 'navigate'}
            size={13}
            color={c.textSecondary}
          />
        </View>
      </View>
      <View style={[styles.commutePanel, { backgroundColor: c.fill1 }]}>
        <View style={styles.commuteHeader}>
          {leaveBy ? (
            <>
              <Ionicons name="time-outline" size={12} color={c.accent} />
              <RNText style={[styles.commuteLeave, { color: c.accent }]}>
                {`Leave by ${leaveBy}`}
              </RNText>
              <RNText style={[styles.commuteMeta, { color: c.textTertiary }]}>
                {`  ·  ${formatLegMinutes(leg.minutes)}`}
              </RNText>
            </>
          ) : (
            <RNText style={[styles.commuteMeta, { color: c.textSecondary }]}>
              {`${formatLegMinutes(leg.minutes)} ${label}`}
            </RNText>
          )}
          {onPress ? (
            <Ionicons
              name="chevron-forward"
              size={14}
              color={c.textTertiary}
              style={styles.commuteChevron}
            />
          ) : null}
        </View>
        {hasSteps ? (
          steps.map((s, i) => (
            <CommuteStep
              key={`${i}-${s.mode}`}
              step={s}
              startTime={stepTimes[i]?.start}
              endTime={stepTimes[i]?.end}
              fromLabel={i === 0 ? leg.fromLabel : undefined}
              colors={c}
            />
          ))
        ) : (
          <CommuteFallbackStep leg={leg} label={label} colors={c} />
        )}
      </View>
    </Pressable>
  );
}

/**
 * Single-mode hop with no step breakdown (a trivial walk, or the haversine
 * fallback): one badge + a duration. Mirrors `CommuteStep`'s layout using the
 * coarse leg mode so the panel stays visually consistent.
 */
function CommuteFallbackStep({
  leg,
  label,
  colors,
}: {
  leg: TravelLeg;
  label: string;
  colors: ThemeColors;
}) {
  const lc = legStyle(leg.mode, colors);
  const isWalk = leg.mode === 'walk';
  const title = isWalk
    ? leg.fromLabel
      ? `Walk from ${leg.fromLabel}`
      : 'Walk'
    : `${label.charAt(0).toUpperCase()}${label.slice(1)}`;
  return (
    <View style={[styles.stepBlock, styles.stepBlockCenter]}>
      <View style={[styles.stepBadge, { backgroundColor: lc.badge }]}>
        <Ionicons
          name={TRAVEL_MODE_ICON[leg.mode] ?? 'navigate'}
          size={17}
          color={lc.color}
        />
      </View>
      <View style={styles.stepMain}>
        <View style={styles.stepTitleRow}>
          <RNText
            style={[
              styles.stepTitle,
              { color: isWalk ? colors.textPrimary : lc.color },
              isWalk && styles.stepTitleWalk,
            ]}
            numberOfLines={1}
          >
            {title}
          </RNText>
          <RNText style={[styles.stepMeta, { color: colors.textTertiary }]}>
            {formatLegMinutes(leg.minutes)}
          </RNText>
        </View>
        {!isWalk && leg.fromLabel ? (
          <RNText
            style={[styles.stepFromLabel, { color: colors.textTertiary }]}
            numberOfLines={1}
          >
            {`from ${leg.fromLabel}`}
          </RNText>
        ) : null}
      </View>
    </View>
  );
}

function ItemCard({
  item,
  isContinuation,
  onPressPlace,
  onOpenMenu,
  hasConflict,
}: {
  item: ItineraryItem;
  /**
   * True when the previous item was at the SAME venue. We suppress the place
   * block (photo / name / rating / open status) so the same venue card doesn't
   * repeat across consecutive items like "Run to pull-up bar" → "Pull-up
   * workout" — the title alone makes the continuity clear.
   */
  isContinuation?: boolean;
  /** Tap-handler on the place block (opens the swap-place sheet). */
  onPressPlace?: () => void;
  /** Tap-handler on the "..." menu button (opens the per-card actions sheet). */
  onOpenMenu?: () => void;
  /** Marks the card with a small warning glyph when this item has a conflict. */
  hasConflict?: boolean;
}) {
  const t = useTheme();
  const place = isContinuation ? undefined : item.place;
  const emoji = place?.emoji ?? KIND_EMOJI[item.kind];
  // Arrival markers ("Back home") carry a single time that is when you GET
  // there — prefix it so a lone "19:30" doesn't read as a departure.
  const timeRange = isArrivalMarker(item)
    ? item.startTime
      ? `Arrive ${item.startTime}`
      : ''
    : item.startTime && item.endTime
    ? `${item.startTime} – ${item.endTime}`
    : item.startTime ?? '';
  const rating = typeof place?.rating === 'number' ? place.rating : undefined;

  return (
    <Card padded>
      <View style={styles.itemTopRow}>
        <View style={styles.timeWrap}>
          {hasConflict ? (
            <Ionicons name="warning" size={13} color={t.colors.warning} />
          ) : null}
          <Text variant="caption" tone={hasConflict ? 'danger' : 'secondary'} weight="semibold" style={styles.timeText}>
            {timeRange || ' '}
          </Text>
        </View>
        {SHOW_FLEX_BADGES ? <FlexBadge flexibility={item.flexibility} /> : null}
        {item.durationMinutes ? (
          <View style={[styles.durationPill, { backgroundColor: t.colors.fill1 }]}>
            <Ionicons name="time-outline" size={12} color={t.colors.textSecondary} />
            <Text variant="micro" tone="secondary" weight="semibold">
              {formatDuration(item.durationMinutes)}
            </Text>
          </View>
        ) : null}
        {onOpenMenu ? (
          <Pressable
            onPress={onOpenMenu}
            accessibilityLabel="Edit this block"
            hitSlop={10}
            style={({ pressed }) => [
              styles.menuBtn,
              { backgroundColor: t.colors.fill1 },
              pressed && { opacity: 0.6 },
            ]}
          >
            <Ionicons name="ellipsis-horizontal" size={15} color={t.colors.textSecondary} />
          </Pressable>
        ) : null}
      </View>

      <Text variant="body" weight="semibold" style={{ marginTop: 8 }}>
        {item.title}
      </Text>

      {place ? (
        <Pressable
          onPress={onPressPlace}
          disabled={!onPressPlace}
          style={({ pressed }) => [styles.placeRow, pressed && onPressPlace && { opacity: 0.7 }]}
        >
          {place.photoUrl ? (
            <Image
              source={{ uri: place.photoUrl }}
              style={[styles.thumb, { backgroundColor: t.colors.fill1 }]}
            />
          ) : null}
          <View style={{ flex: 1, gap: 3 }}>
            <Text variant="bodySm" weight="semibold">
              {place.name}
            </Text>
            {rating !== undefined ? (
              <View style={styles.ratingRow}>
                <Text variant="caption" tone="secondary" weight="medium">
                  {rating.toFixed(1)}
                </Text>
                <Ionicons name="star" size={12} color={t.colors.highlightYellow} />
                {place.priceLevel ? (
                  <Text variant="caption" tone="secondary">{`·  ${place.priceLevel}`}</Text>
                ) : null}
              </View>
            ) : place.priceLevel ? (
              <Text variant="caption" tone="secondary">
                {place.priceLevel}
              </Text>
            ) : null}
            {place.category ? (
              <RNText style={[styles.categoryText, { color: t.colors.textSecondary }]}>
                {`${emoji}  ${place.category}`}
              </RNText>
            ) : null}
            {place.openStatus ? <OpenStatus status={place.openStatus} /> : null}
          </View>
          {onPressPlace ? (
            <View style={[styles.swapHint, { backgroundColor: t.colors.fill1 }]}>
              <Ionicons name="swap-horizontal" size={15} color={t.colors.accent} />
            </View>
          ) : null}
        </Pressable>
      ) : null}

      {item.description ? (
        <Text variant="bodySm" tone="secondary" style={{ marginTop: 10 }}>
          {item.description}
        </Text>
      ) : null}

      {item.highlights && item.highlights.length > 0 ? (
        <View style={styles.highlights}>
          {item.highlights.map((h, i) => (
            <View
              key={`${item.id}-h-${i}`}
              style={[styles.chip, { backgroundColor: t.colors.fill1 }]}
            >
              <Text variant="micro" tone="secondary" weight="medium">
                {h}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    borderTopWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOpacity: 0.18,
        shadowRadius: 16,
        shadowOffset: { width: 0, height: -4 },
      },
      android: { elevation: 16 },
    }),
  },
  handleArea: {
    paddingHorizontal: 18,
    paddingTop: 8,
    paddingBottom: 10,
  },
  grabber: {
    alignSelf: 'center',
    width: 38,
    height: 5,
    borderRadius: 3,
    marginBottom: 10,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
  },
  refiningPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
  },
  refiningText: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  tabs: {
    gap: 8,
    paddingTop: 12,
    paddingRight: 8,
  },
  tab: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    maxWidth: 200,
  },
  tabText: {
    fontSize: 13,
    fontWeight: '600',
  },
  floatingBar: {
    position: 'absolute',
    left: 16,
    right: 16,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  roundBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOpacity: 0.15,
        shadowRadius: 6,
        shadowOffset: { width: 0, height: 2 },
      },
      android: { elevation: 4 },
    }),
  },
  input: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    minHeight: 110,
  },
  homeSummary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  sectionHeader: {
    gap: 2,
  },
  itemTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    marginBottom: 2,
  },
  timeWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    flexShrink: 1,
    flexGrow: 1,
  },
  timeText: {
    fontSize: 14,
    letterSpacing: 0.3,
  },
  menuBtn: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
  durationPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 999,
  },
  placeRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    marginTop: 10,
  },
  thumb: {
    width: 72,
    height: 72,
    borderRadius: 12,
  },
  ratingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  categoryText: {
    fontSize: 14,
    fontWeight: '400',
  },
  openStatus: {
    fontSize: 13,
    fontWeight: '400',
  },
  flexBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
  },
  flexBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  highlights: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 10,
  },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
  },
  // ---- Left timeline rail ------------------------------------------------
  timeline: {
    position: 'relative',
    paddingRight: RAIL.edge,
  },
  // Everything that isn't a rail node is indented past the gutter.
  timelineText: {
    marginLeft: RAIL.contentLeft,
  },
  // Blocks whose time has already elapsed are dimmed back.
  pastDim: {
    opacity: PAST_OPACITY,
  },
  railContainer: {
    position: 'absolute',
    top: 0,
    left: RAIL.center - RAIL.node / 2,
    width: RAIL.node,
  },
  railTrack: {
    position: 'absolute',
    top: 0,
    left: (RAIL.node - RAIL.track) / 2,
    width: RAIL.track,
    borderRadius: RAIL.track / 2,
    opacity: 0.7,
  },
  railFill: {
    position: 'absolute',
    top: 0,
    left: (RAIL.node - RAIL.track) / 2,
    width: RAIL.track,
    borderRadius: RAIL.track / 2,
    shadowOffset: { width: 0, height: 0 },
    shadowRadius: 6,
  },
  railHalo: {
    position: 'absolute',
    bottom: -(RAIL.halo / 2),
    left: (RAIL.track - RAIL.halo) / 2,
    width: RAIL.halo,
    height: RAIL.halo,
    borderRadius: RAIL.halo / 2,
  },
  railHead: {
    position: 'absolute',
    bottom: -(RAIL.head / 2),
    left: (RAIL.track - RAIL.head) / 2,
    width: RAIL.head,
    height: RAIL.head,
    borderRadius: RAIL.head / 2,
    shadowOffset: { width: 0, height: 0 },
    shadowRadius: 8,
  },
  // ---- Rail nodes & active glow -----------------------------------------
  sectionRow: {
    position: 'relative',
  },
  sectionNode: {
    position: 'absolute',
    top: 3,
    left: RAIL.center - 7,
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 2,
    shadowOffset: { width: 0, height: 0 },
    shadowRadius: 8,
  },
  cardWrap: {
    marginLeft: RAIL.contentLeft,
    position: 'relative',
  },
  cardGlow: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderRadius: CARD_RADIUS,
    borderWidth: 1.5,
    shadowOffset: { width: 0, height: 0 },
    shadowRadius: 12,
  },
  swapHint: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
  },
  rearrangeBanner: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  rearrangeChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingLeft: 12,
    paddingRight: 6,
    paddingVertical: 7,
    borderRadius: 999,
    shadowOpacity: 0.3,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  rearrangeDone: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.18)',
  },
  undoToast: {
    position: 'absolute',
    left: 16,
    right: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 10,
  },
  conflictWrap: {
    position: 'absolute',
    left: 12,
    right: 12,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 16,
    borderWidth: 1,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  conflictActions: {
    alignItems: 'flex-end',
    gap: 8,
  },
  conflictDismiss: {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // ---- Connectors (travel / free time) aligned to the rail ---------------
  connRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  connRowCenter: {
    alignItems: 'center',
  },
  connRail: {
    width: RAIL.contentLeft,
  },
  connDot: {
    marginLeft: RAIL.center - 12,
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: 2,
  },
  connDotSm: {
    marginLeft: RAIL.center - 10,
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  connDotEmojiSm: {
    fontSize: 10,
  },
  connBody: {
    flex: 1,
    paddingVertical: 6,
    gap: 3,
  },
  gapText: {
    fontSize: 12.5,
    fontWeight: '500',
  },
  gapRowBody: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  gapAddPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingVertical: 3,
    paddingHorizontal: 7,
  },
  gapAddText: {
    fontSize: 11.5,
    fontWeight: '700',
  },
  gapCard: {
    borderWidth: 1,
    borderStyle: 'dashed',
    borderRadius: 16,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  gapCardEmoji: {
    fontSize: 13,
  },
  // ---- Commute panel (redesigned travel leg) ----------------------------
  commutePanel: {
    flex: 1,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 12,
    marginVertical: 3,
  },
  commuteHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  commuteLeave: {
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  commuteMeta: {
    fontSize: 12.5,
    fontWeight: '500',
  },
  commuteChevron: {
    marginLeft: 'auto',
    opacity: 0.7,
  },
  stepBlock: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 11,
  },
  stepBlockCenter: {
    alignItems: 'center',
  },
  stepBadge: {
    width: 34,
    height: 34,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepMain: {
    flex: 1,
    gap: 4,
    paddingTop: 1,
  },
  stepTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  stepTitle: {
    flex: 1,
    fontSize: 15,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  stepTitleWalk: {
    fontWeight: '600',
    letterSpacing: 0,
  },
  stepMeta: {
    fontSize: 12.5,
    fontWeight: '600',
  },
  stepStops: {
    gap: 5,
  },
  stepFromLabel: {
    fontSize: 13,
    fontWeight: '500',
  },
  stopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  stopDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    borderWidth: 1.5,
  },
  stopName: {
    flex: 1,
    fontSize: 13.5,
    fontWeight: '500',
  },
  stopTime: {
    fontSize: 13.5,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  skelCard: {
    marginTop: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 16,
    padding: 14,
  },
  debugHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  debugBox: {
    padding: 10,
    marginTop: 8,
  },
  debugText: {
    fontSize: 11,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
    lineHeight: 14,
  },
});
