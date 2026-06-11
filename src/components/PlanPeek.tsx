import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text as RNText, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/theme/useTheme';
import { Text } from '@/components/Text';
import {
  getDayPeek,
  isArrivalMarker,
  type PeekRow,
} from '@/lib/itinerary/timeline';
import {
  KIND_EMOJI,
  type Itinerary,
  type ItineraryItem,
  type ItineraryTravelMode,
} from '@/types/itinerary';
import {
  currentHHMM,
  formatDuration,
  formatTime,
  minutesOfDay,
} from '@/utils/time';

/** Coarse leg mode → the glyph shown in the commute row's badge. */
const TRAVEL_MODE_ICON: Record<ItineraryTravelMode, keyof typeof Ionicons.glyphMap> = {
  walk: 'walk',
  bike: 'bicycle',
  transit: 'subway',
  drive: 'car',
};

interface Props {
  itinerary: Itinerary;
}

/** Destination headline for a row: prefer the real venue name, else the title. */
function placeLabel(item: ItineraryItem): string {
  return item.place?.name?.trim() || item.title;
}

/**
 * Trailing meta for a peek row. Blocks show their start clock; a commute shows
 * when you'll arrive (its destination's start), falling back to the leg's
 * length when the arrival time isn't known.
 */
function rowMeta(row: PeekRow): string {
  const item = row.item;
  if (row.kind === 'commute' && row.leg) {
    return item.startTime
      ? formatTime(item.startTime)
      : formatDuration(Math.max(1, Math.round(row.leg.minutes)));
  }
  if (item.startTime) return formatTime(item.startTime);
  if (item.durationMinutes) return formatDuration(item.durationMinutes);
  return '';
}

/** Primary headline for a peek row. */
function rowTitle(row: PeekRow): string {
  if (row.kind === 'commute') {
    return isArrivalMarker(row.item) ? 'Heading home' : `Heading to ${placeLabel(row.item)}`;
  }
  return placeLabel(row.item);
}

function PeekLine({ row, label, live }: { row: PeekRow; label: string; live?: boolean }) {
  const t = useTheme();
  const isCommute = row.kind === 'commute';
  const meta = rowMeta(row);
  return (
    <View style={styles.row}>
      <View
        style={[
          styles.glyph,
          {
            backgroundColor: isCommute ? t.colors.accentSoft : t.colors.fill1,
          },
        ]}
      >
        {isCommute && row.leg ? (
          <Ionicons
            name={TRAVEL_MODE_ICON[row.leg.mode] ?? 'navigate'}
            size={15}
            color={t.colors.accentText}
          />
        ) : (
          <RNText style={styles.emoji}>
            {row.item.place?.emoji || KIND_EMOJI[row.item.kind] || '•'}
          </RNText>
        )}
      </View>
      <View style={styles.body}>
        <Text
          variant="micro"
          uppercase
          weight="bold"
          tone={live ? 'accent' : 'secondary'}
          style={styles.label}
        >
          {label}
        </Text>
        <View style={styles.titleRow}>
          <Text variant="bodySm" weight="semibold" numberOfLines={1} style={styles.title}>
            {rowTitle(row)}
          </Text>
          {meta ? (
            <Text variant="caption" tone="secondary" style={styles.meta} numberOfLines={1}>
              {meta}
            </Text>
          ) : null}
        </View>
      </View>
    </View>
  );
}

/**
 * A compact "where am I right now" peek for the homepage plan card. Sits inside
 * the same glass surface, under the plan headline, and mirrors the planner
 * screen's now/commute logic: it shows the block (or commute) happening right
 * now plus the next one up. Renders nothing once the day is finished or the
 * plan has no blocks.
 */
export function PlanPeek({ itinerary }: Props) {
  const t = useTheme();
  // The peek's now-ness moves by the minute, so keep a light local tick rather
  // than depending on the home screen's slower day-part clock.
  const [nowMin, setNowMin] = useState(() => minutesOfDay(currentHHMM()) ?? 0);
  useEffect(() => {
    const id = setInterval(() => {
      setNowMin(minutesOfDay(currentHHMM()) ?? 0);
    }, 60 * 1000);
    return () => clearInterval(id);
  }, []);

  const peek = useMemo(() => getDayPeek(itinerary, nowMin), [itinerary, nowMin]);
  if (!peek.now) return null;

  const before = peek.status === 'before';
  return (
    <View style={styles.wrap}>
      <View style={[styles.divider, { backgroundColor: t.colors.separator }]} />
      <PeekLine row={peek.now} label={before ? 'Up next' : 'Now'} live={!before} />
      {peek.next ? (
        <PeekLine row={peek.next} label={before ? 'Later' : 'Next'} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginTop: 14,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginBottom: 10,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 5,
  },
  glyph: {
    width: 30,
    height: 30,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emoji: {
    fontSize: 15,
  },
  body: {
    flex: 1,
    gap: 1,
  },
  label: {
    letterSpacing: 1,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 8,
  },
  title: {
    flexShrink: 1,
  },
  meta: {
    fontVariant: ['tabular-nums'],
  },
});
