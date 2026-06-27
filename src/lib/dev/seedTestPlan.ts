import { useErrandsStore, type ErrandInput } from '@/store/useErrandsStore';
import {
  usePlanSetupStore,
  DEFAULT_MEAL_MODES,
} from '@/store/usePlanSetupStore';
import { useHomeStore } from '@/store/useHomeStore';
import { tomorrowISO } from '@/utils/time';
import type { VenueOpeningHours } from '@/types/itinerary';

/**
 * DEV-only test harness.
 *
 * Re-creates a fixed, repeatable "tomorrow" so we can regenerate the exact same
 * itinerary over and over. The errands below are ISOLATED debug errands
 * (`source: 'test'`): they're separate from your real errands, they NEVER get
 * auto-marked "Planned" (so they don't vanish after a plan), they're always
 * dated tomorrow, and only a manual delete or a re-seed removes them. Each run
 * plans with EXACTLY these errands (real errands on the date are ignored).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  EDIT BELOW to control precisely what gets sent.
 *
 *  Each errand provides ONE of:
 *   • `place`          — an EXACT venue, sent to the planner VERBATIM (no
 *                        auto-resolution, no guessing). Paste this straight from
 *                        the `(6) PLANNER INPUT` log's `anchors` array. THIS is
 *                        how you pin "Massage → your Korunní TAWAN" instead of
 *                        letting the resolver pick the Hilton branch.
 *   • neither          — a place-less task (online / at-home, e.g. a video call).
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** The free-text description folded in on top of the errands. */
export const TEST_PLAN_INTENT =
  'Go to a maxfitness gym, language learning 1.5h, skincare, read before sleep';

/** Day frame for the test day. */
const TEST_START_TIME = '08:30';
const TEST_END_TIME = '23:00';

/** One editable debug errand. See the banner above for the three modes. */
interface TestErrand {
  title: string;
  /** Optional hard time pin, "HH:MM". */
  startTime?: string;
  endTime?: string;
  durationMin?: number;
  notes?: string;
  /** EXACT venue — sent verbatim. Paste from the `(6) PLANNER INPUT` log. */
  place?: {
    /** Venue label, e.g. "TAWAN Thajské masáže - Korunní". */
    name: string;
    latitude: number;
    longitude: number;
    placeId?: string;
    photoUrl?: string;
    rating?: number;
    ratingCount?: number;
    priceLevel?: number;
    openingHours?: VenueOpeningHours;
  };
}

/** A plain 7-day "HH:MM–HH:MM" weekly schedule for a venue's opening hours. */
function weeklyHours(openHour: number, closeHour: number): VenueOpeningHours {
  return {
    periods: Array.from({ length: 7 }, (_, day) => ({
      open: { day, hour: openHour, minute: 0 },
      close: { day, hour: closeHour, minute: 0 },
    })),
  };
}

const TEST_ERRANDS: TestErrand[] = [
  {
    title: 'Teeth whitening',
    // Verbatim located errand. Swap for your exact Premier Clinic venue (paste
    // from the `(6) PLANNER INPUT` log) to pin the precise branch.
    place: {
      name: 'Premier Clinic, Prague',
      latitude: 50.0796,
      longitude: 14.4304,
    },
  },
  {
    title: 'Deep work',
    durationMin: 120,
    // Verbatim located errand. Swap for your exact Space Café venue to pin it.
    place: {
      name: 'Space Café Karlín, Prague',
      latitude: 50.0925,
      longitude: 14.4509,
    },
  },
  {
    // Place-less: the title has "online", so the planner keeps it at home and
    // never attaches a venue (the "online therapy → random shop" bug).
    title: 'Online therapy session',
    startTime: '11:00',
    endTime: '12:00',
    notes: 'Online therapy session — joins by video call, no physical location.',
  },
  {
    title: 'Massage',
    // VERBATIM venue. NOTE: this is the HILTON branch the auto-resolver picked —
    // swap `name` + `latitude`/`longitude` for your Korunní branch (paste from
    // the `(6) PLANNER INPUT` log) to send exactly the one you mean.
    place: {
      name: 'TAWAN Thajské masáže - Hilton Prague',
      latitude: 50.0934009,
      longitude: 14.4391713,
      photoUrl:
        'https://lh3.googleusercontent.com/place-photos/AJRVUZNUO-WfLMmm82J_9RwDO8PhJomh7WEmfIkWr2rYSqjLbEATGQB5Pnposy4s-cm9ML9ZGD4ATlVjLXe-LGDaxQW48X3MpEPYbuOYSO0CAyskMaUhQjhA0pQGsgV9Li1DtXO5-QChI-ortwIwn1eBrwix=s4800-w400-h400',
      rating: 4.8,
      ratingCount: 114,
      openingHours: weeklyHours(10, 22),
    },
  },
  {
    // GOLDEN closed-venue case: a verbatim bakery open only 07:00–10:00, so any
    // afternoon slot is CLOSED. Exercises (a) the card's opening-hours warning
    // and (b) the refine pass RETIMING it into the morning (a user-named venue's
    // identity is kept — only its time should move).
    title: 'Pick up sourdough',
    place: {
      name: 'Morning Bakery (closes 10:00)',
      latitude: 50.1045,
      longitude: 14.4378,
      openingHours: weeklyHours(7, 10),
    },
  },
];

export interface SeedTestPlanResult {
  /** The day that was seeded ("YYYY-MM-DD", always tomorrow). */
  date: string;
  /** The free-text intent to pass to the itinerary screen for auto-planning. */
  intent: string;
}

/**
 * Seed (or re-seed) the repeatable test day for tomorrow:
 *   1. Remove prior DEBUG errands (`source: 'test'`) + tomorrow's brain-made
 *      freestyle errands. NEVER touches your real ('user') errands.
 *   2. Create the {@link TEST_ERRANDS} fresh, dated tomorrow, tagged 'test'
 *      (verbatim venue / place-less, per entry).
 *   3. Pin the day frame: home → home, 08:30 → 23:00, tomorrow.
 *
 * Returns the day + the free-text intent for the caller to auto-plan with.
 */
export function seedTestPlan(): SeedTestPlanResult {
  const date = tomorrowISO();
  const store = useErrandsStore.getState();
  const home = useHomeStore.getState().home;

  // 1) Wipe prior debug errands + tomorrow's freestyle errands. Iterating the
  //    captured snapshot is safe: `remove` swaps in a new items array.
  for (const e of store.items) {
    const isDebug = e.source === 'test';
    const isFreestyleTomorrow = e.source === 'freestyle' && e.date === date;
    if (isDebug || isFreestyleTomorrow) store.remove(e.id);
  }

  // 2) Recreate the debug errands fresh for tomorrow.
  const summary: string[] = [];
  TEST_ERRANDS.forEach((t, i) => {
    const input: ErrandInput = {
      title: t.title,
      startTime: t.startTime,
      endTime: t.endTime,
      durationMin: t.durationMin,
      notes: t.notes,
      date,
      source: 'test',
      rawText: t.title,
    };
    let venue: string;
    if (t.place) {
      // A verbatim located errand: an `address` makes the coords + metadata
      // stick (see normalizeInput).
      input.address = t.place.name;
      input.latitude = t.place.latitude;
      input.longitude = t.place.longitude;
      input.placeId = t.place.placeId;
      input.photoUrl = t.place.photoUrl;
      input.rating = t.place.rating;
      input.ratingCount = t.place.ratingCount;
      input.priceLevel = t.place.priceLevel;
      input.openingHours = t.place.openingHours;
      venue = `VERBATIM "${t.place.name}" (${t.place.latitude}, ${t.place.longitude})`;
    } else {
      venue = 'place-less (at-home / online)';
    }
    store.add(input);
    const when = t.startTime ? ` @ ${t.startTime}-${t.endTime ?? '?'}` : '';
    summary.push(`  ${i + 1}. ${t.title}${when} -> ${venue}`);
  });

  // 3) Pin the day frame to home → home, 08:30 → 23:00, tomorrow.
  usePlanSetupStore.getState().setDayPlan({
    date,
    startTime: TEST_START_TIME,
    startLocation: home,
    endTime: TEST_END_TIME,
    endLocation: home,
    mealModes: { ...DEFAULT_MEAL_MODES },
    mealLinks: { breakfast: null, lunch: null, dinner: null },
  });

  if (__DEV__) {
    console.log(
      `[test-seed] ${TEST_ERRANDS.length} debug errands for ${date} ` +
        `(${TEST_START_TIME}-${TEST_END_TIME}, ${home?.label ?? 'home'} -> ${home?.label ?? 'home'}):\n` +
        summary.join('\n') +
        `\n  + free-text: "${TEST_PLAN_INTENT}"`,
    );
  }

  return { date, intent: TEST_PLAN_INTENT };
}
