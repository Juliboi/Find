import React from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useColorScheme,
} from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useTheme } from '@/theme/useTheme';
import { TopBar } from '@/components/TopBar';
import { Card } from '@/components/Card';
import { Text } from '@/components/Text';
import { FloatingTabBar } from '@/components/FloatingTabBar';
import { PRIMARY_TABS } from '@/components/nav/tabs';
import { isSupabaseConfigured } from '@/lib/supabase';

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
          <Text variant="caption" tone="secondary">
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
  const supabaseOn = isSupabaseConfigured;

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
        kicker="Profile"
        title="Settings"
        actions={[
          {
            icon: 'flask-outline',
            onPress: () => router.push('/test'),
            accessibilityLabel: 'Open sandbox',
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
      >
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
              AI &amp; Sync
            </Text>
          </View>
          <Row
            first
            icon={supabaseOn ? 'cloud-done' : 'cloud-offline'}
            iconBg={
              supabaseOn ? t.colors.successSoft : t.colors.fill1
            }
            iconColor={supabaseOn ? t.colors.success : t.colors.textSecondary}
            title="Supabase"
            subtitle={
              supabaseOn
                ? 'Connected — schedule-day Edge Function will be used'
                : 'Not configured — using local heuristic scheduler'
            }
            trailing={
              <View
                style={[
                  styles.pill,
                  {
                    backgroundColor: supabaseOn
                      ? t.colors.successSoft
                      : t.colors.fill1,
                  },
                ]}
              >
                <Text
                  variant="micro"
                  weight="bold"
                  uppercase
                  style={{
                    color: supabaseOn ? t.colors.success : t.colors.textSecondary,
                  }}
                >
                  {supabaseOn ? 'On' : 'Off'}
                </Text>
              </View>
            }
          />
          <Row
            icon="flask-outline"
            iconBg={t.colors.infoSoft}
            iconColor={t.colors.info}
            title="Sandbox"
            subtitle="Inspect AI scheduling for a single plan"
            onPress={() => router.push('/test')}
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
            icon="location-outline"
            iconBg={t.colors.accentSoft}
            iconColor={t.colors.accentText}
            title="Anchors"
            subtitle="Home + end of day location"
            onPress={() => router.push('/places')}
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

      <FloatingTabBar tabs={PRIMARY_TABS} onFabPress={goAdd} />
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
});
