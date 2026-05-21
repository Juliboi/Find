import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/theme/useTheme';
import { Text } from './Text';

interface Props {
  title: string;
  /** Show a right-pointing chevron after the title (acts like a "more" hint). */
  showChevron?: boolean;
  /** Tap handler — turns the whole row into a Pressable. */
  onPress?: () => void;
  /** Optional small right-side accessory (e.g. tabs "Recents / Suggested"). */
  accessory?: React.ReactNode;
}

/**
 * Section header in the style of the reference screenshots:
 * "Calendar >", "Tasks >", "Notes >". Bold title, chevron, optional
 * right accessory.
 */
export function SectionHeader({
  title,
  showChevron = true,
  onPress,
  accessory,
}: Props) {
  const { colors } = useTheme();
  const titleRow = (
    <View style={styles.row}>
      <View style={styles.left}>
        <Text variant="title3" weight="bold" tight>
          {title}
        </Text>
        {showChevron ? (
          <Ionicons name="chevron-forward" size={20} color={colors.textPrimary} />
        ) : null}
      </View>
      {accessory ? <View style={styles.accessory}>{accessory}</View> : null}
    </View>
  );

  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        hitSlop={6}
        style={({ pressed }) => [pressed && { opacity: 0.6 }]}
      >
        {titleRow}
      </Pressable>
    );
  }
  return titleRow;
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 6,
  },
  left: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  accessory: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
});
