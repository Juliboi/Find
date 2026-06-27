import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  Image,
  Keyboard,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useFocusEffect, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import * as Haptics from 'expo-haptics';
import * as Notifications from 'expo-notifications';
import {
  useSavedItineraries,
  plansForDate,
  activePlanForDate,
  type SavedItinerary,
} from '@/store/useSavedItineraries';
import {
  usePlanSetupStore,
  type DayPlanSelection,
} from '@/store/usePlanSetupStore';
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
  skipRecurringOccurrence,
} from '@/lib/recurring';
import { useProfileStore } from '@/store/useProfileStore';
import { useHomeStore } from '@/store/useHomeStore';
import { useWeatherStore } from '@/store/useWeatherStore';
import { usePlanJobsStore } from '@/store/usePlanJobsStore';
import { useTheme } from '@/theme/useTheme';
import { Text } from '@/components/Text';
import { GlassSurface } from '@/components/Glass';
import { GradientWave } from '@/components/GradientWave';
import { ChatComposerBar } from '@/components/ChatComposerBar';
import { CalendarStrip } from '@/components/CalendarStrip';
import { DayScheduleCard } from '@/components/DayScheduleCard';
import { DayBalanceCard } from '@/components/DayBalanceCard';
import { PlanBuildingCard } from '@/components/PlanBuildingCard';
import { PlanSetupSheet } from '@/components/PlanSetupSheet';
import { ErrandDrawer } from '@/components/ErrandDrawer';
import { ErrandRow } from '@/components/ErrandRow';
import { WeatherCard } from '@/components/WeatherCard';
import { PlanPeek } from '@/components/PlanPeek';
import { parseErrandRemote, type ErrandDraft } from '@/lib/ai/parseErrand';
import { type DiscoveryIntent } from '@/lib/discover';
import { isDailyReviewResponse } from '@/lib/notifications';
import { todayISO, tomorrowISO, currentHHMM, minutesOfDay } from '@/utils/time';
import { scoreDay, errandLoadMin } from '@/lib/planning/mindfulness';
import { usableDayWindow } from '@/lib/planning/dayWindow';
import { minToHHMM } from '@/lib/planning/conflicts';
import { describeDay, dateFromISO } from '@/utils/days';
import {
  DAYTIME_PALETTES,
  getDayPart,
  getDayPartLabel,
  getGreeting,
} from '@/utils/daytime';

// Text that sits on top of the saturated part of the gradient — kept light in
// both themes since the colour field underneath is vivid regardless of mode.
const ON = '#FFFFFF';
const ON_SOFT = 'rgba(255, 255, 255, 0.82)';
const ON_DIM = 'rgba(255, 255, 255, 0.64)';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
// Focusing the errand composer dims the page behind it to near-black so the
// field reads as a spotlit, focused compose surface. We darken toward the app's
// black canvas (rather than the active theme bg) so it reads as "almost black"
// in both light and dark mode, stopping just shy of full opacity so a whisper of
// the page survives underneath.
const DIM_COLOR = '#0B0B0F';
const DIM_OPACITY = 1;
const DIM_TIMING = { duration: 260, easing: Easing.out(Easing.cubic) } as const;

// The "Anytime" group shows at most this many rows before a "Show all" expander.
const ANYTIME_CAP = 5;

const EMPTY_DRAFT: ErrandDraft = {
  title: '',
  date: null,
  startTime: null,
  endTime: null,
  address: null,
  notes: null,
};

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

function formatLongDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}

function tripSubtitle(trip: SavedItinerary): string {
  const parts: string[] = [];
  if (trip.stopCount > 0) {
    parts.push(`${trip.stopCount} stop${trip.stopCount === 1 ? '' : 's'}`);
  }
  const place = trip.city ?? trip.origin;
  if (place) parts.push(place.split(',')[0]);
  return parts.join(' · ');
}

export default function HomeScreen() {
  const router = useRouter();
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();

  // A slow "now" tick (once a minute) keeps every time-derived part of the home
  // screen live while the app stays open: the date rolls over at midnight, and
  // the greeting + gradient flow from one part of the day into the next.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60 * 1000);
    return () => clearInterval(id);
  }, []);

  // Keep the weather widget fresh "as you use the app". Each call is cheap: the
  // store is stale-while-revalidate (20-min TTL) and resolves location without
  // prompting, so it no-ops until the cache actually expires. We re-check on the
  // minute tick (covers leaving the app open), when the screen regains focus,
  // and when the app returns to the foreground (JS timers are throttled while
  // backgrounded, so the tick alone can't be trusted after a resume).
  const refreshWeather = useCallback(() => {
    void useWeatherStore.getState().refresh();
  }, []);
  useEffect(() => {
    refreshWeather();
  }, [now, refreshWeather]);
  useFocusEffect(refreshWeather);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') refreshWeather();
    });
    return () => sub.remove();
  }, [refreshWeather]);

  const dayPart = getDayPart(now);
  const palette = DAYTIME_PALETTES[dayPart];
  const greeting = getGreeting(dayPart);
  const label = getDayPartLabel(dayPart);

  const fullName = useProfileStore((s) => s.fullName);
  const firstName = fullName?.trim().split(/\s+/)[0] ?? '';
  const homeHeading = firstName ? `Hey, ${firstName}` : 'Hey there';

  // Sleep window — the "fit it into your day" bounds the mindfulness score uses.
  const wakeTime = useProfileStore((s) => s.wakeTime);
  const bedTime = useProfileStore((s) => s.bedTime);
  const windDownTime = useProfileStore((s) => s.windDownTime);
  const wakeUpDurationMin = useProfileStore((s) => s.wakeUpDurationMin);

  // The home screen is day-scoped: a calendar strip under the header moves
  // `focusDate` between days and everything date-derived below it (the plan
  // card, the date line, the errand sections, the weather) follows along. It
  // defaults to — and the strip starts at — today.
  const today = todayISO();
  const [focusDate, setFocusDate] = useState(today);
  const isToday = focusDate === today;
  const focusDay = useMemo(() => describeDay(focusDate), [focusDate]);

  const savedTrips = useSavedItineraries((s) => s.items);
  // The focused day's plans: its active plan (the one the user pinned, else the
  // most recent that day) is the card; any others are reachable via the "other
  // plans" link below it.
  const dayPlans = useMemo(
    () => plansForDate(savedTrips, focusDate),
    [savedTrips, focusDate],
  );
  const activePlan = useMemo(
    () => activePlanForDate(savedTrips, focusDate),
    [savedTrips, focusDate],
  );
  const otherPlansCount = Math.max(0, dayPlans.length - 1);

  // A plan still building in the background for the focused day takes over the
  // card with a live skeleton until it lands (see the card branch below).
  const buildingJob = usePlanJobsStore((s) =>
    s.jobs.find((j) => j.status === 'building' && j.date === focusDate),
  );

  // ----- Errands -----
  const errands = useErrandsStore((s) => s.items);
  const addErrand = useErrandsStore((s) => s.add);
  const updateErrand = useErrandsStore((s) => s.update);
  const toggleErrandDone = useErrandsStore((s) => s.toggleDone);
  const reopenErrand = useErrandsStore((s) => s.reopen);
  const removeErrand = useErrandsStore((s) => s.remove);

  // DEV: export the OPEN, dated errands — exactly what the home "Scheduled" list
  // shows — as JSON for AI Studio. Sourced from `groupErrands().scheduled`, so it
  // deliberately EXCLUDES completed/planned leftovers (e.g. a "skincare"
  // freestyle errand left over + marked Planned by an earlier plan) and DOES
  // include later days like tomorrow's clinic — the mismatch the raw "everything
  // dated today" version caused. Shares via the OS sheet (its "Copy" hits the
  // clipboard) and always logs to Metro as a fallback — no native module/rebuild.
  const copyScheduledErrands = useCallback(async () => {
    const scheduled = groupErrands(errands, { focusDate, today }).scheduled;
    const payload = scheduled.map((e) => ({
      title: e.title,
      startTime: e.startTime ?? null,
      endTime: e.endTime ?? null,
      durationMin: e.durationMin ?? null,
      date: e.date ?? null,
      address: e.address ?? null,
      latitude: e.latitude ?? null,
      longitude: e.longitude ?? null,
      placeId: e.placeId ?? null,
      rating: e.rating ?? null,
      ratingCount: e.ratingCount ?? null,
      notes: e.notes ?? null,
      source: e.source ?? 'user',
    }));
    if (payload.length === 0) {
      Alert.alert('No errands', 'No scheduled errands to copy yet.');
      return;
    }
    const json = JSON.stringify(payload, null, 2);
    // Always log it: the Metro console is the guaranteed grab-point even if the
    // share sheet is dismissed.
    console.log(`[errands-copy] ${payload.length} scheduled errand(s)\n${json}`);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(
      () => undefined,
    );
    try {
      await Share.share({ message: json });
    } catch {
      // dismissed / unavailable — the console log above is the fallback.
    }
  }, [errands, focusDate, today]);

  // Recurring templates → today's editable occurrences. Materialize whenever the
  // day rolls over or a template changes (add/edit/skip in Settings), then read
  // the still-open occurrences back out of the errands store. Idempotent, so a
  // re-run never duplicates or clobbers an edited/done occurrence.
  const recurringTemplates = useRecurringErrandsStore((s) => s.items);
  useEffect(() => {
    // Always keep today materialized (so it's instant to jump back to), plus
    // the focused day when it's somewhere else.
    materializeRecurringForDate(today);
    if (focusDate !== today) materializeRecurringForDate(focusDate);
  }, [today, focusDate, recurringTemplates]);
  const recurringDay = useMemo(
    () => recurringInstancesForDate(errands, focusDate),
    [errands, focusDate],
  );
  const recurringDayIds = useMemo(
    () => new Set(recurringDay.map((e) => e.id)),
    [recurringDay],
  );

  // The focused day's list: a "Repeats" section (the recurring occurrences)
  // leads, then that day's dated errands in "Scheduled". Recurring occurrences
  // are rendered in their own section, so exclude them from the normal groups.
  const errandGroups = useMemo(
    () =>
      groupErrands(
        errands.filter((e) => !recurringDayIds.has(e.id)),
        { focusDate, today },
      ),
    [errands, recurringDayIds, focusDate, today],
  );
  // The focused day's dated, still-open errands. On today we also pull in
  // anything overdue (dated earlier but never closed) so it keeps nagging here
  // rather than hiding on a past day the strip can't reach; other days show
  // only what's dated to them.
  const scheduledForDay = useMemo(
    () =>
      errandGroups.scheduled.filter((e) =>
        isToday ? (e.date ?? '') <= today : e.date === focusDate,
      ),
    [errandGroups.scheduled, isToday, today, focusDate],
  );
  // Stretch the calendar strip just far enough to always reach the most distant
  // dated thing the user has (an open errand or a saved plan), so a far-future
  // item is never orphaned past the strip's end. Two weeks minimum, capped so a
  // date set far out can't balloon it.
  const stripDays = useMemo(() => {
    let furthest = today;
    for (const e of errands) {
      if (e.date && errandStatus(e, today) === 'open' && e.date > furthest) {
        furthest = e.date;
      }
    }
    for (const p of savedTrips) {
      if (p.date && p.date > furthest) furthest = p.date;
    }
    const diffDays = Math.round(
      (dateFromISO(furthest).getTime() - dateFromISO(today).getTime()) / 86_400_000,
    );
    return Math.min(90, Math.max(14, diffDays + 1));
  }, [errands, savedTrips, today]);

  // "Anytime" (undated) and "Completed" are day-agnostic housekeeping — they
  // belong to the home base (today), not to a specific browsed day.
  const showAnytime = errandGroups.anytime.length > 0;
  const showCompleted = errandGroups.completed.length > 0;
  const hasDayContent =
    recurringDay.length > 0 ||
    scheduledForDay.length > 0 ||
    showAnytime ||
    showCompleted;

  const [showAllAnytime, setShowAllAnytime] = useState(false);
  const [showCompletedSection, setShowCompletedSection] = useState(false);

  // Drives the full-screen scrim that fades in while the errand composer holds
  // focus. Kept on the UI thread via reanimated so the dim tracks the keyboard's
  // rise frame-for-frame.
  const [composerFocused, setComposerFocused] = useState(false);
  const dim = useSharedValue(0);
  useEffect(() => {
    dim.value = withTiming(composerFocused ? 1 : 0, DIM_TIMING);
  }, [composerFocused, dim]);
  const dimStyle = useAnimatedStyle(() => ({
    opacity: dim.value * DIM_OPACITY,
  }));

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerParsing, setDrawerParsing] = useState(false);
  const [drawerMode, setDrawerMode] = useState<'create' | 'edit'>('create');
  const [drawerSeed, setDrawerSeed] = useState<ErrandDraft>(EMPTY_DRAFT);
  const [drawerRawText, setDrawerRawText] = useState('');
  const [drawerSeedKey, setDrawerSeedKey] = useState('seed-0');
  const [drawerInitialStep, setDrawerInitialStep] = useState<'form' | 'discover'>('form');
  const [drawerDiscovery, setDrawerDiscovery] = useState<DiscoveryIntent | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  // Monotonic token so a slow parse that resolves after the user has moved on
  // (started another errand, opened one to edit) is ignored.
  const parseSeq = useRef(0);

  // Home anchors discovery searches that aren't "nearby" and have no named area
  // ("find a pharmacy"). Kept as stable primitives so the drawer's fetch effect
  // doesn't refire on unrelated re-renders.
  const home = useHomeStore((s) => s.home);
  const fallbackCenter = useMemo(
    () => (home ? { latitude: home.latitude, longitude: home.longitude } : null),
    [home],
  );

  // ----- Mindfulness / day balance -----
  // How well the focused day "breathes": its open errands' hours + estimated
  // travel (round-tripping from home) measured against the usable window — wake
  // plus the morning ramp through wind-down (now → wind-down on today, so the
  // past isn't counted as free). We drop errands that already finished today so
  // "leftover time" reflects what's actually still ahead. The plan drawer
  // recomputes the very same score from just the ticked errands, so the user can
  // untick to see a calmer day.
  const dayWindow = useMemo(() => {
    const nowMin = isToday ? minutesOfDay(currentHHMM()) : null;
    const { startMin, endMin } = usableDayWindow(
      { wakeTime, bedTime, windDownTime, wakeUpDurationMin },
      { nowMin },
    );
    return { start: minToHHMM(startMin), end: minToHHMM(endMin) };
    // `now` ticks each minute, sliding today's window start forward.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wakeTime, bedTime, windDownTime, wakeUpDurationMin, isToday, now]);

  const dayBalanceErrands = useMemo(() => {
    const open = errands.filter(
      (e) => e.date === focusDate && errandStatus(e, today) === 'open',
    );
    if (!isToday) return open;
    // Today: anything already wrapped up is behind us — only score what's left.
    const nowMin = minutesOfDay(currentHHMM()) ?? 0;
    return open.filter((e) => {
      const startMin = minutesOfDay(e.startTime);
      if (startMin == null) return true;
      return startMin + errandLoadMin(e) > nowMin;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [errands, focusDate, today, isToday, now]);

  const dayScore = useMemo(
    () =>
      scoreDay({
        startTime: dayWindow.start,
        endTime: dayWindow.end,
        errands: dayBalanceErrands,
        startAnchor: fallbackCenter,
        endAnchor: fallbackCenter,
      }),
    [dayWindow, dayBalanceErrands, fallbackCenter],
  );

  const onComposerSubmit = (text: string) => {
    const seq = (parseSeq.current += 1);
    // When viewing a day other than today, a bare errand (one the parser didn't
    // date itself) defaults to the day you're looking at — so it lands on, and
    // stays visible under, the focused day instead of dropping into "Anytime".
    const withDayDefault = (draft: ErrandDraft): ErrandDraft =>
      !isToday && !draft.date ? { ...draft, date: focusDate } : draft;
    setDrawerMode('create');
    setEditId(null);
    setDrawerRawText(text);
    // Open immediately in the reading state; the orchestrator (one cheap call)
    // both classifies the intent and fills the slots, then we route. A place
    // search ("find a pharmacy near Karlín", or a 12:00 coffee whose café isn't
    // chosen yet) lands on the discover step; everything else on the form. The
    // field stays a single line — no area field, no "near me" toggle.
    setDrawerDiscovery(null);
    setDrawerInitialStep('form');
    setDrawerSeed(withDayDefault({ ...EMPTY_DRAFT, title: text }));
    setDrawerParsing(true);
    setDrawerSeedKey(`parse-${seq}`);
    setDrawerOpen(true);
    Haptics.selectionAsync().catch(() => undefined);
    // The parser still resolves relative dates ("tomorrow", "friday") against
    // the real today, so those words keep meaning what they say.
    parseErrandRemote(text, { date: todayISO() })
      .then((res) => {
        if (seq !== parseSeq.current) return;
        if (res.intent === 'discover' && res.discovery) {
          setDrawerDiscovery(res.discovery);
          setDrawerSeed(withDayDefault(res.draft));
          setDrawerInitialStep('discover');
          setDrawerParsing(false);
          setDrawerSeedKey(`discover-${seq}`);
        } else {
          setDrawerSeed(withDayDefault(res.draft));
          setDrawerInitialStep('form');
          setDrawerParsing(false);
          setDrawerSeedKey(`create-${seq}-done`);
        }
      })
      .catch(() => {
        if (seq !== parseSeq.current) return;
        setDrawerSeed(withDayDefault({ ...EMPTY_DRAFT, title: text }));
        setDrawerParsing(false);
        setDrawerSeedKey(`create-${seq}-done`);
      });
  };

  const onEditErrand = (errand: Errand) => {
    parseSeq.current += 1; // invalidate any in-flight create parse
    setDrawerMode('edit');
    setEditId(errand.id);
    setDrawerRawText(errand.rawText);
    setDrawerSeed(errandToDraft(errand));
    setDrawerDiscovery(null);
    setDrawerInitialStep('form');
    setDrawerParsing(false);
    setDrawerSeedKey(`edit-${errand.id}-${errand.updatedAt}`);
    setDrawerOpen(true);
  };

  const onSaveErrand = (input: ErrandInput) => {
    if (drawerMode === 'edit' && editId) {
      updateErrand(editId, input);
    } else {
      addErrand(input);
    }
    setDrawerOpen(false);
  };

  const onDeleteErrand = () => {
    if (editId) {
      // Deleting a recurring occurrence means "skip this one" — record it on the
      // template so the generator doesn't just recreate it on the next pass.
      const e = errands.find((x) => x.id === editId);
      if (e?.recurringId && e.date) skipRecurringOccurrence(e.recurringId, e.date);
      else removeErrand(editId);
    }
    setDrawerOpen(false);
  };

  // Recurring occurrence "..." menu: edit this one (tap the row), skip just this
  // week, or jump to Settings to edit the whole series.
  const openRecurringOptions = (errand: Errand) => {
    if (!errand.recurringId || !errand.date) return;
    Haptics.selectionAsync().catch(() => undefined);
    Alert.alert(errand.title, 'This repeats on a schedule.', [
      {
        text: 'Skip this week',
        onPress: () => skipRecurringOccurrence(errand.recurringId!, errand.date!),
      },
      {
        text: 'Edit series',
        onPress: () =>
          router.push({
            pathname: '/recurring-errands',
            params: { edit: errand.recurringId },
          }),
      },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  const gradientHeight = Math.round(height * 0.8);

  const [setupOpen, setSetupOpen] = useState(false);
  // When the planner is opened from the daily reminder we seed it to tomorrow;
  // every other entry point (the card, the "+" composer) leaves this undefined
  // so the sheet defaults to today.
  const [setupInitialDate, setSetupInitialDate] = useState<string | undefined>(
    undefined,
  );
  const setDayPlan = usePlanSetupStore((s) => s.setDayPlan);
  const openSetup = () => {
    // Plan the day you're looking at: seed the planner to the focused day
    // (today stays undefined so the sheet keeps its own "default to today").
    setSetupInitialDate(isToday ? undefined : focusDate);
    setSetupOpen(true);
  };
  const closeSetup = () => {
    setSetupOpen(false);
    setSetupInitialDate(undefined);
  };
  const onSetupConfirm = (selection: DayPlanSelection) => {
    setDayPlan(selection);
    closeSetup();
    router.push('/itinerary');
  };

  // A tap on the evening "plan tomorrow" reminder routes here: open the planner
  // seeded to tomorrow, then clear the response so it doesn't reopen on the next
  // render. The hook surfaces the launching tap too, so this also covers a cold
  // start from the notification.
  const lastNotificationResponse = Notifications.useLastNotificationResponse();
  useEffect(() => {
    if (!isDailyReviewResponse(lastNotificationResponse)) return;
    setSetupInitialDate(tomorrowISO());
    setSetupOpen(true);
    void Notifications.clearLastNotificationResponseAsync();
  }, [lastNotificationResponse]);

  // Build the single adaptive card: building → planning → up-next → recent
  // trip → prompt.
  let cardOnPress: (() => void) | undefined;
  let cardA11y: string | undefined;
  let cardBody: React.ReactNode;
  // An optional "where am I now / next up" peek rendered under the card's
  // headline — only for the live saved plan, which carries timed blocks +
  // commutes the peek can read.
  let cardPeek: React.ReactNode = null;
  // When set, replaces the standard row+peek with a bespoke card body (the
  // background-build skeleton).
  let cardFullBody: React.ReactNode = null;

  if (buildingJob) {
    cardOnPress = () => {
      Haptics.selectionAsync().catch(() => undefined);
      router.push({ pathname: '/itinerary', params: { jobId: buildingJob.id } });
    };
    cardA11y = 'Building your plan — tap to watch it come together';
    cardFullBody = <PlanBuildingCard job={buildingJob} />;
  } else if (activePlan) {
    cardOnPress = () => {
      Haptics.selectionAsync().catch(() => undefined);
      router.push({ pathname: '/itinerary', params: { id: activePlan.id } });
    };
    cardA11y = `Open ${activePlan.title}`;
    cardPeek = <PlanPeek itinerary={activePlan.itinerary} />;
    cardBody = (
      <>
        <View style={[styles.thumb, { backgroundColor: t.colors.fill1 }]}>
          {activePlan.thumbUrl ? (
            <Image source={{ uri: activePlan.thumbUrl }} style={styles.thumbImg} />
          ) : (
            <Ionicons
              name="map-outline"
              size={20}
              color={t.colors.textSecondary}
            />
          )}
        </View>
        <View style={styles.cardText}>
          <Text variant="micro" uppercase weight="bold" tone="accent">
            {`${focusDay.title}\u2019s plan`}
          </Text>
          <Text variant="body" weight="semibold" numberOfLines={1}>
            {activePlan.title}
          </Text>
          <Text variant="caption" tone="secondary" numberOfLines={1}>
            {tripSubtitle(activePlan)}
          </Text>
        </View>
        <Ionicons
          name="chevron-forward"
          size={18}
          color={t.colors.textTertiary}
        />
      </>
    );
  } else {
    cardOnPress = () => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(
        () => undefined,
      );
      openSetup();
    };
    cardA11y = 'Plan your day';
    cardBody = (
      <>
        <View style={[styles.iconCircle, { backgroundColor: t.colors.accentSoft }]}>
          <Ionicons name="sparkles" size={20} color={t.colors.accentText} />
        </View>
        <View style={styles.cardText}>
          <Text variant="micro" uppercase weight="bold" tone="accent">
            Start
          </Text>
          <Text variant="body" weight="semibold">
            Plan your day
          </Text>
          <Text variant="caption" tone="secondary" numberOfLines={2}>
            Tell me what&apos;s on and I&apos;ll build your schedule.
          </Text>
        </View>
        <Ionicons name="add" size={20} color={t.colors.textTertiary} />
      </>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: t.colors.background }]}>
      <StatusBar style="light" />
      <GradientWave height={gradientHeight} palette={palette} />

      <View style={styles.safe}>
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={[
            styles.content,
            {
              paddingHorizontal: t.spacing.lg,
              paddingTop: insets.top,
              paddingBottom: insets.bottom + 110,
            },
          ]}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.header}>
            {/* <Image source={require('../assets/diem-logo.png')} style={{ width: 32, height: 32, borderRadius: 6 }} /> */}
            <Text variant="title1" weight="bold" tight style={{ color: ON }}>
              {homeHeading}
            </Text>
            <View style={styles.headerActions}>
              {__DEV__ ? (
                <Pressable
                  onPress={copyScheduledErrands}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel="Copy scheduled errands"
                  style={({ pressed }) => [styles.gear, pressed && { opacity: 0.6 }]}
                >
                  <Ionicons name="copy-outline" size={18} color={ON} />
                </Pressable>
              ) : null}
              <Pressable
                onPress={() => {
                  Haptics.selectionAsync().catch(() => undefined);
                  router.push('/settings');
                }}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Settings"
                style={({ pressed }) => [styles.gear, pressed && { opacity: 0.6 }]}
              >
                <Ionicons name="settings-outline" size={19} color={ON} />
              </Pressable>
            </View>
          </View>

          <CalendarStrip
            selectedDate={focusDate}
            onSelectDate={setFocusDate}
            today={today}
            days={stripDays}
            edgePadding={t.spacing.lg}
            style={styles.calendar}
          />

          <View style={styles.hero}>
            <Text
              variant="caption"
              uppercase
              weight="bold"
              style={{ color: ON_DIM, letterSpacing: 1.4 }}
            >
              {label}
            </Text>
            <Text
              variant="title1"
              weight="semibold"
              tight
              style={[styles.greeting, { color: ON }]}
            >
              {greeting}
            </Text>
            <View style={styles.dateRow}>
              <Text variant="body" style={{ color: ON_SOFT }}>
                {focusDay.isToday || focusDay.isTomorrow
                  ? `${focusDay.title} \u00B7 ${formatLongDate(focusDate)}`
                  : formatLongDate(focusDate)}
              </Text>
              {!isToday ? (
                <Pressable
                  onPress={() => {
                    Haptics.selectionAsync().catch(() => undefined);
                    setFocusDate(today);
                  }}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel="Jump to today"
                  style={({ pressed }) => [
                    styles.todayPill,
                    pressed && { opacity: 0.6 },
                  ]}
                >
                  <Ionicons name="chevron-back" size={12} color={ON} />
                  <Text variant="micro" weight="bold" style={{ color: ON }}>
                    Today
                  </Text>
                </Pressable>
              ) : null}
            </View>
          </View>

          <Pressable
            onPress={cardOnPress}
            accessibilityRole="button"
            accessibilityLabel={cardA11y}
            style={({ pressed }) =>
              pressed
                ? { opacity: 0.9, transform: [{ scale: 0.99 }] }
                : undefined
            }
          >
            <GlassSurface
              variant="regular"
              radius={t.radii.xl}
              style={[styles.card, { shadowColor: t.colors.shadow }]}
              innerStyle={styles.cardInner}
            >
              {cardFullBody ?? (
                <>
                  <View style={styles.cardRow}>{cardBody}</View>
                  {cardPeek}
                </>
              )}
            </GlassSurface>
          </Pressable>

          {otherPlansCount > 0 ? (
            <Pressable
              onPress={() => {
                Haptics.selectionAsync().catch(() => undefined);
                router.push({ pathname: '/day-plans', params: { date: focusDate } });
              }}
              accessibilityRole="button"
              accessibilityLabel={`View all ${dayPlans.length} plans for ${focusDay.title}`}
              style={({ pressed }) => [
                styles.otherPlans,
                pressed && { opacity: 0.6 },
              ]}
            >
              <Text variant="caption" weight="semibold" style={{ color: ON_SOFT }}>
                {otherPlansCount} other plan{otherPlansCount === 1 ? '' : 's'}
              </Text>
              <View style={styles.otherPlansCta}>
                <Text variant="caption" weight="semibold" style={{ color: ON }}>
                  View all
                </Text>
                <Ionicons name="chevron-forward" size={13} color={ON} />
              </View>
            </Pressable>
          ) : null}

          <DayScheduleCard
            date={focusDate}
            today={today}
            onPress={() => {
              Haptics.selectionAsync().catch(() => undefined);
              router.push({ pathname: '/day-calendar', params: { date: focusDate } });
            }}
            style={styles.schedule}
          />

          {dayBalanceErrands.length > 0 ? (
            <DayBalanceCard score={dayScore} style={styles.balance} />
          ) : null}

          {isToday ? <WeatherCard style={styles.weather} /> : null}

          {/* Errands / reminders — scoped to the focused day */}
          {hasDayContent ? (
            <View style={styles.errands}>
              {recurringDay.length > 0 ? (
                <ErrandSection
                  title={isToday ? 'Repeats today' : 'Repeats'}
                  count={recurringDay.length}
                >
                  {recurringDay.map((errand, i) => (
                    <ErrandRow
                      key={errand.id}
                      errand={errand}
                      repeats
                      onPress={() => onEditErrand(errand)}
                      onToggleDone={() => toggleErrandDone(errand.id)}
                      onOptions={() => openRecurringOptions(errand)}
                      showSeparator={i < recurringDay.length - 1}
                    />
                  ))}
                </ErrandSection>
              ) : null}

              {scheduledForDay.length > 0 ? (
                <ErrandSection title="Scheduled" count={scheduledForDay.length}>
                  {scheduledForDay.map((errand, i) => (
                    <ErrandRow
                      key={errand.id}
                      errand={errand}
                      onPress={() => onEditErrand(errand)}
                      onToggleDone={() => toggleErrandDone(errand.id)}
                      showSeparator={i < scheduledForDay.length - 1}
                    />
                  ))}
                </ErrandSection>
              ) : null}

              {showAnytime ? (
                <ErrandSection title="Anytime" count={errandGroups.anytime.length}>
                  {(showAllAnytime
                    ? errandGroups.anytime
                    : errandGroups.anytime.slice(0, ANYTIME_CAP)
                  ).map((errand, i, arr) => (
                    <ErrandRow
                      key={errand.id}
                      errand={errand}
                      onPress={() => onEditErrand(errand)}
                      onToggleDone={() => toggleErrandDone(errand.id)}
                      showSeparator={
                        i < arr.length - 1 ||
                        errandGroups.anytime.length > ANYTIME_CAP
                      }
                    />
                  ))}
                  {errandGroups.anytime.length > ANYTIME_CAP ? (
                    <Pressable
                      onPress={() => {
                        Haptics.selectionAsync().catch(() => undefined);
                        setShowAllAnytime((v) => !v);
                      }}
                      style={({ pressed }) => [
                        styles.errandsShowMore,
                        pressed && { opacity: 0.6 },
                      ]}
                    >
                      <Text variant="caption" weight="semibold" tone="accent">
                        {showAllAnytime
                          ? 'Show less'
                          : `Show all ${errandGroups.anytime.length}`}
                      </Text>
                    </Pressable>
                  ) : null}
                </ErrandSection>
              ) : null}

              {showCompleted ? (
                <ErrandSection
                  title="Completed"
                  count={errandGroups.completed.length}
                  collapsible
                  collapsed={!showCompletedSection}
                  onToggle={() => {
                    Haptics.selectionAsync().catch(() => undefined);
                    setShowCompletedSection((v) => !v);
                  }}
                >
                  {errandGroups.completed.map((errand, i) => (
                    <ErrandRow
                      key={errand.id}
                      errand={errand}
                      onToggleDone={() => toggleErrandDone(errand.id)}
                      onReopen={() => reopenErrand(errand.id)}
                      onDelete={() => removeErrand(errand.id)}
                      status={errandStatus(errand, today)}
                      showSeparator={i < errandGroups.completed.length - 1}
                    />
                  ))}
                </ErrandSection>
              ) : null}
            </View>
          ) : (
            <View style={styles.errandsHint}>
              <Ionicons
                name={isToday ? 'checkmark-circle-outline' : 'calendar-clear-outline'}
                size={18}
                color={t.colors.textTertiary}
              />
              <Text variant="caption" tone="tertiary" style={styles.errandsHintText}>
                {isToday
                  ? 'Add a quick smart reminder below — like “call mom” or “dentist at 18:00”.'
                  : `Nothing planned for ${
                      focusDay.isTomorrow ? 'tomorrow' : focusDay.weekdayLong
                    } yet — add a reminder below, or tap + to plan the day.`}
              </Text>
            </View>
          )}
        </ScrollView>
      </View>

      <AnimatedPressable
        pointerEvents={composerFocused ? 'auto' : 'none'}
        onPress={() => Keyboard.dismiss()}
        accessibilityElementsHidden={!composerFocused}
        importantForAccessibility={
          composerFocused ? 'auto' : 'no-hide-descendants'
        }
        style={[styles.dim, { backgroundColor: DIM_COLOR }, dimStyle]}
      />

      <ChatComposerBar
        onPlus={openSetup}
        onSubmit={onComposerSubmit}
        onFocusChange={setComposerFocused}
        placeholder="Add a plan or find a place…"
      />

      <PlanSetupSheet
        open={setupOpen}
        initialDate={setupInitialDate}
        onClose={closeSetup}
        onConfirm={onSetupConfirm}
      />

      <ErrandDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        draft={drawerSeed}
        rawText={drawerRawText}
        parsing={drawerParsing}
        seedKey={drawerSeedKey}
        mode={drawerMode}
        currentErrandId={editId}
        initialStep={drawerInitialStep}
        discovery={drawerDiscovery}
        fallbackCenter={fallbackCenter}
        onSave={onSaveErrand}
        onDelete={drawerMode === 'edit' ? onDeleteErrand : undefined}
      />
    </View>
  );
}

/**
 * A titled errands group on the home list: a small caption header (with count)
 * over a borderless card of rows. The "Completed" group passes `collapsible` so
 * its header toggles the card open/closed and keeps finished errands tucked away.
 */
function ErrandSection({
  title,
  count,
  collapsible = false,
  collapsed = false,
  onToggle,
  children,
}: {
  title: string;
  count: number;
  collapsible?: boolean;
  collapsed?: boolean;
  onToggle?: () => void;
  children: React.ReactNode;
}) {
  const t = useTheme();
  return (
    <View style={styles.errandSection}>
      <Pressable
        disabled={!collapsible}
        onPress={onToggle}
        accessibilityRole={collapsible ? 'button' : undefined}
        style={styles.errandsHead}
      >
        <Text
          variant="micro"
          uppercase
          weight="bold"
          tone="secondary"
          style={{ letterSpacing: 1.2 }}
        >
          {title}
          {count > 0 ? ` · ${count}` : ''}
        </Text>
        {collapsible ? (
          <Ionicons
            name={collapsed ? 'chevron-down' : 'chevron-up'}
            size={16}
            color={t.colors.textTertiary}
          />
        ) : null}
      </Pressable>
      {!collapsed ? (
        <GlassSurface
          variant="regular"
          radius={t.radii.xl}
          style={[styles.errandsCard, { shadowColor: t.colors.shadow }]}
          innerStyle={styles.errandsCardInner}
        >
          {children}
        </GlassSurface>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  safe: { flex: 1 },
  // Full-screen scrim that fades the home content toward near-black while the
  // errand composer is focused. Sits above the page but below the composer bar
  // (which is rendered after it), so the field stays lit while everything else
  // recedes. A tap anywhere on it dismisses the keyboard.
  dim: {
    ...StyleSheet.absoluteFillObject,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 6,
    paddingBottom: 6,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  gear: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.14)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 255, 255, 0.24)',
  },
  scroll: {
    flex: 1,
  },
  content: {
    flexGrow: 1,
  },
  calendar: {
    marginTop: 14,
  },
  hero: {
    marginTop: 24,
    gap: 8,
  },
  greeting: {
    fontSize: 38,
    lineHeight: 44,
  },
  dateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  todayPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingLeft: 8,
    paddingRight: 10,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: 'rgba(255, 255, 255, 0.16)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 255, 255, 0.26)',
  },
  card: {
    marginTop: 28,
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.18,
    shadowRadius: 22,
    elevation: 8,
  },
  cardInner: {
    padding: 16,
  },
  cardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  cardText: {
    flex: 1,
    gap: 2,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    alignSelf: 'flex-start',
    marginTop: 6,
  },
  morePill: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
  },
  otherPlans: {
    marginTop: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 6,
  },
  otherPlansCta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  schedule: {
    marginTop: 28,
  },
  balance: {
    marginTop: 16,
  },
  weather: {
    marginTop: 28,
  },
  thumb: {
    width: 46,
    height: 46,
    borderRadius: 12,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbImg: {
    width: '100%',
    height: '100%',
  },
  iconCircle: {
    width: 46,
    height: 46,
    borderRadius: 23,
    alignItems: 'center',
    justifyContent: 'center',
  },
  errands: {
    marginTop: 28,
    gap: 18,
  },
  errandSection: {
    gap: 10,
  },
  errandsHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 4,
  },
  // Match the plan / weather card chrome so the errand groups read as the same
  // family of liquid-glass surfaces.
  errandsCard: {
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.18,
    shadowRadius: 22,
    elevation: 8,
  },
  errandsCardInner: {
    paddingHorizontal: 2,
  },
  errandsShowMore: {
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  errandsHint: {
    marginTop: 24,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 12,
  },
  errandsHintText: {
    flexShrink: 1,
  },
});
