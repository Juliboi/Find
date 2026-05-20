import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  ViewStyle,
} from 'react-native';
import { useTheme } from '@/theme/useTheme';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

interface Props {
  title: string;
  onPress?: () => void;
  variant?: Variant;
  disabled?: boolean;
  loading?: boolean;
  style?: ViewStyle;
  leftIcon?: React.ReactNode;
}

export function Button({
  title,
  onPress,
  variant = 'primary',
  disabled,
  loading,
  style,
  leftIcon,
}: Props) {
  const { colors } = useTheme();

  const variantStyles = (): { container: ViewStyle; textColor: string } => {
    switch (variant) {
      case 'primary':
        return {
          container: { backgroundColor: colors.accent },
          textColor: '#FFFFFF',
        };
      case 'secondary':
        return {
          container: {
            backgroundColor: colors.surface,
            borderWidth: 1,
            borderColor: colors.border,
          },
          textColor: colors.text,
        };
      case 'danger':
        return {
          container: { backgroundColor: 'transparent' },
          textColor: colors.danger,
        };
      case 'ghost':
      default:
        return {
          container: { backgroundColor: 'transparent' },
          textColor: colors.text,
        };
    }
  };

  const v = variantStyles();

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        styles.base,
        v.container,
        (disabled || loading) && { opacity: 0.5 },
        pressed && { opacity: 0.85 },
        style,
      ]}
    >
      <View style={styles.row}>
        {loading ? (
          <ActivityIndicator color={v.textColor} />
        ) : (
          <>
            {leftIcon}
            <Text style={[styles.text, { color: v.textColor }]}>{title}</Text>
          </>
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    height: 48,
    borderRadius: 14,
    paddingHorizontal: 18,
    justifyContent: 'center',
    alignItems: 'center',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  text: {
    fontSize: 16,
    fontWeight: '600',
  },
});
