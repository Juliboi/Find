import React, { useState } from 'react';
import {
  Alert,
  FlatList,
  RefreshControl,
  StyleSheet,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { useDayStore } from '@/store/useDayStore';
import { useTheme } from '@/theme/useTheme';
import { TopBar } from '@/components/TopBar';
import { Text } from '@/components/Text';
import { PlanCard } from '@/components/PlanCard';
import { EmptyState } from '@/components/EmptyState';
import { FloatingTabBar } from '@/components/FloatingTabBar';
import { PRIMARY_TABS } from '@/components/nav/tabs';
import { Input } from '@/components/Input';
import { Button } from '@/components/Button';

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

  const [query, setQuery] = useState('');

  const filtered = query.trim()
    ? plans.filter((p) =>
        `${p.title} ${p.rawText} ${p.location ?? ''}`
          .toLowerCase()
          .includes(query.trim().toLowerCase()),
      )
    : plans;

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
        ItemSeparatorComponent={() => <View style={{ height: 12 }} />}
        renderItem={({ item }) => (
          <PlanCard
            plan={item}
            onResolveClarification={resolveClarification}
            onRemove={removePlan}
          />
        )}
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
          !isEmpty && plans.length > 0 ? (
            <Text
              variant="caption"
              tone="secondary"
              uppercase
              weight="semibold"
              style={{ marginBottom: 8 }}
            >
              {filtered.length} of {plans.length}
            </Text>
          ) : null
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
});
