/**
 * Smart-ish detection of which of the user's errands "is" a meal, so the planner
 * drawer can show a real dining errand (a reservation, a lunch with a friend, a
 * "grab food" stop) in its Breakfast/Lunch/Dinner row instead of the generic
 * Home/Out chips — and so the planning brain treats that errand AS the meal
 * rather than inventing a duplicate.
 *
 * It's a heuristic, not magic: a dining SIGNAL in the errand's words/category
 * (so "grab a bite", "eat", "Café Savoy" all count — not just the literal word
 * "lunch") plus a real place, scored higher when its time also lands in the
 * meal's window. The drawer lets the user unlink a wrong guess, and the brain
 * does the authoritative association during planning, so a miss here is cheap.
 */
import type { Errand } from '@/store/useErrandsStore';
import type { MealKey } from '@/store/usePlanSetupStore';
import { minutesOfDay } from '@/utils/time';

export interface MealWindow {
  start?: string | null;
  end?: string | null;
}

/** Words that specifically name ONE meal — a strong signal for THAT meal. */
const MEAL_WORDS: Record<MealKey, RegExp> = {
  breakfast: /\b(breakfast|brunch)\b/i,
  lunch: /\b(lunch|brunch|luncheon)\b/i,
  dinner: /\b(dinner|supper)\b/i,
};

/** Any dining signal at all — the gate for an errand to count as "a meal". */
const DINING_SIGNAL =
  /\b(eat|eating|meal|food|grab\s+(a\s+)?(bite|food|lunch|dinner|coffee)|brunch|breakfast|lunch|dinner|supper|restaurant|caf[eé]|coffee|bistro|brasserie|trattoria|osteria|pizza|pizzeria|sushi|burger|ramen|noodles?|pho|tapas|dim\s?sum|bbq|barbecue|steak(house)?|kebab|tacos?|taqueria|bakery|patisserie|deli|diner|eatery|canteen|food\s?court|pub|brewery|wine\s?bar|gastro)\b/i;

function errandText(e: Errand): string {
  return [e.title, e.notes, e.placeQuery, e.address].filter(Boolean).join(' ');
}

/** An errand can stand in for a meal only if it has a place to show/route to. */
function hasUsablePlace(e: Errand): boolean {
  if (typeof e.latitude === 'number' && typeof e.longitude === 'number') return true;
  return e.autoPlace === true && !!e.placeQuery;
}

function inWindow(hhmm: string | undefined, w?: MealWindow): boolean {
  if (!hhmm || !w) return false;
  const m = minutesOfDay(hhmm);
  if (m == null) return false;
  const s = w.start ? minutesOfDay(w.start) : null;
  const e = w.end ? minutesOfDay(w.end) : null;
  if (s != null && e != null) return m >= s - 30 && m <= e + 30;
  if (s != null) return Math.abs(m - s) <= 90;
  return false;
}

/** A short human label for what the errand's meal place is. */
export function mealErrandLabel(e: Errand): string {
  if (e.address && e.address.trim()) return e.address.trim();
  if (e.autoPlace && e.placeQuery) return e.placeQuery;
  return e.title;
}

/**
 * Map each meal to the errand that best "is" that meal for the given day, or
 * null. An errand is only ever assigned to one meal (its best-scoring one).
 */
export function detectMealErrands(
  errands: Errand[],
  windows: Partial<Record<MealKey, MealWindow>>,
  dateISO: string,
): Record<MealKey, Errand | null> {
  const result: Record<MealKey, Errand | null> = {
    breakfast: null,
    lunch: null,
    dinner: null,
  };

  // Eligible = on this day (or undated), not done/already-elsewhere, has a
  // place, and reads as dining.
  const eligible = errands.filter(
    (e) =>
      e.done !== true &&
      (e.date == null || e.date === dateISO) &&
      (e.plannedDate == null || e.plannedDate === dateISO) &&
      hasUsablePlace(e) &&
      DINING_SIGNAL.test(errandText(e)),
  );
  if (eligible.length === 0) return result;

  const keys: MealKey[] = ['breakfast', 'lunch', 'dinner'];
  const score = (e: Errand, meal: MealKey): number => {
    const text = errandText(e);
    let s = 1; // passed the dining gate
    if (MEAL_WORDS[meal].test(text)) s += 3;
    if (inWindow(e.startTime, windows[meal])) s += 2;
    return s;
  };

  // Each errand picks its single best meal; then each meal keeps its top errand.
  const best: Record<MealKey, { e: Errand; s: number } | null> = {
    breakfast: null,
    lunch: null,
    dinner: null,
  };
  for (const e of eligible) {
    let bestMeal: MealKey | null = null;
    let bestScore = 0;
    for (const meal of keys) {
      const s = score(e, meal);
      if (s > bestScore) {
        bestScore = s;
        bestMeal = meal;
      }
    }
    // Need a real signal beyond the bare dining gate (a meal word or in-window).
    if (bestMeal && bestScore >= 3) {
      const cur = best[bestMeal];
      if (!cur || bestScore > cur.s) best[bestMeal] = { e, s: bestScore };
    }
  }
  for (const meal of keys) result[meal] = best[meal]?.e ?? null;
  return result;
}
