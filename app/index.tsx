import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import * as Haptics from 'expo-haptics';
import { useDayStore } from '@/store/useDayStore';
import {
  useSavedItineraries,
  type SavedItinerary,
} from '@/store/useSavedItineraries';
import { usePlanSetupStore } from '@/store/usePlanSetupStore';
import { useTheme } from '@/theme/useTheme';
import { Text } from '@/components/Text';
import { GlassSurface } from '@/components/Glass';
import { GradientWave } from '@/components/GradientWave';
import { ChatComposerBar } from '@/components/ChatComposerBar';
import { PlanSetupSheet } from '@/components/PlanSetupSheet';
import { formatTime, formatDuration } from '@/utils/time';
import {
  DAYTIME_PALETTES,
  getDayPart,
  getDayPartLabel,
  getGreeting,
} from '@/utils/daytime';

// Text that sits on top of the saturated part of the gradient — kept light in
// both themes since the colour field underneath is vivid regardless of mode.
const ON = '#FFFFFF';
const ON_SOFT = 'rgba(255, 255, 255, 0.82)';
const ON_DIM = 'rgba(255, 255, 255, 0.64)';

function formatLongDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}

function tripSubtitle(trip: SavedItinerary): string {
  const parts: string[] = [];
  if (trip.stopCount > 0) {
    parts.push(`${trip.stopCount} stop${trip.stopCount === 1 ? '' : 's'}`);
  }
  const place = trip.city ?? trip.origin;
  if (place) parts.push(place.split(',')[0]);
  return parts.join(' · ');
}

export default function HomeScreen() {
  const router = useRouter();
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();

  // The part of the day drives the gradient + greeting. Re-evaluate on a slow
  // tick so the colour field flows from, say, sunset into night if the screen
  // is left open across a boundary — but only re-render when it actually moves.
  const [dayPart, setDayPart] = useState(() => getDayPart());
  useEffect(() => {
    const id = setInterval(() => {
      setDayPart((prev) => {
        const next = getDayPart();
        return next === prev ? prev : next;
      });
    }, 60 * 1000);
    return () => clearInterval(id);
  }, []);

  const palette = DAYTIME_PALETTES[dayPart];
  const greeting = getGreeting(dayPart);
  const label = getDayPartLabel(dayPart);

  const date = useDayStore((s) => s.date);
  const plans = useDayStore((s) => s.plans);
  const isScheduling = useDayStore((s) => s.isScheduling);
  const isComposing = useDayStore((s) => s.isComposing);
  const isWorking = isScheduling || isComposing;

  const savedTrips = useSavedItineraries((s) => s.items);
  const latestTrip = useMemo(
    () =>
      savedTrips.length > 0
        ? [...savedTrips].sort((a, b) => b.createdAt - a.createdAt)[0]
        : undefined,
    [savedTrips],
  );

  const [setupOpen, setSetupOpen] = useState(false);
  const setPlanSelection = usePlanSetupStore((s) => s.setSelection);
  const openSetup = () => setSetupOpen(true);
  const onSetupConfirm = (d: string, startTime: string) => {
    setPlanSelection(d, startTime);
    setSetupOpen(false);
    router.push('/itinerary');
  };

  const gradientHeight = Math.round(height * 0.6);

  const next = plans[0];
  const moreCount = Math.max(0, plans.length - 1);

  // Build the single adaptive card: planning → up-next → recent trip → prompt.
  let cardOnPress: (() => void) | undefined;
  let cardA11y: string | undefined;
  let cardBody: React.ReactNode;

  if (isWorking) {
    cardBody = (
      <>
        <ActivityIndicator color={t.colors.accent} />
        <View style={styles.cardText}>
          <Text variant="micro" uppercase weight="bold" tone="secondary">
            Planning
          </Text>
          <Text variant="body" weight="semibold">
            Building your schedule…
          </Text>
        </View>
      </>
    );
  } else if (next) {
    cardOnPress = () => {
      Haptics.selectionAsync().catch(() => undefined);
      router.push('/itinerary');
    };
    cardA11y = "Open today's plan";
    cardBody = (
      <>
        <View style={[styles.dot, { backgroundColor: t.colors.accent }]} />
        <View style={styles.cardText}>
          <Text variant="micro" uppercase weight="bold" tone="accent">
            Up next
          </Text>
          <Text variant="body" weight="semibold" numberOfLines={1}>
            {next.title || next.rawText}
          </Text>
          <Text variant="caption" tone="secondary" numberOfLines={1}>
            {[
              next.startTime ? formatTime(next.startTime) : null,
              formatDuration(next.durationMinutes),
            ]
              .filter(Boolean)
              .join(' · ')}
          </Text>
        </View>
        {moreCount > 0 ? (
          <View style={[styles.morePill, { backgroundColor: t.colors.fill1 }]}>
            <Text variant="caption" weight="semibold" tone="secondary">
              +{moreCount}
            </Text>
          </View>
        ) : null}
        <Ionicons
          name="chevron-forward"
          size={18}
          color={t.colors.textTertiary}
        />
      </>
    );
  } else if (latestTrip) {
    cardOnPress = () => {
      Haptics.selectionAsync().catch(() => undefined);
      router.push({ pathname: '/itinerary', params: { id: latestTrip.id } });
    };
    cardA11y = `Open ${latestTrip.title}`;
    cardBody = (
      <>
        <View style={[styles.thumb, { backgroundColor: t.colors.fill1 }]}>
          {latestTrip.thumbUrl ? (
            <Image source={{ uri: latestTrip.thumbUrl }} style={styles.thumbImg} />
          ) : (
            <Ionicons
              name="map-outline"
              size={20}
              color={t.colors.textSecondary}
            />
          )}
        </View>
        <View style={styles.cardText}>
          <Text variant="micro" uppercase weight="bold" tone="secondary">
            Pick up where you left off
          </Text>
          <Text variant="body" weight="semibold" numberOfLines={1}>
            {latestTrip.title}
          </Text>
          <Text variant="caption" tone="secondary" numberOfLines={1}>
            {tripSubtitle(latestTrip)}
          </Text>
        </View>
        <Ionicons
          name="chevron-forward"
          size={18}
          color={t.colors.textTertiary}
        />
      </>
    );
  } else {
    cardOnPress = () => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(
        () => undefined,
      );
      openSetup();
    };
    cardA11y = 'Plan your day';
    cardBody = (
      <>
        <View style={[styles.iconCircle, { backgroundColor: t.colors.accentSoft }]}>
          <Ionicons name="sparkles" size={20} color={t.colors.accentText} />
        </View>
        <View style={styles.cardText}>
          <Text variant="micro" uppercase weight="bold" tone="accent">
            Start
          </Text>
          <Text variant="body" weight="semibold">
            Plan your day
          </Text>
          <Text variant="caption" tone="secondary" numberOfLines={2}>
            Tell me what&apos;s on and I&apos;ll build your schedule.
          </Text>
        </View>
        <Ionicons name="add" size={20} color={t.colors.textTertiary} />
      </>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: t.colors.background }]}>
      <StatusBar style="light" />
      <GradientWave height={gradientHeight} palette={palette} />

      <SafeAreaView style={styles.safe} edges={['top']}>
        <View style={[styles.header, { paddingHorizontal: t.spacing.lg }]}>
          <Text variant="title3" weight="bold" tight style={{ color: ON }}>
            Your day
          </Text>
          <Pressable
            onPress={() => {
              Haptics.selectionAsync().catch(() => undefined);
              router.push('/settings');
            }}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Settings"
            style={({ pressed }) => [styles.gear, pressed && { opacity: 0.6 }]}
          >
            <Ionicons name="settings-outline" size={19} color={ON} />
          </Pressable>
        </View>

        <View
          style={[
            styles.content,
            {
              paddingHorizontal: t.spacing.lg,
              paddingBottom: insets.bottom + 96,
            },
          ]}
        >
          <View style={styles.hero}>
            <Text
              variant="caption"
              uppercase
              weight="bold"
              style={{ color: ON_DIM, letterSpacing: 1.4 }}
            >
              {label}
            </Text>
            <Text
              variant="title1"
              weight="heavy"
              tight
              style={[styles.greeting, { color: ON }]}
            >
              {greeting}
            </Text>
            <Text variant="body" style={{ color: ON_SOFT }}>
              {formatLongDate(date)}
            </Text>
          </View>

          <Pressable
            disabled={!cardOnPress}
            onPress={cardOnPress}
            accessibilityRole={cardOnPress ? 'button' : undefined}
            accessibilityLabel={cardA11y}
            style={({ pressed }) =>
              pressed && cardOnPress
                ? { opacity: 0.9, transform: [{ scale: 0.99 }] }
                : undefined
            }
          >
            <GlassSurface
              variant="regular"
              radius={t.radii.xl}
              style={[styles.card, { shadowColor: t.colors.shadow }]}
              innerStyle={styles.cardInner}
            >
              {cardBody}
            </GlassSurface>
          </Pressable>
        </View>
      </SafeAreaView>

      <ChatComposerBar onPlus={openSetup} />

      <PlanSetupSheet
        open={setupOpen}
        onClose={() => setSetupOpen(false)}
        onConfirm={onSetupConfirm}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  safe: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 6,
    paddingBottom: 6,
  },
  gear: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.14)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 255, 255, 0.24)',
  },
  content: {
    flex: 1,
    justifyContent: 'space-between',
  },
  hero: {
    marginTop: 28,
    gap: 8,
  },
  greeting: {
    fontSize: 38,
    lineHeight: 44,
  },
  card: {
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.18,
    shadowRadius: 22,
    elevation: 8,
  },
  cardInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    padding: 16,
  },
  cardText: {
    flex: 1,
    gap: 2,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    alignSelf: 'flex-start',
    marginTop: 6,
  },
  morePill: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
  },
  thumb: {
    width: 46,
    height: 46,
    borderRadius: 12,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbImg: {
    width: '100%',
    height: '100%',
  },
  iconCircle: {
    width: 46,
    height: 46,
    borderRadius: 23,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
