/**
 * Place discovery — the data layer behind the errand drawer's "find a place"
 * route. The user types something like "find a pharmacy near Karlín" or "a
 * coworking spot nearby"; we turn that into a ranked list of real venues, each
 * with a one-line "what to expect" blurb, so the user picks the place instead
 * of an opaque proximity ranking deciding for them.
 *
 * This deliberately reuses the existing `find-places` edge function (Google
 * Places Text Search → composite scoring → a gpt-4o-mini pass that writes the
 * per-place blurb). The genuinely new work here is resolving WHERE to search
 * from the phrasing:
 *
 *   - "nearby" / "near me"  → the user's current GPS location
 *   - "near <area>"         → geocode that area to a center
 *   - otherwise             → the user's home (fallback to GPS)
 *
 * Per-candidate distances to the rest of the user's day are computed later,
 * client-side, by the drawer — this module only fetches the candidates.
 */

import {
  findPlaces,
  getCurrentCoords,
  type Coords,
  type NearbyPlace,
  type PlacesProvider,
} from '@/lib/places';
import { autocompletePlaces, resolvePlace } from '@/lib/geocoding';

/** Where the candidate search was centered, and how we got there. */
export type DiscoverCenterSource = 'gps' | 'area' | 'home' | 'none';

export interface DiscoverParams {
  /** What the user is looking for, e.g. "pharmacy", "coworking or cafe". */
  query: string;
  /**
   * Optional explicit query variants. The Phase 4 orchestrator supplies these
   * (it understands the phrasing in one cheap call); callers that don't have
   * variants can omit this and we search the single normalized `query`.
   */
  queries?: string[];
  /** A neighbourhood/area to search around ("Karlín"). Geocoded to a center. */
  area?: string | null;
  /** Search around the user's current GPS location ("nearby" / "near me"). */
  nearby?: boolean;
  /** Center to use when not `nearby` and no `area` — typically the user's home. */
  fallbackCenter?: Coords | null;
  /** Override the search radius (meters). Defaults depend on the search kind. */
  radiusM?: number;
}

export interface DiscoverResult {
  /** Ranked candidates. Each carries `reasoning` — the "what to expect" blurb. */
  places: NearbyPlace[];
  /** The coordinate the search was centered on (null if it couldn't resolve). */
  center: Coords | null;
  /** Human label for the center, e.g. "Karlín" or "Current location". */
  centerLabel: string | null;
  centerSource: DiscoverCenterSource;
  /** The normalized "what" we searched for. */
  query: string;
  /** The actual query variants sent to the provider. */
  queries: string[];
  provider: PlacesProvider;
  reason?: 'no_supabase' | 'no_location' | 'no_results' | 'error';
  detail?: string;
  /** Raw provider payload (provider, server debug, etc.) for the dev sandbox. */
  debug?: unknown;
}

/**
 * Strips conversational lead-ins so "find me a pharmacy" → "pharmacy" before it
 * hits Google Text Search. Conservative: if stripping would leave almost
 * nothing, the original text is kept.
 */
export function normalizeDiscoveryQuery(raw: string): string {
  const trimmed = (raw ?? '').trim();
  let q = trimmed
    // Leading lookup verb: "find", "look for", "search for", "where's", …
    .replace(
      /^(?:please\s+)?(?:can|could)?\s*(?:you\s+)?(?:help\s+me\s+)?(?:find|search(?:\s+for)?|look(?:\s+for)?|locate|get(?:\s+me)?|show\s+me|where(?:'s|\s+is|\s+are|\s+can\s+i\s+(?:find|get))?)\s+/i,
      '',
    )
    // A leading article left behind: "a pharmacy" → "pharmacy".
    .replace(/^(?:me\s+)?(?:a|an|some|the)\s+/i, '');
  q = q.trim();
  return q.length >= 2 ? q : trimmed;
}

// --------------------------------------------------------------- orchestrator
//
// The "field is smart" router. The home composer hands us one line; we decide
// whether it's a *place discovery* ("find a pharmacy near Karlín", "coffee
// nearby") or an ordinary plan/errand ("call mom at 15:00", "padel with maty at
// sport centrum cimice"), and — when it IS discovery — pull the search shape
// (what / where / nearby) straight out of the phrasing so the user never sees an
// "area" field or a "near me" toggle.
//
// This is a fast, free, on-device first pass. It deliberately favours precision:
// only fairly unambiguous discovery phrasings trigger the discovery route, so we
// don't hijack normal errands. A future server-side pass (the `parse-errand`
// model) can supersede it for trickier phrasing.

/** What the orchestrator extracts from a discovery-style line. */
export interface DiscoveryIntent {
  /** The "what", normalized for Text Search: "pharmacy", "coworking or cafe". */
  query: string;
  /** A named neighbourhood/area pulled from "near/around/close to X", else null. */
  area: string | null;
  /** True for "near me" / "nearby" / "closest" — search around live GPS. */
  nearby: boolean;
}

// "near me", "nearby", "closest", … — proximity to the user, not a named area.
const NEARBY_RE =
  /\b(?:near\s*me|near\s*by|nearby|near\s*here|close\s*by|closest|nearest|around\s*here|in\s+the\s+area)\b/i;

// Explicit lookup intent: "find", "look for", "recommend", "where can I get", …
const LOOKUP_VERB_RE =
  /\b(?:find|search(?:\s+for)?|look(?:ing)?(?:\s+for)?|recommend|suggest|locate|need\s+(?:a|an|some|the)|where(?:'s|\s+is|\s+are|\s+can\s+i\s+(?:find|get))?)\b/i;

// A named area, via spatial prepositions only. We intentionally avoid "in"/"at":
// "in" collides with time ("in the morning") and "at" names a specific venue
// ("at sport centrum cimice"), which the normal errand flow already resolves.
const AREA_RE = /\b(?:near|around|close\s+to)\s+(.+)$/i;

/** Drops a trailing time clause so "Karlín at 5pm" / "Karlín tomorrow" → "Karlín". */
function stripTrailingTime(s: string): string {
  return s
    .replace(/\s*\b(?:at|by|around|before|after|from)\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b.*$/i, '')
    .replace(/\s*\b(?:today|tonight|tomorrow|this|next|on)\b.*$/i, '')
    .trim();
}

/**
 * Classifies one composer line. Returns the discovery shape when the text reads
 * like a place search, or `null` to mean "let the normal errand parser handle
 * this". Never throws.
 */
export function detectDiscovery(text: string): DiscoveryIntent | null {
  const raw = (text ?? '').trim();
  if (raw.length < 3) return null;

  const nearby = NEARBY_RE.test(raw);

  // Pull a named area out of "near/around/close to X" (and keep the head of the
  // sentence as the candidate "what").
  let area: string | null = null;
  let head = raw;
  const m = raw.match(AREA_RE);
  if (m && m.index != null) {
    const candidate = stripTrailingTime(m[1]).trim();
    // "near me"/"near here" are proximity, not areas — don't treat them as one.
    if (candidate && !/^(?:me|here|us|you|by)\b/i.test(candidate)) {
      area = candidate.replace(/[\s,.;:]+$/g, '') || null;
    }
    head = raw.slice(0, m.index).trim();
  }

  const isDiscovery =
    nearby || LOOKUP_VERB_RE.test(raw) || /^\s*any\b/i.test(raw) || area != null;
  if (!isDiscovery) return null;

  // Build the "what": strip the lookup verb, proximity words and leading
  // "any"/articles out of the head so Google gets a clean category.
  let query = head
    .replace(LOOKUP_VERB_RE, ' ')
    .replace(NEARBY_RE, ' ')
    .replace(/^\s*any\s+/i, ' ')
    .replace(/\b(?:please|for\s+me)\b/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  query = normalizeDiscoveryQuery(query);
  if (query.length < 2) query = normalizeDiscoveryQuery(raw);
  if (query.length < 2) return null;

  return { query, area, nearby };
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const it of items) {
    const key = it.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

/**
 * Geocodes a free-text area to a single center. Reuses the location-picker
 * pipeline (Google autocomplete + details, with a Nominatim fallback built into
 * `autocompletePlaces`/`resolvePlace`), biased toward the user when known.
 */
async function geocodeArea(
  area: string,
  bias: Coords | null,
): Promise<{ center: Coords; label: string } | null> {
  try {
    const predictions = await autocompletePlaces(area, bias);
    if (predictions.length > 0) {
      const resolved = await resolvePlace(predictions[0].placeId);
      if (
        resolved &&
        Number.isFinite(resolved.latitude) &&
        Number.isFinite(resolved.longitude)
      ) {
        return {
          center: {
            latitude: resolved.latitude,
            longitude: resolved.longitude,
          },
          label: resolved.label,
        };
      }
    }
  } catch {
    // fall through — caller treats null as "couldn't geocode the area".
  }
  return null;
}

interface ResolvedCenter {
  center: Coords | null;
  label: string | null;
  source: DiscoverCenterSource;
  /** Set when an area couldn't be geocoded — keep it in the query text instead. */
  areaInQuery?: string;
}

async function resolveCenter(input: {
  area: string | null;
  nearby: boolean;
  fallbackCenter: Coords | null;
}): Promise<ResolvedCenter> {
  const { area, nearby, fallbackCenter } = input;

  if (nearby) {
    const gps = await getCurrentCoords();
    if (gps) return { center: gps, label: 'Current location', source: 'gps' };
    if (fallbackCenter) return { center: fallbackCenter, label: 'Home', source: 'home' };
    return { center: null, label: null, source: 'none' };
  }

  const areaName = area?.trim();
  if (areaName && areaName.length >= 2) {
    const geo = await geocodeArea(areaName, fallbackCenter);
    if (geo) return { center: geo.center, label: geo.label, source: 'area' };
    // Geocode miss: search around a known center but keep the area name in the
    // query text so Google still returns the right neighbourhood.
    if (fallbackCenter) {
      return { center: fallbackCenter, label: 'Home', source: 'home', areaInQuery: areaName };
    }
    const gps = await getCurrentCoords();
    if (gps) {
      return { center: gps, label: 'Current location', source: 'gps', areaInQuery: areaName };
    }
    return { center: null, label: null, source: 'none', areaInQuery: areaName };
  }

  // General search ("find a pharmacy"): prefer home, fall back to GPS.
  if (fallbackCenter) return { center: fallbackCenter, label: 'Home', source: 'home' };
  const gps = await getCurrentCoords();
  if (gps) return { center: gps, label: 'Current location', source: 'gps' };
  return { center: null, label: null, source: 'none' };
}

/**
 * Default radius by search kind: tight for "near me", medium around a named
 * area, wide for a general city-level search from home.
 */
function defaultRadiusM(params: DiscoverParams): number {
  if (params.nearby) return 2500;
  if (params.area && params.area.trim()) return 4000;
  return 5000;
}

/**
 * Resolves the search center from the phrasing, then fetches ranked candidates
 * (with "what to expect" blurbs) via `find-places`. Never throws — failures
 * come back as an empty `places` list with a `reason`/`detail`.
 */
export async function discoverPlaces(params: DiscoverParams): Promise<DiscoverResult> {
  const baseQuery = normalizeDiscoveryQuery(params.query ?? '');
  const fallbackCenter = params.fallbackCenter ?? null;

  const resolved = await resolveCenter({
    area: params.area ?? null,
    nearby: !!params.nearby,
    fallbackCenter,
  });

  const variants =
    params.queries && params.queries.length > 0
      ? dedupe(params.queries.map((q) => q.trim()).filter(Boolean))
      : [baseQuery];
  // When the area couldn't be pinned to a coordinate, fold its name into each
  // query so the provider still searches the right neighbourhood.
  const queries = resolved.areaInQuery
    ? variants.map((q) => `${q} in ${resolved.areaInQuery}`)
    : variants;

  if (!resolved.center) {
    return {
      places: [],
      center: null,
      centerLabel: null,
      centerSource: 'none',
      query: baseQuery,
      queries,
      provider: 'none',
      reason: 'no_location',
      detail: "Couldn't decide where to search — set a home address or enable location.",
    };
  }

  const radiusM = params.radiusM ?? defaultRadiusM(params);
  const res = await findPlaces(queries, baseQuery, resolved.center, undefined, {
    radiusM,
  });

  return {
    places: res.places,
    center: resolved.center,
    centerLabel: resolved.label,
    centerSource: resolved.source,
    query: baseQuery,
    queries,
    provider: res.provider,
    reason: res.reason,
    detail: res.detail,
    debug: res.debug,
  };
}
