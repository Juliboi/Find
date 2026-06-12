import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import Animated from 'react-native-reanimated';
import { useTheme } from '@/theme/useTheme';
import { Sheet } from './Sheet';
import { Text } from './Text';
import { ErrandFormStep } from './ErrandFormStep';
import { ErrandDiscoverStep } from './ErrandDiscoverStep';
import { ENTER, EXIT } from './errandDrawerAnim';
import type { ErrandDraft } from '@/lib/ai/parseErrand';
import type { ErrandInput } from '@/store/useErrandsStore';
import type { Coords, NearbyPlace } from '@/lib/places';

/**
 * Which screen the drawer is showing. `form` is the confirm/edit form;
 * `discover` is the place-suggestion step. Both live in the same sheet so the
 * "find a place → confirm errand" handoff feels like one continuous flow.
 */
export type ErrandStep = 'form' | 'discover';

/** The search shape the home orchestrator extracts for a discovery request. */
export interface DiscoverySeed {
  query: string;
  area?: string | null;
  nearby?: boolean;
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** The current seed values (a basic seed while parsing, full once parsed). */
  draft: ErrandDraft;
  /** The original text the user typed (kept on the saved errand). */
  rawText: string;
  /** True while the AI is still extracting — shows a reading state. */
  parsing: boolean;
  /**
   * Bumped by the parent whenever `draft` should be (re)applied to the form:
   * a fresh parse completing, or a different errand opened for editing.
   */
  seedKey: string;
  mode: 'create' | 'edit';
  /** Which step to open on. Defaults to the confirm form. */
  initialStep?: ErrandStep;
  /** Search shape for the discover step (set when `initialStep` is 'discover'). */
  discovery?: DiscoverySeed | null;
  /** Where to search when a discovery isn't "nearby" and no area resolves. */
  fallbackCenter?: Coords | null;
  onSave: (input: ErrandInput) => void;
  onDelete?: () => void;
}

/**
 * Folds a picked discovery candidate into the parsed base draft. The base
 * carries the orchestrator's plan fields (title like "Coffee with Natalie",
 * date, time, notes); we overlay the chosen venue's location + metadata so the
 * confirm form opens fully prefilled and the place reads as a confirmed pin.
 */
function mergePlaceIntoDraft(base: ErrandDraft, p: NearbyPlace, fallbackTitle: string): ErrandDraft {
  return {
    ...base,
    title: base.title?.trim() ? base.title : fallbackTitle,
    address: p.name,
    latitude: p.latitude,
    longitude: p.longitude,
    placeId: p.id ?? null,
    photoUrl: p.photoUrl ?? null,
    rating: p.rating ?? null,
    ratingCount: p.ratingCount ?? null,
    priceLevel: p.priceLevel ?? null,
    openingHours: p.openingHours ?? null,
    autoPlace: null,
    placeQuery: null,
  };
}

/**
 * Builds the confirm-form seed for "Let Diem find it": keep the parsed plan
 * fields (title, date, time, notes) but pin NO venue — flag it auto-place and
 * carry the search category so the planner can pick the best spot when the
 * errand is folded into a day.
 */
function autoPlaceDraft(base: ErrandDraft, query: string, fallbackTitle: string): ErrandDraft {
  return {
    ...base,
    title: base.title?.trim() ? base.title : fallbackTitle,
    address: null,
    latitude: null,
    longitude: null,
    placeId: null,
    photoUrl: null,
    rating: null,
    ratingCount: null,
    priceLevel: null,
    openingHours: null,
    autoPlace: true,
    placeQuery: query?.trim() ? query.trim() : fallbackTitle,
  };
}

/**
 * The errand drawer shell. Owns the bottom sheet, the shared header, and the
 * reading state, then routes to the active step. Today that's the confirm form
 * ({@link ErrandFormStep}); a place-discovery step joins it in a later phase.
 */
export function ErrandDrawer({
  open,
  onClose,
  draft,
  rawText,
  parsing,
  seedKey,
  mode,
  initialStep = 'form',
  discovery,
  fallbackCenter,
  onSave,
  onDelete,
}: Props) {
  const t = useTheme();
  const [step, setStep] = useState<ErrandStep>(initialStep);
  // When the user picks (or skips) a place in the discover step we flip to the
  // form with a freshly built seed. That seed overrides the parent's `draft`
  // until the drawer is re-opened or re-seeded.
  const [override, setOverride] = useState<{ draft: ErrandDraft; seedKey: string } | null>(null);

  // Land on the intended step (and clear any prior pick) each time the drawer
  // (re)opens or a new request is seeded.
  useEffect(() => {
    if (open) {
      setStep(initialStep);
      setOverride(null);
    }
  }, [open, seedKey, initialStep]);

  const formDraft = override?.draft ?? draft;
  const formSeedKey = override?.seedKey ?? seedKey;
  const discoverQuery = discovery?.query ?? rawText;

  const eyebrow = step === 'discover' ? 'Find a place' : mode === 'edit' ? 'Edit errand' : 'New errand';
  const heading =
    step === 'discover' ? 'Pick a spot' : mode === 'edit' ? 'Update reminder' : 'Confirm reminder';

  return (
    <Sheet
      open={open}
      onClose={onClose}
      heightFraction={0.99}
      enableContentPanningGesture={false}
    >
      <View style={styles.container}>
        <Animated.View entering={ENTER(0)} exiting={EXIT(0)} style={styles.header}>
          <View style={{ flex: 1 }}>
            <Text variant="micro" tone="tertiary" uppercase weight="bold">
              {eyebrow}
            </Text>
            <Text variant="title3" weight="bold" tight>
              {heading}
            </Text>
          </View>
          <Pressable
            onPress={() => {
              Haptics.selectionAsync().catch(() => undefined);
              onClose();
            }}
            hitSlop={10}
            style={[styles.iconBtn, { backgroundColor: t.colors.fill1 }]}
            accessibilityLabel="Close"
          >
            <Ionicons name="close" size={18} color={t.colors.textSecondary} />
          </Pressable>
        </Animated.View>

        {parsing ? (
          <View style={styles.parsing}>
            <ActivityIndicator color={t.colors.accent} />
            <Text variant="body" weight="semibold" tone="secondary">
              Reading your errand…
            </Text>
            {rawText ? (
              <Text variant="caption" tone="tertiary" numberOfLines={2} style={styles.parsingRaw}>
                “{rawText}”
              </Text>
            ) : null}
          </View>
        ) : step === 'discover' ? (
          <ErrandDiscoverStep
            query={discoverQuery}
            area={discovery?.area ?? null}
            nearby={discovery?.nearby ?? false}
            fallbackCenter={fallbackCenter ?? null}
            anchorDate={draft.date ?? null}
            onPick={(place) => {
              setOverride({
                draft: mergePlaceIntoDraft(draft, place, discoverQuery),
                seedKey: `picked-${place.id}-${Date.now()}`,
              });
              setStep('form');
            }}
            onManual={() => {
              setOverride({
                draft: { ...draft, title: draft.title?.trim() ? draft.title : discoverQuery },
                seedKey: `manual-${Date.now()}`,
              });
              setStep('form');
            }}
            onAutoPlan={() => {
              setOverride({
                draft: autoPlaceDraft(draft, discoverQuery, discoverQuery),
                seedKey: `auto-${Date.now()}`,
              });
              setStep('form');
            }}
          />
        ) : (
          <ErrandFormStep
            open={open}
            draft={formDraft}
            rawText={rawText}
            parsing={parsing}
            seedKey={formSeedKey}
            mode={mode}
            onSave={onSave}
            onDelete={onDelete}
          />
        )}
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 8,
  },
  iconBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  parsing: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    paddingHorizontal: 32,
  },
  parsingRaw: {
    textAlign: 'center',
  },
});
