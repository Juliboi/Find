import React from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/theme/useTheme';
import { TopBar } from '@/components/TopBar';
import { HomePicker } from '@/components/HomePicker';
import { Card } from '@/components/Card';
import { Text } from '@/components/Text';
import { FloatingTabBar } from '@/components/FloatingTabBar';
import { PRIMARY_TABS } from '@/components/nav/tabs';
import { useHomeStore, selectEndOfDay } from '@/store/useHomeStore';

export default function PlacesScreen() {
  const router = useRouter();
  const t = useTheme();

  const endOfDay = useHomeStore((s) => selectEndOfDay(s));

  const goAdd = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
    router.push('/add');
  };

  return (
    <SafeAreaView
      style={[styles.container, { backgroundColor: t.colors.background }]}
      edges={['top']}
    >
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <TopBar
          kicker="Anchors"
          title="Places"
          actions={[
            {
              icon: 'help-circle-outline',
              accessibilityLabel: 'Help',
            },
          ]}
        />

        <ScrollView
          contentContainerStyle={[
            styles.scrollContent,
            {
              paddingHorizontal: t.spacing.lg,
              paddingTop: t.spacing.sm,
              paddingBottom: 140,
            },
          ]}
          keyboardShouldPersistTaps="handled"
        >
          <HomePicker slot="home" title="Home" />
          <HomePicker slot="work" title="Work" />

          <Card padded>
            <View style={styles.row}>
              <View
                style={[styles.iconWrap, { backgroundColor: t.colors.fill1 }]}
              >
                <Ionicons name="moon" size={18} color={t.colors.textPrimary} />
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <Text variant="body" weight="semibold">
                  End of day
                </Text>
                <Text variant="caption" tone="secondary" numberOfLines={2}>
                  {endOfDay
                    ? endOfDay.label
                    : 'Defaults to Home. Used to plan the last activity of your day.'}
                </Text>
              </View>
            </View>
          </Card>

          <Card padded>
            <Text variant="title3" weight="bold" tight>
              Why this matters
            </Text>
            <Text variant="bodySm" tone="secondary" style={{ marginTop: 6 }}>
              Diem uses Home and Work to anchor your day. Home is the
              default for plans like "deep work" or "read", and the day
              always closes with travel home. Work is the default for
              plans like "poker with colleagues at office" — without it,
              Diem can't compute travel to office activities.
            </Text>
          </Card>
        </ScrollView>
      </KeyboardAvoidingView>

      <FloatingTabBar tabs={PRIMARY_TABS} onFabPress={goAdd} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scrollContent: {
    gap: 16,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  iconWrap: {
    width: 40,
    height: 40,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
