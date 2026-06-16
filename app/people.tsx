import React from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '@/theme/useTheme';
import { TopBar } from '@/components/TopBar';
import { Text } from '@/components/Text';
import { PeopleManager } from '@/components/PeopleManager';

/** Settings screen for managing saved people (contacts + their fixed place). */
export default function PeopleScreen() {
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
        title="People"
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
          Save people with a fixed place. When you write “at Ondra’s place”, Diem fills
          in their spot — but not for “with Ondra”.
        </Text>
        <PeopleManager editId={typeof edit === 'string' ? edit : null} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { paddingBottom: 40 },
  intro: { marginBottom: 14 },
});
