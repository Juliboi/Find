import React, { useState } from 'react';
import {
  Image,
  LayoutChangeEvent,
  Pressable,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/theme/useTheme';
import { Text } from './Text';
import { hourLabel, type CalEvent } from '@/lib/calendar/dayCalendar';
import type { Errand } from '@/store/useErrandsStore';
import { formatTime } from '@/utils/time';

interface Props {
  /** Overlap-packed timed events to lay out (see `buildDayCalendar`). */
  events: CalEvent[];
  /** Visible window, minutes from midnight (see `dayWindow`). */
  startMin: number;
  endMin: number;
  /** Pixels per hour. Defaults to 64. */
  hourHeight?: number;
  /** Current time (minutes from midnight) to draw the "now" line, or null. */
  nowMin?: number | null;
  /** Tap a block to open it (e.g. the edit drawer). */
  onPressEvent?: (errand: Errand) => void;
  style?: StyleProp<ViewStyle>;
}

const GUTTER_W = 56;
const BLOCK_GAP = 4;
// Tall enough that even a short errand fits a one-line title + a full time line.
const MIN_BLOCK_H = 44;
const LABEL_H = 14;
// Fixed thumbnail edge (~two title lines tall) so every block's image matches.
const THUMB = 36;

/**
 * A vertical day timeline: an hour gutter with gridlines, timed errands drawn
 * as absolutely-positioned blocks (overlaps split into side-by-side columns),
 * and an optional "now" line. The host sizes/scrolls it; this view is exactly
 * `(endMin − startMin)` tall at `hourHeight` per hour.
 *
 * Geometry is intentionally simple and declarative so a later drag-to-schedule
 * pass can map a drop's Y back to a minute with the same `pxPerMin`.
 */
export function DayTimeline({
  events,
  startMin,
  endMin,
  hourHeight = 64,
  nowMin,
  onPressEvent,
  style,
}: Props) {
  const t = useTheme();
  const [width, setWidth] = useState(0);

  const pxPerMin = hourHeight / 60;
  const totalMin = Math.max(60, endMin - startMin);
  const height = totalMin * pxPerMin;
  const laneW = Math.max(0, width - GUTTER_W);

  const firstHour = Math.ceil(startMin / 60);
  const lastHour = Math.floor(endMin / 60);
  const hours: number[] = [];
  for (let h = firstHour; h <= lastHour; h += 1) hours.push(h);

  const showNow =
    nowMin != null && nowMin >= startMin && nowMin <= endMin;
  const nowTop = showNow ? (nowMin! - startMin) * pxPerMin : 0;

  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);

  return (
    <View style={[{ height }, style]} onLayout={onLayout}>
      {/* Hour gridlines */}
      {hours.map((h) => {
        const y = (h * 60 - startMin) * pxPerMin;
        return (
          <View
            key={`line-${h}`}
            pointerEvents="none"
            style={[styles.hourLine, { top: y, backgroundColor: t.colors.separator }]}
          />
        );
      })}

      {/* Hour labels (left gutter) */}
      {hours.map((h) => {
        const y = (h * 60 - startMin) * pxPerMin;
        return (
          <Text
            key={`label-${h}`}
            variant="micro"
            tone="secondary"
            weight="semibold"
            pointerEvents="none"
            style={[styles.hourLabel, { top: Math.max(0, y - LABEL_H / 2) }]}
          >
            {hourLabel(h)}
          </Text>
        );
      })}

      {/* Now line */}
      {showNow ? (
        <>
          <View
            pointerEvents="none"
            style={[styles.nowLine, { top: nowTop - 0.75, backgroundColor: t.colors.danger }]}
          />
          <View
            pointerEvents="none"
            style={[styles.nowDot, { top: nowTop - 4, backgroundColor: t.colors.danger }]}
          />
        </>
      ) : null}

      {/* Event blocks — only once we know the lane width */}
      {laneW > 0
        ? events.map((ev) => {
            const top = (ev.startMin - startMin) * pxPerMin;
            const h = Math.max(
              MIN_BLOCK_H,
              (ev.endMin - ev.startMin) * pxPerMin,
            );
            const colW = laneW / ev.cols;
            const left = GUTTER_W + ev.col * colW + BLOCK_GAP;
            const blockW = colW - BLOCK_GAP * 2;
            return (
              <EventBlock
                key={ev.id}
                event={ev}
                top={top}
                height={h}
                left={left}
                width={blockW}
                onPress={onPressEvent}
              />
            );
          })
        : null}
    </View>
  );
}

function EventBlock({
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
  const { errand, flexible, recurring } = event;
  const located = errand.latitude != null && errand.longitude != null;
  // Two-line titles only on taller blocks; the time range below always gets its
  // own full-width line so it's never truncated by the thumbnail beside it.
  const titleLines = height >= 70 ? 2 : 1;
  // Reuse the errand's place photo as a fixed-size thumbnail beside the title,
  // shown only where the block is tall + wide enough to keep text readable.
  const photo = errand.photoUrl;
  const showImage = !!photo && height >= 64 && width >= 120;

  const timeText = errand.endTime
    ? `${formatTime(errand.startTime)} – ${formatTime(errand.endTime)}`
    : formatTime(errand.startTime);

  return (
    <Pressable
      onPress={onPress ? () => onPress(errand) : undefined}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={`${errand.title}, ${timeText}`}
      style={({ pressed }) => [
        styles.block,
        {
          top,
          left,
          width,
          height: height - BLOCK_GAP,
          backgroundColor: flexible ? 'transparent' : t.colors.accentSoft,
          borderColor: t.colors.accent,
          borderStyle: flexible ? 'dashed' : 'solid',
          borderWidth: flexible ? StyleSheet.hairlineWidth : 0,
        },
        pressed && { opacity: 0.7 },
      ]}
    >
      <View style={[styles.blockBar, { backgroundColor: t.colors.accent }]} />
      <View style={styles.blockBody}>
        <View style={styles.blockHeader}>
          <View style={styles.blockTitleRow}>
            <Text
              variant="caption"
              weight="bold"
              numberOfLines={titleLines}
              style={[styles.blockTitle, { color: t.colors.accentText }]}
            >
              {errand.title}
            </Text>
            {recurring ? (
              <Ionicons name="repeat" size={11} color={t.colors.accentText} />
            ) : !showImage && located ? (
              <Ionicons name="location" size={11} color={t.colors.accentText} />
            ) : null}
          </View>
          {showImage ? (
            <Image
              source={{ uri: photo! }}
              style={[styles.blockThumb, { backgroundColor: t.colors.fill1 }]}
            />
          ) : null}
        </View>
        <Text
          variant="micro"
          numberOfLines={1}
          style={[styles.blockMeta, { color: t.colors.accentText }]}
        >
          {flexible ? `Anytime ${timeText}` : timeText}
          {errand.address ? ` · ${errand.address}` : ''}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  hourLabel: {
    position: 'absolute',
    left: 0,
    width: GUTTER_W - 12,
    textAlign: 'right',
    fontVariant: ['tabular-nums'],
  },
  hourLine: {
    position: 'absolute',
    left: GUTTER_W,
    right: 0,
    height: StyleSheet.hairlineWidth,
  },
  nowDot: {
    position: 'absolute',
    left: GUTTER_W - 4,
    width: 8,
    height: 8,
    borderRadius: 4,
    zIndex: 6,
  },
  nowLine: {
    position: 'absolute',
    left: GUTTER_W,
    right: 0,
    height: 1.5,
    zIndex: 5,
  },
  block: {
    position: 'absolute',
    borderRadius: 10,
    overflow: 'hidden',
    flexDirection: 'row',
  },
  blockBar: {
    width: 3,
  },
  blockBody: {
    flex: 1,
    paddingVertical: 3,
    paddingHorizontal: 8,
    gap: 1,
  },
  blockHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
  },
  blockThumb: {
    width: THUMB,
    height: THUMB,
    borderRadius: 8,
  },
  blockTitleRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  blockTitle: {
    flexShrink: 1,
  },
  blockMeta: {
    opacity: 0.85,
    fontVariant: ['tabular-nums'],
  },
});
