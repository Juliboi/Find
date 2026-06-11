import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Switch,
  TextInput,
  View,
} from 'react-native';
import DateTimePicker, {
  type DateTimePickerEvent,
} from '@react-native-community/datetimepicker';
import { BottomSheetTextInput } from '@gorhom/bottom-sheet';
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
  type DayPlanSelection,
} from '@/store/usePlanSetupStore';
import { useProfileStore } from '@/store/useProfileStore';
import { useHomeStore, type LocationPin } from '@/store/useHomeStore';
import { getCurrentCoords } from '@/lib/places';
import {
  autocompletePlaces,
  resolvePlace,
  reverseGeocode,
  type PlacePrediction,
} from '@/lib/geocoding';
import { formatTime, minutesOfDay } from '@/utils/time';

type Step = 0 | 1;

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
}: Props) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const dayStartTime = usePlanSetupStore((s) => s.dayStartTime);
  const hasCar = useProfileStore((s) => s.hasCar);
  const bedTime = useProfileStore((s) => s.bedTime);
  const useCarToday = usePlanSetupStore((s) => s.useCarToday);
  const setUseCarToday = usePlanSetupStore((s) => s.setUseCarToday);
  const home = useHomeStore((s) => s.home);

  // The week is held in state and refreshed each time the sheet opens, so
  // "today" stays correct across a midnight rollover while the app sits
  // backgrounded.
  const [days, setDays] = useState(() => upcomingWeek(DAY_COUNT));
  const [dayIndex, setDayIndex] = useState(0);
  const [startTimeD, setStartTimeD] = useState<Date>(() =>
    hhmmToDate(roundedNowHHMM()),
  );
  const [endTimeD, setEndTimeD] = useState<Date>(() =>
    hhmmToDate(bedTime ?? DEFAULT_DAY_END_TIME),
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

  // Locations. `currentLoc` is the GPS result captured on open; start/end hold
  // the user's (possibly edited) picks.
  const [currentLoc, setCurrentLoc] = useState<LocationPin | null>(null);
  const [locLoading, setLocLoading] = useState(false);
  const [startLoc, setStartLoc] = useState<LocationPin | null>(null);
  const [endLoc, setEndLoc] = useState<LocationPin | null>(null);

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
    // For TODAY, always seed the start to the live clock (which the dev-clock
    // override drives) so "now" is correct after a midnight rollover or a
    // fake-time change — never a stale start carried over from an earlier
    // session. Future days keep the explicit pick or the configured default.
    const seedTime = fresh[idx]?.isToday
      ? roundedNowHHMM()
      : (initialTime ?? dayStartTime);
    setStartTimeD(hhmmToDate(seedTime));
    setEndTimeD(hhmmToDate(bedTime ?? DEFAULT_DAY_END_TIME));
    setStep(initialStep);
    setAndroidPicker(false);
    setActiveRow(null);

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

  const goToStep = (next: Step) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(
      () => undefined,
    );
    setAndroidPicker(false);
    setActiveRow(null);
    setStep(next);
  };

  const confirm = () => {
    if (!selected) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(
      () => undefined,
    );
    onConfirm({
      date: selected.iso,
      startTime,
      startLocation: startLoc,
      endTime,
      endLocation: endLoc,
    });
  };

  const closeButton = (
    <Pressable
      onPress={() => {
        Haptics.selectionAsync().catch(() => undefined);
        onClose();
      }}
      hitSlop={10}
      style={[styles.iconBtn, { backgroundColor: t.colors.fill1 }]}
      accessibilityLabel="Close"
    >
      <Ionicons name="close" size={18} color={t.colors.textSecondary} />
    </Pressable>
  );

  return (
    <Sheet
      open={open}
      onClose={onClose}
      heightFraction={0.99}
      enableContentPanningGesture={false}
    >
      <View style={styles.container}>
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
          ) : (
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
                      ? `${selected.title}, ${selected.dateLabel} · 2 of 2`
                      : '2 of 2'}
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
                hint="Defaults to your usual wind-down"
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
                <Button title="Confirm" onPress={confirm} fullWidth size="lg" />
              </Animated.View>
            </>
          )}
        </View>

        {androidPicker && Platform.OS !== 'ios' ? (
          <DateTimePicker
            value={androidPicker === 'end' ? endTimeD : startTimeD}
            mode="time"
            display="default"
            minuteInterval={5}
            onChange={androidPicker === 'end' ? onEndTimeChange : onStartTimeChange}
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
  footer: {
    paddingTop: 6,
  },
  summary: {
    textAlign: 'center',
    marginBottom: 10,
  },
});
