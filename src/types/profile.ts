/**
 * Shape of a row in `public.profiles` (see migration 0002_profiles.sql).
 * `time` columns come back from PostgREST as "HH:MM:SS" strings; the app
 * normalises them to "HH:MM" before use.
 */
export interface ProfileRow {
  id: string;
  full_name: string | null;
  email: string | null;
  home_label: string | null;
  home_latitude: number | null;
  home_longitude: number | null;
  wake_time: string | null;
  bed_time: string | null;
  has_car: boolean;
  /** Canonical dietary tags (e.g. "vegetarian", "gluten-free"). */
  dietary: string[] | null;
  /** Freeform dietary notes / allergies the chips don't cover. */
  dietary_notes: string | null;
  onboarding_completed: boolean;
  created_at: string;
  updated_at: string;
}

/** The answers collected by the onboarding flow. */
export interface OnboardingInput {
  fullName: string | null;
  homeLabel: string | null;
  homeLatitude: number | null;
  homeLongitude: number | null;
  /** "HH:MM" 24h. */
  wakeTime: string;
  /** "HH:MM" 24h. */
  bedTime: string;
  hasCar: boolean;
  /** Canonical dietary tags chosen from the onboarding chip set. */
  dietary: string[];
  /** Freeform dietary notes / allergies, or null when left blank. */
  dietaryNotes: string | null;
}

/** Trim a Postgres "HH:MM:SS" time to the app's "HH:MM". */
export function normalizeTime(t: string | null | undefined): string | null {
  if (!t) return null;
  return t.slice(0, 5);
}
