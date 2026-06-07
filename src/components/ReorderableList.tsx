import React, { useEffect, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  runOnJS,
  scrollTo,
  type SharedValue,
  useAnimatedRef,
  useAnimatedStyle,
  useFrameCallback,
  useScrollViewOffset,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useTheme } from '@/theme/useTheme';
import { Text } from '@/components/Text';

export type ReorderRow = {
  id: string;
  emoji: string;
  title: string;
  subtitle?: string;
  isGap?: boolean;
};

/** One fixed slot height (card + the breathing gap below it). Uniform heights
 *  are what make the drag math exact and the auto-scroll smooth on a long day. */
const ROW_H = 66;
const CARD_GAP = 5;
/** Distance from the top/bottom edge where dragging starts auto-scrolling. */
const EDGE = 88;
/** Peak auto-scroll speed in px/frame (scaled by how deep into the edge zone). */
const MAX_AUTO = 12;
const SPRING = { damping: 26, stiffness: 260, mass: 0.7 };

function clampW(v: number, lo: number, hi: number) {
  'worklet';
  return Math.min(Math.max(v, lo), hi);
}

/** Reindex the slot map when the dragged row moves from slot `from` to `to`. */
function moveSlots(obj: Record<string, number>, from: number, to: number) {
  'worklet';
  const res: Record<string, number> = {};
  for (const id in obj) {
    const p = obj[id];
    if (p === from) res[id] = to;
    else if (from < to && p > from && p <= to) res[id] = p - 1;
    else if (from > to && p < from && p >= to) res[id] = p + 1;
    else res[id] = p;
  }
  return res;
}

type Shared = {
  positions: SharedValue<Record<string, number>>;
  activeId: SharedValue<string | null>;
  startIndex: SharedValue<number>;
  startScroll: SharedValue<number>;
  tx: SharedValue<number>;
  autoDir: SharedValue<number>;
  scrollY: SharedValue<number>;
  viewportH: SharedValue<number>;
  count: SharedValue<number>;
};

/**
 * A compact, long-press drag-and-drop reorder list. Each plan becomes a uniform
 * row; hold a row to lift it, drag to slot it anywhere, and the list auto-scrolls
 * when you near an edge so even a long day is comfortable to rearrange. Drops are
 * committed via `onReorder(orderedIds)`.
 */
export function ReorderableList({
  rows,
  onReorder,
  topInset = 0,
  bottomInset = 0,
}: {
  rows: ReorderRow[];
  onReorder: (orderedIds: string[]) => void;
  topInset?: number;
  bottomInset?: number;
}) {
  const scrollRef = useAnimatedRef<Animated.ScrollView>();
  const scrollY = useScrollViewOffset(scrollRef);
  const viewportH = useSharedValue(0);

  const positions = useSharedValue<Record<string, number>>(
    Object.fromEntries(rows.map((r, i) => [r.id, i])),
  );
  const count = useSharedValue(rows.length);
  const activeId = useSharedValue<string | null>(null);
  const startIndex = useSharedValue(0);
  const startScroll = useSharedValue(0);
  const tx = useSharedValue(0);
  const autoDir = useSharedValue(0);

  const ids = useMemo(() => rows.map((r) => r.id), [rows]);
  const rowsKey = ids.join('|');

  // Re-seed the slot map whenever the set/order of rows changes upstream
  // (notably right after a drop commits a new order, or a recompute returns).
  useEffect(() => {
    const seed: Record<string, number> = {};
    rows.forEach((r, i) => {
      seed[r.id] = i;
    });
    positions.value = seed;
    count.value = rows.length;
    activeId.value = null;
    autoDir.value = 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowsKey]);

  const shared: Shared = {
    positions,
    activeId,
    startIndex,
    startScroll,
    tx,
    autoDir,
    scrollY,
    viewportH,
    count,
  };

  // Continuous auto-scroll: while a row is held near an edge, slide the list and
  // keep re-resolving the target slot so the gap follows the finger.
  useFrameCallback(() => {
    if (activeId.value == null || autoDir.value === 0) return;
    const max = Math.max(0, count.value * ROW_H - viewportH.value);
    const next = clampW(scrollY.value + autoDir.value * MAX_AUTO, 0, max);
    if (next === scrollY.value) {
      autoDir.value = 0;
      return;
    }
    scrollTo(scrollRef, 0, next, false);
    const id = activeId.value;
    const top = startIndex.value * ROW_H + tx.value + (next - startScroll.value);
    const ti = clampW(Math.round(top / ROW_H), 0, count.value - 1);
    const ci = positions.value[id];
    if (ti !== ci) positions.value = moveSlots(positions.value, ci, ti);
  });

  const commit = (orderedIds: string[]) => onReorder(orderedIds);

  return (
    <Animated.ScrollView
      ref={scrollRef}
      style={styles.fill}
      onLayout={(e) => {
        viewportH.value = e.nativeEvent.layout.height;
      }}
      scrollEventThrottle={16}
      showsVerticalScrollIndicator={false}
      contentContainerStyle={{
        height: rows.length * ROW_H + topInset + bottomInset,
        paddingTop: topInset,
      }}
    >
      {rows.map((row) => (
        <DragRow key={row.id} row={row} ids={ids} shared={shared} onCommit={commit} />
      ))}
    </Animated.ScrollView>
  );
}

function DragRow({
  row,
  ids,
  shared,
  onCommit,
}: {
  row: ReorderRow;
  ids: string[];
  shared: Shared;
  onCommit: (orderedIds: string[]) => void;
}) {
  const t = useTheme();
  const {
    positions,
    activeId,
    startIndex,
    startScroll,
    tx,
    autoDir,
    scrollY,
    viewportH,
    count,
  } = shared;

  const pick = () =>
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
  const drop = () => Haptics.selectionAsync().catch(() => undefined);

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .activateAfterLongPress(180)
        .maxPointers(1)
        .onStart(() => {
          activeId.value = row.id;
          startIndex.value = positions.value[row.id] ?? 0;
          startScroll.value = scrollY.value;
          tx.value = 0;
          runOnJS(pick)();
        })
        .onUpdate((e) => {
          tx.value = e.translationY;
          const top = startIndex.value * ROW_H + tx.value + (scrollY.value - startScroll.value);
          const ti = clampW(Math.round(top / ROW_H), 0, count.value - 1);
          const ci = positions.value[row.id];
          if (ti !== ci) positions.value = moveSlots(positions.value, ci, ti);
          // Edge-proportional auto-scroll direction (-1 up … +1 down).
          const screenY = top - scrollY.value;
          const bottomZone = viewportH.value - ROW_H - EDGE;
          if (screenY < EDGE) autoDir.value = -clampW((EDGE - screenY) / EDGE, 0, 1);
          else if (screenY > bottomZone)
            autoDir.value = clampW((screenY - bottomZone) / EDGE, 0, 1);
          else autoDir.value = 0;
        })
        .onEnd(() => {
          if (activeId.value != null) {
            const ordered = [...ids].sort(
              (a, b) => (positions.value[a] ?? 0) - (positions.value[b] ?? 0),
            );
            runOnJS(onCommit)(ordered);
            runOnJS(drop)();
          }
        })
        .onFinalize(() => {
          activeId.value = null;
          autoDir.value = 0;
        }),
    // Shared values are stable refs; only the row identity / id set matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [row.id, ids],
  );

  const posStyle = useAnimatedStyle(() => {
    const isActive = activeId.value === row.id;
    const top = isActive
      ? startIndex.value * ROW_H + tx.value + (scrollY.value - startScroll.value)
      : (positions.value[row.id] ?? 0) * ROW_H;
    return {
      transform: [{ translateY: isActive ? top : withSpring(top, SPRING) }],
      zIndex: isActive ? 999 : 1,
    };
  });

  const liftStyle = useAnimatedStyle(() => {
    const isActive = activeId.value === row.id;
    return {
      transform: [{ scale: withSpring(isActive ? 1.035 : 1, SPRING) }],
      shadowOpacity: withSpring(isActive ? 0.3 : 0, SPRING),
      shadowRadius: isActive ? 16 : 0,
      elevation: isActive ? 16 : 0,
    };
  });

  return (
    <Animated.View style={[styles.slot, posStyle]}>
      <GestureDetector gesture={pan}>
        <Animated.View
          style={[
            styles.card,
            liftStyle,
            {
              backgroundColor: row.isGap ? t.colors.fill1 : t.colors.surface2,
              borderColor: t.colors.separator,
            },
          ]}
        >
          <View
            style={[
              styles.emojiWrap,
              { backgroundColor: row.isGap ? t.colors.surface2 : t.colors.fill1 },
            ]}
          >
            <Text style={styles.emoji}>{row.emoji}</Text>
          </View>
          <View style={styles.body}>
            <Text variant="bodySm" weight="semibold" numberOfLines={1}>
              {row.title}
            </Text>
            {row.subtitle ? (
              <Text variant="caption" tone="tertiary" numberOfLines={1}>
                {row.subtitle}
              </Text>
            ) : null}
          </View>
          <Ionicons name="reorder-three" size={24} color={t.colors.textTertiary} />
        </Animated.View>
      </GestureDetector>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  slot: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    height: ROW_H,
    paddingVertical: CARD_GAP,
    paddingHorizontal: 16,
  },
  card: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
  },
  emojiWrap: {
    width: 38,
    height: 38,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emoji: { fontSize: 18 },
  body: { flex: 1, gap: 1 },
});
