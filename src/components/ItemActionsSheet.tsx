import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  type TextInput,
} from 'react-native';
import { BottomSheetScrollView, BottomSheetTextInput } from '@gorhom/bottom-sheet';
import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/theme/useTheme';
import { Sheet } from './Sheet';
import { Text } from './Text';
import type { ItineraryItem, ItineraryPlace } from '@/types/itinerary';
import { findPlaces, formatDistance, type Coords, type NearbyPlace } from '@/lib/places';
import {
  autocompletePlaces,
  resolvePlace,
  type PlacePrediction,
  type ResolvedPlace,
} from '@/lib/geocoding';
import { getVenueHoursStatus } from '@/lib/itinerary/hours';
import { formatDuration, minutesOfDay } from '@/utils/time';

interface Props {
  /** The item the user opened actions for; null hides the sheet. */
  item: ItineraryItem | null;
  /** Day's city, used to anchor the AI discovery search on the right place. */
  city?: string;
  /** Day's date ("YYYY-MM-DD") so each candidate shows open/closed for the visit. */
  date?: string;
  /** Where to bias the venue search — the block's own pin, falling back to a
   *  neighbouring stop or home so a location-free block can still find places. */
  searchCenter?: Coords;
  /** Located stops on either side, so AI discovery favours low-detour options. */
  prevCoords?: Coords;
  nextCoords?: Coords;
  onClose: () => void;
  /** Nudge the item's duration by the given signed delta in minutes. */
  onAdjustDuration: (deltaMin: number) => void;
  /** Pin the item to an absolute "HH:MM" start. */
  onMoveTime: (hhmm: string) => void;
  /** Set/replace the block's venue (from the in-drawer location editor). */
  onSetPlace: (place: ItineraryPlace) => void;
  /** Insert a free-time gap block immediately after this block. */
  onAddGapAfter: () => void;
  /** Remove the item from the day. */
  onRemove: () => void;
}

const DURATION_PRESETS = [-30, -15, +15, +30, +60];

function newSessionToken(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Maps a resolved autocomplete pick into the itinerary's place shape. The name
 *  comes from the prediction the user tapped; coords/photo/rating/hours from the
 *  Place Details resolve. */
function resolvedToItineraryPlace(
  prediction: PlacePrediction,
  r: ResolvedPlace,
  fallbackEmoji?: string,
): ItineraryPlace {
  return {
    name: prediction.primary || r.label,
    emoji: fallbackEmoji,
    address: prediction.secondary || undefined,
    rating: r.rating ?? undefined,
    ratingCount: r.ratingCount ?? undefined,
    priceLevel:
      typeof r.priceLevel === 'number' ? '$'.repeat(Math.max(1, r.priceLevel)) : undefined,
    coords: { latitude: r.latitude, longitude: r.longitude },
    photoUrl: r.photoUrl ?? undefined,
    openingHours: r.openingHours ?? undefined,
  };
}

/** Maps an AI-discovery result into the itinerary's place shape. */
function nearbyToItineraryPlace(p: NearbyPlace, fallbackEmoji?: string): ItineraryPlace {
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
    openingHours: p.openingHours ?? undefined,
  };
}

/**
 * Per-card actions sheet: one surface for every edit a single block can take.
 * EVERY card opens it (tap the card, or the "..."), instead of separate chip
 * surfaces scattered across the screen.
 *
 * Two modes:
 *  - "actions" — duration nudges, an absolute time move, a venue change entry,
 *    add free-time, or removal;
 *  - "location" — an inline place editor that mirrors the errand drawer: it
 *    leads with fast/cheap Google Places autocomplete (great for a specific
 *    name like "Bílá labuť Max Fitness" or an address) and offers an explicit
 *    "Discover with AI" escalation for open-ended exploration ("coffee near
 *    Prague"). No automatic AI calls — the user opts in.
 */
export function ItemActionsSheet({
  item,
  city,
  date,
  searchCenter,
  prevCoords,
  nextCoords,
  onClose,
  onAdjustDuration,
  onMoveTime,
  onSetPlace,
  onAddGapAfter,
  onRemove,
}: Props) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const [showTimePicker, setShowTimePicker] = useState(false);
  const [mode, setMode] = useState<'actions' | 'location'>('actions');

  const open = !!item;
  const currentDur = item?.durationMinutes ?? 30;

  // Reset to the action list each time a new card is opened, so the sheet never
  // reopens mid-search on a different block.
  useEffect(() => {
    setMode('actions');
    setShowTimePicker(false);
  }, [item?.id]);

  const handleTimeChange = (_: DateTimePickerEvent, selected?: Date) => {
    if (Platform.OS !== 'ios') setShowTimePicker(false);
    if (!selected) return;
    const h = selected.getHours();
    const m = selected.getMinutes();
    onMoveTime(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
    if (Platform.OS === 'ios') setShowTimePicker(false);
  };

  const startMin = item ? minutesOfDay(item.startTime) ?? 9 * 60 : 9 * 60;
  const pickerDate = new Date();
  pickerDate.setHours(Math.floor(startMin / 60), startMin % 60, 0, 0);

  // Fixed snap heights per mode (rather than dynamic sizing) so the keyboard and
  // the scrollable result list never fight a resizing sheet: the location editor
  // needs room, the inline time picker a little more, the bare list stays small.
  const heightFraction = mode === 'location' ? 0.9 : showTimePicker ? 0.7 : 0.5;

  return (
    <Sheet open={open} onClose={onClose} heightFraction={heightFraction}>
      <View style={[styles.content, { paddingBottom: insets.bottom + 12 }]}>
        {/* ----------------------------------------------------------- header */}
        <View style={styles.header}>
          {mode === 'location' ? (
            <Pressable
              onPress={() => {
                Haptics.selectionAsync().catch(() => undefined);
                setMode('actions');
              }}
              hitSlop={10}
              style={styles.close}
              accessibilityLabel="Back to actions"
            >
              <Ionicons name="chevron-back" size={22} color={t.colors.textSecondary} />
            </Pressable>
          ) : null}
          <View style={{ flex: 1 }}>
            <Text variant="micro" tone="tertiary" uppercase weight="bold">
              {mode === 'location'
                ? 'Change place'
                : item?.startTime
                ? `${item.startTime}${item.endTime ? ` – ${item.endTime}` : ''}`
                : 'Edit block'}
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

        {mode === 'location' ? (
          <LocationEditor
            item={item}
            city={city}
            date={date}
            searchCenter={searchCenter}
            prevCoords={prevCoords}
            nextCoords={nextCoords}
            onPick={(place) => {
              onSetPlace(place);
              onClose();
            }}
          />
        ) : (
          <BottomSheetScrollView
            style={styles.actionsScroll}
            contentContainerStyle={{ paddingBottom: 4 }}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {/* ------------------------------------------------------ location */}
            <Pressable
              onPress={() => {
                Haptics.selectionAsync().catch(() => undefined);
                setMode('location');
              }}
              style={({ pressed }) => [
                styles.locationRow,
                { borderColor: t.colors.separator, backgroundColor: t.colors.fill1 },
                pressed && { opacity: 0.7 },
              ]}
              accessibilityLabel={item?.place ? 'Change place' : 'Add a place'}
            >
              {item?.place?.photoUrl ? (
                <Image
                  source={{ uri: item.place.photoUrl }}
                  style={[styles.locationThumb, { backgroundColor: t.colors.background }]}
                />
              ) : (
                <View
                  style={[
                    styles.locationThumb,
                    styles.locationThumbEmpty,
                    { backgroundColor: t.colors.background },
                  ]}
                >
                  <Ionicons
                    name={item?.place ? 'location' : 'search'}
                    size={18}
                    color={item?.place ? t.colors.accent : t.colors.textTertiary}
                  />
                </View>
              )}
              <View style={{ flex: 1 }}>
                <Text variant="micro" tone="tertiary" uppercase weight="bold">
                  Place
                </Text>
                <Text variant="body" weight="semibold" numberOfLines={1}>
                  {item?.place?.name ?? 'Add a place'}
                </Text>
              </View>
              <View style={styles.changeChip}>
                <Text variant="caption" weight="bold" style={{ color: t.colors.accent }}>
                  {item?.place ? 'Change' : 'Find'}
                </Text>
                <Ionicons name="chevron-forward" size={14} color={t.colors.accent} />
              </View>
            </Pressable>

            {/* ------------------------------------------------------ duration */}
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
                      onPress={() => {
                        Haptics.selectionAsync().catch(() => undefined);
                        onAdjustDuration(d);
                      }}
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
              onPress={() => setShowTimePicker((v) => !v)}
            />
            {showTimePicker ? (
              <View style={styles.pickerWrap}>
                <DateTimePicker
                  value={pickerDate}
                  mode="time"
                  display={Platform.OS === 'ios' ? 'spinner' : 'default'}
                  onChange={handleTimeChange}
                />
              </View>
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
          </BottomSheetScrollView>
        )}
      </View>
    </Sheet>
  );
}

/**
 * The inline place editor. Leads with fast Google Places autocomplete (as-you-
 * type, biased to the day's location) so a specific name/address resolves
 * cheaply — exactly like the errand drawer's address field. A "Discover with AI"
 * button escalates the current query to the richer grounded search (photos,
 * ratings, "why this fits") only when the user asks for it.
 */
function LocationEditor({
  item,
  city,
  date,
  searchCenter,
  prevCoords,
  nextCoords,
  onPick,
}: {
  item: ItineraryItem | null;
  city?: string;
  date?: string;
  searchCenter?: Coords;
  prevCoords?: Coords;
  nextCoords?: Coords;
  onPick: (place: ItineraryPlace) => void;
}) {
  const t = useTheme();
  const [query, setQuery] = useState('');
  const [predictions, setPredictions] = useState<PlacePrediction[]>([]);
  const [searching, setSearching] = useState(false);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  // AI discovery (opt-in) state.
  const [discover, setDiscover] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [discoverResults, setDiscoverResults] = useState<NearbyPlace[]>([]);
  const [discoverReason, setDiscoverReason] = useState<string | null>(null);

  const inputRef = useRef<TextInput>(null);
  const sessionRef = useRef(newSessionToken());
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const discoverReqRef = useRef(0);

  const emoji = item?.place?.emoji;
  const centerKey = searchCenter ? `${searchCenter.latitude},${searchCenter.longitude}` : '';
  const q = query.trim();

  // Raise the keyboard once the sheet has settled at its taller layout.
  useEffect(() => {
    const id = setTimeout(() => inputRef.current?.focus(), 280);
    return () => clearTimeout(id);
  }, []);

  // Debounced autocomplete — the default, cheap path. Paused while AI discovery
  // owns the list (typing again drops back to autocomplete, see onChangeQuery).
  useEffect(() => {
    if (discover) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (q.length < 3) {
      setPredictions([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    debounceRef.current = setTimeout(async () => {
      const preds = await autocompletePlaces(q, searchCenter ?? null, sessionRef.current);
      setPredictions(preds);
      setSearching(false);
    }, 280);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, discover, centerKey]);

  const onChangeQuery = (next: string) => {
    setQuery(next);
    if (discover) {
      setDiscover(false);
      setDiscoverResults([]);
      setDiscoverReason(null);
    }
  };

  const pickPrediction = async (p: PlacePrediction) => {
    Haptics.selectionAsync().catch(() => undefined);
    setResolvingId(p.placeId);
    const resolved = await resolvePlace(p.placeId, sessionRef.current);
    sessionRef.current = newSessionToken();
    setResolvingId(null);
    if (!resolved) {
      // Couldn't fetch coordinates — keep the chosen name unpinned.
      onPick({ name: p.primary, emoji, address: p.secondary || undefined });
      return;
    }
    onPick(resolvedToItineraryPlace(p, resolved, emoji));
  };

  const runDiscover = async () => {
    if (q.length < 2) return;
    Haptics.selectionAsync().catch(() => undefined);
    inputRef.current?.blur();
    setDiscover(true);
    setDiscovering(true);
    setDiscoverReason(null);
    const reqId = (discoverReqRef.current += 1);
    const intent = `${item?.title ?? ''}${city ? ` in ${city}` : ''} — ${q}`.trim();
    const route =
      prevCoords || nextCoords ? { prev: prevCoords, next: nextCoords } : undefined;
    // Choosing a place for a possibly-later visit, so keep closed-now venues —
    // each card flags open/closed for the SCHEDULED time instead.
    const res = await findPlaces(q, intent, searchCenter, route, { includeClosed: true });
    if (reqId !== discoverReqRef.current) return;
    setDiscoverResults(res.places);
    if (res.places.length === 0) {
      setDiscoverReason(
        res.reason === 'no_supabase'
          ? 'Connect a places provider to discover.'
          : res.reason === 'no_location'
          ? 'Location unavailable — add a city, e.g. “coffee near Prague”.'
          : res.detail ?? 'Nothing found — try different words.',
      );
    }
    setDiscovering(false);
  };

  return (
    <View style={styles.locationBody}>
      <View style={[styles.search, { backgroundColor: t.colors.fill1 }]}>
        <Ionicons name="search" size={16} color={t.colors.textTertiary} />
        <BottomSheetTextInput
          ref={inputRef as never}
          style={[styles.searchInput, { color: t.colors.textPrimary }]}
          placeholder="Search a place or address"
          placeholderTextColor={t.colors.textTertiary}
          value={query}
          onChangeText={onChangeQuery}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
        />
        {query ? (
          <Pressable
            onPress={() => {
              Haptics.selectionAsync().catch(() => undefined);
              onChangeQuery('');
            }}
            hitSlop={8}
            accessibilityLabel="Clear search"
          >
            <Ionicons name="close-circle" size={18} color={t.colors.textTertiary} />
          </Pressable>
        ) : null}
      </View>

      <BottomSheetScrollView
        style={styles.results}
        contentContainerStyle={{ paddingBottom: 8 }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {discover ? (
          <>
            <Pressable
              onPress={() => {
                Haptics.selectionAsync().catch(() => undefined);
                setDiscover(false);
                setDiscoverResults([]);
                setDiscoverReason(null);
                setTimeout(() => inputRef.current?.focus(), 60);
              }}
              style={styles.discoverBack}
              hitSlop={6}
            >
              <Ionicons name="chevron-back" size={14} color={t.colors.accent} />
              <Text variant="caption" weight="bold" style={{ color: t.colors.accent }}>
                Back to quick search
              </Text>
            </Pressable>
            {discovering ? (
              <View style={styles.state}>
                <ActivityIndicator color={t.colors.accent} />
                <Text variant="bodySm" tone="secondary" style={{ marginTop: 10 }}>
                  Discovering places…
                </Text>
              </View>
            ) : discoverResults.length === 0 ? (
              <View style={styles.state}>
                <Ionicons name="compass-outline" size={26} color={t.colors.textTertiary} />
                <Text
                  variant="bodySm"
                  tone="tertiary"
                  style={{ textAlign: 'center', marginTop: 8 }}
                >
                  {discoverReason ?? 'Nothing found.'}
                </Text>
              </View>
            ) : (
              discoverResults.map((p) => {
                const fit = getVenueHoursStatus(
                  { name: p.name, openingHours: p.openingHours ?? undefined },
                  date,
                  item?.startTime,
                  item?.endTime,
                );
                return (
                  <Pressable
                    key={p.id}
                    onPress={() => {
                      Haptics.selectionAsync().catch(() => undefined);
                      onPick(nearbyToItineraryPlace(p, emoji));
                    }}
                    style={({ pressed }) => [
                      styles.resultCard,
                      { borderColor: t.colors.separator },
                      pressed && { backgroundColor: t.colors.fill1 },
                    ]}
                  >
                    {p.photoUrl ? (
                      <Image
                        source={{ uri: p.photoUrl }}
                        style={[styles.resultThumb, { backgroundColor: t.colors.fill1 }]}
                      />
                    ) : (
                      <View
                        style={[
                          styles.resultThumb,
                          styles.resultThumbEmpty,
                          { backgroundColor: t.colors.fill1 },
                        ]}
                      >
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
                        ) : null}
                      </View>
                      {p.reasoning ? (
                        <Text variant="caption" tone="tertiary" numberOfLines={2}>
                          {p.reasoning}
                        </Text>
                      ) : null}
                    </View>
                    <Ionicons name="add-circle" size={20} color={t.colors.accent} />
                  </Pressable>
                );
              })
            )}
          </>
        ) : (
          <>
            {searching ? (
              <View style={styles.statusRow}>
                <ActivityIndicator size="small" color={t.colors.textSecondary} />
                <Text variant="caption" tone="tertiary">
                  Searching…
                </Text>
              </View>
            ) : null}
            {predictions.map((p, i) => {
              const resolving = resolvingId === p.placeId;
              return (
                <Pressable
                  key={p.placeId}
                  onPress={() => pickPrediction(p)}
                  disabled={resolvingId !== null}
                  style={({ pressed }) => [
                    styles.hitRow,
                    { borderTopColor: t.colors.separator },
                    i === 0 && { borderTopWidth: 0 },
                    pressed && { opacity: 0.6 },
                  ]}
                >
                  {resolving ? (
                    <ActivityIndicator
                      size="small"
                      color={t.colors.textSecondary}
                      style={styles.hitIcon}
                    />
                  ) : (
                    <Ionicons
                      name="location-outline"
                      size={17}
                      color={t.colors.textSecondary}
                      style={styles.hitIcon}
                    />
                  )}
                  <View style={{ flex: 1 }}>
                    <Text variant="bodySm" weight="semibold" numberOfLines={1}>
                      {p.primary}
                    </Text>
                    {p.secondary ? (
                      <Text variant="caption" tone="tertiary" numberOfLines={1}>
                        {p.secondary}
                      </Text>
                    ) : null}
                  </View>
                </Pressable>
              );
            })}
            {!searching && q.length >= 3 && predictions.length === 0 ? (
              <Text variant="caption" tone="tertiary" style={styles.statusRow}>
                No matches — try a fuller name, or discover options below.
              </Text>
            ) : null}
            {q.length < 3 && predictions.length === 0 && !searching ? (
              <Text variant="caption" tone="tertiary" style={styles.hint}>
                Type a place or address. For ideas like “coffee near Prague”, use Discover.
              </Text>
            ) : null}

            {/* AI escalation — only when the user opts in. */}
            {q.length >= 2 ? (
              <Pressable
                onPress={runDiscover}
                style={({ pressed }) => [
                  styles.discoverBtn,
                  { borderColor: t.colors.separator, backgroundColor: t.colors.accentSoft },
                  pressed && { opacity: 0.7 },
                ]}
                accessibilityLabel={`Discover places for ${q}`}
              >
                <Ionicons name="sparkles" size={16} color={t.colors.accent} />
                <Text
                  variant="bodySm"
                  weight="bold"
                  numberOfLines={1}
                  style={{ color: t.colors.accent, flexShrink: 1 }}
                >
                  {`Discover “${q}” with AI`}
                </Text>
              </Pressable>
            ) : null}
          </>
        )}
      </BottomSheetScrollView>
    </View>
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
      onPress={() => {
        Haptics.selectionAsync().catch(() => undefined);
        onPress();
      }}
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
  content: {
    flex: 1,
    paddingHorizontal: 16,
    paddingTop: 4,
  },
  actionsScroll: {
    flex: 1,
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
  locationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 10,
    marginVertical: 8,
  },
  locationThumb: {
    width: 46,
    height: 46,
    borderRadius: 10,
  },
  locationThumbEmpty: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  changeChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  locationBody: {
    flex: 1,
  },
  pickerWrap: {
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
    borderRadius: 999,
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
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 12,
    paddingHorizontal: 12,
    height: 44,
    marginBottom: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 16,
  },
  results: {
    flex: 1,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 10,
    paddingHorizontal: 4,
  },
  hint: {
    paddingVertical: 10,
    paddingHorizontal: 4,
  },
  hitRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  hitIcon: {
    width: 18,
    textAlign: 'center',
  },
  discoverBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    height: 46,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    marginTop: 12,
  },
  discoverBack: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingVertical: 8,
    paddingHorizontal: 2,
  },
  state: {
    paddingVertical: 32,
    alignItems: 'center',
  },
  resultCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    paddingHorizontal: 10,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: 8,
  },
  resultThumb: {
    width: 56,
    height: 56,
    borderRadius: 12,
  },
  resultThumbEmpty: {
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
