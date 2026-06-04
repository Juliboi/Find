import React, { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text as RNText,
  TextInput,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useTheme } from '@/theme/useTheme';
import { TopBar } from '@/components/TopBar';
import { Card } from '@/components/Card';
import { Text } from '@/components/Text';
import { Button } from '@/components/Button';
import { getCurrentCoords } from '@/lib/places';
import {
  findPlacesGrounded,
  isGeminiConfigured,
  isGroundedError,
  type GroundedResult,
} from '@/lib/groundedPlaces';

// Bohnice, Prague 8 — the neighborhood from the original screenshot, right
// where RVL13 Streetworkout sits. Used as the default so the screen is
// useful even before granting location permission.
const BOHNICE = { latitude: 50.1306, longitude: 14.4146 };

export default function PlaceFinderScreen() {
  const router = useRouter();
  const t = useTheme();

  const [query, setQuery] = useState('pullup bar in bohnice');
  const [lat, setLat] = useState(String(BOHNICE.latitude));
  const [lon, setLon] = useState(String(BOHNICE.longitude));
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<GroundedResult | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [showDebug, setShowDebug] = useState(false);
  const [debugPayload, setDebugPayload] = useState<unknown>(null);

  const useMyLocation = async () => {
    Haptics.selectionAsync().catch(() => undefined);
    const coords = await getCurrentCoords();
    if (!coords) {
      setErrorMsg('Location permission denied or unavailable.');
      return;
    }
    setLat(String(coords.latitude));
    setLon(String(coords.longitude));
  };

  const useBohnice = () => {
    Haptics.selectionAsync().catch(() => undefined);
    setLat(String(BOHNICE.latitude));
    setLon(String(BOHNICE.longitude));
  };

  const run = async () => {
    const q = query.trim();
    const latN = Number(lat);
    const lonN = Number(lon);
    if (!q || loading) return;
    if (!Number.isFinite(latN) || !Number.isFinite(lonN)) {
      setErrorMsg('Latitude / longitude must be valid numbers.');
      return;
    }
    Haptics.selectionAsync().catch(() => undefined);
    setLoading(true);
    setErrorMsg(null);
    setResult(null);
    setDebugPayload(null);

    const res = await findPlacesGrounded(q, latN, lonN);
    if (isGroundedError(res)) {
      setErrorMsg(res.detail ? `${res.error}: ${res.detail}` : res.error);
      setDebugPayload(res.debug ?? null);
    } else {
      setResult(res);
      setDebugPayload(res.debug);
    }
    setLoading(false);
  };

  const reset = () => {
    setResult(null);
    setErrorMsg(null);
    setDebugPayload(null);
  };

  return (
    <SafeAreaView
      style={[styles.container, { backgroundColor: t.colors.background }]}
      edges={['top']}
    >
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <TopBar
          kicker="Experiment"
          title="Grounded finder"
          left={{
            icon: 'chevron-back',
            onPress: () => router.back(),
            accessibilityLabel: 'Back',
          }}
          actions={[
            { icon: 'refresh', onPress: reset, accessibilityLabel: 'Reset' },
          ]}
        />

        <ScrollView
          contentContainerStyle={[
            styles.scrollContent,
            {
              paddingHorizontal: t.spacing.lg,
              paddingTop: t.spacing.md,
              paddingBottom: 60,
            },
          ]}
          keyboardShouldPersistTaps="handled"
        >
          <Card padded>
            <Text variant="title3" weight="bold" tight>
              One grounded call
            </Text>
            <Text variant="bodySm" tone="secondary" style={{ marginTop: 6 }}>
              Sends your raw query + coordinates straight to Gemini with Google
              Search grounding and returns whatever it picks. No category regex,
              no composite score, no re-rank pass, no edge function — the
              opposite of the find-places pipeline.
            </Text>

            <TextInput
              style={[
                styles.input,
                {
                  backgroundColor: t.colors.fill1,
                  color: t.colors.textPrimary,
                  borderRadius: t.radii.md,
                  marginTop: 12,
                },
              ]}
              placeholder="e.g. pullup bar in bohnice"
              placeholderTextColor={t.colors.textTertiary}
              value={query}
              onChangeText={setQuery}
              autoCapitalize="none"
              autoCorrect={false}
              onSubmitEditing={run}
              returnKeyType="search"
            />

            <View style={styles.coordRow}>
              <View style={{ flex: 1 }}>
                <Text variant="micro" tone="secondary" uppercase weight="bold">
                  Latitude
                </Text>
                <TextInput
                  style={[
                    styles.coordInput,
                    {
                      backgroundColor: t.colors.fill1,
                      color: t.colors.textPrimary,
                      borderRadius: t.radii.sm,
                    },
                  ]}
                  value={lat}
                  onChangeText={setLat}
                  keyboardType="numbers-and-punctuation"
                  autoCorrect={false}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Text variant="micro" tone="secondary" uppercase weight="bold">
                  Longitude
                </Text>
                <TextInput
                  style={[
                    styles.coordInput,
                    {
                      backgroundColor: t.colors.fill1,
                      color: t.colors.textPrimary,
                      borderRadius: t.radii.sm,
                    },
                  ]}
                  value={lon}
                  onChangeText={setLon}
                  keyboardType="numbers-and-punctuation"
                  autoCorrect={false}
                />
              </View>
            </View>

            <View style={styles.locButtons}>
              <Button
                title="Use my GPS"
                variant="secondary"
                size="sm"
                leftIcon={
                  <Ionicons
                    name="navigate"
                    size={14}
                    color={t.colors.textPrimary}
                  />
                }
                onPress={useMyLocation}
                style={{ flex: 1 }}
              />
              <Button
                title="Bohnice"
                variant="secondary"
                size="sm"
                onPress={useBohnice}
                style={{ flex: 1 }}
              />
            </View>

            <Button
              title="Find places"
              onPress={run}
              loading={loading}
              disabled={query.trim().length === 0}
              style={{ marginTop: 12 }}
              fullWidth
            />

            {!isGeminiConfigured ? (
              <Text variant="caption" tone="danger" style={{ marginTop: 10 }}>
                EXPO_PUBLIC_GEMINI_API_KEY is not set — add it to .env and
                restart the dev server.
              </Text>
            ) : null}
          </Card>

          {errorMsg ? (
            <Card padded style={{ borderColor: t.colors.danger, borderWidth: 1 }}>
              <Text variant="bodySm" tone="danger">
                {errorMsg}
              </Text>
            </Card>
          ) : null}

          {result ? (
            <View style={{ gap: 12 }}>
              <View style={styles.resultHeader}>
                <Text variant="title3" weight="bold" tight>
                  {result.places.length}{' '}
                  {result.places.length === 1 ? 'result' : 'results'}
                </Text>
                <Text variant="caption" tone="secondary">
                  {result.model} · {result.elapsedMs} ms · 1 call
                </Text>
              </View>

              {result.places.length === 0 ? (
                <Card padded>
                  <Text variant="bodySm" tone="secondary">
                    The model returned no parseable places. Check the raw
                    response in Debug below.
                  </Text>
                </Card>
              ) : (
                result.places.map((p, i) => (
                  <Card padded key={`${p.name}-${i}`}>
                    <View style={styles.placeTop}>
                      <Text variant="body" weight="semibold" style={{ flex: 1 }}>
                        {p.name}
                      </Text>
                      {p.rating != null ? (
                        <View
                          style={[
                            styles.ratingPill,
                            { backgroundColor: t.colors.accentSoft },
                          ]}
                        >
                          <Ionicons
                            name="star"
                            size={11}
                            color={t.colors.accentText}
                          />
                          <Text variant="micro" weight="bold" tone="accent">
                            {p.rating}
                          </Text>
                        </View>
                      ) : null}
                    </View>
                    {p.address ? (
                      <Text
                        variant="caption"
                        tone="secondary"
                        style={{ marginTop: 2 }}
                      >
                        {p.address}
                      </Text>
                    ) : null}
                    {p.why ? (
                      <Text variant="bodySm" style={{ marginTop: 6 }}>
                        {p.why}
                      </Text>
                    ) : null}
                    <View style={styles.metaRow}>
                      {p.approxDistanceKm != null ? (
                        <Text variant="micro" tone="tertiary">
                          ~{p.approxDistanceKm} km
                        </Text>
                      ) : null}
                      {p.latitude != null && p.longitude != null ? (
                        <Text variant="micro" tone="tertiary">
                          {p.latitude.toFixed(4)}, {p.longitude.toFixed(4)}
                        </Text>
                      ) : null}
                    </View>
                  </Card>
                ))
              )}

              {result.sources.length > 0 ? (
                <Card padded>
                  <Text variant="micro" tone="secondary" uppercase weight="bold">
                    Grounded on
                  </Text>
                  <View style={{ marginTop: 8, gap: 6 }}>
                    {result.sources.slice(0, 8).map((s, i) => (
                      <View key={`${s.title}-${i}`} style={styles.sourceRow}>
                        <Ionicons
                          name="link"
                          size={12}
                          color={t.colors.textTertiary}
                        />
                        <Text
                          variant="caption"
                          tone="secondary"
                          numberOfLines={1}
                          style={{ flex: 1 }}
                        >
                          {s.title}
                        </Text>
                      </View>
                    ))}
                  </View>
                </Card>
              ) : null}
            </View>
          ) : null}

          {debugPayload ? (
            <Card padded>
              <Pressable
                onPress={() => setShowDebug((v) => !v)}
                style={({ pressed }) => [pressed && { opacity: 0.6 }]}
              >
                <View style={styles.debugHeader}>
                  <Text variant="title3" weight="bold" tight>
                    Debug
                  </Text>
                  <Ionicons
                    name={showDebug ? 'chevron-down' : 'chevron-forward'}
                    size={18}
                    color={t.colors.textSecondary}
                  />
                </View>
              </Pressable>
              {showDebug ? (
                <View
                  style={[
                    styles.debugBox,
                    {
                      backgroundColor: t.colors.fill1,
                      borderRadius: t.radii.sm,
                    },
                  ]}
                >
                  <RNText
                    style={[styles.debugText, { color: t.colors.textPrimary }]}
                    selectable
                  >
                    {JSON.stringify(debugPayload, null, 2)}
                  </RNText>
                </View>
              ) : null}
            </Card>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scrollContent: { gap: 16 },
  input: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
  },
  coordRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 12,
  },
  coordInput: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    marginTop: 4,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
  },
  locButtons: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 10,
  },
  resultHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  placeTop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  ratingPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 999,
  },
  metaRow: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 8,
  },
  sourceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  debugHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  debugBox: {
    padding: 10,
    marginTop: 10,
  },
  debugText: {
    fontSize: 11,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
    lineHeight: 14,
  },
});
