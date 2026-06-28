import React, { useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useTheme } from '@/theme/useTheme';
import { TopBar } from '@/components/TopBar';
import { Card } from '@/components/Card';
import { Text } from '@/components/Text';
import { Input } from '@/components/Input';
import { Button } from '@/components/Button';
import { useHomeStore } from '@/store/useHomeStore';
import { formatDistance, type NearbyPlace } from '@/lib/places';
import { discoverPlaces, type DiscoverResult } from '@/lib/discover';

/**
 * DEV-only sandbox for the Phase 2 place-discovery data layer. Lets us fire
 * real "find a place" queries and eyeball the candidates, the AI blurbs, the
 * resolved search center, and how fast/cheap the call was — before the Phase 3
 * UI is built. Reached from Settings → Developer (only in __DEV__).
 */
export default function DiscoverSandboxScreen() {
  const t = useTheme();
  const router = useRouter();
  const home = useHomeStore((s) => s.home);

  const [query, setQuery] = useState('pharmacy');
  const [area, setArea] = useState('Karlín');
  const [nearby, setNearby] = useState(false);
  const [forceSmart, setForceSmart] = useState(false);
  const [loading, setLoading] = useState(false);
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);
  const [result, setResult] = useState<DiscoverResult | null>(null);

  const run = async () => {
    if (!query.trim() || loading) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
    setLoading(true);
    setResult(null);
    setElapsedMs(null);
    const startedAt = Date.now();
    try {
      const res = await discoverPlaces({
        query,
        area: nearby ? null : area,
        nearby,
        fallbackCenter: home
          ? { latitude: home.latitude, longitude: home.longitude }
          : null,
        // Feed the typed line to the concierge verbatim so question/problem
        // phrasing ("where can I…") routes correctly and "cheap/fast" survives.
        phrase: query,
        // On → force the web-grounded curated path; off → auto-detect from text.
        ...(forceSmart ? { smart: true } : {}),
      });
      setResult(res);
    } finally {
      setElapsedMs(Date.now() - startedAt);
      setLoading(false);
    }
  };

  const serverDebug = (result?.debug as any)?.debug;

  return (
    <SafeAreaView
      style={[styles.container, { backgroundColor: t.colors.background }]}
      edges={['top', 'bottom']}
    >
      <TopBar
        title="Discovery sandbox"
        left={{ icon: 'close', onPress: () => router.back(), accessibilityLabel: 'Close' }}
      />

      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Card padded style={styles.form}>
          <View style={styles.field}>
            <Text variant="caption" tone="secondary" weight="semibold" uppercase>
              What to find
            </Text>
            <Input
              value={query}
              onChangeText={setQuery}
              placeholder="e.g. pharmacy, coworking or cafe"
              returnKeyType="search"
              onSubmitEditing={run}
            />
          </View>

          <View style={styles.field}>
            <Text variant="caption" tone="secondary" weight="semibold" uppercase>
              Area (optional)
            </Text>
            <Input
              value={area}
              onChangeText={setArea}
              placeholder="e.g. Karlín"
              editable={!nearby}
              returnKeyType="search"
              onSubmitEditing={run}
            />
          </View>

          <Pressable
            onPress={() => {
              Haptics.selectionAsync().catch(() => undefined);
              setNearby((v) => !v);
            }}
            style={styles.toggleRow}
          >
            <View style={{ flex: 1 }}>
              <Text variant="body" weight="semibold">
                Search near me
              </Text>
              <Text variant="caption" tone="secondary">
                Use current GPS location instead of an area
              </Text>
            </View>
            <Switch
              value={nearby}
              onValueChange={(v) => {
                Haptics.selectionAsync().catch(() => undefined);
                setNearby(v);
              }}
              trackColor={{ true: t.colors.accent, false: t.colors.fill2 }}
            />
          </Pressable>

          <Pressable
            onPress={() => {
              Haptics.selectionAsync().catch(() => undefined);
              setForceSmart((v) => !v);
            }}
            style={styles.toggleRow}
          >
            <View style={{ flex: 1 }}>
              <Text variant="body" weight="semibold">
                Force curated (web)
              </Text>
              <Text variant="caption" tone="secondary">
                Use the Gemini-grounded concierge even for plain queries
              </Text>
            </View>
            <Switch
              value={forceSmart}
              onValueChange={(v) => {
                Haptics.selectionAsync().catch(() => undefined);
                setForceSmart(v);
              }}
              trackColor={{ true: t.colors.accent, false: t.colors.fill2 }}
            />
          </Pressable>

          <Button
            title="Discover"
            onPress={run}
            loading={loading}
            disabled={!query.trim()}
            fullWidth
            size="lg"
          />
          {!home && !nearby ? (
            <Text variant="caption" tone="tertiary">
              No home set — falls back to GPS. Set a home in Settings to test the
              from-home path.
            </Text>
          ) : null}
        </Card>

        {loading ? (
          <View style={styles.loading}>
            <ActivityIndicator color={t.colors.accent} />
            <Text variant="bodySm" tone="secondary">
              Searching…
            </Text>
          </View>
        ) : null}

        {result ? (
          <>
            <Card padded style={styles.statusCard}>
              <StatRow label="Center" value={`${result.centerLabel ?? '—'} (${result.centerSource})`} />
              <StatRow label="Provider" value={result.provider} />
              <StatRow
                label="Path"
                value={result.curated ? 'curated (web-grounded)' : 'category search'}
              />
              <StatRow
                label="Latency"
                value={elapsedMs != null ? `${elapsedMs} ms` : '—'}
              />
              <StatRow
                label="AI re-rank"
                value={
                  serverDebug?.aiUsed === true
                    ? 'yes (gpt-4o-mini)'
                    : serverDebug?.aiUsed === false
                    ? `no${serverDebug?.aiFailureReason ? ` — ${serverDebug.aiFailureReason}` : ''}`
                    : '—'
                }
              />
              <StatRow
                label="Pool / shown"
                value={`${serverDebug?.candidatePoolSize ?? '—'} / ${result.places.length}`}
              />
              <StatRow label="Queries" value={result.queries.join('  •  ')} />
              {result.detail ? <StatRow label="Note" value={result.detail} /> : null}
            </Card>

            {result.answer ? (
              <Card padded style={styles.answerCard}>
                <View style={styles.answerHead}>
                  <Ionicons name="sparkles" size={14} color={t.colors.accent} />
                  <Text variant="caption" tone="secondary" weight="semibold" uppercase>
                    Answer
                  </Text>
                </View>
                <Text variant="body">{result.answer}</Text>
              </Card>
            ) : null}

            {result.places.map((p) => <PlaceResultCard key={p.id} place={p} />)}

            {result.suggestions && result.suggestions.length > 0 ? (
              <Card padded style={styles.tipsCard}>
                <Text variant="caption" tone="secondary" weight="semibold" uppercase>
                  Tips ({result.suggestions.length})
                </Text>
                {result.suggestions.map((tip, i) => (
                  <View key={`${tip.title}-${i}`} style={styles.tipItem}>
                    <Text variant="bodySm" weight="semibold">
                      {tip.title}
                    </Text>
                    {tip.detail ? (
                      <Text variant="caption" tone="secondary">
                        {tip.detail}
                      </Text>
                    ) : null}
                    {tip.searchQuery ? (
                      <Text variant="caption" tone="tertiary">
                        search: “{tip.searchQuery}”
                      </Text>
                    ) : null}
                  </View>
                ))}
              </Card>
            ) : null}

            {result.places.length === 0 &&
            !result.answer &&
            (!result.suggestions || result.suggestions.length === 0) ? (
              <Text variant="body" tone="secondary" style={styles.empty}>
                Nothing came back. Reason: {result.reason ?? 'unknown'}.
              </Text>
            ) : null}
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function StatRow({ label, value }: { label: string; value: string }) {
  const t = useTheme();
  return (
    <View style={styles.statRow}>
      <Text variant="caption" tone="tertiary" style={styles.statLabel}>
        {label}
      </Text>
      <Text variant="caption" tone="secondary" style={{ flex: 1, color: t.colors.textSecondary }}>
        {value}
      </Text>
    </View>
  );
}

function PlaceResultCard({ place }: { place: NearbyPlace }) {
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
    <Card padded style={styles.placeCard}>
      <View style={styles.placeTop}>
        {place.photoUrl ? (
          <Image source={{ uri: place.photoUrl }} style={styles.photo} />
        ) : (
          <View style={[styles.photo, styles.photoFallback, { backgroundColor: t.colors.fill1 }]}>
            <Ionicons name="image-outline" size={20} color={t.colors.textTertiary} />
          </View>
        )}
        <View style={{ flex: 1, gap: 3 }}>
          <Text variant="body" weight="semibold" numberOfLines={1}>
            {place.name}
          </Text>
          <Text variant="caption" tone="secondary">
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
      </View>
      {place.address ? (
        <Text variant="caption" tone="tertiary" numberOfLines={1}>
          {place.address}
        </Text>
      ) : null}
      {place.reasoning ? (
        <View style={[styles.blurb, { backgroundColor: t.colors.fill1 }]}>
          <Ionicons name="sparkles-outline" size={13} color={t.colors.accent} />
          <Text variant="caption" tone="secondary" style={{ flex: 1 }}>
            {place.reasoning}
          </Text>
        </View>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 32,
    gap: 14,
  },
  form: {
    gap: 14,
  },
  field: {
    gap: 8,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  loading: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingVertical: 12,
  },
  statusCard: {
    gap: 8,
  },
  statRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  statLabel: {
    width: 96,
  },
  empty: {
    textAlign: 'center',
    paddingVertical: 16,
  },
  answerCard: {
    gap: 8,
  },
  answerHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  tipsCard: {
    gap: 10,
  },
  tipItem: {
    gap: 2,
  },
  placeCard: {
    gap: 10,
  },
  placeTop: {
    flexDirection: 'row',
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
});
