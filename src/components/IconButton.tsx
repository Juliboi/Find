import React from 'react';
import {
  Pressable,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/theme/useTheme';
import { GlassSurface } from './Glass';

type Size = 'sm' | 'md' | 'lg';
type Variant = 'glass' | 'fill' | 'accent' | 'ghost';

interface Props {
  icon: keyof typeof Ionicons.glyphMap;
  size?: Size;
  variant?: Variant;
  onPress?: () => void;
  disabled?: boolean;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  /** Optional: tint override (otherwise computed from variant). */
  color?: string;
}

const SIZE_MAP: Record<Size, { box: number; icon: number }> = {
  sm: { box: 32, icon: 16 },
  md: { box: 40, icon: 19 },
  lg: { box: 52, icon: 24 },
};

/**
 * Circular icon button. Use `variant="glass"` for top-bar / floating
 * controls so they sit nicely on busy backgrounds. `accent` is the
 * primary action (e.g. the FAB confirmation). `ghost` is for inline
 * affordances in cards.
 */
export function IconButton({
  icon,
  size = 'md',
  variant = 'glass',
  onPress,
  disabled,
  accessibilityLabel,
  style,
  color,
}: Props) {
  const { colors } = useTheme();
  const { box, icon: iconSize } = SIZE_MAP[size];

  const tint = color ?? (variant === 'accent' ? colors.textOnAccent : colors.textPrimary);

  const inner = (
    <Ionicons name={icon} size={iconSize} color={tint} />
  );

  const baseStyle: StyleProp<ViewStyle> = [
    {
      width: box,
      height: box,
      borderRadius: box / 2,
      alignItems: 'center',
      justifyContent: 'center',
    },
    disabled && { opacity: 0.5 },
    style,
  ];

  const Content = (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      hitSlop={6}
      style={({ pressed }) => [
        baseStyle,
        pressed && !disabled && { opacity: 0.7 },
      ]}
    >
      {variant === 'glass' ? (
        <GlassSurface
          variant="regular"
          radius={box / 2}
          style={StyleSheet.absoluteFill}
          innerStyle={styles.fill}
        />
      ) : null}
      {variant === 'fill' ? (
        <View
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, { backgroundColor: colors.fill2, borderRadius: box / 2 }]}
        />
      ) : null}
      {variant === 'accent' ? (
        <View
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, { backgroundColor: colors.accent, borderRadius: box / 2 }]}
        />
      ) : null}
      {inner}
    </Pressable>
  );

  return Content;
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
});
