import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useTheme } from '@/theme/useTheme';
import { Text } from './Text';

type Variant = 'primary' | 'secondary' | 'tonal' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

interface Props {
  title: string;
  onPress?: () => void;
  variant?: Variant;
  size?: Size;
  disabled?: boolean;
  loading?: boolean;
  style?: StyleProp<ViewStyle>;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
  fullWidth?: boolean;
}

const SIZE_MAP: Record<Size, { height: number; padding: number; font: 'body' | 'bodySm' }> = {
  sm: { height: 36, padding: 14, font: 'bodySm' },
  md: { height: 48, padding: 18, font: 'body' },
  lg: { height: 56, padding: 22, font: 'body' },
};

/**
 * Primary action button. Variants:
 *   - primary  : accent-filled, white text. Use for THE main CTA per screen.
 *   - secondary: outlined surface (use when there's a primary nearby).
 *   - tonal    : soft accent-tinted background, accent text (subtle CTA).
 *   - ghost    : text-only.
 *   - danger   : destructive text-only.
 */
export function Button({
  title,
  onPress,
  variant = 'primary',
  size = 'md',
  disabled,
  loading,
  style,
  leftIcon,
  rightIcon,
  fullWidth,
}: Props) {
  const { colors, radii } = useTheme();
  const dims = SIZE_MAP[size];

  let bg: string = 'transparent';
  let textTone: React.ComponentProps<typeof Text>['tone'] = 'primary';
  let textColor: string | undefined;
  let borderColor: string | undefined;
  let borderWidth = 0;

  switch (variant) {
    case 'primary':
      bg = colors.accent;
      textColor = colors.textOnAccent;
      break;
    case 'secondary':
      bg = colors.surface1;
      borderColor = colors.border;
      borderWidth = StyleSheet.hairlineWidth;
      textTone = 'primary';
      break;
    case 'tonal':
      bg = colors.accentSoft;
      textTone = 'accent';
      break;
    case 'ghost':
      bg = 'transparent';
      textTone = 'primary';
      break;
    case 'danger':
      bg = 'transparent';
      textTone = 'danger';
      break;
  }

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        styles.base,
        {
          height: dims.height,
          paddingHorizontal: dims.padding,
          borderRadius: radii.pill,
          backgroundColor: bg,
          borderColor,
          borderWidth,
        },
        fullWidth && { alignSelf: 'stretch' },
        (disabled || loading) && { opacity: 0.5 },
        pressed && { opacity: 0.85 },
        style,
      ]}
    >
      <View style={styles.row}>
        {loading ? (
          <ActivityIndicator
            color={textColor ?? (variant === 'primary' ? colors.textOnAccent : colors.accent)}
          />
        ) : (
          <>
            {leftIcon}
            <Text
              variant={dims.font}
              weight="semibold"
              tone={textTone}
              style={textColor ? { color: textColor } : undefined}
            >
              {title}
            </Text>
            {rightIcon}
          </>
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
});
