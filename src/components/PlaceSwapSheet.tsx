import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { BottomSheetScrollView, BottomSheetTextInput } from '@gorhom/bottom-sheet';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/theme/useTheme';
import { Sheet } from './Sheet';
import { Text } from './Text';
import { findPlaces, formatDistance, type Coords, type NearbyPlace } from '@/lib/places';
import { ItineraryItem, ItineraryPlace } from '@/types/itinerary';
import { getVenueHoursStatus } from '@/lib/itinerary/hours';

interface Props {
  /** The block whose venue is being swapped; null closes the sheet. */
  item: ItineraryItem | null;
  /** Day's city, used to bias/format a custom search. */
  city?: string;
  /**
   * The day's date ("YYYY-MM-DD"). Lets each result show whether it's open for
   * THIS item's scheduled visit time, so a swap doesn't reintroduce a closed
   * venue.
   */
  date?: string;
  /**
   * Coordinates of the previous located stop in the day (falling back to the
   * user's home/origin). Lets the search rank alternatives that stay on the
   * route between this stop and the next, instead of drifting cross-town.
   */
  prevCoords?: Coords;
  /** Coordinates of the next located stop (or home/origin) — see prevCoords. */
  nextCoords?: Coords;
  onClose: () => void;
  onPick: (place: ItineraryPlace) => void;
}

/** Maps a nearby-place search result into the itinerary's place shape. */
function toItineraryPlace(p: NearbyPlace, fallbackEmoji?: string): ItineraryPlace {
  return {
    name: p.name,
    category: p.types?.[0]?.replace(/_/g, ' '),
    emoji: fallbackEmoji,
    address: p.address ?? undefined,
    rating: p.rating ?? undefined,
    ratingCount: p.ratingCount ?? undefined,
    priceLevel:
      typeof p.priceLevel === 'number' ? '$'.repeat(Math.max(1, p.priceLevel)) : undefined,
    coords: { latitude: p.latitude, longitude: p.longitude },
    photoUrl: p.photoUrl ?? undefined,
    // Carry hours through so the card's scheduled-time warning keeps working
    // after a swap (and isn't lost the moment you replace a venue).
    openingHours: p.openingHours ?? undefined,
  };
}

/**
 * Bottom sheet that shows alternative venues for a block — image, name, rating,
 * distance and an AI pitch — plus a free-text search for "find your own".
 * Picking one hands a fresh `ItineraryPlace` back to the screen, which swaps it
 * and re-routes the day.
 */
export function PlaceSwapSheet({
  item,
  city,
  date,
  prevCoords,
  nextCoords,
  onClose,
  onPick,
}: Props) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<NearbyPlace[]>([]);
  const [reason, setReason] = useState<string | null>(null);

  const open = !!item;
  const center = item?.place?.coords;
  const emoji = item?.place?.emoji;

  // Initial suggestions: near the current venue, matching its type/intent.
  useEffect(() => {
    if (!item) {
      setResults([]);
      setQuery('');
      setReason(null);
      return;
    }
    const seed = item.place?.category ?? item.title;
    void runSearch(seed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id]);

  const runSearch = async (qRaw: string) => {
    const q = qRaw.trim();
    if (!q) return;
    setLoading(true);
    setReason(null);
    const intent = `${item?.title ?? ''} — ${q}`.trim();
    // Pass the surrounding stops so the edge function favours alternatives
    // that stay on the route (low detour) over ones that merely sit close
    // to the venue we're replacing.
    const route =
      prevCoords || nextCoords ? { prev: prevCoords, next: nextCoords } : undefined;
    const res = await findPlaces(q, intent, center, route);
    setResults(res.places);
    if (res.places.length === 0) {
      setReason(
        res.reason === 'no_supabase'
          ? 'Connect a places provider to see suggestions.'
          : res.reason === 'no_location'
          ? 'Location unavailable for nearby search.'
          : res.detail ?? 'No matches found nearby.',
      );
    }
    setLoading(false);
  };

  return (
    <Sheet open={open} onClose={onClose} heightFraction={0.82}>
      <View style={[styles.content, { paddingBottom: insets.bottom + 12 }]}>
        <View style={styles.header}>
          <View style={{ flex: 1 }}>
            <Text variant="micro" tone="tertiary" uppercase weight="bold">
              Swap place
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

        <View style={[styles.search, { backgroundColor: t.colors.fill1 }]}>
          <Ionicons name="search" size={16} color={t.colors.textTertiary} />
          <BottomSheetTextInput
            style={[styles.searchInput, { color: t.colors.textPrimary }]}
            placeholder="Search a place or type…"
            placeholderTextColor={t.colors.textTertiary}
            value={query}
            onChangeText={setQuery}
            onSubmitEditing={() => runSearch(query)}
            returnKeyType="search"
          />
          {query ? (
            <Pressable
              onPress={() => {
                Haptics.selectionAsync().catch(() => undefined);
                runSearch(query);
              }}
              hitSlop={8}
            >
              <Ionicons name="arrow-forward-circle" size={22} color={t.colors.accent} />
            </Pressable>
          ) : null}
        </View>

        <BottomSheetScrollView
          style={styles.list}
          contentContainerStyle={{ paddingBottom: 8 }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {loading ? (
            <View style={styles.loading}>
              <ActivityIndicator color={t.colors.accent} />
              <Text variant="bodySm" tone="secondary" style={{ marginTop: 10 }}>
                Finding places near here…
              </Text>
            </View>
          ) : results.length === 0 ? (
            <View style={styles.loading}>
              <Text variant="bodySm" tone="tertiary" style={{ textAlign: 'center' }}>
                {reason ?? 'Search to see options.'}
              </Text>
            </View>
          ) : (
            results.map((p, i) => {
              // Judge each candidate against THIS item's scheduled visit window
              // (date + start/end), not just "open right now", so a swap can't
              // silently reintroduce a venue that's closed at the planned time.
              const fit = getVenueHoursStatus(
                { name: p.name, openingHours: p.openingHours ?? undefined },
                date,
                item?.startTime,
                item?.endTime,
              );
              return (
              <Animated.View key={p.id} entering={FadeIn.delay(Math.min(i * 40, 240))}>
                <Pressable
                  onPress={() => {
                    Haptics.selectionAsync().catch(() => undefined);
                    onPick(toItineraryPlace(p, emoji));
                  }}
                  style={({ pressed }) => [
                    styles.card,
                    { borderColor: t.colors.separator },
                    pressed && { backgroundColor: t.colors.fill1 },
                  ]}
                >
                  {p.photoUrl ? (
                    <Image
                      source={{ uri: p.photoUrl }}
                      style={[styles.thumb, { backgroundColor: t.colors.fill1 }]}
                    />
                  ) : (
                    <View style={[styles.thumb, styles.thumbEmpty, { backgroundColor: t.colors.fill1 }]}>
                      <Text variant="title3">{emoji ?? '📍'}</Text>
                    </View>
                  )}
                  <View style={{ flex: 1, gap: 3 }}>
                    <Text variant="bodySm" weight="semibold" numberOfLines={1}>
                      {p.name}
                    </Text>
                    <View style={styles.metaRow}>
                      {p.rating != null ? (
                        <View style={styles.metaItem}>
                          <Text variant="caption" tone="secondary" weight="medium">
                            {p.rating.toFixed(1)}
                          </Text>
                          <Ionicons name="star" size={11} color={t.colors.highlightYellow} />
                        </View>
                      ) : null}
                      <Text variant="caption" tone="tertiary">
                        {formatDistance(p.distanceM)}
                      </Text>
                      {fit.status !== 'unknown' ? (
                        <Text
                          variant="caption"
                          weight="medium"
                          style={{
                            color:
                              fit.status === 'open'
                                ? t.colors.success
                                : fit.status === 'closingSoon'
                                ? t.colors.warning
                                : t.colors.danger,
                          }}
                        >
                          {fit.status === 'open'
                            ? 'Open'
                            : fit.status === 'closingSoon'
                            ? fit.statusLabel
                            : 'Closed then'}
                        </Text>
                      ) : p.openNow != null ? (
                        <Text
                          variant="caption"
                          weight="medium"
                          style={{ color: p.openNow ? t.colors.success : t.colors.danger }}
                        >
                          {p.openNow ? 'Open' : 'Closed'}
                        </Text>
                      ) : null}
                    </View>
                    {p.reasoning ? (
                      <Text variant="caption" tone="tertiary" numberOfLines={2}>
                        {p.reasoning}
                      </Text>
                    ) : null}
                  </View>
                  <Ionicons name="swap-horizontal" size={18} color={t.colors.accent} />
                </Pressable>
              </Animated.View>
              );
            })
          )}
        </BottomSheetScrollView>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  content: {
    flex: 1,
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
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 12,
    paddingHorizontal: 12,
    height: 44,
    marginBottom: 12,
  },
  searchInput: {
    flex: 1,
    fontSize: 16,
  },
  list: {
    flex: 1,
  },
  loading: {
    paddingVertical: 36,
    alignItems: 'center',
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    paddingHorizontal: 10,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: 8,
  },
  thumb: {
    width: 56,
    height: 56,
    borderRadius: 12,
  },
  thumbEmpty: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  metaItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
});
