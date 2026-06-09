import React, { useEffect, useMemo, useState } from 'react';
import { Platform, Pressable, StyleSheet, Switch, View } from 'react-native';
import DateTimePicker, {
  type DateTimePickerEvent,
} from '@react-native-community/datetimepicker';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { useTheme } from '@/theme/useTheme';
import { Sheet } from './Sheet';
import { WheelPicker, type WheelOption } from './WheelPicker';
import { Text } from './Text';
import { Button } from './Button';
import { upcomingWeek, roundedNowHHMM } from '@/utils/days';
import { usePlanSetupStore } from '@/store/usePlanSetupStore';
import { useProfileStore } from '@/store/useProfileStore';
import { formatTime, minutesOfDay } from '@/utils/time';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Called with the chosen day ("YYYY-MM-DD") + start time ("HH:MM"). */
  onConfirm: (date: string, startTime: string) => void;
  /** Seed the wheel to this day (defaults to today). */
  initialDate?: string;
  /** Seed the time selector to this value (defaults to the day's default). */
  initialTime?: string;
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

/**
 * The "when's your day?" drawer. A big day-of-week wheel (today first, the rest
 * of the week following) paired with a start-time selector, confirmed with one
 * tap. Picking today seeds the time to "now"; any future day seeds to the
 * configured day-start, since a future day has no live clock to anchor to.
 *
 * The chosen day + time are handed back via `onConfirm` for the caller to store
 * and route into the planner.
 */
export function PlanSetupSheet({
  open,
  onClose,
  onConfirm,
  initialDate,
  initialTime,
}: Props) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const dayStartTime = usePlanSetupStore((s) => s.dayStartTime);
  const hasCar = useProfileStore((s) => s.hasCar);
  const useCarToday = usePlanSetupStore((s) => s.useCarToday);
  const setUseCarToday = usePlanSetupStore((s) => s.setUseCarToday);

  // The week is held in state and refreshed each time the sheet opens, so
  // "today" stays correct across a midnight rollover while the app sits
  // backgrounded.
  const [days, setDays] = useState(() => upcomingWeek(DAY_COUNT));
  const [dayIndex, setDayIndex] = useState(0);
  const [time, setTime] = useState<Date>(() => hhmmToDate(roundedNowHHMM()));
  const [androidPickerOpen, setAndroidPickerOpen] = useState(false);

  const defaultTimeForDay = (i: number): string =>
    days[i]?.isToday ? roundedNowHHMM() : dayStartTime;

  // (Re)seed the week + selection whenever the sheet is opened.
  useEffect(() => {
    if (!open) return;
    const fresh = upcomingWeek(DAY_COUNT);
    setDays(fresh);
    const found = initialDate ? fresh.findIndex((d) => d.iso === initialDate) : 0;
    const idx = found >= 0 ? found : 0;
    setDayIndex(idx);
    const seedTime = initialTime ?? (fresh[idx]?.isToday ? roundedNowHHMM() : dayStartTime);
    setTime(hhmmToDate(seedTime));
    setAndroidPickerOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const onDayChange = (i: number) => {
    setDayIndex(i);
    // A day switch resets the time to that day's sensible default — "now" for
    // today, the day-start otherwise.
    setTime(hhmmToDate(defaultTimeForDay(i)));
  };

  const onTimeChange = (_: DateTimePickerEvent, picked?: Date) => {
    if (Platform.OS !== 'ios') setAndroidPickerOpen(false);
    if (picked) setTime(picked);
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
  const startTime = dateToHHMM(time);

  const confirm = () => {
    if (!selected) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
    onConfirm(selected.iso, startTime);
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      heightFraction={0.975}
      enableContentPanningGesture={false}
    >
      <View style={[styles.container, { paddingBottom: insets.bottom + 4 }]}>
        <View style={styles.header}>
          <View style={{ flex: 1 }}>
            <Text variant="micro" tone="tertiary" uppercase weight="bold">
              Plan a day
            </Text>
            <Text variant="title3" weight="bold" tight>
              When&rsquo;s your day?
            </Text>
          </View>
          <Pressable
            onPress={onClose}
            hitSlop={10}
            style={[styles.close, { backgroundColor: t.colors.fill1 }]}
            accessibilityLabel="Close"
          >
            <Ionicons name="close" size={18} color={t.colors.textSecondary} />
          </Pressable>
        </View>

        <View style={styles.wheelWrap}>
          <WheelPicker
            options={options}
            selectedIndex={dayIndex}
            onChange={onDayChange}
            itemHeight={84}
            visibleCount={5}
            labelStyle={styles.wheelLabel}
            sublabelStyle={styles.wheelSublabel}
          />
        </View>

        <View style={[styles.timeRow, { borderTopColor: t.colors.separator }]}>
          <View style={styles.timeLabel}>
            <Ionicons name="time-outline" size={18} color={t.colors.textSecondary} />
            <View>
              <Text variant="body" weight="semibold">
                Start time
              </Text>
              <Text variant="caption" tone="tertiary">
                {selected?.isToday ? 'Defaults to now' : 'Defaults to your day start'}
              </Text>
            </View>
          </View>
          {Platform.OS === 'ios' ? (
            <DateTimePicker
              value={time}
              mode="time"
              display="compact"
              minuteInterval={5}
              onChange={onTimeChange}
              themeVariant={t.isDark ? 'dark' : 'light'}
            />
          ) : (
            <Pressable
              onPress={() => setAndroidPickerOpen(true)}
              style={[styles.timePill, { backgroundColor: t.colors.fill1 }]}
            >
              <Text variant="body" weight="bold" tone="accent">
                {formatTime(startTime)}
              </Text>
            </Pressable>
          )}
        </View>

        {androidPickerOpen && Platform.OS !== 'ios' ? (
          <DateTimePicker
            value={time}
            mode="time"
            display="default"
            minuteInterval={5}
            onChange={onTimeChange}
          />
        ) : null}

        {hasCar ? (
          <View style={[styles.carRow, { borderTopColor: t.colors.separator }]}>
            <View style={styles.carLabel}>
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
                    ? 'Driven only when it helps — park back home anytime'
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
          </View>
        ) : null}

        <View style={styles.footer}>
          <Text variant="caption" tone="secondary" style={styles.summary}>
            {selected
              ? `${selected.title}, ${selected.dateLabel} · starts ${formatTime(startTime)}`
              : ''}
          </Text>
          <Button title="Confirm" onPress={confirm} fullWidth size="lg" />
        </View>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  container: {
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
  close: {
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
  timeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingVertical: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  timeLabel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  carRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingVertical: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  carLabel: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  timePill: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 12,
  },
  footer: {
    paddingTop: 6,
  },
  summary: {
    textAlign: 'center',
    marginBottom: 10,
  },
});
