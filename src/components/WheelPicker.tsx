import React, { useCallback, useEffect, useRef } from 'react';
import { StyleSheet, View, type StyleProp, type TextStyle } from 'react-native';
import Animated, {
  Extrapolation,
  interpolate,
  runOnJS,
  type SharedValue,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { useTheme } from '@/theme/useTheme';
import { Text } from './Text';

export interface WheelOption {
  /** Stable key. */
  key: string;
  /** Primary, large label (e.g. "Today"). */
  label: string;
  /** Optional secondary line under the label (e.g. "Sat · Jun 14"). */
  sublabel?: string;
}

interface Props {
  options: WheelOption[];
  /** Index to centre on. Honoured on mount and when changed externally. */
  selectedIndex: number;
  onChange: (index: number) => void;
  /** Height of one row in px. Drives snap + centering math. */
  itemHeight?: number;
  /** Odd number of rows visible at once (centre + N/2 each side). */
  visibleCount?: number;
  /** Override the primary label style (e.g. a much bigger font). */
  labelStyle?: StyleProp<TextStyle>;
  /** Override the secondary label style. */
  sublabelStyle?: StyleProp<TextStyle>;
}

/**
 * An iOS-style scroll wheel: a snapping vertical list where the centred row is
 * full-size + full-opacity and the neighbours fall away in scale/opacity, with
 * a soft highlight band marking the selection slot. Built on a Reanimated
 * scroll handler so the per-row falloff tracks the finger without re-rendering
 * the list on every frame.
 *
 * Lives in its own component so it can back any wheel-style picker (the
 * day-of-week selector today, others later).
 */
export function WheelPicker({
  options,
  selectedIndex,
  onChange,
  itemHeight = 48,
  visibleCount = 5,
  labelStyle,
  sublabelStyle,
}: Props) {
  const t = useTheme();
  const scrollRef = useRef<Animated.ScrollView>(null);
  const scrollY = useSharedValue(selectedIndex * itemHeight);
  // Last index we reported up. Lets us (a) avoid haptic spam and (b) tell our
  // own reported changes apart from external `selectedIndex` updates, so we
  // never fight the user's finger by scrolling back on our own emissions.
  const committed = useRef(selectedIndex);
  const lastTick = useSharedValue(selectedIndex);

  const height = itemHeight * visibleCount;
  const padV = (height - itemHeight) / 2;
  const initialOffsetRef = useRef(selectedIndex * itemHeight);

  // Centre on the initial selection once mounted (covers Android, where the
  // `contentOffset` prop isn't always applied).
  useEffect(() => {
    scrollRef.current?.scrollTo({ y: initialOffsetRef.current, animated: false });
  }, []);

  // React to EXTERNAL selection changes only (e.g. the sheet re-seeding the day
  // on open). Our own scroll-driven emissions update `committed` first, so they
  // no-op here.
  useEffect(() => {
    if (selectedIndex === committed.current) return;
    committed.current = selectedIndex;
    scrollY.value = selectedIndex * itemHeight;
    scrollRef.current?.scrollTo({ y: selectedIndex * itemHeight, animated: true });
  }, [selectedIndex, itemHeight, scrollY]);

  const tick = useCallback(() => {
    Haptics.selectionAsync().catch(() => undefined);
  }, []);

  const commit = useCallback(
    (index: number) => {
      const clamped = Math.max(0, Math.min(options.length - 1, index));
      committed.current = clamped;
      onChange(clamped);
    },
    [onChange, options.length],
  );

  const handler = useAnimatedScrollHandler({
    onScroll: (e) => {
      scrollY.value = e.contentOffset.y;
      const idx = Math.round(e.contentOffset.y / itemHeight);
      if (idx !== lastTick.value) {
        lastTick.value = idx;
        runOnJS(tick)();
        runOnJS(commit)(idx);
      }
    },
    onMomentumEnd: (e) => {
      runOnJS(commit)(Math.round(e.contentOffset.y / itemHeight));
    },
  });

  return (
    <View style={{ height, alignSelf: 'stretch' }}>
      <View
        pointerEvents="none"
        style={[
          styles.band,
          {
            top: padV,
            height: itemHeight,
            backgroundColor: t.colors.fill1,
            borderRadius: t.radii.md,
          },
        ]}
      />
      <Animated.ScrollView
        ref={scrollRef}
        showsVerticalScrollIndicator={false}
        snapToInterval={itemHeight}
        decelerationRate="fast"
        scrollEventThrottle={16}
        onScroll={handler}
        contentOffset={{ x: 0, y: initialOffsetRef.current }}
        contentContainerStyle={{ paddingVertical: padV }}
      >
        {options.map((opt, i) => (
          <WheelRow
            key={opt.key}
            index={i}
            itemHeight={itemHeight}
            scrollY={scrollY}
            option={opt}
            labelStyle={labelStyle}
            sublabelStyle={sublabelStyle}
          />
        ))}
      </Animated.ScrollView>
    </View>
  );
}

const WheelRow = React.memo(function WheelRow({
  index,
  itemHeight,
  scrollY,
  option,
  labelStyle,
  sublabelStyle,
}: {
  index: number;
  itemHeight: number;
  scrollY: SharedValue<number>;
  option: WheelOption;
  labelStyle?: StyleProp<TextStyle>;
  sublabelStyle?: StyleProp<TextStyle>;
}) {
  const rowStyle = useAnimatedStyle(() => {
    const pos = scrollY.value / itemHeight;
    const d = Math.abs(pos - index);
    return {
      opacity: interpolate(d, [0, 1, 2, 3], [1, 0.4, 0.18, 0.07], Extrapolation.CLAMP),
      transform: [
        { scale: interpolate(d, [0, 1, 2], [1, 0.82, 0.68], Extrapolation.CLAMP) },
      ],
    };
  });

  return (
    <Animated.View style={[{ height: itemHeight }, styles.row, rowStyle]}>
      <Text variant="title1" weight="heavy" tight numberOfLines={1} style={labelStyle}>
        {option.label}
      </Text>
      {option.sublabel ? (
        <Text
          variant="caption"
          tone="secondary"
          weight="semibold"
          numberOfLines={1}
          style={sublabelStyle}
        >
          {option.sublabel}
        </Text>
      ) : null}
    </Animated.View>
  );
});

const styles = StyleSheet.create({
  band: {
    position: 'absolute',
    left: 0,
    right: 0,
  },
  row: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});
