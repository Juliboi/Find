import React from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '@/theme/useTheme';
import { TopBar } from '@/components/TopBar';
import { Text } from '@/components/Text';
import { RecurringErrandManager } from '@/components/RecurringErrandManager';

/** Settings screen for managing recurring errand templates. */
export default function RecurringErrandsScreen() {
  const t = useTheme();
  const router = useRouter();
  const { edit } = useLocalSearchParams<{ edit?: string }>();

  return (
    <SafeAreaView
      style={[styles.container, { backgroundColor: t.colors.background }]}
      edges={['top']}
    >
      <TopBar
        kicker="Profile"
        title="Recurring errands"
        left={{
          icon: 'chevron-back',
          onPress: () => router.back(),
          accessibilityLabel: 'Back',
        }}
      />
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingHorizontal: t.spacing.lg, paddingTop: t.spacing.sm },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        <Text variant="bodySm" tone="secondary" style={styles.intro}>
          Set up things that repeat on a weekday. They show above your errands on those
          days and are preselected when you plan.
        </Text>
        <RecurringErrandManager editId={typeof edit === 'string' ? edit : null} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { paddingBottom: 40 },
  intro: { marginBottom: 14 },
});
