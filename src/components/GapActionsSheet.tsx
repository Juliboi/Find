import React, { useEffect, useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import Animated, { FadeInUp } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/theme/useTheme';
import { Text } from './Text';
import type { ItineraryItem } from '@/types/itinerary';
import { formatDuration } from '@/utils/time';

interface Props {
  /** The gap block the user opened actions for; null hides the sheet. */
  item: ItineraryItem | null;
  onClose: () => void;
  /** Rename the gap, e.g. "Playing video games". */
  onRename: (title: string) => void;
  /** Nudge the gap's length by a signed delta in minutes. */
  onAdjustDuration: (deltaMin: number) => void;
  /** Split the gap into two adjacent gaps (halves). */
  onSplit: () => void;
  /** Remove the gap from the day. */
  onRemove: () => void;
}

const DURATION_PRESETS = [-30, -15, +15, +30];
const NAME_SUGGESTIONS = ['Relax', 'Playing video games', 'Reading', 'Nap', 'Errands'];

/**
 * Actions for a free-time GAP block. Unlike a normal item, a gap is elastic
 * empty time the user owns: they can NAME it (turning "Free time" into
 * "Playing video games"), resize it, split it into two handles, or remove it.
 * There's no place to swap and no fixed-time move — a gap just flexes.
 */
export function GapActionsSheet({
  item,
  onClose,
  onRename,
  onAdjustDuration,
  onSplit,
  onRemove,
}: Props) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const open = !!item;
  const [name, setName] = useState(item?.title ?? '');

  // Re-seed the field only when a DIFFERENT gap is opened (keyed on id), so a
  // background re-render mid-typing can't clobber the user's keystrokes.
  const itemId = item?.id;
  const itemTitle = item?.title;
  useEffect(() => {
    if (itemId) setName(itemTitle ?? '');
  }, [itemId, itemTitle]);

  const currentDur = item?.durationMinutes ?? 30;
  const canSplit = currentDur >= 15;

  const commitName = () => {
    const clean = name.trim();
    if (clean && clean !== item?.title) onRename(clean);
  };

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
                ? `Free time · ${item.startTime}${item.endTime ? ` – ${item.endTime}` : ''}`
                : 'Free time'}
            </Text>
            <Text variant="title3" weight="bold" tight>
              {`${formatDuration(currentDur)} to fill`}
            </Text>
          </View>
          <Pressable onPress={onClose} hitSlop={10} style={styles.close}>
            <Ionicons name="close" size={20} color={t.colors.textSecondary} />
          </Pressable>
        </View>

        <View style={styles.section}>
          <View style={styles.sectionHead}>
            <Ionicons name="create-outline" size={15} color={t.colors.textSecondary} />
            <Text variant="caption" tone="secondary" weight="semibold">
              Name this time
            </Text>
          </View>
          <TextInput
            value={name}
            onChangeText={setName}
            onBlur={commitName}
            onSubmitEditing={commitName}
            returnKeyType="done"
            placeholder="e.g. Playing video games"
            placeholderTextColor={t.colors.textTertiary}
            style={[
              styles.input,
              {
                backgroundColor: t.colors.fill1,
                borderColor: t.colors.separator,
                color: t.colors.textPrimary,
              },
            ]}
          />
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.suggestionRow}
          >
            {NAME_SUGGESTIONS.map((s) => (
              <Pressable
                key={s}
                onPress={() => {
                  setName(s);
                  onRename(s);
                }}
                style={({ pressed }) => [
                  styles.chip,
                  { backgroundColor: t.colors.fill1, borderColor: t.colors.separator },
                  pressed && { opacity: 0.7 },
                ]}
              >
                <Text variant="caption" tone="secondary" weight="semibold">
                  {s}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>

        <View style={styles.section}>
          <View style={styles.sectionHead}>
            <Ionicons name="time-outline" size={15} color={t.colors.textSecondary} />
            <Text variant="caption" tone="secondary" weight="semibold">
              {`Length · ${formatDuration(currentDur)}`}
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
                    style={{ color: isReduce ? t.colors.textSecondary : t.colors.accent }}
                  >
                    {d > 0 ? `+${d}` : `${d}`}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>

        {canSplit ? (
          <ActionRow
            icon="cut-outline"
            label="Split in two"
            sub="Make two slots you can name & reorder"
            onPress={() => {
              onClose();
              onSplit();
            }}
          />
        ) : null}
        <ActionRow
          icon="trash-outline"
          label="Remove free time"
          destructive
          onPress={() => {
            onClose();
            onRemove();
          }}
        />
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
  input: {
    height: 44,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    fontSize: 16,
    fontWeight: '600',
  },
  suggestionRow: {
    gap: 8,
    paddingRight: 8,
  },
  chip: {
    height: 32,
    borderRadius: 9,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
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
