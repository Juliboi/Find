import React, { useState } from 'react';
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import Animated, { FadeInUp } from 'react-native-reanimated';
import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/theme/useTheme';
import { Text } from './Text';
import type { ItineraryItem } from '@/types/itinerary';
import { formatDuration, minutesOfDay } from '@/utils/time';

interface Props {
  /** The item the user opened actions for; null hides the sheet. */
  item: ItineraryItem | null;
  onClose: () => void;
  /** Nudge the item's duration by the given signed delta in minutes. */
  onAdjustDuration: (deltaMin: number) => void;
  /** Pin the item to an absolute "HH:MM" start. */
  onMoveTime: (hhmm: string) => void;
  /** Open the place-swap browser. */
  onSwapPlace: () => void;
  /** Insert a free-time gap block immediately after this block. */
  onAddGapAfter: () => void;
  /** Remove the item from the day. */
  onRemove: () => void;
}

const DURATION_PRESETS = [-30, -15, +15, +30, +60];

/**
 * Per-card actions sheet: a unified surface for every edit a single block can
 * receive — duration nudges, an absolute time move, a venue swap, or removal.
 * The point is that EVERY card has one obvious entry point ("...") instead of
 * three different chip surfaces scattered across the screen.
 */
export function ItemActionsSheet({
  item,
  onClose,
  onAdjustDuration,
  onMoveTime,
  onSwapPlace,
  onAddGapAfter,
  onRemove,
}: Props) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const [showTimePicker, setShowTimePicker] = useState(false);

  const open = !!item;
  const currentDur = item?.durationMinutes ?? 30;

  const handleTimeChange = (_: DateTimePickerEvent, date?: Date) => {
    if (Platform.OS !== 'ios') setShowTimePicker(false);
    if (!date) return;
    const h = date.getHours();
    const m = date.getMinutes();
    onMoveTime(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
    if (Platform.OS === 'ios') setShowTimePicker(false);
  };

  const startMin = item ? minutesOfDay(item.startTime) ?? 9 * 60 : 9 * 60;
  const pickerDate = new Date();
  pickerDate.setHours(Math.floor(startMin / 60), startMin % 60, 0, 0);

  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <Animated.View
        entering={FadeInUp.duration(220)}
        style={[
          styles.sheet,
          {
            backgroundColor: t.colors.surface1,
            borderColor: t.colors.separator,
            paddingBottom: insets.bottom + 12,
          },
        ]}
      >
        <View style={[styles.grabber, { backgroundColor: t.colors.separator }]} />
        <View style={styles.header}>
          <View style={{ flex: 1 }}>
            <Text variant="micro" tone="tertiary" uppercase weight="bold">
              {item?.startTime
                ? `${item.startTime}${item.endTime ? ` – ${item.endTime}` : ''}`
                : 'Edit block'}
            </Text>
            <Text variant="title3" weight="bold" tight numberOfLines={1}>
              {item?.title ?? ''}
            </Text>
          </View>
          <Pressable onPress={onClose} hitSlop={10} style={styles.close}>
            <Ionicons name="close" size={20} color={t.colors.textSecondary} />
          </Pressable>
        </View>

        <View style={styles.section}>
          <View style={styles.sectionHead}>
            <Ionicons name="time-outline" size={15} color={t.colors.textSecondary} />
            <Text variant="caption" tone="secondary" weight="semibold">
              {`Duration · ${formatDuration(currentDur)}`}
            </Text>
          </View>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.presetsRow}
          >
            {DURATION_PRESETS.map((d) => {
              const isReduce = d < 0;
              return (
                <Pressable
                  key={d}
                  onPress={() => onAdjustDuration(d)}
                  style={({ pressed }) => [
                    styles.preset,
                    {
                      backgroundColor: isReduce ? t.colors.fill1 : t.colors.accentSoft,
                      borderColor: isReduce ? t.colors.separator : t.colors.accentSoft,
                    },
                    pressed && { opacity: 0.7 },
                  ]}
                >
                  <Text
                    variant="bodySm"
                    weight="bold"
                    style={{
                      color: isReduce ? t.colors.textSecondary : t.colors.accent,
                    }}
                  >
                    {d > 0 ? `+${d}` : `${d}`}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>

        <ActionRow
          icon="calendar-outline"
          label={`Move to specific time${item?.startTime ? ` (now ${item.startTime})` : ''}`}
          onPress={() => setShowTimePicker(true)}
        />
        {item?.place ? (
          <ActionRow
            icon="swap-horizontal"
            label="Swap place"
            sub={item.place.name}
            onPress={() => {
              onClose();
              onSwapPlace();
            }}
          />
        ) : null}
        <ActionRow
          icon="hourglass-outline"
          label="Add free time after"
          sub="Drop a gap you can name or fill"
          onPress={() => {
            onClose();
            onAddGapAfter();
          }}
        />
        <ActionRow
          icon="trash-outline"
          label="Remove from day"
          destructive
          onPress={() => {
            onClose();
            onRemove();
          }}
        />

        {showTimePicker ? (
          <DateTimePicker
            value={pickerDate}
            mode="time"
            display={Platform.OS === 'ios' ? 'spinner' : 'default'}
            onChange={handleTimeChange}
          />
        ) : null}
      </Animated.View>
    </Modal>
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
          <Text variant="caption" tone="tertiary" numberOfLines={1}>
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
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  grabber: {
    alignSelf: 'center',
    width: 38,
    height: 5,
    borderRadius: 3,
    marginBottom: 10,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 8,
  },
  close: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  section: {
    paddingVertical: 12,
    gap: 8,
  },
  sectionHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  presetsRow: {
    gap: 8,
    paddingRight: 8,
  },
  preset: {
    minWidth: 56,
    height: 36,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
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
