import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Platform,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import DateTimePicker, {
  type DateTimePickerEvent,
} from '@react-native-community/datetimepicker';
import * as Haptics from 'expo-haptics';
import { Plan } from '@/types/plan';
import { useTheme } from '@/theme/useTheme';
import { formatDuration, formatTime } from '@/utils/time';
import {
  findPlaces,
  formatDistance,
  isPlaceLookupSuggestion,
  type NearbyPlace,
} from '@/lib/places';
import { Card } from './Card';
import { Chip } from './Chip';
import { Text } from './Text';

interface ResolveOptions {
  location?: string;
  startTime?: string;
}

interface Props {
  plan: Plan;
  onResolveClarification?: (
    planId: string,
    answer: string,
    opts?: ResolveOptions,
  ) => void;
  onRemove?: (planId: string) => void;
}

type Step =
  | { kind: 'chips' }
  | { kind: 'loading_places'; query: string }
  | { kind: 'places'; query: string; places: NearbyPlace[] }
  | {
      kind: 'no_places';
      reason: 'no_supabase' | 'no_location' | 'no_results' | 'error';
    }
  | { kind: 'time_picker'; date: Date };

const TIME_PICKER_CHIPS = [/^pick a time$/i, /set the time/i];

function isTimePickerChip(chip: string): boolean {
  return TIME_PICKER_CHIPS.some((r) => r.test(chip.trim()));
}

function noPlacesMessage(
  reason: 'no_supabase' | 'no_location' | 'no_results' | 'error',
): string {
  switch (reason) {
    case 'no_location':
      return 'Location permission denied. Enable it in Settings to find places nearby.';
    case 'no_results':
      return "Couldn't find anything within 2.5 km. Try a manual answer instead.";
    case 'no_supabase':
      return 'AI server is not configured, so real places are unavailable.';
    default:
      return 'Place lookup failed. Try again or pick a manual answer.';
  }
}

/**
 * Pick a deterministic accent color per plan, so the colored left-bar
 * doesn't flicker between renders but each plan still feels distinct.
 */
function hashIndexed<T>(key: string, arr: readonly T[]): T {
  let h = 0;
  for (let i = 0; i < key.length; i++) {
    h = (h * 31 + key.charCodeAt(i)) | 0;
  }
  return arr[Math.abs(h) % arr.length];
}

export function PlanCard({ plan, onResolveClarification, onRemove }: Props) {
  const t = useTheme();
  const [expanded, setExpanded] = useState(false);
  const [step, setStep] = useState<Step>({ kind: 'chips' });

  const needsClarification = plan.status === 'needs_clarification';

  const highlight = useMemo(() => {
    const palette = [
      t.colors.highlightBlue,
      t.colors.highlightPurple,
      t.colors.highlightYellow,
      t.colors.highlightRed,
      t.colors.success,
    ] as const;
    return hashIndexed(plan.id, palette);
  }, [plan.id, t.colors]);

  const resetStep = () => setStep({ kind: 'chips' });

  const handleChip = async (chip: string) => {
    Haptics.selectionAsync().catch(() => undefined);
    if (isTimePickerChip(chip)) {
      const seed = new Date();
      const [h, m] = (plan.startTime ?? '09:00').split(':').map(Number);
      if (Number.isFinite(h)) seed.setHours(h);
      if (Number.isFinite(m)) seed.setMinutes(m);
      seed.setSeconds(0);
      setStep({ kind: 'time_picker', date: seed });
      return;
    }
    if (isPlaceLookupSuggestion(chip)) {
      const query = plan.title || plan.rawText;
      setStep({ kind: 'loading_places', query });
      const result = await findPlaces(query);
      if (result.places.length > 0) {
        setStep({ kind: 'places', query, places: result.places });
      } else {
        setStep({ kind: 'no_places', reason: result.reason ?? 'error' });
      }
      return;
    }
    onResolveClarification?.(plan.id, chip);
  };

  const pickPlace = (place: NearbyPlace) => {
    resetStep();
    onResolveClarification?.(plan.id, place.name, { location: place.name });
  };

  const onTimeChange = (event: DateTimePickerEvent, date?: Date) => {
    if (Platform.OS === 'android') {
      resetStep();
      if (event.type !== 'set' || !date) return;
    }
    if (!date) return;
    const hh = date.getHours().toString().padStart(2, '0');
    const mm = date.getMinutes().toString().padStart(2, '0');
    const hhmm = `${hh}:${mm}`;
    if (Platform.OS === 'ios') {
      setStep({ kind: 'time_picker', date });
      return;
    }
    onResolveClarification?.(plan.id, hhmm, { startTime: hhmm });
  };

  const confirmTime = () => {
    if (step.kind !== 'time_picker') return;
    const hh = step.date.getHours().toString().padStart(2, '0');
    const mm = step.date.getMinutes().toString().padStart(2, '0');
    const hhmm = `${hh}:${mm}`;
    resetStep();
    onResolveClarification?.(plan.id, hhmm, { startTime: hhmm });
  };

  return (
    <Card padded style={styles.card}>
      <Pressable
        onPress={() => setExpanded((v) => !v)}
        hitSlop={2}
        style={({ pressed }) => [pressed && { opacity: 0.85 }]}
      >
        <View style={styles.headerRow}>
          <View
            style={[styles.bar, { backgroundColor: highlight }]}
            accessibilityElementsHidden
          />
          <View style={styles.headerCenter}>
            <Text variant="body" weight="semibold" numberOfLines={2}>
              {plan.title || plan.rawText}
            </Text>
            <View style={styles.metaRow}>
              <Text variant="caption" tone="secondary">
                {formatDuration(plan.durationMinutes)}
              </Text>
              {plan.location ? (
                <>
                  <Text variant="caption" tone="tertiary">·</Text>
                  <Text variant="caption" tone="secondary" numberOfLines={1}>
                    {plan.location}
                  </Text>
                </>
              ) : null}
              {plan.subtasks.length > 0 ? (
                <>
                  <Text variant="caption" tone="tertiary">·</Text>
                  <Text variant="caption" tone="secondary">
                    {plan.subtasks.length} step
                    {plan.subtasks.length === 1 ? '' : 's'}
                  </Text>
                </>
              ) : null}
            </View>
          </View>
          <View style={styles.headerRight}>
            {plan.startTime ? (
              <Text variant="caption" weight="semibold" tone="secondary">
                {formatTime(plan.startTime)}
              </Text>
            ) : null}
            {onRemove ? (
              <Pressable
                hitSlop={10}
                onPress={() => onRemove(plan.id)}
                accessibilityLabel="Remove plan"
                style={({ pressed }) => [
                  styles.removeBtn,
                  { backgroundColor: t.colors.fill1 },
                  pressed && { opacity: 0.6 },
                ]}
              >
                <Ionicons
                  name="close"
                  size={14}
                  color={t.colors.textSecondary}
                />
              </Pressable>
            ) : null}
          </View>
        </View>
      </Pressable>

      {needsClarification && plan.clarificationQuestion ? (
        <View
          style={[
            styles.clarification,
            { backgroundColor: t.colors.accentSoft },
          ]}
        >
          <View style={styles.clarificationHeader}>
            <Ionicons name="help-circle" size={16} color={t.colors.accentText} />
            <Text variant="bodySm" tone="accent" weight="semibold" style={{ flex: 1 }}>
              {plan.clarificationQuestion}
            </Text>
          </View>

          {step.kind === 'chips' ? (
            <View style={styles.suggestionsRow}>
              {(plan.clarificationSuggestions ?? []).map((s) => (
                <Chip key={s} label={s} onPress={() => handleChip(s)} />
              ))}
              <Chip
                label="Skip"
                onPress={() =>
                  onResolveClarification?.(plan.id, 'Not specified')
                }
              />
            </View>
          ) : null}

          {step.kind === 'loading_places' ? (
            <View style={styles.loadingRow}>
              <ActivityIndicator color={t.colors.accentText} />
              <Text variant="bodySm" tone="accent">
                Searching nearby for "{step.query}"…
              </Text>
            </View>
          ) : null}

          {step.kind === 'places' ? (
            <View style={{ gap: 8 }}>
              <Text variant="caption" tone="accent" weight="semibold">
                Tap a place to pick it:
              </Text>
              {step.places.map((place) => (
                <Pressable
                  key={place.id}
                  onPress={() => pickPlace(place)}
                  style={({ pressed }) => [
                    styles.placeRow,
                    { backgroundColor: t.colors.surface1 },
                    pressed && { opacity: 0.7 },
                  ]}
                >
                  <View
                    style={[
                      styles.placeThumb,
                      { backgroundColor: t.colors.fill1 },
                    ]}
                  >
                    {place.photoUrl ? (
                      <Image
                        source={{ uri: place.photoUrl }}
                        style={styles.placeThumbImg}
                      />
                    ) : (
                      <Ionicons
                        name="location"
                        size={20}
                        color={t.colors.textTertiary}
                      />
                    )}
                  </View>
                  <View style={styles.placeBody}>
                    <Text variant="bodySm" weight="semibold" numberOfLines={1}>
                      {place.name}
                    </Text>
                    {place.rating !== null || place.openNow !== null ? (
                      <View style={styles.placeMetaRow}>
                        {place.rating !== null ? (
                          <Text variant="caption" weight="semibold">
                            ★ {place.rating.toFixed(1)}
                            {place.ratingCount
                              ? ` (${place.ratingCount})`
                              : ''}
                          </Text>
                        ) : null}
                        {place.openNow === true ? (
                          <Text
                            variant="caption"
                            weight="semibold"
                            style={{ color: t.colors.success }}
                          >
                            Open
                          </Text>
                        ) : place.openNow === false ? (
                          <Text variant="caption" weight="semibold" tone="danger">
                            Closed
                          </Text>
                        ) : null}
                      </View>
                    ) : null}
                    {place.address ? (
                      <Text
                        variant="caption"
                        tone="secondary"
                        numberOfLines={1}
                      >
                        {place.address}
                      </Text>
                    ) : null}
                  </View>
                  <Text
                    variant="caption"
                    tone="secondary"
                    weight="semibold"
                    style={styles.placeDistance}
                  >
                    {formatDistance(place.distanceM)}
                  </Text>
                </Pressable>
              ))}
              <Pressable hitSlop={6} onPress={resetStep}>
                <Text variant="caption" tone="accent" weight="semibold">
                  ← Back to suggestions
                </Text>
              </Pressable>
            </View>
          ) : null}

          {step.kind === 'no_places' ? (
            <View style={{ gap: 8 }}>
              <Text variant="caption" tone="accent">
                {noPlacesMessage(step.reason)}
              </Text>
              <Pressable hitSlop={6} onPress={resetStep}>
                <Text variant="caption" tone="accent" weight="semibold">
                  ← Back to suggestions
                </Text>
              </Pressable>
            </View>
          ) : null}

          {step.kind === 'time_picker' ? (
            <View style={{ gap: 8 }}>
              <Text variant="caption" tone="accent" weight="semibold">
                Pick a start time:
              </Text>
              <View style={styles.pickerWrap}>
                <DateTimePicker
                  value={step.date}
                  mode="time"
                  is24Hour
                  display={Platform.OS === 'ios' ? 'spinner' : 'default'}
                  onChange={onTimeChange}
                />
              </View>
              {Platform.OS === 'ios' ? (
                <View style={styles.suggestionsRow}>
                  <Chip label="Use this time" onPress={confirmTime} />
                  <Chip label="Cancel" onPress={resetStep} />
                </View>
              ) : null}
            </View>
          ) : null}
        </View>
      ) : null}

      {expanded && plan.subtasks.length > 0 ? (
        <View
          style={[
            styles.subtasks,
            { backgroundColor: t.colors.fill1, borderRadius: t.radii.md },
          ]}
        >
          {plan.subtasks.map((s, idx) => (
            <View
              key={s.id}
              style={[
                styles.subtaskRow,
                idx > 0 && {
                  borderTopWidth: StyleSheet.hairlineWidth,
                  borderTopColor: t.colors.separator,
                },
              ]}
            >
              <View style={styles.subtaskBullet}>
                <View
                  style={[
                    styles.subtaskDot,
                    { backgroundColor: t.colors.textTertiary },
                  ]}
                />
              </View>
              <Text variant="bodySm" style={{ flex: 1 }}>
                {s.title}
              </Text>
              <Text variant="caption" tone="secondary">
                {formatDuration(s.durationMinutes)}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: 12,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: 10,
  },
  bar: {
    width: 3,
    borderRadius: 2,
    alignSelf: 'stretch',
  },
  headerCenter: {
    flex: 1,
    gap: 4,
    paddingRight: 8,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap',
  },
  headerRight: {
    alignItems: 'flex-end',
    gap: 8,
  },
  removeBtn: {
    width: 24,
    height: 24,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  clarification: {
    padding: 12,
    borderRadius: 12,
    gap: 10,
  },
  clarificationHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
  },
  suggestionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  placeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 8,
    borderRadius: 10,
    gap: 10,
  },
  placeThumb: {
    width: 52,
    height: 52,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  placeThumbImg: {
    width: '100%',
    height: '100%',
  },
  placeBody: {
    flex: 1,
    gap: 2,
  },
  placeMetaRow: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
  },
  placeDistance: {
    fontVariant: ['tabular-nums'],
  },
  pickerWrap: {
    alignItems: 'center',
  },
  subtasks: {
    paddingHorizontal: 12,
  },
  subtaskRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    gap: 10,
  },
  subtaskBullet: {
    width: 12,
    alignItems: 'center',
  },
  subtaskDot: {
    width: 4,
    height: 4,
    borderRadius: 999,
  },
});
