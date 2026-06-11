import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { useDayStore } from '@/store/useDayStore';
import {
  useHomeStore,
  selectAnchors,
  effectiveCoords,
} from '@/store/useHomeStore';
import { Card } from './Card';
import { Chip } from './Chip';
import { Text } from './Text';

interface ResolveOptions {
  location?: string;
  /**
   * Coordinates of the picked place, when the user resolves via the
   * place-search list. Lets the store record real lat/lng so we can
   * compute travel times between plans without re-geocoding.
   */
  locationCoords?: { latitude: number; longitude: number };
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
      detail?: string;
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
  // We block auto-search while the compose pass is in flight — it
  // will resolve the plan with its picked venue and we don't want a
  // race where this card flashes "Searching nearby…" before then.
  // If compose decides to skip this plan (no candidates, etc.) it
  // flips to false and the effect below fires as a fallback.
  const isComposing = useDayStore((s) => s.isComposing);
  const updatePlanLocation = useDayStore((s) => s.updatePlanLocation);
  // Home + work anchors: surfaced so the "Where?" chip row knows
  // which buttons to offer and what labels to set.
  const anchors = useHomeStore(selectAnchors);

  const needsClarification = plan.status === 'needs_clarification';

  // A scheduled plan that has no resolvable location is a "ghost" —
  // the user can't see travel rows around it and the day's geometry
  // breaks. We surface a small chip row to let them fix it in one
  // tap. Note: not shown for needs_clarification plans, which already
  // have the standard clarification block doing this job.
  const hasResolvableLocation = !!effectiveCoords(plan, anchors);
  const showWhereChips =
    plan.status === 'scheduled' && !hasResolvableLocation;

  // Coerce a label into the anchor's coords. We DON'T duplicate the
  // anchor's lat/lng into the plan when the label and anchor match —
  // effectiveCoords already does that resolution at render time, so
  // we only need to set `location`. This keeps the plan small and
  // future-proof: if the user later moves their home, every plan
  // that was set to "Home" automatically follows.
  const setLocationFromAnchor = (which: 'home' | 'work') => {
    const pin = which === 'home' ? anchors.home : anchors.work;
    if (!pin) return;
    Haptics.selectionAsync().catch(() => undefined);
    updatePlanLocation(plan.id, pin.label);
  };

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

  // The user-driven "back / cancel" affordances reset the step *and* give a
  // tap tick; the bare `resetStep` is reused internally (e.g. after picking a
  // place) where a second haptic would double up, so it stays silent.
  const goBack = () => {
    Haptics.selectionAsync().catch(() => undefined);
    resetStep();
  };

  // Tracks whether we've already kicked off an automatic place search
  // for this plan instance. Without this, every re-render would re-fire
  // the request — and stepping back to 'chips' (via picking a place
  // then changing your mind) would loop.
  const autoSearchedRef = useRef<string | null>(null);

  const runPlaceSearch = useCallback(async () => {
    // Build the queries array used by the multi-query fan-out:
    //   1. Prefer the LLM-rewritten `placeSearchQueries[]` — these
    //      are 3-5 variants the model generated specifically to
    //      hedge Google's inconsistent type tagging.
    //   2. Fall back to the deprecated single `placeSearchQuery`
    //      (older persisted plans before multi-query).
    //   3. Final fallback: the plan title / raw text. Useful for
    //      the local-heuristics path which doesn't run the LLM.
    const queries =
      plan.placeSearchQueries && plan.placeSearchQueries.length > 0
        ? plan.placeSearchQueries
        : plan.placeSearchQuery
        ? [plan.placeSearchQuery]
        : [plan.title || plan.rawText];
    // `intent` gives the GPT re-ranker context about what the user is
    // actually trying to do (e.g. "leg day"), separate from the
    // sanitized search terms ("gym fitness").
    const intent = plan.title || plan.rawText;
    // For display in the loading/results UI we surface the user's
    // original intent rather than one of the sanitized search terms —
    // "Searching nearby for leg day…" reads better than
    // "Searching nearby for gym fitness…".
    setStep({ kind: 'loading_places', query: intent });
    const result = await findPlaces(queries, intent);
    if (result.places.length > 0) {
      setStep({ kind: 'places', query: intent, places: result.places });
    } else {
      setStep({
        kind: 'no_places',
        reason: result.reason ?? 'error',
        detail: result.detail,
      });
    }
  }, [
    plan.placeSearchQueries,
    plan.placeSearchQuery,
    plan.title,
    plan.rawText,
  ]);

  // Auto-trigger place search for venue-required plans (dinner out,
  // gym, haircut, etc.). Conditions:
  //   - plan has placeSearchQueries from the LLM
  //   - plan doesn't already have a specific location
  //   - plan still needs clarification (status hasn't been resolved)
  //   - we're at the initial chips step (haven't navigated yet)
  //   - we haven't already auto-searched this plan instance
  //
  // This skips the "Find one nearby" tap — the user sees place results
  // immediately instead of a chip they have to engage with first.
  useEffect(() => {
    if (autoSearchedRef.current === plan.id) return;
    if (step.kind !== 'chips') return;
    if (plan.location) return;
    if (plan.status !== 'needs_clarification') return;
    if (!plan.placeSearchQueries || plan.placeSearchQueries.length === 0) return;
    // Let the store-level compose pass try first — it has access to
    // all plans' candidates simultaneously and can optimize the chain.
    // Only fall back to a per-card search if compose finished without
    // resolving this plan (e.g. no candidates, or compose-day not
    // deployed).
    if (isComposing) return;
    autoSearchedRef.current = plan.id;
    void runPlaceSearch();
  }, [
    plan.id,
    plan.location,
    plan.status,
    plan.placeSearchQueries,
    step.kind,
    runPlaceSearch,
    isComposing,
  ]);

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
      await runPlaceSearch();
      return;
    }
    onResolveClarification?.(plan.id, chip);
  };

  const pickPlace = (place: NearbyPlace) => {
    Haptics.selectionAsync().catch(() => undefined);
    resetStep();
    // Two paths depending on plan status:
    //   - needs_clarification: go through resolveClarification — it
    //     also clears the question/suggestions and records the
    //     answer, then reschedules. This is the original picker path.
    //   - scheduled: the user is just *relabelling* an already-
    //     scheduled plan via the "Where?" chips. A full reschedule
    //     would burn ~3s of LLM latency for a single location swap.
    //     updatePlanLocation is in-place and instant.
    const coords = { latitude: place.latitude, longitude: place.longitude };
    if (plan.status === 'scheduled') {
      updatePlanLocation(plan.id, place.name, coords);
    } else {
      onResolveClarification?.(plan.id, place.name, {
        location: place.name,
        locationCoords: coords,
      });
    }
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
    Haptics.selectionAsync().catch(() => undefined);
    const hh = step.date.getHours().toString().padStart(2, '0');
    const mm = step.date.getMinutes().toString().padStart(2, '0');
    const hhmm = `${hh}:${mm}`;
    resetStep();
    onResolveClarification?.(plan.id, hhmm, { startTime: hhmm });
  };

  return (
    <Card padded style={styles.card}>
      <Pressable
        onPress={() => {
          Haptics.selectionAsync().catch(() => undefined);
          setExpanded((v) => !v);
        }}
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
            {plan.composeReasoning ? (
              <Text
                variant="caption"
                tone="accent"
                numberOfLines={2}
                style={styles.composeReasoning}
              >
                {plan.composeReasoning}
              </Text>
            ) : null}
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
                onPress={() => {
                  Haptics.selectionAsync().catch(() => undefined);
                  onRemove(plan.id);
                }}
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

      {showWhereChips ? (
        <View style={styles.whereRow}>
          <Text variant="caption" tone="secondary" weight="semibold">
            Where?
          </Text>
          <View style={styles.whereChips}>
            {anchors.home ? (
              <Chip
                label={anchors.home.label || 'Home'}
                icon="home-outline"
                onPress={() => setLocationFromAnchor('home')}
              />
            ) : null}
            {anchors.work ? (
              <Chip
                label={anchors.work.label || 'Office'}
                icon="briefcase-outline"
                onPress={() => setLocationFromAnchor('work')}
              />
            ) : null}
            <Chip
              label="Find nearby"
              icon="search-outline"
              onPress={() => {
                Haptics.selectionAsync().catch(() => undefined);
                void runPlaceSearch();
              }}
            />
          </View>
        </View>
      ) : null}

      {showWhereChips && step.kind === 'loading_places' ? (
        <View style={styles.loadingRow}>
          <ActivityIndicator color={t.colors.accentText} />
          <Text variant="bodySm" tone="accent">
            Searching nearby for "{step.query}"…
          </Text>
        </View>
      ) : null}

      {showWhereChips && step.kind === 'places' ? (
        <View style={{ gap: 8 }}>
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
                {place.address ? (
                  <Text variant="caption" tone="secondary" numberOfLines={1}>
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
          <Pressable hitSlop={6} onPress={goBack}>
            <Text variant="caption" tone="accent" weight="semibold">
              ← Back
            </Text>
          </Pressable>
        </View>
      ) : null}

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
                onPress={() => {
                  Haptics.selectionAsync().catch(() => undefined);
                  onResolveClarification?.(plan.id, 'Not specified');
                }}
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
                    {place.reasoning ? (
                      <Text
                        variant="caption"
                        tone="accent"
                        numberOfLines={2}
                        style={styles.placeReasoning}
                      >
                        {place.reasoning}
                      </Text>
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
              <Pressable hitSlop={6} onPress={goBack}>
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
              {step.detail ? (
                <View
                  style={[
                    styles.errorDetail,
                    { backgroundColor: t.colors.surface1 },
                  ]}
                >
                  <Text
                    variant="caption"
                    tone="secondary"
                    selectable
                    style={styles.errorDetailText}
                  >
                    {step.detail}
                  </Text>
                </View>
              ) : null}
              <Pressable hitSlop={6} onPress={goBack}>
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
                  <Chip label="Cancel" onPress={goBack} />
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
  placeReasoning: {
    fontStyle: 'italic',
    lineHeight: 16,
  },
  composeReasoning: {
    fontStyle: 'italic',
    lineHeight: 16,
    marginTop: 2,
  },
  whereRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
  },
  whereChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    flex: 1,
  },
  placeDistance: {
    fontVariant: ['tabular-nums'],
  },
  errorDetail: {
    padding: 8,
    borderRadius: 8,
  },
  errorDetailText: {
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
