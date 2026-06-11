import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useTheme } from '@/theme/useTheme';
import { Text } from '@/components/Text';
import { GlassSurface } from '@/components/Glass';
import {
  formatHour,
  formatTemp,
  type WeatherCondition,
} from '@/lib/weather';
import { useWeatherStore } from '@/store/useWeatherStore';

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

// Warm gold for the sun / soft indigo for the moon — both tuned to read on the
// light *and* dark glass tints without a halo.
const SUN = '#F4A62A';
const MOON = '#9AA3C7';

const HOURLY_COLUMNS = 5;

function conditionIcon(condition: WeatherCondition, isDay: boolean): IoniconName {
  switch (condition) {
    case 'clear':
      return isDay ? 'sunny' : 'moon';
    case 'partly-cloudy':
      return isDay ? 'partly-sunny' : 'cloudy-night';
    case 'cloudy':
    case 'fog':
      return 'cloudy';
    case 'rain':
      return 'rainy';
    case 'snow':
      return 'snow';
    case 'thunderstorm':
      return 'thunderstorm';
    default:
      return isDay ? 'partly-sunny' : 'cloudy-night';
  }
}

function conditionColor(
  condition: WeatherCondition,
  isDay: boolean,
  colors: ReturnType<typeof useTheme>['colors'],
): string {
  switch (condition) {
    case 'clear':
    case 'partly-cloudy':
      return isDay ? SUN : MOON;
    case 'rain':
    case 'snow':
      return colors.info;
    case 'thunderstorm':
      return colors.highlightPurple;
    case 'cloudy':
    case 'fog':
    default:
      return colors.textSecondary;
  }
}

interface Props {
  style?: StyleProp<ViewStyle>;
}

/**
 * Home-screen weather widget. Shares the same liquid-glass chrome as the
 * adaptive plan card above it (regular blur, xl radius, soft drop shadow) so
 * the two read as a set. Shows current conditions plus a short hourly strip;
 * tap to flip between °C and °F. Renders nothing until there's something to
 * show (no permission + no saved home pin → silently absent).
 */
export function WeatherCard({ style }: Props) {
  const t = useTheme();
  const data = useWeatherStore((s) => s.data);
  const place = useWeatherStore((s) => s.place);
  const unit = useWeatherStore((s) => s.unit);
  const status = useWeatherStore((s) => s.status);
  const setUnit = useWeatherStore((s) => s.setUnit);

  const shadow = { shadowColor: t.colors.shadow };

  // Cold start with nothing cached: a slim loading shell that keeps the card's
  // footprint stable instead of popping in.
  if (!data) {
    if (status === 'loading') {
      return (
        <GlassSurface
          variant="regular"
          radius={t.radii.xl}
          style={[styles.card, shadow, style]}
          innerStyle={styles.loadingInner}
        >
          <ActivityIndicator color={t.colors.textSecondary} />
          <Text variant="caption" tone="secondary">
            Loading weather…
          </Text>
        </GlassSurface>
      );
    }
    return null;
  }

  const { current } = data;
  const hours = data.hourly.slice(0, HOURLY_COLUMNS);

  const feelsLike =
    current.feelsLikeC != null &&
    Math.round(current.feelsLikeC) !== Math.round(current.tempC)
      ? `Feels like ${formatTemp(current.feelsLikeC, unit)}`
      : current.precipProbability != null && current.precipProbability >= 20
        ? `${Math.round(current.precipProbability)}% rain`
        : null;

  const toggleUnit = () => {
    Haptics.selectionAsync().catch(() => undefined);
    setUnit(unit === 'C' ? 'F' : 'C');
  };

  return (
    <Pressable
      onPress={toggleUnit}
      accessibilityRole="button"
      accessibilityLabel={`Weather${place ? ` in ${place}` : ''}: ${
        current.label
      }, ${formatTemp(current.tempC, unit)}`}
      accessibilityHint="Toggles between Celsius and Fahrenheit"
      style={({ pressed }) => [
        style,
        pressed && { opacity: 0.92, transform: [{ scale: 0.99 }] },
      ]}
    >
      <GlassSurface
        variant="regular"
        radius={t.radii.xl}
        style={[styles.card, shadow]}
        innerStyle={styles.inner}
      >
        <View style={styles.header}>
          <Ionicons
            name="location"
            size={12}
            color={t.colors.textSecondary}
          />
          <Text
            variant="micro"
            uppercase
            weight="bold"
            tone="secondary"
            numberOfLines={1}
            style={styles.place}
          >
            {place ?? 'Weather'}
          </Text>
        </View>

        <View style={styles.hero}>
          <Ionicons
            name={conditionIcon(current.condition, current.isDay)}
            size={46}
            color={conditionColor(current.condition, current.isDay, t.colors)}
          />
          <Text style={[styles.temp, { color: t.colors.textPrimary }]}>
            {formatTemp(current.tempC, unit)}
          </Text>
          <View style={styles.heroMeta}>
            <Text variant="bodySm" weight="semibold" numberOfLines={1}>
              {current.label}
            </Text>
            {feelsLike ? (
              <Text variant="caption" tone="tertiary" numberOfLines={1}>
                {feelsLike}
              </Text>
            ) : null}
          </View>
        </View>

        {hours.length > 0 ? (
          <>
            <View
              style={[styles.divider, { backgroundColor: t.colors.separator }]}
            />
            <View style={styles.hourly}>
              {hours.map((h, i) => (
                <View key={h.time} style={styles.hourCol}>
                  <Text
                    variant="caption"
                    weight="semibold"
                    style={styles.hourTemp}
                  >
                    {formatTemp(h.tempC, unit)}
                  </Text>
                  <Ionicons
                    name={conditionIcon(h.condition, h.isDay)}
                    size={18}
                    color={conditionColor(h.condition, h.isDay, t.colors)}
                  />
                  <Text variant="micro" tone="tertiary">
                    {i === 0 ? 'Now' : formatHour(h.time)}
                  </Text>
                </View>
              ))}
            </View>
          </>
        ) : null}
      </GlassSurface>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // Match the plan card's drop shadow so the two glass cards feel related.
  card: {
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.18,
    shadowRadius: 22,
    elevation: 8,
  },
  inner: {
    padding: 16,
    gap: 14,
  },
  loadingInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 16,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  place: {
    letterSpacing: 1.2,
    flexShrink: 1,
  },
  hero: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  temp: {
    fontSize: 46,
    lineHeight: 50,
    fontWeight: '600',
    letterSpacing: -1,
  },
  heroMeta: {
    flex: 1,
    alignItems: 'flex-end',
    gap: 1,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
  },
  hourly: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  hourCol: {
    flex: 1,
    alignItems: 'center',
    gap: 6,
  },
  hourTemp: {
    fontVariant: ['tabular-nums'],
  },
});
