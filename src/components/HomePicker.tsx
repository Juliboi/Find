import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Location from 'expo-location';
import * as Haptics from 'expo-haptics';
import { useTheme } from '@/theme/useTheme';
import { useHomeStore, type LocationPin } from '@/store/useHomeStore';
import { reverseGeocode, searchAddresses, type GeocodeHit } from '@/lib/geocoding';
import { Card } from './Card';
import { Text } from './Text';
import { Button } from './Button';
import { Input } from './Input';

interface Props {
  /**
   * Optional title override. The sandbox uses "Home", but this component
   * can later be reused for any pinned location.
   */
  title?: string;
  /** Render without a wrapping Card (e.g. when inside another Card). */
  flat?: boolean;
}

type SearchState =
  | { kind: 'idle' }
  | { kind: 'searching' }
  | { kind: 'results'; hits: GeocodeHit[] }
  | { kind: 'no_results' }
  | { kind: 'error' };

const SEARCH_DEBOUNCE_MS = 350;

export function HomePicker({ title = 'Home', flat }: Props) {
  const t = useTheme();
  const home = useHomeStore((s) => s.home);
  const setHome = useHomeStore((s) => s.setHome);
  const clearHome = useHomeStore((s) => s.clearHome);

  const [query, setQuery] = useState('');
  const [search, setSearch] = useState<SearchState>({ kind: 'idle' });
  const [gpsLoading, setGpsLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = query.trim();
    if (q.length < 3) {
      setSearch({ kind: 'idle' });
      return;
    }
    setSearch({ kind: 'searching' });
    debounceRef.current = setTimeout(async () => {
      const hits = await searchAddresses(q, 6);
      if (hits.length > 0) setSearch({ kind: 'results', hits });
      else setSearch({ kind: 'no_results' });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  const useCurrentLocation = async () => {
    setGpsLoading(true);
    try {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (perm.status !== 'granted') return;
      const pos = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      const label =
        (await reverseGeocode(pos.coords.latitude, pos.coords.longitude)) ??
        `${pos.coords.latitude.toFixed(4)}, ${pos.coords.longitude.toFixed(4)}`;
      const pin: LocationPin = {
        label,
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
      };
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(
        () => undefined,
      );
      setHome(pin);
      setQuery('');
      setSearch({ kind: 'idle' });
    } finally {
      setGpsLoading(false);
    }
  };

  const pickHit = (hit: GeocodeHit) => {
    setHome({
      label: hit.label,
      latitude: hit.latitude,
      longitude: hit.longitude,
    });
    Haptics.selectionAsync().catch(() => undefined);
    setQuery('');
    setSearch({ kind: 'idle' });
  };

  const Body = (
    <View style={{ gap: t.spacing.md }}>
      <View style={styles.headerRow}>
        <Text variant="title3" weight="bold" tight>
          {title}
        </Text>
        {home ? (
          <Pressable
            hitSlop={8}
            onPress={clearHome}
            style={({ pressed }) => [pressed && { opacity: 0.6 }]}
          >
            <Text variant="bodySm" tone="accent" weight="semibold">
              Clear
            </Text>
          </Pressable>
        ) : null}
      </View>

      {home ? (
        <View
          style={[
            styles.currentRow,
            {
              backgroundColor: t.colors.accentSoft,
              borderRadius: t.radii.md,
              padding: t.spacing.md,
            },
          ]}
        >
          <Ionicons name="location" size={18} color={t.colors.accentText} />
          <View style={{ flex: 1 }}>
            <Text variant="bodySm" weight="semibold">
              {home.label}
            </Text>
            <Text variant="caption" tone="secondary">
              {home.latitude.toFixed(4)}, {home.longitude.toFixed(4)}
            </Text>
          </View>
        </View>
      ) : (
        <Text variant="bodySm" tone="secondary">
          Not set yet — pick a place so Diem can plan around it.
        </Text>
      )}

      <Button
        title={home ? 'Update from GPS' : 'Use current location'}
        variant="tonal"
        size="md"
        leftIcon={
          gpsLoading ? null : (
            <Ionicons name="locate" size={18} color={t.colors.accentText} />
          )
        }
        onPress={useCurrentLocation}
        loading={gpsLoading}
      />

      <Input
        placeholder="Or search an address"
        leftIcon="search"
        value={query}
        onChangeText={setQuery}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
      />

      {search.kind === 'searching' ? (
        <View style={styles.searchRow}>
          <ActivityIndicator size="small" color={t.colors.accentText} />
          <Text variant="caption" tone="secondary">
            Searching…
          </Text>
        </View>
      ) : null}
      {search.kind === 'no_results' ? (
        <Text variant="caption" tone="secondary">
          No matches.
        </Text>
      ) : null}
      {search.kind === 'results' ? (
        <View
          style={[
            styles.hitsBox,
            {
              backgroundColor: t.colors.fill1,
              borderRadius: t.radii.md,
            },
          ]}
        >
          {search.hits.map((hit, idx) => (
            <Pressable
              key={hit.osmId}
              onPress={() => pickHit(hit)}
              style={({ pressed }) => [
                styles.hitRow,
                idx > 0 && {
                  borderTopWidth: StyleSheet.hairlineWidth,
                  borderTopColor: t.colors.separator,
                },
                pressed && { opacity: 0.7 },
              ]}
            >
              <Ionicons
                name="location-outline"
                size={16}
                color={t.colors.textSecondary}
              />
              <Text variant="bodySm" numberOfLines={2} style={{ flex: 1 }}>
                {hit.label}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );

  if (flat) return Body;

  return <Card padded>{Body}</Card>;
}

const styles = StyleSheet.create({
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  currentRow: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'flex-start',
  },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  hitsBox: {
    paddingHorizontal: 12,
  },
  hitRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    gap: 10,
  },
});
