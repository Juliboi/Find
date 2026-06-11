import React, { useState } from 'react';
import { Pressable, StyleSheet, Switch, View } from 'react-native';
import { BottomSheetView } from '@gorhom/bottom-sheet';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/theme/useTheme';
import { Sheet } from './Sheet';
import { Text } from './Text';
import type { ItineraryItem, ItineraryTravelMode } from '@/types/itinerary';

interface Props {
  /** Item whose `travelFromPrev` leg is being re-chosen; null hides the sheet. */
  item: ItineraryItem | null;
  onClose: () => void;
  /** Pick a mode for this single leg. */
  onPickLegMode: (mode: ItineraryTravelMode) => void;
  /** Pick a mode and apply it to EVERY leg of the day. */
  onPickDayMode: (mode: ItineraryTravelMode) => void;
}

interface ModeOption {
  mode: ItineraryTravelMode;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
}

const MODE_OPTIONS: ModeOption[] = [
  { mode: 'walk', label: 'Walk', icon: 'walk-outline' },
  { mode: 'bike', label: 'Bike', icon: 'bicycle-outline' },
  { mode: 'transit', label: 'Transit', icon: 'bus-outline' },
  { mode: 'drive', label: 'Drive', icon: 'car-outline' },
];

/**
 * Sheet for changing how the user GETS to a block — surface for user case #2
 * ("don't like the route / a leg"). Pick a different mode for just this hop,
 * or flip the toggle to apply it to every leg of the day in one go (the "I'm
 * taking my car today" case).
 */
export function LegModeSheet({ item, onClose, onPickLegMode, onPickDayMode }: Props) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const [applyToDay, setApplyToDay] = useState(false);

  const open = !!item;
  const currentMode = item?.travelFromPrev?.mode;

  // Reset the toggle each time the sheet opens for a new item so it never
  // surprises the user with a stale "applies to whole day" state.
  React.useEffect(() => {
    if (open) setApplyToDay(false);
  }, [open, item?.id]);

  const pick = (mode: ItineraryTravelMode) => {
    Haptics.selectionAsync().catch(() => undefined);
    if (applyToDay) onPickDayMode(mode);
    else onPickLegMode(mode);
  };

  return (
    <Sheet open={open} onClose={onClose}>
      <BottomSheetView style={[styles.content, { paddingBottom: insets.bottom + 12 }]}>
        <View style={styles.header}>
          <View style={{ flex: 1 }}>
            <Text variant="micro" tone="tertiary" uppercase weight="bold">
              Travel to
            </Text>
            <Text variant="title3" weight="bold" tight numberOfLines={1}>
              {item?.title ?? ''}
            </Text>
          </View>
          <Pressable
            onPress={() => {
              Haptics.selectionAsync().catch(() => undefined);
              onClose();
            }}
            hitSlop={10}
            style={styles.close}
          >
            <Ionicons name="close" size={20} color={t.colors.textSecondary} />
          </Pressable>
        </View>

        <View style={styles.options}>
          {MODE_OPTIONS.map((opt) => {
            const active = opt.mode === currentMode;
            return (
              <Pressable
                key={opt.mode}
                onPress={() => pick(opt.mode)}
                style={({ pressed }) => [
                  styles.option,
                  {
                    backgroundColor: active ? t.colors.accentSoft : t.colors.fill1,
                    borderColor: active ? t.colors.accent : t.colors.separator,
                  },
                  pressed && { opacity: 0.7 },
                ]}
              >
                <Ionicons
                  name={opt.icon}
                  size={26}
                  color={active ? t.colors.accent : t.colors.textPrimary}
                />
                <Text
                  variant="bodySm"
                  weight="bold"
                  style={{
                    marginTop: 6,
                    color: active ? t.colors.accent : t.colors.textPrimary,
                  }}
                >
                  {opt.label}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <View style={[styles.applyRow, { borderTopColor: t.colors.separator }]}>
          <View style={{ flex: 1 }}>
            <Text variant="bodySm" weight="semibold">
              Use for the rest of the day
            </Text>
            <Text variant="caption" tone="tertiary">
              Sets every leg to the mode you pick.
            </Text>
          </View>
          <Switch
            value={applyToDay}
            onValueChange={(v) => {
              Haptics.selectionAsync().catch(() => undefined);
              setApplyToDay(v);
            }}
            trackColor={{ true: t.colors.accent, false: t.colors.fill2 }}
          />
        </View>
      </BottomSheetView>
    </Sheet>
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
    gap: 10,
    marginBottom: 12,
  },
  close: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  options: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 16,
  },
  option: {
    flex: 1,
    aspectRatio: 1,
    borderRadius: 16,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  applyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
