import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  Image,
  Platform,
  Pressable,
  Share,
  StyleSheet,
  Switch,
  TextInput,
  View,
} from 'react-native';
import DateTimePicker, {
  type DateTimePickerEvent,
} from '@react-native-community/datetimepicker';
import { BottomSheetScrollView, BottomSheetTextInput } from '@gorhom/bottom-sheet';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import Animated, {
  Easing,
  FadeIn,
  FadeInDown,
  FadeOut,
  FadeOutUp,
  LinearTransition,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useTheme } from '@/theme/useTheme';
import { Sheet } from './Sheet';
import { WheelPicker, type WheelOption } from './WheelPicker';
import { Text } from './Text';
import { Button } from './Button';
import { upcomingWeek, roundedNowHHMM } from '@/utils/days';
import {
  usePlanSetupStore,
  DEFAULT_DAY_END_TIME,
  DEFAULT_MEAL_MODES,
  MEAL_KEYS,
  type DayPlanSelection,
  type MealKey,
  type MealMode,
} from '@/store/usePlanSetupStore';
import { useProfileStore } from '@/store/useProfileStore';
import { useAuthStore } from '@/store/useAuthStore';
import type { MealWindowsInput } from '@/types/profile';
import { useErrandsStore, type Errand } from '@/store/useErrandsStore';
import { detectMealErrands, defaultMealModes, type MealWindow } from '@/lib/meals';
import { useHomeStore, type LocationPin } from '@/store/useHomeStore';
import { getCurrentCoords, type Coords } from '@/lib/places';
import { ErrandDiscoverStep } from './ErrandDiscoverStep';
import {
  autocompletePlaces,
  resolvePlace,
  reverseGeocode,
  type PlacePrediction,
} from '@/lib/geocoding';
import { buildPlanInputsPayload } from '@/lib/devPlanInputs';
import { formatTime, minutesOfDay } from '@/utils/time';

type Step = 0 | 1 | 2;

const MEAL_META: Record<
  MealKey,
  { label: string; icon: keyof typeof Ionicons.glyphMap }
> = {
  breakfast: { label: 'Breakfast', icon: 'cafe-outline' },
  lunch: { label: 'Lunch', icon: 'fast-food-outline' },
  dinner: { label: 'Dinner', icon: 'restaurant-outline' },
};

/** Which `useProfileStore` / `MealWindowsInput` fields back each meal's window. */
const MEAL_FIELDS: Record<
  MealKey,
  { start: keyof MealWindowsInput; end: keyof MealWindowsInput }
> = {
  breakfast: { start: 'breakfastStart', end: 'breakfastEnd' },
  lunch: { start: 'lunchStart', end: 'lunchEnd' },
  dinner: { start: 'dinnerStart', end: 'dinnerEnd' },
};

/** Fallback windows used to seed the time editor when the profile has none. */
const MEAL_DEFAULT_WINDOW: Record<MealKey, { start: string; end: string }> = {
  breakfast: { start: '07:30', end: '08:30' },
  lunch: { start: '12:00', end: '13:00' },
  dinner: { start: '18:30', end: '19:30' },
};

interface Props {
  open: boolean;
  onClose: () => void;
  /** Called with the full day plan (day, start/end times, start/end places). */
  onConfirm: (selection: DayPlanSelection) => void;
  /** Seed the wheel to this day (defaults to today). */
  initialDate?: string;
  /** Seed the time selector to this value (defaults to the day's default). */
  initialTime?: string;
  /** Which step to open on. 0 = pick the day, 1 = start & end. Defaults to 0. */
  initialStep?: Step;
  /**
   * The errands the user has ticked to fold into this plan. When provided, only
   * these errands can auto-fill a meal — unticking one drops it from its meal
   * here too. Omit (the home planner) to leave every errand eligible.
   */
  selectedErrandIds?: Set<string> | null;
}

const DAY_COUNT = 7;

function hhmmToDate(hhmm: string): Date {
  const mins = minutesOfDay(hhmm) ?? 9 * 60;
  const d = new Date();
  d.setHours(Math.floor(mins / 60), mins % 60, 0, 0);
  return d;
}

function dateToHHMM(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(
    d.getMinutes(),
  ).padStart(2, '0')}`;
}

/** Loose coordinate equality so a re-fetched GPS pin still reads as "current". */
function samePin(a: LocationPin | null, b: LocationPin | null): boolean {
  if (!a || !b) return false;
  return (
    Math.abs(a.latitude - b.latitude) < 1e-4 &&
    Math.abs(a.longitude - b.longitude) < 1e-4
  );
}

/** "lunch", "lunch and dinner", "breakfast, lunch and dinner". */
function joinMeals(meals: MealKey[]): string {
  if (meals.length <= 1) return meals[0] ?? '';
  return `${meals.slice(0, -1).join(', ')} and ${meals[meals.length - 1]}`;
}

/**
 * Per-section staggered transitions. Each block rises in from just below while
 * fading in — one after another — then lifts up and fades out. This makes the
 * drawer's content flow in and out individually instead of sliding as one slab.
 */
const ENTER = (i: number) => FadeInDown.duration(360).delay(110 + i * 60);
const EXIT = (i: number) => FadeOutUp.duration(200).delay(i * 30);

/**
 * The planner setup drawer, now a two-step wizard:
 *
 *   Step 0 — "When's your day?": a big day-of-week wheel plus the start-time
 *            selector (kept here as well as on step 1) and the per-day car
 *            toggle.
 *   Step 1 — "Start & end": start time + start address (defaults to the live
 *            GPS location) and end time + end address (defaults to home), each
 *            with quick chips to flip between Home and Current location.
 *
 * Steps cross-fade with a down-to-up motion: the outgoing content lifts up and
 * fades out, then the incoming content rises in from below. The chosen plan is
 * handed back via `onConfirm`.
 */
export function PlanSetupSheet({
  open,
  onClose,
  onConfirm,
  initialDate,
  initialTime,
  initialStep = 0,
  selectedErrandIds = null,
}: Props) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const dayStartTime = usePlanSetupStore((s) => s.dayStartTime);
  const hasCar = useProfileStore((s) => s.hasCar);
  const bedTime = useProfileStore((s) => s.bedTime);
  const windDownTime = useProfileStore((s) => s.windDownTime);
  const breakfastStart = useProfileStore((s) => s.breakfastStart);
  const breakfastEnd = useProfileStore((s) => s.breakfastEnd);
  const lunchStart = useProfileStore((s) => s.lunchStart);
  const lunchEnd = useProfileStore((s) => s.lunchEnd);
  const dinnerStart = useProfileStore((s) => s.dinnerStart);
  const dinnerEnd = useProfileStore((s) => s.dinnerEnd);
  const useCarToday = usePlanSetupStore((s) => s.useCarToday);
  const setUseCarToday = usePlanSetupStore((s) => s.setUseCarToday);
  const updateMealWindows = useAuthStore((s) => s.updateMealWindows);
  const home = useHomeStore((s) => s.home);
  const errands = useErrandsStore((s) => s.items);
  const addErrand = useErrandsStore((s) => s.add);
  const removeErrand = useErrandsStore((s) => s.remove);

  // The week is held in state and refreshed each time the sheet opens, so
  // "today" stays correct across a midnight rollover while the app sits
  // backgrounded.
  const [days, setDays] = useState(() => upcomingWeek(DAY_COUNT));
  const [dayIndex, setDayIndex] = useState(0);
  const [startTimeD, setStartTimeD] = useState<Date>(() =>
    hhmmToDate(roundedNowHHMM()),
  );
  const [endTimeD, setEndTimeD] = useState<Date>(() =>
    hhmmToDate(bedTime ?? windDownTime ?? DEFAULT_DAY_END_TIME),
  );
  const [androidPicker, setAndroidPicker] = useState<false | 'start' | 'end'>(
    false,
  );

  // Wizard state. The sheet's content is keyed by `step`, so each step change
  // (and the fresh mount on every open) replays the down-to-up intro.
  const [step, setStep] = useState<Step>(initialStep);

  // Only one expandable row (a time spinner or an address search) may be open
  // at a time. Lifting the open id here means opening one row collapses any
  // other that was open. `null` means everything is collapsed.
  const [activeRow, setActiveRow] = useState<string | null>(null);

  // Which meal's start/end time editor is expanded in the meals step (only one
  // at a time), plus the Android one-shot dialog target. `null` ⇒ collapsed.
  const [editingMeal, setEditingMeal] = useState<MealKey | null>(null);
  const [androidMealPicker, setAndroidMealPicker] = useState<{
    meal: MealKey;
    edge: 'start' | 'end';
  } | null>(null);

  // Locations. `currentLoc` is the GPS result captured on open; start/end hold
  // the user's (possibly edited) picks.
  const [currentLoc, setCurrentLoc] = useState<LocationPin | null>(null);
  const [locLoading, setLocLoading] = useState(false);
  const [startLoc, setStartLoc] = useState<LocationPin | null>(null);
  const [endLoc, setEndLoc] = useState<LocationPin | null>(null);

  // Per-meal dining preference + any auto-linked dining errand, re-seeded each
  // open (per-day, never sticky) and refreshed when the chosen day changes.
  const [mealModes, setMealModes] = useState<Record<MealKey, MealMode>>(() => ({
    ...DEFAULT_MEAL_MODES,
  }));
  const [mealLinks, setMealLinks] = useState<Record<MealKey, string | null>>({
    breakfast: null,
    lunch: null,
    dinner: null,
  });

  // The full-screen "pick a place for this Out meal" overlay (a search field OR
  // the Discover step), or null when the normal step content is showing.
  const [mealPicker, setMealPicker] = useState<{
    meal: MealKey;
    method: 'search' | 'discover';
  } | null>(null);
  // Ids of the dining errands THIS picker created, so unlinking one (or the
  // sheet tearing down a never-confirmed pick) removes the throwaway errand
  // rather than orphaning it — auto-detected real errands are never deleted.
  const createdMealErrandIds = useRef<Set<string>>(new Set());

  const mealWindows = useMemo<Partial<Record<MealKey, MealWindow>>>(
    () => ({
      breakfast: { start: breakfastStart, end: breakfastEnd },
      lunch: { start: lunchStart, end: lunchEnd },
      dinner: { start: dinnerStart, end: dinnerEnd },
    }),
    [breakfastStart, breakfastEnd, lunchStart, lunchEnd, dinnerStart, dinnerEnd],
  );

  // Only errands the user is actually folding into the plan inform meals (the
  // auto-link AND the smart Home/Out guess). Unticking one drops its influence.
  // No selection (the home planner) means every errand stays eligible.
  const mealPool = useCallback(
    () => (selectedErrandIds ? errands.filter((e) => selectedErrandIds.has(e.id)) : errands),
    [errands, selectedErrandIds],
  );

  const detectLinks = useCallback(
    (dateISO: string): Record<MealKey, string | null> => {
      const found = detectMealErrands(mealPool(), mealWindows, dateISO);
      return {
        breakfast: found.breakfast?.id ?? null,
        lunch: found.lunch?.id ?? null,
        dinner: found.dinner?.id ?? null,
      };
    },
    [mealPool, mealWindows],
  );

  const defaultTimeForDay = (i: number): string =>
    days[i]?.isToday ? roundedNowHHMM() : dayStartTime;

  const fetchCurrent = useCallback(async (): Promise<LocationPin | null> => {
    const coords = await getCurrentCoords();
    if (!coords) return null;
    const label =
      (await reverseGeocode(coords.latitude, coords.longitude)) ??
      `${coords.latitude.toFixed(4)}, ${coords.longitude.toFixed(4)}`;
    return { label, latitude: coords.latitude, longitude: coords.longitude };
  }, []);

  // (Re)seed everything whenever the sheet opens, and kick off a fresh GPS
  // lookup so the start address always reflects where the user is *now* (not a
  // stale pick or home).
  useEffect(() => {
    if (!open) return;
    const fresh = upcomingWeek(DAY_COUNT);
    setDays(fresh);
    const found = initialDate ? fresh.findIndex((d) => d.iso === initialDate) : 0;
    const idx = found >= 0 ? found : 0;
    setDayIndex(idx);
    const seedTime =
      initialTime ?? (fresh[idx]?.isToday ? roundedNowHHMM() : dayStartTime);
    setStartTimeD(hhmmToDate(seedTime));
    setEndTimeD(hhmmToDate(bedTime ?? windDownTime ?? DEFAULT_DAY_END_TIME));
    setStep(initialStep);
    setAndroidPicker(false);
    setActiveRow(null);
    setEditingMeal(null);
    setAndroidMealPicker(null);
    setMealPicker(null);

    // Meals: default every meal to Home, then auto-link any dining errand that
    // already covers a meal (its place becomes the meal, shown as "out"). We only
    // preselect "out" off a real dining errand — never off the day's other plans.
    const seedISO = fresh[idx]?.iso ?? '';
    setMealModes(defaultMealModes());
    setMealLinks(detectLinks(seedISO));

    // End defaults to home; start defaults to the live location (home as a
    // fallback only if GPS is unavailable).
    setEndLoc(home ?? null);
    setStartLoc(null);
    setCurrentLoc(null);
    setLocLoading(true);
    let cancelled = false;
    void fetchCurrent().then((pin) => {
      if (cancelled) return;
      setCurrentLoc(pin);
      setStartLoc(pin ?? home ?? null);
      setLocLoading(false);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const onDayChange = (i: number) => {
    setDayIndex(i);
    setStartTimeD(hhmmToDate(defaultTimeForDay(i)));
    const iso = days[i]?.iso;
    if (iso) {
      setMealModes(defaultMealModes());
      setMealLinks(detectLinks(iso));
    }
  };

  const setMealMode = (meal: MealKey, mode: MealMode) => {
    Haptics.selectionAsync().catch(() => undefined);
    setMealModes((m) => ({ ...m, [meal]: mode }));
  };
  const unlinkMeal = (meal: MealKey) => {
    Haptics.selectionAsync().catch(() => undefined);
    setMealLinks((l) => {
      const id = l[meal];
      // A place WE created for this meal is throwaway — delete it on unlink so it
      // doesn't linger as a stray errand. A real, user-made dining errand that
      // merely got auto-linked is left alone (just unlinked).
      if (id && createdMealErrandIds.current.has(id)) {
        removeErrand(id);
        createdMealErrandIds.current.delete(id);
      }
      return { ...l, [meal]: null };
    });
  };

  // Open the place picker for an Out meal (manual search or Discover).
  const findMealPlace = (meal: MealKey, method: 'search' | 'discover') => {
    Haptics.selectionAsync().catch(() => undefined);
    setMealPicker({ meal, method });
  };

  // A place was chosen for the picker's meal: materialise it as a dining errand
  // for the day (so it actually routes), then link the meal to it. The day's
  // errands are auto-folded into the plan, so no extra selection wiring is
  // needed. Replaces any throwaway place previously created for this meal.
  const onMealPlacePicked = (place: PickedMealPlace) => {
    const picker = mealPicker;
    if (!picker) return;
    const { meal } = picker;
    const w = mealWindows[meal];
    const prev = mealLinks[meal];
    if (prev && createdMealErrandIds.current.has(prev)) {
      removeErrand(prev);
      createdMealErrandIds.current.delete(prev);
    }
    const title = `${MEAL_META[meal].label} at ${place.name}`;
    const id = addErrand({
      title,
      rawText: title,
      source: 'user',
      date: days[dayIndex]?.iso,
      durationMin: mealDurationMin(w),
      address: place.name,
      latitude: place.latitude,
      longitude: place.longitude,
      placeId: place.placeId,
      photoUrl: place.photoUrl,
      rating: place.rating,
      ratingCount: place.ratingCount,
      priceLevel: place.priceLevel,
      openingHours: place.openingHours,
    });
    createdMealErrandIds.current.add(id);
    setMealModes((m) => ({ ...m, [meal]: 'out' }));
    setMealLinks((l) => ({ ...l, [meal]: id }));
    setMealPicker(null);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(
      () => undefined,
    );
  };

  const onStartTimeChange = (_: DateTimePickerEvent, picked?: Date) => {
    if (Platform.OS !== 'ios') setAndroidPicker(false);
    if (picked) {
      Haptics.selectionAsync().catch(() => undefined);
      setStartTimeD(picked);
    }
  };

  const onEndTimeChange = (_: DateTimePickerEvent, picked?: Date) => {
    if (Platform.OS !== 'ios') setAndroidPicker(false);
    if (picked) {
      Haptics.selectionAsync().catch(() => undefined);
      setEndTimeD(picked);
    }
  };

  const options: WheelOption[] = useMemo(
    () =>
      days.map((d) => ({
        key: d.iso,
        label: d.title,
        sublabel: `${d.weekdayShort} · ${d.dateLabel}`,
      })),
    [days],
  );

  const selected = days[dayIndex] ?? days[0];
  const startTime = dateToHHMM(startTimeD);
  const endTime = dateToHHMM(endTimeD);

  // A meal is "past" when the day begins at or after the end of its window —
  // i.e. it's already over by the time this plan starts (for today, the start
  // time defaults to now, so this reads as "after our meal time"). Such a meal
  // can't be planned, so its row is disabled and its preference is dropped.
  const startMin = minutesOfDay(startTime);
  const mealPassed = useCallback(
    (meal: MealKey): boolean => {
      if (startMin == null) return false;
      const w = mealWindows[meal];
      const refMin = minutesOfDay(w?.end ?? w?.start ?? undefined);
      return refMin != null && startMin >= refMin;
    },
    [mealWindows, startMin],
  );

  // The "HH:MM" / Date the meal's start (or end) editor seeds from: the saved
  // window value, falling back to a sensible default when the profile has none.
  const mealEdgeHHMM = useCallback(
    (meal: MealKey, edge: 'start' | 'end'): string => {
      const w = mealWindows[meal];
      const saved = edge === 'start' ? w?.start : w?.end;
      return saved ?? MEAL_DEFAULT_WINDOW[meal][edge];
    },
    [mealWindows],
  );

  // Scrubbing a meal time writes straight to the local profile mirror so the
  // window text + "passed" state update live; the DB write is deferred to when
  // the editor closes (commitMealEdits) to avoid a request per spinner tick.
  const onMealEdgeChange = (
    meal: MealKey,
    edge: 'start' | 'end',
    picked?: Date,
  ) => {
    if (Platform.OS !== 'ios') setAndroidMealPicker(null);
    if (!picked) return;
    Haptics.selectionAsync().catch(() => undefined);
    const field = MEAL_FIELDS[meal][edge];
    const patch: Partial<MealWindowsInput> = { [field]: dateToHHMM(picked) };
    useProfileStore.getState().hydrate(patch);
  };

  // Persist the meal being edited (if any) to the profile, then collapse the
  // editor. Safe to call any time the meals step is left.
  const commitMealEdits = useCallback(() => {
    if (editingMeal) {
      const fields = MEAL_FIELDS[editingMeal];
      const p = useProfileStore.getState();
      const patch: Partial<MealWindowsInput> = {};
      const start = p[fields.start];
      const end = p[fields.end];
      if (start) patch[fields.start] = start;
      if (end) patch[fields.end] = end;
      if (Object.keys(patch).length > 0) void updateMealWindows(patch);
    }
    setEditingMeal(null);
    setAndroidMealPicker(null);
  }, [editingMeal, updateMealWindows]);

  const toggleMealEditor = (meal: MealKey) => {
    Haptics.selectionAsync().catch(() => undefined);
    // Tapping the open meal closes it; tapping another commits the open one
    // first, then opens the new one (only one editor at a time). Decide from
    // the value before commit clears it, so re-tapping the open meal collapses.
    const wasEditing = editingMeal === meal;
    commitMealEdits();
    if (!wasEditing) setEditingMeal(meal);
  };

  const goToStep = (next: Step) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(
      () => undefined,
    );
    commitMealEdits();
    setAndroidPicker(false);
    setActiveRow(null);
    setStep(next);
  };

  // A meal set to "Out" needs a real spot — a specific place or a Discover pick
  // (its `mealLinks` entry) — before the day can be planned. Still-upcoming
  // "Out" meals with no link block Confirm; a passed meal is moot (confirm()
  // coerces it to 'auto'), so it never blocks.
  const unplacedOutMeals = MEAL_KEYS.filter(
    (m) => mealModes[m] === 'out' && !mealLinks[m] && !mealPassed(m),
  );
  const mealsReady = unplacedOutMeals.length === 0;

  const confirm = () => {
    if (!selected) return;
    if (!mealsReady) return;
    commitMealEdits();
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(
      () => undefined,
    );
    // Never carry a preference (or errand link) for a meal that's already over
    // for this day — the planner shouldn't try to place it.
    const mModes = { ...mealModes };
    const mLinks = { ...mealLinks };
    for (const meal of MEAL_KEYS) {
      if (mealPassed(meal)) {
        mModes[meal] = 'auto';
        mLinks[meal] = null;
      }
    }
    onConfirm({
      date: selected.iso,
      startTime,
      startLocation: startLoc,
      endTime,
      endLocation: endLoc,
      mealModes: mModes,
      mealLinks: mLinks,
    });
  };

  // DEV: snapshot EVERY user-side planning input (the three drawer steps plus
  // the profile, anchors, full errand + recurring lists, and saved people) as
  // JSON to hand to an external model. Mirrors the home screen's errand-copy
  // export: shares via the OS sheet (its "Copy" hits the clipboard) and always
  // logs to Metro as a fallback — no native clipboard module / rebuild needed.
  const copyInputs = useCallback(async () => {
    if (!selected) return;
    const payload = buildPlanInputsPayload({
      date: selected.iso,
      startTime,
      startLocation: startLoc,
      endTime,
      endLocation: endLoc,
      mealModes,
      mealLinks,
      useCarToday,
    });
    const json = JSON.stringify(payload, null, 2);
    console.log(`[plan-inputs-copy] ${selected.iso}\n${json}`);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(
      () => undefined,
    );
    try {
      await Share.share({ message: json });
    } catch {
      // dismissed / unavailable — the console log above is the fallback.
    }
  }, [
    selected,
    startTime,
    startLoc,
    endTime,
    endLoc,
    mealModes,
    mealLinks,
    useCarToday,
  ]);

  // Commit any in-progress meal edit before the sheet dismisses (drag-down,
  // backdrop tap, or the close button) so a tweak is never silently lost.
  const handleClose = () => {
    commitMealEdits();
    onClose();
  };

  const closeButton = (
    <Pressable
      onPress={() => {
        Haptics.selectionAsync().catch(() => undefined);
        handleClose();
      }}
      hitSlop={10}
      style={[styles.iconBtn, { backgroundColor: t.colors.fill1 }]}
      accessibilityLabel="Close"
    >
      <Ionicons name="close" size={18} color={t.colors.textSecondary} />
    </Pressable>
  );

  // Where the meal-place search/Discover centres when nothing more specific is
  // chosen: the day's start, else home, else the live position. Memoised so its
  // reference is stable (the search effect keys off it).
  const mealCenter = useMemo<Coords | null>(() => {
    if (startLoc) return { latitude: startLoc.latitude, longitude: startLoc.longitude };
    if (home) return { latitude: home.latitude, longitude: home.longitude };
    if (currentLoc) return { latitude: currentLoc.latitude, longitude: currentLoc.longitude };
    return null;
  }, [startLoc, home, currentLoc]);

  return (
    <Sheet
      open={open}
      onClose={handleClose}
      heightFraction={0.99}
      enableContentPanningGesture={false}
    >
      <View style={styles.container}>
        {mealPicker ? (
          <MealPlacePicker
            meal={mealPicker.meal}
            method={mealPicker.method}
            onMethodChange={(m) =>
              setMealPicker((p) => (p ? { ...p, method: m } : p))
            }
            center={mealCenter}
            anchorDate={days[dayIndex]?.iso ?? null}
            anchorTime={mealWindows[mealPicker.meal]?.start ?? null}
            onPicked={onMealPlacePicked}
            onCancel={() => setMealPicker(null)}
          />
        ) : (
        <View style={[styles.stepInner, { paddingBottom: insets.bottom + 4 }]}>
          {step === 0 ? (
            // ---- STEP 0 — pick the day ------------------------------------
            <>
              <Animated.View
                key="s0-header"
                entering={ENTER(0)}
                exiting={EXIT(0)}
                style={styles.header}
              >
                <View style={{ flex: 1 }}>
                  <Text variant="micro" tone="tertiary" uppercase weight="bold">
                    Plan a day · 1 of 2
                  </Text>
                  <Text variant="title3" weight="bold" tight>
                    When&rsquo;s your day?
                  </Text>
                </View>
                {closeButton}
              </Animated.View>

              <Animated.View
                key="s0-wheel"
                entering={ENTER(1)}
                exiting={EXIT(1)}
                style={styles.wheelWrap}
              >
                <WheelPicker
                  options={options}
                  selectedIndex={dayIndex}
                  onChange={onDayChange}
                  itemHeight={84}
                  visibleCount={5}
                  labelStyle={styles.wheelLabel}
                  sublabelStyle={styles.wheelSublabel}
                />
              </Animated.View>

              <TimeRow
                key="s0-time"
                index={2}
                rowId="s0-time"
                activeRow={activeRow}
                onActivate={setActiveRow}
                icon="time-outline"
                title="Start time"
                hint={
                  selected?.isToday
                    ? 'Defaults to now'
                    : 'Defaults to your day start'
                }
                value={startTimeD}
                display={formatTime(startTime)}
                onChange={onStartTimeChange}
                onAndroidOpen={() => setAndroidPicker('start')}
              />

              {hasCar ? (
                <Animated.View
                  key="s0-car"
                  entering={ENTER(3)}
                  exiting={EXIT(3)}
                  style={[styles.row, { borderTopColor: t.colors.separator }]}
                >
                  <View style={styles.rowLabel}>
                    <Ionicons
                      name={useCarToday ? 'car-sport' : 'walk'}
                      size={18}
                      color={t.colors.textSecondary}
                    />
                    <View style={{ flex: 1 }}>
                      <Text variant="body" weight="semibold">
                        Use my car today
                      </Text>
                      <Text variant="caption" tone="tertiary">
                        {useCarToday
                          ? 'Driven only when it helps'
                          : 'Walking & transit only for this day'}
                      </Text>
                    </View>
                  </View>
                  <Switch
                    value={useCarToday}
                    onValueChange={(v) => {
                      Haptics.selectionAsync().catch(() => undefined);
                      setUseCarToday(v);
                    }}
                    trackColor={{ true: t.colors.accent, false: t.colors.fill2 }}
                  />
                </Animated.View>
              ) : null}

              <Animated.View
                key="s0-footer"
                entering={ENTER(hasCar ? 4 : 3)}
                exiting={EXIT(hasCar ? 4 : 3)}
                style={styles.footer}
              >
                <Text variant="caption" tone="secondary" style={styles.summary}>
                  {selected
                    ? `${selected.title}, ${selected.dateLabel} · starts ${formatTime(
                        startTime,
                      )}`
                    : ''}
                </Text>
                <Button
                  title="Continue"
                  onPress={() => goToStep(1)}
                  fullWidth
                  size="lg"
                  rightIcon={
                    <Ionicons
                      name="arrow-forward"
                      size={18}
                      color={t.colors.textOnAccent}
                    />
                  }
                />
              </Animated.View>
            </>
          ) : step === 1 ? (
            // ---- STEP 1 — start & end -------------------------------------
            <>
              <Animated.View
                key="s1-header"
                entering={ENTER(0)}
                exiting={EXIT(0)}
                style={styles.header}
              >
                <Pressable
                  onPress={() => goToStep(0)}
                  hitSlop={10}
                  style={[styles.iconBtn, { backgroundColor: t.colors.fill1 }]}
                  accessibilityLabel="Back"
                >
                  <Ionicons
                    name="chevron-back"
                    size={18}
                    color={t.colors.textSecondary}
                  />
                </Pressable>
                <View style={{ flex: 1 }}>
                  <Text variant="micro" tone="tertiary" uppercase weight="bold">
                    {selected
                      ? `${selected.title}, ${selected.dateLabel} · 2 of 3`
                      : '2 of 3'}
                  </Text>
                  <Text variant="title3" weight="bold" tight>
                    Start &amp; end
                  </Text>
                </View>
                {closeButton}
              </Animated.View>

              {/* Equal flex spacers above and below center the rows between the
                  header and footer. An expanding row grows symmetrically from the
                  middle, and the LinearTransition on each row animates the reflow. */}
              <View key="s1-spaceTop" style={{ flex: 1 }} />

              <TimeRow
                key="s1-startTime"
                index={1}
                rowId="s1-startTime"
                activeRow={activeRow}
                onActivate={setActiveRow}
                icon="play-circle-outline"
                title="Start time"
                hint={selected?.isToday ? 'Defaults to now' : 'Defaults to your day start'}
                value={startTimeD}
                display={formatTime(startTime)}
                onChange={onStartTimeChange}
                onAndroidOpen={() => setAndroidPicker('start')}
              />

              <AddressRow
                key="s1-startAddr"
                index={2}
                rowId="s1-startAddr"
                activeRow={activeRow}
                onActivate={setActiveRow}
                icon="navigate-circle-outline"
                title="Start address"
                hint="Defaults to your current location"
                value={startLoc}
                loading={locLoading}
                center={currentLoc ?? home ?? null}
                quickLabel="Home"
                quickIcon="home"
                quickActive={samePin(startLoc, home)}
                quickAvailable={!!home}
                onUseQuick={() => setStartLoc(home)}
                onPick={(pin) => setStartLoc(pin)}
              />

              <TimeRow
                key="s1-endTime"
                index={3}
                rowId="s1-endTime"
                activeRow={activeRow}
                onActivate={setActiveRow}
                icon="flag-outline"
                title="End time"
                hint="Defaults to your usual bedtime"
                value={endTimeD}
                display={formatTime(endTime)}
                onChange={onEndTimeChange}
                onAndroidOpen={() => setAndroidPicker('end')}
              />

              <AddressRow
                key="s1-endAddr"
                index={4}
                rowId="s1-endAddr"
                activeRow={activeRow}
                onActivate={setActiveRow}
                icon="home-outline"
                title="End address"
                hint="Defaults to home"
                value={endLoc}
                loading={false}
                center={currentLoc ?? home ?? null}
                quickLabel="Current"
                quickIcon="navigate"
                quickActive={samePin(endLoc, currentLoc)}
                quickAvailable={!!currentLoc}
                onUseQuick={() => setEndLoc(currentLoc)}
                onPick={(pin) => setEndLoc(pin)}
              />

              <View key="s1-spaceBottom" style={{ flex: 1 }} />

              <Animated.View
                key="s1-footer"
                entering={ENTER(5)}
                exiting={EXIT(5)}
                style={styles.footer}
              >
                <Button
                  title="Continue"
                  onPress={() => goToStep(2)}
                  fullWidth
                  size="lg"
                  rightIcon={
                    <Ionicons
                      name="arrow-forward"
                      size={18}
                      color={t.colors.textOnAccent}
                    />
                  }
                />
              </Animated.View>
            </>
          ) : (
            // ---- STEP 2 — meals ------------------------------------------
            <>
              <Animated.View
                key="s2-header"
                entering={ENTER(0)}
                exiting={EXIT(0)}
                style={styles.header}
              >
                <Pressable
                  onPress={() => goToStep(1)}
                  hitSlop={10}
                  style={[styles.iconBtn, { backgroundColor: t.colors.fill1 }]}
                  accessibilityLabel="Back"
                >
                  <Ionicons
                    name="chevron-back"
                    size={18}
                    color={t.colors.textSecondary}
                  />
                </Pressable>
                <View style={{ flex: 1 }}>
                  <Text variant="micro" tone="tertiary" uppercase weight="bold">
                    {selected
                      ? `${selected.title}, ${selected.dateLabel} · 3 of 3`
                      : '3 of 3'}
                  </Text>
                  <Text variant="title3" weight="bold" tight>
                    Meals
                  </Text>
                </View>
                {closeButton}
              </Animated.View>

              {/* <View key="s2-spaceTop" style={{ flex: 1 }} /> */}

              <Animated.View key="s2-intro" entering={ENTER(1)} exiting={EXIT(1)} style={{ marginBottom: 24 }}>
                <Text variant="caption" tone="tertiary">
                  Where you&apos;ll eat. Meals default to{' '}
                  <Text variant="caption" tone="secondary" weight="semibold">
                    Home
                  </Text>
                  ; if one of your errands is a meal out, we slot it in. Switch
                  any to Out to pick a spot, or tap a meal&apos;s time to adjust
                  its window.
                </Text>
              </Animated.View>

              {MEAL_KEYS.map((meal, i) => (
                <MealRow
                  key={`s2-${meal}`}
                  index={i + 2}
                  meal={meal}
                  mode={mealModes[meal]}
                  window={mealWindows[meal]}
                  passed={mealPassed(meal)}
                  editing={editingMeal === meal}
                  startValue={hhmmToDate(mealEdgeHHMM(meal, 'start'))}
                  endValue={hhmmToDate(mealEdgeHHMM(meal, 'end'))}
                  startHHMM={mealEdgeHHMM(meal, 'start')}
                  endHHMM={mealEdgeHHMM(meal, 'end')}
                  onToggleEdit={() => toggleMealEditor(meal)}
                  onStartChange={(_, d) => onMealEdgeChange(meal, 'start', d)}
                  onEndChange={(_, d) => onMealEdgeChange(meal, 'end', d)}
                  onAndroidStart={() =>
                    setAndroidMealPicker({ meal, edge: 'start' })
                  }
                  onAndroidEnd={() => setAndroidMealPicker({ meal, edge: 'end' })}
                  linkedErrand={
                    mealLinks[meal]
                      ? errands.find((e) => e.id === mealLinks[meal]) ?? null
                      : null
                  }
                  onSetMode={(m) => setMealMode(meal, m)}
                  onUnlink={() => unlinkMeal(meal)}
                  onFindPlace={(method) => findMealPlace(meal, method)}
                />
              ))}

              <View key="s2-spaceBottom" style={{ flex: 1 }} />

              <Animated.View
                key="s2-footer"
                entering={ENTER(MEAL_KEYS.length + 2)}
                exiting={EXIT(MEAL_KEYS.length + 2)}
                style={styles.footer}
              >
               
                {!mealsReady ? (
                  <View style={styles.mealBlockHint}>
                    <Ionicons
                      name="restaurant-outline"
                      size={15}
                      color={t.colors.warning}
                    />
                    <Text variant="caption" tone="secondary" style={{ flex: 1 }}>
                      Pick a spot for {joinMeals(unplacedOutMeals)} out — search a place
                      or use Discover.
                    </Text>
                  </View>
                ) : null}
                <Button
                  title="Confirm"
                  onPress={confirm}
                  disabled={!mealsReady}
                  fullWidth
                  size="lg"
                />
              </Animated.View>
            </>
          )}
        </View>
        )}

        {androidPicker && Platform.OS !== 'ios' ? (
          <DateTimePicker
            value={androidPicker === 'end' ? endTimeD : startTimeD}
            mode="time"
            display="default"
            minuteInterval={5}
            onChange={androidPicker === 'end' ? onEndTimeChange : onStartTimeChange}
          />
        ) : null}

        {androidMealPicker && Platform.OS !== 'ios' ? (
          <DateTimePicker
            value={hhmmToDate(
              mealEdgeHHMM(androidMealPicker.meal, androidMealPicker.edge),
            )}
            mode="time"
            display="default"
            minuteInterval={5}
            onChange={(e, d) =>
              onMealEdgeChange(androidMealPicker.meal, androidMealPicker.edge, d)
            }
          />
        ) : null}
      </View>
    </Sheet>
  );
}

/**
 * A labelled time row. The whole row is the tap target: on iOS it expands an
 * inline spinner in place; on Android it opens the system time dialog. The pill
 * on the right mirrors the value and highlights while the spinner is open.
 */
function TimeRow({
  index,
  rowId,
  activeRow,
  onActivate,
  icon,
  title,
  hint,
  value,
  display,
  onChange,
  onAndroidOpen,
}: {
  index: number;
  rowId: string;
  activeRow: string | null;
  onActivate: (id: string | null) => void;
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  hint: string;
  value: Date;
  display: string;
  onChange: (e: DateTimePickerEvent, d?: Date) => void;
  onAndroidOpen: () => void;
}) {
  const t = useTheme();
  const isIOS = Platform.OS === 'ios';
  // Controlled by the parent so opening another row collapses this one.
  const expanded = activeRow === rowId;

  const handlePress = () => {
    Haptics.selectionAsync().catch(() => undefined);
    if (isIOS) {
      onActivate(expanded ? null : rowId);
    } else {
      // No inline spinner on Android; collapse any open row and defer to the
      // system dialog.
      onActivate(null);
      onAndroidOpen();
    }
  };

  return (
    <Animated.View
      entering={ENTER(index)}
      exiting={EXIT(index)}
      layout={LinearTransition.duration(220)}
      style={[styles.rowOuter, { borderTopColor: t.colors.separator }]}
    >
      <Pressable
        onPress={handlePress}
        style={({ pressed }) => [styles.rowTap, pressed && { opacity: 0.6 }]}
        accessibilityRole="button"
        accessibilityLabel={`${title}: ${display}`}
      >
        <View style={styles.rowLabel}>
          <Ionicons name={icon} size={18} color={t.colors.textSecondary} />
          <View style={{ flex: 1 }}>
            <Text variant="body" weight="semibold">
              {title}
            </Text>
            <Text variant="caption" tone="tertiary">
              {hint}
            </Text>
          </View>
        </View>
        <View
          style={[
            styles.timePill,
            { backgroundColor: expanded ? t.colors.accent : t.colors.fill1 },
          ]}
        >
          <Text
            variant="body"
            weight="bold"
            style={{
              color: expanded ? t.colors.textOnAccent : t.colors.accent,
            }}
          >
            {display}
          </Text>
        </View>
      </Pressable>

      {isIOS && expanded ? (
        <Animated.View
          entering={FadeIn.duration(160)}
          exiting={FadeOut.duration(120)}
          style={styles.spinnerWrap}
        >
          <DateTimePicker
            value={value}
            mode="time"
            display="spinner"
            minuteInterval={5}
            onChange={onChange}
            themeVariant={t.isDark ? 'dark' : 'light'}
            style={styles.spinner}
          />
        </Animated.View>
      ) : null}
    </Animated.View>
  );
}

type AddrSearch =
  | { kind: 'idle' }
  | { kind: 'searching' }
  | { kind: 'results'; predictions: PlacePrediction[] }
  | { kind: 'no_results' };

const SEARCH_DEBOUNCE_MS = 300;

/** A resolved place chosen for an Out meal, from either search or Discover. */
interface PickedMealPlace {
  name: string;
  latitude: number;
  longitude: number;
  placeId?: string;
  photoUrl?: string;
  rating?: number;
  ratingCount?: number;
  priceLevel?: number;
  openingHours?: Errand['openingHours'];
}

/** A sensible block length for a dining stop: the meal window, capped to a
 *  comfortable sitting (45–90 min) so a wide "anytime lunch" window doesn't
 *  reserve hours. */
function mealDurationMin(w?: MealWindow): number {
  const s = w?.start ? minutesOfDay(w.start) : null;
  const e = w?.end ? minutesOfDay(w.end) : null;
  if (s != null && e != null && e > s) {
    return Math.max(45, Math.min(90, e - s));
  }
  return 60;
}

function newSessionToken(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * A labelled address row. In its resting state it shows the resolved address
 * with a single quick chip (Home for the start, Current for the end). Tapping
 * the row pushes that content out to the left and slides in a live search
 * field backed by Google Places (addresses + venues, typo-tolerant); picking a
 * result resolves its coordinates, sets the pin, and slides back.
 */
function AddressRow({
  index,
  rowId,
  activeRow,
  onActivate,
  icon,
  title,
  hint,
  value,
  loading,
  center,
  quickLabel,
  quickIcon,
  quickActive,
  quickAvailable,
  onUseQuick,
  onPick,
}: {
  index: number;
  rowId: string;
  activeRow: string | null;
  onActivate: (id: string | null) => void;
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  hint: string;
  value: LocationPin | null;
  loading: boolean;
  center: { latitude: number; longitude: number } | null;
  quickLabel: string;
  quickIcon: keyof typeof Ionicons.glyphMap;
  quickActive: boolean;
  quickAvailable: boolean;
  onUseQuick: () => void;
  onPick: (pin: LocationPin) => void;
}) {
  const t = useTheme();
  // Controlled by the parent so opening another row collapses this one.
  const editing = activeRow === rowId;
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState<AddrSearch>({ kind: 'idle' });
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [laneW, setLaneW] = useState(0);
  const inputRef = useRef<TextInput>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // One Google "session" per edit so autocomplete + details bill as a unit.
  const sessionRef = useRef<string>(newSessionToken());
  const tx = useSharedValue(0);

  const trackStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.value }],
  }));

  // Slide the lane to reveal the search field (and back) whenever editing flips.
  useEffect(() => {
    tx.value = withTiming(editing ? -laneW : 0, {
      duration: 320,
      easing: Easing.out(Easing.cubic),
    });
  }, [editing, laneW, tx]);

  // Debounced place + address search while the field is open.
  useEffect(() => {
    if (!editing) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = query.trim();
    if (q.length < 3) {
      setSearch({ kind: 'idle' });
      return;
    }
    setSearch({ kind: 'searching' });
    debounceRef.current = setTimeout(async () => {
      const predictions = await autocompletePlaces(q, center, sessionRef.current);
      setSearch(
        predictions.length > 0
          ? { kind: 'results', predictions }
          : { kind: 'no_results' },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, editing, center]);

  // React to the controlled `editing` flag. This runs whether the row was
  // opened/closed by its own tap OR collapsed because another row opened, so
  // focus + teardown stay correct in every case.
  useEffect(() => {
    if (editing) {
      sessionRef.current = newSessionToken();
      // Focus after the slide has begun so the keyboard rises with the field.
      const id = setTimeout(() => inputRef.current?.focus(), 80);
      return () => clearTimeout(id);
    }
    inputRef.current?.blur();
    setQuery('');
    setSearch({ kind: 'idle' });
    setResolvingId(null);
    return undefined;
  }, [editing]);

  const openEdit = () => {
    Haptics.selectionAsync().catch(() => undefined);
    onActivate(rowId);
  };

  const closeEdit = () => {
    Haptics.selectionAsync().catch(() => undefined);
    onActivate(null);
  };

  const pick = async (prediction: PlacePrediction) => {
    Haptics.selectionAsync().catch(() => undefined);
    setResolvingId(prediction.placeId);
    const resolved = await resolvePlace(prediction.placeId, sessionRef.current);
    // A fresh session starts after a successful details lookup.
    sessionRef.current = newSessionToken();
    if (!resolved) {
      setResolvingId(null);
      return;
    }
    onPick({
      label: resolved.label,
      latitude: resolved.latitude,
      longitude: resolved.longitude,
    });
    closeEdit();
  };

  return (
    <Animated.View
      entering={ENTER(index)}
      exiting={EXIT(index)}
      layout={LinearTransition.duration(220)}
      style={[styles.rowOuter, { borderTopColor: t.colors.separator }]}
    >
      <View
        style={styles.lane}
        onLayout={(e) => setLaneW(e.nativeEvent.layout.width)}
      >
        <Animated.View
          style={[
            styles.track,
            trackStyle,
            { width: laneW ? laneW * 2 : '200%' },
          ]}
        >
          {/* Resting pane — tap anywhere to start searching. */}
          <Pressable
            disabled={editing}
            onPress={openEdit}
            style={({ pressed }) => [
              styles.pane,
              laneW ? { width: laneW } : { flex: 1 },
              pressed && { opacity: 0.6 },
            ]}
            accessibilityRole="button"
            accessibilityLabel={`${title}, tap to search an address`}
          >
            <View style={styles.rowLabel}>
              <Ionicons name={icon} size={18} color={t.colors.textSecondary} />
              <View style={{ flex: 1 }}>
                <Text variant="body" weight="semibold">
                  {title}
                </Text>
                {loading ? (
                  <View style={styles.addrLoading}>
                    <ActivityIndicator
                      size="small"
                      color={t.colors.textSecondary}
                    />
                    <Text variant="caption" tone="tertiary">
                      Finding you…
                    </Text>
                  </View>
                ) : (
                  <Text variant="caption" tone="tertiary" numberOfLines={1}>
                    {value?.label ?? hint}
                  </Text>
                )}
              </View>
            </View>
            <View style={styles.addrRight}>
              <LocChip
                label={quickLabel}
                icon={quickIcon}
                active={quickActive}
                disabled={!quickAvailable}
                onPress={onUseQuick}
              />
              <Ionicons name="search" size={16} color={t.colors.textTertiary} />
            </View>
          </Pressable>

          {/* Search pane — slides in from the right. */}
          <View style={[styles.pane, laneW ? { width: laneW } : { flex: 1 }]}>
            <View
              style={[
                styles.searchField,
                {
                  backgroundColor: t.colors.fill1,
                  borderRadius: t.radii.md,
                },
              ]}
            >
              <Ionicons
                name="search"
                size={18}
                color={t.colors.textSecondary}
              />
              <BottomSheetTextInput
                // gorhom types its ref against gesture-handler's TextInput;
                // we only call focus()/blur(), which the native input supports.
                ref={inputRef as any}
                placeholder="Search an address"
                placeholderTextColor={t.colors.textTertiary}
                value={query}
                onChangeText={setQuery}
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="search"
                style={[styles.searchTextInput, { color: t.colors.textPrimary }]}
              />
            </View>
            <Pressable
              onPress={closeEdit}
              hitSlop={8}
              style={[styles.iconBtn, { backgroundColor: t.colors.fill1 }]}
              accessibilityLabel="Cancel address search"
            >
              <Ionicons name="close" size={16} color={t.colors.textSecondary} />
            </Pressable>
          </View>
        </Animated.View>
      </View>

      {editing ? (
        <Animated.View
          entering={FadeIn.duration(160)}
          exiting={FadeOut.duration(120)}
          style={styles.results}
        >
          {search.kind === 'searching' ? (
            <View style={styles.resultStatus}>
              <ActivityIndicator size="small" color={t.colors.textSecondary} />
              <Text variant="caption" tone="tertiary">
                Searching…
              </Text>
            </View>
          ) : null}
          {search.kind === 'no_results' ? (
            <Text
              variant="caption"
              tone="tertiary"
              style={styles.resultStatus}
            >
              No matches — try a place name or a more specific address.
            </Text>
          ) : null}
          {search.kind === 'results'
            ? search.predictions.map((prediction, i) => {
                const isResolving = resolvingId === prediction.placeId;
                return (
                  <Pressable
                    key={prediction.placeId}
                    onPress={() => pick(prediction)}
                    disabled={resolvingId !== null}
                    style={({ pressed }) => [
                      styles.hitRow,
                      i > 0 && {
                        borderTopWidth: StyleSheet.hairlineWidth,
                        borderTopColor: t.colors.separator,
                      },
                      pressed && { opacity: 0.6 },
                    ]}
                  >
                    {isResolving ? (
                      <ActivityIndicator
                        size="small"
                        color={t.colors.textSecondary}
                        style={styles.hitIcon}
                      />
                    ) : (
                      <Ionicons
                        name="location-outline"
                        size={16}
                        color={t.colors.textSecondary}
                        style={styles.hitIcon}
                      />
                    )}
                    <View style={{ flex: 1 }}>
                      <Text variant="bodySm" weight="semibold" numberOfLines={1}>
                        {prediction.primary}
                      </Text>
                      {prediction.secondary ? (
                        <Text variant="caption" tone="tertiary" numberOfLines={1}>
                          {prediction.secondary}
                        </Text>
                      ) : null}
                    </View>
                  </Pressable>
                );
              })
            : null}
        </Animated.View>
      ) : null}
    </Animated.View>
  );
}

/** A small quick-set chip (Home / Current) shown on an address row. */
function LocChip({
  label,
  icon,
  active,
  disabled,
  onPress,
}: {
  label: string;
  icon?: keyof typeof Ionicons.glyphMap;
  active: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  const t = useTheme();
  const color = active ? t.colors.textOnAccent : t.colors.textSecondary;
  return (
    <Pressable
      disabled={disabled || active}
      onPress={() => {
        Haptics.selectionAsync().catch(() => undefined);
        onPress();
      }}
      style={({ pressed }) => [
        styles.chip,
        {
          backgroundColor: active ? t.colors.accent : t.colors.fill1,
        },
        disabled && { opacity: 0.4 },
        pressed && !active && { opacity: 0.7 },
      ]}
    >
      {icon ? (
        <Ionicons name={icon} size={13} color={color} style={{ marginRight: 4 }} />
      ) : null}
      <Text variant="caption" weight="bold" style={{ color }}>
        {label}
      </Text>
    </Pressable>
  );
}

/** Time · place line shown under a linked dining errand's title. */
function linkedErrandMeta(e: Errand): string {
  const parts: string[] = [];
  if (e.startTime) {
    parts.push(
      e.endTime
        ? `${formatTime(e.startTime)} – ${formatTime(e.endTime)}`
        : formatTime(e.startTime),
    );
  }
  if (e.address && e.address.trim()) parts.push(e.address.trim());
  return parts.join(' · ');
}

/**
 * A meal time chip: an inline compact picker on iOS, or a pill that opens the
 * system dialog on Android. Mirrors onboarding's meal-window editor.
 */
function MealTimeChip({
  value,
  hhmm,
  onChange,
  onAndroidPress,
}: {
  value: Date;
  hhmm: string;
  onChange: (e: DateTimePickerEvent, d?: Date) => void;
  onAndroidPress: () => void;
}) {
  const t = useTheme();
  if (Platform.OS === 'ios') {
    return (
      <DateTimePicker
        value={value}
        mode="time"
        display="compact"
        minuteInterval={5}
        onChange={onChange}
        themeVariant={t.isDark ? 'dark' : 'light'}
      />
    );
  }
  return (
    <Pressable
      onPress={() => {
        Haptics.selectionAsync().catch(() => undefined);
        onAndroidPress();
      }}
      style={[styles.mealTimePill, { backgroundColor: t.colors.fill1 }]}
    >
      <Text variant="body" weight="bold" tone="accent">
        {formatTime(hhmm)}
      </Text>
    </Pressable>
  );
}

/**
 * One meal's preference row: a label + window with an inline time editor, then
 * EITHER the dining errand that covers it (with an unlink "×") OR a three-way
 * No preference / Home / Out segmented control. A meal whose window is already
 * over for this day reads as `passed` — its controls are hidden and it won't be
 * planned. Re-seeded per day, so it never carries stale picks.
 */
function MealRow({
  index,
  meal,
  mode,
  window,
  passed,
  editing,
  startValue,
  endValue,
  startHHMM,
  endHHMM,
  onToggleEdit,
  onStartChange,
  onEndChange,
  onAndroidStart,
  onAndroidEnd,
  linkedErrand,
  onSetMode,
  onUnlink,
  onFindPlace,
}: {
  index: number;
  meal: MealKey;
  mode: MealMode;
  window?: MealWindow;
  passed: boolean;
  editing: boolean;
  startValue: Date;
  endValue: Date;
  startHHMM: string;
  endHHMM: string;
  onToggleEdit: () => void;
  onStartChange: (e: DateTimePickerEvent, d?: Date) => void;
  onEndChange: (e: DateTimePickerEvent, d?: Date) => void;
  onAndroidStart: () => void;
  onAndroidEnd: () => void;
  linkedErrand: Errand | null;
  onSetMode: (mode: MealMode) => void;
  onUnlink: () => void;
  onFindPlace: (method: 'search' | 'discover') => void;
}) {
  const t = useTheme();
  const meta = MEAL_META[meal];
  const windowText =
    window?.start && window?.end
      ? `${formatTime(window.start)} – ${formatTime(window.end)}`
      : window?.start
        ? `around ${formatTime(window.start)}`
        : 'Anytime';
  const linkedMeta = linkedErrand ? linkedErrandMeta(linkedErrand) : '';

  // Dim, but keep the time editor reachable, so a passed meal can be nudged
  // back into the day by adjusting its window.
  const subtitle =
    !editing && passed
      ? 'Already passed'
      : linkedErrand
        ? 'From your errand'
        : windowText;

  const options: { value: MealMode; label: string }[] = [
    { value: 'home', label: 'Home' },
    { value: 'out', label: 'Out' },
  ];

  return (
    <Animated.View
      entering={ENTER(index)}
      exiting={EXIT(index)}
      layout={LinearTransition.duration(220)}
      style={[styles.rowOuter, { borderTopColor: t.colors.separator }]}
    >
      <View style={styles.mealHead}>
        <View
          style={[styles.mealHeadMain, passed && !editing && styles.mealDimmed]}
        >
          <Ionicons name={meta.icon} size={18} color={t.colors.textSecondary} />
          <View style={{ flex: 1 }}>
            <Text variant="body" weight="semibold">
              {meta.label}
            </Text>
            <Text variant="caption" tone="tertiary">
              {subtitle}
            </Text>
          </View>
        </View>
        <Pressable
          onPress={onToggleEdit}
          hitSlop={8}
          style={[
            styles.iconBtn,
            { backgroundColor: editing ? t.colors.accent : t.colors.fill1 },
          ]}
          accessibilityRole="button"
          accessibilityLabel={
            editing ? `Done editing ${meta.label} time` : `Edit ${meta.label} time`
          }
        >
          <Ionicons
            name={editing ? 'checkmark' : 'time-outline'}
            size={16}
            color={editing ? t.colors.textOnAccent : t.colors.textSecondary}
          />
        </Pressable>
      </View>

      {editing ? (
        <Animated.View
          entering={FadeIn.duration(160)}
          exiting={FadeOut.duration(120)}
          style={styles.mealEditor}
        >
          <MealTimeChip
            value={startValue}
            hhmm={startHHMM}
            onChange={onStartChange}
            onAndroidPress={onAndroidStart}
          />
          <Text variant="bodySm" tone="tertiary">
            to
          </Text>
          <MealTimeChip
            value={endValue}
            hhmm={endHHMM}
            onChange={onEndChange}
            onAndroidPress={onAndroidEnd}
          />
        </Animated.View>
      ) : passed ? null : linkedErrand ? (
        <Pressable
          onPress={onUnlink}
          style={[styles.linkedCard, { backgroundColor: t.colors.fill1 }]}
          accessibilityRole="button"
          accessibilityLabel={`${meta.label} from your errand ${linkedErrand.title}. Tap to remove and choose instead.`}
        >
          {linkedErrand.photoUrl ? (
            <Image
              source={{ uri: linkedErrand.photoUrl }}
              style={[styles.linkedThumb, { backgroundColor: t.colors.fill2 }]}
            />
          ) : (
            <View
              style={[
                styles.linkedThumb,
                styles.linkedThumbFallback,
                { backgroundColor: t.colors.fill2 },
              ]}
            >
              <Ionicons name="restaurant" size={18} color={t.colors.accent} />
            </View>
          )}
          <View style={styles.linkedText}>
            <Text variant="bodySm" weight="semibold" numberOfLines={1}>
              {linkedErrand.title}
            </Text>
            {linkedMeta ? (
              <Text variant="caption" tone="tertiary" numberOfLines={1}>
                {linkedMeta}
              </Text>
            ) : null}
          </View>
          <Ionicons name="close-circle" size={20} color={t.colors.textTertiary} />
        </Pressable>
      ) : (
        <View style={styles.mealOutWrap}>
          <View style={styles.segment}>
            {options.map((o) => {
              const active = mode === o.value;
              return (
                <Pressable
                  key={o.value}
                  onPress={() => onSetMode(o.value)}
                  style={[
                    styles.segChip,
                    { backgroundColor: active ? t.colors.accent : t.colors.fill1 },
                  ]}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  accessibilityLabel={`${meta.label}: ${o.label}`}
                >
                  <Text
                    variant="caption"
                    weight="bold"
                    numberOfLines={1}
                    style={{
                      color: active
                        ? t.colors.textOnAccent
                        : t.colors.textSecondary,
                    }}
                  >
                    {o.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          {/* Eating out → let the user pin the exact spot (by search or
              Discover), or leave it for the planner to fill near the route. */}
          {mode === 'out' ? (
            <View style={styles.findRow}>
              <Pressable
                onPress={() => onFindPlace('search')}
                style={[styles.findBtn, { borderColor: t.colors.accent }]}
                accessibilityRole="button"
                accessibilityLabel={`Search a place for ${meta.label}`}
              >
                <Ionicons name="search" size={14} color={t.colors.accent} />
                <Text variant="caption" weight="bold" style={{ color: t.colors.accent }}>
                  Search a place
                </Text>
              </Pressable>
              <Pressable
                onPress={() => onFindPlace('discover')}
                style={[styles.findBtn, { borderColor: t.colors.accent }]}
                accessibilityRole="button"
                accessibilityLabel={`Discover a place for ${meta.label}`}
              >
                <Ionicons name="compass" size={15} color={t.colors.accent} />
                <Text variant="caption" weight="bold" style={{ color: t.colors.accent }}>
                  Discover
                </Text>
              </Pressable>
            </View>
          ) : null}
        </View>
      )}
    </Animated.View>
  );
}

/**
 * Full-sheet picker for an Out meal's exact spot. Two methods share one surface:
 * a manual Google search (precise venue/address, like the errand drawer) and the
 * Discover step (curated suggestions, anchorable to the day's other stops). A
 * pick hands back a resolved place the meals step turns into a dining stop.
 */
function MealPlacePicker({
  meal,
  method,
  onMethodChange,
  center,
  anchorDate,
  anchorTime,
  onPicked,
  onCancel,
}: {
  meal: MealKey;
  method: 'search' | 'discover';
  onMethodChange: (m: 'search' | 'discover') => void;
  center: Coords | null;
  anchorDate: string | null;
  anchorTime: string | null;
  onPicked: (place: PickedMealPlace) => void;
  onCancel: () => void;
}) {
  const t = useTheme();
  const meta = MEAL_META[meal];
  const methods: {
    value: 'search' | 'discover';
    label: string;
    icon: keyof typeof Ionicons.glyphMap;
  }[] = [
    { value: 'search', label: 'Search', icon: 'search' },
    { value: 'discover', label: 'Discover', icon: 'compass' },
  ];
  return (
    <View style={styles.pickerWrap}>
      <View style={styles.pickerHeader}>
        <Pressable
          onPress={onCancel}
          hitSlop={10}
          style={[styles.iconBtn, { backgroundColor: t.colors.fill1 }]}
          accessibilityRole="button"
          accessibilityLabel="Back to meals"
        >
          <Ionicons name="chevron-back" size={18} color={t.colors.textSecondary} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text variant="micro" tone="tertiary" uppercase weight="bold">
            Where you&apos;ll eat
          </Text>
          <Text variant="title3" weight="bold">
            {meta.label} out
          </Text>
        </View>
      </View>

      <View style={styles.methodToggle}>
        {methods.map((m) => {
          const active = method === m.value;
          return (
            <Pressable
              key={m.value}
              onPress={() => onMethodChange(m.value)}
              style={[
                styles.methodChip,
                { backgroundColor: active ? t.colors.accent : t.colors.fill1 },
              ]}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              accessibilityLabel={`Find by ${m.label}`}
            >
              <Ionicons
                name={m.icon}
                size={14}
                color={active ? t.colors.textOnAccent : t.colors.textSecondary}
              />
              <Text
                variant="caption"
                weight="bold"
                style={{
                  color: active ? t.colors.textOnAccent : t.colors.textSecondary,
                }}
              >
                {m.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {method === 'discover' ? (
        <ErrandDiscoverStep
          query=""
          area={null}
          nearby={false}
          fallbackCenter={center}
          anchorDate={anchorDate}
          anchorTime={anchorTime}
          onPick={(place) =>
            onPicked({
              name: place.name,
              latitude: place.latitude,
              longitude: place.longitude,
              placeId: place.id ?? undefined,
              photoUrl: place.photoUrl ?? undefined,
              rating: place.rating ?? undefined,
              ratingCount: place.ratingCount ?? undefined,
              priceLevel: place.priceLevel ?? undefined,
              openingHours: place.openingHours ?? undefined,
            })
          }
          onManual={() => onMethodChange('search')}
        />
      ) : (
        <MealSearch center={center} onPicked={onPicked} />
      )}
    </View>
  );
}

/**
 * The manual "search a place" method: forgiving Google autocomplete (the same
 * backing as the start/end address rows), resolving the tapped result to real
 * coordinates + venue metadata for the dining stop.
 */
function MealSearch({
  center,
  onPicked,
}: {
  center: Coords | null;
  onPicked: (place: PickedMealPlace) => void;
}) {
  const t = useTheme();
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState<AddrSearch>({ kind: 'idle' });
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionRef = useRef<string>(newSessionToken());

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = query.trim();
    if (q.length < 3) {
      setSearch({ kind: 'idle' });
      return;
    }
    setSearch({ kind: 'searching' });
    debounceRef.current = setTimeout(async () => {
      const predictions = await autocompletePlaces(q, center, sessionRef.current);
      setSearch(
        predictions.length > 0
          ? { kind: 'results', predictions }
          : { kind: 'no_results' },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, center]);

  const pick = async (prediction: PlacePrediction) => {
    Haptics.selectionAsync().catch(() => undefined);
    setResolvingId(prediction.placeId);
    const resolved = await resolvePlace(prediction.placeId, sessionRef.current);
    sessionRef.current = newSessionToken();
    if (!resolved) {
      setResolvingId(null);
      return;
    }
    onPicked({
      name: prediction.primary || resolved.label,
      latitude: resolved.latitude,
      longitude: resolved.longitude,
      placeId: resolved.placeId ?? undefined,
      photoUrl: resolved.photoUrl ?? undefined,
      rating: resolved.rating ?? undefined,
      ratingCount: resolved.ratingCount ?? undefined,
      priceLevel: resolved.priceLevel ?? undefined,
      openingHours: resolved.openingHours ?? undefined,
    });
  };

  return (
    <>
      <View style={styles.mealSearchWrap}>
        <View
          style={[
            styles.mealSearchBar,
            { backgroundColor: t.colors.fill1, borderColor: t.colors.separator },
          ]}
        >
          <Ionicons name="search" size={16} color={t.colors.textTertiary} />
          <BottomSheetTextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search a restaurant, café, or address"
            placeholderTextColor={t.colors.textTertiary}
            autoFocus
            autoCorrect={false}
            returnKeyType="search"
            style={[styles.mealSearchInput, { color: t.colors.textPrimary }]}
          />
          {query.length > 0 ? (
            <Pressable
              onPress={() => setQuery('')}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Clear search"
            >
              <Ionicons name="close-circle" size={18} color={t.colors.textTertiary} />
            </Pressable>
          ) : null}
        </View>
      </View>
      <BottomSheetScrollView
        style={{ flex: 1 }}
        contentContainerStyle={styles.mealSearchResults}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {search.kind === 'searching' ? (
          <View style={styles.mealSearchState}>
            <ActivityIndicator color={t.colors.accent} />
          </View>
        ) : search.kind === 'no_results' ? (
          <View style={styles.mealSearchState}>
            <Text variant="bodySm" tone="tertiary" style={{ textAlign: 'center' }}>
              No matches. Try a different name.
            </Text>
          </View>
        ) : search.kind === 'results' ? (
          search.predictions.map((p) => (
            <Pressable
              key={p.placeId}
              onPress={() => pick(p)}
              style={[styles.resultRow, { borderBottomColor: t.colors.separator }]}
              accessibilityRole="button"
              accessibilityLabel={`Pick ${p.primary}`}
            >
              <Ionicons name="location-outline" size={18} color={t.colors.textTertiary} />
              <View style={{ flex: 1 }}>
                <Text variant="body" weight="semibold" numberOfLines={1}>
                  {p.primary}
                </Text>
                {p.secondary ? (
                  <Text variant="caption" tone="tertiary" numberOfLines={1}>
                    {p.secondary}
                  </Text>
                ) : null}
              </View>
              {resolvingId === p.placeId ? (
                <ActivityIndicator size="small" color={t.colors.accent} />
              ) : (
                <Ionicons name="chevron-forward" size={16} color={t.colors.textTertiary} />
              )}
            </Pressable>
          ))
        ) : (
          <View style={styles.mealSearchState}>
            <Ionicons name="restaurant-outline" size={26} color={t.colors.textTertiary} />
            <Text variant="bodySm" tone="tertiary" style={{ textAlign: 'center' }}>
              Search for the exact place you&apos;ll eat — a restaurant, café, or
              address.
            </Text>
          </View>
        )}
      </BottomSheetScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  stepInner: {
    flex: 1,
    paddingHorizontal: 16,
    paddingTop: 4,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 4,
  },
  iconBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  wheelWrap: {
    flex: 1,
    alignItems: 'stretch',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  wheelLabel: {
    fontSize: 44,
    lineHeight: 50,
    letterSpacing: -0.8,
  },
  wheelSublabel: {
    fontSize: 14,
    lineHeight: 18,
    marginTop: 2,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingVertical: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  rowOuter: {
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  rowTap: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingVertical: 14,
  },
  spinnerWrap: {
    alignItems: 'center',
    paddingBottom: 8,
  },
  spinner: {
    height: 180,
    width: 260,
  },
  lane: {
    overflow: 'hidden',
  },
  track: {
    flexDirection: 'row',
  },
  pane: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingVertical: 14,
    minHeight: 56,
  },
  rowLabel: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  addrLoading: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 2,
  },
  addrRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  searchField: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    minHeight: 44,
  },
  searchTextInput: {
    flex: 1,
    fontSize: 16,
    paddingVertical: 10,
  },
  results: {
    paddingBottom: 10,
  },
  resultStatus: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 10,
  },
  hitRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    paddingVertical: 12,
  },
  hitIcon: {
    width: 18,
    alignItems: 'center',
    marginTop: 1,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
  },
  timePill: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 999,
  },
  mealHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingTop: 14,
  },
  mealHeadMain: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  mealDimmed: {
    opacity: 0.45,
  },
  mealEditor: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingTop: 12,
    paddingBottom: 14,
  },
  mealTimePill: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 999,
  },
  segment: {
    flexDirection: 'row',
    gap: 8,
    paddingTop: 10,
    paddingBottom: 14,
  },
  segChip: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
    paddingVertical: 10,
    borderRadius: 12,
  },
  linkedCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 10,
    borderRadius: 14,
    marginTop: 10,
    marginBottom: 14,
  },
  linkedThumb: {
    width: 44,
    height: 44,
    borderRadius: 10,
  },
  linkedThumbFallback: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  linkedText: {
    flex: 1,
    gap: 1,
  },
  footer: {
    paddingTop: 6,
  },
  mealBlockHint: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 7,
    paddingHorizontal: 4,
    marginBottom: 10,
  },
  copyBtn: {
    marginBottom: 10,
  },
  summary: {
    textAlign: 'center',
    marginBottom: 10,
  },
  mealOutWrap: {
    gap: 10,
    marginBottom: 4,
  },
  findRow: {
    flexDirection: 'row',
    gap: 8,
  },
  findBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 9,
    borderRadius: 10,
    borderWidth: 1,
  },
  pickerWrap: {
    flex: 1,
  },
  pickerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 4,
    marginBottom: 14,
  },
  methodToggle: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
    marginBottom: 6,
  },
  methodChip: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 9,
    borderRadius: 10,
  },
  mealSearchWrap: {
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 10,
  },
  mealSearchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 44,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
  },
  mealSearchInput: {
    flex: 1,
    fontSize: 16,
    paddingVertical: 10,
  },
  mealSearchResults: {
    paddingHorizontal: 16,
    paddingBottom: 24,
  },
  mealSearchState: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingTop: 56,
    paddingHorizontal: 24,
  },
  resultRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
});
