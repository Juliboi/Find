import React from 'react';
import {
  Platform,
  StyleSheet,
  View,
  type StyleProp,
  type ViewProps,
  type ViewStyle,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { useTheme } from '@/theme/useTheme';

type GlassVariant =
  | 'thin' // subtle, e.g. floating bar background over a busy screen
  | 'regular' // default — cards, sheets
  | 'thick'; // for modal backgrounds / full overlays

interface Props extends ViewProps {
  variant?: GlassVariant;
  /** Override the radius. Defaults to whatever the parent style provides. */
  radius?: number;
  /** Add a hairline border with `glassBorder` color. Defaults to true. */
  bordered?: boolean;
  /** Add subtle top highlight (white inner glow). Defaults to true on dark. */
  highlight?: boolean;
  /** Custom outer style (margins, position, etc.) */
  style?: StyleProp<ViewStyle>;
  /** Style applied to the inner tint layer (e.g. padding for content). */
  innerStyle?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
}

const INTENSITY: Record<GlassVariant, number> = {
  thin: 30,
  regular: 55,
  thick: 80,
};

/**
 * Apple "liquid glass" surface. Uses `expo-blur` to physically blur what's
 * behind it (on supported platforms), with a semi-transparent tint, a hairline
 * border, and an optional top highlight for that subtle inner glow you see
 * on iOS sheets and the iOS 17 floating tab bar.
 *
 * On platforms where blur isn't available (Android < 12, web fallback) we
 * gracefully degrade to a solid tinted surface.
 */
export function GlassSurface({
  variant = 'regular',
  radius,
  bordered = true,
  highlight,
  style,
  innerStyle,
  children,
  ...rest
}: Props) {
  const { colors, isDark } = useTheme();
  const intensity = INTENSITY[variant];
  const showHighlight = highlight ?? isDark;

  // expo-blur 'tint' picks system materials. We then overlay our own tint
  // because we want the color to match the theme exactly.
  const blurTint: 'light' | 'dark' | 'default' = isDark ? 'dark' : 'light';

  const containerRadiusStyle =
    typeof radius === 'number' ? { borderRadius: radius } : null;

  // Some Android versions cap BlurView quality — when that's the case
  // we fall back to a stronger tint so things still look intentional.
  const fallbackToSolid = Platform.OS === 'android' && Platform.Version < 31;
  const tint = fallbackToSolid
    ? isDark
      ? 'rgba(28, 28, 34, 0.95)'
      : 'rgba(255, 255, 255, 0.95)'
    : colors.glassTint;

  return (
    <View
      {...rest}
      style={[
        styles.wrapper,
        containerRadiusStyle,
        bordered && {
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.glassBorder,
        },
        style,
      ]}
    >
      {!fallbackToSolid ? (
        <BlurView
          tint={blurTint}
          intensity={intensity}
          style={[StyleSheet.absoluteFill, containerRadiusStyle]}
        />
      ) : null}
      <View
        style={[StyleSheet.absoluteFill, { backgroundColor: tint }, containerRadiusStyle]}
      />
      {showHighlight ? (
        <View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            styles.highlight,
            containerRadiusStyle,
            { borderColor: colors.glassHighlight },
          ]}
        />
      ) : null}
      <View style={[styles.content, innerStyle]}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    overflow: 'hidden',
    position: 'relative',
  },
  highlight: {
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  content: {
    position: 'relative',
    zIndex: 1,
  },
});
