// Supabase Edge Function: plan-itinerary
//
// The "v2" planning architecture. Where `schedule-day` takes a list of
// short activities and orders them, this function takes ONE free-form
// description of a whole day ("I want to go to Olomouc, do 1-2h deep
// work, meet a friend, watch the horse show, then drinks") and returns a
// fully structured, Gemini-style itinerary: an ordered list of rich place
// objects, each tagged with a time-flexibility so the client can re-flow
// the flexible blocks around the fixed commitments later.
//
// Request body:
//   { request: string, date?: "YYYY-MM-DD", context?: Context }
//
// Returns an Itinerary object (see src/types/itinerary.ts) or a 501 when
// OPENAI_API_KEY is unset so the client can fall back to a sample.

// deno-lint-ignore-file no-explicit-any
// @ts-nocheck Deno runtime - types resolved by Supabase tooling at deploy time.

const SYSTEM_PROMPT = `You are DayFlow's itinerary architect. The user
gives you a free-form description of ONE day they want to have — things to
do, people to meet, constraints (a fixed event time, "1-2h of deep work",
an address to start from). You do the CORE STRUCTURE PLANNING: WHAT each
block is and WHERE it should happen (near home, clustered, at home …). You
do NOT pick exact venues — the app resolves the best real venue near the
anchor you choose, and computes all the real travel. Think like a sharp
local who RESPECTS THE USER'S TIME.

# Be strategic about time and distance (THIS IS THE MOST IMPORTANT PART)
A good day minimizes pointless travel and clusters things sensibly. For
EACH block, decide the smartest location rather than scattering the user
across the city:
- If something can be done at home (deep work, reading, a call, a rest)
  and the day already has several trips out, prefer doing it AT HOME. Only
  send the user to a cafe for it when that genuinely fits (they're already
  out near one, or explicitly want a change of scene). Say why in the
  description (e.g. "kept at home to save a round trip before your 18:00").
- Cluster errands and stops that are near each other (groceries on the way
  back, two sights in the same quarter).
- Do NOT send the user across town for an everyday thing (gym, pool,
  supermarket, cafe, pharmacy) when a good option is near home or near
  where they already are. Quality still matters — a clearly better option
  a few minutes or a few stops away is worth it — but fame is NOT worth a
  long detour.
- Adapt to the DAY TYPE: a local work/errands day stays tight around home;
  a day with one far destination (a day trip, a specific event) is built
  around that anchor; a combined day does both, batching the local stuff.

# Locations: describe INTENT, not a specific venue
For every block output these three fields:
- "locationStrategy": one of
    "at_home"     — happens at the user's home. NO venue, NO travel.
    "near_home"   — a venue close to home.
    "near_prev"   — cluster it with the block right before it.
    "near_anchor" — near the day's fixed commitment (the meetup/event).
    "anywhere"    — wherever is most convenient for the day's shape.
- "venueQuery": a short, Google-searchable phrase for the TYPE of place
  ("well-equipped gym", "swimming pool", "supermarket", "specialty coffee
  shop with seating to work", "cosy pub"). NOT a brand — UNLESS the user
  named one. Null ONLY when locationStrategy is "at_home".
- "userSpecified": true ONLY if the user explicitly named THIS exact venue
  (then also put that name in place.name; the app keeps it and won't swap
  it for a "better" one). Otherwise false.
Never invent venue names, ratings, addresses, or coordinates — the app
attaches the real ones.

# Start at home; the app handles ALL travel
- MORNING ROUTINE: when a home/origin is given and the day starts in the
  morning, OPEN with "Wake & get ready" (~30m) then "Breakfast" (~25m),
  both locationStrategy "at_home", place null, venueQuery null. The FIRST
  block's startTime is the wake time and ANCHORS the whole day — pick a
  realistic one that still makes every fixed commitment reachable.
- NEVER output travel/commute items (no "train to X", "walk to station",
  "drive to Y"). The app inserts the real door-to-door journey (walk → bus
  → metro → train) between every stop, including long inter-city trips.

# Durations & clock
- "durationMinutes" = the on-site length of the activity ITSELF (EXCLUDE
  travel; the app measures and inserts travel).
- Set "startTime" ONLY on (1) the very first block (the wake time) and
  (2) any "fixed" commitment at a set hour. Leave startTime/endTime null
  everywhere else; order blocks sensibly and the app cascades real times.

# Time flexibility (REQUIRED on every item)
  - "fixed":    pinned to startTime — a person to meet, an event/show
                start, a booked reservation. The day bends around these.
  - "window":   must fall within [windowStart, windowEnd] but floats.
  - "flexible": free to slide/reorder — deep work, errands, a walk, drinks.
Default to "flexible" unless the user implied a real constraint.

# Concreteness
One activity per item. Don't lump a sightseeing list into one block — emit
ONE item per spot, each with its own venueQuery. Per-item "title" is the
concrete activity ("Deep work session", "Gym session", "Grocery run",
"Holy Trinity Column"); the catchy headline lives on the SECTION.

# Sections (catchy grouping)
Group the day into 4-8 SECTIONS, each with a catchy upbeat "title"
("Rise and Shine!", "Get Fit!", "The Main Event", "Wind Down"), an optional
"period" ("Morning" | "Afternoon" | "Evening"), and "items".

# Output (JSON only) — EXACTLY this shape:
{
  "title": string,                 // e.g. "A productive day in Prague"
  "summary": string,               // 1-2 sentence intro framing the day
  "origin": string | null,         // where the day starts (user's address)
  "city": string | null,           // primary city, e.g. "Prague, Czechia"
  "sections": [
    {
      "title": string,             // catchy section headline
      "period": string | null,     // "Morning" | "Afternoon" | "Evening"
      "items": [
        {
          "title": string,         // concrete per-item activity title
          "kind": "work" | "sightseeing" | "meal" | "event" | "meetup" | "drinks" | "activity" | "break" | "other",
          "flexibility": "fixed" | "window" | "flexible",
          "startTime": string | null,  // "HH:MM" 24h — only first block + fixed items
          "durationMinutes": number,   // REQUIRED — on-site length, EXCLUDING travel
          "windowStart": string | null,
          "windowEnd": string | null,
          "locationStrategy": "at_home" | "near_home" | "near_prev" | "near_anchor" | "anywhere",
          "venueQuery": string | null, // searchable venue TYPE; null iff at_home
          "userSpecified": boolean,    // true only if the user named this exact venue
          "place": {                   // null iff at_home; hints only — the app fills name/coords/rating/photo
            "name": string | null,     // set ONLY when userSpecified
            "category": string | null, // human label, e.g. "Gym", "Coffee shop"
            "emoji": string | null,    // one emoji for the category, e.g. "🏋️", "☕"
            "priceLevel": string | null
          } | null,
          "description": string,       // vivid 1-3 sentence "what / why" (mention the time/distance trade-off when relevant)
          "highlights": string[] | null
        }
      ]
    }
  ]
}
Return JSON only — no prose outside the JSON object.`;

// --- venue resolution (location-biased, quality-vs-proximity) --------------
//
// The AI no longer names venues; it emits a venueQuery (the TYPE of place)
// and a locationStrategy (where it should be: near home, near the previous
// stop, near the fixed anchor, …). We resolve each to a REAL venue by
// biasing a Google Text Search around the right anchor and picking the best
// candidate by the same distance-vs-quality composite that powers
// `find-places` — so "swimming pool" near home becomes a good LOCAL pool,
// not the famous water-park 20 km away, while a clearly better gym a few
// stops out can still win.

interface ResolvedPlace {
  name: string;
  coords: { latitude: number; longitude: number };
  address?: string;
  rating?: number;
  ratingCount?: number;
  priceLevel?: number;
  photoUrl?: string;
}

const LOCATION_STRATEGIES = new Set([
  'at_home',
  'near_home',
  'near_prev',
  'near_anchor',
  'anywhere',
]);

const EVERYDAY_QUERY_RE =
  /\b(restaurant|food|dinner|lunch|brunch|breakfast|cafe|caf\u00e9|coffee|bar|pub|bistro|grocer|groceries|supermarket|market|pharmacy|chemist|bakery|eat|drink|takeout|takeaway|deli)\b/i;

function isEverydayQuery(q: string): boolean {
  return EVERYDAY_QUERY_RE.test(q || '');
}

function priceLevelToNum(v: unknown): number | undefined {
  switch (v) {
    case 'PRICE_LEVEL_INEXPENSIVE':
      return 1;
    case 'PRICE_LEVEL_MODERATE':
      return 2;
    case 'PRICE_LEVEL_EXPENSIVE':
      return 3;
    case 'PRICE_LEVEL_VERY_EXPENSIVE':
      return 4;
    default:
      return undefined;
  }
}

function priceNumToStr(n: number | undefined): string | null {
  if (!n || n < 1) return null;
  return '$'.repeat(Math.min(4, n));
}

/** Resolve a Places photo reference to an auth-free CDN URL (best-effort). */
async function resolvePhotoUrl(
  photoName: string | undefined,
  apiKey: string,
): Promise<string | undefined> {
  if (!photoName) return undefined;
  try {
    const res = await fetch(
      `https://places.googleapis.com/v1/${photoName}/media?key=${apiKey}&maxHeightPx=400&maxWidthPx=400&skipHttpRedirect=true`,
    );
    if (!res.ok) return undefined;
    const json = await res.json();
    return typeof json?.photoUri === 'string' ? json.photoUri : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One location-biased Text Search. `center` biases (does not restrict)
 * the search; pass null to search unbiased (no home known). Returns the
 * raw candidate list with distance-from-center, ready for scoring.
 */
async function searchTextBiased(
  query: string,
  center: Coords | null,
  radiusM: number,
  apiKey: string,
): Promise<any[]> {
  const body: any = {
    textQuery: query,
    maxResultCount: 12,
    rankPreference: 'RELEVANCE',
  };
  if (center) {
    body.locationBias = {
      circle: {
        center: { latitude: center.latitude, longitude: center.longitude },
        radius: Math.min(50000, Math.max(500, radiusM)),
      },
    };
  }
  let data: any;
  try {
    const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask':
          'places.displayName,places.formattedAddress,places.shortFormattedAddress,places.location,places.rating,places.userRatingCount,places.priceLevel,places.photos',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) return [];
    data = await res.json();
  } catch {
    return [];
  }
  const raw: any[] = Array.isArray(data?.places) ? data.places : [];
  const out: any[] = [];
  raw.forEach((p, i) => {
    const lat = p?.location?.latitude;
    const lon = p?.location?.longitude;
    const name = p?.displayName?.text;
    if (typeof lat !== 'number' || typeof lon !== 'number' || !name) return;
    const coords = { latitude: lat, longitude: lon };
    out.push({
      name,
      coords,
      address:
        (typeof p.shortFormattedAddress === 'string' ? p.shortFormattedAddress : null) ??
        (typeof p.formattedAddress === 'string' ? p.formattedAddress : undefined),
      rating: typeof p.rating === 'number' ? p.rating : undefined,
      ratingCount: typeof p.userRatingCount === 'number' ? p.userRatingCount : undefined,
      priceLevel: priceLevelToNum(p.priceLevel),
      photoName: p?.photos?.[0]?.name,
      distanceM: center ? Math.round(haversineMeters(center, coords)) : 0,
      position: i,
    });
  });
  return out;
}

/**
 * Composite score (0..1) blending distance decay, relevance position,
 * rating and review count. Two profiles: EVERYDAY venues weight proximity
 * heavily (you won't cross town for a coffee), DESTINATION venues let a
 * well-validated farther option win (you'll commute for the right gym).
 * Ported from `find-places` `scoreCandidate`.
 */
function scoreVenue(c: any, radiusM: number, everyday: boolean): number {
  const pos = 1 / (1 + (c.position ?? 0));
  const decay = everyday ? Math.max(800, radiusM / 4) : Math.max(1500, radiusM / 2);
  const dist = Math.exp(-((c.distanceM ?? 0) / decay));
  const rating = typeof c.rating === 'number' ? c.rating / 5 : 0;
  const reviewsRaw = c.ratingCount ?? 0;
  const reviews = reviewsRaw > 0 ? Math.min(1, Math.log10(reviewsRaw + 1) / 3) : 0;
  if (everyday) {
    return dist * 0.55 + pos * 0.1 + rating * 0.2 + reviews * 0.1 + 0.05;
  }
  return (
    dist * 0.35 +
    pos * 0.1 +
    rating * 0.3 +
    reviews * 0.15 +
    0.05 +
    (rating >= 0.9 && reviewsRaw >= 200 ? 0.05 : 0)
  );
}

/**
 * Resolve a venueQuery to the single best real venue near `center`.
 * `trustName` (a user-named venue) takes the top relevance match over a
 * wide area instead of re-picking by proximity, so a deliberately-far
 * choice the user named is honoured.
 */
async function pickVenue(
  query: string,
  center: Coords | null,
  apiKey: string,
  opts: { trustName?: boolean } = {},
): Promise<ResolvedPlace | null> {
  const everyday = isEverydayQuery(query);
  const radius = opts.trustName ? 50000 : everyday ? 2500 : 6000;
  let cands = await searchTextBiased(query, center, radius, apiKey);
  if (cands.length === 0 && center) {
    // Widen once before giving up — the right venue may sit just outside.
    cands = await searchTextBiased(query, center, Math.max(radius * 2, 12000), apiKey);
  }
  if (cands.length === 0) return null;

  const best = opts.trustName
    ? cands[0]
    : cands
        .slice()
        .sort((a, b) => scoreVenue(b, radius, everyday) - scoreVenue(a, radius, everyday))[0];
  if (!best) return null;

  return {
    name: best.name,
    coords: best.coords,
    address: best.address,
    rating: best.rating,
    ratingCount: best.ratingCount,
    priceLevel: best.priceLevel,
    photoUrl: await resolvePhotoUrl(best.photoName, apiKey),
  };
}

/** Best searchable phrase for an item: the user's named venue, else the type. */
function venueQueryOf(item: any): string {
  if (item?.userSpecified && typeof item?.place?.name === 'string' && item.place.name.trim()) {
    return item.place.name.trim();
  }
  if (typeof item?.venueQuery === 'string' && item.venueQuery.trim()) {
    return item.venueQuery.trim();
  }
  if (typeof item?.place?.name === 'string' && item.place.name.trim()) {
    return item.place.name.trim();
  }
  return typeof item?.title === 'string' ? item.title : '';
}

/** Validate the model's locationStrategy, inferring a sane default. */
function normalizeStrategy(item: any): string {
  const s = item?.locationStrategy;
  if (typeof s === 'string' && LOCATION_STRATEGIES.has(s)) return s;
  const hasQuery = typeof item?.venueQuery === 'string' && item.venueQuery.trim();
  const hasName = typeof item?.place?.name === 'string' && item.place.name.trim();
  return hasQuery || hasName ? 'near_home' : 'at_home';
}

function centroidOf(coordsList: Coords[]): Coords | null {
  if (coordsList.length === 0) return null;
  let lat = 0;
  let lon = 0;
  for (const c of coordsList) {
    lat += c.latitude;
    lon += c.longitude;
  }
  return { latitude: lat / coordsList.length, longitude: lon / coordsList.length };
}

/**
 * Walks the parsed itinerary and resolves a real venue for every block that
 * needs one, biasing each search to the smartest anchor. Two passes so that
 * cluster-relative blocks (near_prev / near_anchor / anywhere) can lean on
 * coordinates resolved in the first pass. Mutates `parsed` in place.
 */
async function resolveVenues(parsed: any, context: any, apiKey?: string): Promise<void> {
  if (!parsed || !Array.isArray(parsed.sections)) return;
  const home: Coords | null = context?.home
    ? { latitude: context.home.latitude, longitude: context.home.longitude }
    : null;
  const items = flattenItems(parsed);

  const apply = (item: any, r: ResolvedPlace | null) => {
    if (!r) return;
    const hint = item.place && typeof item.place === 'object' ? item.place : {};
    item.place = {
      name: r.name ?? hint.name ?? null,
      category: typeof hint.category === 'string' ? hint.category : null,
      emoji: typeof hint.emoji === 'string' ? hint.emoji : null,
      address: r.address ?? (typeof hint.address === 'string' ? hint.address : null),
      rating: typeof r.rating === 'number' ? r.rating : null,
      ratingCount: typeof r.ratingCount === 'number' ? r.ratingCount : null,
      priceLevel:
        (typeof hint.priceLevel === 'string' ? hint.priceLevel : null) ??
        priceNumToStr(r.priceLevel),
      openStatus: null,
      coords: r.coords,
      photoUrl: r.photoUrl ?? null,
    };
  };

  // Normalize strategy + clear at-home blocks (these have no venue/travel).
  for (const item of items) {
    item.locationStrategy = normalizeStrategy(item);
    if (item.locationStrategy === 'at_home') item.place = null;
  }

  if (!apiKey) return; // no Google key → keep AI hints, no coords (dev/offline)

  const needsVenue = (item: any) =>
    item.locationStrategy !== 'at_home' && !item.place?.coords && !!venueQueryOf(item);

  // Pass A — anchors: user-named venues, fixed commitments, and near_home.
  // All biased to home (a named venue uses a wide radius so a deliberately
  // far pick is still found).
  await Promise.all(
    items
      .filter(
        (it) =>
          needsVenue(it) &&
          (it.userSpecified ||
            it.flexibility === 'fixed' ||
            it.locationStrategy === 'near_home'),
      )
      .map(async (it) => {
        const r = await pickVenue(venueQueryOf(it), home, apiKey, {
          trustName: !!it.userSpecified,
        });
        apply(it, r);
      }),
  );

  // Pass B — cluster-relative: near_prev / near_anchor / anywhere (and any
  // leftover), biased to coordinates resolved in pass A.
  const resolvedCoords = (): Coords[] =>
    items.map((it) => it.place?.coords).filter(Boolean) as Coords[];
  const anchorCoordsNear = (idx: number): Coords | null => {
    // Nearest (by position in the day) fixed/located item's coords.
    for (let d = 1; d < items.length; d++) {
      const before = items[idx - d];
      const after = items[idx + d];
      if (before?.flexibility === 'fixed' && before?.place?.coords) return before.place.coords;
      if (after?.flexibility === 'fixed' && after?.place?.coords) return after.place.coords;
    }
    return null;
  };

  await Promise.all(
    items.map(async (it, idx) => {
      if (!needsVenue(it)) return;
      let center: Coords | null = home;
      if (it.locationStrategy === 'near_prev') {
        for (let j = idx - 1; j >= 0; j--) {
          if (items[j].place?.coords) {
            center = items[j].place.coords;
            break;
          }
        }
      } else if (it.locationStrategy === 'near_anchor') {
        center = anchorCoordsNear(idx) ?? home;
      } else {
        // anywhere → the day's center of mass, else home
        center = centroidOf(resolvedCoords()) ?? home;
      }
      const r = await pickVenue(venueQueryOf(it), center, apiKey, {});
      apply(it, r);
    }),
  );
}

// --- travel routing + scheduling -------------------------------------------
//
// The AI hands us structure + durations; we turn it into a real clock. For
// each consecutive pair of LOCATED stops we ask Google Routes for the true
// door-to-door time (mode-aware), then cascade start/end times from the
// day's anchor, snapping fixed commitments to their hard time. This is what
// makes the plan practical ("leave home at 07:15 to make the 12:00 meetup")
// rather than a string of guessed thresholds.

type TravelMode = 'walk' | 'bike' | 'transit' | 'drive';

interface Coords {
  latitude: number;
  longitude: number;
}

function haversineMeters(a: Coords, b: Coords): number {
  const R = 6371000;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Straight-line under-counts real routing distance; pad before picking mode.
const DETOUR_FACTOR = 1.3;

const SPEED_M_PER_MIN: Record<TravelMode, number> = {
  walk: 80,
  bike: 250,
  transit: 200,
  drive: 400,
};
const MODE_OVERHEAD_MIN: Record<TravelMode, number> = {
  walk: 1,
  bike: 2,
  transit: 4,
  drive: 3,
};
const ROUTES_TRAVEL_MODE: Record<TravelMode, string> = {
  walk: 'WALK',
  bike: 'BICYCLE',
  transit: 'TRANSIT',
  drive: 'DRIVE',
};

function pickMode(distanceM: number): TravelMode {
  if (distanceM <= 1300) return 'walk';
  return 'transit';
}

function estimateMinutes(distanceM: number, mode: TravelMode): number {
  return Math.max(1, Math.round(distanceM / SPEED_M_PER_MIN[mode] + MODE_OVERHEAD_MIN[mode]));
}

type TravelStepMode = 'walk' | 'bus' | 'tram' | 'subway' | 'train' | 'ferry' | 'transit';

interface TravelStep {
  mode: TravelStepMode;
  line?: string;
  from?: string;
  to?: string;
  durationMinutes?: number;
  numStops?: number;
  fromCoords?: Coords;
  toCoords?: Coords;
}

interface RouteResult {
  minutes: number;
  distanceMeters?: number;
  steps?: TravelStep[];
  polyline?: string;
}

/** Google Routes transit vehicle type → our coarse step sub-mode. */
function vehicleToStepMode(type: unknown): TravelStepMode {
  switch (type) {
    case 'BUS':
    case 'INTERCITY_BUS':
    case 'TROLLEYBUS':
    case 'SHARE_TAXI':
      return 'bus';
    case 'SUBWAY':
    case 'METRO_RAIL':
    case 'MONORAIL':
      return 'subway';
    case 'TRAM':
    case 'LIGHT_RAIL':
    case 'CABLE_CAR':
    case 'GONDOLA_LIFT':
    case 'FUNICULAR':
      return 'tram';
    case 'HEAVY_RAIL':
    case 'RAIL':
    case 'COMMUTER_TRAIN':
    case 'HIGH_SPEED_TRAIN':
    case 'LONG_DISTANCE_TRAIN':
      return 'train';
    case 'FERRY':
      return 'ferry';
    default:
      return 'transit';
  }
}

function secsToMin(v: unknown): number | undefined {
  const secs = typeof v === 'string' ? parseInt(v.replace(/s$/, ''), 10) : Number(v);
  return Number.isFinite(secs) ? Math.max(1, Math.round(secs / 60)) : undefined;
}

/** Reads a {latitude, longitude} out of a Routes API latLng, if present. */
function latLngOf(loc: any): Coords | undefined {
  const ll = loc?.latLng ?? loc;
  const lat = Number(ll?.latitude);
  const lng = Number(ll?.longitude);
  return Number.isFinite(lat) && Number.isFinite(lng)
    ? { latitude: lat, longitude: lng }
    : undefined;
}

/** Pulls a readable walk → bus → metro → train breakdown out of a route. */
function parseSteps(route: any): TravelStep[] {
  const legs = Array.isArray(route?.legs) ? route.legs : [];
  const out: TravelStep[] = [];
  for (const leg of legs) {
    const steps = Array.isArray(leg?.steps) ? leg.steps : [];
    for (const st of steps) {
      if (st?.travelMode === 'TRANSIT' && st?.transitDetails) {
        const td = st.transitDetails;
        const line: string | undefined =
          td?.transitLine?.nameShort || td?.transitLine?.name || undefined;
        out.push({
          mode: vehicleToStepMode(td?.transitLine?.vehicle?.type),
          line: typeof line === 'string' ? line : undefined,
          from: typeof td?.stopDetails?.departureStop?.name === 'string'
            ? td.stopDetails.departureStop.name
            : undefined,
          to: typeof td?.stopDetails?.arrivalStop?.name === 'string'
            ? td.stopDetails.arrivalStop.name
            : undefined,
          durationMinutes: secsToMin(st?.staticDuration),
          numStops: typeof td?.stopCount === 'number' ? td.stopCount : undefined,
          fromCoords: latLngOf(td?.stopDetails?.departureStop?.location),
          toCoords: latLngOf(td?.stopDetails?.arrivalStop?.location),
        });
      } else if (st?.travelMode === 'WALK') {
        const dmin = secsToMin(st?.staticDuration);
        // Skip trivial in-station shuffles; keep walks that matter.
        if (dmin && dmin >= 2) out.push({ mode: 'walk', durationMinutes: dmin });
      }
    }
  }
  return out;
}

/**
 * Real door-to-door route via Google Routes (computeRoutes): total minutes
 * plus the transit step breakdown. Returns null on any failure so the
 * caller can fall back to the haversine estimate.
 */
async function computeRoute(
  origin: Coords,
  dest: Coords,
  mode: TravelMode,
  apiKey: string,
): Promise<RouteResult | null> {
  try {
    const res = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask':
          'routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline,routes.legs.steps.travelMode,routes.legs.steps.staticDuration,routes.legs.steps.transitDetails',
      },
      body: JSON.stringify({
        origin: { location: { latLng: { latitude: origin.latitude, longitude: origin.longitude } } },
        destination: { location: { latLng: { latitude: dest.latitude, longitude: dest.longitude } } },
        travelMode: ROUTES_TRAVEL_MODE[mode],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const route = Array.isArray(data?.routes) ? data.routes[0] : null;
    if (!route) return null;
    const secs =
      typeof route.duration === 'string'
        ? parseInt(route.duration.replace(/s$/, ''), 10)
        : Number(route.duration);
    if (!Number.isFinite(secs)) return null;
    const steps = parseSteps(route);
    const polyline =
      typeof route?.polyline?.encodedPolyline === 'string'
        ? route.polyline.encodedPolyline
        : undefined;
    return {
      minutes: Math.max(1, Math.round(secs / 60)),
      distanceMeters: typeof route.distanceMeters === 'number' ? route.distanceMeters : undefined,
      steps: steps.length > 1 ? steps : undefined,
      polyline,
    };
  } catch {
    return null;
  }
}

function parseHHMM(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const m = v.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min)) return null;
  return h * 60 + min;
}

function fmtHHMM(totalMin: number): string {
  const wrapped = ((Math.round(totalMin) % 1440) + 1440) % 1440;
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function itemDuration(item: any): number {
  const d = Number(item?.durationMinutes);
  if (Number.isFinite(d) && d > 0) return Math.round(d);
  const s = parseHHMM(item?.startTime);
  const e = parseHHMM(item?.endTime);
  if (s != null && e != null && e > s) return e - s;
  return 30;
}

function flattenItems(parsed: any): any[] {
  if (!parsed || !Array.isArray(parsed.sections)) return [];
  return parsed.sections.flatMap((s: any) => (s && Array.isArray(s.items) ? s.items : []));
}

/**
 * Safety net: the model is told never to emit "travel" items (the app draws
 * all travel as connectors), but it sometimes still does — a "Train to X"
 * card that breaks the visual continuity. Drop any AI-produced travel items
 * (and now-empty sections) so the journey is rendered as the routed,
 * step-by-step leg between the real places instead.
 */
function stripAiTravelItems(parsed: any): void {
  if (!parsed || !Array.isArray(parsed.sections)) return;
  for (const s of parsed.sections) {
    if (s && Array.isArray(s.items)) {
      s.items = s.items.filter((it: any) => it?.kind !== 'travel');
    }
  }
  parsed.sections = parsed.sections.filter(
    (s: any) => s && Array.isArray(s.items) && s.items.length > 0,
  );
}

/** Routes one hop, attaching the transit step breakdown, with a fallback. */
async function computeLeg(
  origin: Coords,
  dest: Coords,
  apiKey: string,
  fromLabel?: string,
): Promise<any> {
  const straight = haversineMeters(origin, dest);
  const distanceM = Math.round(straight * DETOUR_FACTOR);
  const mode = pickMode(distanceM);
  const routed = await computeRoute(origin, dest, mode, apiKey);
  const leg: any = routed
    ? {
        mode,
        minutes: routed.minutes,
        distanceMeters: routed.distanceMeters ?? distanceM,
        steps: routed.steps,
        polyline: routed.polyline,
        estimated: false,
      }
    : {
        mode,
        minutes: estimateMinutes(distanceM, mode),
        distanceMeters: distanceM,
        estimated: true,
      };
  if (fromLabel) leg.fromLabel = fromLabel;
  return leg;
}

/**
 * Attaches a real travel leg (with transit steps) to every located stop —
 * from the previous stop, or from HOME for the first one so the day can
 * never "teleport" into another city. Adds a routed trip back home when the
 * day ends away from it. Then cascades the clock around fixed anchors.
 */
async function routeAndSchedule(
  parsed: any,
  context: Context,
  apiKey: string | undefined,
): Promise<void> {
  if (!parsed || !Array.isArray(parsed.sections)) return;

  // Drop any stray AI-emitted "travel" cards; we draw travel ourselves.
  stripAiTravelItems(parsed);

  // 1) Travel legs (needs a Google key to route with). Each hop's endpoints
  //    are already known (from the place coords), so the hops don't depend on
  //    each other — we route them ALL IN PARALLEL instead of one-by-one,
  //    which is the main latency win for a multi-stop day.
  if (apiKey) {
    const homeCoords: Coords | null = context.home
      ? { latitude: context.home.latitude, longitude: context.home.longitude }
      : null;

    const located = flattenItems(parsed).filter((it: any) => it?.place?.coords);

    const hops: {
      item: any;
      origin: Coords;
      dest: Coords;
      fromLabel?: string;
    }[] = [];

    let prevCoords: Coords | null = homeCoords;
    let outOfHome = true; // the first leg starts at the user's home
    for (const item of located) {
      const coords: Coords = item.place.coords;
      if (prevCoords) {
        // Label the origin only for the leg out of home; inter-venue hops
        // start at the card directly above, so naming it would be noise.
        hops.push({
          item,
          origin: prevCoords,
          dest: coords,
          fromLabel: outOfHome ? context.home?.label : undefined,
        });
        outOfHome = false;
      }
      prevCoords = coords;
    }

    const lastCoords: Coords | null = located.length
      ? located[located.length - 1].place.coords
      : null;

    // Trip back home, when the day ends meaningfully away from it. Appended
    // as a synthetic item and routed in the same parallel batch.
    let backHomeItem: any = null;
    if (homeCoords && lastCoords && haversineMeters(lastCoords, homeCoords) > 400) {
      backHomeItem = {
        title: 'Back home',
        kind: 'travel',
        flexibility: 'flexible',
        durationMinutes: 0,
        place: null,
        travelFromPrev: null,
      };
      hops.push({ item: backHomeItem, origin: lastCoords, dest: homeCoords });
    }

    await Promise.all(
      hops.map(async (h) => {
        h.item.travelFromPrev = await computeLeg(h.origin, h.dest, apiKey, h.fromLabel);
      }),
    );

    if (backHomeItem) {
      parsed.sections.push({
        title: 'Head Home',
        period: 'Evening',
        items: [backHomeItem],
      });
    }
  }

  // 2) Cascade the clock (re-flatten so any appended return item is timed).
  const items = flattenItems(parsed);
  if (items.length === 0) return;
  let cursor = parseHHMM(items[0]?.startTime);
  if (cursor == null) cursor = 8 * 60;
  for (const item of items) {
    const legMin = Number(item?.travelFromPrev?.minutes);
    if (Number.isFinite(legMin) && legMin > 0) cursor += legMin;
    let start = cursor;
    if (item?.flexibility === 'fixed') {
      const fixed = parseHHMM(item.startTime);
      // Arrive early → wait for the fixed time. Arrive late → we can't go
      // back in time, so keep the real (late) arrival; the user sees the slip.
      if (fixed != null && fixed >= start) start = fixed;
    }
    // A placeless block reached by a travel leg is a pure arrival (e.g.
    // "Back home") — zero length, just stamp the arrival time.
    const isArrival = !item?.place && !!item?.travelFromPrev;
    const dur = isArrival ? 0 : itemDuration(item);
    item.startTime = fmtHHMM(start);
    if (dur > 0) {
      item.endTime = fmtHHMM(start + dur);
      item.durationMinutes = dur;
    } else {
      item.endTime = null;
      item.durationMinutes = null;
    }
    cursor = start + dur;
  }
}

// --- order optimization (minimize back-and-forth travel) -------------------
//
// Venue resolution already clusters most stops near home/anchors; this pass
// removes the remaining zig-zag by reordering RUNS of flexible located
// sections to flow along the route. Fixed-time commitments and placeless
// (at-home) sections act as fences, so the day's energy arc and hard times
// are preserved. The user's stated order is only the seed; manual/AI
// re-balancing is a later feature.

function permutations<T>(arr: T[]): T[][] {
  if (arr.length <= 1) return [arr];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i++) {
    const rest = arr.slice(0, i).concat(arr.slice(i + 1));
    for (const p of permutations(rest)) out.push([arr[i], ...p]);
  }
  return out;
}

function sectionCoords(section: any): Coords | null {
  if (!section || !Array.isArray(section.items)) return null;
  for (const it of section.items) {
    if (it?.place?.coords) return it.place.coords;
  }
  return null;
}

function sectionHasFixed(section: any): boolean {
  return (
    !!section &&
    Array.isArray(section.items) &&
    section.items.some(
      (it: any) => it?.flexibility === 'fixed' && parseHHMM(it?.startTime) != null,
    )
  );
}

/** Order a small run of nodes to minimize entry -> ... -> exit travel. */
function orderRun(run: any[], entry: Coords | null, exit: Coords | null): any[] {
  if (run.length <= 1) return run;
  const d = (a: Coords | null, b: Coords | null) => (a && b ? haversineMeters(a, b) : 0);
  const cost = (seq: any[]) => {
    let total = 0;
    let prev = entry;
    for (const n of seq) {
      total += d(prev, n.coords);
      prev = n.coords;
    }
    return total + d(prev, exit);
  };
  if (run.length <= 6) {
    // Tiny path-TSP — brute force is exact and cheap at this size.
    let best = run;
    let bestCost = Infinity;
    for (const perm of permutations(run)) {
      const c = cost(perm);
      if (c < bestCost) {
        bestCost = c;
        best = perm;
      }
    }
    return best;
  }
  // Larger runs (rare): greedy nearest-neighbour from the entry point.
  const remaining = run.slice();
  const out: any[] = [];
  let prev = entry;
  while (remaining.length) {
    let bi = 0;
    let bd = Infinity;
    remaining.forEach((n, idx) => {
      const dist = d(prev, n.coords);
      if (dist < bd) {
        bd = dist;
        bi = idx;
      }
    });
    const [n] = remaining.splice(bi, 1);
    out.push(n);
    prev = n.coords;
  }
  return out;
}

/**
 * Reorders flexible located sections to minimize travel, keeping fixed-time
 * and placeless (at-home) sections fixed as fences. Mutates `parsed`.
 */
function reorderSectionsForTravel(parsed: any, home: Coords | null): void {
  if (!parsed || !Array.isArray(parsed.sections) || parsed.sections.length < 3) return;
  const nodes = parsed.sections.map((s: any) => ({
    section: s,
    coords: sectionCoords(s),
    fixed: sectionHasFixed(s),
  }));
  const movable = (n: any) => !!n.coords && !n.fixed;

  const result: any[] = [];
  const lastCoords = (): Coords | null => {
    for (let k = result.length - 1; k >= 0; k--) {
      if (result[k].coords) return result[k].coords;
    }
    return home;
  };

  let i = 0;
  while (i < nodes.length) {
    if (!movable(nodes[i])) {
      result.push(nodes[i]);
      i++;
      continue;
    }
    let j = i;
    while (j < nodes.length && movable(nodes[j])) j++;
    const run = nodes.slice(i, j);
    const entry = lastCoords();
    let exit: Coords | null = home;
    for (let k = j; k < nodes.length; k++) {
      if (nodes[k].coords) {
        exit = nodes[k].coords;
        break;
      }
    }
    result.push(...orderRun(run, entry, exit));
    i = j;
  }

  parsed.sections = result.map((n) => n.section);
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers':
      'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

interface LocationPin {
  label: string;
  latitude: number;
  longitude: number;
}

interface Context {
  home?: LocationPin;
  work?: LocationPin;
  endOfDay?: LocationPin;
  currentLocation?: { latitude: number; longitude: number };
}

function normalizePin(input: any): LocationPin | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const lat = Number(input.latitude);
  const lon = Number(input.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return undefined;
  return {
    label: typeof input.label === 'string' ? input.label : 'Pin',
    latitude: lat,
    longitude: lon,
  };
}

function normalizeContext(input: any): Context {
  if (!input || typeof input !== 'object') return {};
  const ctx: Context = {};
  const home = normalizePin(input.home);
  if (home) ctx.home = home;
  const work = normalizePin(input.work);
  if (work) ctx.work = work;
  const endOfDay = normalizePin(input.endOfDay);
  if (endOfDay) ctx.endOfDay = endOfDay;
  if (input.currentLocation && typeof input.currentLocation === 'object') {
    const lat = Number(input.currentLocation.latitude);
    const lon = Number(input.currentLocation.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      ctx.currentLocation = { latitude: lat, longitude: lon };
    }
  }
  return ctx;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders() });
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  const apiKey = Deno.env.get('OPENAI_API_KEY');
  if (!apiKey) {
    return jsonResponse(
      { error: 'OPENAI_API_KEY not configured on the server.' },
      501,
    );
  }

  let payload: { request?: string; date?: string; context?: any };
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  const request = typeof payload.request === 'string' ? payload.request.trim() : '';
  if (!request) {
    return jsonResponse({ error: 'Missing `request` text.' }, 400);
  }
  const date = typeof payload.date === 'string' ? payload.date : undefined;
  const context = normalizeContext(payload.context);

  const userMessage = JSON.stringify({ request, date, context });

  const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0.5,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
    }),
  });

  if (!openaiRes.ok) {
    const text = await openaiRes.text();
    return jsonResponse({ error: 'OpenAI error', detail: text }, 502);
  }

  const completion = await openaiRes.json();
  const content: string = completion?.choices?.[0]?.message?.content ?? '{}';

  let parsed: any;
  try {
    parsed = JSON.parse(content);
  } catch {
    return jsonResponse({ error: 'Model returned invalid JSON', raw: content }, 502);
  }

  const googleKey = Deno.env.get('GOOGLE_PLACES_API_KEY');

  // 1) Resolve each block's venueQuery to a real, well-rated venue near the
  //    smartest anchor (location-biased, quality-vs-proximity). Best-effort:
  //    without a key, at-home blocks are cleared and the rest keep AI hints.
  try {
    await resolveVenues(parsed, context, googleKey);
  } catch {
    // never fail the request because resolution hiccuped
  }

  // 2) Reorder flexible located stops to minimize back-and-forth (needs the
  //    coords from step 1; fixed + at-home blocks stay put as fences).
  try {
    const homeCoords = context.home
      ? { latitude: context.home.latitude, longitude: context.home.longitude }
      : null;
    reorderSectionsForTravel(parsed, homeCoords);
  } catch {
    // keep the resolved order if reordering hiccuped
  }

  // 3) Turn structure + durations into a real clock: attach map-based travel
  //    legs between the real coords and cascade times around fixed anchors.
  //    Runs even without a Google key — then it just cascades durations with
  //    no travel inserted. Best-effort: never fail the request.
  try {
    await routeAndSchedule(parsed, context, googleKey);
  } catch {
    // keep the unscheduled structure if routing/scheduling hiccuped
  }

  return jsonResponse(parsed);
});
