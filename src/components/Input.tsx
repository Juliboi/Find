import React, { forwardRef } from 'react';
import {
  StyleSheet,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/theme/useTheme';

interface Props extends TextInputProps {
  /** Icon shown on the leading edge of the input. */
  leftIcon?: keyof typeof import('@expo/vector-icons/build/Ionicons').default.glyphMap;
  /** Visual variant — `filled` matches the search bar style from the spec. */
  variant?: 'filled' | 'plain';
  containerStyle?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
}

export const Input = forwardRef<TextInput, Props>(function Input(
  { containerStyle, textStyle, style, leftIcon, variant = 'filled', ...rest },
  ref,
) {
  const { colors, radii, spacing } = useTheme();

  const isFilled = variant === 'filled';

  return (
    <View
      style={[
        styles.container,
        {
          backgroundColor: isFilled ? colors.fill1 : 'transparent',
          borderRadius: radii.md,
          paddingHorizontal: leftIcon ? spacing.md : spacing.lg,
        },
        containerStyle,
      ]}
    >
      {leftIcon ? (
        <Ionicons
          name={leftIcon}
          size={18}
          color={colors.textSecondary}
          style={{ marginRight: spacing.sm }}
        />
      ) : null}
      <TextInput
        ref={ref}
        placeholderTextColor={colors.textTertiary}
        style={[
          styles.input,
          { color: colors.textPrimary },
          textStyle,
          style,
        ]}
        {...rest}
      />
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 48,
  },
  input: {
    flex: 1,
    fontSize: 17,
    paddingVertical: 12,
  },
});
