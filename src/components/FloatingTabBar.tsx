import React from 'react';
import {
  Pressable,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { useRouter, usePathname, type Href } from 'expo-router';
import { useTheme } from '@/theme/useTheme';
import { GlassSurface } from './Glass';
import { Text } from './Text';

export interface TabItem {
  /** Pathname to navigate to, e.g. `"/"`, `"/plans"`. */
  href: Href;
  /** Display label. */
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
}

interface Props {
  tabs: TabItem[];
  /** Optional handler for the floating "+" action. If omitted, FAB is hidden. */
  onFabPress?: () => void;
  fabIcon?: keyof typeof Ionicons.glyphMap;
  /** Hide the bar entirely (useful for modal sub-screens). */
  hidden?: boolean;
  style?: StyleProp<ViewStyle>;
}

/**
 * The floating glass tab bar shown at the bottom of every primary screen,
 * with a separate, larger FAB to the right for the most important action
 * (per the video's "important action broken out" pattern).
 *
 * Why floating + glass: it matches modern iOS (Music, Maps, App Store) and
 * keeps the visual weight low so content scrolls behind it nicely.
 */
export function FloatingTabBar({
  tabs,
  onFabPress,
  fabIcon = 'add',
  hidden,
  style,
}: Props) {
  const t = useTheme();
  const router = useRouter();
  const pathname = usePathname();
  const insets = useSafeAreaInsets();

  if (hidden) return null;

  const isActive = (href: string) => {
    if (href === '/') return pathname === '/' || pathname === '/index';
    return pathname === href;
  };

  return (
    <View
      pointerEvents="box-none"
      style={[
        styles.container,
        { paddingBottom: Math.max(insets.bottom, t.spacing.md) },
        style,
      ]}
    >
      <View style={styles.row}>
        <View
          style={[
            styles.barShadow,
            {
              shadowColor: t.colors.shadow,
              borderRadius: t.radii.xxl,
            },
          ]}
        >
        <GlassSurface
          variant="thick"
          radius={t.radii.xxl}
          innerStyle={styles.barInner}
          style={styles.bar}
        >
          {tabs.map((tab) => {
            const active = isActive(tab.href as string);
            return (
              <Pressable
                key={tab.href as string}
                onPress={() => {
                  if (active) return;
                  Haptics.selectionAsync().catch(() => undefined);
                  router.push(tab.href);
                }}
                style={({ pressed }) => [
                  styles.tab,
                  pressed && { opacity: 0.65 },
                ]}
                accessibilityRole="tab"
                accessibilityState={{ selected: active }}
                accessibilityLabel={tab.label}
                hitSlop={6}
              >
                <View
                  style={[
                    styles.tabInner,
                    active && {
                      backgroundColor: t.colors.fill1,
                      borderRadius: t.radii.pill,
                    },
                  ]}
                >
                  <Ionicons
                    name={tab.icon}
                    size={22}
                    color={active ? t.colors.textPrimary : t.colors.textSecondary}
                  />
                  <Text
                    variant="micro"
                    tone={active ? 'primary' : 'secondary'}
                    style={styles.tabLabel}
                  >
                    {tab.label}
                  </Text>
                </View>
              </Pressable>
            );
          })}
        </GlassSurface>
        </View>

        {onFabPress ? (
          <Pressable
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(
                () => undefined,
              );
              onFabPress();
            }}
            accessibilityLabel="Add"
            accessibilityRole="button"
            style={({ pressed }) => [
              styles.fabWrap,
              { shadowColor: t.colors.shadow },
              pressed && { opacity: 0.85, transform: [{ scale: 0.96 }] },
            ]}
          >
            <GlassSurface
              variant="thick"
              radius={FAB_SIZE / 2}
              style={styles.fabInner}
              innerStyle={styles.fabContent}
            >
              <Ionicons name={fabIcon} size={28} color={t.colors.textPrimary} />
            </GlassSurface>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const BAR_HEIGHT = 64;
const FAB_SIZE = 64;

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 16,
    pointerEvents: 'box-none',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  barShadow: {
    flex: 1,
    height: BAR_HEIGHT,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.18,
    shadowRadius: 24,
    elevation: 12,
  },
  bar: {
    flex: 1,
    height: BAR_HEIGHT,
  },
  barInner: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 6,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    height: BAR_HEIGHT,
  },
  tabInner: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
    paddingVertical: 8,
    minWidth: 56,
    minHeight: 48,
  },
  tabLabel: {
    marginTop: 2,
  },
  fabWrap: {
    width: FAB_SIZE,
    height: FAB_SIZE,
    borderRadius: FAB_SIZE / 2,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.2,
    shadowRadius: 24,
    elevation: 12,
  },
  fabInner: {
    width: FAB_SIZE,
    height: FAB_SIZE,
  },
  fabContent: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
