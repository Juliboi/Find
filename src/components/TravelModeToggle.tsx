import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useTheme } from '@/theme/useTheme';
import { Text } from './Text';
import type { TravelPref } from '@/store/useErrandsStore';

interface Props {
  /** The explicit choice, or undefined to follow the `hasCar` default. */
  value?: TravelPref;
  /** Whether the user owns a car — sets the default when `value` is unset. */
  hasCar: boolean;
  onChange: (mode: TravelPref) => void;
}

interface Option {
  mode: TravelPref;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
}

const OPTIONS: Option[] = [
  { mode: 'commute', label: 'Commute', icon: 'bus-outline' },
  { mode: 'car', label: 'Car', icon: 'car-outline' },
];

/**
 * Two-way travel-mode picker shown once an errand has a real location: how the
 * user wants to get there — by commute (walk / public transport) or by car.
 *
 * The selection is a soft default: until the user taps, the active pill mirrors
 * what the planner would do anyway (car if they own one, else commute), so the
 * row reads as a sensible preset rather than an unanswered question. Tapping
 * pins an explicit choice the planner then honours for routing.
 */
export function TravelModeToggle({ value, hasCar, onChange }: Props) {
  const t = useTheme();
  const effective: TravelPref = value ?? (hasCar ? 'car' : 'commute');

  return (
    <View style={styles.row}>
      {OPTIONS.map((opt) => {
        const active = opt.mode === effective;
        return (
          <Pressable
            key={opt.mode}
            onPress={() => {
              Haptics.selectionAsync().catch(() => undefined);
              onChange(opt.mode);
            }}
            style={({ pressed }) => [
              styles.pill,
              {
                backgroundColor: active ? t.colors.accent : t.colors.fill1,
                borderColor: active ? t.colors.accent : t.colors.separator,
              },
              pressed && !active && { opacity: 0.7 },
            ]}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
          >
            <Ionicons
              name={opt.icon}
              size={17}
              color={active ? t.colors.textOnAccent : t.colors.textSecondary}
            />
            <Text
              variant="bodySm"
              weight="semibold"
              style={{ color: active ? t.colors.textOnAccent : t.colors.textSecondary }}
            >
              {opt.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: 8,
  },
  pill: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    height: 40,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
  },
});
