import React from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { useTheme } from '@/theme/useTheme';

interface Props {
  label: string;
  selected?: boolean;
  onPress?: () => void;
}

export function Chip({ label, selected, onPress }: Props) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        {
          backgroundColor: selected ? colors.accentSoft : colors.surface,
          borderColor: selected ? colors.accent : colors.border,
        },
        pressed && { opacity: 0.8 },
      ]}
    >
      <Text
        style={[
          styles.text,
          { color: selected ? colors.accent : colors.text },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
  },
  text: {
    fontSize: 14,
    fontWeight: '500',
  },
});
