import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  StyleSheet,
  View,
  type TextInput,
} from 'react-native';
import { BottomSheetTextInput } from '@gorhom/bottom-sheet';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useTheme } from '@/theme/useTheme';
import { Text } from './Text';
import {
  autocompletePlaces,
  resolvePlace,
  type PlacePrediction,
} from '@/lib/geocoding';
import { getOpeningHoursStatus } from '@/lib/itinerary/hours';
import { todayISO } from '@/utils/time';
import type { VenueOpeningHours } from '@/types/itinerary';

/**
 * A place selection. `label` is always set; coords + rich metadata (photo,
 * rating, hours) are present once a real Google place is picked from search.
 */
export interface AddressValue {
  label: string;
  latitude?: number;
  longitude?: number;
  placeId?: string | null;
  photoUrl?: string | null;
  rating?: number | null;
  ratingCount?: number | null;
  priceLevel?: number | null;
  openingHours?: VenueOpeningHours | null;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Compact review count: 489450 → "489k", 1234 → "1.2k". */
function formatReviews(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}

/**
 * Today's (or the errand day's) opening line, prefix stripped:
 * "Monday: 9:30 AM – 11:00 PM" → "9:30 AM – 11:00 PM".
 */
function hoursLineFor(
  hours: VenueOpeningHours | null | undefined,
  dateISO?: string,
): string | null {
  const desc = hours?.weekdayDescriptions;
  if (!desc || desc.length < 7) return null;
  const d = dateISO ? new Date(`${dateISO}T00:00:00`) : new Date();
  if (Number.isNaN(d.getTime())) return null;
  // Google lists Monday first (index 0); JS getDay() is 0=Sunday.
  const idx = (d.getDay() + 6) % 7;
  const line = desc[idx];
  return typeof line === 'string' ? line.replace(/^[^:]+:\s*/, '') : null;
}

type SearchState =
  | { kind: 'idle' }
  | { kind: 'searching' }
  | { kind: 'results'; predictions: PlacePrediction[] }
  | { kind: 'no_results' };

const SEARCH_DEBOUNCE_MS = 300;
const MAX_RESULTS = 6;

function newSessionToken(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

interface Props {
  value: AddressValue | null;
  /** Bias search toward here (the user's home) so nearby places rank first. */
  center?: { latitude: number; longitude: number } | null;
  /** Bumped by the parent whenever the form is (re)seeded. */
  seedKey: string;
  /**
   * If set when `seedKey` changes, the field auto-opens search prefilled with
   * this text — so the address the AI extracted immediately surfaces real
   * matches to confirm or correct. Pass null/empty to just rest.
   */
  seedQuery?: string | null;
  /** The errand's scheduled day/time, so the card can show open/closed for it
   *  (falls back to "open right now" when the errand has no set time). */
  dateISO?: string;
  startTime?: string;
  endTime?: string;
  onChange: (next: AddressValue | null) => void;
}

/**
 * The "Where" control for an errand. Instead of a dumb text box, this is a live
 * Google Places picker (with Nominatim fallback): it auto-searches the address
 * the AI extracted and offers a few matches to confirm, lets the user search
 * manually, keep raw text as-is, or clear it. Picking a match stores real
 * coordinates so the planner can later route to the errand.
 */
export function ErrandAddressField({
  value,
  center,
  seedKey,
  seedQuery,
  dateISO,
  startTime,
  endTime,
  onChange,
}: Props) {
  const t = useTheme();
  const [editing, setEditing] = useState(false);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState<SearchState>({ kind: 'idle' });
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const inputRef = useRef<TextInput>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // One Google "session" per search so autocomplete + details bill as a unit.
  const sessionRef = useRef<string>(newSessionToken());
  // Set when an AI-seeded search should auto-select its best match (so the
  // errand lands on a real, pinned business instead of plain text). Consumed
  // once, the first time results come back for that seed.
  const autoResolveRef = useRef(false);

  const located = value?.latitude != null && value?.longitude != null;
  const centerKey = center ? `${center.latitude},${center.longitude}` : '';

  // React to (re)seeds: auto-open search for the AI's guess, else rest. We read
  // `seedQuery` (not `value`) because the parent commits `value` via an effect
  // that lands a render later, whereas `seedQuery` is in sync with `seedKey`.
  useEffect(() => {
    sessionRef.current = newSessionToken();
    setResolvingId(null);
    const sq = seedQuery?.trim() ?? '';
    if (sq.length >= 3) {
      setQuery(sq);
      setEditing(true);
      // The AI gave us an address — confirm it for real against Google and
      // auto-select the top hit, rather than leaving the user on plain text.
      autoResolveRef.current = true;
    } else {
      setQuery('');
      setEditing(false);
      setSearch({ kind: 'idle' });
      autoResolveRef.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedKey]);

  // Debounced place + address search while the field is open.
  useEffect(() => {
    if (!editing) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = query.trim();
    if (q.length < 3) {
      setSearch({ kind: 'idle' });
      return;
    }
    setSearch({ kind: 'searching' });
    debounceRef.current = setTimeout(async () => {
      const predictions = await autocompletePlaces(
        q,
        center ?? null,
        sessionRef.current,
      );
      if (predictions.length === 0) {
        autoResolveRef.current = false;
        setSearch({ kind: 'no_results' });
        return;
      }
      const top = predictions.slice(0, MAX_RESULTS);
      setSearch({ kind: 'results', predictions: top });
      // First results after an AI seed → auto-confirm the best match so the
      // errand gets a real pinned business (photo/rating/hours) instead of
      // plain text. Costs one Place Details call; the user can still tap to
      // change it. Manual typing never auto-resolves (flag stays false).
      if (autoResolveRef.current) {
        autoResolveRef.current = false;
        void pick(top[0]);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, editing, centerKey]);

  const openEdit = () => {
    Haptics.selectionAsync().catch(() => undefined);
    sessionRef.current = newSessionToken();
    setQuery(value?.label ?? '');
    setEditing(true);
    // Focus once the field is mounted so the keyboard rises with it.
    setTimeout(() => inputRef.current?.focus(), 60);
  };

  const closeEdit = () => {
    inputRef.current?.blur();
    setEditing(false);
    setQuery('');
    setSearch({ kind: 'idle' });
    setResolvingId(null);
  };

  const clear = () => {
    Haptics.selectionAsync().catch(() => undefined);
    onChange(null);
    closeEdit();
  };

  const pick = async (prediction: PlacePrediction) => {
    Haptics.selectionAsync().catch(() => undefined);
    setResolvingId(prediction.placeId);
    const resolved = await resolvePlace(prediction.placeId, sessionRef.current);
    sessionRef.current = newSessionToken();
    if (!resolved) {
      // Couldn't fetch coordinates — keep the chosen name as an unpinned label.
      onChange({ label: prediction.primary });
      closeEdit();
      return;
    }
    onChange({
      label: resolved.label,
      latitude: resolved.latitude,
      longitude: resolved.longitude,
      placeId: resolved.placeId ?? null,
      photoUrl: resolved.photoUrl ?? null,
      rating: resolved.rating ?? null,
      ratingCount: resolved.ratingCount ?? null,
      priceLevel: resolved.priceLevel ?? null,
      openingHours: resolved.openingHours ?? null,
    });
    closeEdit();
  };

  const keepAsTyped = () => {
    const q = query.trim();
    if (!q) return;
    Haptics.selectionAsync().catch(() => undefined);
    onChange({ label: q });
    closeEdit();
  };

  // ----------------------------------------------------------------- editing
  if (editing) {
    const q = query.trim();
    return (
      <View style={styles.wrap}>
        <View
          style={[
            styles.searchField,
            {
              backgroundColor: t.colors.fill1,
              borderColor: t.colors.separator,
            },
          ]}
        >
          <Ionicons name="search" size={17} color={t.colors.textSecondary} />
          <BottomSheetTextInput
            // gorhom types its ref against gesture-handler's TextInput; we only
            // call focus()/blur(), which the native input supports.
            ref={inputRef as never}
            placeholder="Search a place or address"
            placeholderTextColor={t.colors.textTertiary}
            value={query}
            onChangeText={setQuery}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            style={[styles.searchInput, { color: t.colors.textPrimary }]}
          />
          <Pressable
            onPress={() => {
              Haptics.selectionAsync().catch(() => undefined);
              closeEdit();
            }}
            hitSlop={8}
            accessibilityLabel="Cancel address search"
          >
            <Ionicons
              name="close-circle"
              size={18}
              color={t.colors.textTertiary}
            />
          </Pressable>
        </View>

        <View style={styles.results}>
          {search.kind === 'searching' ? (
            <View style={styles.statusRow}>
              <ActivityIndicator size="small" color={t.colors.textSecondary} />
              <Text variant="caption" tone="tertiary">
                Searching…
              </Text>
            </View>
          ) : null}
          {search.kind === 'no_results' ? (
            <Text variant="caption" tone="tertiary" style={styles.statusRow}>
              No matches — try a place name or a fuller address.
            </Text>
          ) : null}
          {search.kind === 'results'
            ? search.predictions.map((p, i) => {
                const isResolving = resolvingId === p.placeId;
                return (
                  <Pressable
                    key={p.placeId}
                    onPress={() => pick(p)}
                    disabled={resolvingId !== null}
                    style={({ pressed }) => [
                      styles.hitRow,
                      i > 0 && {
                        borderTopWidth: StyleSheet.hairlineWidth,
                        borderTopColor: t.colors.separator,
                      },
                      pressed && { opacity: 0.6 },
                    ]}
                  >
                    {isResolving ? (
                      <ActivityIndicator
                        size="small"
                        color={t.colors.textSecondary}
                        style={styles.hitIcon}
                      />
                    ) : (
                      <Ionicons
                        name="location-outline"
                        size={16}
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
              })
            : null}

          {/* Manual escape hatch: keep whatever was typed as an unpinned place. */}
          {q.length > 0 ? (
            <Pressable
              onPress={keepAsTyped}
              style={({ pressed }) => [
                styles.hitRow,
                {
                  borderTopWidth: StyleSheet.hairlineWidth,
                  borderTopColor: t.colors.separator,
                },
                pressed && { opacity: 0.6 },
              ]}
            >
              <Ionicons
                name="create-outline"
                size={16}
                color={t.colors.textSecondary}
                style={styles.hitIcon}
              />
              <Text variant="bodySm" numberOfLines={1} style={{ flex: 1 }}>
                Use “{q}” as typed
              </Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    );
  }

  // ------------------------------------------------------------ resting: empty
  if (!value) {
    return (
      <Pressable
        onPress={openEdit}
        style={({ pressed }) => [
          styles.restEmpty,
          { backgroundColor: t.colors.fill1, borderColor: t.colors.separator },
          pressed && { opacity: 0.7 },
        ]}
        accessibilityRole="button"
        accessibilityLabel="Add a place"
      >
        <Ionicons name="search" size={17} color={t.colors.textTertiary} />
        <Text variant="body" tone="tertiary" style={{ flex: 1 }}>
          Anywhere — tap to add a place
        </Text>
      </Pressable>
    );
  }

  // -------------------------------------------------- resting: has a selection
  const rating = typeof value.rating === 'number' ? value.rating : null;
  const ratingCount =
    typeof value.ratingCount === 'number' ? value.ratingCount : null;
  const hours = value.openingHours ?? null;
  const timed = !!startTime;

  // Open/closed status — against the errand's scheduled window when it has one,
  // otherwise "right now".
  const now = new Date();
  const hoursStatus = hours
    ? getOpeningHoursStatus(
        hours,
        timed ? dateISO ?? todayISO() : todayISO(),
        timed ? startTime : `${pad2(now.getHours())}:${pad2(now.getMinutes())}`,
        timed ? endTime : undefined,
      )
    : null;
  const hoursLine = hoursLineFor(hours, timed ? dateISO : undefined);

  let statusChip: { label: string; color: string } | null = null;
  if (hoursStatus && hoursStatus.status !== 'unknown') {
    const s = hoursStatus.status;
    const color =
      s === 'open'
        ? t.colors.success
        : s === 'closingSoon'
        ? t.colors.warning
        : t.colors.danger;
    const label =
      s === 'open'
        ? timed
          ? hoursStatus.statusLabel ?? 'Open'
          : 'Open now'
        : s === 'closingSoon'
        ? hoursStatus.statusLabel ?? 'Closes soon'
        : timed
        ? 'Closed then'
        : 'Closed now';
    statusChip = { label, color };
  }

  return (
    <Pressable
      onPress={openEdit}
      style={({ pressed }) => [
        styles.card,
        { borderColor: t.colors.separator },
        pressed && { backgroundColor: t.colors.fill1 },
      ]}
      accessibilityRole="button"
      accessibilityLabel={`Place: ${value.label}. Tap to change.`}
    >
      {value.photoUrl ? (
        <Image
          source={{ uri: value.photoUrl }}
          style={[styles.thumb, { backgroundColor: t.colors.fill1 }]}
        />
      ) : (
        <View
          style={[styles.thumb, styles.thumbEmpty, { backgroundColor: t.colors.fill1 }]}
        >
          <Ionicons
            name={located ? 'location' : 'location-outline'}
            size={20}
            color={located ? t.colors.accentText : t.colors.textSecondary}
          />
        </View>
      )}
      <View style={styles.cardBody}>
        <Text variant="body" weight="semibold" numberOfLines={1}>
          {value.label}
        </Text>
        {rating != null || statusChip ? (
          <View style={styles.cardMeta}>
            {rating != null ? (
              <View style={styles.metaItem}>
                <Ionicons name="star" size={12} color={t.colors.highlightYellow} />
                <Text variant="caption" tone="secondary" weight="semibold">
                  {rating.toFixed(1)}
                  {ratingCount != null ? ` (${formatReviews(ratingCount)})` : ''}
                </Text>
              </View>
            ) : null}
            {statusChip ? (
              <Text
                variant="caption"
                weight="semibold"
                style={{ color: statusChip.color }}
                numberOfLines={1}
              >
                {statusChip.label}
              </Text>
            ) : null}
          </View>
        ) : null}
        <Text variant="caption" tone="tertiary" numberOfLines={1}>
          {hoursLine ??
            (located
              ? 'Pinned location'
              : 'Not pinned — tap to find the exact place')}
        </Text>
      </View>
      <Pressable
        onPress={clear}
        hitSlop={8}
        accessibilityLabel="Clear place"
        style={styles.cardClear}
      >
        <Ionicons name="close-circle" size={20} color={t.colors.textTertiary} />
      </Pressable>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: {
    gap: 8,
  },
  searchField: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 46,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
  },
  searchInput: {
    flex: 1,
    fontSize: 16,
    paddingVertical: 12,
  },
  results: {
    borderRadius: 12,
    overflow: 'hidden',
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 10,
    paddingHorizontal: 4,
  },
  hitRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 12,
    paddingHorizontal: 4,
  },
  hitIcon: {
    width: 16,
    textAlign: 'center',
  },
  restEmpty: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: 46,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 10,
  },
  thumb: {
    width: 52,
    height: 52,
    borderRadius: 10,
  },
  thumbEmpty: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardBody: {
    flex: 1,
    gap: 3,
  },
  cardMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flexWrap: 'wrap',
  },
  metaItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  cardClear: {
    alignSelf: 'flex-start',
  },
});
