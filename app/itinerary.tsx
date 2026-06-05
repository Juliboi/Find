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
import { useHomeStore, selectEndOfDay } from '@/store/useHomeStore';
import { useSavedItineraries } from '@/store/useSavedItineraries';
import { HomePicker } from '@/components/HomePicker';
import { Card } from '@/components/Card';
import { Text } from '@/components/Text';
import { Button } from '@/components/Button';
import { TripMap, type LatLng, type TripStop } from '@/components/TripMap';
import { planItinerary, type ItineraryDebug } from '@/lib/ai/itinerary';
import { recomputeItinerary } from '@/lib/ai/recomputeItinerary';
import {
  Itinerary,
  ItineraryItem,
  ItinerarySection,
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
 * Flexibility pills are hidden for now; the field stays in the data model.
 */
const SHOW_FLEX_BADGES = false;

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
  // reshapes the itinerary, so you can copy the structured JSON from Metro
  // and share it instead of taking screenshots when reporting a bug. Includes
  // every piece of state that influences how the day renders: the full
  // itinerary, the resolved context (home / end-of-day), the saved-store id
  // (if opened from the homepage), the AI vs heuristic flag, and the planner's
  // debug envelope when one came back with the plan.
  useEffect(() => {
    if (!__DEV__ || !itinerary) return;
    const snapshot = {
      savedId: params.id ?? null,
      usedAi,
      context: { home, endOfDay },
      itinerary,
      debug,
    };
    const stamp = new Date().toISOString();
    // Sentinel lines either side make it trivial to copy a single snapshot
    // out of a noisy log; the prefix makes filtering with `metro | grep`
    // straightforward too.
    console.log(`══════════ [day-snapshot] ${stamp} ══════════`);
    console.log(JSON.stringify(snapshot, null, 2));
    console.log(`══════════ [day-snapshot/end] ${stamp} ══════════`);
  }, [itinerary, debug, usedAi, home, endOfDay, params.id]);

  const flatItems = useMemo(
    () => (itinerary ? itinerary.sections.flatMap((s) => s.items) : []),
    [itinerary],
  );
  const flatItemsRef = useRef(flatItems);
  flatItemsRef.current = flatItems;

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
    // Invalidate any background routing/plan jobs in flight so their
    // resolutions are dropped instead of repopulating the cleared screen.
    planSeqRef.current += 1;
    setItinerary(null);
    setDebug(null);
    setErrorMsg(null);
    setUsedAi(false);
    setSavedId(null);
    setRoutesRefining(false);
    resetTracking();
    snapTo(expandedTop);
  };

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

        <ScrollView
          ref={listRef}
          contentContainerStyle={{
            paddingHorizontal: showRail ? 0 : t.spacing.lg,
            paddingTop: 8,
            paddingBottom: insets.bottom + 80,
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
                  glow={glowPulse}
                  nowItemId={nowItemId}
                  nowMin={nowMin}
                  sectionActive={si === nowSectionIndex}
                  sectionPast={
                    section.items.length > 0 &&
                    section.items.every((it) => itemEndMin(it) <= nowMin)
                  }
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
      </Animated.View>

      <View style={[styles.floatingBar, { top: insets.top + 8 }]} pointerEvents="box-none">
        <RoundButton icon="chevron-back" label="Back" onPress={() => router.back()} />
        {itinerary ? (
          <RoundButton icon="refresh" label="Reset" onPress={reset} />
        ) : null}
      </View>
    </View>
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
  glow,
  nowItemId,
  nowMin,
  sectionActive,
  sectionPast,
  onSectionLayout,
  onItemLayout,
  onCardLayout,
}: {
  section: ItinerarySection;
  first: boolean;
  continuationIds: Set<string>;
  index: number;
  gapsById: Record<string, number>;
  glow: SharedValue<number>;
  nowItemId: string | null;
  nowMin: number;
  sectionActive: boolean;
  sectionPast: boolean;
  onSectionLayout: (y: number) => void;
  onItemLayout: (id: string, y: number) => void;
  onCardLayout: (id: string, relY: number, h: number) => void;
}) {
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
              {gapsById[item.id] ? <GapRow minutes={gapsById[item.id]} /> : null}
              {leg ? <TravelLegRow leg={leg} leaveBy={leaveBy} /> : null}
              <View
                style={styles.cardWrap}
                onLayout={(e) =>
                  onCardLayout(item.id, e.nativeEvent.layout.y, e.nativeEvent.layout.height)
                }
              >
                <ItemCard item={item} isContinuation={continuationIds.has(item.id)} />
                {active ? <CardGlow glow={glow} /> : null}
              </View>
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

const TRAVEL_MODE_EMOJI: Record<ItineraryTravelMode, string> = {
  walk: '🚶',
  bike: '🚲',
  transit: '🚍',
  drive: '🚗',
};

const TRAVEL_MODE_LABEL: Record<ItineraryTravelMode, string> = {
  walk: 'walk',
  bike: 'bike',
  transit: 'transit',
  drive: 'drive',
};

const TRAVEL_STEP_EMOJI: Record<TravelStepMode, string> = {
  walk: '🚶',
  bus: '🚌',
  tram: '🚊',
  subway: '🚇',
  train: '🚆',
  ferry: '⛴️',
  transit: '🚍',
};

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

function travelStepText(step: TravelStep): string {
  if (step.mode === 'walk') {
    return step.durationMinutes ? `Walk ${step.durationMinutes} min` : 'Walk';
  }
  const parts: string[] = [];
  if (step.line) parts.push(step.line);
  if (step.from && step.to) parts.push(`${step.from} → ${step.to}`);
  else if (step.to) parts.push(step.to);
  const head = parts.join(' · ');
  return step.durationMinutes ? `${head}  ·  ${step.durationMinutes} min` : head || 'Transit';
}

/** A light connector marking idle/free time the user has between two blocks. */
function GapRow({ minutes }: { minutes: number }) {
  const t = useTheme();
  return (
    <View style={[styles.connRow, styles.connRowCenter]}>
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
      <View style={styles.connBody}>
        <RNText style={[styles.gapText, { color: t.colors.textTertiary }]}>
          {`${formatDuration(minutes)} free`}
        </RNText>
      </View>
    </View>
  );
}

/**
 * Connector that sits BETWEEN two place cards and shows how you get from one
 * to the next — when to leave, a simple hop on one line, or a full journey
 * broken into its transit legs (🚶 → 🚌 → 🚇 → 🚆), maps-app style.
 */
function TravelLegRow({ leg, leaveBy }: { leg: TravelLeg; leaveBy?: string }) {
  const t = useTheme();
  const steps = leg.steps ? mergeWalkSteps(leg.steps) : [];
  const hasSteps = steps.length > 0;
  const bubbleEmoji = TRAVEL_MODE_EMOJI[leg.mode] ?? '➡️';
  const label = TRAVEL_MODE_LABEL[leg.mode] ?? 'travel';
  return (
    <View style={styles.connRow}>
      <View style={styles.connRail} accessibilityElementsHidden>
        <View
          style={[
            styles.connDot,
            { backgroundColor: t.colors.surface1, borderColor: t.colors.separator },
          ]}
        >
          <RNText style={styles.connDotEmoji}>{bubbleEmoji}</RNText>
        </View>
      </View>
      <View style={styles.connBody}>
        {leaveBy ? (
          <View style={styles.leaveRow}>
            <Ionicons name="walk" size={13} color={t.colors.accent} />
            <RNText style={[styles.leaveText, { color: t.colors.accent }]}>
              {`Leave by ${leaveBy}`}
            </RNText>
            <RNText style={[styles.leaveMeta, { color: t.colors.textTertiary }]}>
              {`  ·  ${formatLegMinutes(leg.minutes)} ${label}`}
            </RNText>
          </View>
        ) : (
          <RNText style={[styles.legHead, { color: t.colors.textSecondary }]}>
            {`${formatLegMinutes(leg.minutes)} ${label}`}
          </RNText>
        )}
        {leg.fromLabel ? (
          <RNText style={[styles.legFrom, { color: t.colors.textTertiary }]}>
            {`from ${leg.fromLabel}`}
          </RNText>
        ) : null}
        {hasSteps ? (
          <View style={styles.legSteps}>
            {steps.map((s, i) => (
              <View key={`${i}-${s.mode}`} style={styles.legStep}>
                <RNText style={styles.legStepEmoji}>
                  {TRAVEL_STEP_EMOJI[s.mode] ?? '🚍'}
                </RNText>
                <RNText
                  style={[styles.legStepText, { color: t.colors.textTertiary }]}
                  numberOfLines={1}
                >
                  {travelStepText(s)}
                </RNText>
              </View>
            ))}
          </View>
        ) : null}
      </View>
    </View>
  );
}

function ItemCard({
  item,
  isContinuation,
}: {
  item: ItineraryItem;
  /** True when the previous item was at the SAME venue. We suppress the place
   * block (photo / name / rating / open status) so the same venue card doesn't
   * repeat across consecutive items like "Run to pull-up bar" → "Pull-up
   * workout" — the title alone makes the continuity clear. */
  isContinuation?: boolean;
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
        <Text variant="caption" tone="secondary" weight="semibold" style={styles.timeText}>
          {timeRange || ' '}
        </Text>
        {item.durationMinutes ? (
          <View style={[styles.durationPill, { backgroundColor: t.colors.fill1 }]}>
            <Ionicons name="time-outline" size={12} color={t.colors.textSecondary} />
            <Text variant="micro" tone="secondary" weight="semibold">
              {formatDuration(item.durationMinutes)}
            </Text>
          </View>
        ) : SHOW_FLEX_BADGES ? (
          <FlexBadge flexibility={item.flexibility} />
        ) : null}
      </View>

      <Text variant="body" weight="semibold" style={{ marginTop: 8 }}>
        {item.title}
      </Text>

      {place ? (
        <View style={styles.placeRow}>
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
        </View>
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
  timeText: {
    fontSize: 14,
    letterSpacing: 0.3,
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
  connDotEmoji: {
    fontSize: 12,
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
  leaveRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    flexWrap: 'wrap',
  },
  leaveText: {
    fontSize: 13.5,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  leaveMeta: {
    fontSize: 13,
    fontWeight: '500',
  },
  legHead: {
    fontSize: 13,
    fontWeight: '600',
  },
  legFrom: {
    fontSize: 12.5,
    fontWeight: '400',
  },
  legSteps: {
    gap: 3,
    marginTop: 2,
  },
  legStep: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  legStepEmoji: {
    fontSize: 12,
    width: 16,
    textAlign: 'center',
  },
  legStepText: {
    fontSize: 12.5,
    fontWeight: '400',
    flex: 1,
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
