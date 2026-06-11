/**
 * Itinerary model — the "v2" planning architecture.
 *
 * Where the original `Plan` model (see `./plan.ts`) is built around the
 * user typing ONE activity at a time and the AI scheduling it, this model
 * is built around the AI doing the *core structure planning* for a whole
 * day at once (the "Gemini-style" output): a free-form description in,
 * an ordered list of rich place objects out.
 *
 * The shape is deliberately object-heavy so the rest of the app can
 * *operate on* the result later — reorder items, swap a venue, edit a
 * time — and have the flexible items re-flow around the fixed ones. That
 * re-flow behaviour keys entirely off `ItineraryItem.flexibility`.
 */

/**
 * Coarse activity category. Drives the icon/emoji and lets later passes
 * reason about an item without re-parsing its prose (e.g. "don't schedule
 * two `meal` items back to back").
 */
export type ItineraryItemKind =
  | 'travel' // getting from A to B (train, tram, taxi, walk between stops)
  | 'work' // focused work / coworking
  | 'sightseeing' // landmarks, walking a historic centre
  | 'meal' // breakfast / lunch / dinner
  | 'event' // a timed event with its own start (show, match, concert)
  | 'meetup' // meeting a specific person
  | 'drinks' // bar / pub / cafe social
  | 'activity' // generic doing-something block
  | 'break' // rest / buffer
  | 'gap' // elastic free time the user can name, split, resize, or fill
  | 'other';

/**
 * How locked an item is on the timeline. This is THE field the
 * (future) rescheduler keys off when the user drags, deletes, swaps,
 * or re-times an item:
 *
 *   - 'fixed'    : pinned to `startTime`. A real-world commitment the
 *                  day must bend around — meeting a friend at 12:00,
 *                  an event that starts at 14:00, a reservation. The
 *                  rescheduler NEVER moves these; everything else flows
 *                  around them.
 *   - 'window'   : must fall inside [`windowStart`, `windowEnd`] (e.g. a
 *                  venue's opening hours, "sometime before the train")
 *                  but the exact slot floats.
 *   - 'flexible' : free to slide and reorder. Deep work, drinks, a walk
 *                  — the filler that absorbs schedule changes.
 */
export type TimeFlexibility = 'fixed' | 'window' | 'flexible';

/**
 * How the user gets between two consecutive stops. Mirrors the modes the
 * routing layer understands (and the legacy `src/lib/travel.ts` estimator).
 */
export type ItineraryTravelMode = 'walk' | 'bike' | 'transit' | 'drive';

/**
 * Sub-mode for a single transit step. Lets the UI show the right glyph for
 * each hop (a 🚌 vs 🚇 vs 🚆) when we break a journey down.
 */
export type TravelStepMode =
  | 'walk'
  | 'bus'
  | 'tram'
  | 'subway'
  | 'train'
  | 'ferry'
  | 'transit';

/**
 * One concrete leg of a multi-modal journey, as returned by Google Routes'
 * transit step breakdown — e.g. "Metro C from Kobylisy to Hlavní nádraží".
 * This is what makes the connector show the real route ("from where to
 * where exactly") instead of a single opaque duration.
 */
export interface TravelStep {
  mode: TravelStepMode;
  /** Line label, e.g. "Metro C", "102", "RegioJet". */
  line?: string;
  /** Boarding stop / start point, e.g. "Přívorská". */
  from?: string;
  /** Alighting stop / end point, e.g. "Kobylisy". */
  to?: string;
  /** Minutes spent on this step. */
  durationMinutes?: number;
  /**
   * Google's REAL scheduled board time for a transit step, "HH:MM" 24h (e.g.
   * the bus's "12:40"). Absent for walks and the haversine fallback. The UI
   * shows this verbatim instead of stacking durations from the leave-by, which
   * drifted a few minutes early and ignored platform waits.
   */
  departAt?: string;
  /** Google's REAL scheduled alight time for a transit step, "HH:MM" 24h. */
  arriveAt?: string;
  /** Number of stops ridden on a transit step, when known. */
  numStops?: number;
  /** Geo of the boarding stop, so the journey's stations can be mapped. */
  fromCoords?: { latitude: number; longitude: number };
  /** Geo of the alighting stop. */
  toCoords?: { latitude: number; longitude: number };
}

/**
 * A real, map-derived hop from the previous located stop to THIS item.
 *
 * This is the piece that makes the day practical instead of guessed: the
 * minutes come from Google Routes between the two venues' real coordinates
 * (door-to-door, mode-aware), and the scheduler adds them to the clock so
 * "you leave home at 07:15 to make the 12:00 meetup" actually holds up.
 */
export interface TravelLeg {
  mode: ItineraryTravelMode;
  /** Door-to-door minutes for this hop. */
  minutes: number;
  /** Routing distance in meters, when known. */
  distanceMeters?: number;
  /**
   * Where the hop starts, shown in the UI ("…from Home"). Only set for the
   * leg out of the user's origin; inter-venue hops leave this blank since
   * the previous card already names the start.
   */
  fromLabel?: string;
  /** Optional human hint, e.g. "Tram 2 → short walk". */
  summary?: string;
  /**
   * The journey broken into concrete legs (walk → bus → metro → train …).
   * Present for multi-modal routes from Google Routes; absent for trivial
   * single-mode hops and for the haversine fallback.
   */
  steps?: TravelStep[];
  /** True when this is the local haversine fallback, not real Routes data. */
  estimated?: boolean;
  /**
   * Google-encoded polyline of the real route geometry between the two
   * stops, so the map can trace the actual path (train tracks, bus route)
   * instead of a straight line. Absent for the haversine fallback.
   */
  polyline?: string;
}

/**
 * One open→close interval in a venue's weekly schedule, mirroring the shape
 * Google Places returns under `regularOpeningHours.periods`. `day` is
 * 0 = Sunday … 6 = Saturday. A period whose `close` is omitted means the
 * venue is open 24 hours from that `open` point (Google's "always open"
 * representation). `close.day` may differ from `open.day` for venues that
 * trade past midnight (a bar open Fri 18:00 → Sat 02:00).
 */
export interface VenueOpenPeriod {
  open: { day: number; hour: number; minute: number };
  close?: { day: number; hour: number; minute: number };
}

/**
 * A venue's weekly opening schedule — enough to decide whether a planned
 * visit (a date + time window) falls inside an open interval. Populated from
 * Google Places during enrichment; absent for providers/venues without hours.
 */
export interface VenueOpeningHours {
  /** Weekly open intervals. */
  periods: VenueOpenPeriod[];
  /** Google's human-readable lines ("Monday: 9:00 AM – 6:00 PM"), for display. */
  weekdayDescriptions?: string[];
}

/**
 * A real-world venue attached to an item. Mirrors the kind of structured
 * data a grounded web search (Google Places / Gemini grounding) returns,
 * so this object can be populated either by the model's own knowledge now
 * or by a live places lookup later without changing the shape.
 */
export interface ItineraryPlace {
  /** Display name, e.g. "Telegraph Coworking". */
  name: string;
  /** Human label for the venue type, e.g. "Coworking space", "Irish pub". */
  category?: string;
  /** Single emoji that mirrors the category, e.g. "💻". */
  emoji?: string;
  /** Street address / neighbourhood when known. */
  address?: string;
  /** Star rating 0–5. */
  rating?: number;
  /** Number of ratings behind `rating`, when known. */
  ratingCount?: number;
  /** Free-form price hint: "$$", "CZK200–CZK600". */
  priceLevel?: string;
  /** Free-form open/closed hint: "Open · Closes at 6.00 pm". */
  openStatus?: string;
  /**
   * Structured weekly opening hours, used to check whether a visit at the
   * item's scheduled date + time actually fits inside open hours. Recomputed
   * client-side as the schedule reflows on edits. Absent when the provider
   * returned no hours (status is then treated as unknown — never flagged).
   */
  openingHours?: VenueOpeningHours;
  /**
   * True when this venue came from the user naming it explicitly (the planner
   * set `place.userQuery`). Such venues are kept verbatim even if closed at the
   * visit time — the UI shows a "consider changing" notice instead of the
   * planner swapping them for an open alternative.
   */
  userNamed?: boolean;
  /** Geocoded coordinates, when resolvable. */
  coords?: { latitude: number; longitude: number };
  /**
   * Auth-free CDN photo URL for the venue. Populated server-side by a
   * Google Places lookup (same source as `find-places`), so the card can
   * show a real image the way grounded search results do.
   */
  photoUrl?: string;
  /** Source/citation URL the venue details were grounded on, when any. */
  sourceUrl?: string;
}

/**
 * One block of the day. The atomic unit users will reorder / edit.
 */
export interface ItineraryItem {
  /** Stable id — survives reordering and edits. */
  id: string;
  /** Short action title, e.g. "High-focus deep work". */
  title: string;
  kind: ItineraryItemKind;
  /** Determines whether the rescheduler may move this item. */
  flexibility: TimeFlexibility;
  /** "HH:MM" 24h. For `fixed` items this is the hard anchor. */
  startTime?: string;
  /** "HH:MM" 24h end of the block, when known. */
  endTime?: string;
  /** Planned length in minutes (source of truth when re-timing). */
  durationMinutes?: number;
  /** For `window` items: earliest the block may start ("HH:MM"). */
  windowStart?: string;
  /** For `window` items: latest the block may start ("HH:MM"). */
  windowEnd?: string;
  /** The venue this item happens at, when it has one. */
  place?: ItineraryPlace;
  /**
   * Real (or estimated) travel from the previous located stop to this item.
   * Populated server-side from Google Routes; absent for the first stop and
   * for personal at-home blocks (wake, breakfast) that don't move you.
   */
  travelFromPrev?: TravelLeg;
  /**
   * Intended free time BEFORE this item, on top of any travel leg. Captured
   * on the first cascade from the planner's original start times so the day's
   * natural breathing room (coffee gap before lunch, buffer before a fixed
   * meeting) is PRESERVED across subsequent edits. Re-cascades simply add
   * `travel + gap` between blocks instead of collapsing everything back-to-back.
   * Set to 0 (not undefined) once captured to distinguish "no gap" from "not
   * yet measured".
   */
  gapBeforeMin?: number;
  /** Prose explanation — the Gemini-style "what / why" paragraph. */
  description?: string;
  /**
   * True for the synthetic "Back home" marker the router appends when the day
   * ends away from home. Unlike a normal `travel` block (a train ride, where
   * startTime is the DEPARTURE), an arrival marker's `startTime` is when you
   * ARRIVE — so the UI computes "leave by" as startTime − leg.minutes and
   * labels the card "Arrive HH:MM".
   */
  arrival?: boolean;
  /** 0-based position in the day. Kept dense + contiguous. */
  orderIndex: number;
}

/**
 * A named block of the day grouping one or more concrete items. The title
 * is the catchy, human-friendly headline ("Time for Food!", "Explore the
 * Old Town") that can cover several places — e.g. a sightseeing section
 * dissected into one item per landmark. A simple activity (deep work) is a
 * section with a single item.
 *
 * Sections are also the unit the screen's header tracks while scrolling.
 */
export interface ItinerarySection {
  id: string;
  /** Catchy headline, e.g. "Time for Food!". Shared across the section's items. */
  title: string;
  /** Optional time-of-day kicker, e.g. "Morning", "Afternoon", "Evening". */
  period?: string;
  /** Concrete items — ideally one real, named place per item. */
  items: ItineraryItem[];
}

/**
 * A full day's plan, grouped into sections.
 */
export interface Itinerary {
  id: string;
  /** Headline, e.g. "Prague → Olomouc day trip". */
  title: string;
  /** Intro paragraph framing the day. */
  summary?: string;
  /** "YYYY-MM-DD" when the day is dated. */
  date?: string;
  /** Where the day departs from (the user's address / home). */
  origin?: string;
  /**
   * Where THIS plan's day actually begins, baked in when the plan is created.
   * A saved day re-routes its first leg from this fixed origin (home, a hotel,
   * a friend's place) instead of inheriting whatever start the global planner-
   * setup drawer happens to hold now — which is how a "from home" day silently
   * turned into a short walk once the user picked a different start elsewhere.
   * Absent on older plans → recompute falls back to home.
   */
  startLocation?: { label?: string; latitude: number; longitude: number } | null;
  /**
   * Primary city the day takes place in, e.g. "Olomouc, Czechia". Used to
   * disambiguate venue names when grounding places against Google.
   */
  city?: string;
  sections: ItinerarySection[];
}

export const ITINERARY_KINDS: ItineraryItemKind[] = [
  'travel',
  'work',
  'sightseeing',
  'meal',
  'event',
  'meetup',
  'drinks',
  'activity',
  'break',
  'gap',
  'other',
];

export const TIME_FLEXIBILITIES: TimeFlexibility[] = [
  'fixed',
  'window',
  'flexible',
];

/** Fallback emoji per kind, used when the model didn't supply a place emoji. */
export const KIND_EMOJI: Record<ItineraryItemKind, string> = {
  travel: '🚆',
  work: '💻',
  sightseeing: '🏛️',
  meal: '🍽️',
  event: '🎟️',
  meetup: '🤝',
  drinks: '🍺',
  activity: '✨',
  break: '☕',
  gap: '⏳',
  other: '📍',
};
