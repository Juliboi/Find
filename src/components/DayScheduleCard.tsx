import React, { useMemo } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/theme/useTheme';
import { Text } from './Text';
import { GlassSurface } from './Glass';
import { useErrandsStore } from '@/store/useErrandsStore';
import { useSavedItineraries, activePlanForDate } from '@/store/useSavedItineraries';
import {
  buildDayCalendar,
  contentWindow,
  type CalEvent,
} from '@/lib/calendar/dayCalendar';
import { dayErrandsWithPlan } from '@/lib/calendar/planProjection';
import { currentHHMM, formatTime, minutesOfDay } from '@/utils/time';
import { describeDay } from '@/utils/days';

interface Props {
  /** The day to preview ("YYYY-MM-DD"). */
  date: string;
  /** The user's today, for the live "now" marker. */
  today: string;
  /** Open the full day calendar. */
  onPress: () => void;
  style?: StyleProp<ViewStyle>;
}

const MINI_HEIGHT = 132;
const MINI_GUTTER = 4;

/**
 * Homepage "calendar widget": a glass card previewing the focused day as a
 * miniature timeline of its timed errands, with the unscheduled count + plan
 * surfaced beneath. Tapping opens the full day calendar. Renders nothing when
 * the day has no errands at all (the home screen's other affordances cover the
 * empty case), so it only appears when there's actually a day to glance at.
 */
export function DayScheduleCard({ date, today, onPress, style }: Props) {
  const t = useTheme();
  const errands = useErrandsStore((s) => s.items);
  const savedTrips = useSavedItineraries((s) => s.items);

  const { timed, untimed } = useMemo(
    () => buildDayCalendar(dayErrandsWithPlan(savedTrips, date, errands), date),
    [errands, savedTrips, date],
  );
  const plan = useMemo(
    () => activePlanForDate(savedTrips, date),
    [savedTrips, date],
  );

  const isToday = date === today;
  const nowMin = isToday ? minutesOfDay(currentHHMM()) : null;
  const dayTitle = describeDay(date).title;

  if (timed.length === 0 && untimed.length === 0) return null;

  const summary: string[] = [];
  if (timed.length > 0) summary.push(`${timed.length} timed`);
  if (untimed.length > 0) summary.push(`${untimed.length} unscheduled`);
  if (plan) summary.push('1 plan');

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Open the calendar for ${dayTitle}`}
      style={({ pressed }) => [
        style,
        pressed && { opacity: 0.9, transform: [{ scale: 0.99 }] },
      ]}
    >
      <GlassSurface
        variant="regular"
        radius={t.radii.xl}
        style={[styles.card, { shadowColor: t.colors.shadow }]}
        innerStyle={styles.cardInner}
      >
        <View style={styles.header}>
          <View style={[styles.icon, { backgroundColor: t.colors.accentSoft }]}>
            <Ionicons name="calendar-outline" size={18} color={t.colors.accentText} />
          </View>
          <View style={styles.headerText}>
            <Text variant="micro" uppercase weight="bold" tone="accent">
              Schedule
            </Text>
            <Text variant="body" weight="semibold" numberOfLines={1}>
              {`${dayTitle}\u2019s timeline`}
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={t.colors.textTertiary} />
        </View>

        {timed.length > 0 ? (
          <MiniTimeline events={timed} nowMin={nowMin} />
        ) : (
          <View style={[styles.empty, { backgroundColor: t.colors.fill1 }]}>
            <Ionicons name="time-outline" size={18} color={t.colors.textTertiary} />
            <Text variant="caption" tone="secondary" style={styles.emptyText}>
              {untimed.length === 1
                ? '1 reminder with no set time — tap to place it on your day.'
                : `${untimed.length} reminders with no set time — tap to place them on your day.`}
            </Text>
          </View>
        )}

        <View style={[styles.footer, { borderTopColor: t.colors.separator }]}>
          <Text variant="caption" tone="secondary" numberOfLines={1}>
            {summary.join('  ·  ')}
          </Text>
          <View style={styles.footerCta}>
            <Text variant="caption" weight="semibold" tone="accent">
              View day
            </Text>
          </View>
        </View>
      </GlassSurface>
    </Pressable>
  );
}

/**
 * A scaled-down timeline hugging just the events' span. Same overlap columns as
 * the full view, sized to a fixed card height so a packed day and a single
 * block both read at a glance.
 */
function MiniTimeline({
  events,
  nowMin,
}: {
  events: CalEvent[];
  nowMin: number | null;
}) {
  const t = useTheme();
  const win = contentWindow(events);
  if (!win) return null;

  const span = Math.max(60, win.endMin - win.startMin);
  const pxPerMin = MINI_HEIGHT / span;

  const firstHour = Math.ceil(win.startMin / 60);
  const lastHour = Math.floor(win.endMin / 60);
  const spanHours = lastHour - firstHour;
  const step = spanHours > 6 ? 3 : spanHours > 3 ? 2 : 1;
  const lines: number[] = [];
  for (let h = firstHour; h <= lastHour; h += step) lines.push(h);

  const showNow = nowMin != null && nowMin >= win.startMin && nowMin <= win.endMin;

  return (
    <View style={[styles.mini, { height: MINI_HEIGHT }]}>
      {lines.map((h) => {
        const y = (h * 60 - win.startMin) * pxPerMin;
        return (
          <View
            key={`line-${h}`}
            pointerEvents="none"
            style={[styles.miniLine, { top: y, backgroundColor: t.colors.separator }]}
          />
        );
      })}
      {lines.map((h) => {
        const y = (h * 60 - win.startMin) * pxPerMin;
        return (
          <Text
            key={`label-${h}`}
            variant="micro"
            tone="tertiary"
            pointerEvents="none"
            style={[styles.miniHour, { top: Math.max(0, y - 6) }]}
          >
            {formatTime(`${String(h).padStart(2, '0')}:00`).replace(':00', '')}
          </Text>
        );
      })}

      {showNow ? (
        <View
          style={[
            styles.miniNow,
            { top: (nowMin! - win.startMin) * pxPerMin, backgroundColor: t.colors.danger },
          ]}
          pointerEvents="none"
        />
      ) : null}

      <View style={styles.miniLane}>
        {events.map((ev) => {
          const top = (ev.startMin - win.startMin) * pxPerMin;
          const h = Math.max(12, (ev.endMin - ev.startMin) * pxPerMin - 2);
          const widthPct = 100 / ev.cols;
          return (
            <View
              key={ev.id}
              style={[
                styles.miniBlock,
                {
                  top,
                  height: h,
                  left: `${ev.col * widthPct}%`,
                  width: `${widthPct}%`,
                },
              ]}
            >
              <View
                style={[
                  styles.miniBlockInner,
                  ev.errand.planRef
                    ? {
                        backgroundColor: 'rgba(175, 82, 222, 0.16)',
                        borderColor: t.colors.highlightPurple,
                        borderWidth: StyleSheet.hairlineWidth,
                        borderStyle: 'solid',
                      }
                    : {
                        backgroundColor: ev.flexible ? 'transparent' : t.colors.accentSoft,
                        borderColor: t.colors.accent,
                        borderWidth: ev.flexible ? StyleSheet.hairlineWidth : 0,
                        borderStyle: ev.flexible ? 'dashed' : 'solid',
                      },
                ]}
              >
                <View
                  style={[
                    styles.miniBlockBar,
                    { backgroundColor: ev.errand.planRef ? t.colors.highlightPurple : t.colors.accent },
                  ]}
                />
                {h >= 16 ? (
                  <Text
                    variant="micro"
                    weight="semibold"
                    numberOfLines={1}
                    style={[
                      styles.miniBlockText,
                      { color: ev.errand.planRef ? t.colors.textPrimary : t.colors.accentText },
                    ]}
                  >
                    {ev.errand.title}
                  </Text>
                ) : null}
              </View>
            </View>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.18,
    shadowRadius: 22,
    elevation: 8,
  },
  cardInner: {
    padding: 16,
    gap: 14,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  icon: {
    width: 38,
    height: 38,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerText: {
    flex: 1,
    gap: 1,
  },
  empty: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 14,
    borderRadius: 14,
  },
  emptyText: {
    flex: 1,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 12,
  },
  footerCta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  mini: {
    position: 'relative',
  },
  miniHour: {
    position: 'absolute',
    left: 0,
    width: 30,
    textAlign: 'right',
    fontVariant: ['tabular-nums'],
  },
  miniLine: {
    position: 'absolute',
    left: 36,
    right: 0,
    height: StyleSheet.hairlineWidth,
  },
  miniNow: {
    position: 'absolute',
    left: 36,
    right: 0,
    height: 1.5,
    zIndex: 5,
  },
  miniLane: {
    position: 'absolute',
    left: 36 + MINI_GUTTER,
    right: 0,
    top: 0,
    bottom: 0,
  },
  miniBlock: {
    position: 'absolute',
    paddingRight: 3,
  },
  miniBlockInner: {
    flex: 1,
    flexDirection: 'row',
    borderRadius: 6,
    overflow: 'hidden',
    alignItems: 'stretch',
  },
  miniBlockBar: {
    width: 2.5,
  },
  miniBlockText: {
    flex: 1,
    paddingHorizontal: 5,
    paddingTop: 1,
  },
});
