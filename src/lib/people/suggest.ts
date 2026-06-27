/**
 * Fuzzy matching of saved people against what the user typed for an errand, so
 * the confirm form can offer a one-tap "did you mean…" chip when the parser
 * didn't catch a saved person by itself.
 *
 * Two things are matched, diacritic- and typo-tolerantly:
 *   - a person's NAME / nicknames against the errand text ("doctors visit" → the
 *     saved person "doctor"), and
 *   - a person's saved PLACE label against the text ("Váš Praktik at Ladvi" → the
 *     saved place "Váš praktika kobylisy").
 *
 * Everything here is dependency-free and intentionally avoids
 * `String.prototype.normalize` — it's unreliable on Hermes/Android (throws or
 * no-ops in release builds), so we fold accents with an explicit map instead.
 * That keeps Czech (and other Latin) names matching the same with or without
 * diacritics.
 */
import { personAliases, type Person, type PersonPlace } from '@/store/usePeopleStore';

/** Accented Latin letters → their ASCII base. Lowercase only (we fold case first). */
const FOLD_MAP: Record<string, string> = {};
function addFold(chars: string, base: string): void {
  for (const ch of chars) FOLD_MAP[ch] = base;
}
addFold('àáâãäåāăąǎ', 'a');
addFold('çćčĉċ', 'c');
addFold('ďđ', 'd');
addFold('èéêëēĕėęě', 'e');
addFold('ĝğġģ', 'g');
addFold('ĥħ', 'h');
addFold('ìíîïĩīĭįı', 'i');
addFold('ĵ', 'j');
addFold('ķ', 'k');
addFold('ĺļľŀł', 'l');
addFold('ñńņňŉ', 'n');
addFold('òóôõöøōŏőǒ', 'o');
addFold('ŕŗř', 'r');
addFold('śŝşš', 's');
addFold('ţťŧ', 't');
addFold('ùúûüũūŭůűųǔ', 'u');
addFold('ŵ', 'w');
addFold('ýÿŷ', 'y');
addFold('źżž', 'z');
addFold('æ', 'ae');
addFold('œ', 'oe');
addFold('ß', 'ss');

/** Lowercase + strip accents so "Váš" and "vas" compare equal. */
export function foldText(input: string): string {
  let out = '';
  for (const ch of (input ?? '').toLowerCase()) out += FOLD_MAP[ch] ?? ch;
  return out;
}

/** Folded, punctuation-free word list (empties dropped). */
function tokenize(input: string): string[] {
  return foldText(input)
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0);
}

/** Classic Levenshtein edit distance (small strings — cheap). */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/**
 * Are two folded tokens "the same word", allowing typos and a short
 * plural/inflection tail? Tuned to be generous enough for "doctor"/"doctors"
 * and "praktik"/"praktika" while rejecting accidental short collisions like
 * "sam"/"same" or "tom"/"mom".
 */
function tokensClose(a: string, b: string): boolean {
  if (a === b) return true;
  const min = Math.min(a.length, b.length);
  const max = Math.max(a.length, b.length);
  // Shared stem ("praktik" ⊂ "praktika", "doctor" ⊂ "doctors"). Require a real
  // stem length and only a small tail so "cat" doesn't swallow "catastrophe".
  if (min >= 4 && max - min <= 3 && (a.startsWith(b) || b.startsWith(a))) return true;
  // Typo tolerance, scaled to length. Nothing for very short words (too risky).
  const allowed = min < 4 ? 0 : min < 8 ? 1 : 2;
  if (allowed === 0) return false;
  return editDistance(a, b) <= allowed;
}

/** Does any token in `pool` closely match `token`? */
function poolHas(pool: string[], token: string): boolean {
  for (const p of pool) if (tokensClose(p, token)) return true;
  return false;
}

/**
 * Generic geo words that shouldn't, on their own, make a place "match" — a lone
 * "Praha"/"street" overlap is too weak to suggest someone's saved place.
 */
const PLACE_STOPWORDS = new Set([
  'praha', 'prague', 'brno', 'street', 'st', 'road', 'rd', 'ave', 'avenue',
  'blvd', 'namesti', 'nam', 'square', 'city', 'ulice', 'trida',
]);

/** A saved person worth offering, with why it surfaced and a sort score. */
export interface PersonSuggestion {
  person: Person;
  /** Always present — we only suggest people who have a place to apply. */
  place: PersonPlace;
  /** Whether the person's name or their place label drove the match. */
  reason: 'name' | 'place';
  /** Higher = stronger; used only to rank. */
  score: number;
}

interface SuggestArgs {
  people: Person[];
  /** Text to match a person's NAME against (e.g. the errand title + raw text). */
  nameText?: string | null;
  /** Text to match a person's PLACE label against (e.g. address + raw text). */
  placeText?: string | null;
  /** Skip the person whose place is already chosen (folded labels equal). */
  skipPlaceLabel?: string | null;
  /** Max suggestions to return (default 3). */
  limit?: number;
}

/**
 * Rank saved people that plausibly match the typed errand. Only people with a
 * saved place are returned (a suggestion has to *do* something — pin a place).
 */
export function suggestPeople({
  people,
  nameText,
  placeText,
  skipPlaceLabel,
  limit = 3,
}: SuggestArgs): PersonSuggestion[] {
  const nameTokens = tokenize(nameText ?? '');
  const placeTokens = tokenize(placeText ?? '');
  if (!nameTokens.length && !placeTokens.length) return [];
  const skip = skipPlaceLabel ? foldText(skipPlaceLabel).replace(/\s+/g, ' ').trim() : '';

  const out: PersonSuggestion[] = [];
  for (const person of people) {
    const place = person.place;
    if (!place?.label) continue; // nothing to apply
    if (skip && foldText(place.label).replace(/\s+/g, ' ').trim() === skip) continue;

    // --- name / nickname match against the errand text ---
    let nameScore = 0;
    if (nameTokens.length) {
      for (const alias of personAliases(person)) {
        const aliasTokens = tokenize(alias);
        if (!aliasTokens.length) continue;
        // Every word of the alias must appear (closely) in the text.
        if (!aliasTokens.every((at) => poolHas(nameTokens, at))) continue;
        // Exact word(s) beat a fuzzy/stemmed hit.
        const exact = aliasTokens.every((at) => nameTokens.includes(at));
        nameScore = Math.max(nameScore, exact ? 1 : 0.8);
      }
    }

    // --- place-label match against the errand text ---
    let placeScore = 0;
    if (placeTokens.length) {
      const significant = tokenize(place.label).filter(
        (w) => w.length >= 4 && !PLACE_STOPWORDS.has(w),
      );
      let matched = 0;
      let longMatched = 0;
      for (const lt of significant) {
        if (poolHas(placeTokens, lt)) {
          matched += 1;
          if (lt.length >= 6) longMatched += 1;
        }
      }
      // Two distinctive words, or one long distinctive word, is enough signal.
      if (matched >= 2 || longMatched >= 1) {
        placeScore = Math.min(1, 0.6 + 0.2 * matched);
      }
    }

    if (nameScore === 0 && placeScore === 0) continue;
    const high = Math.max(nameScore, placeScore);
    const low = Math.min(nameScore, placeScore);
    out.push({
      person,
      place,
      reason: placeScore > nameScore ? 'place' : 'name',
      // Blend so a person matched on *both* name and place ranks highest.
      score: high + low * 0.25,
    });
  }

  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}
