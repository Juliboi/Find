import React, { forwardRef } from 'react';
import { StyleSheet, TextInput, TextInputProps, View, ViewStyle } from 'react-native';
import { useTheme } from '@/theme/useTheme';

interface Props extends TextInputProps {
  containerStyle?: ViewStyle;
}

export const Input = forwardRef<TextInput, Props>(function Input(
  { containerStyle, style, ...rest },
  ref,
) {
  const { colors } = useTheme();
  return (
    <View
      style={[
        styles.container,
        {
          backgroundColor: colors.surface,
          borderColor: colors.border,
        },
        containerStyle,
      ]}
    >
      <TextInput
        ref={ref}
        placeholderTextColor={colors.textMuted}
        style={[styles.input, { color: colors.text }, style]}
        {...rest}
      />
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    borderRadius: 14,
    borderWidth: 1,
    paddingHorizontal: 14,
    minHeight: 48,
    justifyContent: 'center',
  },
  input: {
    fontSize: 16,
    paddingVertical: 12,
  },
});
