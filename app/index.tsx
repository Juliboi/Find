import React from 'react';
import {
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useDayStore } from '@/store/useDayStore';
import { useTheme } from '@/theme/useTheme';
import { PlanCard } from '@/components/PlanCard';
import { Button } from '@/components/Button';
import { EmptyState } from '@/components/EmptyState';

function formatDateLong(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}

export default function HomeScreen() {
  const router = useRouter();
  const { colors } = useTheme();

  const date = useDayStore((s) => s.date);
  const plans = useDayStore((s) => s.plans);
  const summary = useDayStore((s) => s.summary);
  const isScheduling = useDayStore((s) => s.isScheduling);
  const usedAi = useDayStore((s) => s.usedAi);
  const resolveClarification = useDayStore((s) => s.resolveClarification);
  const removePlan = useDayStore((s) => s.removePlan);
  const reorderAndReschedule = useDayStore((s) => s.reorderAndReschedule);
  const resetDay = useDayStore((s) => s.resetDay);

  const isEmpty = plans.length === 0;

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={['top']}>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.kicker, { color: colors.textMuted }]}>
            {formatDateLong(date)}
          </Text>
          <Text style={[styles.title, { color: colors.text }]}>Your day</Text>
          {summary ? (
            <Text style={[styles.summary, { color: colors.textMuted }]}>
              {summary}
              {!usedAi && plans.length > 0 ? ' · offline mode' : ''}
            </Text>
          ) : null}
        </View>
        {!isEmpty ? (
          <Pressable
            hitSlop={8}
            onPress={resetDay}
            style={({ pressed }) => [pressed && { opacity: 0.6 }]}
          >
            <Text style={[styles.headerAction, { color: colors.textMuted }]}>
              Clear
            </Text>
          </Pressable>
        ) : null}
      </View>

      <FlatList
        data={plans}
        keyExtractor={(item) => item.id}
        contentContainerStyle={[
          styles.listContent,
          isEmpty && { flexGrow: 1, justifyContent: 'center' },
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
            tintColor={colors.accent}
          />
        }
        ListEmptyComponent={
          <EmptyState
            title="What are you up to today?"
            body="Add the things you want to do. DayFlow will order them, fill in the missing steps, and estimate how long each will take."
            action={
              <Button
                title="Add today's plans"
                onPress={() => router.push('/add')}
              />
            }
          />
        }
      />

      {!isEmpty ? (
        <View style={styles.fabWrap}>
          <Button
            title="Add more plans"
            onPress={() => router.push('/add')}
            style={styles.fab}
          />
        </View>
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 16,
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  kicker: {
    fontSize: 13,
    fontWeight: '500',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  title: {
    fontSize: 30,
    fontWeight: '700',
    marginTop: 2,
  },
  summary: {
    fontSize: 14,
    marginTop: 6,
  },
  headerAction: {
    fontSize: 14,
    fontWeight: '500',
    paddingTop: 6,
  },
  listContent: {
    paddingHorizontal: 20,
    paddingBottom: 120,
  },
  fabWrap: {
    position: 'absolute',
    left: 20,
    right: 20,
    bottom: 24,
  },
  fab: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 4,
  },
});
