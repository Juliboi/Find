import React, { useEffect, useMemo, useRef } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { Text } from './Text';
import { dateFromISO, upcomingWeek, type DayOption } from '@/utils/days';

// This strip lives on top of the home screen's saturated daytime gradient, so
// — like the "Hey, …" header above it — it's painted in whites rather than the
// theme's text tokens. The selected day flips to a solid white pill with near
// black text so it reads as the clear, lit focus against the colour field.
const ON = '#FFFFFF';
const ON_SOFT = 'rgba(255, 255, 255, 0.82)';
const ON_DIM = 'rgba(255, 255, 255, 0.58)';
const SELECTED_BG = 'rgba(255, 255, 255, 0.96)';
const SELECTED_INK = '#0B0B0F';
const SELECTED_INK_SOFT = 'rgba(11, 11, 15, 0.55)';

const PILL_W = 48;
const GAP = 8;

interface Props {
  /** The currently focused day ("YYYY-MM-DD"). */
  selectedDate: string;
  /** Fired with the tapped day's ISO date. */
  onSelectDate: (iso: string) => void;
  /**
   * The user's "today" ("YYYY-MM-DD"). Passed in (rather than read here) so the
   * strip re-anchors when the host's midnight-rollover tick advances the day.
   */
  today: string;
  /** How many days to show, starting at today. Defaults to 14 (two weeks). */
  days?: number;
  /**
   * Horizontal inset for the scroll content — set to the screen's edge padding
   * so the first/last pill aligns with the page while the strip itself bleeds
   * edge to edge. Defaults to 16.
   */
  edgePadding?: number;
  style?: StyleProp<ViewStyle>;
}

/**
 * A horizontal, swipeable week-strip of day pills for moving the home screen
 * between days. Starts at today (the app is forward-looking) and runs a couple
 * of weeks out; the selected day is highlighted and auto-scrolled into view.
 *
 * It's intentionally a controlled component — the host owns the focused date —
 * and is styled for placement over the home gradient.
 */
export function CalendarStrip({
  selectedDate,
  onSelectDate,
  today,
  days = 14,
  edgePadding = 16,
  style,
}: Props) {
  const options = useMemo(
    () => upcomingWeek(days, dateFromISO(today)),
    [days, today],
  );

  const scrollRef = useRef<ScrollView>(null);
  const didMount = useRef(false);

  // Keep the focused day on screen: snap to it on mount (no animation, so it's
  // already in place on first paint) and glide to it on every later change —
  // including a programmatic jump back to "today".
  useEffect(() => {
    const index = options.findIndex((o) => o.iso === selectedDate);
    if (index < 0) return;
    // Leave one pill of lead-in so the selected day isn't jammed to the edge.
    const x = Math.max(0, index * (PILL_W + GAP) - (PILL_W + GAP));
    scrollRef.current?.scrollTo({ x, animated: didMount.current });
    didMount.current = true;
  }, [selectedDate, options]);

  return (
    <ScrollView
      ref={scrollRef}
      horizontal
      showsHorizontalScrollIndicator={false}
      style={[styles.scroll, { marginHorizontal: -edgePadding }, style]}
      contentContainerStyle={[styles.content, { paddingHorizontal: edgePadding }]}
    >
      {options.map((option) => (
        <DayPill
          key={option.iso}
          option={option}
          selected={option.iso === selectedDate}
          onPress={() => {
            if (option.iso === selectedDate) return;
            Haptics.selectionAsync().catch(() => undefined);
            onSelectDate(option.iso);
          }}
        />
      ))}
    </ScrollView>
  );
}

function DayPill({
  option,
  selected,
  onPress,
}: {
  option: DayOption;
  selected: boolean;
  onPress: () => void;
}) {
  const { weekdayShort, dayNum, isToday, title, monthShort } = option;
  const showDot = isToday && !selected;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={`${title}, ${monthShort} ${dayNum}`}
      style={({ pressed }) => [
        styles.pill,
        selected && { backgroundColor: SELECTED_BG },
        pressed && !selected && { opacity: 0.6 },
      ]}
    >
      <Text
        variant="micro"
        uppercase
        weight="bold"
        style={{ color: selected ? SELECTED_INK_SOFT : ON_DIM, letterSpacing: 0.8 }}
      >
        {weekdayShort}
      </Text>
      <Text
        variant="subhead"
        weight={selected || isToday ? 'bold' : 'semibold'}
        tight
        style={{ color: selected ? SELECTED_INK : isToday ? ON : ON_SOFT }}
      >
        {dayNum}
      </Text>
      <View style={[styles.dot, showDot && { backgroundColor: ON }]} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  scroll: {
    flexGrow: 0,
  },
  content: {
    gap: GAP,
    paddingVertical: 2,
  },
  pill: {
    width: PILL_W,
    paddingVertical: 8,
    borderRadius: 16,
    alignItems: 'center',
    gap: 3,
  },
  dot: {
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'transparent',
  },
});
