import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  type LayoutChangeEvent,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import {
  BottomSheetScrollView,
  BottomSheetTextInput,
} from '@gorhom/bottom-sheet';
import DateTimePicker, {
  type DateTimePickerEvent,
} from '@react-native-community/datetimepicker';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import Animated, {
  FadeInDown,
  FadeOutUp,
  LinearTransition,
} from 'react-native-reanimated';
import { useTheme } from '@/theme/useTheme';
import { useHomeStore } from '@/store/useHomeStore';
import { Sheet } from './Sheet';
import { Text } from './Text';
import { Button } from './Button';
import { ErrandAddressField, type AddressValue } from './ErrandAddressField';
import type { ErrandDraft } from '@/lib/ai/parseErrand';
import type { ErrandInput } from '@/store/useErrandsStore';
import { formatTime, formatDuration, minutesOfDay, addMinutes } from '@/utils/time';
import { upcomingWeek, describeDay, roundedNowHHMM } from '@/utils/days';

interface Props {
  open: boolean;
  onClose: () => void;
  /** The current seed values (a basic seed while parsing, full once parsed). */
  draft: ErrandDraft;
  /** The original text the user typed (kept on the saved errand). */
  rawText: string;
  /** True while the AI is still extracting — shows a reading state. */
  parsing: boolean;
  /**
   * Bumped by the parent whenever `draft` should be (re)applied to the form:
   * a fresh parse completing, or a different errand opened for editing.
   */
  seedKey: string;
  mode: 'create' | 'edit';
  onSave: (input: ErrandInput) => void;
  onDelete?: () => void;
}

const DAY_CHOICES = 14;

// Duration presets (minutes) offered as chips under the start time. An errand
// edited to a duration outside this set keeps its exact value via an injected
// chip (see `durationOptions`).
const DURATION_CHOICES = [15, 30, 45, 60, 90, 120, 180];
const DEFAULT_DURATION = 30;

/**
 * Minutes between a start and (optional) end "HH:MM", defaulting when the end is
 * absent or non-positive. Wraps across midnight so a late start still reads as a
 * sensible positive length.
 */
function durationFromDraft(start: string, end: string | null | undefined): number {
  if (!end) return DEFAULT_DURATION;
  const s = minutesOfDay(start);
  const e = minutesOfDay(end);
  if (s == null || e == null) return DEFAULT_DURATION;
  const diff = (((e - s) % 1440) + 1440) % 1440;
  return diff > 0 ? diff : DEFAULT_DURATION;
}

/**
 * Per-section staggered transitions — mirrors the planner ("+") drawer. Each
 * block rises in from just below while fading, one after another, so the
 * drawer's content flows in instead of appearing as one slab. The gorhom modal
 * remounts its children on every present, so this replays each time it opens.
 */
const ENTER = (i: number) => FadeInDown.duration(360).delay(110 + i * 60);
const EXIT = (i: number) => FadeOutUp.duration(200).delay(i * 30);

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

/**
 * The errand confirm drawer. Opens prefilled with whatever the parser pulled
 * out, and lets the user tweak each slot before saving — every slot is optional
 * and falls back to "Any day" / "Anytime" / "Anywhere". Used for both creating
 * a fresh errand and editing an existing one.
 */
export function ErrandDrawer({
  open,
  onClose,
  draft,
  rawText,
  parsing,
  seedKey,
  mode,
  onSave,
  onDelete,
}: Props) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const home = useHomeStore((s) => s.home);
  // Stable bias object so the address field's search effect doesn't re-fire on
  // every render (it keys off the lat/lng, not object identity).
  const center = useMemo(
    () => (home ? { latitude: home.latitude, longitude: home.longitude } : null),
    [home],
  );

  const [title, setTitle] = useState('');
  const [date, setDate] = useState<string | undefined>(undefined);
  const [timed, setTimed] = useState(false);
  const [startD, setStartD] = useState<Date>(() => hhmmToDate(roundedNowHHMM()));
  // Minutes, or null for "Any length" (only offered for an untimed errand — a
  // timed one always resolves to a concrete duration so it has an end).
  const [durationMin, setDurationMin] = useState<number | null>(DEFAULT_DURATION);
  const [addr, setAddr] = useState<AddressValue | null>(null);
  const [notes, setNotes] = useState('');
  const [androidPicker, setAndroidPicker] = useState(false);
  // The horizontal day list + a map of each day chip's x-offset, so a (re)seed
  // can scroll the selected day into view — a parsed "the 15th" otherwise stays
  // selected but off-screen.
  const dateScrollRef = useRef<ScrollView>(null);
  const dateOffsetsRef = useRef<Map<string, number>>(new Map());

  // (Re)seed the form from the draft whenever the drawer opens, a parse
  // finishes, or a different errand is opened. We skip seeding mid-parse (the
  // form is hidden behind the reading state then), so user edits are never
  // clobbered by a late-arriving parse.
  useEffect(() => {
    if (!open || parsing) return;
    setTitle(draft.title ?? '');
    setDate(draft.date ?? undefined);
    setAddr(
      draft.address
        ? {
            label: draft.address,
            latitude: draft.latitude ?? undefined,
            longitude: draft.longitude ?? undefined,
            placeId: draft.placeId ?? undefined,
            photoUrl: draft.photoUrl ?? undefined,
            rating: draft.rating ?? undefined,
            ratingCount: draft.ratingCount ?? undefined,
            priceLevel: draft.priceLevel ?? undefined,
            openingHours: draft.openingHours ?? undefined,
          }
        : null,
    );
    setNotes(draft.notes ?? '');
    const hasTime = !!draft.startTime;
    setTimed(hasTime);
    if (hasTime) {
      const start = draft.startTime as string;
      setStartD(hhmmToDate(start));
      // Prefer a stored duration; else derive it from the AI's start/end window.
      setDurationMin(draft.durationMin ?? durationFromDraft(start, draft.endTime));
    } else {
      // Untimed: respect a stored estimate, otherwise default to "Any length".
      setDurationMin(draft.durationMin ?? null);
    }
    setAndroidPicker(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, parsing, seedKey]);

  // Bring the selected day chip into view after a (re)seed or a tap. A parsed
  // date like "the 15th" can land far down the horizontal list; without this the
  // chip reads as selected but is scrolled off-screen. We defer a beat so the
  // chip offsets (captured via onLayout) are measured first.
  useEffect(() => {
    if (!open || parsing) return;
    if (!date) {
      dateScrollRef.current?.scrollTo({ x: 0, animated: false });
      return;
    }
    const id = setTimeout(() => {
      const x = dateOffsetsRef.current.get(date);
      if (x != null) {
        dateScrollRef.current?.scrollTo({ x: Math.max(0, x - 12), animated: true });
      }
    }, 120);
    return () => clearTimeout(id);
  }, [open, parsing, seedKey, date]);

  const startTime = dateToHHMM(startD);
  const endTime =
    durationMin != null ? addMinutes(startTime, durationMin) : undefined;
  // Keep an exact (edited) duration selectable even when it isn't a preset.
  const durationOptions = useMemo(
    () =>
      durationMin == null || DURATION_CHOICES.includes(durationMin)
        ? DURATION_CHOICES
        : [...DURATION_CHOICES, durationMin].sort((a, b) => a - b),
    [durationMin],
  );

  const onToggleTimed = (next: boolean) => {
    Haptics.selectionAsync().catch(() => undefined);
    setTimed(next);
    if (next) {
      // Seed sensible defaults the first time the user opts into a time. A timed
      // errand needs a concrete length (so it has an end), so coerce away "Any
      // length" — but keep an estimate the user already picked while untimed.
      const seedStart = draft.startTime ?? roundedNowHHMM();
      setStartD(hhmmToDate(seedStart));
      setDurationMin(
        (cur) => cur ?? draft.durationMin ?? durationFromDraft(seedStart, draft.endTime),
      );
    }
    setAndroidPicker(false);
  };

  const onStartChange = (_: DateTimePickerEvent, picked?: Date) => {
    if (Platform.OS !== 'ios') setAndroidPicker(false);
    if (!picked) return;
    Haptics.selectionAsync().catch(() => undefined);
    setStartD(picked);
  };

  const canSave = title.trim().length > 0;

  const save = () => {
    if (!canSave) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
    onSave({
      title: title.trim(),
      date,
      startTime: timed ? startTime : undefined,
      endTime: timed ? endTime : undefined,
      // Persist the length estimate in BOTH modes (timed → mirrors the window;
      // anytime → the standalone "how long" the planner uses). null = no estimate.
      durationMin: durationMin ?? undefined,
      address: addr?.label,
      latitude: addr?.latitude ?? undefined,
      longitude: addr?.longitude ?? undefined,
      placeId: addr?.placeId ?? undefined,
      photoUrl: addr?.photoUrl ?? undefined,
      rating: addr?.rating ?? undefined,
      ratingCount: addr?.ratingCount ?? undefined,
      priceLevel: addr?.priceLevel ?? undefined,
      openingHours: addr?.openingHours ?? undefined,
      notes: notes.trim() || undefined,
      rawText,
    });
  };

  // Date chips: "Any day" + the next two weeks, plus the parsed date itself if
  // it falls outside that window (so a far-off pick still shows + stays
  // selected).
  const dayOptions = upcomingWeek(DAY_CHOICES);
  const extraDay =
    date && !dayOptions.some((d) => d.iso === date) ? describeDay(date) : null;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      heightFraction={0.99}
      enableContentPanningGesture={false}
    >
      <View style={styles.container}>
        <Animated.View entering={ENTER(0)} exiting={EXIT(0)} style={styles.header}>
          <View style={{ flex: 1 }}>
            <Text variant="micro" tone="tertiary" uppercase weight="bold">
              {mode === 'edit' ? 'Edit errand' : 'New errand'}
            </Text>
            <Text variant="title3" weight="bold" tight>
              {mode === 'edit' ? 'Update reminder' : 'Confirm reminder'}
            </Text>
          </View>
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
        </Animated.View>

        {parsing ? (
          <View style={styles.parsing}>
            <ActivityIndicator color={t.colors.accent} />
            <Text variant="body" weight="semibold" tone="secondary">
              Reading your errand…
            </Text>
            {rawText ? (
              <Text variant="caption" tone="tertiary" numberOfLines={2} style={styles.parsingRaw}>
                “{rawText}”
              </Text>
            ) : null}
          </View>
        ) : (
          <>
            <BottomSheetScrollView
              style={styles.scroll}
              contentContainerStyle={styles.body}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              {/* Title */}
              <Field icon="checkmark-circle-outline" label="What" index={1}>
                <BottomSheetTextInput
                  value={title}
                  onChangeText={setTitle}
                  placeholder="e.g. Call mom"
                  placeholderTextColor={t.colors.textTertiary}
                  style={[
                    styles.input,
                    styles.titleInput,
                    {
                      backgroundColor: t.colors.fill1,
                      borderColor: t.colors.separator,
                      color: t.colors.textPrimary,
                    },
                  ]}
                />
              </Field>

              {/* Date */}
              <Field icon="calendar-outline" label="When" index={2}>
                <ScrollView
                  ref={dateScrollRef}
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  keyboardShouldPersistTaps="handled"
                  contentContainerStyle={styles.chipRow}
                >
                  <SelectChip
                    label="Any day"
                    active={!date}
                    onPress={() => {
                      Haptics.selectionAsync().catch(() => undefined);
                      setDate(undefined);
                    }}
                  />
                  {extraDay ? (
                    <SelectChip
                      label={`${extraDay.title} · ${extraDay.dateLabel}`}
                      active
                      onPress={() => undefined}
                      onLayout={(e) => {
                        if (date) {
                          dateOffsetsRef.current.set(date, e.nativeEvent.layout.x);
                        }
                      }}
                    />
                  ) : null}
                  {dayOptions.map((d) => (
                    <SelectChip
                      key={d.iso}
                      label={
                        d.isToday
                          ? 'Today'
                          : d.isTomorrow
                          ? 'Tomorrow'
                          : `${d.weekdayShort} ${d.dayNum}`
                      }
                      active={date === d.iso}
                      onPress={() => {
                        Haptics.selectionAsync().catch(() => undefined);
                        setDate(d.iso);
                      }}
                      onLayout={(e) =>
                        dateOffsetsRef.current.set(d.iso, e.nativeEvent.layout.x)
                      }
                    />
                  ))}
                </ScrollView>
              </Field>

              {/* Time */}
              <Field icon="time-outline" label="Time" index={3}>
                <View style={styles.segment}>
                  <SelectChip
                    label="Anytime"
                    active={!timed}
                    onPress={() => onToggleTimed(false)}
                  />
                  <SelectChip
                    label="At a time"
                    active={timed}
                    onPress={() => onToggleTimed(true)}
                  />
                </View>
                {/* Start + duration. The start row only shows for a timed
                    errand; "How long" shows for both — for an untimed errand it's
                    an optional estimate the planner uses to reserve a slot. */}
                <View style={styles.timeRows}>
                  {timed ? (
                    <TimeRow
                      label="Starts"
                      value={startD}
                      display={formatTime(startTime)}
                      onChange={onStartChange}
                      onAndroidOpen={() => setAndroidPicker(true)}
                    />
                  ) : null}
                  <View
                    style={[
                      styles.durationHead,
                      { borderTopColor: t.colors.separator },
                    ]}
                  >
                    <Text variant="body" weight="semibold">
                      How long
                    </Text>
                    {timed && endTime ? (
                      <Text variant="bodySm" tone="secondary">
                        Ends {formatTime(endTime)}
                      </Text>
                    ) : null}
                  </View>
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    keyboardShouldPersistTaps="handled"
                    contentContainerStyle={styles.chipRow}
                  >
                    {!timed ? (
                      <SelectChip
                        label="Any length"
                        active={durationMin == null}
                        onPress={() => {
                          Haptics.selectionAsync().catch(() => undefined);
                          setDurationMin(null);
                        }}
                      />
                    ) : null}
                    {durationOptions.map((min) => (
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
                  {!timed ? (
                    <Text
                      variant="caption"
                      tone="tertiary"
                      style={styles.durationHint}
                    >
                      Optional — helps the planner set aside enough time.
                    </Text>
                  ) : null}
                </View>
              </Field>

              {/* Address — a live place picker, not a plain text box. On a
                  fresh parse it auto-searches the AI's guess so the user can
                  confirm/correct it; an already-pinned errand just rests. */}
              <Field icon="location-outline" label="Where" index={4}>
                <ErrandAddressField
                  value={addr}
                  center={center}
                  seedKey={seedKey}
                  seedQuery={
                    mode === 'create' && draft.latitude == null
                      ? draft.address
                      : null
                  }
                  dateISO={date}
                  startTime={timed ? startTime : undefined}
                  endTime={timed ? endTime : undefined}
                  onChange={setAddr}
                />
              </Field>

              {/* Notes — also handed to the planner when this errand is folded
                  into a day, so we call out the impact below the field. */}
              <Field icon="document-text-outline" label="Note" index={5}>
                <BottomSheetTextInput
                  value={notes}
                  onChangeText={setNotes}
                  placeholder="Optional — e.g. bring documents, flexible timing"
                  placeholderTextColor={t.colors.textTertiary}
                  style={[
                    styles.input,
                    {
                      backgroundColor: t.colors.fill1,
                      borderColor: t.colors.separator,
                      color: t.colors.textPrimary,
                    },
                  ]}
                />
                <View style={styles.noteHint}>
                  <Ionicons
                    name="sparkles-outline"
                    size={12}
                    color={t.colors.textTertiary}
                  />
                  <Text variant="caption" tone="tertiary" style={styles.noteHintText}>
                    The assistant reads this when you add the errand to a plan —
                    mention timing, priorities, or anything that should shape your day.
                  </Text>
                </View>
              </Field>

              {mode === 'edit' && onDelete ? (
                <Animated.View entering={ENTER(6)} exiting={EXIT(6)}>
                  <Pressable
                    onPress={() => {
                      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(
                        () => undefined,
                      );
                      onDelete();
                    }}
                    style={({ pressed }) => [styles.deleteRow, pressed && { opacity: 0.6 }]}
                  >
                    <Ionicons name="trash-outline" size={18} color={t.colors.danger} />
                    <Text variant="body" weight="semibold" style={{ color: t.colors.danger }}>
                      Delete errand
                    </Text>
                  </Pressable>
                </Animated.View>
              ) : null}
            </BottomSheetScrollView>

            <Animated.View
              entering={ENTER(6)}
              exiting={EXIT(6)}
              style={[
                styles.footer,
                {
                  paddingBottom: insets.bottom + 8,
                  borderTopColor: t.colors.separator,
                },
              ]}
            >
              <Button
                title={mode === 'edit' ? 'Save changes' : 'Save errand'}
                onPress={save}
                disabled={!canSave}
                fullWidth
                size="lg"
              />
            </Animated.View>
          </>
        )}

        {androidPicker && Platform.OS !== 'ios' ? (
          <DateTimePicker
            value={startD}
            mode="time"
            display="default"
            minuteInterval={5}
            onChange={onStartChange}
          />
        ) : null}
      </View>
    </Sheet>
  );
}

/**
 * A labelled section: small icon + caption header above its control. `index`
 * drives its place in the staggered intro; `layout` smooths the reflow when a
 * field grows (e.g. the Time section expanding) so the fields below glide.
 */
function Field({
  icon,
  label,
  index,
  children,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  index: number;
  children: React.ReactNode;
}) {
  const t = useTheme();
  return (
    <Animated.View
      entering={ENTER(index)}
      exiting={EXIT(index)}
      layout={LinearTransition.duration(220)}
      style={styles.field}
    >
      <View style={styles.fieldHead}>
        <Ionicons name={icon} size={15} color={t.colors.textSecondary} />
        <Text variant="caption" tone="secondary" weight="semibold">
          {label}
        </Text>
      </View>
      {children}
    </Animated.View>
  );
}

/** A selectable pill (date / time mode). */
function SelectChip({
  label,
  active,
  onPress,
  onLayout,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  onLayout?: (e: LayoutChangeEvent) => void;
}) {
  const t = useTheme();
  return (
    <Pressable
      onPress={onPress}
      onLayout={onLayout}
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

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scroll: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 8,
  },
  iconBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  parsing: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    paddingHorizontal: 32,
  },
  parsingRaw: {
    textAlign: 'center',
  },
  body: {
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 16,
    gap: 18,
  },
  field: {
    gap: 8,
  },
  fieldHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  input: {
    minHeight: 46,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
  },
  titleInput: {
    fontSize: 17,
    fontWeight: '600',
  },
  chipRow: {
    gap: 8,
    paddingRight: 8,
  },
  segment: {
    flexDirection: 'row',
    gap: 8,
  },
  chip: {
    height: 38,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  timeRows: {
    marginTop: 4,
  },
  timeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  durationHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 12,
    paddingBottom: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  durationHint: {
    paddingHorizontal: 2,
    paddingTop: 10,
  },
  noteHint: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    paddingHorizontal: 2,
  },
  noteHintText: {
    flex: 1,
  },
  timePill: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 999,
  },
  deleteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    marginTop: 4,
  },
  footer: {
    paddingHorizontal: 16,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
