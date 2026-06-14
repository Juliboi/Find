/**
 * Deterministic resolve + assemble for the unified compose brain (v3).
 *
 * The brain ({@link composeItinerary}) returns an ORDERED list of day blocks
 * carrying only a PLACEMENT INTENT — never a final venue. This module turns
 * those intents into a real, renderable {@link Itinerary} with NO further model
 * calls:
 *
 *   - placement "anchor"   → the located user errand's own venue (verbatim).
 *   - placement "colocate" → shares an existing anchor's venue.
 *   - placement "find"     → Google Places (`resolveAutoPlace`), neighbourhood-
 *                            centred, ranked by least detour; best venue chosen,
 *                            the rest kept as swappable alternatives.
 *   - placement "venue"    → the venue the user NAMED, geocoded verbatim.
 *   - placement "home"     → no venue (an at-home / online block).
 *
 * Venue truth therefore stays with Google Places (reliable), and the per-minute
 * clock + travel + gaps are laid down afterward by the routing engine
 * (recompute-itinerary). PINNED user times are re-applied from the source errand
 * so the LLM can never corrupt a hard commitment.
 */
import { Itinerary, ItineraryPlace } from '@/types/itinerary';
import { sanitizeItinerary } from '@/lib/ai/itinerary';
import { resolveAutoPlaceVenues } from '@/lib/resolveAutoPlace';
import { findPlaces, type Coords, type NearbyPlace } from '@/lib/places';
import type { ComposedBlock } from '@/lib/ai/composeItinerary';

/** A located user errand's resolved venue + any pinned time, keyed by errand id. */
export interface AssembleAnchor {
  title: string;
  place: ItineraryPlace;
  startTime?: string;
  endTime?: string;
  durationMin?: number;
}

/** An unplaced errand's pinned time, keyed by errand id (for pin enforcement). */
export interface AssembleTask {
  title: string;
  startTime?: string;
  endTime?: string;
  durationMin?: number;
}

export interface AssembleArgs {
  blocks: ComposedBlock[];
  title: string;
  summary: string;
  city: string;
  date: string;
  /** Located errands by the id the brain referenced (placement anchor/colocate). */
  anchorsById: Map<string, AssembleAnchor>;
  /** Unplaced errands by id, so a block linking one inherits its pinned time. */
  tasksById: Map<string, AssembleTask>;
  /** The day's known points (start, end, home, located errands) for find-centring. */
  dayAnchorCoords: Coords[];
  start: Coords | null;
  end: Coords | null;
}

export interface AssembleResult {
  itinerary: Itinerary | null;
  /** coordKey → ranked alternative venues, attached by the caller after show. */
  altByCoordKey: Map<string, ItineraryPlace[]>;
}

function coordKey(lat: number, lng: number): string {
  return `${lat.toFixed(5)},${lng.toFixed(5)}`;
}

function centroid(points: Coords[]): Coords | null {
  if (points.length === 0) return null;
  const sum = points.reduce(
    (a, p) => ({ latitude: a.latitude + p.latitude, longitude: a.longitude + p.longitude }),
    { latitude: 0, longitude: 0 },
  );
  return { latitude: sum.latitude / points.length, longitude: sum.longitude / points.length };
}

/** NearbyPlace → ItineraryPlace (mirrors itinerary.tsx's nearbyToItineraryPlace). */
function nearbyToPlace(p: NearbyPlace): ItineraryPlace {
  return {
    name: p.name,
    category: p.types?.[0]?.replace(/_/g, ' '),
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
 * Resolve every block's placement to a venue (or none) and assemble the ordered
 * {@link Itinerary}. Best-effort: a `find`/`venue` that resolves to nothing
 * becomes a place-less block (the routing pass still times it) rather than a
 * dropped activity. Returns `itinerary: null` only when there are no blocks.
 */
export async function assembleComposedDay(args: AssembleArgs): Promise<AssembleResult> {
  const altByCoordKey = new Map<string, ItineraryPlace[]>();
  const blocks = args.blocks ?? [];
  if (blocks.length === 0) return { itinerary: null, altByCoordKey };

  // 1) Batch-resolve every "find" block through the area-aware Places search.
  const findItems = blocks
    .map((b, i) => ({ b, key: `cb-${i}` }))
    .filter(({ b }) => b.placement === 'find' && b.findQuery)
    .map(({ b, key }) => ({ id: key, query: b.findQuery as string, area: b.area ?? undefined }));
  const findResults = findItems.length
    ? await resolveAutoPlaceVenues({
        items: findItems,
        anchors: args.dayAnchorCoords,
        start: args.start,
        end: args.end,
      })
    : new Map<string, NearbyPlace[]>();

  // 2) Geocode every "venue" block (a venue the user named verbatim) in parallel.
  const center = centroid(args.dayAnchorCoords) ?? args.start ?? args.end ?? undefined;
  const venueResults = new Map<string, NearbyPlace[]>();
  await Promise.all(
    blocks.map(async (b, i) => {
      if (b.placement !== 'venue' || !b.userQuery) return;
      try {
        const res = await findPlaces(b.userQuery, b.userQuery, center, undefined, { limit: 4 });
        if (res.places.length) venueResults.set(`cb-${i}`, res.places);
      } catch {
        // best-effort — falls back to a place-less block
      }
    }),
  );

  // 3) Build an ordered item per block, attaching the resolved venue + pinned time.
  const referencedAnchors = new Set<string>();
  const referencedTasks = new Set<string>();
  type RawItem = Record<string, unknown> & { __section: string; __period: string | null };
  const rawItems: RawItem[] = [];

  const pushItem = (
    b: Pick<
      ComposedBlock,
      'title' | 'kind' | 'flexibility' | 'section' | 'period' | 'description'
    >,
    opts: {
      startTime?: string | null;
      endTime?: string | null;
      durationMin?: number | null;
      place?: ItineraryPlace;
    },
  ) => {
    rawItems.push({
      title: b.title,
      kind: b.kind,
      flexibility: b.flexibility,
      startTime: opts.startTime ?? undefined,
      endTime: opts.endTime ?? undefined,
      durationMinutes: opts.durationMin ?? undefined,
      place: opts.place,
      description: b.description ?? undefined,
      __section: (b.section || b.period || 'Your day').toString(),
      __period: b.period ?? null,
    });
  };

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const key = `cb-${i}`;

    // Pinned time: a block linked to a source errand inherits THAT errand's hard
    // time (the brain can't corrupt it); otherwise use the brain's own pin.
    const anchorSrc = b.anchorId ? args.anchorsById.get(b.anchorId) : undefined;
    const taskSrc = b.taskId ? args.tasksById.get(b.taskId) : undefined;
    const inherit = b.placement === 'anchor' ? anchorSrc : undefined;
    const pinnedStart = inherit?.startTime ?? taskSrc?.startTime ?? b.startTime ?? null;
    const pinnedEnd = pinnedStart ? inherit?.endTime ?? taskSrc?.endTime ?? b.endTime ?? null : null;
    const duration = inherit?.durationMin ?? taskSrc?.durationMin ?? b.durationMin ?? null;
    if (b.anchorId && anchorSrc) referencedAnchors.add(b.anchorId);
    if (b.taskId && taskSrc) referencedTasks.add(b.taskId);

    let place: ItineraryPlace | undefined;
    if ((b.placement === 'anchor' || b.placement === 'colocate') && anchorSrc) {
      // The located errand's own venue, kept verbatim.
      place = { ...anchorSrc.place, userNamed: true };
    } else if (b.placement === 'find') {
      const list = findResults.get(key) ?? [];
      if (list[0]) {
        place = nearbyToPlace(list[0]);
        const alts = list.slice(1).map(nearbyToPlace);
        if (alts.length && place.coords) {
          altByCoordKey.set(coordKey(place.coords.latitude, place.coords.longitude), alts);
        }
      }
    } else if (b.placement === 'venue') {
      const list = venueResults.get(key) ?? [];
      if (list[0]) place = { ...nearbyToPlace(list[0]), userNamed: true };
    }
    // placement "home" (or anything that resolved to nothing) → no place.

    pushItem(b, { startTime: pinnedStart, endTime: pinnedEnd, durationMin: duration, place });
  }

  // 3b) Safety net — never silently drop a user errand the brain forgot to
  // reference. Append any unreferenced located/unplaced errand at the end so it
  // still lands in the day (the user can reorder it).
  for (const [id, a] of args.anchorsById) {
    if (referencedAnchors.has(id)) continue;
    pushItem(
      { title: a.title, kind: 'other', flexibility: a.startTime ? 'fixed' : 'flexible', section: 'Also today', period: null, description: null },
      { startTime: a.startTime ?? null, endTime: a.endTime ?? null, durationMin: a.durationMin ?? null, place: { ...a.place, userNamed: true } },
    );
  }
  for (const [id, t] of args.tasksById) {
    if (referencedTasks.has(id)) continue;
    pushItem(
      { title: t.title, kind: 'other', flexibility: t.startTime ? 'fixed' : 'flexible', section: 'Also today', period: null, description: null },
      { startTime: t.startTime ?? null, endTime: t.endTime ?? null, durationMin: t.durationMin ?? null },
    );
  }

  // 4) Group consecutive items sharing a section label into sections, then let
  // the shared sanitiser assign ids, validate kinds/flexibility, and index.
  const sections: { title: string; period?: string | null; items: RawItem[] }[] = [];
  for (const it of rawItems) {
    const label = it.__section;
    const last = sections[sections.length - 1];
    if (last && last.title === label) last.items.push(it);
    else sections.push({ title: label, period: it.__period, items: [it] });
  }

  const raw = {
    title: args.title || 'Your day',
    summary: args.summary || undefined,
    date: args.date,
    city: args.city || undefined,
    sections: sections.map((s) => ({
      title: s.title,
      period: s.period ?? undefined,
      items: s.items.map(({ __section, __period, ...rest }) => rest),
    })),
  };

  return { itinerary: sanitizeItinerary(raw), altByCoordKey };
}
