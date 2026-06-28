import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useTheme } from '@/theme/useTheme';
import { Text } from './Text';
import { hourLabel, type CalEvent } from '@/lib/calendar/dayCalendar';
import type { Errand } from '@/store/useErrandsStore';

/** One day column in the week grid: its label bits plus its packed events. */
export interface WeekDay {
  iso: string;
  /** "Mon" */
  weekdayShort: string;
  dayNum: number;
  isToday: boolean;
  events: CalEvent[];
}

const LABEL_H = 14;
const MIN_BLOCK_H = 14;

/**
 * The sticky top row of the week view: a weekday + date cell per column, with
 * today filled and the focused day outlined. Tapping a cell drills into that
 * day. Shares `gutter`/`colW` with {@link WeekGrid} so the columns line up.
 */
export function WeekHeader({
  days,
  gutter,
  colW,
  selectedDate,
  onPressDay,
}: {
  days: WeekDay[];
  gutter: number;
  colW: number;
  selectedDate: string;
  onPressDay: (iso: string) => void;
}) {
  const t = useTheme();
  return (
    <View style={[styles.header, { backgroundColor: t.colors.background, borderBottomColor: t.colors.separator }]}>
      <View style={{ width: gutter }} />
      {days.map((d) => {
        const selected = d.iso === selectedDate;
        return (
          <Pressable
            key={d.iso}
            onPress={() => onPressDay(d.iso)}
            accessibilityRole="button"
            accessibilityLabel={`${d.weekdayShort} ${d.dayNum}`}
            style={[styles.headCell, { width: colW }]}
          >
            <Text
              variant="micro"
              uppercase
              weight="bold"
              tone={selected || d.isToday ? 'accent' : 'tertiary'}
            >
              {d.weekdayShort}
            </Text>
            <View
              style={[
                styles.headNum,
                d.isToday && { backgroundColor: t.colors.accent },
                !d.isToday && selected && {
                  borderWidth: 1.5,
                  borderColor: t.colors.accent,
                },
              ]}
            >
              <Text
                variant="bodySm"
                weight="bold"
                style={{
                  color: d.isToday ? t.colors.textOnAccent : t.colors.textPrimary,
                }}
              >
                {d.dayNum}
              </Text>
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * The scrollable body of the week view: a shared hour gutter on the left, then
 * seven day columns with horizontal hour gridlines, vertical column dividers,
 * compact event blocks, and a "now" line drawn only in today's column.
 */
export function WeekGrid({
  days,
  gutter,
  colW,
  startMin,
  endMin,
  hourHeight,
  nowMin,
  todayIndex,
  onPressEvent,
}: {
  days: WeekDay[];
  gutter: number;
  colW: number;
  startMin: number;
  endMin: number;
  hourHeight: number;
  nowMin: number | null;
  todayIndex: number;
  onPressEvent?: (errand: Errand) => void;
}) {
  const t = useTheme();
  const pxPerMin = hourHeight / 60;
  const totalMin = Math.max(60, endMin - startMin);
  const height = totalMin * pxPerMin;

  const firstHour = Math.ceil(startMin / 60);
  const lastHour = Math.floor(endMin / 60);
  const hours: number[] = [];
  for (let h = firstHour; h <= lastHour; h += 1) hours.push(h);

  const showNow =
    nowMin != null && todayIndex >= 0 && nowMin >= startMin && nowMin <= endMin;
  const nowTop = showNow ? (nowMin! - startMin) * pxPerMin : 0;

  return (
    <View style={{ height }}>
      {/* Hour gridlines + labels */}
      {hours.map((h) => {
        const y = (h * 60 - startMin) * pxPerMin;
        return (
          <View
            key={`line-${h}`}
            pointerEvents="none"
            style={[styles.hourLine, { top: y, left: gutter, backgroundColor: t.colors.separator }]}
          />
        );
      })}
      {hours.map((h) => {
        const y = (h * 60 - startMin) * pxPerMin;
        return (
          <Text
            key={`label-${h}`}
            variant="micro"
            tone="secondary"
            weight="semibold"
            pointerEvents="none"
            style={[styles.hourLabel, { top: Math.max(0, y - LABEL_H / 2), width: gutter - 8 }]}
          >
            {hourLabel(h)}
          </Text>
        );
      })}

      {/* Column dividers */}
      {days.map((d, i) =>
        i === 0 ? null : (
          <View
            key={`sep-${d.iso}`}
            pointerEvents="none"
            style={[styles.colSep, { left: gutter + i * colW, backgroundColor: t.colors.separator }]}
          />
        ),
      )}

      {/* Now line — only in today's column */}
      {showNow ? (
        <>
          <View
            pointerEvents="none"
            style={[
              styles.nowLine,
              {
                top: nowTop - 0.75,
                left: gutter + todayIndex * colW,
                width: colW,
                backgroundColor: t.colors.danger,
              },
            ]}
          />
          <View
            pointerEvents="none"
            style={[
              styles.nowDot,
              { top: nowTop - 3, left: gutter + todayIndex * colW - 3, backgroundColor: t.colors.danger },
            ]}
          />
        </>
      ) : null}

      {/* Event blocks */}
      {days.map((d, di) =>
        d.events.map((ev) => {
          const top = (ev.startMin - startMin) * pxPerMin;
          const h = Math.max(MIN_BLOCK_H, (ev.endMin - ev.startMin) * pxPerMin);
          const subW = colW / ev.cols;
          const left = gutter + di * colW + ev.col * subW;
          return (
            <WeekBlock
              key={ev.id}
              event={ev}
              top={top}
              height={h}
              left={left + 1}
              width={subW - 2}
              onPress={onPressEvent}
            />
          );
        }),
      )}
    </View>
  );
}

function WeekBlock({
  event,
  top,
  height,
  left,
  width,
  onPress,
}: {
  event: CalEvent;
  top: number;
  height: number;
  left: number;
  width: number;
  onPress?: (errand: Errand) => void;
}) {
  const t = useTheme();
  const { errand, flexible } = event;
  const isPlan = errand.planRef != null;
  const showTitle = height >= 22 && width >= 26;
  return (
    <Pressable
      onPress={onPress ? () => onPress(errand) : undefined}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={errand.title}
      style={({ pressed }) => [
        styles.block,
        isPlan
          ? {
              top,
              left,
              width,
              height: Math.max(12, height - 1),
              backgroundColor: 'rgba(175, 82, 222, 0.16)',
              borderColor: t.colors.highlightPurple,
              borderWidth: StyleSheet.hairlineWidth,
              borderStyle: 'solid',
            }
          : {
              top,
              left,
              width,
              height: Math.max(12, height - 1),
              backgroundColor: flexible ? 'transparent' : t.colors.accentSoft,
              borderColor: t.colors.accent,
              borderWidth: flexible ? StyleSheet.hairlineWidth : 0,
              borderStyle: flexible ? 'dashed' : 'solid',
            },
        pressed && { opacity: 0.7 },
      ]}
    >
      <View
        style={[
          styles.blockBar,
          { backgroundColor: isPlan ? t.colors.highlightPurple : t.colors.accent },
        ]}
      />
      {showTitle ? (
        <Text
          variant="micro"
          weight="semibold"
          numberOfLines={3}
          style={[
            styles.blockText,
            { color: isPlan ? t.colors.textPrimary : t.colors.accentText },
          ]}
        >
          {errand.title}
        </Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingTop: 2,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headCell: {
    alignItems: 'center',
    gap: 3,
  },
  headNum: {
    minWidth: 26,
    height: 26,
    borderRadius: 13,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  hourLabel: {
    position: 'absolute',
    left: 0,
    textAlign: 'right',
    fontVariant: ['tabular-nums'],
  },
  hourLine: {
    position: 'absolute',
    right: 0,
    height: StyleSheet.hairlineWidth,
  },
  colSep: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: StyleSheet.hairlineWidth,
  },
  nowLine: {
    position: 'absolute',
    height: 1.5,
    zIndex: 5,
  },
  nowDot: {
    position: 'absolute',
    width: 6,
    height: 6,
    borderRadius: 3,
    zIndex: 6,
  },
  block: {
    position: 'absolute',
    borderRadius: 5,
    overflow: 'hidden',
    flexDirection: 'row',
  },
  blockBar: {
    width: 2.5,
  },
  blockText: {
    flex: 1,
    paddingHorizontal: 3,
    paddingTop: 1,
    fontSize: 9,
    lineHeight: 11,
  },
});
