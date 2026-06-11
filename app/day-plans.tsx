import React, { useMemo } from 'react';
import {
  Alert,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import {
  useSavedItineraries,
  plansForDate,
  activePlanForDate,
  type SavedItinerary,
} from '@/store/useSavedItineraries';
import { useTheme } from '@/theme/useTheme';
import { Text } from '@/components/Text';
import { Card } from '@/components/Card';
import { TopBar } from '@/components/TopBar';
import { todayISO } from '@/utils/time';

function tripSubtitle(trip: SavedItinerary): string {
  const parts: string[] = [];
  if (trip.stopCount > 0) {
    parts.push(`${trip.stopCount} stop${trip.stopCount === 1 ? '' : 's'}`);
  }
  const place = trip.city ?? trip.origin;
  if (place) parts.push(place.split(',')[0]);
  return parts.join(' · ');
}

function formatLongDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}

/**
 * The day's plans. Every saved itinerary dated today, oldest first, with the
 * active one badged. Tapping a card opens it; the per-row action pins a
 * different plan as today's active one (what the homepage shows), behind a
 * confirm so it isn't a one-tap surprise.
 */
export default function DayPlansScreen() {
  const router = useRouter();
  const t = useTheme();
  const today = todayISO();

  const items = useSavedItineraries((s) => s.items);
  const activate = useSavedItineraries((s) => s.activate);
  const remove = useSavedItineraries((s) => s.remove);
  const plans = useMemo(() => plansForDate(items, today), [items, today]);
  const active = useMemo(() => activePlanForDate(items, today), [items, today]);

  const onOpen = (id: string) => {
    Haptics.selectionAsync().catch(() => undefined);
    router.push({ pathname: '/itinerary', params: { id } });
  };

  const onActivate = (plan: SavedItinerary) => {
    Haptics.selectionAsync().catch(() => undefined);
    Alert.alert(
      'Set as today\u2019s plan?',
      `\u201C${plan.title}\u201D will show on your home screen as today\u2019s plan.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Set as active',
          onPress: () => {
            activate(plan.id);
            Haptics.notificationAsync(
              Haptics.NotificationFeedbackType.Success,
            ).catch(() => undefined);
            router.back();
          },
        },
      ],
    );
  };

  const onDelete = (plan: SavedItinerary) => {
    Haptics.selectionAsync().catch(() => undefined);
    Alert.alert(
      'Delete this plan?',
      `\u201C${plan.title}\u201D will be permanently removed.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            // Pop back to home when this was the last plan for the day, so the
            // user isn't left staring at an empty "Today's plans" screen.
            const isLast = plansForDate(items, today).length <= 1;
            remove(plan.id);
            Haptics.notificationAsync(
              Haptics.NotificationFeedbackType.Success,
            ).catch(() => undefined);
            if (isLast) router.back();
          },
        },
      ],
    );
  };

  return (
    <SafeAreaView
      style={[styles.container, { backgroundColor: t.colors.background }]}
      edges={['top', 'bottom']}
    >
      <TopBar
        kicker={formatLongDate(today)}
        title={'Today\u2019s plans'}
        left={{
          icon: 'chevron-back',
          onPress: () => router.back(),
          accessibilityLabel: 'Back',
        }}
      />

      <ScrollView
        contentContainerStyle={[
          styles.content,
          {
            paddingHorizontal: t.spacing.lg,
            paddingTop: t.spacing.md,
            paddingBottom: t.spacing.xxl,
          },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {plans.length === 0 ? (
          <View style={styles.empty}>
            <Ionicons
              name="calendar-outline"
              size={28}
              color={t.colors.textTertiary}
            />
            <Text variant="body" tone="secondary" style={styles.emptyText}>
              No plans for today yet.
            </Text>
          </View>
        ) : (
          plans.map((plan) => {
            const isActive = active?.id === plan.id;
            return (
              <Card key={plan.id} borderless style={styles.card}>
                <Pressable
                  onPress={() => onOpen(plan.id)}
                  accessibilityRole="button"
                  accessibilityLabel={`Open ${plan.title}`}
                  style={({ pressed }) => [
                    styles.row,
                    pressed && { opacity: 0.7 },
                  ]}
                >
                  <View style={[styles.thumb, { backgroundColor: t.colors.fill1 }]}>
                    {plan.thumbUrl ? (
                      <Image source={{ uri: plan.thumbUrl }} style={styles.thumbImg} />
                    ) : (
                      <Ionicons
                        name="map-outline"
                        size={20}
                        color={t.colors.textSecondary}
                      />
                    )}
                  </View>
                  <View style={styles.rowText}>
                    <Text variant="body" weight="semibold" numberOfLines={1}>
                      {plan.title}
                    </Text>
                    <Text variant="caption" tone="secondary" numberOfLines={1}>
                      {tripSubtitle(plan)}
                    </Text>
                  </View>
                  <Ionicons
                    name="chevron-forward"
                    size={18}
                    color={t.colors.textTertiary}
                  />
                </Pressable>

                <View
                  style={[styles.footer, { borderTopColor: t.colors.separator }]}
                >
                  {isActive ? (
                    <View style={styles.activeBadge}>
                      <Ionicons
                        name="checkmark-circle"
                        size={16}
                        color={t.colors.accent}
                      />
                      <Text variant="caption" weight="semibold" tone="accent">
                        Active today
                      </Text>
                    </View>
                  ) : (
                    <Pressable
                      onPress={() => onActivate(plan)}
                      accessibilityRole="button"
                      accessibilityLabel={`Make ${plan.title} today\u2019s plan`}
                      style={({ pressed }) => [
                        styles.activateBtn,
                        { backgroundColor: t.colors.accentSoft },
                        pressed && { opacity: 0.7 },
                      ]}
                    >
                      <Text
                        variant="caption"
                        weight="semibold"
                        style={{ color: t.colors.accentText }}
                      >
                        {'Set as today\u2019s plan'}
                      </Text>
                    </Pressable>
                  )}

                  <Pressable
                    onPress={() => onDelete(plan)}
                    accessibilityRole="button"
                    accessibilityLabel={`Delete ${plan.title}`}
                    hitSlop={8}
                    style={({ pressed }) => [
                      styles.deleteBtn,
                      { backgroundColor: t.colors.dangerSoft },
                      pressed && { opacity: 0.7 },
                    ]}
                  >
                    <Ionicons
                      name="trash-outline"
                      size={16}
                      color={t.colors.danger}
                    />
                  </Pressable>
                </View>
              </Card>
            );
          })
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: {
    flexGrow: 1,
    gap: 12,
  },
  card: {
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
  },
  thumb: {
    width: 46,
    height: 46,
    borderRadius: 12,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbImg: {
    width: '100%',
    height: '100%',
  },
  rowText: {
    flex: 1,
    gap: 2,
  },
  footer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    paddingVertical: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  activeBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  activateBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
  },
  deleteBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
  empty: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    marginTop: 64,
  },
  emptyText: {
    textAlign: 'center',
  },
});
