export type PlanStatus = 'draft' | 'needs_clarification' | 'scheduled' | 'done';

export interface SubTask {
  id: string;
  title: string;
  durationMinutes: number;
}

export interface Plan {
  id: string;
  title: string;
  /** Original raw text the user typed. */
  rawText: string;
  /** Free-form description (what / where / why). */
  description?: string;
  /** Human-readable location label, set after AI clarification. */
  location?: string;
  /**
   * Geocoded coordinates for the location, when resolvable. Populated
   * when the user picks a real place (from the auto place-search) — we
   * keep the lat/lng so downstream features (travel-time rows, smart
   * compose, map view) can do geometry without re-geocoding the name.
   * Absent for free-text locations the user typed manually.
   */
  locationCoords?: { latitude: number; longitude: number };
  /**
   * One-line explanation written by the compose pass for why this
   * venue was picked over the alternatives. Lets the UI show the
   * "why" without re-querying — it's the bit that makes the day feel
   * thought-through rather than randomly picked. Absent for plans
   * with a user-typed location.
   */
  composeReasoning?: string;
  /**
   * LLM-rewritten search queries, used when the user taps "Find one
   * nearby". The client fans these out to Google Text Search in
   * parallel, merges + dedupes the results, and then asks GPT to
   * re-rank and write a short pitch for each.
   *
   * Why an *array*: Google Maps users naturally try multiple wordings
   * ("dinner" vs "food" vs "restaurant") to surface the full set of
   * relevant venues — categorization in Google's database is uneven
   * (e.g. "Max Fitness Krakov" is typed `spa`, not `gym`; vegan spots
   * are sometimes typed `restaurant`, sometimes `vegan_restaurant`).
   * Querying multiple variants closes those gaps.
   *
   * Conventions:
   *   - First entry is the canonical query (most specific to intent).
   *   - 2-3 entries total. More than 3 is rarely worth the API cost.
   *   - Empty/undefined → falls back to title/rawText.
   */
  placeSearchQueries?: string[];
  /**
   * @deprecated Pre-multi-query field. Old persisted plans may still
   * have it; the client falls back to it when `placeSearchQueries` is
   * absent. New plans should use the array form exclusively.
   */
  placeSearchQuery?: string;
  /** Logical sub-steps inferred by AI (e.g. prep, cook, cleanup). */
  subtasks: SubTask[];
  /** Estimated minutes for the whole plan including subtasks. */
  durationMinutes: number;
  /** ISO time-of-day "HH:MM" once scheduled. */
  startTime?: string;
  /** AI-asked question we still need an answer for. */
  clarificationQuestion?: string;
  /** Pre-baked suggestions for the user to pick from when clarifying. */
  clarificationSuggestions?: string[];
  /**
   * Last clarification the user resolved on this plan. Sent back to the AI on
   * reschedule so it won't ask the same thing again.
   */
  resolvedClarification?: { question: string; answer: string };
  status: PlanStatus;
  orderIndex: number;
}

export interface DaySchedule {
  id: string;
  date: string; // YYYY-MM-DD
  summary?: string;
  plans: Plan[];
  updatedAt: string;
}
