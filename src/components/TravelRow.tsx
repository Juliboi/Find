import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/theme/useTheme';
import { Text } from './Text';
import {
  formatTravel,
  travelIconName,
  type TravelEstimate,
} from '@/lib/travel';

interface Props {
  travel: TravelEstimate;
  /**
   * Optional label shown to the right of the duration (e.g. "to Sansho"
   * or "Home"). Lets us reuse the same row for inter-plan jumps and
   * the final "→ Home" anchor without a second component.
   */
  destinationLabel?: string;
  /**
   * Visually flags this row as the day-closing leg back home. Renders a
   * slightly different connector + a house glyph next to the mode icon.
   */
  isHomeAnchor?: boolean;
}

/**
 * Slim divider that lives between two PlanCards (or before the home
 * anchor). Uses a vertical connector line to imply "the day flows
 * downward" — similar to Apple Maps' step list.
 *
 * Kept deliberately low-contrast so it never competes with the cards
 * above and below it.
 */
export function TravelRow({ travel, destinationLabel, isHomeAnchor }: Props) {
  const t = useTheme();
  const iconName = isHomeAnchor ? 'home-outline' : travelIconName(travel.mode);
  return (
    <View style={styles.wrap}>
      <View style={styles.connectorCol} accessibilityElementsHidden>
        <View
          style={[styles.connector, { backgroundColor: t.colors.separator }]}
        />
        <View
          style={[
            styles.iconBubble,
            {
              backgroundColor: t.colors.surface1,
              borderColor: t.colors.separator,
            },
          ]}
        >
          <Ionicons
            name={iconName as never}
            size={12}
            color={t.colors.textSecondary}
          />
        </View>
        <View
          style={[styles.connector, { backgroundColor: t.colors.separator }]}
        />
      </View>
      <View style={styles.textCol}>
        <Text variant="caption" tone="secondary" weight="semibold">
          {formatTravel(travel)}
          {destinationLabel ? (
            <Text variant="caption" tone="tertiary">
              {' · to '}
              {destinationLabel}
            </Text>
          ) : null}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 4,
    paddingLeft: 14,
    gap: 10,
  },
  connectorCol: {
    width: 24,
    alignItems: 'center',
  },
  connector: {
    width: StyleSheet.hairlineWidth * 2,
    flex: 1,
    minHeight: 8,
  },
  iconBubble: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
  textCol: {
    flex: 1,
    paddingVertical: 4,
  },
});
