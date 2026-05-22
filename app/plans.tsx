import React, { useMemo, useState } from 'react';
import {
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { useDayStore } from '@/store/useDayStore';
import {
  useHomeStore,
  selectAnchors,
  selectEndOfDay,
  effectiveCoords,
} from '@/store/useHomeStore';
import { useTheme } from '@/theme/useTheme';
import { Ionicons } from '@expo/vector-icons';
import { TopBar } from '@/components/TopBar';
import { Text } from '@/components/Text';
import { PlanCard } from '@/components/PlanCard';
import { TravelRow } from '@/components/TravelRow';
import { ComposerStatus } from '@/components/ComposerStatus';
import { EmptyState } from '@/components/EmptyState';
import { FloatingTabBar } from '@/components/FloatingTabBar';
import { PRIMARY_TABS } from '@/components/nav/tabs';
import { Input } from '@/components/Input';
import { Button } from '@/components/Button';
import { travelBetween } from '@/lib/travel';
import type { Plan } from '@/types/plan';

export default function PlansScreen() {
  const router = useRouter();
  const t = useTheme();

  const plans = useDayStore((s) => s.plans);
  const isScheduling = useDayStore((s) => s.isScheduling);
  const usedAi = useDayStore((s) => s.usedAi);
  const resolveClarification = useDayStore((s) => s.resolveClarification);
  const removePlan = useDayStore((s) => s.removePlan);
  const reorderAndReschedule = useDayStore((s) => s.reorderAndReschedule);
  const resetDay = useDayStore((s) => s.resetDay);
  const dismissComposeSummary = useDayStore((s) => s.dismissComposeSummary);
  // Home + work + end-of-day anchors as a single snapshot. Used to
  // resolve "Home"/"Office" location strings into real coords so we
  // can render travel rows even for plans that didn't pick a venue.
  const anchors = useHomeStore(selectAnchors);
  const endOfDay = useHomeStore(selectEndOfDay);

  const [query, setQuery] = useState('');

  const filtered = query.trim()
    ? plans.filter((p) =>
        `${p.title} ${p.rawText} ${p.location ?? ''}`
          .toLowerCase()
          .includes(query.trim().toLowerCase()),
      )
    : plans;

  // Pre-compute each filtered plan's effective coords once. Saves
  // recomputing inside renderItem and inside the home-anchor lookup.
  const effectiveByPlanId = useMemo(() => {
    const map = new Map<string, { latitude: number; longitude: number } | null>();
    for (const p of filtered) {
      map.set(p.id, effectiveCoords(p, anchors));
    }
    return map;
  }, [filtered, anchors]);

  // Find the last plan that has *resolvable* coords (real venue OR
  // an anchor like Home/Office). The closing "→ Home" row lives
  // after that plan — placing it later than the last real location
  // would visually float the row in space.
  const lastResolvedIndex = useMemo<number>(() => {
    for (let i = filtered.length - 1; i >= 0; i--) {
      if (effectiveByPlanId.get(filtered[i].id)) return i;
    }
    return -1;
  }, [filtered, effectiveByPlanId]);

  const lastResolvedPlan: Plan | null =
    lastResolvedIndex >= 0 ? filtered[lastResolvedIndex] : null;

  const lastResolvedCoords = lastResolvedPlan
    ? effectiveByPlanId.get(lastResolvedPlan.id) ?? null
    : null;

  // Skip the home row when the last located plan is already AT home
  // (or end-of-day) — a "0 min" travel row reads as a bug. The 250 m
  // threshold absorbs GPS jitter on the user's saved pin.
  const HOME_ANCHOR_SKIP_M = 250;
  const homeAnchorTravel = (() => {
    if (!lastResolvedCoords || !endOfDay) return null;
    const t = travelBetween(lastResolvedCoords, endOfDay);
    if (!t) return null;
    if (t.distanceM <= HOME_ANCHOR_SKIP_M) return null;
    return t;
  })();

  const goAdd = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
    router.push('/add');
  };

  const confirmReset = () => {
    Alert.alert(
      'Clear all plans?',
      'This will remove every plan in today\'s schedule. You can\'t undo this.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear',
          style: 'destructive',
          onPress: resetDay,
        },
      ],
    );
  };

  const isEmpty = plans.length === 0;
  const isSearchEmpty = plans.length > 0 && filtered.length === 0;

  return (
    <SafeAreaView
      style={[styles.container, { backgroundColor: t.colors.background }]}
      edges={['top']}
    >
      <TopBar
        kicker={usedAi ? 'AI scheduled' : 'Offline scheduled'}
        title="Plans"
        actions={[
          {
            icon: 'sync',
            onPress: reorderAndReschedule,
            accessibilityLabel: 'Reschedule',
          },
          ...(isEmpty
            ? []
            : [
                {
                  icon: 'trash-outline' as const,
                  onPress: confirmReset,
                  accessibilityLabel: 'Clear all',
                },
              ]),
        ]}
      />

      {!isEmpty ? (
        <View style={{ paddingHorizontal: t.spacing.lg, paddingTop: 4 }}>
          <Input
            placeholder="Search plans"
            leftIcon="search"
            value={query}
            onChangeText={setQuery}
            returnKeyType="search"
          />
        </View>
      ) : null}

      <FlatList
        data={filtered}
        keyExtractor={(item) => item.id}
        contentContainerStyle={[
          styles.listContent,
          {
            paddingHorizontal: t.spacing.lg,
            paddingTop: t.spacing.md,
            paddingBottom: 140,
          },
          (isEmpty || isSearchEmpty) && { flexGrow: 1, justifyContent: 'center' },
        ]}
        // No ItemSeparatorComponent on purpose — we paint the travel
        // connector ourselves inside renderItem so it visually flows
        // from card → connector → card. Static separators would
        // re-introduce gaps that break the "timeline" feeling.
        renderItem={({ item, index }) => {
          const next = filtered[index + 1];
          const here = effectiveByPlanId.get(item.id);
          const there = next ? effectiveByPlanId.get(next.id) : null;
          // Render the travel leg on the *outgoing* side of each
          // plan (departure-flavored). Conditions:
          //   1. There's a next plan to travel TO.
          //   2. Both sides have resolvable coords (real venue OR an
          //      anchor like Home/Office).
          //   3. The two are actually different places — a "0 min"
          //      row reads as a bug; suppress with a tiny threshold
          //      to absorb GPS jitter (50 m).
          let interTravel = null as ReturnType<typeof travelBetween>;
          if (next && here && there) {
            const t = travelBetween(here, there);
            if (t && t.distanceM > 50) interTravel = t;
          }
          return (
            <View>
              <PlanCard
                plan={item}
                onResolveClarification={resolveClarification}
                onRemove={removePlan}
              />
              {interTravel ? (
                <TravelRow
                  travel={interTravel}
                  destinationLabel={next?.title || next?.rawText}
                />
              ) : next ? (
                // No travel row (same location or one side unresolved):
                // keep the visual rhythm with a small spacer so cards
                // don't slam into each other.
                <View style={{ height: 12 }} />
              ) : null}
            </View>
          );
        }}
        refreshControl={
          <RefreshControl
            refreshing={isScheduling}
            onRefresh={reorderAndReschedule}
            tintColor={t.colors.accent}
          />
        }
        ListEmptyComponent={
          isSearchEmpty ? (
            <EmptyState
              icon="folder-outline"
              title="Oops, nothing found"
              body={`Your search didn’t turn anything up for “${query.trim()}”.`}
              action={
                <Button
                  title="Clear search"
                  variant="secondary"
                  onPress={() => setQuery('')}
                />
              }
            />
          ) : (
            <EmptyState
              icon="sparkles-outline"
              title="No plans yet"
              body="Tap the + to add things you want to do today. Diem will order them and ask follow-ups when it needs detail."
              pointToFab
            />
          )
        }
        ListHeaderComponent={
          <View style={{ gap: 12, marginBottom: 8 }}>
            <ComposerStatus onDismissSummary={dismissComposeSummary} />
            {!isEmpty && plans.length > 0 ? (
              <Text
                variant="caption"
                tone="secondary"
                uppercase
                weight="semibold"
              >
                {filtered.length} of {plans.length}
              </Text>
            ) : null}
          </View>
        }
        ListFooterComponent={
          isEmpty ? null : (
            <View style={{ marginTop: 4 }}>
              {homeAnchorTravel && endOfDay ? (
                <TravelRow
                  travel={homeAnchorTravel}
                  destinationLabel={endOfDay.label || 'Home'}
                  isHomeAnchor
                />
              ) : null}
              <Pressable
                onPress={goAdd}
                style={({ pressed }) => [
                  styles.addMoreRow,
                  {
                    backgroundColor: t.colors.fill1,
                    borderColor: t.colors.separator,
                    borderRadius: t.radii.lg,
                    marginTop: 12,
                  },
                  pressed && { opacity: 0.7 },
                ]}
              >
                <View
                  style={[
                    styles.addMoreIcon,
                    { backgroundColor: t.colors.surface1 },
                  ]}
                >
                  <Ionicons
                    name="add"
                    size={18}
                    color={t.colors.textPrimary}
                  />
                </View>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text variant="bodySm" weight="semibold">
                    Add more to today
                  </Text>
                  <Text variant="caption" tone="secondary">
                    Diem will fit it into the day around your plans.
                  </Text>
                </View>
                <Ionicons
                  name="chevron-forward"
                  size={16}
                  color={t.colors.textSecondary}
                />
              </Pressable>
            </View>
          )
        }
      />

      <FloatingTabBar tabs={PRIMARY_TABS} onFabPress={goAdd} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  listContent: {
    gap: 0,
  },
  addMoreRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 14,
    paddingHorizontal: 14,
    borderWidth: StyleSheet.hairlineWidth,
    // Slight dashed treatment would read nicest here, but RN's
    // borderStyle 'dashed' is iOS-only at this radius. Going with
    // a solid hairline for cross-platform consistency.
  },
  addMoreIcon: {
    width: 32,
    height: 32,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
