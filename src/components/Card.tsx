import React from 'react';
import {
  Pressable,
  StyleSheet,
  View,
  type PressableProps,
  type StyleProp,
  type ViewProps,
  type ViewStyle,
} from 'react-native';
import { useTheme } from '@/theme/useTheme';

type Tier = 'surface1' | 'surface2' | 'surface3';

interface BaseProps {
  /** Which surface elevation to use. Defaults to `surface1`. */
  tier?: Tier;
  /** Use a smaller radius (md) instead of the default (lg). */
  small?: boolean;
  /** Hide the hairline border. */
  borderless?: boolean;
  /** Apply default 16px padding inside the card. */
  padded?: boolean;
  children?: React.ReactNode;
}

type Props = BaseProps & {
  /** If provided, the card becomes a Pressable. */
  onPress?: PressableProps['onPress'];
  onLongPress?: PressableProps['onLongPress'];
  style?: StyleProp<ViewStyle>;
} & Omit<ViewProps, 'style'>;

/**
 * Canonical card primitive. Use it for *every* grouped content block —
 * this is the most important rule of mobile UI per the spec: cards group
 * content where whitespace alone isn't enough.
 *
 * Try to avoid nesting `Card` inside another `Card`. If you need to
 * indicate a sub-region, use a `fill1` `View` instead.
 */
export function Card({
  tier = 'surface1',
  small,
  borderless,
  padded,
  onPress,
  onLongPress,
  style,
  children,
  ...rest
}: Props) {
  const { colors, radii, spacing } = useTheme();
  const radius = small ? radii.md : radii.lg;
  const containerStyle: StyleProp<ViewStyle> = [
    styles.base,
    {
      backgroundColor: colors[tier],
      borderRadius: radius,
      borderWidth: borderless ? 0 : StyleSheet.hairlineWidth,
      borderColor: colors.separator,
    },
    padded ? { padding: spacing.lg } : null,
    style,
  ];

  if (onPress || onLongPress) {
    return (
      <Pressable
        onPress={onPress}
        onLongPress={onLongPress}
        style={({ pressed }) => [containerStyle, pressed && { opacity: 0.92 }]}
        {...rest}
      >
        {children}
      </Pressable>
    );
  }

  return (
    <View style={containerStyle} {...rest}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    overflow: 'hidden',
  },
});
