import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, View } from 'react-native';
import { BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import Animated from 'react-native-reanimated';
import { useTheme } from '@/theme/useTheme';
import { Text } from './Text';
import { Button } from './Button';
import { ENTER, EXIT } from './errandDrawerAnim';
import { discoverPlaces, type DiscoverResult } from '@/lib/discover';
import { formatDistance, type Coords, type NearbyPlace } from '@/lib/places';

interface Props {
  /** The normalized "what" the orchestrator pulled from the typed line. */
  query: string;
  /** A named area to search around, or null. */
  area: string | null;
  /** True when the user said "nearby"/"near me" — search around live GPS. */
  nearby: boolean;
  /** Where to search when not nearby and no area resolves (usually home). */
  fallbackCenter: Coords | null;
  /** Picked a candidate → hand back to the drawer to seed the confirm form. */
  onPick: (place: NearbyPlace) => void;
  /** Skip the suggestions and fill the form by hand. */
  onManual: () => void;
}

/**
 * The "find a place" step. Given the orchestrator's search shape it fetches
 * ranked candidates (each with a one-line "what to expect" blurb), lists them as
 * tappable cards, and on tap hands the place back up so the drawer can flip to
 * the prefilled confirm form. Every place the user picks becomes an errand —
 * this step is really just a place pre-step in front of the normal form.
 */
export function ErrandDiscoverStep({
  query,
  area,
  nearby,
  fallbackCenter,
  onPick,
  onManual,
}: Props) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const [loading, setLoading] = useState(true);
  const [result, setResult] = useState<DiscoverResult | null>(null);
  const [version, setVersion] = useState(0);
  const reqRef = useRef(0);

  // Refetch whenever the search shape changes (a new discovery submit) or the
  // user hits retry. Guarded so a stale in-flight call can't overwrite a newer
  // one, and so we never setState after the drawer closes.
  useEffect(() => {
    const id = (reqRef.current += 1);
    let cancelled = false;
    setLoading(true);
    setResult(null);
    discoverPlaces({ query, area, nearby, fallbackCenter })
      .then((res) => {
        if (!cancelled && id === reqRef.current) setResult(res);
      })
      .catch(() => {
        if (!cancelled && id === reqRef.current) setResult(null);
      })
      .finally(() => {
        if (!cancelled && id === reqRef.current) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, area, nearby, fallbackCenter?.latitude, fallbackCenter?.longitude, version]);

  const where = whereLabel({ result, nearby, area });
  const places = result?.places ?? [];

  return (
    <>
      <Animated.View entering={ENTER(0)} exiting={EXIT(0)} style={styles.context}>
        <View style={[styles.contextIcon, { backgroundColor: t.colors.fill1 }]}>
          <Ionicons name="location-outline" size={15} color={t.colors.accent} />
        </View>
        <View style={{ flex: 1 }}>
          <Text variant="body" weight="semibold" numberOfLines={1} tight>
            {capitalize(query)}
          </Text>
          {where ? (
            <Text variant="caption" tone="secondary" numberOfLines={1}>
              {where}
            </Text>
          ) : null}
        </View>
      </Animated.View>

      <BottomSheetScrollView
        style={styles.scroll}
        contentContainerStyle={styles.body}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {loading ? (
          <View style={styles.state}>
            <ActivityIndicator color={t.colors.accent} />
            <Text variant="body" weight="semibold" tone="secondary">
              Finding places…
            </Text>
          </View>
        ) : places.length === 0 ? (
          <View style={styles.state}>
            <Ionicons name="compass-outline" size={28} color={t.colors.textTertiary} />
            <Text variant="body" weight="semibold" tone="secondary" style={styles.stateText}>
              {result?.detail ?? "Couldn't find anything to suggest."}
            </Text>
            <Pressable
              onPress={() => {
                Haptics.selectionAsync().catch(() => undefined);
                setVersion((v) => v + 1);
              }}
              hitSlop={8}
              style={styles.retry}
            >
              <Ionicons name="refresh" size={15} color={t.colors.accent} />
              <Text variant="bodySm" weight="semibold" style={{ color: t.colors.accent }}>
                Try again
              </Text>
            </Pressable>
          </View>
        ) : (
          places.map((p, i) => (
            <DiscoverCard
              key={p.id}
              place={p}
              index={i}
              onPress={() => {
                Haptics.selectionAsync().catch(() => undefined);
                onPick(p);
              }}
            />
          ))
        )}
      </BottomSheetScrollView>

      <Animated.View
        entering={ENTER(4)}
        exiting={EXIT(4)}
        style={[
          styles.footer,
          { paddingBottom: insets.bottom + 8, borderTopColor: t.colors.separator },
        ]}
      >
        <Button
          title="Enter details manually"
          variant="ghost"
          onPress={() => {
            Haptics.selectionAsync().catch(() => undefined);
            onManual();
          }}
          fullWidth
          size="lg"
        />
      </Animated.View>
    </>
  );
}

/** One tappable candidate: photo, name, rating/price/distance, blurb, chevron. */
function DiscoverCard({
  place,
  index,
  onPress,
}: {
  place: NearbyPlace;
  index: number;
  onPress: () => void;
}) {
  const t = useTheme();
  const meta: string[] = [];
  if (place.rating != null) {
    meta.push(`★ ${place.rating.toFixed(1)}${place.ratingCount ? ` (${place.ratingCount})` : ''}`);
  }
  if (place.priceLevel != null && place.priceLevel > 0) {
    meta.push('$'.repeat(place.priceLevel));
  }
  meta.push(formatDistance(place.distanceM));

  return (
    <Animated.View entering={ENTER(index + 1)} exiting={EXIT(index + 1)}>
      <Pressable
        onPress={onPress}
        style={({ pressed }) => [
          styles.card,
          {
            backgroundColor: t.colors.surface2,
            borderColor: t.colors.separator,
            opacity: pressed ? 0.85 : 1,
          },
        ]}
        accessibilityRole="button"
        accessibilityLabel={`Pick ${place.name}`}
      >
        <View style={styles.cardTop}>
          {place.photoUrl ? (
            <Image source={{ uri: place.photoUrl }} style={styles.photo} />
          ) : (
            <View style={[styles.photo, styles.photoFallback, { backgroundColor: t.colors.fill1 }]}>
              <Ionicons name="storefront-outline" size={20} color={t.colors.textTertiary} />
            </View>
          )}
          <View style={{ flex: 1, gap: 3 }}>
            <Text variant="body" weight="semibold" numberOfLines={1}>
              {place.name}
            </Text>
            <Text variant="caption" tone="secondary" numberOfLines={1}>
              {meta.join('  ·  ')}
            </Text>
            {place.openNow != null ? (
              <Text
                variant="caption"
                weight="semibold"
                style={{ color: place.openNow ? t.colors.success : t.colors.danger }}
              >
                {place.openNow ? 'Open now' : 'Closed'}
              </Text>
            ) : null}
          </View>
          <Ionicons name="chevron-forward" size={18} color={t.colors.textTertiary} />
        </View>

        {place.reasoning ? (
          <View style={[styles.blurb, { backgroundColor: t.colors.fill1 }]}>
            <Ionicons name="sparkles-outline" size={13} color={t.colors.accent} />
            <Text variant="caption" tone="secondary" style={{ flex: 1 }}>
              {place.reasoning}
            </Text>
          </View>
        ) : place.address ? (
          <Text variant="caption" tone="tertiary" numberOfLines={1}>
            {place.address}
          </Text>
        ) : null}
      </Pressable>
    </Animated.View>
  );
}

function whereLabel({
  result,
  nearby,
  area,
}: {
  result: DiscoverResult | null;
  nearby: boolean;
  area: string | null;
}): string {
  if (result) {
    switch (result.centerSource) {
      case 'gps':
        return 'Near you';
      case 'area':
        return result.centerLabel ? `In ${result.centerLabel}` : 'In the area';
      case 'home':
        return 'Near home';
      default:
        return '';
    }
  }
  if (nearby) return 'Near you';
  if (area) return `In ${area}`;
  return 'Near home';
}

function capitalize(s: string): string {
  const trimmed = (s ?? '').trim();
  return trimmed ? trimmed.charAt(0).toUpperCase() + trimmed.slice(1) : trimmed;
}

const styles = StyleSheet.create({
  context: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 2,
    paddingBottom: 10,
  },
  contextIcon: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scroll: {
    flex: 1,
  },
  body: {
    paddingHorizontal: 16,
    paddingTop: 2,
    paddingBottom: 16,
    gap: 12,
  },
  state: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    paddingTop: 64,
    paddingHorizontal: 24,
  },
  stateText: {
    textAlign: 'center',
  },
  retry: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 6,
  },
  card: {
    gap: 10,
    padding: 12,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
  },
  cardTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  photo: {
    width: 56,
    height: 56,
    borderRadius: 12,
  },
  photoFallback: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  blurb: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    padding: 10,
    borderRadius: 10,
  },
  footer: {
    paddingHorizontal: 16,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
