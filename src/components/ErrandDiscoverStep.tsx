import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, View } from 'react-native';
import { BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import Animated from 'react-native-reanimated';
import { useTheme } from '@/theme/useTheme';
import { Text } from './Text';
import { Button } from './Button';
import { ENTER, EXIT } from './errandDrawerAnim';
import { discoverPlaces, type DiscoverResult } from '@/lib/discover';
import { formatDistance, type Coords, type NearbyPlace } from '@/lib/places';
import { collectDayAnchors, nearestAnchor, type DayAnchor } from '@/lib/dayAnchors';
import { travelIconName } from '@/lib/travel';
import { useErrandsStore } from '@/store/useErrandsStore';
import { getOpeningHoursStatus } from '@/lib/itinerary/hours';
import { addMinutes, currentHHMM, todayISO } from '@/utils/time';

// Discovery candidates render as dark "liquid glass" cards (matching the home
// screen's frosted surfaces) so pure-white text stays crisp no matter what the
// sheet background is. Text tones below are white at descending opacity.
const ON = '#FFFFFF';
const ON_SOFT = 'rgba(255, 255, 255, 0.82)';
const ON_DIM = 'rgba(255, 255, 255, 0.56)';
const ON_FAINT = 'rgba(255, 255, 255, 0.40)';
// The glass itself: a dark tint over a blur, a hairline light edge, and a
// brighter inset for the AI blurb so it reads as a panel-within-a-panel.
const GLASS_TINT = 'rgba(18, 18, 24, 0.55)';
const GLASS_BORDER = 'rgba(255, 255, 255, 0.14)';
const GLASS_INSET = 'rgba(255, 255, 255, 0.09)';
const ACCENT_ON_GLASS = '#5AC8FA';

interface Props {
  /** The normalized "what" the orchestrator pulled from the typed line. */
  query: string;
  /** A named area to search around, or null. */
  area: string | null;
  /** True when the user said "nearby"/"near me" — search around live GPS. */
  nearby: boolean;
  /** Where to search when not nearby and no area resolves (usually home). */
  fallbackCenter: Coords | null;
  /** The errand's date (from the orchestrator) — scopes which day's stops we
   * measure closeness to. Null falls back to today. */
  anchorDate: string | null;
  /** The errand's start time (from the orchestrator). When set together with
   * anchorDate, each card shows open/closed AT that planned time instead of
   * "right now" — "open now" is irrelevant when planning for later. */
  anchorTime: string | null;
  /** Picked a candidate → hand back to the drawer to seed the confirm form. */
  onPick: (place: NearbyPlace) => void;
  /** Skip the suggestions and fill the form by hand. */
  onManual: () => void;
  /** Defer the venue choice to the day-planner ("Let Diem pick the spot"). */
  onAutoPlan: () => void;
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
  anchorDate,
  anchorTime,
  onPick,
  onManual,
  onAutoPlan,
}: Props) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const [loading, setLoading] = useState(true);
  const [result, setResult] = useState<DiscoverResult | null>(null);
  const [version, setVersion] = useState(0);
  const reqRef = useRef(0);

  // The day's other located errands — the "stops" each candidate's closeness is
  // measured against ("≈12 min from Dentist"), so picking a place is informed by
  // how it fits the day rather than an opaque proximity rank.
  const errands = useErrandsStore((s) => s.items);
  const dayStops = useMemo(
    () => collectDayAnchors({ errands, date: anchorDate ?? todayISO() }),
    [errands, anchorDate],
  );

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
              dayStops={dayStops}
              anchorDate={anchorDate}
              anchorTime={anchorTime}
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
          title="Let Diem pick the spot"
          variant="tonal"
          leftIcon={<Ionicons name="sparkles" size={16} color={t.colors.accent} />}
          onPress={() => {
            Haptics.selectionAsync().catch(() => undefined);
            onAutoPlan();
          }}
          fullWidth
          size="lg"
        />
        <Button
          title="Enter details manually"
          variant="ghost"
          onPress={() => {
            Haptics.selectionAsync().catch(() => undefined);
            onManual();
          }}
          fullWidth
          size="md"
        />
      </Animated.View>
    </>
  );
}

/** One tappable candidate: photo, name, rating/price/distance, blurb, chevron. */
function DiscoverCard({
  place,
  index,
  dayStops,
  anchorDate,
  anchorTime,
  onPress,
}: {
  place: NearbyPlace;
  index: number;
  dayStops: DayAnchor[];
  anchorDate: string | null;
  anchorTime: string | null;
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

  // Closeness to the day's nearest other stop — the routing cue that makes a
  // pick "fit the day". Only shown when there's another located errand to relate
  // to (otherwise the distance-to-center above already covers home/you).
  const nearStop = useMemo(
    () =>
      dayStops.length
        ? nearestAnchor({ latitude: place.latitude, longitude: place.longitude }, dayStops)
        : null,
    [dayStops, place.latitude, place.longitude],
  );

  // Google-Maps-style hours from the structured weekly schedule, evaluated for
  // the PLANNED visit rather than blindly "right now":
  //   • an explicit time → check open/closed AT that date+time (a 60-min
  //     look-ahead surfaces "Closing soon");
  //   • today / no date, no time → fall back to the live clock (acting now);
  //   • a FUTURE day with no time → show NO judgment — "open now" is irrelevant
  //     for a day we aren't on yet, and shouldn't hide or flag anything.
  const today = todayISO();
  const evalDate = anchorDate ?? today;
  const isFutureDay = evalDate > today;
  const evalStart = anchorTime ?? (isFutureDay ? null : currentHHMM());
  const hours =
    evalStart && place.openingHours && place.openingHours.periods?.length
      ? getOpeningHoursStatus(place.openingHours, evalDate, evalStart, addMinutes(evalStart, 60))
      : null;
  let hoursLabel: string | null = hours?.statusLabel ?? null;
  let hoursColor = ON_DIM;
  if (hours?.statusLabel) {
    hoursColor =
      hours.status === 'open'
        ? t.colors.success
        : hours.status === 'closingSoon'
          ? t.colors.warning
          : hours.status === 'closed'
            ? t.colors.danger
            : ON_DIM;
  } else if (!anchorTime && !isFutureDay && place.openNow != null) {
    // Coarse provider flag (Foursquare/OSM, no structured periods). It only
    // describes "right now", so we surface it only when evaluating the live clock.
    hoursLabel = place.openNow ? 'Open now' : 'Closed';
    hoursColor = place.openNow ? t.colors.success : t.colors.danger;
  }

  return (
    <Animated.View entering={ENTER(index + 1)} exiting={EXIT(index + 1)}>
      <Pressable
        onPress={onPress}
        style={({ pressed }) => [styles.card, pressed && { opacity: 0.9 }]}
        accessibilityRole="button"
        accessibilityLabel={`Pick ${place.name}`}
      >
        {/* Frosted "liquid glass": a dark blur + tint so white text stays crisp
            on any sheet background; the tint also covers the Android fallback. */}
        <BlurView tint="dark" intensity={48} style={StyleSheet.absoluteFill} />
        <View style={[StyleSheet.absoluteFill, { backgroundColor: GLASS_TINT }]} />

        <View style={styles.cardContent}>
          <View style={styles.cardTop}>
            {place.photoUrl ? (
              <Image source={{ uri: place.photoUrl }} style={styles.photo} />
            ) : (
              <View style={[styles.photo, styles.photoFallback]}>
                <Ionicons name="storefront-outline" size={20} color={ON_DIM} />
              </View>
            )}
            <View style={{ flex: 1, gap: 3 }}>
              <Text variant="body" weight="semibold" numberOfLines={1} style={{ color: ON }}>
                {place.name}
              </Text>
              <Text variant="caption" numberOfLines={1} style={{ color: ON_DIM }}>
                {meta.join('  ·  ')}
              </Text>
              {hoursLabel ? (
                <Text
                  variant="caption"
                  weight="semibold"
                  numberOfLines={1}
                  style={{ color: hoursColor }}
                >
                  {hoursLabel}
                </Text>
              ) : null}
            </View>
            <Ionicons name="chevron-forward" size={18} color={ON_FAINT} />
          </View>

          {nearStop ? (
            <View style={styles.anchorRow}>
              <Ionicons
                name={travelIconName(nearStop.estimate.mode) as keyof typeof Ionicons.glyphMap}
                size={13}
                color={ACCENT_ON_GLASS}
              />
              <Text
                variant="caption"
                weight="semibold"
                numberOfLines={1}
                style={{ flex: 1, color: ON_SOFT }}
              >
                {`${nearStop.estimate.minutes} min from ${nearStop.anchor.label}`}
              </Text>
            </View>
          ) : null}

          {place.address ? (
            <View style={styles.addressRow}>
              <Ionicons name="location-outline" size={13} color={ON_FAINT} />
              <Text variant="caption" numberOfLines={1} style={{ flex: 1, color: ON_DIM }}>
                {place.address}
              </Text>
            </View>
          ) : null}

          {place.reasoning ? (
            <View style={[styles.blurb]}>
              <Text variant="caption" style={{ flex: 1, color: ON_SOFT }}>
                {place.reasoning}
              </Text>
            </View>
          ) : null}
        </View>
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
      case 'place':
        return result.centerLabel ? `Near ${result.centerLabel}` : 'Nearby';
      case 'area':
        return result.centerLabel ? `In ${result.centerLabel}` : 'In the area';
      case 'home':
        return 'Near home';
      default:
        return '';
    }
  }
  if (nearby) return 'Near you';
  if (area) return `Near ${area}`;
  return 'Near you';
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
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: GLASS_BORDER,
    overflow: 'hidden',
  },
  cardContent: {
    gap: 10,
    padding: 12,
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
    backgroundColor: 'rgba(255, 255, 255, 0.10)',
  },
  addressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  anchorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  blurb: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  footer: {
    paddingHorizontal: 16,
    paddingTop: 10,
    gap: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
