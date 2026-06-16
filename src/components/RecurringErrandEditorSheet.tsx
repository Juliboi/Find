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
import { useHomeStore } from '@/store/useHomeStore';
import type {
  RecurringErrand,
  RecurringErrandInput,
} from '@/store/useRecurringErrandsStore';
import { formatTime, formatDuration, minutesOfDay } from '@/utils/time';
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

function hhmmToDate(hhmm: string): Date {
  const mins = minutesOfDay(hhmm) ?? 18 * 60;
  const d = new Date();
  d.setHours(Math.floor(mins / 60), mins % 60, 0, 0);
  return d;
}

function dateToHHMM(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function placeToValue(e: RecurringErrand | null | undefined): AddressValue | null {
  if (!e?.address) return null;
  return {
    label: e.address,
    latitude: e.latitude,
    longitude: e.longitude,
    placeId: e.placeId ?? null,
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
  const center = useMemo(
    () => (home ? { latitude: home.latitude, longitude: home.longitude } : null),
    [home],
  );

  const [title, setTitle] = useState('');
  const [weekdays, setWeekdays] = useState<number[]>([]);
  const [timed, setTimed] = useState(true);
  const [startD, setStartD] = useState<Date>(() => hhmmToDate('18:00'));
  const [durationMin, setDurationMin] = useState<number | null>(DEFAULT_DURATION);
  const [addr, setAddr] = useState<AddressValue | null>(null);
  const [autoPlace, setAutoPlace] = useState(false);
  const [placeQuery, setPlaceQuery] = useState<string | undefined>(undefined);
  const [notes, setNotes] = useState('');
  const [androidPicker, setAndroidPicker] = useState(false);

  const seedKey = `rcr-${errand?.id ?? 'new'}-${open ? 'open' : 'closed'}`;
  useEffect(() => {
    if (!open) return;
    setTitle(errand?.title ?? '');
    setWeekdays(errand?.weekdays ?? []);
    const hasTime = !!errand?.startTime;
    setTimed(errand ? hasTime : true);
    setStartD(hhmmToDate(errand?.startTime ?? roundedNowHHMM()));
    setDurationMin(errand?.durationMin ?? (hasTime || !errand ? DEFAULT_DURATION : null));
    setAddr(placeToValue(errand));
    setAutoPlace(!!errand?.autoPlace);
    setPlaceQuery(errand?.placeQuery ?? undefined);
    setNotes(errand?.notes ?? '');
    setAndroidPicker(false);
  }, [open, errand]);

  const startTime = dateToHHMM(startD);
  const canSave = title.trim().length > 0 && weekdays.length > 0;

  const toggleWeekday = (num: number) => {
    Haptics.selectionAsync().catch(() => undefined);
    setWeekdays((prev) =>
      prev.includes(num) ? prev.filter((d) => d !== num) : [...prev, num],
    );
  };

  const onStartChange = (event: DateTimePickerEvent, selected?: Date) => {
    if (Platform.OS !== 'ios') setAndroidPicker(false);
    if (event.type === 'dismissed') return;
    if (selected) setStartD(selected);
  };

  const save = () => {
    if (!canSave) return;
    Haptics.selectionAsync().catch(() => undefined);
    onSubmit({
      title: title.trim(),
      weekdays,
      startTime: timed ? startTime : undefined,
      durationMin: durationMin ?? undefined,
      address: autoPlace ? undefined : addr?.label,
      latitude: autoPlace ? undefined : addr?.latitude,
      longitude: autoPlace ? undefined : addr?.longitude,
      placeId: autoPlace ? undefined : addr?.placeId ?? undefined,
      autoPlace: autoPlace || undefined,
      placeQuery: autoPlace ? placeQuery ?? title.trim() : undefined,
      notes: notes.trim() ? notes.trim() : undefined,
    });
    onClose();
  };

  return (
    <Sheet open={open} onClose={onClose} heightFraction={0.92} enableContentPanningGesture={false}>
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
            <SelectChip label="Anytime" active={!timed} onPress={() => setTimed(false)} />
            <SelectChip label="At a time" active={timed} onPress={() => setTimed(true)} />
          </View>
          {timed ? (
            <View style={[styles.timeRow, { borderTopColor: t.colors.separator }]}>
              <Text variant="body" weight="semibold">
                Starts
              </Text>
              {Platform.OS === 'ios' ? (
                <DateTimePicker
                  value={startD}
                  mode="time"
                  display="compact"
                  minuteInterval={5}
                  onChange={onStartChange}
                  themeVariant={t.isDark ? 'dark' : 'light'}
                />
              ) : (
                <Pressable
                  onPress={() => {
                    Haptics.selectionAsync().catch(() => undefined);
                    setAndroidPicker(true);
                  }}
                  style={[styles.timePill, { backgroundColor: t.colors.fill1 }]}
                >
                  <Text variant="body" weight="bold" tone="accent">
                    {formatTime(startTime)}
                  </Text>
                </Pressable>
              )}
            </View>
          ) : null}
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

          <FieldLabel icon="location-outline" label="Where" />
          {autoPlace ? (
            <View
              style={[
                styles.autoPlaceCard,
                { backgroundColor: t.colors.accentSoft, borderColor: t.colors.separator },
              ]}
            >
              <View style={styles.autoPlaceHead}>
                <Ionicons name="sparkles" size={15} color={t.colors.accent} />
                <Text variant="body" weight="semibold" tone="accent">
                  Diem will pick the spot
                </Text>
              </View>
              <Pressable
                onPress={() => {
                  Haptics.selectionAsync().catch(() => undefined);
                  setAutoPlace(false);
                }}
                hitSlop={8}
                style={styles.autoPlaceSwitch}
              >
                <Ionicons name="location-outline" size={13} color={t.colors.accent} />
                <Text variant="bodySm" weight="semibold" tone="accent">
                  Pick a specific place instead
                </Text>
              </Pressable>
            </View>
          ) : (
            <>
              <ErrandAddressField
                value={addr}
                center={center}
                seedKey={seedKey}
                onChange={setAddr}
              />
              <Pressable
                onPress={() => {
                  Haptics.selectionAsync().catch(() => undefined);
                  setAddr(null);
                  setPlaceQuery((q) => q ?? (title.trim() || undefined));
                  setAutoPlace(true);
                }}
                hitSlop={8}
                style={styles.autoPlaceSwitch}
              >
                <Ionicons name="sparkles-outline" size={13} color={t.colors.accent} />
                <Text variant="bodySm" weight="semibold" tone="accent">
                  Let Diem find it for me
                </Text>
              </Pressable>
            </>
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

      {androidPicker && Platform.OS !== 'ios' ? (
        <DateTimePicker
          value={startD}
          mode="time"
          display="default"
          minuteInterval={5}
          onChange={onStartChange}
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
    paddingTop: 12,
  },
  timePill: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 10,
  },
  autoPlaceCard: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 14,
    gap: 8,
  },
  autoPlaceHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  autoPlaceSwitch: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 6,
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
