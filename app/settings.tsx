import React, { useState } from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useColorScheme,
} from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useTheme } from '@/theme/useTheme';
import { TopBar } from '@/components/TopBar';
import { Card } from '@/components/Card';
import { Text } from '@/components/Text';
import { Sheet } from '@/components/Sheet';
import { HomePicker, type AnchorSlot } from '@/components/HomePicker';
import { useAuthStore } from '@/store/useAuthStore';
import { useProfileStore } from '@/store/useProfileStore';
import { useHomeStore } from '@/store/useHomeStore';
import { formatTime } from '@/utils/time';

interface RowProps {
  icon: keyof typeof Ionicons.glyphMap;
  iconColor?: string;
  iconBg?: string;
  title: string;
  subtitle?: string;
  trailing?: React.ReactNode;
  onPress?: () => void;
  /** Position in the group — controls divider visibility. */
  first?: boolean;
  last?: boolean;
}

function Row({
  icon,
  iconColor,
  iconBg,
  title,
  subtitle,
  trailing,
  onPress,
  first,
}: RowProps) {
  const t = useTheme();
  const content = (
    <View style={styles.row}>
      <View
        style={[
          styles.rowIcon,
          {
            backgroundColor: iconBg ?? t.colors.fill1,
          },
        ]}
      >
        <Ionicons
          name={icon}
          size={16}
          color={iconColor ?? t.colors.textPrimary}
        />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="body" weight="semibold">
          {title}
        </Text>
        {subtitle ? (
          <Text variant="caption" tone="secondary" numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {trailing ? <View>{trailing}</View> : null}
      {onPress ? (
        <Ionicons
          name="chevron-forward"
          size={18}
          color={t.colors.textTertiary}
        />
      ) : null}
    </View>
  );

  const wrapStyle = [
    styles.rowWrap,
    !first && {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: t.colors.separator,
    },
  ];

  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        style={({ pressed }) => [wrapStyle, pressed && { opacity: 0.8 }]}
      >
        {content}
      </Pressable>
    );
  }
  return <View style={wrapStyle}>{content}</View>;
}

export default function SettingsScreen() {
  const router = useRouter();
  const t = useTheme();
  const systemScheme = useColorScheme();
  const insets = useSafeAreaInsets();

  const user = useAuthStore((s) => s.user);
  const signOut = useAuthStore((s) => s.signOut);
  const fullName = useProfileStore((s) => s.fullName);
  const wakeTime = useProfileStore((s) => s.wakeTime);
  const bedTime = useProfileStore((s) => s.bedTime);
  const hasCar = useProfileStore((s) => s.hasCar);
  const dietary = useProfileStore((s) => s.dietary);
  const dietaryNotes = useProfileStore((s) => s.dietaryNotes);
  const home = useHomeStore((s) => s.home);
  const work = useHomeStore((s) => s.work);

  // Which anchor the location-picker sheet is editing (null = closed).
  const [anchorSlot, setAnchorSlot] = useState<AnchorSlot | null>(null);

  const dietarySummary = dietary.length
    ? dietary.join(', ')
    : dietaryNotes
      ? dietaryNotes
      : 'No restrictions';

  const accountName =
    fullName ??
    (typeof user?.user_metadata?.full_name === 'string'
      ? (user.user_metadata.full_name as string)
      : null);
  const accountEmail = user?.email ?? null;
  const accountInitial = (accountName ?? accountEmail ?? '?')
    .trim()
    .charAt(0)
    .toUpperCase();

  // Jump straight to the matching onboarding step to edit a single preference;
  // onboarding runs in "edit" mode and returns here on Save/Cancel.
  const editPref = (key: 'rhythm' | 'car' | 'diet') => {
    Haptics.selectionAsync().catch(() => undefined);
    router.push({ pathname: '/onboarding', params: { edit: key } });
  };

  const confirmSignOut = () => {
    Haptics.selectionAsync().catch(() => undefined);
    Alert.alert('Sign out?', 'You can sign back in anytime.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign out',
        style: 'destructive',
        onPress: () => {
          void signOut();
          Haptics.notificationAsync(
            Haptics.NotificationFeedbackType.Warning,
          ).catch(() => undefined);
        },
      },
    ]);
  };

  return (
    <SafeAreaView
      style={[styles.container, { backgroundColor: t.colors.background }]}
      edges={['top']}
    >
      <TopBar
        kicker="Profile"
        title="Settings"
        left={{
          icon: 'chevron-back',
          onPress: () => router.back(),
          accessibilityLabel: 'Back',
        }}
      />

      <ScrollView
        contentContainerStyle={[
          styles.scrollContent,
          {
            paddingHorizontal: t.spacing.lg,
            paddingTop: t.spacing.sm,
            paddingBottom: 40,
          },
        ]}
      >
        {user ? (
          <Card padded style={{ padding: 0 }}>
            <View style={{ padding: t.spacing.lg, paddingBottom: t.spacing.sm }}>
              <Text
                variant="caption"
                tone="secondary"
                uppercase
                weight="semibold"
              >
                Account
              </Text>
            </View>
            <View style={[styles.accountRow, { paddingHorizontal: 16 }]}>
              <View
                style={[styles.avatar, { backgroundColor: t.colors.accentSoft }]}
              >
                <Text variant="title3" weight="bold" tone="accent">
                  {accountInitial}
                </Text>
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <Text variant="body" weight="semibold" numberOfLines={1}>
                  {accountName ?? 'Signed in'}
                </Text>
                {accountEmail ? (
                  <Text variant="caption" tone="secondary" numberOfLines={1}>
                    {accountEmail}
                  </Text>
                ) : null}
              </View>
            </View>
            <Row
              icon="log-out-outline"
              iconBg={t.colors.dangerSoft}
              iconColor={t.colors.danger}
              title="Sign out"
              onPress={confirmSignOut}
            />
          </Card>
        ) : null}

        <Card padded style={{ padding: 0 }}>
          <View style={{ padding: t.spacing.lg, paddingBottom: t.spacing.sm }}>
            <Text variant="caption" tone="secondary" uppercase weight="semibold">
              Daily preferences
            </Text>
          </View>
          <Row
            first
            icon="sunny-outline"
            iconBg={t.colors.warningSoft}
            iconColor={t.colors.warning}
            title="Wake up"
            subtitle="Seeds your default day start"
            onPress={() => editPref('rhythm')}
            trailing={
              <Text variant="body" weight="semibold" tone="secondary">
                {wakeTime ? formatTime(wakeTime) : 'Not set'}
              </Text>
            }
          />
          <Row
            icon="moon-outline"
            iconBg={t.colors.fill1}
            title="Bed time"
            subtitle="When you want to wind down"
            onPress={() => editPref('rhythm')}
            trailing={
              <Text variant="body" weight="semibold" tone="secondary">
                {bedTime ? formatTime(bedTime) : 'Not set'}
              </Text>
            }
          />
          <Row
            icon={hasCar ? 'car-sport' : 'walk'}
            iconBg={t.colors.infoSoft}
            iconColor={t.colors.info}
            title="Transport"
            subtitle={
              hasCar
                ? 'Driven only when it helps — toggle per day'
                : 'Walking and transit between stops'
            }
            onPress={() => editPref('car')}
            trailing={
              <Text variant="body" weight="semibold" tone="secondary">
                {hasCar ? 'Has a car' : 'No car'}
              </Text>
            }
          />
          <Row
            icon="restaurant-outline"
            iconBg={t.colors.successSoft}
            iconColor={t.colors.success}
            title="Dietary"
            subtitle="Filters food and drink stops"
            onPress={() => editPref('diet')}
            trailing={
              <Text
                variant="body"
                weight="semibold"
                tone="secondary"
                numberOfLines={1}
                style={styles.dietaryValue}
              >
                {dietarySummary}
              </Text>
            }
          />
        </Card>

        <Card padded style={{ padding: 0 }}>
          <View style={{ padding: t.spacing.lg, paddingBottom: t.spacing.sm }}>
            <Text variant="caption" tone="secondary" uppercase weight="semibold">
              Appearance
            </Text>
          </View>
          <Row
            first
            icon={t.isDark ? 'moon' : 'sunny'}
            iconBg={t.colors.accentSoft}
            iconColor={t.colors.accentText}
            title="Theme"
            subtitle={`Following system (${systemScheme ?? 'unknown'})`}
            trailing={
              <View
                style={[
                  styles.pill,
                  {
                    backgroundColor: t.colors.fill1,
                  },
                ]}
              >
                <Text variant="micro" weight="bold" tone="secondary" uppercase>
                  Auto
                </Text>
              </View>
            }
          />
          <Row
            icon="color-palette-outline"
            iconBg={t.colors.fill1}
            title="Accent color"
            subtitle="System blue · matches iOS look"
          />
        </Card>

        <Card padded style={{ padding: 0 }}>
          <View style={{ padding: t.spacing.lg, paddingBottom: t.spacing.sm }}>
            <Text variant="caption" tone="secondary" uppercase weight="semibold">
              Places
            </Text>
          </View>
          <Row
            first
            icon="home-outline"
            iconBg={t.colors.accentSoft}
            iconColor={t.colors.accentText}
            title="Home"
            subtitle={home ? home.label : 'Set your home base'}
            onPress={() => {
              Haptics.selectionAsync().catch(() => undefined);
              setAnchorSlot('home');
            }}
          />
          <Row
            icon="briefcase-outline"
            iconBg={t.colors.fill1}
            title="Work"
            subtitle={work ? work.label : 'Optional — for office plans'}
            onPress={() => {
              Haptics.selectionAsync().catch(() => undefined);
              setAnchorSlot('work');
            }}
          />
        </Card>

        <Card padded style={{ padding: 0 }}>
          <View style={{ padding: t.spacing.lg, paddingBottom: t.spacing.sm }}>
            <Text variant="caption" tone="secondary" uppercase weight="semibold">
              About
            </Text>
          </View>
          <Row
            first
            icon="information-circle-outline"
            title="Diem"
            subtitle="v0.1.0 · A dynamic day planner"
          />
        </Card>
      </ScrollView>

      <Sheet
        open={anchorSlot !== null}
        onClose={() => setAnchorSlot(null)}
        heightFraction={0.99}
        enableContentPanningGesture={false}
      >
        <BottomSheetScrollView
          contentContainerStyle={{
            paddingHorizontal: t.spacing.lg,
            paddingTop: t.spacing.sm,
            paddingBottom: insets.bottom + 24,
          }}
          keyboardShouldPersistTaps="handled"
        >
          {anchorSlot ? <HomePicker slot={anchorSlot} flat /> : null}
        </BottomSheetScrollView>
      </Sheet>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scrollContent: {
    gap: 16,
  },
  rowWrap: {
    paddingHorizontal: 16,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    gap: 12,
  },
  rowIcon: {
    width: 32,
    height: 32,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pill: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
  },
  dietaryValue: {
    maxWidth: 170,
    textAlign: 'right',
  },
  accountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 8,
    paddingBottom: 14,
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
