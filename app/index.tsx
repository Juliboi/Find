import React from 'react';
import {
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { useDayStore } from '@/store/useDayStore';
import { useTheme } from '@/theme/useTheme';
import { Card } from '@/components/Card';
import { Text } from '@/components/Text';
import { TopBar } from '@/components/TopBar';
import { SectionHeader } from '@/components/SectionHeader';
import { Chip } from '@/components/Chip';
import { Button } from '@/components/Button';
import { ComposerStatus } from '@/components/ComposerStatus';
import { EmptyState } from '@/components/EmptyState';
import { FloatingTabBar } from '@/components/FloatingTabBar';
import { PRIMARY_TABS } from '@/components/nav/tabs';
import { formatTime, formatDuration } from '@/utils/time';

function formatDateLong(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}

function formatKicker(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  return d
    .toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    })
    .toUpperCase();
}

function highlightForIndex(idx: number, c: ReturnType<typeof useTheme>['colors']) {
  const palette = [
    c.highlightBlue,
    c.highlightPurple,
    c.highlightYellow,
    c.highlightRed,
    c.success,
  ];
  return palette[idx % palette.length];
}

export default function HomeScreen() {
  const router = useRouter();
  const t = useTheme();

  const date = useDayStore((s) => s.date);
  const plans = useDayStore((s) => s.plans);
  const summary = useDayStore((s) => s.summary);
  const isScheduling = useDayStore((s) => s.isScheduling);
  const isComposing = useDayStore((s) => s.isComposing);
  const usedAi = useDayStore((s) => s.usedAi);
  const reorderAndReschedule = useDayStore((s) => s.reorderAndReschedule);
  const dismissComposeSummary = useDayStore((s) => s.dismissComposeSummary);
  // While the AI pipeline runs we want the empty-state to *not* show —
  // it'd flash up between submission and the first plan landing. Treat
  // "we're working on it" as already having content.
  const isWorking = isScheduling || isComposing;

  const isEmpty = plans.length === 0 && !isWorking;
  const upNext = plans.slice(0, 3);
  const remaining = Math.max(0, plans.length - upNext.length);

  const totalMinutes = plans.reduce((sum, p) => sum + p.durationMinutes, 0);

  const goAdd = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
    router.push('/add');
  };

  return (
    <SafeAreaView
      style={[styles.container, { backgroundColor: t.colors.background }]}
      edges={['top']}
    >
      <TopBar
        actions={[
          {
            icon: 'notifications-outline',
            accessibilityLabel: 'Notifications',
          },
          {
            icon: 'ellipsis-horizontal',
            onPress: () => router.push('/settings'),
            accessibilityLabel: 'More',
          },
        ]}
        compact
      />

      <ScrollView
        contentContainerStyle={[
          styles.scrollContent,
          {
            paddingHorizontal: t.spacing.lg,
            paddingBottom: 140,
          },
          isEmpty && { flexGrow: 1, justifyContent: 'space-between' },
        ]}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={isScheduling}
            onRefresh={reorderAndReschedule}
            tintColor={t.colors.accent}
          />
        }
      >
        <View style={styles.heroBlock}>
          <Text variant="caption" tone="secondary" uppercase weight="semibold">
            {formatKicker(date)}
          </Text>
          <View style={styles.titleRow}>
            <Text variant="title1" tight>
              Your day
            </Text>
            {plans.length > 0 ? (
              <View
                style={[
                  styles.badge,
                  {
                    backgroundColor: usedAi
                      ? t.colors.accentSoft
                      : t.colors.fill1,
                  },
                ]}
              >
                <Text
                  variant="micro"
                  weight="bold"
                  uppercase
                  tone={usedAi ? 'accent' : 'secondary'}
                >
                  {usedAi ? 'AI' : 'Offline'}
                </Text>
              </View>
            ) : null}
          </View>
        </View>

        {isEmpty ? (
          <EmptyState
            icon="sparkles-outline"
            title="Get started with Diem"
            body="Add plans, errands, or focus blocks with the action bar. Diem will order them, estimate timings, and ask follow-ups when needed."
            pointToFab
          />
        ) : (
          <View style={[styles.stack, { gap: t.spacing.xl }]}>
            <ComposerStatus onDismissSummary={dismissComposeSummary} />
            {summary ? (
              <Card padded>
                <Text variant="caption" tone="secondary" uppercase weight="semibold">
                  Summary
                </Text>
                <Text variant="body" style={{ marginTop: 6 }}>
                  {summary}
                </Text>
              </Card>
            ) : null}

            <View style={{ gap: t.spacing.sm }}>
              <SectionHeader title="Up next" onPress={() => router.push('/plans')} />
              <Card padded>
                {upNext.map((plan, idx) => (
                  <View
                    key={plan.id}
                    style={[
                      styles.planRow,
                      idx > 0 && {
                        borderTopWidth: StyleSheet.hairlineWidth,
                        borderTopColor: t.colors.separator,
                      },
                    ]}
                  >
                    <View
                      style={[
                        styles.planBar,
                        { backgroundColor: highlightForIndex(idx, t.colors) },
                      ]}
                    />
                    <View style={{ flex: 1, gap: 2 }}>
                      <Text variant="body" weight="semibold" numberOfLines={1}>
                        {plan.title || plan.rawText}
                      </Text>
                      <Text variant="caption" tone="secondary" numberOfLines={1}>
                        {formatDuration(plan.durationMinutes)}
                        {plan.location ? ` · ${plan.location}` : ''}
                      </Text>
                    </View>
                    <Text
                      variant="caption"
                      weight="semibold"
                      tone="secondary"
                    >
                      {plan.startTime ? formatTime(plan.startTime) : '—'}
                    </Text>
                  </View>
                ))}
                {remaining > 0 ? (
                  <View
                    style={[
                      styles.planRow,
                      {
                        borderTopWidth: StyleSheet.hairlineWidth,
                        borderTopColor: t.colors.separator,
                      },
                    ]}
                  >
                    <View style={styles.planBar} />
                    <Text variant="bodySm" tone="secondary" style={{ flex: 1 }}>
                      +{remaining} more plan{remaining === 1 ? '' : 's'}
                    </Text>
                    <Ionicons
                      name="chevron-forward"
                      size={16}
                      color={t.colors.textSecondary}
                    />
                  </View>
                ) : null}
              </Card>
            </View>

            <View style={{ gap: t.spacing.sm }}>
              <SectionHeader title="At a glance" showChevron={false} />
              <View style={styles.glanceRow}>
                <Card padded style={styles.glanceCard}>
                  <Ionicons
                    name="time-outline"
                    size={20}
                    color={t.colors.textSecondary}
                  />
                  <Text
                    variant="title2"
                    tight
                    weight="bold"
                    style={{ marginTop: 4 }}
                  >
                    {formatDuration(totalMinutes)}
                  </Text>
                  <Text variant="caption" tone="secondary">
                    Scheduled today
                  </Text>
                </Card>
                <Card padded style={styles.glanceCard}>
                  <Ionicons
                    name="list-outline"
                    size={20}
                    color={t.colors.textSecondary}
                  />
                  <Text
                    variant="title2"
                    tight
                    weight="bold"
                    style={{ marginTop: 4 }}
                  >
                    {plans.length}
                  </Text>
                  <Text variant="caption" tone="secondary">
                    {plans.length === 1 ? 'Plan' : 'Plans'}
                  </Text>
                </Card>
              </View>
            </View>

            <View style={{ gap: t.spacing.sm }}>
              <SectionHeader title="Quick actions" showChevron={false} />
              <View style={styles.actionsRow}>
                <Chip
                  icon="add"
                  label="Add plan"
                  onPress={goAdd}
                  large
                />
                <Chip
                  icon="sync"
                  label="Reschedule"
                  onPress={reorderAndReschedule}
                  large
                />
                <Chip
                  icon="location-outline"
                  label="Set home"
                  onPress={() => router.push('/places')}
                  large
                />
              </View>
            </View>
          </View>
        )}

        {isEmpty ? (
          <View style={{ alignItems: 'center', paddingVertical: 12 }}>
            <Button
              title="Or open the sandbox"
              variant="ghost"
              size="sm"
              onPress={() => router.push('/test')}
            />
          </View>
        ) : null}
      </ScrollView>

      <FloatingTabBar tabs={PRIMARY_TABS} onFabPress={goAdd} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scrollContent: {
    paddingTop: 16,
    paddingBottom: 80,
    gap: 20,
  },
  heroBlock: {
    gap: 6,
    paddingTop: 4,
    paddingBottom: 4,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
  },
  stack: {},
  planRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    gap: 12,
  },
  planBar: {
    width: 3,
    alignSelf: 'stretch',
    borderRadius: 2,
    minHeight: 24,
  },
  glanceRow: {
    flexDirection: 'row',
    gap: 12,
  },
  glanceCard: {
    flex: 1,
    gap: 2,
  },
  actionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
});
