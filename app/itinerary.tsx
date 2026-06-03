import React, { useEffect, useMemo, useRef, useState } from 'react';
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
  runOnJS,
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
import { formatDuration, todayISO } from '@/utils/time';

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

const PLANNING_PHASES = [
  'Drafting your day…',
  'Finding the best places…',
  'Mapping your route…',
  'Polishing the details…',
];

const HOME_ID = '__home__';

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

  // Opening a saved plan from the homepage: hydrate it (once) so the screen
  // shows the preview straight away with the drawer already collapsed.
  const params = useLocalSearchParams<{ id?: string }>();
  const preloaded = useMemo(() => {
    if (!params.id) return null;
    return (
      useSavedItineraries.getState().items.find((i) => i.id === params.id)
        ?.itinerary ?? null
    );
  }, [params.id]);

  const [input, setInput] = useState(SAMPLE_PROMPT);
  const [itinerary, setItinerary] = useState<Itinerary | null>(preloaded);
  const [usedAi, setUsedAi] = useState(!!preloaded);
  const [loading, setLoading] = useState(false);
  const [debug, setDebug] = useState<ItineraryDebug | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [showDebug, setShowDebug] = useState(false);
  const [activeSectionIndex, setActiveSectionIndex] = useState(0);
  const [activeStopId, setActiveStopId] = useState<string | null>(null);
  const [sheetExpanded, setSheetExpanded] = useState(!preloaded);
  const [phase, setPhase] = useState(0);

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

  const listRef = useRef<ScrollView>(null);
  const tabsRef = useRef<ScrollView>(null);
  const sectionOffsetsRef = useRef<number[]>([]);
  const itemOffsetsRef = useRef<Record<string, number>>({});
  const tabOffsetsRef = useRef<number[]>([]);

  const context: SchedulerContext = { home, endOfDay };

  const flatItems = useMemo(
    () => (itinerary ? itinerary.sections.flatMap((s) => s.items) : []),
    [itinerary],
  );

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
        n += 1;
        seen.add(key(c)); // a numbered stop wins over a coincident station dot
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
    tabOffsetsRef.current = [];
    setActiveSectionIndex(0);
    setActiveStopId(null);
  };

  const planIt = async () => {
    const text = input.trim();
    if (!text || loading) return;
    Haptics.selectionAsync().catch(() => undefined);
    setLoading(true);
    setErrorMsg(null);
    resetTracking();
    snapTo(expandedTop); // show the skeleton full-height while we work
    try {
      const result = await planItinerary(text, {
        context,
        date: todayISO(),
        debug: true,
      });
      setItinerary(result.itinerary);
      setUsedAi(result.usedAi);
      setDebug(result.debug ?? null);
      if (!result.itinerary) {
        setErrorMsg('No itinerary was produced. Check the debug section.');
      } else {
        // Keep it for later — it'll surface on the homepage's "Day trips".
        saveItinerary(result.itinerary);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(
          () => undefined,
        );
        // Let the day fade in expanded for a beat, then ease the drawer down
        // to reveal the mapped route — a small reveal beats a hard cut.
        setTimeout(() => snapTo(collapsedTop), 520);
      }
    } catch (e: any) {
      setErrorMsg(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  };

  const reset = () => {
    setItinerary(null);
    setDebug(null);
    setErrorMsg(null);
    setUsedAi(false);
    resetTracking();
    snapTo(expandedTop);
  };

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (!itinerary) return;
    const probe = e.nativeEvent.contentOffset.y + 96;

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

    // Default to the home pin while scrolled through the at-home morning
    // blocks (which have no coords), then switch as each located stop passes.
    let stopId: string | null = home ? HOME_ID : null;
    for (const item of flatItems) {
      if (!item.place?.coords) continue;
      const off = itemOffsetsRef.current[item.id];
      if (off != null && off <= probe) stopId = item.id;
    }
    // Returning home: once the "Back home" arrival (placeless, but reached by
    // a travel leg) scrolls into view, snap focus back to the home pin so the
    // map shows the day ending at home instead of lingering on the last stop.
    const last = flatItems[flatItems.length - 1];
    if (home && last && !last.place?.coords && last.travelFromPrev) {
      const off = itemOffsetsRef.current[last.id];
      if (off != null && off <= probe) stopId = HOME_ID;
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
                          { color: active ? t.colors.accentText : t.colors.textSecondary },
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
            paddingHorizontal: t.spacing.lg,
            paddingTop: 8,
            paddingBottom: insets.bottom + 80,
          }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          onScroll={onScroll}
          scrollEventThrottle={16}
        >
          {loading ? (
            <PlanningSkeleton />
          ) : !itinerary ? (
            <View style={{ gap: 16 }}>
              <HomePicker title="Home" />
              <Card padded>
                <Text variant="title3" weight="bold" tight>
                  Describe your whole day
                </Text>
                <Text variant="bodySm" tone="secondary" style={{ marginTop: 6 }}>
                  One free-form prompt — the AI plans the day, and the app draws the
                  real route and travel between every stop.
                </Text>
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
            <>
              {itinerary.summary ? (
                <Text variant="bodySm" tone="secondary" style={{ marginBottom: 2 }}>
                  {itinerary.summary}
                </Text>
              ) : null}
              {itinerary.origin ? (
                <Text variant="caption" tone="tertiary" style={{ marginTop: 4 }}>
                  From {itinerary.origin}
                </Text>
              ) : null}

              {sections.map((section, si) => (
                <SectionBlock
                  key={section.id}
                  section={section}
                  first={si === 0}
                  index={si}
                  onSectionLayout={(y) => {
                    sectionOffsetsRef.current[si] = y;
                  }}
                  onItemLayout={(id, y) => {
                    itemOffsetsRef.current[id] = y;
                  }}
                />
              ))}

              {debug ? (
                <Card padded style={{ marginTop: 18 }}>
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
            </>
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
  index,
  onSectionLayout,
  onItemLayout,
}: {
  section: ItinerarySection;
  first: boolean;
  index: number;
  onSectionLayout: (y: number) => void;
  onItemLayout: (id: string, y: number) => void;
}) {
  const base = Math.min(index * 50, 150);
  return (
    <>
      <Animated.View
        entering={FadeInDown.duration(280).delay(base)}
        style={{ marginTop: first ? 12 : 20 }}
        onLayout={(e) => onSectionLayout(e.nativeEvent.layout.y)}
      >
        <SectionHeader period={section.period} title={section.title} />
      </Animated.View>
      {section.items.map((item, i) => (
        <Animated.View
          key={item.id}
          entering={FadeInDown.duration(280).delay(Math.min(base + (i + 1) * 40, 360))}
          style={{ marginTop: 8 }}
          onLayout={(e) => onItemLayout(item.id, e.nativeEvent.layout.y)}
        >
          {item.travelFromPrev ? <TravelLegRow leg={item.travelFromPrev} /> : null}
          <ItemCard item={item} />
        </Animated.View>
      ))}
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

function SectionHeader({ period, title }: { period?: string; title: string }) {
  return (
    <View style={styles.sectionHeader}>
      {period ? (
        <Text variant="micro" tone="tertiary" uppercase weight="bold">
          {period}
        </Text>
      ) : null}
      <Text variant="subhead" weight="bold" tight>
        {title}
      </Text>
    </View>
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

/**
 * Connector that sits BETWEEN two place cards and shows how you get from one
 * to the next — a simple hop on one line, or a full journey broken into its
 * transit legs (🚶 → 🚌 → 🚇 → 🚆), maps-app style.
 */
function TravelLegRow({ leg }: { leg: TravelLeg }) {
  const t = useTheme();
  const steps = leg.steps ? mergeWalkSteps(leg.steps) : [];
  const hasSteps = steps.length > 0;
  const bubbleEmoji = TRAVEL_MODE_EMOJI[leg.mode] ?? '➡️';
  const label = TRAVEL_MODE_LABEL[leg.mode] ?? 'travel';
  return (
    <View style={styles.legWrap}>
      <View style={styles.legRail} accessibilityElementsHidden>
        <View style={[styles.legLine, { backgroundColor: t.colors.separator }]} />
        <View
          style={[
            styles.legDot,
            { backgroundColor: t.colors.surface1, borderColor: t.colors.separator },
          ]}
        >
          <RNText style={styles.legDotEmoji}>{bubbleEmoji}</RNText>
        </View>
        <View style={[styles.legLine, { backgroundColor: t.colors.separator }]} />
      </View>
      <View style={styles.legBody}>
        <RNText style={[styles.legHead, { color: t.colors.textSecondary }]}>
          {`${formatLegMinutes(leg.minutes)} ${label}`}
          {leg.fromLabel ? (
            <RNText style={{ color: t.colors.textTertiary, fontWeight: '400' }}>
              {` from ${leg.fromLabel}`}
            </RNText>
          ) : null}
        </RNText>
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

function ItemCard({ item }: { item: ItineraryItem }) {
  const t = useTheme();
  const place = item.place;
  const emoji = place?.emoji ?? KIND_EMOJI[item.kind];
  const timeRange =
    item.startTime && item.endTime
      ? `${item.startTime} – ${item.endTime}`
      : item.startTime ?? '';
  const rating = typeof place?.rating === 'number' ? place.rating : undefined;

  return (
    <Card padded>
      <View style={styles.itemTopRow}>
        <Text variant="caption" tone="secondary" weight="semibold">
          {timeRange}
          {item.durationMinutes ? `  ·  ${formatDuration(item.durationMinutes)}` : ''}
        </Text>
        {SHOW_FLEX_BADGES ? <FlexBadge flexibility={item.flexibility} /> : null}
      </View>

      <Text variant="body" weight="semibold" style={{ marginTop: 6 }}>
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
  sectionHeader: {
    gap: 2,
  },
  itemTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
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
  legWrap: {
    flexDirection: 'row',
    gap: 10,
    paddingLeft: 4,
  },
  legRail: {
    width: 24,
    alignItems: 'center',
  },
  legLine: {
    width: StyleSheet.hairlineWidth * 2,
    flex: 1,
    minHeight: 6,
  },
  legDot: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: 2,
  },
  legDotEmoji: {
    fontSize: 12,
  },
  legBody: {
    flex: 1,
    paddingVertical: 6,
    gap: 4,
  },
  legHead: {
    fontSize: 13,
    fontWeight: '600',
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
