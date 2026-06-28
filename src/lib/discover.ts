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
 *   - otherwise             → the user's current GPS location (fallback to home)
 *
 * Per-candidate distances to the rest of the user's day are computed later,
 * client-side, by the drawer — this module only fetches the candidates.
 */

import {
  curateDiscoveryPlaces,
  findPlaces,
  getCurrentCoords,
  type Coords,
  type DiscoverTip,
  type NearbyPlace,
  type PlacesProvider,
} from '@/lib/places';
import { autocompletePlaces, resolvePlace, reverseGeocodeCity } from '@/lib/geocoding';
import { expandPlaceQuery } from '@/lib/placeQueryExpand';
import type { LlmTokenUsage } from '@/lib/usage';

export type { DiscoverTip } from '@/lib/places';

/**
 * Where the candidate search was centered, and how we got there.
 *   - 'place': anchored on a SPECIFIC named venue/landmark the user gave
 *     ("near Hilton Prague") — searched tightly AROUND that point.
 *   - 'area':  anchored on a broad neighbourhood/district ("in Karlín").
 */
export type DiscoverCenterSource = 'gps' | 'area' | 'place' | 'home' | 'none';

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
  /**
   * An explicit, already-resolved search center — e.g. one of the day's errand
   * locations the user anchored on ("find coffee near the dentist"). When set it
   * short-circuits center resolution: we search tightly around this point and
   * ignore `area` / `nearby`.
   */
  center?: Coords | null;
  /** Human label for an explicit {@link center} ("Dentist"), for the UI + curation. */
  centerLabel?: string | null;
  /** Override the search radius (meters). Defaults depend on the search kind. */
  radiusM?: number;
  /**
   * Force (true) or forbid (false) the curated, knowledge-backed discovery path
   * (the `discover-curate` Gemini+web route). Omitted → auto-detected from the
   * phrasing via {@link isSmartDiscovery}. Lets the parser/sandbox override the
   * heuristic when it knows better.
   */
  smart?: boolean;
  /**
   * The user's ORIGINAL natural-language request ("where can I take a quick
   * cheap government photo near me?"). When present for a curated search it is
   * sent to the concierge verbatim, so qualities like "cheap"/"fast" survive and
   * steer the answer (rather than the stripped-down category). Also used to
   * route question/problem phrasings to the concierge.
   */
  phrase?: string;
  /**
   * Set by the orchestrator (parse-errand) when the line is a question/problem
   * to solve rather than a tidy category — forces the curated concierge path
   * even when no superlative/occasion keyword is present.
   */
  openEnded?: boolean;
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
  /**
   * True when these came from the curated, knowledge-backed path
   * (`discover-curate`: a web-grounded model named the venues) rather than the
   * plain category Text Search. Lets the UI label them as hand-picked.
   */
  curated?: boolean;
  /**
   * Curated path only: the concierge's short, flowing conversational answer
   * (the "here's the best way to get what you need" summary). Rendered above the
   * cards. Absent on the plain category path.
   */
  answer?: string;
  /**
   * Curated path only: non-venue options/tips (a self-service method, a chain/
   * category) to show alongside the cards. See {@link DiscoverTip}.
   */
  suggestions?: DiscoverTip[];
  reason?: 'no_supabase' | 'no_location' | 'no_results' | 'error';
  detail?: string;
  /** Token spend the venue re-rank reported for this call; null when none ran. */
  usage?: LlmTokenUsage | null;
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
  /**
   * True when the line is a question/problem to solve rather than a tidy
   * category ("where can I take a cheap passport photo?"). Routes the search to
   * the web-researched concierge. Set by the orchestrator (parse-errand); the
   * on-device {@link detectDiscovery} also infers it from question phrasing.
   */
  openEnded?: boolean;
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

  // Flag question/problem-solving (and curation) phrasing so the search routes
  // to the web-researched concierge. Tested on the RAW line because the cue
  // ("where can I…", "best") is usually stripped out of the cleaned `query`.
  return { query, area, nearby, openEnded: isSmartDiscovery(raw, area) };
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
 * Geocodes a free-text anchor to a single center. Reuses the location-picker
 * pipeline (Google autocomplete + details, with a Nominatim fallback built into
 * `autocompletePlaces`/`resolvePlace`), biased toward the user when known.
 * Carries the resolved place's `types` so the caller can tell a SPECIFIC
 * venue/landmark ("Hilton Prague") apart from a broad area ("Karlín").
 */
async function geocodeArea(
  area: string,
  bias: Coords | null,
): Promise<{ center: Coords; label: string; types: string[] } | null> {
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
          types: Array.isArray(resolved.types) ? resolved.types : [],
        };
      }
    }
  } catch {
    // fall through — caller treats null as "couldn't geocode the area".
  }
  return null;
}

// Google place types that name a BROAD geographic region rather than a single
// point. An anchor resolving to one of these (and to NO establishment/POI type)
// is a neighbourhood/city we search WIDELY inside; anything else is a specific
// venue/landmark we search TIGHTLY around.
const BROAD_AREA_TYPES = new Set([
  'locality',
  'sublocality',
  'sublocality_level_1',
  'sublocality_level_2',
  'neighborhood',
  'administrative_area_level_1',
  'administrative_area_level_2',
  'administrative_area_level_3',
  'administrative_area_level_4',
  'administrative_area_level_5',
  'postal_code',
  'postal_town',
  'colloquial_area',
  'country',
  'continent',
  'archipelago',
]);

/**
 * True when a resolved anchor is a SPECIFIC point (a hotel, landmark, station,
 * business, …) rather than a broad area. Google tags real venues with
 * `establishment`/`point_of_interest`; cities and districts never carry those.
 * Unknown types (e.g. the Nominatim fallback) are treated as broad so we don't
 * over-tighten a search we're unsure about.
 */
function isPreciseAnchor(types: string[]): boolean {
  if (!types.length) return false;
  if (types.includes('establishment') || types.includes('point_of_interest')) {
    return true;
  }
  return !types.some((t) => BROAD_AREA_TYPES.has(t));
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
  center?: Coords | null;
  centerLabel?: string | null;
}): Promise<ResolvedCenter> {
  const { area, nearby, fallbackCenter, center, centerLabel } = input;

  // An explicit, caller-resolved center (a day errand the user anchored on) wins
  // over everything — it's a deliberate "search around HERE" the user tapped.
  if (center) {
    return { center, label: centerLabel ?? null, source: 'place' };
  }

  if (nearby) {
    const gps = await getCurrentCoords();
    if (gps) return { center: gps, label: 'Current location', source: 'gps' };
    if (fallbackCenter) return { center: fallbackCenter, label: 'Home', source: 'home' };
    return { center: null, label: null, source: 'none' };
  }

  const areaName = area?.trim();
  if (areaName && areaName.length >= 2) {
    const geo = await geocodeArea(areaName, fallbackCenter);
    if (geo) {
      // A specific venue/landmark ("Hilton Prague") becomes a 'place' anchor we
      // search tightly around; a neighbourhood ("Karlín") stays a wide 'area'.
      const source: DiscoverCenterSource = isPreciseAnchor(geo.types) ? 'place' : 'area';
      return { center: geo.center, label: geo.label, source };
    }
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

  // General search ("find a pharmacy", "recommend a restaurant"): default to
  // the user's CURRENT location. People who type a bare "find a …" almost always
  // mean "near me right now", and that naturally covers the at-home case too.
  // Home is the fallback only when GPS is unavailable / permission is denied.
  const gps = await getCurrentCoords();
  if (gps) return { center: gps, label: 'Current location', source: 'gps' };
  if (fallbackCenter) return { center: fallbackCenter, label: 'Home', source: 'home' };
  return { center: null, label: null, source: 'none' };
}

/**
 * Default radius by search kind: tight for "near me", medium around a named
 * neighbourhood, wide for a general city-level search from home. A precise
 * venue/landmark anchor (center source 'place') is handled by the caller with
 * an even tighter radius so "near X" stays genuinely near X.
 */
function defaultRadiusM(params: DiscoverParams): number {
  if (params.nearby) return 2500;
  if (params.area && params.area.trim()) return 4000;
  return 5000;
}

// ----------------------------------------------------------- curated discovery
//
// Some discovery requests can't be answered by a literal Text Search of the
// words — they need WORLD KNOWLEDGE or a curated opinion: superlatives ("best",
// "most popular"), distinctions ("michelin", "rooftop"), subjective qualities
// ("interesting", "romantic"), or an occasion with no category at all ("where to
// take my gf for our anniversary"). For those we route through `discover-curate`
// (a Google Search–grounded model that names the real venues, then grounds each
// into a card). Everyday category lookups ("pharmacy near me", "max fitness near
// Krakov") skip it — they're already well served by the plain path, and curation
// would only add cost and latency.

// Curation cues: superlatives, awards/distinctions, and subjective qualities that
// imply "pick the good ones", not "list the nearest ones".
const CURATION_RE =
  /\b(?:best|top|finest|greatest|nicest|coolest|hottest|trendiest|most\s+\w+|popular|famous|renowned|acclaimed|iconic|legendary|award[\s-]*winning|michelin|fine\s+dining|gourmet|hidden\s+gems?|underrated|must[\s-]*(?:try|visit|see|eat|go)|unique|interesting|special|charming|authentic|romantic|fancy|upscale|high[\s-]*end|luxur(?:y|ious)|scenic|rooftop|with\s+a\s+view|instagram\w*|aesthetic|vibe[sy]?)\b/i;

// Occasion cues: a celebration/intent with no explicit category to search for.
const OCCASION_RE =
  /\b(?:anniversary|date\s*night|first\s+date|propose|proposal|honeymoon|birthday|celebrat(?:e|ion|ing)|special\s+occasion|impress)\b/i;

// Open-intent phrasing: "where to take …", "somewhere romantic", "ideas for …".
const OPEN_INTENT_RE =
  /\b(?:where\s+(?:to|can\s+i|should\s+i)\s+(?:take|go|eat|drink|bring|have)|what\s+to\s+do|things\s+to\s+do|somewhere\s+(?:to|nice|special|romantic|fun|cool)|ideas?\s+for|suggestions?\s+for)\b/i;

// Question / problem-solving phrasing: "where can I…", "how do I…", "I need
// somewhere to…", "is there anywhere…", "can I … here". These are requests
// where the obvious category may NOT be the best answer (a cheap passport
// photo, where to print something, where to charge a car), so they deserve the
// web-researched concierge rather than a literal category search.
const OPEN_ENDED_RE =
  /\b(?:where\s+(?:can|could|do|should)\s+(?:i|we|you)|how\s+(?:can|could|do|should|to)\s+(?:i|we|you)|i\s+need\s+(?:to|a|an|some|somewhere)|need\s+somewhere\s+to|somewhere\s+(?:i\s+can|to\s+\w)|is\s+there\s+(?:a|an|any|anywhere|somewhere)|can\s+i\s+(?:find|get|buy|do|take|grab))\b/i;

/**
 * True when a discovery request reads as knowledge/curation-heavy and should go
 * through the web-grounded `discover-curate` path rather than a plain category
 * search. Tested against the "what" plus any named area so "interesting" in
 * "interesting restaurants" and "anniversary" in a bare occasion line both
 * trigger. Conservative by design: ordinary category lookups never match.
 */
export function isSmartDiscovery(query: string, area?: string | null): boolean {
  const text = `${query ?? ''} ${area ?? ''}`.trim();
  if (text.length < 3) return false;
  return (
    CURATION_RE.test(text) ||
    OCCASION_RE.test(text) ||
    OPEN_INTENT_RE.test(text) ||
    OPEN_ENDED_RE.test(text)
  );
}

/**
 * Builds the natural-language phrase handed to the curation concierge from the
 * split (what / where) shape, so "interesting restaurants" + "Prague" reads as
 * "interesting restaurants in Prague" and the model anchors on the right city.
 */
function curatePhrase(
  query: string,
  area: string | null,
  nearby: boolean,
  nearLabel: string | null,
): string {
  const q = query.trim();
  if (area && area.trim()) return `${q} in ${area.trim()}`;
  if (nearLabel && nearLabel.trim() && !/current location|^home$/i.test(nearLabel.trim())) {
    return `${q} in ${nearLabel.trim()}`;
  }
  if (nearby) return `${q} near me`;
  return q;
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
    center: params.center ?? null,
    centerLabel: params.centerLabel ?? null,
  });

  // Expand the "what" into locale-aware variants so a household/drugstore need
  // ("buy domestos", "drugstore") actually searches *drogerie* (dm / Teta /
  // Rossmann) — Google maps the bare English "drugstore" to medicine pharmacies
  // (lékárna) and misses the drogerie next door. Ordinary queries pass through
  // unchanged. Explicit orchestrator variants are each expanded then merged.
  const baseVariants =
    params.queries && params.queries.length > 0
      ? params.queries.map((q) => q.trim()).filter(Boolean)
      : [baseQuery];
  const variants = dedupe(baseVariants.flatMap((q) => expandPlaceQuery(q)));
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

  // Knowledge/curation-heavy requests go through the web-grounded concierge
  // first. On any miss (not configured, model error, nothing grounded) we fall
  // straight through to the plain category search below — curated discovery is
  // strictly an upgrade, never a dead end.
  // The concierge runs when the orchestrator flagged the line open-ended, when
  // the caller forced it, or when the phrasing itself reads as curation/problem-
  // solving. The decision is tested against the user's ORIGINAL phrase when we
  // have it (so "where can I…" survives the category strip), else the category.
  const decisionText = (params.phrase ?? '').trim() || baseQuery;
  const smart =
    params.smart ??
    (params.openEnded === true || isSmartDiscovery(decisionText, params.area ?? null));
  if (smart) {
    // Anchor on a real city name. A named area already is one; otherwise turn the
    // bare GPS/home center into a locality ("Current location" tells the model
    // nothing) so its picks and grounding land in the right place.
    let nearLabel = resolved.label;
    const hasArea = !!(params.area && params.area.trim());
    if (!hasArea && (resolved.source === 'gps' || resolved.source === 'home')) {
      const city = await reverseGeocodeCity(
        resolved.center.latitude,
        resolved.center.longitude,
      ).catch(() => null);
      if (city) nearLabel = city;
    }
    // For an open-ended/problem request, send the user's ORIGINAL words so the
    // concierge sees "quick, fast, cheap" and can prefer a booth over a studio.
    // For a superlative/occasion request with no raw phrase, build the tidy
    // "<what> in <where>" phrase as before.
    const conciergeQuery =
      (params.phrase ?? '').trim() ||
      curatePhrase(baseQuery, params.area ?? null, !!params.nearby, nearLabel);
    const curated = await curateDiscoveryPlaces({
      query: conciergeQuery,
      area: params.area ?? null,
      nearLabel,
      center: resolved.center,
      radiusM: params.radiusM,
    });
    // Keep the curated result when it has ANY content — grounded cards, a written
    // answer, or tips — so a useful non-business answer is never discarded just
    // because nothing grounded to a Maps pin.
    const hasCuratedContent =
      curated.places.length > 0 ||
      !!curated.answer ||
      (curated.suggestions?.length ?? 0) > 0;
    if (hasCuratedContent) {
      return {
        places: curated.places,
        center: resolved.center,
        centerLabel: resolved.label,
        centerSource: resolved.source,
        query: baseQuery,
        queries,
        provider: curated.provider,
        curated: true,
        answer: curated.answer ?? undefined,
        suggestions: curated.suggestions,
        usage: curated.usage ?? null,
        debug: curated.debug,
      };
    }
  }

  // A specific venue/landmark anchor ("near Hilton Prague") searches TIGHTLY
  // around the resolved point, so "near X" returns places actually near X
  // rather than ranked across the whole city the landmark sits in.
  const radiusM =
    params.radiusM ?? (resolved.source === 'place' ? 2500 : defaultRadiusM(params));
  // Discovery never filters by "open now": the user is choosing a place for a
  // possibly-later time, so closed-right-now venues must still appear (their
  // open/closed status is shown on each card, not used to hide them).
  const res = await findPlaces(queries, baseQuery, resolved.center, undefined, {
    radiusM,
    includeClosed: true,
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
    usage: res.usage ?? null,
    debug: res.debug,
  };
}
