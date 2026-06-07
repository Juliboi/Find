import React, { useEffect, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  interpolateColor,
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
import type { ReorderImpact } from '@/lib/itinerary/edits';

export type ReorderRow = {
  id: string;
  emoji: string;
  title: string;
  subtitle?: string;
  isGap?: boolean;
  /** Travel INTO this stop from the previous located stop, when any — lets the
   *  rearrange view show WHERE commutes sit and how long they are. */
  commute?: { icon: keyof typeof Ionicons.glyphMap; label: string; estimated?: boolean };
  /** True for a pinned `fixed` anchor; surfaced with a lock since dragging one
   *  unpins it (a reorder softens a moved fixed block to flexible). */
  fixed?: boolean;
};

/** 0/1/2 ↔ free/reroute/replan, so the worklet layer can carry the score in a
 *  plain numeric shared value and the JS layer can talk in names. */
const IMPACTS: ReorderImpact[] = ['free', 'reroute', 'replan'];

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
  /** Impact (0/1/2) of dropping at the slot the finger is currently over. */
  currentImpact: SharedValue<number>;
  /** Precomputed impact per candidate drop-slot, scored once on lift. */
  impactBySlot: SharedValue<Record<number, number>>;
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
  classify,
  onImpact,
  topInset = 0,
  bottomInset = 0,
}: {
  rows: ReorderRow[];
  onReorder: (orderedIds: string[]) => void;
  /** Pure predictor: given a candidate order, what will committing it cost?
   *  Scored for every drop-slot the moment a row is lifted. */
  classify?: (orderedIds: string[]) => ReorderImpact;
  /** Fires as the lifted row crosses an impact boundary (and null on drop), so
   *  the host can reflect "free / re-route / replan" live. */
  onImpact?: (impact: ReorderImpact | null) => void;
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
  const currentImpact = useSharedValue(0);
  const impactBySlot = useSharedValue<Record<number, number>>({});

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
    currentImpact,
    impactBySlot,
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
        <DragRow
          key={row.id}
          row={row}
          ids={ids}
          shared={shared}
          onCommit={commit}
          classify={classify}
          onImpact={onImpact}
        />
      ))}
    </Animated.ScrollView>
  );
}

function DragRow({
  row,
  ids,
  shared,
  onCommit,
  classify,
  onImpact,
}: {
  row: ReorderRow;
  ids: string[];
  shared: Shared;
  onCommit: (orderedIds: string[]) => void;
  classify?: (orderedIds: string[]) => ReorderImpact;
  onImpact?: (impact: ReorderImpact | null) => void;
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
    currentImpact,
    impactBySlot,
  } = shared;

  const pick = () =>
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
  const drop = () => Haptics.selectionAsync().catch(() => undefined);
  const emitImpact = (n: number) => onImpact?.(IMPACTS[n] ?? 'free');
  const clearImpact = () => onImpact?.(null);

  // Score every candidate drop-slot ONCE, the moment the row lifts, so the
  // live readout during the drag is a shared-value lookup (no per-frame JS).
  const scoreSlots = (draggedId: string) => {
    if (!classify) return;
    const from = ids.indexOf(draggedId);
    if (from < 0) return;
    const map: Record<number, number> = {};
    for (let to = 0; to < ids.length; to += 1) {
      const ord = [...ids];
      const [moved] = ord.splice(from, 1);
      ord.splice(to, 0, moved);
      const imp = classify(ord);
      map[to] = imp === 'replan' ? 2 : imp === 'reroute' ? 1 : 0;
    }
    impactBySlot.value = map;
    const here = map[from] ?? 0;
    currentImpact.value = here;
    onImpact?.(IMPACTS[here] ?? 'free');
  };

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
          impactBySlot.value = {};
          currentImpact.value = 0;
          runOnJS(pick)();
          runOnJS(scoreSlots)(row.id);
        })
        .onUpdate((e) => {
          tx.value = e.translationY;
          const top = startIndex.value * ROW_H + tx.value + (scrollY.value - startScroll.value);
          const ti = clampW(Math.round(top / ROW_H), 0, count.value - 1);
          const ci = positions.value[row.id];
          if (ti !== ci) positions.value = moveSlots(positions.value, ci, ti);
          // Reflect the impact of dropping at the slot under the finger. Only
          // notify JS when the LEVEL flips (free↔reroute↔replan), not per slot.
          const imp = impactBySlot.value[ti] ?? 0;
          if (imp !== currentImpact.value) {
            currentImpact.value = imp;
            runOnJS(emitImpact)(imp);
          }
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
          currentImpact.value = 0;
          runOnJS(clearImpact)();
        }),
    // Shared values are stable refs; rebuild when the row, id set, or the
    // (itinerary-bound) classifier identity changes so scoring stays fresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [row.id, ids, classify, onImpact],
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

  // While lifted, the card's border tracks the impact of the slot it's over:
  // green = reflows freely, amber = re-routes the commute, red = needs a replan.
  const impactStyle = useAnimatedStyle(() => {
    const isActive = activeId.value === row.id;
    if (!isActive || !classify) {
      return { borderColor: t.colors.separator, borderWidth: StyleSheet.hairlineWidth };
    }
    return {
      borderColor: interpolateColor(
        currentImpact.value,
        [0, 1, 2],
        [t.colors.success, t.colors.warning, t.colors.danger],
      ),
      borderWidth: 1.5,
    };
  });

  return (
    <Animated.View style={[styles.slot, posStyle]}>
      <GestureDetector gesture={pan}>
        <Animated.View
          style={[
            styles.card,
            liftStyle,
            impactStyle,
            { backgroundColor: row.isGap ? t.colors.fill1 : t.colors.surface2 },
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
            <View style={styles.titleRow}>
              {row.fixed ? (
                <Ionicons name="lock-closed" size={12} color={t.colors.warning} />
              ) : null}
              <Text variant="bodySm" weight="semibold" numberOfLines={1} style={styles.title}>
                {row.title}
              </Text>
            </View>
            {row.subtitle ? (
              <Text variant="caption" tone="tertiary" numberOfLines={1}>
                {row.subtitle}
              </Text>
            ) : null}
          </View>
          {row.commute ? (
            <View style={[styles.commuteChip, { backgroundColor: t.colors.fill1 }]}>
              <Ionicons name={row.commute.icon} size={12} color={t.colors.textSecondary} />
              <Text variant="micro" weight="semibold" tone="secondary">
                {row.commute.label}
                {row.commute.estimated ? '~' : ''}
              </Text>
            </View>
          ) : null}
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
    borderRadius: 18,
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
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  title: { flexShrink: 1 },
  commuteChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 8,
  },
});
