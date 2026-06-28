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
import {
  usePlanSetupStore,
  MEAL_KEYS,
  type MealKey,
} from '@/store/usePlanSetupStore';
import { mealErrandLabel } from '@/lib/meals';
import { useProfileStore } from '@/store/useProfileStore';
import {
  useErrandsStore,
  groupErrands,
  errandStatus,
  type Errand,
  type ErrandInput,
} from '@/store/useErrandsStore';
import { useRecurringErrandsStore } from '@/store/useRecurringErrandsStore';
import {
  materializeRecurringForDate,
  recurringInstancesForDate,
} from '@/lib/recurring';
import { PlanSetupSheet } from '@/components/PlanSetupSheet';
import { DayBalanceCard } from '@/components/DayBalanceCard';
import { Card } from '@/components/Card';
import { Text } from '@/components/Text';
import { ErrandRow } from '@/components/ErrandRow';
import { ErrandDrawer } from '@/components/ErrandDrawer';
import { Button } from '@/components/Button';
import { type ErrandDraft } from '@/lib/ai/parseErrand';
import { TripMap, type LatLng, type TripStop } from '@/components/TripMap';
import {
  buildContextPayload,
  planItinerary,
  sanitizeItinerary,
  type ItineraryDebug,
  type PlanAnchor,
  type PlanDayEdge,
  type PlanTask,
} from '@/lib/ai/itinerary';
import { composeItinerary, type ComposedBlock } from '@/lib/ai/composeItinerary';
import {
  orderDay,
  fillDay,
  type OrderDayErrand,
  type FillStop,
} from '@/lib/ai/composeV3';
import { planDayV4, type V4Block } from '@/lib/ai/composeV4';
import {
  assembleComposedDay,
  lastComposedBlocks,
  type AssembleAnchor,
  type AssembleTask,
} from '@/lib/ai/composeAssemble';
import { refineItinerary } from '@/lib/ai/refineItinerary';
import { recomputeItinerary } from '@/lib/ai/recomputeItinerary';
import { applyErrandTravelModes } from '@/lib/itinerary/travelModes';
import { scoreDay } from '@/lib/planning/mindfulness';
import { requestAdjustOps } from '@/lib/ai/adjustItinerary';
import { collectDayAnchors } from '@/lib/dayAnchors';
import {
  applyOp,
  applyRoutedLegs,
  cascadeTimes,
  classifyReorder,
  describeOp,
  fitGapsToAnchors,
  opNeedsRoute,
  type CascadeConflict,
  type EditOp,
  type ReorderImpact,
} from '@/lib/itinerary/edits';
import { parseAdjustCommand } from '@/lib/itinerary/adjustCommand';
import { compactItinerary, logItineraryEdit } from '@/lib/itinerary/debugLog';
import {
  absCommuteWindow,
  buildAbsoluteTimeline,
  isArrivalMarker,
  toAbsoluteNow,
  type AbsSpan,
} from '@/lib/itinerary/timeline';
import { AdjustBar } from '@/components/AdjustBar';
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
  errandTimeMode,
  formatDuration,
  formatTime,
  minutesOfDay,
  todayISO,
} from '@/utils/time';
import { describeDay, isPastDay } from '@/utils/days';
import { getVenueHoursStatus } from '@/lib/itinerary/hours';

/**
 * Temporarily surfaces a small Fixed / Window / Flexible label on each plan
 * block so the item's `flexibility` is visible at a glance. Flip back to
 * `false` to hide the pills again; the field stays in the data model.
 */
const SHOW_FLEX_BADGES = true;

/** One-line description of each planning pipeline for the drawer selector. */
const PLANNER_MODE_HINT: Record<'v2' | 'v3' | 'v4', string> = {
  v2: 'Unified: one compose brain + resolve/route',
  v3: 'Staged: order → locate → route → fill',
  v4: 'Solo: one grounded brain does it all',
};

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

/** A blank errand draft used to seed the (edit-only) errand drawer. */
const EMPTY_ERRAND_DRAFT: ErrandDraft = {
  title: '',
  date: null,
  startTime: null,
  endTime: null,
  address: null,
  notes: null,
};

/** Map a stored errand onto the draft shape the errand drawer edits, carrying
 *  the resolved place data so the pinned location/photo/hours survive a round
 *  trip through the editor. */
function errandToDraft(e: Errand): ErrandDraft {
  return {
    title: e.title,
    date: e.date ?? null,
    startTime: e.startTime ?? null,
    endTime: e.endTime ?? null,
    durationMin: e.durationMin ?? null,
    address: e.address ?? null,
    latitude: e.latitude ?? null,
    longitude: e.longitude ?? null,
    placeId: e.placeId ?? null,
    photoUrl: e.photoUrl ?? null,
    rating: e.rating ?? null,
    ratingCount: e.ratingCount ?? null,
    priceLevel: e.priceLevel ?? null,
    openingHours: e.openingHours ?? null,
    travelMode: e.travelMode ?? null,
    notes: e.notes ?? null,
  };
}

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
 * One measured hop of a commute: its real clock window (`t0`→`t1`, minutes of
 * day) paired with the pixel band (`top`→`bottom`) of its row, measured
 * relative to the top of the leg's wrapper. The rail maps each hop's OWN time
 * interval onto its OWN row, so the playhead sits on the exact leg you're
 * riding (the 12-min bus, not an averaged-out blob across the whole panel)
 * while the trip as a whole still flows top-to-bottom continuously.
 */
type StepRect = { t0: number; t1: number; top: number; bottom: number };

const PLANNING_PHASES = [
  'Drafting your day…',
  'Finding the best places…',
  'Mapping your route…',
  'Polishing the details…',
];

const HOME_ID = '__home__';

// Unified compose brain (v3) rollout flag. Planning runs through the single
// `compose-itinerary` brain + deterministic Places resolve + assembly, instead
// of the legacy decompose-intent + plan-itinerary two-pass. DEFAULT ON (this is
// now the validated path); set `EXPO_PUBLIC_UNIFIED_COMPOSE=0` to force the
// legacy two-pass. The unified path also degrades gracefully to legacy if the
// brain returns nothing. (Legacy is kept as the runtime fallback; "Direction C"
// — one full-control planner with venue/route/hours tools — is the documented
// next fallback if this underperforms; see the planner overhaul plan.)
const UNIFIED_COMPOSE = process.env.EXPO_PUBLIC_UNIFIED_COMPOSE !== '0';

// AI refine pass (v3 second pass). After the unified path produces + grounds a
// day, a single `refine-itinerary` call re-plans on top of the REAL venues +
// travel + opening hours (reorder, retime, fill gaps, split errands, swap/retime
// closed venues). DEFAULT ON; set `EXPO_PUBLIC_REFINE=0` to disable. Degrades
// gracefully to the pre-refine grounded day on any failure or no-op (including
// before `refine-itinerary` is deployed), so turning it on is always safe.
const REFINE = process.env.EXPO_PUBLIC_REFINE !== '0';

// Don't flag tiny slivers as "free time" — only gaps worth noticing.
const GAP_MIN_MINUTES = 20;

// Default length for a gap the user adds by hand (between two plans, etc.).
const DEFAULT_GAP_MINUTES = 30;

const HOME_NAME_RE = /^(home|my home|house|residence)$/i;

// A commitment that happens at home / online and must NEVER get a physical
// venue: a video/phone call, telehealth, remote work, a virtual class. Without
// this the planner treats "Online therapy" as an appointment and invents a
// (often far-away) venue for it. Matched against the errand title + notes.
const REMOTE_ACTIVITY_RE =
  /\b(online|virtual|remote(?:ly)?|tele(?:health|medicine|therapy|conference)|web(?:inar|cast)|zoom|google\s?meet|ms\s?teams|teams\s+(?:call|meeting)|video\s?(?:call|chat|meeting|conference|consultation)|phone\s+call|call\s+with|by\s+phone|facetime|skype|dial[-\s]?in)\b/i;

/** Whether an errand's text marks it as an at-home / online (place-less) commitment. */
function isRemoteActivity(...parts: (string | null | undefined)[]): boolean {
  const text = parts.filter(Boolean).join(' ');
  return !!text && REMOTE_ACTIVITY_RE.test(text);
}

/**
 * Best-fit {@link ItineraryItemKind} for an errand, from a quick keyword scan of
 * its title/notes. Only a hint for the V3 pipeline's first-pass blocks (icons +
 * the fill brain's context); the brains/assembler can still refine it.
 */
function inferErrandKind(...parts: (string | null | undefined)[]): string {
  const t = parts.filter(Boolean).join(' ').toLowerCase();
  if (!t) return 'other';
  if (/\b(breakfast|brunch|lunch|dinner|eat|meal|restaurant|food|café|cafe|coffee)\b/.test(t))
    return 'meal';
  if (/\b(gym|workout|run|yoga|swim|training|fitness|exercise|walk|hike)\b/.test(t))
    return 'activity';
  if (/\b(work|deep work|study|focus|coworking|email|prep|writing)\b/.test(t)) return 'work';
  if (/\b(drinks|bar|pub|beer|wine|cocktail)\b/.test(t)) return 'drinks';
  if (/\b(meet|meetup|catch up|see |with )\b/.test(t)) return 'meetup';
  if (/\b(museum|gallery|sightsee|landmark|tour|explore)\b/.test(t)) return 'sightseeing';
  if (/\b(show|concert|match|game|movie|cinema|event|class)\b/.test(t)) return 'event';
  return 'activity';
}

/**
 * DEV-only structured trace for the planning pipeline (brain → resolve →
 * planner). Pretty-prints each stage's payload so it's easy to read in the
 * Metro logs AND to copy a whole dataset straight out into AI Studio. Wrapped
 * in BEGIN/END markers so a block is trivial to select. No-op outside __DEV__.
 */
function tracePlan(tag: string, data?: unknown): void {
  if (!__DEV__) return;
  if (data === undefined) {
    console.log(`[plan-trace] ${tag}`);
    return;
  }
  let body: string;
  try {
    body = JSON.stringify(data, null, 2);
  } catch {
    body = String(data);
  }
  console.log(`[plan-trace] ${tag} ===== BEGIN\n${body}\n[plan-trace] ${tag} ===== END`);
}

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

/** ~1m-precision coordinate key for matching a planned place back to the
 *  pre-plan candidate it was resolved from (the server copies anchor coords
 *  verbatim, so an exact-ish key match is reliable). */
function coordKey(lat: number, lng: number): string {
  return `${lat.toFixed(5)},${lng.toFixed(5)}`;
}

/** Re-attach carried alternative venues onto the planned places that match
 *  them by coordinate. The base planner emits its own places (and skips lookups
 *  for fixed anchors), so alternatives from the discover pre-pass are merged
 *  back here. Mutates `itin` in place; safe no-op when there are none. */
function attachAlternatives(
  itin: Itinerary,
  altByCoordKey: Map<string, ItineraryPlace[]>,
): void {
  if (altByCoordKey.size === 0) return;
  for (const section of itin.sections) {
    for (const item of section.items) {
      const c = item.place?.coords;
      if (!c || !item.place) continue;
      const alts = altByCoordKey.get(coordKey(c.latitude, c.longitude));
      if (alts && alts.length) item.place.alternatives = alts;
    }
  }
}

export default function ItineraryScreen() {
  const router = useRouter();
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { height: screenH } = useWindowDimensions();

  const home = useHomeStore((s) => s.home);
  const endOfDay = useHomeStore((s) => selectEndOfDay(s));
  // Profile-derived personalisation woven into every planner call below.
  const userName = useProfileStore((s) => s.fullName);
  const profileWakeTime = useProfileStore((s) => s.wakeTime);
  const profileBedTime = useProfileStore((s) => s.bedTime);
  const wakeUpDurationMin = useProfileStore((s) => s.wakeUpDurationMin);
  const breakfastStart = useProfileStore((s) => s.breakfastStart);
  const breakfastEnd = useProfileStore((s) => s.breakfastEnd);
  const lunchStart = useProfileStore((s) => s.lunchStart);
  const lunchEnd = useProfileStore((s) => s.lunchEnd);
  const dinnerStart = useProfileStore((s) => s.dinnerStart);
  const dinnerEnd = useProfileStore((s) => s.dinnerEnd);
  const windDownTime = useProfileStore((s) => s.windDownTime);
  const allowScreenWindDown = useProfileStore((s) => s.allowScreenWindDown);
  const hasCar = useProfileStore((s) => s.hasCar);
  const dietary = useProfileStore((s) => s.dietary);
  const dietaryNotes = useProfileStore((s) => s.dietaryNotes);
  const useCarToday = usePlanSetupStore((s) => s.useCarToday);
  // Experimental planning pipeline selector (dev/testing control in the drawer).
  const plannerMode = usePlanSetupStore((s) => s.plannerMode);
  const setPlannerMode = usePlanSetupStore((s) => s.setPlannerMode);
  const planMealModes = usePlanSetupStore((s) => s.mealModes);
  const planMealLinks = usePlanSetupStore((s) => s.mealLinks);
  const saveItinerary = useSavedItineraries((s) => s.save);
  const updateSavedItinerary = useSavedItineraries((s) => s.update);
  const activatePlan = useSavedItineraries((s) => s.activate);

  // The day + start time chosen in the planner setup drawer (homepage "+" or
  // the "When" row below). A stale past date heals to today so we never plan
  // into the past.
  const planDate = usePlanSetupStore((s) => s.date);
  const planStartTime = usePlanSetupStore((s) => s.startTime);
  const planStartLocation = usePlanSetupStore((s) => s.startLocation);
  const planEndTime = usePlanSetupStore((s) => s.endTime);
  const planEndLocation = usePlanSetupStore((s) => s.endLocation);
  const setDayPlan = usePlanSetupStore((s) => s.setDayPlan);
  const clearMealLinksForErrand = usePlanSetupStore(
    (s) => s.clearMealLinksForErrand,
  );
  const effectiveDate = isPastDay(planDate) ? todayISO() : planDate;
  const [setupOpen, setSetupOpen] = useState(false);
  // Which step the setup drawer opens to: 0 = pick the day, 1 = start & end.
  const [setupStep, setSetupStep] = useState<0 | 1>(0);
  const openSetup = (stepTo: 0 | 1) => {
    Haptics.selectionAsync().catch(() => undefined);
    setSetupStep(stepTo);
    setSetupOpen(true);
  };
  const whenSummary = useMemo(() => {
    const d = describeDay(effectiveDate);
    return `${d.title}, ${d.dateLabel} · ${formatTime(planStartTime)}`;
  }, [effectiveDate, planStartTime]);

  // Opening a saved plan from the homepage: hydrate it (once) so the screen
  // shows the preview straight away with the drawer already collapsed.
  // We also defensively scrub "Home"-looking place blocks (the
  // ALZHEIMER-HOME / Sevt-Inc doppelgängers an earlier build let through)
  // so old saves heal themselves on the next open instead of carrying that
  // stale enrichment forever.
  const params = useLocalSearchParams<{
    id?: string;
    /** DEV test harness: free-text to auto-plan with (see seedTestPlan). */
    seedIntent?: string;
    /** DEV test harness: "1" to kick off planning automatically on entry. */
    autoplan?: string;
  }>();
  const preloaded = useMemo(() => {
    if (!params.id) return null;
    const saved = useSavedItineraries
      .getState()
      .items.find((i) => i.id === params.id)?.itinerary;
    if (!saved) return null;
    return scrubHomePlacesFromSaved(saved, home);
  }, [params.id, home]);

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
  // True when the user picked the v4 brain but it didn't finalise the plan (it
  // timed out / errored) so a lesser pipeline produced what's on screen. Surfaced
  // in the header so a fall-back is never invisible — the "I picked v4 but got
  // the zig-zag day and didn't know it wasn't v4" trap.
  const [v4FellBack, setV4FellBack] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const [activeSectionIndex, setActiveSectionIndex] = useState(0);
  const [activeStopId, setActiveStopId] = useState<string | null>(null);
  // Current wall-clock time (minutes since midnight). Drives the time-based
  // progress fill, the glowing "now / next" card, and greying-out of the past.
  const [nowMin, setNowMin] = useState(() => minutesOfDay(currentHHMM()) ?? 0);
  const [sheetExpanded, setSheetExpanded] = useState(!preloaded);
  const [phase, setPhase] = useState(0);

  // --- live editing state ---------------------------------------------------
  // True while an edit is being applied (route refresh / AI re-plan in flight).
  const [editBusy, setEditBusy] = useState(false);
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

  // ----- Errands shown as the drawer's main content (pre-plan) -------------
  // The day's errands lead, then a catch-all "Anytime" group, shown purely as
  // reference for the day you're about to plan. Rows aren't editable here (and
  // never strike through) — the round check just toggles done. New errands are
  // captured from the home screen.
  const errands = useErrandsStore((s) => s.items);
  const addErrand = useErrandsStore((s) => s.add);
  const toggleErrandDone = useErrandsStore((s) => s.toggleDone);
  const updateErrand = useErrandsStore((s) => s.update);
  const removeErrand = useErrandsStore((s) => s.remove);
  const reopenErrand = useErrandsStore((s) => s.reopen);
  const setErrandsPlanned = useErrandsStore((s) => s.setPlanned);
  // Errand-drawer state — tapping a row opens it in edit mode; the
  // "+ New errand for this day" button opens it in create mode for the planned
  // day. Both flows resolve a concrete location inside the drawer.
  const [errandDrawerOpen, setErrandDrawerOpen] = useState(false);
  const [errandDrawerMode, setErrandDrawerMode] = useState<'create' | 'edit'>('edit');
  const [errandSeed, setErrandSeed] = useState<ErrandDraft>(EMPTY_ERRAND_DRAFT);
  const [errandRawText, setErrandRawText] = useState('');
  const [errandSeedKey, setErrandSeedKey] = useState('errand-0');
  const [editErrandId, setEditErrandId] = useState<string | null>(null);

  // Errands the user ticked to fold into THIS plan. We don't auto-inject any of
  // them — selection is explicit — and they're woven into the planner request on
  // "Plan my day", then cleared once a plan lands.
  const [selectedErrandIds, setSelectedErrandIds] = useState<Set<string>>(
    () => new Set(),
  );
  // The planned day we last seeded the selection for, plus which of that day's
  // errands we've already auto-selected. Together they let us preselect the
  // day's errands — and fold in any added or hydrated later — without ever
  // re-adding ones the user has unticked. See `seedSelectedErrands`.
  const errandSeedDateRef = useRef<string | null>(null);
  const seenDayErrandsRef = useRef<Set<string>>(new Set());
  const toggleErrandSelected = (id: string) => {
    // Unticking an errand also drops any confirmed meal link to it, so a dining
    // errand the user removed from the plan stops standing in for its meal (in
    // the setup drawer's meals step and the planner's meal-venue context alike).
    if (selectedErrandIds.has(id)) clearMealLinksForErrand(id);
    setSelectedErrandIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Active candidates are open errands only; planned/done ones drop into the
  // Completed group below. `groupErrands` does the status split + sorting and
  // floats the day being planned to the front of the scheduled bucket.
  const todayIso = todayISO();
  const errandGroups = useMemo(
    () => groupErrands(errands, { focusDate: effectiveDate, today: todayIso }),
    [errands, effectiveDate, todayIso],
  );
  // The drawer plans ONE day, so its scheduled group is just that day's open
  // errands (other days live on the home list); anytime + completed follow.
  // `dayErrands` stays the FULL set (recurring occurrences included) so the
  // preselect + fold-into-plan bookkeeping below treats them like any other of
  // the day's errands; the render below splits the recurring ones into their
  // own "Repeats" section (mirroring the home screen) without affecting that.
  const dayErrands = useMemo(
    () => errandGroups.scheduled.filter((e) => e.date === effectiveDate),
    [errandGroups, effectiveDate],
  );
  const anytimeErrands = errandGroups.anytime;
  const completedErrands = errandGroups.completed;
  const [showCompletedErrands, setShowCompletedErrands] = useState(false);

  // Materialize the planned day's recurring occurrences so they become real
  // dated errands for `effectiveDate`. They then flow through everything below
  // as ordinary errands: `dayErrands` picks them up, the preselect effect ticks
  // them on ("always preselected"), and "mark planned" works unchanged.
  const recurringTemplates = useRecurringErrandsStore((s) => s.items);
  useEffect(() => {
    materializeRecurringForDate(effectiveDate);
  }, [effectiveDate, recurringTemplates]);

  // The planned day's still-open recurring occurrences. They get their own
  // "Repeats" section at the top of the list (with a repeat glyph) — exactly
  // like the home screen — so the user can SEE them, distinct from one-off
  // errands. They're still part of `dayErrands` above, so they stay preselected
  // and fold into the plan unless the user unticks them.
  const recurringDay = useMemo(
    () => recurringInstancesForDate(errands, effectiveDate),
    [errands, effectiveDate],
  );
  const recurringDayIds = useMemo(
    () => new Set(recurringDay.map((e) => e.id)),
    [recurringDay],
  );
  // The day group renders only the NON-recurring errands, so a recurring
  // occurrence never shows twice (Repeats section + day group).
  const dayOnlyErrands = useMemo(
    () => dayErrands.filter((e) => !recurringDayIds.has(e.id)),
    [dayErrands, recurringDayIds],
  );

  // Open dated errands for the planned day are the user's clear intent, so they
  // get preselected. `groupErrands` already excludes done/planned ones.
  const dayErrandIds = useMemo(() => dayErrands.map((e) => e.id), [dayErrands]);

  // (Re)seed the fold-into-plan selection to exactly the day's own errands,
  // resetting the "seen" set so the new day starts fresh. Used on a day change
  // and to re-preselect for a fresh planning pass after a reset.
  const seedSelectedErrands = useCallback(() => {
    errandSeedDateRef.current = effectiveDate;
    seenDayErrandsRef.current = new Set(dayErrandIds);
    setSelectedErrandIds(new Set(dayErrandIds));
  }, [dayErrandIds, effectiveDate]);

  // Preselect the planned day's errands so the user needn't tick each by hand.
  // On a day change we seed from scratch; within a day we fold in any errands
  // that appear later (added, or hydrated from storage after the first pass)
  // the first time we see them — but never re-add ones the user has unticked,
  // since those are already marked "seen".
  useEffect(() => {
    if (errandSeedDateRef.current !== effectiveDate) {
      seedSelectedErrands();
      return;
    }
    const fresh = dayErrandIds.filter((id) => !seenDayErrandsRef.current.has(id));
    if (fresh.length === 0) return;
    fresh.forEach((id) => seenDayErrandsRef.current.add(id));
    setSelectedErrandIds((prev) => {
      const next = new Set(prev);
      fresh.forEach((id) => next.add(id));
      return next;
    });
  }, [effectiveDate, dayErrandIds, seedSelectedErrands]);

  // ----- Mindfulness / day balance (live as errands are ticked) -----
  // Score the day the user is assembling: the ticked errands' hours + estimated
  // travel (from where the day starts, through the located stops, back to where
  // it ends) against the plan's window. Unticking an errand re-scores instantly,
  // so a lighter, calmer day is something the user can feel before they plan.
  const selectedErrands = useMemo(
    () => errands.filter((e) => selectedErrandIds.has(e.id)),
    [errands, selectedErrandIds],
  );
  const planScore = useMemo(
    () =>
      scoreDay({
        startTime: planStartTime,
        endTime: planEndTime,
        errands: selectedErrands,
        startAnchor: planStartLocation ?? home ?? null,
        endAnchor: planEndLocation ?? home ?? null,
      }),
    [
      planStartTime,
      planEndTime,
      selectedErrands,
      planStartLocation,
      planEndLocation,
      home,
    ],
  );

  const onEditErrand = (errand: Errand) => {
    // No haptic here: ErrandRow's body tap already fires the selection tick, so
    // firing again would double up (matches the home screen's onEditErrand).
    setErrandDrawerMode('edit');
    setEditErrandId(errand.id);
    setErrandRawText(errand.rawText);
    setErrandSeed(errandToDraft(errand));
    setErrandSeedKey(`errand-${errand.id}-${errand.updatedAt}`);
    setErrandDrawerOpen(true);
  };

  // "+ New errand for this day": open the drawer in create mode, pre-dated to
  // the planned day so the new errand lands on it (and gets preselected below).
  const openNewErrand = () => {
    Haptics.selectionAsync().catch(() => undefined);
    setErrandDrawerMode('create');
    setEditErrandId(null);
    setErrandRawText('');
    setErrandSeed({ ...EMPTY_ERRAND_DRAFT, date: effectiveDate });
    setErrandSeedKey(`errand-new-${Date.now()}`);
    setErrandDrawerOpen(true);
  };

  const onSaveErrand = (patch: ErrandInput) => {
    if (errandDrawerMode === 'edit' && editErrandId) {
      updateErrand(editErrandId, patch);
    } else {
      // Create on the planned day and tick it so it folds into the next plan.
      const newId = addErrand({ ...patch, date: patch.date ?? effectiveDate });
      setSelectedErrandIds((prev) => new Set(prev).add(newId));
    }
    setErrandDrawerOpen(false);
  };

  const onDeleteErrand = () => {
    if (editErrandId) removeErrand(editErrandId);
    setErrandDrawerOpen(false);
  };

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
  // Holds the wall clock on the UNWRAPPED axis (see `nowAbs`), so the rail's
  // off-render recompute compares like-for-like with the absolute anchors.
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
  // Each commute (travel) row's offset/height *within its wrapper*, mirroring
  // `cardRawRef`. Lets the rail map the commute's time window onto its own band
  // so the playhead tracks "you're on the bus" instead of jumping card-to-card.
  const legRawRef = useRef<Record<string, { relY: number; h: number }>>({});
  // Per-commute step geometry (each hop's time window + pixel band relative to
  // the leg top), reported up by `TravelLegRow`. Drives the fine-grained,
  // per-hop progress so the head lands on the exact step (walk / bus 200).
  const legStepsRef = useRef<Record<string, StepRect[]>>({});
  const tabOffsetsRef = useRef<number[]>([]);

  // The day's end anchor: the per-day end address chosen in the setup drawer
  // wins over the persistent home/end-of-day pin so a "drinks downtown, crash
  // at a friend's" day routes to the right finish.
  const effectiveEndOfDay = planEndLocation ?? endOfDay;

  // Memoised so it's stable across renders — effects that depend on `context`
  // (auto-refresh, log dumper) only re-fire when the underlying pins actually
  // change, not on every parent re-render.
  // Resolve each meal's linked dining errand (set in the planner drawer) to a
  // venue label the planning brain can use as that meal — so a "Dinner at Café
  // Savoy" errand becomes dinner instead of the brain inventing a separate one.
  const mealVenuesForCtx = useMemo(() => {
    const out: Partial<Record<MealKey, string>> = {};
    for (const meal of MEAL_KEYS) {
      const id = planMealLinks?.[meal];
      if (!id) continue;
      const e = errands.find((x) => x.id === id);
      if (e) out[meal] = mealErrandLabel(e);
    }
    return out;
  }, [planMealLinks, errands]);

  const context = useMemo<SchedulerContext>(
    () => ({
      home,
      endOfDay: effectiveEndOfDay,
      currentLocation: planStartLocation
        ? {
            latitude: planStartLocation.latitude,
            longitude: planStartLocation.longitude,
            label: planStartLocation.label,
          }
        : undefined,
      dayStartTime: planStartTime,
      userName,
      wakeTime: profileWakeTime,
      bedTime: profileBedTime,
      wakeUpDurationMin,
      breakfastStart,
      breakfastEnd,
      lunchStart,
      lunchEnd,
      dinnerStart,
      dinnerEnd,
      windDownTime,
      allowScreenWindDown,
      hasCar,
      useCarToday,
      mealModes: planMealModes,
      mealVenues: mealVenuesForCtx,
      dietary,
      dietaryNotes,
    }),
    [
      home,
      effectiveEndOfDay,
      planStartLocation,
      planStartTime,
      userName,
      profileWakeTime,
      profileBedTime,
      wakeUpDurationMin,
      breakfastStart,
      breakfastEnd,
      lunchStart,
      lunchEnd,
      dinnerStart,
      dinnerEnd,
      windDownTime,
      allowScreenWindDown,
      hasCar,
      useCarToday,
      planMealModes,
      mealVenuesForCtx,
      dietary,
      dietaryNotes,
    ],
  );

  // A recompute/route context whose START is THIS plan's own baked origin
  // (`itinerary.startLocation`) rather than the global planner-setup pick. A
  // saved day therefore always re-routes its first leg from where it was
  // planned to begin (home, a hotel, a friend's place), instead of silently
  // inheriting wherever the setup drawer was last left — the bug that turned a
  // "from home" day into a short walk once a different start was picked. Plans
  // without a baked start (older ones) send no currentLocation, so the server
  // falls back to home.
  const contextFor = useCallback(
    (itin: Itinerary | null | undefined): SchedulerContext => ({
      ...context,
      currentLocation: itin?.startLocation
        ? {
            latitude: itin.startLocation.latitude,
            longitude: itin.startLocation.longitude,
            label: itin.startLocation.label ?? null,
          }
        : null,
    }),
    [context],
  );

  // One self-heal per saved trip per session, on first open. Two cases qualify:
  //   1. Trips planned BEFORE real routing existed (every leg `estimated: true`
  //      with no polyline) — the original "Petřiny ⇄ Pekařova nonsense" heal.
  //   2. Trips with NO baked `startLocation` (planned before per-plan starts) —
  //      their cached first leg may still run from a stale global start (the
  //      "walk from Sokolovská instead of home" bug). Re-routing with this
  //      plan's context sends no current-location, so the server re-anchors the
  //      day to home; we then bake home in so it converges and never re-heals.
  // Keyed by saved id so it fires at most once per trip per session.
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
    const needsStartHeal = !preloaded.startLocation;
    if (!allEstimated && !needsStartHeal) return;

    autoRefreshedRef.current.add(id);
    const seq = ++planSeqRef.current;
    // `routesRefining` instead of `loading` — the saved day is already on
    // screen and we don't want a full planning skeleton to flash over it.
    setRoutesRefining(true);
    console.log(
      `[plan-trace] RECOMPUTE source=autoHeal id=${id} allEstimated=${allEstimated} needsStartHeal=${needsStartHeal}`,
    );
    recomputeItinerary(preloaded, contextFor(preloaded))
      .then((result) => {
        if (planSeqRef.current !== seq) return;
        if (result.refreshed) {
          // Bake the resolved start so the heal sticks: keep an existing one,
          // else stamp home (the origin this plan was just re-routed from).
          const healed = result.itinerary.startLocation
            ? result.itinerary
            : {
                ...result.itinerary,
                startLocation: {
                  label: home.label,
                  latitude: home.latitude,
                  longitude: home.longitude,
                },
              };
          setItinerary(healed);
          updateSavedItinerary(id, healed);
        }
      })
      .finally(() => {
        if (planSeqRef.current === seq) setRoutesRefining(false);
      });
  }, [params.id, preloaded, home, contextFor, updateSavedItinerary]);

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
            blocks: lastComposedBlocks,
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

  // Unwrapped time axis so a plan that crosses midnight (a 22:20 → 01:30 night)
  // stays ordered: blocks after midnight climb past 1440 instead of wrapping to
  // tiny morning minutes (which made them read as "already over" → greyed out,
  // and broke the now/progress logic). Same-day plans get raw==absolute minutes.
  const { byId: absById, dayStart: dayStartMin, dayEnd: dayEndMin } = useMemo(
    () => buildAbsoluteTimeline(flatItems),
    [flatItems],
  );
  const absByIdRef = useRef(absById);
  absByIdRef.current = absById;
  const dayBoundsRef = useRef({ start: dayStartMin, end: dayEndMin });
  dayBoundsRef.current = { start: dayStartMin, end: dayEndMin };
  // The wall clock on that same axis (rolls past midnight while a night plan is
  // still running). Drives every "now / past / progress" comparison below.
  const nowAbs = useMemo(
    () => toAbsoluteNow(nowMin, dayStartMin, dayEndMin),
    [nowMin, dayStartMin, dayEndMin],
  );
  nowRef.current = nowAbs;

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
    for (const it of flatItems) if ((absById[it.id]?.end ?? Infinity) > nowAbs) return it.id;
    return null;
  }, [flatItems, absById, nowAbs]);

  // The commute happening now: the item whose incoming leg's [depart, arrive]
  // window contains the clock — i.e. you're mid-journey TO it. While set, that
  // connector glows instead of the destination card (you haven't arrived yet).
  const nowLegId = useMemo(() => {
    for (const it of flatItems) {
      const w = absCommuteWindow(it, absById);
      if (w && nowAbs >= w.depart && nowAbs < w.arrive) return it.id;
    }
    return null;
  }, [flatItems, absById, nowAbs]);

  // Blocks already finished (dimmed). Keyed off the unwrapped end so a plan that
  // runs past midnight isn't wrongly greyed because "01:00" < the evening clock.
  const pastIds = useMemo(() => {
    const s = new Set<string>();
    for (const it of flatItems) if ((absById[it.id]?.end ?? Infinity) <= nowAbs) s.add(it.id);
    return s;
  }, [flatItems, absById, nowAbs]);

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

  // Search context for the per-card location editor: where to center a venue
  // search and the located stops on either side. Walk the flat day outward
  // from the open card to the nearest items that actually have coordinates,
  // falling back to home/origin at the day's edges (the day departs from and
  // returns to home). Handing these to the editor lets discovery rank options
  // by how little they detour the route, instead of just "closest to the old
  // pin" — which is what stops a change from introducing a zig-zag. The center
  // is the card's own pin when it has one, else the nearest neighbour.
  const menuSearch = useMemo(() => {
    if (!menuItem) return { center: undefined, prev: undefined, next: undefined };
    const homeCoord = home
      ? { latitude: home.latitude, longitude: home.longitude }
      : undefined;
    const idx = flatItems.findIndex((it) => it.id === menuItem.id);
    let prev: { latitude: number; longitude: number } | undefined;
    let next: { latitude: number; longitude: number } | undefined;
    if (idx !== -1) {
      for (let i = idx - 1; i >= 0; i--) {
        const c = flatItems[i]?.place?.coords;
        if (c) {
          prev = c;
          break;
        }
      }
      for (let i = idx + 1; i < flatItems.length; i++) {
        const c = flatItems[i]?.place?.coords;
        if (c) {
          next = c;
          break;
        }
      }
    }
    const center = menuItem.place?.coords ?? prev ?? next ?? homeCoord;
    return { center, prev: prev ?? homeCoord, next: next ?? homeCoord };
  }, [menuItem, flatItems, home]);

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
      if (wrapY == null) continue;
      // Commute band: map the journey onto the measured travel row so the head
      // creeps down the bus/train while you ride it. Pushed before the card
      // anchors so it lands just above this card's start.
      const legRaw = legRawRef.current[it.id];
      if (legRaw) {
        const legTop = wrapY + legRaw.relY;
        const stepRects = legStepsRef.current[it.id];
        if (stepRects && stepRects.length > 0) {
          // Per-hop: each step maps its OWN real clock interval onto its OWN
          // row, so 22:25 lands partway down the "bus 200" row, not at the 50%
          // mark of an averaged whole-leg band.
          for (const r of stepRects) {
            anchors.push({ t: r.t0, y: legTop + r.top });
            anchors.push({ t: r.t1, y: legTop + r.bottom });
          }
        } else {
          // Fallback (haversine leg, no measured steps): one linear band across
          // the whole panel.
          const w = absCommuteWindow(it, absByIdRef.current);
          if (w) {
            anchors.push({ t: w.depart, y: legTop });
            anchors.push({ t: w.arrive, y: legTop + legRaw.h });
          }
        }
      }
      const raw = cardRawRef.current[it.id];
      if (raw == null) continue;
      const top = wrapY + raw.relY;
      const span = absByIdRef.current[it.id];
      const s = span?.start ?? null;
      const e = span?.end ?? Number.POSITIVE_INFINITY;
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
      const { start, end } = dayBoundsRef.current;
      nowRef.current = toAbsoluteNow(m, start, end);
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
      const prevEnd = absById[prev.id]?.end ?? null;
      const curStart = absById[cur.id]?.start ?? null;
      if (prevEnd == null || !Number.isFinite(prevEnd) || curStart == null) continue;
      const travel = Number(cur.travelFromPrev?.minutes) || 0;
      const gap = curStart - prevEnd - travel;
      if (gap >= GAP_MIN_MINUTES) map[cur.id] = gap;
    }
    return map;
  }, [flatItems, absById]);

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
    legRawRef.current = {};
    legStepsRef.current = {};
    tabOffsetsRef.current = [];
    setActiveSectionIndex(0);
    setActiveStopId(null);
    timeFillY.value = 0;
  };

  // UNIFIED COMPOSE (v3, flag-gated). One structured brain call positions +
  // orders the whole day; Google Places resolves real venues and the routing
  // engine lays the clock + gaps — no legacy decompose/plan two-pass. Runs after
  // planIt's shared setup; returns true when it handled the plan (or was
  // superseded), false to fall back to the legacy pipeline (e.g. brain empty).
  const runUnifiedCompose = async (run: {
    seq: number;
    text: string;
    userChosen: Errand[];
  }): Promise<boolean> => {
    const { seq, text, userChosen } = run;

    // Located errands (a concrete pin) are FIXED geography the brain clusters
    // around; everything else (at-home/online, pure tasks) is an unplaced TASK
    // the brain positions. Online/remote stays place-less.
    const located = userChosen.filter(
      (e) =>
        e.latitude != null &&
        e.longitude != null &&
        !isRemoteActivity(e.title, e.notes),
    );
    const locatedIds = new Set(located.map((e) => e.id));
    const taskErrands = userChosen.filter((e) => !locatedIds.has(e.id));

    const composeAnchors = located.map((e) => ({
      id: e.id,
      title: e.title,
      name: e.address ?? e.title,
      latitude: e.latitude,
      longitude: e.longitude,
      startTime: e.startTime,
      endTime: e.endTime,
      durationMin: e.durationMin,
      notes: e.notes,
      locationType: (e.placeId ? 'business' : undefined) as 'business' | undefined,
    }));
    const composeTasks = taskErrands.map((e) => ({
      id: e.id,
      title: e.title,
      startTime: e.startTime,
      endTime: e.endTime,
      durationMin: e.durationMin,
      notes: e.notes,
      atHome: isRemoteActivity(e.title, e.notes),
    }));

    // Located venues + pinned times keyed by errand id, so the assembler can
    // attach the real place and re-apply hard user times verbatim.
    const anchorsById = new Map<string, AssembleAnchor>();
    for (const e of located) {
      anchorsById.set(e.id, {
        title: e.title,
        place: {
          name: e.address ?? e.title,
          address: e.address ?? undefined,
          coords: { latitude: e.latitude!, longitude: e.longitude! },
          photoUrl: e.photoUrl ?? undefined,
          rating: e.rating ?? undefined,
          ratingCount: e.ratingCount ?? undefined,
          priceLevel:
            typeof e.priceLevel === 'number'
              ? '$'.repeat(Math.max(1, e.priceLevel))
              : undefined,
          openingHours: e.openingHours ?? undefined,
        },
        startTime: e.startTime,
        endTime: e.endTime,
        durationMin: e.durationMin,
      });
    }
    const tasksById = new Map<string, AssembleTask>();
    for (const e of taskErrands) {
      tasksById.set(e.id, {
        title: e.title,
        startTime: e.startTime,
        endTime: e.endTime,
        durationMin: e.durationMin,
      });
    }

    // Day frame + corridor (same rule as the legacy path): only send `now` once
    // the day is genuinely underway, so a fresh day still gets its morning.
    const planningToday = effectiveDate === todayISO();
    const localNow = currentHHMM();
    const dayUnderway = planningToday && !!planStartTime && localNow > planStartTime;
    const nowArg = dayUnderway ? localNow : undefined;
    const startForFrame = dayUnderway ? localNow : planStartTime;
    const startCoord = planStartLocation
      ? { latitude: planStartLocation.latitude, longitude: planStartLocation.longitude }
      : home
        ? { latitude: home.latitude, longitude: home.longitude }
        : null;
    const endCoord = planEndLocation
      ? { latitude: planEndLocation.latitude, longitude: planEndLocation.longitude }
      : home
        ? { latitude: home.latitude, longitude: home.longitude }
        : null;
    const dayAnchorCoords = collectDayAnchors({ errands, date: effectiveDate, home }).map(
      (a) => a.coords,
    );
    for (const e of located) {
      dayAnchorCoords.push({ latitude: e.latitude!, longitude: e.longitude! });
    }
    if (startCoord) dayAnchorCoords.push(startCoord);
    if (endCoord) dayAnchorCoords.push(endCoord);

    // The drawer "Start time" is the user's explicit, per-day signal of when the
    // day BEGINS, so it must anchor the morning routine. Without this the brain
    // opens the day at the profile's default wake (e.g. 08:00) and ignores the
    // 09:00 the user just picked in the drawer. Once the day is already underway
    // no morning is generated (includeMorning is false), so we leave the wake as
    // it is then.
    const composeCtx = buildContextPayload(context);
    if (composeCtx && !dayUnderway && startForFrame) composeCtx.wakeTime = startForFrame;

    tracePlan('(1) COMPOSE BRAIN REQUEST — full merged day (one pass)', {
      intent: text,
      date: effectiveDate,
      now: nowArg ?? null,
      dayStart: { time: startForFrame ?? null, label: planStartLocation?.label ?? null },
      dayEnd: { time: planEndTime ?? null, label: planEndLocation?.label ?? null },
      anchors: composeAnchors,
      tasks: composeTasks,
    });

    const composed = await composeItinerary({
      intent: text,
      anchors: composeAnchors,
      tasks: composeTasks,
      dayStart: { time: startForFrame, label: planStartLocation?.label },
      dayEnd: { time: planEndTime, label: planEndLocation?.label },
      context: composeCtx,
      home: home
        ? { label: home.label, latitude: home.latitude, longitude: home.longitude }
        : undefined,
      date: effectiveDate,
      now: nowArg,
    });
    if (planSeqRef.current !== seq) return true; // superseded — stop, don't fall back
    if (composed.blocks.length === 0) {
      tracePlan('(2) COMPOSE BRAIN — empty, falling back to legacy pipeline', null);
      return false;
    }
    tracePlan('(2) COMPOSE BRAIN RESPONSE — ordered blocks', composed.blocks);

    const { itinerary: itin, altByCoordKey } = await assembleComposedDay({
      blocks: composed.blocks,
      title: composed.title,
      summary: composed.summary,
      city: composed.city,
      date: effectiveDate,
      anchorsById,
      tasksById,
      dayAnchorCoords,
      start: startCoord,
      end: endCoord,
      home: home ? { latitude: home.latitude, longitude: home.longitude } : null,
    });
    if (planSeqRef.current !== seq) return true;
    if (!itin) return false; // assembly produced nothing usable — fall back

    tracePlan(
      '(3) ASSEMBLED — resolved venues + order (pre-routing)',
      itin.sections
        .flatMap((s) => s.items)
        .map((it, i) => ({
          i,
          start: it.startTime ?? null,
          kind: it.kind,
          title: it.title,
          place: it.place?.name ?? null,
        })),
    );

    setUsedAi(true);
    setDebug(null);

    // Bake the chosen start so reopening/editing routes the first leg from the
    // same origin (mirrors the legacy path).
    if (planStartLocation) {
      itin.startLocation = {
        label: planStartLocation.label,
        latitude: planStartLocation.latitude,
        longitude: planStartLocation.longitude,
      };
    }
    attachAlternatives(itin, altByCoordKey);

    const id = saveItinerary(itin);
    activatePlan(id);
    setSavedId(id);
    setItinerary(itin);
    // Mark the user's own ticked errands "Planned" (test errands persist for
    // reproducible reruns). The brain's free-text activities live in the plan,
    // not as errands — so nothing to clean up there.
    const plannedIds = userChosen.filter((e) => e.source !== 'test').map((e) => e.id);
    if (plannedIds.length) setErrandsPlanned(plannedIds, effectiveDate);
    setSelectedErrandIds(new Set());
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(
      () => undefined,
    );
    setTimeout(() => snapTo(collapsedTop), 520);

    setLoading(false);
    setRoutesRefining(true);
    console.log(`[plan-trace] RECOMPUTE source=compose-bg seq=${seq}`);
    void (async () => {
      try {
        // Pass 1 — GROUND the day: resolve real door-to-door travel legs,
        // cascade the clock, synthesise idle gaps. (Venues already resolved.)
        // Lock "drive" onto the hops into car errands first so Google routes
        // them by car (commute errands keep the walk/transit auto-pick).
        const grounded = await recomputeItinerary(
          applyErrandTravelModes(itin, userChosen, hasCar),
          contextFor(itin),
        );
        if (planSeqRef.current !== seq) return;
        let current = itin;
        if (grounded.refreshed) {
          current = grounded.itinerary;
          attachAlternatives(current, altByCoordKey);
          setItinerary(current);
          updateSavedItinerary(id, current);
        }

        // Pass 2 (flag-gated) — AI REFINE on the grounded day: re-plan against
        // REAL venues + travel + opening hours (reorder, fill gaps, retime,
        // split, swap closed), then re-assemble + re-route the revision. Any
        // failure or no-op leaves the grounded day exactly as it is.
        if (!REFINE || !grounded.refreshed) return;
        tracePlan('(4) REFINE REQUEST — grounded day → refine brain', {
          date: effectiveDate,
          now: nowArg ?? null,
        });
        const refined = await refineItinerary({
          itinerary: current,
          intent: text,
          date: effectiveDate,
          now: nowArg,
          dayStart: { time: startForFrame, label: planStartLocation?.label },
          dayEnd: { time: planEndTime, label: planEndLocation?.label },
          context: composeCtx,
          anchors: composeAnchors,
          tasks: composeTasks,
        });
        if (planSeqRef.current !== seq) return;
        if (!refined.changed || refined.blocks.length === 0) {
          tracePlan('(5) REFINE — no change', refined.notes || null);
          return;
        }
        tracePlan('(5) REFINE RESPONSE — revised blocks', {
          notes: refined.notes,
          blocks: refined.blocks,
        });

        const { itinerary: refinedItin, altByCoordKey: refinedAlts } =
          await assembleComposedDay({
            blocks: refined.blocks,
            title: current.title || 'Your day',
            summary: current.summary ?? '',
            city: current.city ?? '',
            date: effectiveDate,
            anchorsById,
            tasksById,
            dayAnchorCoords,
            start: startCoord,
            end: endCoord,
            home: home ? { latitude: home.latitude, longitude: home.longitude } : null,
          });
        if (planSeqRef.current !== seq || !refinedItin) return;
        // Keep the day's id + baked start across the revision so it updates the
        // same saved record and re-routes the first leg from the same origin.
        refinedItin.id = current.id;
        refinedItin.startLocation = current.startLocation ?? refinedItin.startLocation;

        // Re-apply the car locks — the refine re-assembly rebuilds legs from
        // scratch, so the preference must be stamped on again before routing.
        const regrounded = await recomputeItinerary(
          applyErrandTravelModes(refinedItin, userChosen, hasCar),
          contextFor(refinedItin),
        );
        if (planSeqRef.current !== seq) return;
        const out = regrounded.refreshed ? regrounded.itinerary : refinedItin;
        attachAlternatives(out, refinedAlts);
        setItinerary(out);
        updateSavedItinerary(id, out);
      } finally {
        if (planSeqRef.current === seq) setRoutesRefining(false);
      }
    })();
    return true;
  };

  /**
   * EXPERIMENTAL V3 pipeline (drawer "V3" switch). A deliberately staged
   * alternative to {@link runUnifiedCompose}, matching the user's mental model:
   *
   *   1. CREATE errands — user + recurring + (if free text) freestyle, via the
   *      same `decompose-intent` brain the legacy path uses.
   *   2. ORDER — one CHEAP `order-day` call returns the best geographic order
   *      (ids only); a deterministic guard keeps fixed times ascending.
   *   3. LOCATE — fill every place-less-but-place-y errand IN ORDER via
   *      `resolveAutoPlaceVenuesInOrder` (cluster each onto the previous stop).
   *   4. COMMUTE — assemble the ordered + located stops and route them
   *      (`recompute-itinerary`) so the user sees a connected day immediately.
   *   5. FILL — one HEAVY `fill-day` call weaves in the everyday scaffolding
   *      (wake, meals, wind-down, sleep) + gap blocks around the routed stops.
   *   6. RE-COMMUTE — re-assemble + re-route the filled day.
   *
   * Returns true once it has produced a day (even an un-filled one); false only
   * when there is genuinely nothing to plan, so `planIt` can fall through.
   */
  const runComposeV3 = async (run: {
    seq: number;
    text: string;
    userChosen: Errand[];
  }): Promise<boolean> => {
    const { seq } = run;
    const dayErrands: Errand[] = [...run.userChosen];

    const isLocated = (e: Errand) =>
      e.latitude != null &&
      e.longitude != null &&
      !isRemoteActivity(e.title, e.notes);

    // Day frame + corridor (same rule as the other paths): only send `now` once
    // the day is genuinely underway, so a fresh day still gets its morning.
    const planningToday = effectiveDate === todayISO();
    const localNow = currentHHMM();
    const dayUnderway = planningToday && !!planStartTime && localNow > planStartTime;
    const nowArg = dayUnderway ? localNow : undefined;
    const startForFrame = dayUnderway ? localNow : planStartTime;
    const startCoord = planStartLocation
      ? { latitude: planStartLocation.latitude, longitude: planStartLocation.longitude }
      : home
        ? { latitude: home.latitude, longitude: home.longitude }
        : null;
    const endCoord = planEndLocation
      ? { latitude: planEndLocation.latitude, longitude: planEndLocation.longitude }
      : home
        ? { latitude: home.latitude, longitude: home.longitude }
        : null;
    const composeCtx = buildContextPayload(context);
    if (composeCtx && !dayUnderway && startForFrame) composeCtx.wakeTime = startForFrame;

    if (dayErrands.length === 0) {
      tracePlan('V3 — nothing to plan, falling back', null);
      return false;
    }

    // ---- PHASE 2: ORDER (cheap brain) ------------------------------------
    const orderInput: OrderDayErrand[] = dayErrands.map((e) => {
      const fixed = errandTimeMode(e.startTime, e.endTime, e.durationMin) === 'at';
      return {
        id: e.id,
        title: e.title,
        startTime: fixed ? e.startTime ?? null : null,
        endTime: fixed ? e.endTime ?? null : null,
        durationMin: e.durationMin ?? null,
        address: isLocated(e) ? e.address ?? null : null,
        located: isLocated(e),
      };
    });
    tracePlan('V3 (2) ORDER — request', orderInput);
    const ordered = await orderDay({
      errands: orderInput,
      dayStart: { time: startForFrame, label: planStartLocation?.label },
      dayEnd: { time: planEndTime, label: planEndLocation?.label },
      home: home ? { label: home.label } : undefined,
      date: effectiveDate,
    });
    if (planSeqRef.current !== seq) return true;
    tracePlan('V3 (2) ORDER — response (ids)', ordered.order);

    const byId = new Map(dayErrands.map((e) => [e.id, e]));
    const fixedMin = (e: Errand) =>
      errandTimeMode(e.startTime, e.endTime, e.durationMin) === 'at'
        ? minutesOfDay(e.startTime)
        : null;
    // Reorder per the brain, then a deterministic guard: stable-sort so any two
    // FIXED-time errands sit in ascending clock order (the router needs that),
    // while everything flexible keeps the brain's order.
    const orderedErrands = (ordered.order.map((id) => byId.get(id)).filter(Boolean) as Errand[])
      .map((e, i) => ({ e, i }))
      .sort((a, b) => {
        const ta = fixedMin(a.e);
        const tb = fixedMin(b.e);
        if (ta != null && tb != null && ta !== tb) return ta - tb;
        return a.i - b.i;
      })
      .map((x) => x.e);

    // Every located errand carries its own pin; nothing else is searched, so
    // place-less blocks stay place-less (the user owns location choices).
    const altByCoordKey = new Map<string, ItineraryPlace[]>();

    // ---- ASSEMBLE + first COMMUTE ----------------------------------------
    // Located user errands become "anchors" (their venue is attached verbatim);
    // place-less ones are "tasks" (pinned time only).
    const anchorsById = new Map<string, AssembleAnchor>();
    const tasksById = new Map<string, AssembleTask>();
    for (const e of orderedErrands) {
      if (isLocated(e)) {
        anchorsById.set(e.id, {
          title: e.title,
          place: {
            name: e.address ?? e.title,
            address: e.address ?? undefined,
            coords: { latitude: e.latitude!, longitude: e.longitude! },
            photoUrl: e.photoUrl ?? undefined,
            rating: e.rating ?? undefined,
            ratingCount: e.ratingCount ?? undefined,
            priceLevel:
              typeof e.priceLevel === 'number'
                ? '$'.repeat(Math.max(1, e.priceLevel))
                : undefined,
            openingHours: e.openingHours ?? undefined,
          },
          startTime: e.startTime,
          endTime: e.endTime,
          durationMin: e.durationMin,
        });
      } else {
        tasksById.set(e.id, {
          title: e.title,
          startTime: e.startTime,
          endTime: e.endTime,
          durationMin: e.durationMin,
        });
      }
    }

    const dayAnchorCoords = collectDayAnchors({ errands, date: effectiveDate, home }).map(
      (a) => a.coords,
    );
    for (const e of orderedErrands) {
      if (isLocated(e)) dayAnchorCoords.push({ latitude: e.latitude!, longitude: e.longitude! });
    }
    if (startCoord) dayAnchorCoords.push(startCoord);
    if (endCoord) dayAnchorCoords.push(endCoord);

    const toBlock = (e: Errand): ComposedBlock => {
      const located = anchorsById.has(e.id);
      const tm = errandTimeMode(e.startTime, e.endTime, e.durationMin);
      return {
        title: e.title,
        kind: inferErrandKind(e.title, e.notes),
        flexibility: tm === 'at' ? 'fixed' : tm === 'between' ? 'window' : 'flexible',
        section: 'Your day',
        period: null,
        startTime: tm === 'at' ? e.startTime ?? null : null,
        endTime: null,
        durationMin: e.durationMin ?? null,
        description: e.notes ?? null,
        placement: located ? 'anchor' : 'home',
        anchorId: located ? e.id : null,
        taskId: located ? null : e.id,
        findQuery: null,
        area: null,
        userQuery: null,
      };
    };
    const firstBlocks = orderedErrands.map(toBlock);

    const assembleArgs = {
      date: effectiveDate,
      anchorsById,
      tasksById,
      dayAnchorCoords,
      start: startCoord,
      end: endCoord,
      home: home ? { latitude: home.latitude, longitude: home.longitude } : null,
    };

    const { itinerary: itin } = await assembleComposedDay({
      ...assembleArgs,
      blocks: firstBlocks,
      title: ordered.title || 'Your day',
      summary: ordered.summary || '',
      city: ordered.city || '',
    });
    if (planSeqRef.current !== seq) return true;
    if (!itin) return false;

    if (planStartLocation) {
      itin.startLocation = {
        label: planStartLocation.label,
        latitude: planStartLocation.latitude,
        longitude: planStartLocation.longitude,
      };
    }
    attachAlternatives(itin, altByCoordKey);

    setUsedAi(true);
    setDebug(null);
    const id = saveItinerary(itin);
    activatePlan(id);
    setSavedId(id);
    setItinerary(itin);
    const plannedIds = run.userChosen.filter((e) => e.source !== 'test').map((e) => e.id);
    if (plannedIds.length) setErrandsPlanned(plannedIds, effectiveDate);
    setSelectedErrandIds(new Set());
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
    setTimeout(() => snapTo(collapsedTop), 520);

    setLoading(false);
    setRoutesRefining(true);
    console.log(`[plan-trace] RECOMPUTE source=v3-bg seq=${seq}`);
    void (async () => {
      try {
        // Phase 4 — GROUND the ordered + located day (real travel + clock).
        const grounded = await recomputeItinerary(
          applyErrandTravelModes(itin, dayErrands, hasCar),
          contextFor(itin),
        );
        if (planSeqRef.current !== seq) return;
        let current = itin;
        if (grounded.refreshed) {
          current = grounded.itinerary;
          attachAlternatives(current, altByCoordKey);
          setItinerary(current);
          updateSavedItinerary(id, current);
        }

        // Phase 5 — FILL the day: weave in wake/meals/wind-down/sleep + gaps.
        const fillStops: FillStop[] = orderedErrands.map((e) => {
          const anchor = anchorsById.get(e.id);
          const tm = errandTimeMode(e.startTime, e.endTime, e.durationMin);
          return {
            ref: e.id,
            title: e.title,
            kind: inferErrandKind(e.title, e.notes),
            startTime: tm === 'at' ? e.startTime ?? null : null,
            endTime: tm === 'at' ? e.endTime ?? null : null,
            durationMin: e.durationMin ?? null,
            place: anchor?.place.name ?? null,
            located: !!anchor,
            fixed: tm === 'at',
          };
        });
        tracePlan('V3 (5) FILL — request', {
          date: effectiveDate,
          now: nowArg ?? null,
          stops: fillStops,
        });
        const filled = await fillDay({
          stops: fillStops,
          dayStart: { time: startForFrame, label: planStartLocation?.label },
          dayEnd: { time: planEndTime, label: planEndLocation?.label },
          context: composeCtx,
          home: home
            ? { label: home.label, latitude: home.latitude, longitude: home.longitude }
            : undefined,
          date: effectiveDate,
          now: nowArg,
        });
        if (planSeqRef.current !== seq) return;
        if (filled.blocks.length === 0) {
          tracePlan('V3 (5) FILL — empty, keeping routed day', null);
          return;
        }
        tracePlan('V3 (5) FILL — response (blocks)', filled.blocks);

        const { itinerary: filledItin, altByCoordKey: filledAlts } = await assembleComposedDay({
          ...assembleArgs,
          blocks: filled.blocks,
          title: filled.title || current.title || 'Your day',
          summary: filled.summary || current.summary || '',
          city: filled.city || current.city || '',
        });
        if (planSeqRef.current !== seq || !filledItin) return;
        filledItin.id = current.id;
        filledItin.startLocation = current.startLocation ?? filledItin.startLocation;
        // Keep the Phase-3 alternatives for stops the fill kept; add any new ones.
        for (const [k, v] of altByCoordKey) if (!filledAlts.has(k)) filledAlts.set(k, v);

        // Phase 6 — RE-COMMUTE the filled day.
        const refilled = await recomputeItinerary(
          applyErrandTravelModes(filledItin, dayErrands, hasCar),
          contextFor(filledItin),
        );
        if (planSeqRef.current !== seq) return;
        const out = refilled.refreshed ? refilled.itinerary : filledItin;
        attachAlternatives(out, filledAlts);
        setItinerary(out);
        updateSavedItinerary(id, out);
      } finally {
        if (planSeqRef.current === seq) setRoutesRefining(false);
      }
    })();
    return true;
  };

  /**
   * EXPERIMENTAL V4 pipeline (drawer "v4"). The ISOLATED single-call approach.
   * ONE grounded, high-thinking Gemini pass ({@link planDayV4}) returns the
   * WHOLE day — order, times, and gaps for the user's located errands — as a
   * compact block list. The client does only the deterministic bits:
   *   1. BUILD the itinerary KEEPING the brain's clock, attaching each located
   *      errand's own venue. Diem never searches venues; a block the brain named
   *      a spot for stays place-less with the suggestion shown as a hint.
   *   2. COMMUTE as a separate process: route once so real travel legs slot in
   *      and the clock re-cascades around the brain's intended schedule.
   *
   * Returns true once it produces a day; false only when there's nothing to
   * plan or the brain returns nothing, so `planIt` can fall through.
   */
  const runComposeV4 = async (run: {
    seq: number;
    text: string;
    userChosen: Errand[];
  }): Promise<boolean> => {
    const { seq, text, userChosen } = run;
    if (userChosen.length === 0) return false;
    console.log(`[plan-trace] V4 ENTER seq=${seq} (plannerMode=v4)`);

    const isLocated = (e: Errand) =>
      e.latitude != null &&
      e.longitude != null &&
      !isRemoteActivity(e.title, e.notes);

    // Day frame: only send `now` once the day is genuinely underway, so a fresh
    // day still gets its morning. The morning anchors on the user's REAL wake
    // time (profile) — NOT the plan-setup "start time", which defaults to
    // now-rounded and is just a corridor hint. Using it as the wake is what made
    // the day open at 07:15 instead of the user's actual 08:30.
    const planningToday = effectiveDate === todayISO();
    const localNow = currentHHMM();
    const dayUnderway = planningToday && !!planStartTime && localNow > planStartTime;
    const nowArg = dayUnderway ? localNow : undefined;
    const startForFrame = dayUnderway ? localNow : profileWakeTime || planStartTime;

    const composeCtx = buildContextPayload(context);
    // Keep the profile wake time buildContextPayload set (the user's real 08:30);
    // do NOT clobber it with the plan-setup start. When the day is already
    // underway the brain skips the morning anyway (it plans from `now`).

    // Located errands = fixed geography (anchors); everything else = tasks.
    // Free text is handed to the brain whole — V4 splits it into activities
    // itself (no separate decompose pass), keeping the flow to a single call.
    const located = userChosen.filter(isLocated);
    const locatedIds = new Set(located.map((e) => e.id));
    const taskErrands = userChosen.filter((e) => !locatedIds.has(e.id));
    const errandById = new Map(userChosen.map((e) => [e.id, e]));

    const anchors = located.map((e) => ({
      id: e.id,
      title: e.title,
      name: e.address ?? e.title,
      latitude: e.latitude,
      longitude: e.longitude,
      startTime: e.startTime,
      endTime: e.endTime,
      durationMin: e.durationMin,
      notes: e.notes,
      locationType: (e.placeId ? 'business' : undefined) as 'business' | undefined,
    }));
    const tasks = taskErrands.map((e) => ({
      id: e.id,
      title: e.title,
      startTime: e.startTime,
      endTime: e.endTime,
      durationMin: e.durationMin,
      notes: e.notes,
      atHome: isRemoteActivity(e.title, e.notes),
    }));

    tracePlan('V4 — single grounded brain (request)', {
      intent: text,
      date: effectiveDate,
      now: nowArg ?? null,
      anchors,
      tasks,
    });
    const plan = await planDayV4({
      intent: text,
      anchors,
      tasks,
      dayStart: { time: startForFrame, label: planStartLocation?.label },
      dayEnd: { time: planEndTime, label: planEndLocation?.label },
      context: composeCtx,
      home: home
        ? { label: home.label, latitude: home.latitude, longitude: home.longitude }
        : undefined,
      date: effectiveDate,
      now: nowArg,
    });
    if (planSeqRef.current !== seq) return true;
    if (plan.blocks.length === 0) {
      console.warn(
        `[plan-trace] V4 seq=${seq} — brain returned 0 blocks → FALLING BACK TO v2. ` +
          'Check the [plan-day-v4] warning above (function deployed? GEMINI_API_KEY set? timeout?).',
      );
      return false;
    }
    console.log(`[plan-trace] V4 seq=${seq} — brain returned ${plan.blocks.length} blocks; building day`);
    tracePlan('V4 — brain blocks (response)', plan.blocks);

    // Diem no longer searches venues — only the user's located errands carry a
    // place; every other block stays place-less (the brain's suggestion shows
    // as a hint the user can act on).
    const altByCoordKey = new Map<string, ItineraryPlace[]>();

    // ---- BUILD the itinerary, KEEPING the brain's clock ------------------
    const periodOf = (hhmm: string | null, fallback: string): string => {
      const m = hhmm ? minutesOfDay(hhmm) : null;
      if (m == null) return fallback;
      if (m < 12 * 60) return 'Morning';
      if (m < 17 * 60) return 'Afternoon';
      return 'Evening';
    };

    interface V4RawItem {
      title: string;
      kind: string;
      flexibility: TimeFlexibility;
      startTime: string | null;
      endTime: string | null;
      durationMinutes: number | null;
      windowStart: string | null;
      windowEnd: string | null;
      place: ItineraryPlace | undefined;
      description: string | null;
      period: string;
      /** The source errand id this block IS (b.ref), so the calendar can dedupe it. */
      errandId: string | null;
    }

    let lastPeriod = 'Morning';
    const rawItems: V4RawItem[] = plan.blocks.map((b: V4Block, i: number) => {
      const e = b.ref ? errandById.get(b.ref) : undefined;
      let startTime: string | null = b.start;
      let endTime: string | null = b.end;
      let windowStart: string | null = null;
      let windowEnd: string | null = null;
      let flexibility: TimeFlexibility = b.fixed ? 'fixed' : 'flexible';
      let durationMinutes: number | null = null;

      // The user's OWN errand timing is LAW — the brain's clock is only a hint
      // for it. A pinned errand keeps its pin; a "between" errand stays a window
      // the router places.
      if (e) {
        const tm = errandTimeMode(e.startTime, e.endTime, e.durationMin);
        if (tm === 'at') {
          startTime = e.startTime ?? b.start;
          endTime = e.endTime ?? b.end;
          flexibility = 'fixed';
        } else if (tm === 'between') {
          windowStart = e.startTime ?? null;
          windowEnd = e.endTime ?? null;
          startTime = null;
          endTime = null;
          flexibility = 'window';
          durationMinutes = e.durationMin ?? null;
        } else if (e.durationMin) {
          durationMinutes = e.durationMin;
        }
      }
      if (startTime && endTime) {
        const s = minutesOfDay(startTime);
        const en = minutesOfDay(endTime);
        if (s != null && en != null && en - s > 0) durationMinutes = en - s;
      }

      // Only the user's located errands carry a venue; everything else stays
      // place-less (Diem never searches on the user's behalf).
      let place: ItineraryPlace | undefined;
      if (e && isLocated(e)) {
        place = {
          name: e.address ?? e.title,
          address: e.address ?? undefined,
          coords: { latitude: e.latitude!, longitude: e.longitude! },
          photoUrl: e.photoUrl ?? undefined,
          rating: e.rating ?? undefined,
          ratingCount: e.ratingCount ?? undefined,
          priceLevel:
            typeof e.priceLevel === 'number'
              ? '$'.repeat(Math.max(1, e.priceLevel))
              : undefined,
          openingHours: e.openingHours ?? undefined,
        };
      }

      // A place-less block the brain named a spot for: surface the suggestion
      // as a hint so the user can pick the business themselves.
      let description: string | null = null;
      if (!place && b.place) {
        const sugg = [b.place, ...b.alts].slice(0, 3).join(', ');
        description = `Pick a place${b.area ? ` in ${b.area}` : ''} — e.g. ${sugg}`;
      }

      const period = periodOf(startTime ?? windowStart, lastPeriod);
      lastPeriod = period;

      return {
        title: b.title,
        kind: b.kind === 'errand' ? 'activity' : b.kind,
        flexibility,
        startTime,
        endTime,
        durationMinutes,
        windowStart,
        windowEnd,
        place,
        description,
        period,
        errandId: b.ref ?? null,
      };
    });

    // Group consecutive blocks of the same period into sections (Morning /
    // Afternoon / Evening) — purely cosmetic for the rail.
    const grouped: { title: string; period: string; items: V4RawItem[] }[] = [];
    for (const it of rawItems) {
      const last = grouped[grouped.length - 1];
      if (last && last.period === it.period) last.items.push(it);
      else grouped.push({ title: it.period, period: it.period, items: [it] });
    }

    const itin = sanitizeItinerary({
      title: plan.title || 'Your day',
      summary: plan.summary || '',
      date: effectiveDate,
      city: plan.city || '',
      sections: grouped.map((s) => ({
        title: s.title,
        period: s.period,
        items: s.items,
      })),
    });
    if (planSeqRef.current !== seq) return true;
    if (!itin) {
      tracePlan('V4 — assembly produced nothing, falling back', null);
      return false;
    }
    if (planStartLocation) {
      itin.startLocation = {
        label: planStartLocation.label,
        latitude: planStartLocation.latitude,
        longitude: planStartLocation.longitude,
      };
    }
    attachAlternatives(itin, altByCoordKey);

    setUsedAi(true);
    setDebug(null);
    const id = saveItinerary(itin);
    activatePlan(id);
    setSavedId(id);
    setItinerary(itin);
    const plannedIds = userChosen.filter((e) => e.source !== 'test').map((e) => e.id);
    if (plannedIds.length) setErrandsPlanned(plannedIds, effectiveDate);
    setSelectedErrandIds(new Set());
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
    setTimeout(() => snapTo(collapsedTop), 520);

    // ---- COMMUTE (separate process): real travel legs + clock cascade ----
    setLoading(false);
    setRoutesRefining(true);
    console.log(`[plan-trace] RECOMPUTE source=v4-bg seq=${seq}`);
    void (async () => {
      try {
        const grounded = await recomputeItinerary(
          applyErrandTravelModes(itin, userChosen, hasCar),
          contextFor(itin),
        );
        if (planSeqRef.current !== seq) return;
        if (grounded.refreshed) {
          const current = grounded.itinerary;
          attachAlternatives(current, altByCoordKey);
          setItinerary(current);
          updateSavedItinerary(id, current);
        }
      } finally {
        if (planSeqRef.current === seq) setRoutesRefining(false);
      }
    })();
    return true;
  };

  const planIt = async (overrideErrandIds?: Set<string>) => {
    if (loading) return;
    // The day's backbone is the located errands the user ticked in the drawer.
    // The test harness passes an explicit id set so a debug run plans with
    // EXACTLY its seeded errands, ignoring whatever else is on the date.
    const chosenIds = overrideErrandIds ?? selectedErrandIds;
    const userChosen = errands.filter(
      (e) => chosenIds.has(e.id) && !e.done && e.source !== 'freestyle',
    );
    if (userChosen.length === 0) return;
    // Sweep any leftover freestyle errands for this day (legacy data from the
    // old free-text planner) so they can't sneak into a plan.
    errands
      .filter((e) => e.source === 'freestyle' && e.date === effectiveDate)
      .forEach((e) => removeErrand(e.id));

    Haptics.selectionAsync().catch(() => undefined);
    // Anything that was already in flight is no longer relevant; bump the seq
    // so a slow recompute from a previous plan can't slot itself in after
    // this one has rendered.
    const seq = ++planSeqRef.current;
    console.log(
      `[plan-trace] START source=planIt seq=${seq} date=${effectiveDate} chosen=${userChosen.length} routeId=${params.id ?? 'none'}`,
    );
    setLoading(true);
    setErrorMsg(null);
    setV4FellBack(false);
    setSavedId(null);
    resetTracking();
    snapTo(expandedTop); // show the skeleton full-height while we work
    try {
      // EXPERIMENTAL V4 (drawer selector): ONE grounded brain does order +
      // times + gaps; the client routes. Owns the plan when on; only falls
      // through if there's genuinely nothing to do.
      if (plannerMode === 'v4') {
        const handled = await runComposeV4({ seq, text: '', userChosen });
        if (handled) return;
        // v4 was chosen but couldn't finalise (timeout/error → 0 blocks). We
        // still build *a* day below so the user isn't stranded, but flag it so
        // the header shows this ISN'T the v4 plan they asked for.
        if (planSeqRef.current === seq) setV4FellBack(true);
        console.warn(
          `[plan-trace] V4 seq=${seq} did not finalise — using fallback pipeline. ` +
            'See the [plan-day-v4] warning above for why (timeout >145s / function error).',
        );
      }
      // EXPERIMENTAL V3 (drawer selector): staged order → route → fill. When on
      // it owns the plan; only falls through if there's nothing to do.
      if (plannerMode === 'v3') {
        const handled = await runComposeV3({ seq, text: '', userChosen });
        if (handled) return;
      }
      // UNIFIED COMPOSE (flag-gated): one brain + deterministic route. Handles
      // the whole plan when it succeeds; falls through to the legacy pipeline
      // below if the brain returns nothing usable.
      if (UNIFIED_COMPOSE) {
        const handled = await runUnifiedCompose({ seq, text: '', userChosen });
        if (handled) return;
      }
      // Located errands carry their own pin; nothing is searched. No free-text,
      // no decompose — the planner only orders/times what the user chose.
      const altByCoordKey = new Map<string, ItineraryPlace[]>();
      // Split the chosen errands into ANCHORS (located: their pin is placed
      // VERBATIM) and TASKS (remote/at-home: a call, telehealth, remote work —
      // scheduled at home, never given a venue). Every user errand now carries a
      // concrete pin unless it's remote, so there's nothing left to search.
      const anchors: PlanAnchor[] = [];
      const tasks: PlanTask[] = [];
      for (const e of userChosen) {
        if (isRemoteActivity(e.title, e.notes)) {
          tasks.push({
            title: e.title,
            startTime: e.startTime,
            endTime: e.endTime,
            durationMin: e.durationMin,
            notes: e.notes,
            atHome: true,
          });
        } else if (e.address && e.latitude != null && e.longitude != null) {
          anchors.push({
            title: e.title,
            name: e.address,
            latitude: e.latitude,
            longitude: e.longitude,
            startTime: e.startTime,
            endTime: e.endTime,
            durationMin: e.durationMin,
            notes: e.notes,
            // A resolved Google place is a business; a typed address with no
            // placeId we leave unset (the backend defaults to business).
            ...(e.placeId ? { locationType: 'business' as const } : {}),
            photoUrl: e.photoUrl,
            rating: e.rating,
            ratingCount: e.ratingCount,
            openingHours: e.openingHours,
          });
        } else {
          // No coords (legacy/edge data) → a place-less task; never searched.
          tasks.push({
            title: e.title,
            startTime: e.startTime,
            endTime: e.endTime,
            durationMin: e.durationMin,
            notes: e.notes,
          });
        }
      }

      // The day counts as ALREADY UNDERWAY only once the current time (real wall
      // clock OR the dev fake clock) is PAST the user's head-out time. Only then
      // do we send `now`, so the planner trims to the remainder and skips the
      // morning. At/before head-out — or any future day — it's a FRESH day: send
      // no `now`, so the planner opens with the morning routine and builds the
      // whole day. (This is what lets a fake clock pinned to the morning still
      // rehearse wake → prep → breakfast.)
      const planningToday = effectiveDate === todayISO();
      const localNow = currentHHMM();
      const dayUnderway =
        planningToday && !!planStartTime && localNow > planStartTime;
      const nowArg = dayUnderway ? localNow : undefined;
      const startForFrame = dayUnderway ? localNow : planStartTime;

      // The day frame from the setup drawer: where/when the day starts and
      // should finish. The planner places the first block around the start and
      // routes the day to the right finish.
      const dayStart: PlanDayEdge = { time: startForFrame };
      if (planStartLocation?.label) dayStart.label = planStartLocation.label;
      const dayEnd: PlanDayEdge = { time: planEndTime };
      if (planEndLocation?.label) dayEnd.label = planEndLocation.label;

      // The full, UNORDERED building blocks the planner receives: the day frame
      // + every anchor (placed) and task (unplaced / at-home), with coords. This
      // is the dataset to copy into AI Studio to iterate on ordering/routing —
      // it is deliberately NOT connected or time-sequenced yet.
      tracePlan('(6) PLANNER INPUT — copy this whole block into AI Studio', {
        intent: '',
        date: effectiveDate,
        now: nowArg ?? null,
        dayStart: {
          time: dayStart.time ?? null,
          label: planStartLocation?.label ?? dayStart.label ?? null,
          latitude: planStartLocation?.latitude ?? null,
          longitude: planStartLocation?.longitude ?? null,
        },
        dayEnd: {
          time: dayEnd.time ?? null,
          label: planEndLocation?.label ?? dayEnd.label ?? null,
          latitude: planEndLocation?.latitude ?? null,
          longitude: planEndLocation?.longitude ?? null,
        },
        home: home
          ? { label: home.label, latitude: home.latitude, longitude: home.longitude }
          : null,
        anchors,
        tasks,
      });

      const result = await planItinerary('', {
        context,
        date: effectiveDate,
        now: nowArg,
        anchors,
        tasks,
        dayStart,
        dayEnd,
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
      tracePlan(
        '(7) planner RESULT — produced order (pre-routing)',
        itin.sections
          .flatMap((s) => s.items)
          .map((it, i) => ({
            i,
            start: it.startTime ?? null,
            end: it.endTime ?? null,
            kind: it.kind,
            title: it.title,
            place: it.place?.name ?? null,
          })),
      );

      // Bake the chosen start into the plan so reopening/editing it later always
      // routes the first leg from the same origin — not from wherever the global
      // planner-setup drawer is pointed at the time.
      if (planStartLocation) {
        itin.startLocation = {
          label: planStartLocation.label,
          latitude: planStartLocation.latitude,
          longitude: planStartLocation.longitude,
        };
      }

      // Re-attach the carried alternative venues onto the matching auto-placed
      // stops (the planner emits its own places, so they don't survive the
      // round-trip otherwise).
      attachAlternatives(itin, altByCoordKey);

      // OPTIMISTIC SHOW. Save and render the model output the instant Gemini
      // returns, so the user sees their day 2-5 seconds sooner. Routing then
      // runs in the BACKGROUND (no await on this code path — see below) and
      // swaps real Google Routes data into the same itinerary id when it's
      // done. The cards may shift slightly when that happens (travel stubs
      // strip, clock re-cascades) — the `routesRefining` pill hints at that.
      const id = saveItinerary(itin);
      // The day the user just generated IS the day they want for this date —
      // make it the active plan so the home card + "open today" surface THIS
      // plan, not the earliest-created one for the date (which left a stale
      // older plan winning, e.g. one with no morning routine). They can still
      // switch between same-day plans from the day-plans screen.
      activatePlan(id);
      setSavedId(id);
      setItinerary(itin);
      // The chosen errands are now folded into this plan: mark them "Planned"
      // (they move to the Completed group; pull one back to re-include it) and
      // clear the ticks so a later replan doesn't re-add a stale selection.
      // Debug ('test') errands persist: they're never marked Planned, so they
      // stay put for the next reproducible run (only a manual delete or re-seed
      // removes them). Real + freestyle errands move to Planned as usual.
      const plannedIds = userChosen
        .filter((e) => e.source !== 'test')
        .map((e) => e.id);
      if (plannedIds.length) {
        setErrandsPlanned(plannedIds, effectiveDate);
      }
      setSelectedErrandIds(new Set());
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
      console.log(`[plan-trace] RECOMPUTE source=planIt-bg seq=${seq}`);
      void recomputeItinerary(applyErrandTravelModes(itin, userChosen, hasCar), contextFor(itin))
        .then((refreshed) => {
          if (planSeqRef.current !== seq) return;
          if (!refreshed.refreshed) return;
          // Routing rebuilds the itinerary, so re-attach alternatives onto it.
          attachAlternatives(refreshed.itinerary, altByCoordKey);
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

  // --- DEV test harness: auto-plan on entry ---------------------------------
  // When Settings → "Generate test plan" seeds the day and pushes here with
  // `autoplan=1`, kick off planning automatically once the seeded DEBUG errands
  // (source 'test') are in the store. The run uses EXACTLY those errands — any
  // real errands on the date are ignored — so it's fully controlled and
  // reproducible. Guarded by a ref so it fires once per mount; a fresh tap
  // remounts and plans again.
  const autoplanRef = useRef(false);
  useEffect(() => {
    if (autoplanRef.current) return;
    if (params.autoplan !== '1' || preloaded) return;
    const testErrands = dayErrands.filter((e) => e.source === 'test');
    if (testErrands.length === 0) return; // not seeded into the store yet
    autoplanRef.current = true;
    const ids = new Set(testErrands.map((e) => e.id));
    setSelectedErrandIds(ids); // reflect the debug selection in the drawer
    void planIt(ids);
    // planIt is intentionally omitted: this is a one-shot guarded by autoplanRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.autoplan, preloaded, dayErrands]);

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
    // Re-preselect the day's errands so the fresh planning pass starts the same
    // way a first visit does (planning cleared the selection on success).
    seedSelectedErrands();
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
        console.log(
          `[plan-trace] RECOMPUTE source=applyOps editSeq=${mySeq} ops=${ops.map((o) => o.type).join(',')}`,
        );
        const { itinerary: refreshed, refreshed: didRefresh } = await recomputeItinerary(
          current,
          contextFor(current),
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
        // If the real, time-aware commutes still overrun a FIXED anchor after
        // the gaps were shrunk, we keep the cascaded day as-is and let the
        // conflict banner surface it — no auto-escalation to a planner rerun.
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
    [itinerary, persist, showUndo, contextFor],
  );
  /** Convenience: most callers only have one op. */
  const applyEdit = useCallback((op: EditOp) => applyOps([op]), [applyOps]);

  // Pick one of the carried alternative venues straight from the card. Swaps to
  // the chosen place and keeps the rest of the pool (incl. the place we just
  // left) as its new alternatives, so the strip stays useful across swaps.
  const handlePickAlternative = useCallback(
    (target: ItineraryItem, chosen: ItineraryPlace) => {
      const current = target.place;
      const pool: ItineraryPlace[] = [];
      if (current) pool.push({ ...current, alternatives: undefined });
      for (const alt of current?.alternatives ?? []) {
        pool.push({ ...alt, alternatives: undefined });
      }
      const samePlace = (a: ItineraryPlace, b: ItineraryPlace) =>
        a.name === b.name &&
        Math.abs((a.coords?.latitude ?? 0) - (b.coords?.latitude ?? 0)) < 1e-6 &&
        Math.abs((a.coords?.longitude ?? 0) - (b.coords?.longitude ?? 0)) < 1e-6;
      const nextAlts = pool.filter((p) => !samePlace(p, chosen));
      Haptics.selectionAsync().catch(() => undefined);
      applyEdit({
        type: 'replacePlace',
        id: target.id,
        place: { ...chosen, alternatives: nextAlts.length ? nextAlts : undefined },
      });
    },
    [applyEdit],
  );

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
        console.log(
          `[plan-trace] START source=runReplan editSeq=${mySeq} text=${JSON.stringify(text.slice(0, 48))}`,
        );
        const basis = describeItineraryForReplan(itinerary);
        const request = `${basis}\n\nAdjustment requested: ${text}`;
        const result = await planItinerary(request, {
          context: contextFor(itinerary),
          date: todayISO(),
          fast: true,
        });
        if (mySeq !== editSeqRef.current) return;
        if (result.itinerary) {
          // A replan keeps the day's original starting point.
          result.itinerary.startLocation = itinerary.startLocation;
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
    [itinerary, contextFor, persist, showUndo],
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

  // Group header for the day's errands, e.g. "Today · Jun 10" / "Sat · Jun 14".
  const dayMeta = describeDay(effectiveDate);
  const dayGroupLabel = `${dayMeta.title} · ${dayMeta.dateLabel}`;
  const startLabel = planStartLocation?.label ?? 'Current location';
  // The compact when/where controls + errands view share the "no plan yet"
  // state; once a plan exists the timeline + AdjustBar take over.
  const showPlanLanding = !itinerary && !loading;

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
          { backgroundColor: t.colors.background, borderColor: t.colors.separator },
        ]}
      >
        <GestureDetector gesture={pan}>
          <View style={styles.handleArea}>
            <View style={[styles.grabber, { backgroundColor: t.colors.separator }]} />
            <View style={styles.sheetHeader}>
              <View style={{ flex: 1 }}>
                <Text variant="micro" tone="tertiary" uppercase weight="bold">
                  {loading
                    ? 'Planning'
                    : v4FellBack
                      ? 'Sandbox · v4 → fallback'
                      : `Sandbox · ${plannerMode}`}
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

            {showPlanLanding ? (
              <View style={styles.whenRow}>
                <Pressable
                  onPress={() => openSetup(0)}
                  style={({ pressed }) => [
                    styles.whenChip,
                    { backgroundColor: t.colors.fill1 },
                    pressed && { opacity: 0.6 },
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel="Change the day and start time"
                >
                  <Ionicons name="calendar-outline" size={14} color={t.colors.accent} />
                  <Text variant="caption" weight="semibold" numberOfLines={1} style={styles.whenChipText}>
                    {whenSummary}
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => openSetup(1)}
                  style={({ pressed }) => [
                    styles.whenChip,
                    { backgroundColor: t.colors.fill1 },
                    pressed && { opacity: 0.6 },
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel="Change the start and end address"
                >
                  <Ionicons name="navigate-circle-outline" size={14} color={t.colors.accent} />
                  <Text variant="caption" weight="semibold" numberOfLines={1} style={styles.whenChipText}>
                    {startLabel}
                  </Text>
                </Pressable>
              </View>
            ) : null}

            {showPlanLanding ? (
              <View style={[styles.v3Row, { backgroundColor: t.colors.fill1 }]}>
                <View style={{ flex: 1 }}>
                  <Text variant="caption" weight="semibold">
                    Planner pipeline (test)
                  </Text>
                  <Text variant="micro" tone="tertiary">
                    {PLANNER_MODE_HINT[plannerMode]}
                  </Text>
                </View>
                <View style={[styles.modeSegment, { backgroundColor: t.colors.fill2 }]}>
                  {(['v2', 'v3', 'v4'] as const).map((m) => {
                    const active = plannerMode === m;
                    return (
                      <Pressable
                        key={m}
                        onPress={() => {
                          Haptics.selectionAsync().catch(() => undefined);
                          setPlannerMode(m);
                        }}
                        hitSlop={6}
                        style={[
                          styles.modePill,
                          active && { backgroundColor: t.colors.accent },
                        ]}
                      >
                        <Text
                          variant="caption"
                          weight="bold"
                          style={{
                            color: active ? t.colors.textOnAccent : t.colors.textSecondary,
                          }}
                        >
                          {m}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            ) : null}

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
            // Leave room for the floating bottom bar (adjust / plan composer)
            // so the last row always clears it.
            paddingBottom: insets.bottom + (itinerary ? 132 : 104),
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
            <View style={styles.errandsWrap}>
              {dayErrands.length + anytimeErrands.length > 0 ? (
                <Text variant="caption" tone="tertiary" style={styles.errandsSelectHint}>
                  Tap an errand to add it into this plan · tap the arrow to edit.
                </Text>
              ) : null}
              {selectedErrandIds.size > 0 ? (
                <DayBalanceCard score={planScore} surface="plain" />
              ) : null}
              {recurringDay.length > 0 ? (
                <ErrandGroup
                  label={`Repeats · ${dayMeta.title}`}
                  count={recurringDay.length}
                  items={recurringDay}
                  emptyHint=""
                  repeats
                  onEdit={onEditErrand}
                  onToggle={toggleErrandDone}
                  selectedIds={selectedErrandIds}
                  onToggleSelect={toggleErrandSelected}
                />
              ) : null}
              <ErrandGroup
                label={dayGroupLabel}
                count={dayOnlyErrands.length}
                items={dayOnlyErrands}
                emptyHint={
                  recurringDay.length > 0
                    ? 'No other errands for this day.'
                    : 'Nothing for this day yet — add errands from home, then plan below.'
                }
                onEdit={onEditErrand}
                onToggle={toggleErrandDone}
                selectedIds={selectedErrandIds}
                onToggleSelect={toggleErrandSelected}
              />
              <ErrandGroup
                label="Anytime"
                count={anytimeErrands.length}
                items={anytimeErrands}
                emptyHint="No loose errands waiting."
                onEdit={onEditErrand}
                onToggle={toggleErrandDone}
                selectedIds={selectedErrandIds}
                onToggleSelect={toggleErrandSelected}
              />
              {completedErrands.length > 0 ? (
                <ErrandGroup
                  label="Completed"
                  count={completedErrands.length}
                  items={completedErrands}
                  emptyHint=""
                  onEdit={onEditErrand}
                  onToggle={toggleErrandDone}
                  completed
                  today={todayIso}
                  onReopen={reopenErrand}
                  collapsible
                  collapsed={!showCompletedErrands}
                  onToggleCollapse={() => {
                    Haptics.selectionAsync().catch(() => undefined);
                    setShowCompletedErrands((v) => !v);
                  }}
                />
              ) : null}
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
                  dayDate={itinerary.date}
                  index={si}
                  gapsById={gapsById}
                  continuationIds={continuationIds}
                  conflictIds={conflictIds}
                  glow={glowPulse}
                  nowItemId={nowItemId}
                  nowLegId={nowLegId}
                  nowAbs={nowAbs}
                  absById={absById}
                  pastIds={pastIds}
                  sectionActive={si === nowSectionIndex}
                  sectionPast={
                    section.items.length > 0 &&
                    section.items.every((it) => (absById[it.id]?.end ?? Infinity) <= nowAbs)
                  }
                  rearrangeMode={rearrangeMode}
                  onEnterRearrange={enterRearrange}
                  onPickAlternative={handlePickAlternative}
                  onOpenMenu={(it) => {
                    Haptics.selectionAsync().catch(() => undefined);
                    setMenuItemId(it.id);
                  }}
                  onPressLeg={(it) => {
                    Haptics.selectionAsync().catch(() => undefined);
                    setLegMenuId(it.id);
                  }}
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
                  onLegLayout={(id, relY, h) => {
                    legRawRef.current[id] = { relY, h };
                    recomputeTimeFill();
                  }}
                  onLegStepsGeometry={(id, rects) => {
                    legStepsRef.current[id] = rects;
                    recomputeTimeFill();
                  }}
                />
              ))}

              {debug ? (
                <Card padded style={{ marginTop: 18, marginLeft: RAIL.contentLeft }}>
                  <Pressable
                    onPress={() => {
                      Haptics.selectionAsync().catch(() => undefined);
                      setShowDebug((v) => !v);
                    }}
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

      {/* The plan actions take the bottom while there's no plan yet: add a new
          errand for the day, or build the day from the ticked errands. Once a
          day is built the AdjustBar above replaces this. */}
      {showPlanLanding ? (
        <View
          pointerEvents="box-none"
          style={[styles.planActions, { paddingBottom: Math.max(insets.bottom, 16) }]}
        >
          <Button
            title="New errand"
            variant="secondary"
            onPress={openNewErrand}
            leftIcon={<Ionicons name="add" size={18} color={t.colors.accent} />}
            style={styles.planActionBtn}
          />
          <Button
            title="Plan my day"
            onPress={() => planIt()}
            loading={loading}
            disabled={selectedErrandIds.size === 0}
            style={styles.planActionBtn}
          />
        </View>
      ) : null}

      {/* One "..." entry point (also the whole card), two sheets: gaps get the
          gap-specific actions (name / resize / split), every other block gets
          the standard ones — including the inline place editor. */}
      <ItemActionsSheet
        item={menuItem && menuItem.kind !== 'gap' ? menuItem : null}
        city={itinerary?.city}
        date={itinerary?.date}
        searchCenter={menuSearch.center}
        prevCoords={menuSearch.prev}
        nextCoords={menuSearch.next}
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
        onSetPlace={(place) => {
          if (!menuItem) return;
          setMenuItemId(null);
          applyEdit({ type: 'replacePlace', id: menuItem.id, place });
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

      <PlanSetupSheet
        open={setupOpen}
        onClose={() => setSetupOpen(false)}
        onConfirm={(selection) => {
          setDayPlan(selection);
          setSetupOpen(false);
        }}
        initialDate={effectiveDate}
        initialTime={planStartTime}
        initialStep={setupStep}
        selectedErrandIds={selectedErrandIds}
      />

      <ErrandDrawer
        open={errandDrawerOpen}
        onClose={() => setErrandDrawerOpen(false)}
        draft={errandSeed}
        rawText={errandRawText}
        parsing={false}
        seedKey={errandSeedKey}
        mode={errandDrawerMode}
        currentErrandId={editErrandId}
        fallbackCenter={home ? { latitude: home.latitude, longitude: home.longitude } : null}
        onSave={onSaveErrand}
        onDelete={errandDrawerMode === 'edit' ? onDeleteErrand : undefined}
      />
    </View>
  );
}

/**
 * One group in the pre-plan drawer view: a small uppercase header with a count
 * pill, then the day's (or anytime) errands rendered as tappable rows. Empty
 * groups fall back to a soft dashed hint so the section structure stays legible.
 */
function ErrandGroup({
  label,
  count,
  items,
  emptyHint,
  onEdit,
  onToggle,
  selectedIds,
  onToggleSelect,
  repeats = false,
  completed = false,
  today,
  onReopen,
  collapsible = false,
  collapsed = false,
  onToggleCollapse,
}: {
  label: string;
  count: number;
  items: Errand[];
  emptyHint: string;
  /** Tap a row body to open it for editing. */
  onEdit: (errand: Errand) => void;
  onToggle: (id: string) => void;
  /** When provided, rows become selectable (tap the circle to fold into plan). */
  selectedIds?: Set<string>;
  onToggleSelect?: (id: string) => void;
  /** Badge every row with the recurring "repeat" glyph (the Repeats section). */
  repeats?: boolean;
  /** Completed mode: rows show a status tag + pull-back, and aren't selectable. */
  completed?: boolean;
  today?: string;
  onReopen?: (id: string) => void;
  /** Collapsible header (used by the Completed group). */
  collapsible?: boolean;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}) {
  const t = useTheme();
  const selectable = !completed && !!onToggleSelect;
  return (
    <View style={styles.errandGroup}>
      <Pressable
        disabled={!collapsible}
        onPress={onToggleCollapse}
        accessibilityRole={collapsible ? 'button' : undefined}
        style={styles.errandGroupHead}
      >
        <Text
          variant="micro"
          uppercase
          weight="bold"
          tone="secondary"
          style={{ letterSpacing: 1.2 }}
        >
          {label}
        </Text>
        {count > 0 ? (
          <View style={[styles.errandCountPill, { backgroundColor: t.colors.fill1 }]}>
            <Text variant="micro" weight="bold" tone="secondary">
              {count}
            </Text>
          </View>
        ) : null}
        {collapsible ? (
          <Ionicons
            name={collapsed ? 'chevron-down' : 'chevron-up'}
            size={15}
            color={t.colors.textTertiary}
          />
        ) : null}
      </Pressable>
      {collapsed ? null : items.length > 0 ? (
        <Card tier="surface2" style={styles.errandsCard}>
          {items.map((errand, i) => (
            <ErrandRow
              key={errand.id}
              errand={errand}
              repeats={repeats}
              onPress={completed ? undefined : () => onEdit(errand)}
              onToggleDone={() => onToggle(errand.id)}
              showSeparator={i < items.length - 1}
              dimWhenDone={false}
              selectable={selectable}
              selected={selectedIds?.has(errand.id) ?? false}
              onToggleSelect={
                selectable ? () => onToggleSelect?.(errand.id) : undefined
              }
              status={completed && today ? errandStatus(errand, today) : undefined}
              onReopen={completed && onReopen ? () => onReopen(errand.id) : undefined}
            />
          ))}
        </Card>
      ) : (
        <View style={[styles.errandEmpty, { borderColor: t.colors.separator }]}>
          <Text variant="caption" tone="tertiary">
            {emptyHint}
          </Text>
        </View>
      )}
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
        <Pressable
          onPress={() => {
            Haptics.selectionAsync().catch(() => undefined);
            onResolve(head);
          }}
          hitSlop={6}
        >
          <Text variant="caption" weight="bold" style={{ color: t.colors.warning }}>
            {action}
          </Text>
        </Pressable>
        <Pressable
          onPress={() => {
            Haptics.selectionAsync().catch(() => undefined);
            onDismiss();
          }}
          hitSlop={8}
          style={styles.conflictDismiss}
        >
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
        <Pressable
          onPress={() => {
            Haptics.selectionAsync().catch(() => undefined);
            onConfirm();
          }}
          hitSlop={6}
        >
          <Text variant="caption" weight="bold" style={{ color: t.colors.accent }}>
            Ask the planner →
          </Text>
        </Pressable>
        <Pressable
          onPress={() => {
            Haptics.selectionAsync().catch(() => undefined);
            onDismiss();
          }}
          hitSlop={8}
          style={styles.conflictDismiss}
        >
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
      onPress={() => {
        Haptics.selectionAsync().catch(() => undefined);
        onPress();
      }}
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
  dayDate,
  continuationIds,
  index,
  gapsById,
  conflictIds,
  glow,
  nowItemId,
  nowLegId,
  nowAbs,
  absById,
  pastIds,
  sectionActive,
  sectionPast,
  rearrangeMode,
  onEnterRearrange,
  onPickAlternative,
  onOpenMenu,
  onPressLeg,
  onAddGap,
  onSectionLayout,
  onItemLayout,
  onCardLayout,
  onLegLayout,
  onLegStepsGeometry,
}: {
  section: ItinerarySection;
  first: boolean;
  /** The day's date ("YYYY-MM-DD"), used for the venue opening-hours check. */
  dayDate?: string;
  continuationIds: Set<string>;
  index: number;
  gapsById: Record<string, number>;
  /** Item ids the latest cascade flagged as conflicting (fixed-anchor overrun, etc.). */
  conflictIds: Set<string>;
  glow: SharedValue<number>;
  nowItemId: string | null;
  /** Item whose incoming commute is happening right now (glows the connector). */
  nowLegId: string | null;
  /** Wall clock on the unwrapped (midnight-aware) axis. */
  nowAbs: number;
  /** Unwrapped start/end per item id — used for the active hop's depart anchor. */
  absById: Record<string, AbsSpan>;
  /** Item ids whose block has already finished (dimmed). */
  pastIds: Set<string>;
  sectionActive: boolean;
  sectionPast: boolean;
  /** True only in rearrange mode; here it just suppresses card taps (the drag
   *  view itself is rendered separately by the parent). */
  rearrangeMode: boolean;
  /** Long-press a card -> enter rearrange mode. */
  onEnterRearrange: () => void;
  /** Tap an alternative venue thumbnail → swap the card's place to it. */
  onPickAlternative: (item: ItineraryItem, place: ItineraryPlace) => void;
  /** Tap a card (or its "...") → open the per-card actions sheet. */
  onOpenMenu: (item: ItineraryItem) => void;
  /** Tap a travel connector → open the mode picker for that leg. */
  onPressLeg: (item: ItineraryItem) => void;
  /** Tap a "free time" connector → fill it with a named gap before that item. */
  onAddGap: (beforeId: string, minutes: number) => void;
  onSectionLayout: (y: number) => void;
  onItemLayout: (id: string, y: number) => void;
  onCardLayout: (id: string, relY: number, h: number) => void;
  /** Reports the commute row's offset/height within the item wrapper. */
  onLegLayout: (id: string, relY: number, h: number) => void;
  /** Reports each commute step's time window + pixel band (relative to leg top). */
  onLegStepsGeometry: (id: string, rects: StepRect[]) => void;
}) {
  const t = useTheme();
  const base = Math.min(index * 50, 150);
  return (
    <>
      <Animated.View
        entering={FadeInDown.duration(280).delay(base)}
        style={{ marginTop: first ? 16 : 30 }}
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
        // True while you're mid-commute TO this item: the connector glows and
        // the (not-yet-reached) destination card's glow is held back.
        const legActive = item.id === nowLegId;
        const past = pastIds.has(item.id);
        const leg = item.travelFromPrev;
        const isGapItem = item.kind === 'gap';
        // Absolute departure for this item's incoming leg, so the commute's hops
        // can be unwrapped onto the same midnight-aware axis as the rail.
        const legStartAbs =
          leg && absById[item.id]?.start != null
            ? (absById[item.id]!.start as number) - leg.minutes
            : undefined;
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
            style={{ marginTop: 12 }}
            onLayout={(e) => onItemLayout(item.id, e.nativeEvent.layout.y)}
          >
            <View>
              {!isGapItem && gapsById[item.id] ? (
                <GapRow
                  minutes={gapsById[item.id]}
                  past={past}
                  onPress={
                    rearrangeMode ? undefined : () => onAddGap(item.id, gapsById[item.id])
                  }
                />
              ) : null}
              {leg ? (
                <View
                  onLayout={(e) =>
                    onLegLayout(item.id, e.nativeEvent.layout.y, e.nativeEvent.layout.height)
                  }
                >
                  <TravelLegRow
                    leg={leg}
                    leaveBy={leaveBy}
                    active={legActive && !rearrangeMode}
                    past={past}
                    glow={glow}
                    nowAbs={nowAbs}
                    legStartAbs={legStartAbs}
                    onStepsGeometry={(rects) => onLegStepsGeometry(item.id, rects)}
                    onPress={rearrangeMode ? undefined : () => onPressLeg(item)}
                  />
                </View>
              ) : null}
              <Pressable
                onPress={rearrangeMode ? undefined : () => onOpenMenu(item)}
                onLongPress={rearrangeMode ? undefined : onEnterRearrange}
                delayLongPress={350}
                style={({ pressed }) => [
                  styles.cardWrap,
                  past && styles.pastDim,
                  pressed && !rearrangeMode && { opacity: 0.92 },
                ]}
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
                    dayDate={dayDate}
                    isContinuation={continuationIds.has(item.id)}
                    onPickAlternative={
                      rearrangeMode
                        ? undefined
                        : (place) => onPickAlternative(item, place)
                    }
                    onOpenMenu={rearrangeMode ? undefined : () => onOpenMenu(item)}
                    hasConflict={conflictIds.has(item.id)}
                  />
                )}
                {active && !rearrangeMode && !legActive ? <CardGlow glow={glow} /> : null}
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

/**
 * Pulsing highlight over the single commute hop you're riding right now (the
 * walk, or "bus 200"). A soft accent fill + glowing border, inset slightly
 * beyond the row via negative margins so it reads as a highlighted section
 * without nudging the surrounding layout (it's absolutely positioned).
 */
function StepGlow({ glow, colors }: { glow: SharedValue<number>; colors: ThemeColors }) {
  const aStyle = useAnimatedStyle(() => ({
    opacity: 0.85 + glow.value * 0.15,
    shadowOpacity: 0.25 + glow.value * 0.4,
  }));
  return (
    <Animated.View
      pointerEvents="none"
      entering={FadeIn.duration(200)}
      style={[
        styles.stepGlow,
        {
          backgroundColor: colors.accentSoft,
          borderColor: colors.accent,
          shadowColor: colors.accent,
        },
        aStyle,
      ]}
    />
  );
}

function FlexBadge({ flexibility }: { flexibility: TimeFlexibility }) {
  const t = useTheme();
  // Only "fixed" items carry a marker now, and it's just the lock icon — no
  // text label. "window" and "flexible" render nothing so cards stay clean.
  if (flexibility !== 'fixed') return null;
  return (
    <View style={[styles.flexBadge, { backgroundColor: t.colors.warningSoft }]}>
      <Ionicons name="lock-closed" size={11} color={t.colors.warning} />
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
function GapRow({
  minutes,
  past,
  onPress,
}: {
  minutes: number;
  past?: boolean;
  onPress?: () => void;
}) {
  const t = useTheme();
  return (
    <Pressable
      onPress={
        onPress
          ? () => {
              Haptics.selectionAsync().catch(() => undefined);
              onPress();
            }
          : undefined
      }
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
      <View style={[styles.connBody, styles.gapRowBody, past && styles.pastDim]}>
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
  const base = timeRange ? `Free · ${timeRange}` : 'Free time';
  const timeLabel = item.durationMinutes
    ? `${base}  ·  ${formatDuration(item.durationMinutes)}`
    : base;
  return (
    <View
      style={[
        styles.gapCard,
        { borderColor: t.colors.separator, backgroundColor: t.colors.fill1 },
      ]}
    >
      <View style={styles.itemTopRow}>
        <View style={styles.timeWrap}>
          <Text variant="caption" tone="tertiary" weight="semibold" style={styles.timeText}>
            {timeLabel}
          </Text>
        </View>
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
      <Text variant="body" weight="semibold" style={styles.gapTitle}>
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
  active,
  glow,
}: {
  step: TravelStep;
  /** Cascaded boarding clock, "HH:MM", when the leg's leave-by is known. */
  startTime?: string;
  /** Cascaded alighting clock, "HH:MM". */
  endTime?: string;
  /** Origin label, only for the very first (walk-from-home) step. */
  fromLabel?: string;
  colors: ThemeColors;
  /** True for the single hop you're currently on — draws the glowing highlight. */
  active?: boolean;
  /** Shared breathing pulse for the active highlight. */
  glow?: SharedValue<number>;
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
      {active && glow ? <StepGlow glow={glow} colors={colors} /> : null}
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
  active,
  past,
  glow,
  nowAbs,
  legStartAbs,
  onStepsGeometry,
  onPress,
}: {
  leg: TravelLeg;
  leaveBy?: string;
  /** True while you're currently traveling this leg (gates the step highlight). */
  active?: boolean;
  /** True once the leg is behind us — crisp blue-ringed dot + dimmed panel. */
  past?: boolean;
  /** Shared breathing pulse, so the active step glows in sync with cards. */
  glow?: SharedValue<number>;
  /** Wall clock on the unwrapped (midnight-aware) axis, to pick the live hop. */
  nowAbs?: number;
  /** This leg's absolute departure minute, used to unwrap the hops past midnight. */
  legStartAbs?: number;
  /** Reports each hop's time window + pixel band so the rail can track it. */
  onStepsGeometry?: (rects: StepRect[]) => void;
  onPress?: () => void;
}) {
  const t = useTheme();
  const c = t.colors;
  const steps = leg.steps ? mergeWalkSteps(leg.steps) : [];
  const hasSteps = steps.length > 0;
  const label = TRAVEL_MODE_LABEL[leg.mode] ?? 'travel';

  // Per-hop clock. Transit steps carry Google's REAL board/alight times
  // (`departAt`/`arriveAt`) for the leg's actual planned departure slot, so by
  // default we show those verbatim — "145 at 12:29" is the bus that truly runs,
  // and any platform wait is real. Only when there's no scheduled hop to anchor
  // to (a pure-walk leg) or the schedule lands implausibly far from where the
  // day places this leg (the old "queried at NOW, hours off" failure) do we fall
  // back to keeping just the journey's SHAPE and sliding it onto `leaveBy`.
  const leaveByMin = minutesOfDay(leaveBy);
  const firstTimed = steps.findIndex((s) => minutesOfDay(s.departAt) != null);
  // 1) Lay every hop on Google's own unwrapped axis: scheduled hops pin to their
  //    times (rolling past midnight when alight < board), walks chain forward by
  //    their duration. A LEADING walk has nothing before it, so it's back-filled
  //    afterwards to END exactly when the first ride departs.
  const gFrame = steps.map(() => ({ g0: 0, g1: 0 }));
  let gRun: number | null = null;
  steps.forEach((s, i) => {
    const dep = minutesOfDay(s.departAt);
    const dur = s.durationMinutes ?? 0;
    if (dep != null) {
      let g0 = dep;
      while (gRun != null && g0 < gRun) g0 += 1440;
      const arr = minutesOfDay(s.arriveAt);
      let g1 = arr ?? g0 + dur;
      while (g1 < g0) g1 += 1440;
      gFrame[i] = { g0, g1 };
      gRun = g1;
    } else {
      const g0 = gRun ?? 0;
      gFrame[i] = { g0, g1: g0 + dur };
      gRun = g0 + dur;
    }
  });
  for (let i = firstTimed - 1; i >= 0; i--) {
    const g1 = gFrame[i + 1].g0;
    gFrame[i] = { g0: g1 - (steps[i].durationMinutes ?? 0), g1 };
  }
  // 2) Prefer Google's REAL schedule; rebase onto `leaveBy` only as a fallback.
  //    We WANT to show the vehicle that genuinely departs ("145 at 12:29"), not
  //    a synthetic "leaveBy + walk" time. Google's board/alight times are sound
  //    now because the server queries each leg for its real planned departure
  //    slot (a past slot is rolled forward whole weeks so the time-of-day still
  //    matches the live timetable). We fall back to sliding onto `leaveBy` only
  //    for a pure-walk leg (nothing scheduled to anchor to) or when the returned
  //    schedule sits implausibly far from where the day places this leg — the
  //    stale "queried at NOW, hours off" case this rebasing was first added for.
  const realFirst = firstTimed >= 0 ? gFrame[firstTimed].g0 : null;
  const circDist = (a: number, b: number) => {
    const d = Math.abs(a - b) % 1440;
    return Math.min(d, 1440 - d);
  };
  const usingReal =
    realFirst != null &&
    (leaveByMin == null || circDist(((realFirst % 1440) + 1440) % 1440, leaveByMin) <= 90);
  // Real times → keep Google's frame exactly where it is (shift 0). Fallback →
  // slide the whole sequence so the first hop lands on `leaveBy`.
  const anchorTo = usingReal ? gFrame[0].g0 : (leaveByMin ?? (gFrame.length ? gFrame[0].g0 : 0));
  const shift = anchorTo - (gFrame.length ? gFrame[0].g0 : 0);
  const stepTimes = gFrame.map((gf) => ({
    start: addMinutes('00:00', gf.g0 + shift),
    end: addMinutes('00:00', gf.g1 + shift),
  }));
  // Keep the panel header consistent with whichever clock we're showing: when
  // using real times the honest "Leave by" is the start of the first hop and the
  // duration is the real door-to-door span, not the cascade's slack-padded one.
  const realSpan = gFrame.length ? gFrame[gFrame.length - 1].g1 - gFrame[0].g0 : 0;
  const headerLeaveBy = usingReal && stepTimes.length ? stepTimes[0].start : leaveBy;
  // The real span should track the routed door-to-door minutes. If the unwrapped
  // step frame produces something implausible (a midnight roll or a stale
  // schedule can balloon it into a "15 hr 5 min"/"905 min" header), fall back to
  // the server's authoritative leg minutes rather than showing the absurd value.
  const realSpanPlausible =
    realSpan > 0 && realSpan <= Math.max(leg.minutes * 2 + 30, 360);
  const headerMinutes = usingReal && realSpanPlausible ? realSpan : leg.minutes;

  // Hop times on the rail's ABSOLUTE (midnight-unwrapped) axis. First unwrap the
  // hops among themselves (a journey can roll past midnight: alight 00:32 after
  // board 23:50), then snap the whole sequence onto the rail axis with a single
  // whole-day offset from `legStartAbs` — snapping to a multiple of 1440 keeps
  // minor rounding from nudging a hop a full day off.
  const rawStepMins = stepTimes.map((st) => ({
    t0: minutesOfDay(st.start),
    t1: minutesOfDay(st.end),
  }));
  let unwrapRun: number | null = null;
  const relStepMins = rawStepMins.map(({ t0, t1 }) => {
    let a0 = t0;
    let a1 = t1;
    if (a0 != null) {
      while (unwrapRun != null && a0 < unwrapRun) a0 += 1440;
      unwrapRun = a0;
    }
    if (a1 != null) {
      while (unwrapRun != null && a1 < unwrapRun) a1 += 1440;
      unwrapRun = a1;
    }
    return { t0: a0, t1: a1 };
  });
  const firstRel = relStepMins.find((s) => s.t0 != null)?.t0 ?? null;
  const dayOffset =
    legStartAbs != null && firstRel != null
      ? Math.round((legStartAbs - firstRel) / 1440) * 1440
      : 0;
  const stepMins = relStepMins.map(({ t0, t1 }) => ({
    t0: t0 == null ? null : t0 + dayOffset,
    t1: t1 == null ? null : t1 + dayOffset,
  }));

  // The hop you're physically on right now: the one whose [start, end) window
  // holds the clock. Only consulted while the leg is active, so it lights up a
  // single row — the walk, or "bus 200" — instead of the whole panel. Clamps to
  // the first/last hop at the very edges so rounding can't leave a gap.
  let activeStepIndex = -1;
  if (active && nowAbs != null && stepMins.length > 0) {
    for (let i = 0; i < stepMins.length; i++) {
      const { t0, t1 } = stepMins[i];
      if (t0 != null && t1 != null && nowAbs >= t0 && nowAbs < t1) {
        activeStepIndex = i;
        break;
      }
    }
    if (activeStepIndex === -1) {
      const first = stepMins[0];
      const last = stepMins[stepMins.length - 1];
      if (first.t0 != null && nowAbs < first.t0) activeStepIndex = 0;
      else if (last.t1 != null && nowAbs >= last.t1) activeStepIndex = stepMins.length - 1;
    }
  }

  // Measure the panel's offset within the row and each hop's band within the
  // panel, then report `top/bottom` relative to the leg's top (panelY + stepY)
  // so the parent rail can anchor each hop's clock window to its own pixels.
  const panelYRef = useRef(0);
  const stepGeomRef = useRef<Record<number, { y: number; h: number }>>({});
  const reportGeometry = () => {
    if (!onStepsGeometry) return;
    const rects: StepRect[] = [];
    for (let i = 0; i < stepMins.length; i++) {
      const g = stepGeomRef.current[i];
      const { t0, t1 } = stepMins[i];
      if (!g || t0 == null || t1 == null || !(t1 > t0)) continue;
      rects.push({
        t0,
        t1,
        top: panelYRef.current + g.y,
        bottom: panelYRef.current + g.y + g.h,
      });
    }
    if (rects.length > 0) onStepsGeometry(rects);
  };

  // First real vehicle on the journey (for the header's "leave 12:30 · 152 at
  // 12:40" context, making the head walk + platform wait explicit).
  const firstRide = steps.find((s) => s.mode !== 'walk' && !!s.departAt);

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
            {
              backgroundColor: c.surface1,
              borderColor: past ? c.accent : c.separator,
              borderWidth: past ? 1.5 : StyleSheet.hairlineWidth,
            },
          ]}
        >
          <Ionicons
            name={TRAVEL_MODE_ICON[leg.mode] ?? 'navigate'}
            size={13}
            color={past ? c.accent : c.textSecondary}
          />
        </View>
      </View>
      <View
        style={[styles.commutePanel, past && styles.pastDim]}
        onLayout={(e) => {
          panelYRef.current = e.nativeEvent.layout.y;
          reportGeometry();
        }}
      >
        <View style={styles.commuteHeader}>
          {headerLeaveBy ? (
            <>
              <Ionicons name="time-outline" size={12} color={c.accent} />
              <RNText style={[styles.commuteLeave, { color: c.accent }]}>
                {`Leave by ${headerLeaveBy}`}
              </RNText>
              <RNText style={[styles.commuteMeta, { color: c.textTertiary }]}>
                {`  ·  ${formatLegMinutes(headerMinutes)}`}
              </RNText>
            </>
          ) : (
            <RNText style={[styles.commuteMeta, { color: c.textSecondary }]}>
              {`${formatLegMinutes(headerMinutes)} ${label}`}
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
            <View
              key={`${i}-${s.mode}`}
              onLayout={(e) => {
                stepGeomRef.current[i] = {
                  y: e.nativeEvent.layout.y,
                  h: e.nativeEvent.layout.height,
                };
                reportGeometry();
              }}
            >
              <CommuteStep
                step={s}
                startTime={stepTimes[i]?.start}
                endTime={stepTimes[i]?.end}
                fromLabel={i === 0 ? leg.fromLabel : undefined}
                colors={c}
                active={i === activeStepIndex}
                glow={glow}
              />
            </View>
          ))
        ) : (
          <CommuteFallbackStep
            leg={leg}
            label={label}
            colors={c}
            active={!!active}
            glow={glow}
          />
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
  active,
  glow,
}: {
  leg: TravelLeg;
  label: string;
  colors: ThemeColors;
  /** True while you're on this (single-hop) leg — draws the glowing highlight. */
  active?: boolean;
  /** Shared breathing pulse for the active highlight. */
  glow?: SharedValue<number>;
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
      {active && glow ? <StepGlow glow={glow} colors={colors} /> : null}
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
  dayDate,
  isContinuation,
  onPickAlternative,
  onOpenMenu,
  hasConflict,
}: {
  item: ItineraryItem;
  /** The day's date ("YYYY-MM-DD"), used for the venue opening-hours check. */
  dayDate?: string;
  /**
   * True when the previous item was at the SAME venue. We suppress the place
   * block (photo / name / rating / open status) so the same venue card doesn't
   * repeat across consecutive items like "Run to pull-up bar" → "Pull-up
   * workout" — the title alone makes the continuity clear.
   */
  isContinuation?: boolean;
  /** Tap-handler on an alternative venue thumbnail (swaps to that place). */
  onPickAlternative?: (place: ItineraryPlace) => void;
  /** Tap-handler on the "..." menu button (opens the per-card actions sheet). */
  onOpenMenu?: () => void;
  /** Marks the card with a small warning glyph when this item has a conflict. */
  hasConflict?: boolean;
}) {
  const t = useTheme();
  const place = isContinuation ? undefined : item.place;
  // Arrival markers ("Back home") carry a single time that is when you GET
  // there — prefix it so a lone "19:30" doesn't read as a departure.
  const timeRange = isArrivalMarker(item)
    ? item.startTime
      ? `Arrive ${item.startTime}`
      : ''
    : item.startTime && item.endTime
    ? `${item.startTime} – ${item.endTime}`
    : item.startTime ?? '';
  // Fold the duration into the time kicker ("13:10 – 15:10 · 2h") so the top
  // row is a single quiet line, not a time plus a competing pill.
  const timeLabel = [timeRange, item.durationMinutes ? formatDuration(item.durationMinutes) : '']
    .filter(Boolean)
    .join('  ·  ');
  const rating = typeof place?.rating === 'number' ? place.rating : undefined;
  // Condense price + category onto one muted line under the venue name.
  const metaBits = [place?.priceLevel, place?.category].filter(Boolean) as string[];
  // Opening-hours check against the LIVE scheduled time — recomputed here (not
  // baked server-side) because the schedule reflows as the user edits. Drives
  // the open-status line and a "consider changing" notice when the venue is
  // closed or closes before this visit ends. Unknown hours show nothing.
  const hours = getVenueHoursStatus(place, dayDate, item.startTime, item.endTime);

  return (
    <Card padded>
      <View style={styles.itemTopRow}>
        <View style={styles.timeWrap}>
          {hasConflict ? (
            <Ionicons name="warning" size={13} color={t.colors.warning} />
          ) : null}
          <Text
            variant="caption"
            tone={hasConflict ? 'danger' : 'secondary'}
            weight="semibold"
            style={styles.timeText}
          >
            {timeLabel || ' '}
          </Text>
        </View>
        {SHOW_FLEX_BADGES ? <FlexBadge flexibility={item.flexibility} /> : null}
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

      <Text variant="subhead" weight="bold" tight style={styles.itemTitle}>
        {item.title}
      </Text>

      {item.description ? (
        <Text variant="bodySm" tone="secondary" numberOfLines={3} style={styles.itemDesc}>
          {item.description}
        </Text>
      ) : null}

      {place ? (
        <>
          {/* The venue is shown for reference only; tapping anywhere on the card
              opens the actions drawer (where the place can be changed). */}
          <View style={styles.placeRow}>
            {place.photoUrl ? (
              <Image
                source={{ uri: place.photoUrl }}
                style={[styles.thumb, { backgroundColor: t.colors.fill1 }]}
              />
            ) : null}
            <View style={styles.placeBody}>
              <Text variant="bodySm" weight="semibold" numberOfLines={1}>
                {place.name}
              </Text>
              {rating !== undefined || metaBits.length ? (
                <View style={styles.metaRow}>
                  {rating !== undefined ? (
                    <>
                      <Text variant="caption" tone="secondary" weight="medium">
                        {rating.toFixed(1)}
                      </Text>
                      <Ionicons name="star" size={12} color={t.colors.highlightYellow} />
                    </>
                  ) : null}
                  {metaBits.length ? (
                    <Text variant="caption" tone="tertiary" numberOfLines={1} style={styles.metaText}>
                      {`${rating !== undefined ? '·  ' : ''}${metaBits.join('  ·  ')}`}
                    </Text>
                  ) : null}
                </View>
              ) : null}
              {/* Prefer the live scheduled-time status; fall back to the
                  server's openStatus string only when we have no structured
                  hours to compute from. */}
              {hours.status !== 'unknown' && hours.statusLabel ? (
                <OpenStatus status={hours.statusLabel} />
              ) : place.openStatus ? (
                <OpenStatus status={place.openStatus} />
              ) : null}
            </View>
          </View>
          {hours.warning ? (
            <View
              style={[
                styles.hoursWarn,
                {
                  backgroundColor:
                    hours.status === 'closed' ? t.colors.dangerSoft : t.colors.warningSoft,
                },
              ]}
            >
              <Ionicons
                name="alert-circle"
                size={14}
                color={hours.status === 'closed' ? t.colors.danger : t.colors.warning}
              />
              <Text
                variant="caption"
                weight="medium"
                style={[
                  styles.hoursWarnText,
                  { color: hours.status === 'closed' ? t.colors.danger : t.colors.warning },
                ]}
              >
                {hours.warning}
              </Text>
            </View>
          ) : null}
          {/* A few runner-up venues for a "Diem picks the spot" stop — tap one
              to swap straight from the card (no need to open the full sheet). */}
          {onPickAlternative && place.alternatives && place.alternatives.length ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={styles.altStrip}
              contentContainerStyle={styles.altStripContent}
            >
              {place.alternatives.map((alt, i) => (
                <Pressable
                  key={`${alt.name}-${i}`}
                  onPress={() => onPickAlternative(alt)}
                  style={({ pressed }) => [styles.altThumbWrap, pressed && { opacity: 0.65 }]}
                >
                  {alt.photoUrl ? (
                    <Image
                      source={{ uri: alt.photoUrl }}
                      style={[styles.altThumb, { backgroundColor: t.colors.fill1 }]}
                    />
                  ) : (
                    <View
                      style={[
                        styles.altThumb,
                        styles.altThumbEmpty,
                        { backgroundColor: t.colors.fill1 },
                      ]}
                    >
                      <Text variant="bodySm">{alt.emoji ?? '📍'}</Text>
                    </View>
                  )}
                  <Text
                    variant="micro"
                    tone="secondary"
                    numberOfLines={1}
                    style={styles.altThumbLabel}
                  >
                    {alt.name}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          ) : null}
        </>
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
  planActions: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  planActionBtn: {
    flex: 1,
  },
  whenRow: {
    flexDirection: 'row',
    gap: 8,
    paddingTop: 12,
  },
  whenChip: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 7,
    paddingHorizontal: 12,
    borderRadius: 999,
  },
  whenChipText: {
    flexShrink: 1,
  },
  v3Row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 10,
    paddingVertical: 8,
    paddingLeft: 14,
    paddingRight: 8,
    borderRadius: 16,
  },
  modeSegment: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 2,
    borderRadius: 999,
    gap: 2,
  },
  modePill: {
    minWidth: 34,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderRadius: 999,
  },
  errandsWrap: {
    gap: 18,
  },
  errandsSelectHint: {
    marginTop: -4,
    marginBottom: -6,
    paddingHorizontal: 2,
  },
  errandGroup: {
    gap: 10,
  },
  errandGroupHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 4,
  },
  errandCountPill: {
    minWidth: 20,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 999,
    alignItems: 'center',
  },
  errandsCard: {
    paddingHorizontal: 2,
  },
  errandEmpty: {
    borderWidth: StyleSheet.hairlineWidth,
    borderStyle: 'dashed',
    borderRadius: 12,
    paddingVertical: 16,
    paddingHorizontal: 14,
    alignItems: 'center',
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
    fontSize: 13,
    letterSpacing: 0.2,
    fontVariant: ['tabular-nums'],
  },
  menuBtn: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
  itemTitle: {
    marginTop: 4,
  },
  itemDesc: {
    marginTop: 6,
  },
  gapTitle: {
    marginTop: 6,
  },
  placeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginTop: 12,
  },
  placeBody: {
    flex: 1,
    gap: 3,
  },
  thumb: {
    width: 60,
    height: 60,
    borderRadius: 12,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  metaText: {
    flexShrink: 1,
  },
  altStrip: {
    marginTop: 10,
  },
  altStripContent: {
    gap: 10,
    paddingRight: 4,
  },
  altThumbWrap: {
    width: 66,
    gap: 4,
  },
  altThumb: {
    width: 66,
    height: 50,
    borderRadius: 10,
  },
  altThumbEmpty: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  altThumbLabel: {
    width: 66,
  },
  openStatus: {
    fontSize: 13,
    fontWeight: '400',
  },
  hoursWarn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 8,
    paddingVertical: 7,
    paddingHorizontal: 10,
    borderRadius: 10,
  },
  hoursWarnText: {
    flex: 1,
  },
  flexBadge: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
    paddingVertical: 4,
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
    fontSize: 13,
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
    borderRadius: 999,
    paddingVertical: 3,
    paddingHorizontal: 7,
  },
  gapAddText: {
    fontSize: 11,
    fontWeight: '700',
  },
  gapCard: {
    borderWidth: 1,
    borderStyle: 'dashed',
    borderRadius: 18,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  // ---- Commute panel (redesigned travel leg) ----------------------------
  commutePanel: {
    flex: 1,
    paddingVertical: 4,
    gap: 10,
    marginVertical: 2,
  },
  commuteHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  commuteLeave: {
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 0.2,
    fontVariant: ['tabular-nums'],
  },
  commuteMeta: {
    fontSize: 13,
    fontWeight: '500',
  },
  commuteChevron: {
    marginLeft: 'auto',
    opacity: 0.7,
  },
  stepBlock: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  stepBlockCenter: {
    alignItems: 'center',
  },
  stepGlow: {
    position: 'absolute',
    top: -6,
    bottom: -6,
    left: -8,
    right: -8,
    borderRadius: 10,
    borderWidth: 1.5,
    shadowOffset: { width: 0, height: 0 },
    shadowRadius: 10,
  },
  stepBadge: {
    width: 30,
    height: 30,
    borderRadius: 8,
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
    fontSize: 13,
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
    fontSize: 13,
    fontWeight: '500',
  },
  stopTime: {
    fontSize: 13,
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
