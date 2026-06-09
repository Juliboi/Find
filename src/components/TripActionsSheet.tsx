import React from 'react';
import { Image, Pressable, StyleSheet, View } from 'react-native';
import { BottomSheetView } from '@gorhom/bottom-sheet';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/theme/useTheme';
import { Sheet } from './Sheet';
import { Text } from './Text';
import type { SavedItinerary } from '@/store/useSavedItineraries';

interface Props {
  /** The trip the user long-pressed; null hides the sheet. */
  trip: SavedItinerary | null;
  onClose: () => void;
  /** Open the trip in the itinerary screen. */
  onOpen: () => void;
  /** Clone the trip into a new "(copy)" entry on the homepage. */
  onDuplicate: () => void;
  /** Permanently remove the trip from the saved list. */
  onDelete: () => void;
}

/**
 * Per-trip actions sheet: long-pressing a homepage trip card brings this up
 * so the user can manage saved plans (open, duplicate, delete) without having
 * to enter the itinerary first. Mirrors the per-card actions pattern used on
 * the itinerary screen so the two surfaces feel cohesive.
 */
export function TripActionsSheet({
  trip,
  onClose,
  onOpen,
  onDuplicate,
  onDelete,
}: Props) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const open = !!trip;
  return (
    <Sheet open={open} onClose={onClose}>
      <BottomSheetView style={[styles.content, { paddingBottom: insets.bottom + 12 }]}>
        <View style={styles.header}>
          <View style={[styles.thumb, { backgroundColor: t.colors.fill1 }]}>
            {trip?.thumbUrl ? (
              <Image source={{ uri: trip.thumbUrl }} style={styles.thumbImg} />
            ) : (
              <Ionicons name="map-outline" size={20} color={t.colors.textSecondary} />
            )}
          </View>
          <View style={{ flex: 1 }}>
            <Text variant="micro" tone="tertiary" uppercase weight="bold">
              Trip
            </Text>
            <Text variant="title3" weight="bold" tight numberOfLines={1}>
              {trip?.title ?? ''}
            </Text>
          </View>
          <Pressable onPress={onClose} hitSlop={10} style={styles.close}>
            <Ionicons name="close" size={20} color={t.colors.textSecondary} />
          </Pressable>
        </View>

        <ActionRow
          icon="open-outline"
          label="Open"
          onPress={() => {
            onClose();
            onOpen();
          }}
        />
        <ActionRow
          icon="copy-outline"
          label="Duplicate"
          sub="Makes an editable copy you can tweak separately."
          onPress={() => {
            onClose();
            onDuplicate();
          }}
        />
        <ActionRow
          icon="trash-outline"
          label="Delete"
          destructive
          onPress={() => {
            onClose();
            onDelete();
          }}
        />
      </BottomSheetView>
    </Sheet>
  );
}

function ActionRow({
  icon,
  label,
  sub,
  destructive,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  sub?: string;
  destructive?: boolean;
  onPress: () => void;
}) {
  const t = useTheme();
  const color = destructive ? t.colors.danger : t.colors.textPrimary;
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        { borderTopColor: t.colors.separator },
        pressed && { backgroundColor: t.colors.fill1 },
      ]}
    >
      <Ionicons
        name={icon}
        size={20}
        color={destructive ? t.colors.danger : t.colors.textSecondary}
      />
      <View style={{ flex: 1 }}>
        <Text variant="body" weight="semibold" style={{ color }}>
          {label}
        </Text>
        {sub ? (
          <Text variant="caption" tone="tertiary" numberOfLines={2}>
            {sub}
          </Text>
        ) : null}
      </View>
      {destructive ? null : (
        <Ionicons name="chevron-forward" size={18} color={t.colors.textTertiary} />
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: 16,
    paddingTop: 4,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 8,
  },
  thumb: {
    width: 42,
    height: 42,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  thumbImg: {
    width: '100%',
    height: '100%',
  },
  close: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 14,
    paddingHorizontal: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
