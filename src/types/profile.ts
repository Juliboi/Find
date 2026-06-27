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
  /** Minutes the user needs to fully wake up before focused/productive time. */
  wake_up_duration_min: number | null;
  /** Comfortable meal windows ("HH:MM:SS" from PostgREST; nullable). */
  breakfast_start: string | null;
  breakfast_end: string | null;
  lunch_start: string | null;
  lunch_end: string | null;
  dinner_start: string | null;
  dinner_end: string | null;
  /** After this time the planner sticks to calm, sleep-friendly activities. */
  wind_down_time: string | null;
  /** Whether screen-heavy wind-down activities are acceptable near bedtime. */
  allow_screen_wind_down: boolean | null;
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
  /** Minutes the user takes to fully wake up (morning ramp-up). */
  wakeUpDurationMin: number;
  /** "HH:MM" comfortable meal windows. */
  breakfastStart: string;
  breakfastEnd: string;
  lunchStart: string;
  lunchEnd: string;
  dinnerStart: string;
  dinnerEnd: string;
  /** "HH:MM" after which only calm, sleep-friendly activities are scheduled. */
  windDownTime: string;
  /** Whether screen-heavy wind-down activities are acceptable near bedtime. */
  allowScreenWindDown: boolean;
  hasCar: boolean;
  /** Canonical dietary tags chosen from the onboarding chip set. */
  dietary: string[];
  /** Freeform dietary notes / allergies, or null when left blank. */
  dietaryNotes: string | null;
}

/**
 * The six "HH:MM" meal-window fields, editable on their own (e.g. from the
 * planner drawer) without re-saving the entire onboarding profile. Keyed to the
 * `useProfileStore` fields so a patch can flow straight into the local mirror.
 */
export interface MealWindowsInput {
  breakfastStart: string;
  breakfastEnd: string;
  lunchStart: string;
  lunchEnd: string;
  dinnerStart: string;
  dinnerEnd: string;
}

/** Maps each meal-window field to its `public.profiles` column. */
export const MEAL_WINDOW_COLUMN: Record<keyof MealWindowsInput, string> = {
  breakfastStart: 'breakfast_start',
  breakfastEnd: 'breakfast_end',
  lunchStart: 'lunch_start',
  lunchEnd: 'lunch_end',
  dinnerStart: 'dinner_start',
  dinnerEnd: 'dinner_end',
};

/** Trim a Postgres "HH:MM:SS" time to the app's "HH:MM". */
export function normalizeTime(t: string | null | undefined): string | null {
  if (!t) return null;
  return t.slice(0, 5);
}
