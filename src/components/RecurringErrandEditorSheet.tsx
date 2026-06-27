import React, { useEffect, useMemo, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { BottomSheetScrollView, BottomSheetTextInput } from '@gorhom/bottom-sheet';
import DateTimePicker, {
  type DateTimePickerEvent,
} from '@react-native-community/datetimepicker';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/theme/useTheme';
import { Text } from './Text';
import { Button } from './Button';
import { Sheet } from './Sheet';
import { ErrandAddressField, type AddressValue } from './ErrandAddressField';
import { ErrandDiscoverStep } from './ErrandDiscoverStep';
import { TravelModeToggle } from './TravelModeToggle';
import { useHomeStore } from '@/store/useHomeStore';
import { useProfileStore } from '@/store/useProfileStore';
import type { NearbyPlace } from '@/lib/places';
import type { TravelPref } from '@/store/useErrandsStore';
import type {
  RecurringErrand,
  RecurringErrandInput,
} from '@/store/useRecurringErrandsStore';
import {
  formatTime,
  formatDuration,
  minutesOfDay,
  addMinutes,
  errandTimeMode,
  type TimeMode,
} from '@/utils/time';
import { roundedNowHHMM } from '@/utils/days';

interface Props {
  open: boolean;
  onClose: () => void;
  /** The template being edited, or null/undefined to add a new one. */
  errand?: RecurringErrand | null;
  onSubmit: (input: RecurringErrandInput) => void;
  /** Shown only when editing an existing template. */
  onDelete?: () => void;
}

// Monday-first display, mapped to JS weekday numbers (0 = Sunday).
const WEEKDAYS: { num: number; label: string }[] = [
  { num: 1, label: 'Mon' },
  { num: 2, label: 'Tue' },
  { num: 3, label: 'Wed' },
  { num: 4, label: 'Thu' },
  { num: 5, label: 'Fri' },
  { num: 6, label: 'Sat' },
  { num: 0, label: 'Sun' },
];
const DURATION_CHOICES = [15, 30, 45, 60, 90, 120, 180];
const DEFAULT_DURATION = 60;
// Default span of a fresh "Between" availability window (start … start + 2h).
const DEFAULT_WINDOW_SPAN = 120;
const DAY_END_MIN = 23 * 60 + 55;

function hhmmToDate(hhmm: string): Date {
  const mins = minutesOfDay(hhmm) ?? 18 * 60;
  const d = new Date();
  d.setHours(Math.floor(mins / 60), mins % 60, 0, 0);
  return d;
}

function dateToHHMM(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** A "to" time `spanMin` after `start`, clamped so a window never wraps midnight. */
function windowEndDate(start: Date, spanMin: number): Date {
  const startMin = start.getHours() * 60 + start.getMinutes();
  const endMin = Math.min(startMin + spanMin, DAY_END_MIN);
  const d = new Date(start);
  d.setHours(Math.floor(endMin / 60), endMin % 60, 0, 0);
  return d;
}

const minutesOf = (d: Date) => d.getHours() * 60 + d.getMinutes();

function placeToValue(e: RecurringErrand | null | undefined): AddressValue | null {
  if (!e?.address) return null;
  return {
    label: e.address,
    latitude: e.latitude,
    longitude: e.longitude,
    placeId: e.placeId ?? null,
  };
}

/** A recurring template has no day context, so it offers three location methods. */
type LocMethod = 'home' | 'specific' | 'discover';

/** Loose coordinate equality so a re-seeded pin still reads as the same place. */
function samePin(
  a: { latitude?: number | null; longitude?: number | null } | null | undefined,
  b: { latitude: number; longitude: number } | null | undefined,
): boolean {
  if (!a || !b || a.latitude == null || a.longitude == null) return false;
  return (
    Math.abs(a.latitude - b.latitude) < 1e-6 &&
    Math.abs(a.longitude - b.longitude) < 1e-6
  );
}

/** Build the home pin as a place selection. */
function homeValue(home: {
  label?: string;
  latitude: number;
  longitude: number;
}): AddressValue {
  return {
    label: home.label?.trim() || 'Home',
    latitude: home.latitude,
    longitude: home.longitude,
  };
}

/** Convert a discovery candidate into a place selection. */
function placeToAddressValue(p: NearbyPlace): AddressValue {
  return {
    label: p.name,
    latitude: p.latitude,
    longitude: p.longitude,
    placeId: p.id ?? null,
    photoUrl: p.photoUrl ?? null,
    rating: p.rating ?? null,
    ratingCount: p.ratingCount ?? null,
    priceLevel: p.priceLevel ?? null,
    openingHours: p.openingHours ?? null,
  };
}

/**
 * Add / edit a recurring errand template: a title, the weekdays it repeats on, a
 * time + length, and a place (pinned or "let Diem find it"). Lives in a bottom
 * sheet so the place picker works and so it can be summoned from onboarding or
 * Settings. The day-by-day occurrences are ordinary errands edited elsewhere.
 */
export function RecurringErrandEditorSheet({
  open,
  onClose,
  errand,
  onSubmit,
  onDelete,
}: Props) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const home = useHomeStore((s) => s.home);
  const hasCar = useProfileStore((s) => s.hasCar);
  const center = useMemo(
    () => (home ? { latitude: home.latitude, longitude: home.longitude } : null),
    [home],
  );

  const [title, setTitle] = useState('');
  const [weekdays, setWeekdays] = useState<number[]>([]);
  // 'anytime' (no clock), 'at' (fixed start), or 'between' (an availability
  // window the planner schedules inside).
  const [timeMode, setTimeMode] = useState<TimeMode>('at');
  const [startD, setStartD] = useState<Date>(() => hhmmToDate('18:00'));
  // The "to" edge of a Between window. Only meaningful in 'between' mode.
  const [endD, setEndD] = useState<Date>(() =>
    windowEndDate(hhmmToDate('18:00'), DEFAULT_WINDOW_SPAN),
  );
  // Length is always required now (every occurrence reserves a real block).
  const [durationMin, setDurationMin] = useState<number>(DEFAULT_DURATION);
  const [addr, setAddr] = useState<AddressValue | null>(null);
  // Which location method is active (Home / Specific / Discover) — every one
  // resolves to a concrete `addr` before the template can be saved.
  const [locMethod, setLocMethod] = useState<LocMethod | null>(null);
  // Bumped to pop the "Specific location" search open imperatively.
  const [searchToken, setSearchToken] = useState(0);
  // True while the in-sheet "Discover" place step is showing.
  const [discoverOpen, setDiscoverOpen] = useState(false);
  // Explicit travel preference, or undefined to follow the profile default.
  const [travelMode, setTravelMode] = useState<TravelPref | undefined>(undefined);
  const [notes, setNotes] = useState('');
  // false, or which edge's Android time dialog is open ('start' | 'end').
  const [androidPicker, setAndroidPicker] = useState<false | 'start' | 'end'>(
    false,
  );

  const seedKey = `rcr-${errand?.id ?? 'new'}-${open ? 'open' : 'closed'}`;
  useEffect(() => {
    if (!open) return;
    setTitle(errand?.title ?? '');
    setWeekdays(errand?.weekdays ?? []);
    // New templates default to a fixed time; existing ones reflect their data.
    const seededMode = errand
      ? errandTimeMode(errand.startTime, errand.endTime, errand.durationMin)
      : 'at';
    setTimeMode(seededMode);
    const sd = hhmmToDate(errand?.startTime ?? roundedNowHHMM());
    setStartD(sd);
    setEndD(
      seededMode === 'between' && errand?.endTime
        ? hhmmToDate(errand.endTime)
        : windowEndDate(sd, DEFAULT_WINDOW_SPAN),
    );
    setDurationMin(errand?.durationMin ?? DEFAULT_DURATION);
    const seededAddr = placeToValue(errand);
    setAddr(seededAddr);
    setLocMethod(
      seededAddr ? (samePin(seededAddr, home) ? 'home' : 'specific') : null,
    );
    setDiscoverOpen(false);
    setTravelMode(errand?.travelMode ?? undefined);
    setNotes(errand?.notes ?? '');
    setAndroidPicker(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, errand]);

  const startTime = dateToHHMM(startD);
  const windowEnd = dateToHHMM(endD);
  // 'between' → the window's "to"; 'at' → start+duration; 'anytime' → none.
  const endTime =
    timeMode === 'between'
      ? windowEnd
      : durationMin != null
      ? addMinutes(startTime, durationMin)
      : undefined;
  // Save needs a title, at least one weekday, a concrete length, and a real
  // located place (lat/lng resolved) — the planner relies on all three.
  const hasLocation = addr?.latitude != null && addr?.longitude != null;
  const canSave =
    title.trim().length > 0 &&
    weekdays.length > 0 &&
    durationMin != null &&
    durationMin > 0 &&
    hasLocation;
  const discoverQuery = title.trim() || 'place';

  // A place pinned to the user's saved home needs no "how you'll get there":
  // travel mode is about getting TO an errand, which is moot when the errand is
  // home itself, so we hide the toggle (and never persist a mode) for it.
  const isHomeLocation =
    !!home &&
    addr?.latitude != null &&
    addr?.longitude != null &&
    Math.abs(addr.latitude - home.latitude) < 1e-6 &&
    Math.abs(addr.longitude - home.longitude) < 1e-6;

  const toggleWeekday = (num: number) => {
    Haptics.selectionAsync().catch(() => undefined);
    setWeekdays((prev) =>
      prev.includes(num) ? prev.filter((d) => d !== num) : [...prev, num],
    );
  };

  const onSelectMode = (next: TimeMode) => {
    if (next === timeMode) return;
    Haptics.selectionAsync().catch(() => undefined);
    // A timed/between template needs a concrete length (so it has an end);
    // coerce away "Any length" but keep an estimate the user already picked.
    if (next !== 'anytime') setDurationMin((cur) => cur ?? DEFAULT_DURATION);
    // Entering Between: make sure the "to" sits after the "from".
    if (next === 'between' && minutesOf(endD) <= minutesOf(startD)) {
      setEndD(windowEndDate(startD, DEFAULT_WINDOW_SPAN));
    }
    setTimeMode(next);
    setAndroidPicker(false);
  };

  const onStartChange = (event: DateTimePickerEvent, selected?: Date) => {
    if (Platform.OS !== 'ios') setAndroidPicker(false);
    if (event.type === 'dismissed') return;
    if (!selected) return;
    setStartD(selected);
    // Keep the window's "to" after its "from".
    if (timeMode === 'between' && minutesOf(endD) <= minutesOf(selected)) {
      setEndD(windowEndDate(selected, DEFAULT_WINDOW_SPAN));
    }
  };

  const onEndChange = (event: DateTimePickerEvent, selected?: Date) => {
    if (Platform.OS !== 'ios') setAndroidPicker(false);
    if (event.type === 'dismissed') return;
    if (selected) setEndD(selected);
  };

  const chooseHome = () => {
    Haptics.selectionAsync().catch(() => undefined);
    setLocMethod('home');
    setAddr(home ? homeValue(home) : null);
  };
  const chooseSpecific = () => {
    Haptics.selectionAsync().catch(() => undefined);
    setLocMethod('specific');
    setAddr(null);
    setSearchToken((n) => n + 1);
  };
  const chooseDiscover = () => {
    Haptics.selectionAsync().catch(() => undefined);
    setLocMethod('discover');
    setAddr(null);
    setDiscoverOpen(true);
  };

  const save = () => {
    if (!canSave) return;
    Haptics.selectionAsync().catch(() => undefined);
    const isTimed = timeMode !== 'anytime';
    onSubmit({
      title: title.trim(),
      weekdays,
      startTime: isTimed ? startTime : undefined,
      endTime: isTimed ? endTime : undefined,
      durationMin: durationMin ?? undefined,
      address: addr?.label,
      latitude: addr?.latitude,
      longitude: addr?.longitude,
      placeId: addr?.placeId ?? undefined,
      // You don't commute to your own home, so a home-pinned template carries
      // no travel mode; otherwise persist the chosen mode for the located spot.
      travelMode: !isHomeLocation ? travelMode : undefined,
      notes: notes.trim() ? notes.trim() : undefined,
    });
    onClose();
  };

  return (
    <Sheet open={open} onClose={onClose} heightFraction={0.92} enableContentPanningGesture={false}>
      {discoverOpen ? (
        <View style={styles.container}>
          <View style={[styles.discoverHeader, { borderBottomColor: t.colors.separator }]}>
            <Pressable
              onPress={() => {
                Haptics.selectionAsync().catch(() => undefined);
                setDiscoverOpen(false);
              }}
              hitSlop={8}
              style={styles.backBtn}
              accessibilityRole="button"
              accessibilityLabel="Back to the recurring errand form"
            >
              <Ionicons name="chevron-back" size={22} color={t.colors.textPrimary} />
            </Pressable>
            <Text variant="title3" weight="heavy" tight>
              Pick a spot
            </Text>
          </View>
          <ErrandDiscoverStep
            query={discoverQuery}
            area={null}
            nearby={false}
            fallbackCenter={center}
            anchorDate={null}
            anchorTime={timeMode !== 'anytime' ? startTime : null}
            onPick={(place) => {
              setAddr(placeToAddressValue(place));
              setLocMethod('specific');
              setDiscoverOpen(false);
            }}
            onManual={() => {
              setDiscoverOpen(false);
              setLocMethod('specific');
              setSearchToken((n) => n + 1);
            }}
          />
        </View>
      ) : (
      <View style={styles.container}>
        <BottomSheetScrollView
          style={styles.scroll}
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <Text variant="title3" weight="heavy" tight>
            {errand ? 'Edit recurring errand' : 'Add a recurring errand'}
          </Text>
          <Text variant="bodySm" tone="secondary">
            It appears on its days above your errands, and is preselected when you plan
            that day.
          </Text>

          <FieldLabel icon="repeat" label="What" />
          <BottomSheetTextInput
            value={title}
            onChangeText={setTitle}
            placeholder="e.g. Ping pong with Maty"
            placeholderTextColor={t.colors.textTertiary}
            autoCapitalize="sentences"
            style={[
              styles.input,
              { backgroundColor: t.colors.fill1, color: t.colors.textPrimary },
            ]}
          />

          <FieldLabel icon="calendar-outline" label="Repeats on" />
          <View style={styles.chips}>
            {WEEKDAYS.map((d) => {
              const active = weekdays.includes(d.num);
              return (
                <Pressable
                  key={d.num}
                  onPress={() => toggleWeekday(d.num)}
                  style={[
                    styles.dayChip,
                    {
                      backgroundColor: active ? t.colors.accent : t.colors.fill1,
                      borderColor: active ? t.colors.accent : t.colors.separator,
                    },
                  ]}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: active }}
                >
                  <Text
                    variant="bodySm"
                    weight="semibold"
                    style={{ color: active ? t.colors.textOnAccent : t.colors.textSecondary }}
                  >
                    {d.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <FieldLabel icon="time-outline" label="Time" />
          <View style={styles.segment}>
            <SelectChip
              label="Anytime"
              active={timeMode === 'anytime'}
              onPress={() => onSelectMode('anytime')}
            />
            <SelectChip
              label="At a time"
              active={timeMode === 'at'}
              onPress={() => onSelectMode('at')}
            />
            <SelectChip
              label="Between"
              active={timeMode === 'between'}
              onPress={() => onSelectMode('between')}
            />
          </View>
          {timeMode === 'at' ? (
            <TimeRow
              label="Starts"
              value={startD}
              display={formatTime(startTime)}
              onChange={onStartChange}
              onAndroidOpen={() => setAndroidPicker('start')}
            />
          ) : null}
          {timeMode === 'between' ? (
            <>
              <TimeRow
                label="From"
                value={startD}
                display={formatTime(startTime)}
                onChange={onStartChange}
                onAndroidOpen={() => setAndroidPicker('start')}
              />
              <TimeRow
                label="To"
                value={endD}
                display={formatTime(windowEnd)}
                onChange={onEndChange}
                onAndroidOpen={() => setAndroidPicker('end')}
              />
            </>
          ) : null}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.chipRow}
          >
            {DURATION_CHOICES.map((min) => (
              <SelectChip
                key={min}
                label={formatDuration(min)}
                active={durationMin === min}
                onPress={() => {
                  Haptics.selectionAsync().catch(() => undefined);
                  setDurationMin(min);
                }}
              />
            ))}
          </ScrollView>
          {timeMode === 'between' ? (
            <Text variant="caption" tone="tertiary" style={styles.windowHint}>
              Diem fits this in anywhere between {formatTime(startTime)} and{' '}
              {formatTime(windowEnd)}.
            </Text>
          ) : timeMode === 'at' && endTime ? (
            <Text variant="caption" tone="tertiary" style={styles.windowHint}>
              Each occurrence runs until {formatTime(endTime)}.
            </Text>
          ) : null}

          <FieldLabel icon="location-outline" label="Where" />
          {/* Three ways to set a concrete location — one is required to save. */}
          <View style={styles.locMethods}>
            <LocMethodChip
              label="Home"
              icon="home-outline"
              active={locMethod === 'home'}
              disabled={!home}
              onPress={chooseHome}
            />
            <LocMethodChip
              label="Specific"
              icon="search-outline"
              active={locMethod === 'specific'}
              onPress={chooseSpecific}
            />
            <LocMethodChip
              label="Discover"
              icon="sparkles-outline"
              active={locMethod === 'discover'}
              onPress={chooseDiscover}
            />
          </View>

          {addr || locMethod === 'specific' ? (
            <>
              <ErrandAddressField
                value={addr}
                center={center}
                home={home}
                seedKey={seedKey}
                autoOpenToken={searchToken}
                hideHomeShortcut
                allowUnpinned={false}
                emptyLabel="Tap to search a place"
                startTime={timeMode !== 'anytime' ? startTime : undefined}
                onChange={(next) => {
                  setAddr(next);
                  if (next) setLocMethod(samePin(next, home) ? 'home' : 'specific');
                }}
              />
              {addr?.latitude != null &&
              addr?.longitude != null &&
              !isHomeLocation ? (
                <View style={styles.travelBlock}>
                  <Text variant="micro" uppercase weight="bold" tone="secondary" style={{ letterSpacing: 1 }}>
                    How you&apos;ll get there
                  </Text>
                  <TravelModeToggle
                    value={travelMode}
                    hasCar={hasCar}
                    onChange={setTravelMode}
                  />
                </View>
              ) : null}
            </>
          ) : locMethod === 'home' ? (
            <LocationHint
              icon="home-outline"
              text="Set your home address in Settings to use it here."
            />
          ) : locMethod === 'discover' ? (
            <LocationHint
              icon="sparkles-outline"
              text="Pick a place from Discover to set the location."
            />
          ) : (
            <LocationHint
              icon="location-outline"
              text="Choose where this happens — a location is required so the planner can route your day."
            />
          )}

          <FieldLabel icon="document-text-outline" label="Note" />
          <BottomSheetTextInput
            value={notes}
            onChangeText={setNotes}
            placeholder="Optional"
            placeholderTextColor={t.colors.textTertiary}
            multiline
            style={[
              styles.input,
              styles.notes,
              { backgroundColor: t.colors.fill1, color: t.colors.textPrimary },
            ]}
          />

          {onDelete ? (
            <Pressable
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(
                  () => undefined,
                );
                onDelete();
                onClose();
              }}
              style={({ pressed }) => [styles.deleteRow, pressed && { opacity: 0.6 }]}
              accessibilityRole="button"
            >
              <Ionicons name="trash-outline" size={18} color={t.colors.danger} />
              <Text variant="body" weight="semibold" tone="danger">
                Delete recurring errand
              </Text>
            </Pressable>
          ) : null}
        </BottomSheetScrollView>

        <View
          style={[
            styles.footer,
            { paddingBottom: insets.bottom + 8, borderTopColor: t.colors.separator },
          ]}
        >
          <Button
            title={errand ? 'Save' : 'Add'}
            size="lg"
            onPress={save}
            disabled={!canSave}
            style={{ flex: 1 }}
          />
        </View>
      </View>
      )}

      {androidPicker && Platform.OS !== 'ios' && !discoverOpen ? (
        <DateTimePicker
          value={androidPicker === 'end' ? endD : startD}
          mode="time"
          display="default"
          minuteInterval={5}
          onChange={androidPicker === 'end' ? onEndChange : onStartChange}
        />
      ) : null}
    </Sheet>
  );
}

function FieldLabel({
  icon,
  label,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
}) {
  const t = useTheme();
  return (
    <View style={styles.fieldLabel}>
      <Ionicons name={icon} size={15} color={t.colors.textSecondary} />
      <Text variant="micro" uppercase weight="bold" tone="secondary" style={{ letterSpacing: 1 }}>
        {label}
      </Text>
    </View>
  );
}

/** A start/end time row: label on the left, inline (iOS) / pill (Android) picker. */
function TimeRow({
  label,
  value,
  display,
  onChange,
  onAndroidOpen,
}: {
  label: string;
  value: Date;
  display: string;
  onChange: (e: DateTimePickerEvent, d?: Date) => void;
  onAndroidOpen: () => void;
}) {
  const t = useTheme();
  return (
    <View style={[styles.timeRow, { borderTopColor: t.colors.separator }]}>
      <Text variant="body" weight="semibold">
        {label}
      </Text>
      {Platform.OS === 'ios' ? (
        <DateTimePicker
          value={value}
          mode="time"
          display="compact"
          minuteInterval={5}
          onChange={onChange}
          themeVariant={t.isDark ? 'dark' : 'light'}
        />
      ) : (
        <Pressable
          onPress={() => {
            Haptics.selectionAsync().catch(() => undefined);
            onAndroidOpen();
          }}
          style={[styles.timePill, { backgroundColor: t.colors.fill1 }]}
        >
          <Text variant="body" weight="bold" tone="accent">
            {display}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

function SelectChip({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  const t = useTheme();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        {
          backgroundColor: active ? t.colors.accent : t.colors.fill1,
          borderColor: active ? t.colors.accent : t.colors.separator,
        },
        pressed && !active && { opacity: 0.7 },
      ]}
    >
      <Text
        variant="bodySm"
        weight="semibold"
        style={{ color: active ? t.colors.textOnAccent : t.colors.textSecondary }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/** A pill for choosing how the template's location is set (the "Where" methods). */
function LocMethodChip({
  label,
  icon,
  active,
  disabled,
  onPress,
}: {
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  active: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  const t = useTheme();
  const color = active ? t.colors.textOnAccent : t.colors.textSecondary;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.locChip,
        {
          backgroundColor: active ? t.colors.accent : t.colors.fill1,
          borderColor: active ? t.colors.accent : t.colors.separator,
        },
        disabled && { opacity: 0.4 },
        pressed && !active && { opacity: 0.7 },
      ]}
      accessibilityRole="button"
      accessibilityState={{ selected: active, disabled: !!disabled }}
      accessibilityLabel={label}
    >
      <Ionicons name={icon} size={14} color={color} />
      <Text variant="bodySm" weight="semibold" style={{ color }}>
        {label}
      </Text>
    </Pressable>
  );
}

/** A small inline hint shown under the location methods (no place chosen yet). */
function LocationHint({
  icon,
  text,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  text: string;
}) {
  const t = useTheme();
  return (
    <View
      style={[
        styles.locHint,
        { backgroundColor: t.colors.fill1, borderColor: t.colors.separator },
      ]}
    >
      <Ionicons name={icon} size={15} color={t.colors.textTertiary} />
      <Text variant="caption" tone="tertiary" style={{ flex: 1 }}>
        {text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scroll: { flex: 1 },
  content: {
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 24,
    gap: 10,
  },
  fieldLabel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 8,
  },
  input: {
    minHeight: 48,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
  },
  notes: {
    minHeight: 64,
    textAlignVertical: 'top',
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  dayChip: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1,
  },
  segment: {
    flexDirection: 'row',
    gap: 8,
  },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 999,
    borderWidth: 1,
  },
  chipRow: {
    gap: 8,
    paddingVertical: 2,
  },
  timeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  windowHint: {
    paddingHorizontal: 2,
    paddingTop: 4,
  },
  timePill: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 10,
  },
  locMethods: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  locChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    height: 38,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
  },
  locHint: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  discoverHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backBtn: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  travelBlock: {
    gap: 8,
    paddingTop: 10,
    paddingBottom: 2,
  },
  deleteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 16,
    paddingVertical: 10,
  },
  footer: {
    flexDirection: 'row',
    paddingHorizontal: 20,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
