import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Image,
  Keyboard,
  Pressable,
  ScrollView,
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
import { useDayStore } from '@/store/useDayStore';
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
import { useProfileStore } from '@/store/useProfileStore';
import { useHomeStore } from '@/store/useHomeStore';
import { useWeatherStore } from '@/store/useWeatherStore';
import { usePlanJobsStore } from '@/store/usePlanJobsStore';
import { useTheme } from '@/theme/useTheme';
import { Text } from '@/components/Text';
import { GlassSurface } from '@/components/Glass';
import { GradientWave } from '@/components/GradientWave';
import { ChatComposerBar } from '@/components/ChatComposerBar';
import { PlanBuildingCard } from '@/components/PlanBuildingCard';
import { PlanSetupSheet } from '@/components/PlanSetupSheet';
import { ErrandDrawer } from '@/components/ErrandDrawer';
import { ErrandRow } from '@/components/ErrandRow';
import { WeatherCard } from '@/components/WeatherCard';
import { PlanPeek } from '@/components/PlanPeek';
import { parseErrandRemote, type ErrandDraft } from '@/lib/ai/parseErrand';
import { type DiscoveryIntent } from '@/lib/discover';
import { isDailyReviewResponse } from '@/lib/notifications';
import { formatTime, formatDuration, todayISO, tomorrowISO } from '@/utils/time';
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
    autoPlace: e.autoPlace ?? null,
    placeQuery: e.placeQuery ?? null,
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

  const plans = useDayStore((s) => s.plans);
  const isScheduling = useDayStore((s) => s.isScheduling);
  const isComposing = useDayStore((s) => s.isComposing);
  const isWorking = isScheduling || isComposing;

  const savedTrips = useSavedItineraries((s) => s.items);
  // The homepage is strictly "today": the day's active plan (the one the user
  // pinned, else the first they created that day) is the card, and any other
  // plans dated today are reachable via the "other plans" link below it.
  const today = todayISO();
  const todayPlans = useMemo(
    () => plansForDate(savedTrips, today),
    [savedTrips, today],
  );
  const activeToday = useMemo(
    () => activePlanForDate(savedTrips, today),
    [savedTrips, today],
  );
  const otherTodayCount = Math.max(0, todayPlans.length - 1);

  // A day still building in the background (the user kicked off a plan and was
  // sent back here). Takes over the card with a live skeleton until it lands —
  // see the card branch below. We surface the most recent in-flight build
  // regardless of its date: the card speaks for itself ("Building your plan")
  // and a future-day build still deserves visible progress here.
  const buildingJob = usePlanJobsStore((s) =>
    s.jobs.find((j) => j.status === 'building'),
  );

  // ----- Errands -----
  const errands = useErrandsStore((s) => s.items);
  const addErrand = useErrandsStore((s) => s.add);
  const updateErrand = useErrandsStore((s) => s.update);
  const toggleErrandDone = useErrandsStore((s) => s.toggleDone);
  const reopenErrand = useErrandsStore((s) => s.reopen);
  const removeErrand = useErrandsStore((s) => s.remove);
  // The home list focuses on today: today's dated errands lead the Scheduled
  // group, then "Anytime" (capped), then a collapsible "Completed" section.
  const errandGroups = useMemo(
    () => groupErrands(errands, { focusDate: today, today }),
    [errands, today],
  );
  const [showAllAnytime, setShowAllAnytime] = useState(false);
  const [showCompleted, setShowCompleted] = useState(false);

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

  const onComposerSubmit = (text: string) => {
    const seq = (parseSeq.current += 1);
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
    setDrawerSeed({ ...EMPTY_DRAFT, title: text });
    setDrawerParsing(true);
    setDrawerSeedKey(`parse-${seq}`);
    setDrawerOpen(true);
    Haptics.selectionAsync().catch(() => undefined);
    parseErrandRemote(text, { date: todayISO() })
      .then((res) => {
        if (seq !== parseSeq.current) return;
        if (res.intent === 'discover' && res.discovery) {
          setDrawerDiscovery(res.discovery);
          setDrawerSeed(res.draft);
          setDrawerInitialStep('discover');
          setDrawerParsing(false);
          setDrawerSeedKey(`discover-${seq}`);
        } else {
          setDrawerSeed(res.draft);
          setDrawerInitialStep('form');
          setDrawerParsing(false);
          setDrawerSeedKey(`create-${seq}-done`);
        }
      })
      .catch(() => {
        if (seq !== parseSeq.current) return;
        setDrawerSeed({ ...EMPTY_DRAFT, title: text });
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
    if (editId) removeErrand(editId);
    setDrawerOpen(false);
  };

  const gradientHeight = Math.round(height * 0.8);

  const next = plans[0];
  const moreCount = Math.max(0, plans.length - 1);

  const [setupOpen, setSetupOpen] = useState(false);
  // When the planner is opened from the daily reminder we seed it to tomorrow;
  // every other entry point (the card, the "+" composer) leaves this undefined
  // so the sheet defaults to today.
  const [setupInitialDate, setSetupInitialDate] = useState<string | undefined>(
    undefined,
  );
  const setDayPlan = usePlanSetupStore((s) => s.setDayPlan);
  const openSetup = () => {
    setSetupInitialDate(undefined);
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
  } else if (isWorking) {
    cardBody = (
      <>
        <ActivityIndicator color={t.colors.accent} />
        <View style={styles.cardText}>
          <Text variant="micro" uppercase weight="bold" tone="secondary">
            Planning
          </Text>
          <Text variant="body" weight="semibold">
            Building your schedule…
          </Text>
        </View>
      </>
    );
  } else if (next) {
    cardOnPress = () => {
      Haptics.selectionAsync().catch(() => undefined);
      router.push('/itinerary');
    };
    cardA11y = "Open today's plan";
    cardBody = (
      <>
        <View style={[styles.dot, { backgroundColor: t.colors.accent }]} />
        <View style={styles.cardText}>
          <Text variant="micro" uppercase weight="bold" tone="accent">
            Up next
          </Text>
          <Text variant="body" weight="semibold" numberOfLines={1}>
            {next.title || next.rawText}
          </Text>
          <Text variant="caption" tone="secondary" numberOfLines={1}>
            {[
              next.startTime ? formatTime(next.startTime) : null,
              formatDuration(next.durationMinutes),
            ]
              .filter(Boolean)
              .join(' · ')}
          </Text>
        </View>
        {moreCount > 0 ? (
          <View style={[styles.morePill, { backgroundColor: t.colors.fill1 }]}>
            <Text variant="caption" weight="semibold" tone="secondary">
              +{moreCount}
            </Text>
          </View>
        ) : null}
        <Ionicons
          name="chevron-forward"
          size={18}
          color={t.colors.textTertiary}
        />
      </>
    );
  } else if (activeToday) {
    cardOnPress = () => {
      Haptics.selectionAsync().catch(() => undefined);
      router.push({ pathname: '/itinerary', params: { id: activeToday.id } });
    };
    cardA11y = `Open ${activeToday.title}`;
    cardPeek = <PlanPeek itinerary={activeToday.itinerary} />;
    cardBody = (
      <>
        <View style={[styles.thumb, { backgroundColor: t.colors.fill1 }]}>
          {activeToday.thumbUrl ? (
            <Image source={{ uri: activeToday.thumbUrl }} style={styles.thumbImg} />
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
            Today&apos;s plan
          </Text>
          <Text variant="body" weight="semibold" numberOfLines={1}>
            {activeToday.title}
          </Text>
          <Text variant="caption" tone="secondary" numberOfLines={1}>
            {tripSubtitle(activeToday)}
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
            <Text variant="body" style={{ color: ON_SOFT }}>
              {formatLongDate(today)}
            </Text>
          </View>

          <Pressable
            disabled={!cardOnPress}
            onPress={cardOnPress}
            accessibilityRole={cardOnPress ? 'button' : undefined}
            accessibilityLabel={cardA11y}
            style={({ pressed }) =>
              pressed && cardOnPress
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

          {!isWorking && otherTodayCount > 0 ? (
            <Pressable
              onPress={() => {
                Haptics.selectionAsync().catch(() => undefined);
                router.push('/day-plans');
              }}
              accessibilityRole="button"
              accessibilityLabel={`View all ${todayPlans.length} plans for today`}
              style={({ pressed }) => [
                styles.otherPlans,
                pressed && { opacity: 0.6 },
              ]}
            >
              <Text variant="caption" weight="semibold" style={{ color: ON_SOFT }}>
                {otherTodayCount} other plan{otherTodayCount === 1 ? '' : 's'} today
              </Text>
              <View style={styles.otherPlansCta}>
                <Text variant="caption" weight="semibold" style={{ color: ON }}>
                  View all
                </Text>
                <Ionicons name="chevron-forward" size={13} color={ON} />
              </View>
            </Pressable>
          ) : null}

          <WeatherCard style={styles.weather} />

          {/* Errands / reminders */}
          {errands.length > 0 ? (
            <View style={styles.errands}>
              {errandGroups.scheduled.length > 0 ? (
                <ErrandSection title="Scheduled" count={errandGroups.scheduled.length}>
                  {errandGroups.scheduled.map((errand, i) => (
                    <ErrandRow
                      key={errand.id}
                      errand={errand}
                      onPress={() => onEditErrand(errand)}
                      onToggleDone={() => toggleErrandDone(errand.id)}
                      showSeparator={i < errandGroups.scheduled.length - 1}
                    />
                  ))}
                </ErrandSection>
              ) : null}

              {errandGroups.anytime.length > 0 ? (
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

              {errandGroups.completed.length > 0 ? (
                <ErrandSection
                  title="Completed"
                  count={errandGroups.completed.length}
                  collapsible
                  collapsed={!showCompleted}
                  onToggle={() => {
                    Haptics.selectionAsync().catch(() => undefined);
                    setShowCompleted((v) => !v);
                  }}
                >
                  {errandGroups.completed.map((errand, i) => (
                    <ErrandRow
                      key={errand.id}
                      errand={errand}
                      onToggleDone={() => toggleErrandDone(errand.id)}
                      onReopen={() => reopenErrand(errand.id)}
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
                name="checkmark-circle-outline"
                size={18}
                color={t.colors.textTertiary}
              />
              <Text variant="caption" tone="tertiary" style={styles.errandsHintText}>
                Add a quick smart reminder below — like “call mom” or “dentist at 18:00”.
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
  hero: {
    marginTop: 28,
    gap: 8,
  },
  greeting: {
    fontSize: 38,
    lineHeight: 44,
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
