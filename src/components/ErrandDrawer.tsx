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
import { useHomeStore } from '@/store/useHomeStore';
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
  /** True when the line is a question/problem — routes to the web concierge. */
  openEnded?: boolean;
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
  /** The id of the errand being edited, so "at an existing errand" excludes it. */
  currentErrandId?: string | null;
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
  currentErrandId,
  initialStep = 'form',
  discovery,
  fallbackCenter,
  onSave,
  onDelete,
}: Props) {
  const t = useTheme();
  const home = useHomeStore((s) => s.home);
  const [step, setStep] = useState<ErrandStep>(initialStep);
  // When the user picks (or skips) a place in the discover step we flip to the
  // form with a freshly built seed. That seed overrides the parent's `draft`
  // until the drawer is re-opened or re-seeded.
  const [override, setOverride] = useState<{ draft: ErrandDraft; seedKey: string } | null>(null);
  // A discover request raised FROM the form ("Discover" location method): the
  // form's current fields (so edits survive) plus the search shape. Takes
  // precedence over the parent's initial `discovery` while it's set.
  const [formDiscover, setFormDiscover] = useState<
    { base: ErrandDraft; seed: DiscoverySeed } | null
  >(null);

  // Land on the intended step (and clear any prior pick) each time the drawer
  // (re)opens or a new request is seeded.
  useEffect(() => {
    if (open) {
      setStep(initialStep);
      setOverride(null);
      setFormDiscover(null);
    }
  }, [open, seedKey, initialStep]);

  const formDraft = override?.draft ?? draft;
  const formSeedKey = override?.seedKey ?? seedKey;
  // The base the discover step folds a pick into: the in-form snapshot when the
  // user opened discover from the form, else the parent's parsed draft.
  const discoverBase = formDiscover?.base ?? draft;
  const activeDiscovery = formDiscover?.seed ?? discovery ?? null;
  // The search SEED for the discover step. It MUST preserve an empty string: the
  // form's "Discover" button opens with "" so the user writes the search (no
  // auto-search), while the home composer routes here with its parsed phrase.
  // (`|| rawText` here would resurrect the errand title and auto-search it.)
  const discoverSeedQuery = activeDiscovery?.query ?? '';
  // A fallback TITLE only — used when a pick / manual entry carries no written
  // query (e.g. "Enter a place manually" tapped before searching anything).
  const discoverFallbackTitle =
    activeDiscovery?.query || discoverBase.title?.trim() || rawText;
  // Discover searches around the parent's center, falling back to home.
  const discoverCenter: Coords | null =
    fallbackCenter ??
    (home ? { latitude: home.latitude, longitude: home.longitude } : null);

  // The form's "Discover" location method: snapshot its fields and open the
  // place-suggestion step with an EMPTY search. The user writes what to look for
  // themselves ("lunch around Karlín") rather than us reusing the errand title.
  const requestDiscover = (snapshot: ErrandDraft) => {
    setFormDiscover({ base: snapshot, seed: { query: '', area: null, nearby: false } });
    setStep('discover');
  };

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
            query={discoverSeedQuery}
            area={activeDiscovery?.area ?? null}
            nearby={activeDiscovery?.nearby ?? false}
            openEnded={activeDiscovery?.openEnded ?? false}
            phrase={rawText}
            fallbackCenter={discoverCenter}
            anchorDate={discoverBase.date ?? null}
            anchorTime={discoverBase.startTime ?? null}
            onPick={(place, q) => {
              setOverride({
                draft: mergePlaceIntoDraft(discoverBase, place, q || discoverFallbackTitle),
                seedKey: `picked-${place.id}-${Date.now()}`,
              });
              setFormDiscover(null);
              setStep('form');
            }}
            onManual={(q) => {
              setOverride({
                draft: {
                  ...discoverBase,
                  title: discoverBase.title?.trim() ? discoverBase.title : q || discoverFallbackTitle,
                },
                seedKey: `manual-${Date.now()}`,
              });
              setFormDiscover(null);
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
            currentErrandId={currentErrandId}
            onSave={onSave}
            onDelete={onDelete}
            onRequestDiscover={requestDiscover}
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
