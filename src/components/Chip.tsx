import React from 'react';
import { Pressable, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/theme/useTheme';
import { Text } from './Text';

interface Props {
  label: string;
  selected?: boolean;
  onPress?: () => void;
  /** Optional leading icon. */
  icon?: keyof typeof Ionicons.glyphMap;
  /** Render as a slightly larger, more prominent chip. */
  large?: boolean;
  style?: StyleProp<ViewStyle>;
}

/**
 * Pill-style chip used for quick suggestions, filters, and category tags.
 */
export function Chip({ label, selected, onPress, icon, large, style }: Props) {
  const { colors, radii } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        {
          backgroundColor: selected ? colors.accentSoft : colors.fill1,
          borderRadius: radii.pill,
          paddingVertical: large ? 10 : 8,
          paddingHorizontal: large ? 14 : 12,
        },
        pressed && { opacity: 0.7 },
        style,
      ]}
    >
      {icon ? (
        <Ionicons
          name={icon}
          size={14}
          color={selected ? colors.accentText : colors.textPrimary}
        />
      ) : null}
      <Text
        variant="bodySm"
        weight="semibold"
        tone={selected ? 'accent' : 'primary'}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
});
