/**
 * Localized place-search vocabulary expansion.
 *
 * Google Places Text Search keys hard off the EXACT category word, and the
 * right word is locale-specific. In Czech (the user's locale) the English
 * "drugstore" / "household goods" resolves to *lékárna* — a medicine PHARMACY —
 * NOT *drogerie* (dm / Teta / Rossmann), the household shops that actually stock
 * cleaning products like Domestos. So a bare "drugstore" search returns far-away
 * pharmacies and misses the drogerie next door (the bug the user hit when
 * picking a spot for "buy domestos").
 *
 * We expand such a query into the variants that DO surface the right shops and
 * let the provider's multi-query fan-out + proximity ranking pick the closest.
 * Conservative: a query we don't recognise passes straight through as a single
 * variant, so this never changes behaviour for ordinary searches.
 *
 * Keep this in sync with the mirror in `supabase/functions/find-places`
 * (`expandLocalizedQueries`) — the edge function applies the same expansion so
 * any caller benefits even when the client didn't pre-expand.
 */

/** A HOUSEHOLD / drogerie need: cleaning supplies, toiletries, cosmetics —
 *  sold at a drogerie or supermarket, never a medicine pharmacy (lékárna). */
const DROGERIE_RE =
  /\b(drugstore|drogerie|household\s*(?:goods|cleaning|supplies)?|cleaning\s*(?:supplies|products|stuff)|toiletr(?:y|ies)|cosmetics?)\b/i;

/** A specific cleaning/household PRODUCT, in case the raw product word reaches
 *  the search instead of a category ("buy domestos" → drogerie run). */
const HOUSEHOLD_PRODUCT_RE =
  /\b(domestos|savo|bleach|detergent|washing\s*(?:powder|liquid|tablets|gel)|fabric\s*softener|laundry\s*(?:detergent|gel|pods|powder)|dish(?:washer)?\s*(?:soap|tablets|gel|liquid)|toilet\s*paper|paper\s*towels|shampoo|toothpaste|deodorant|sponges?)\b/i;

/** The variants that actually surface dm / Teta / Rossmann (and a supermarket
 *  fallback, which also stocks these products). Ordered best-first. */
const DROGERIE_VARIANTS = [
  'drogerie',
  'dm drogerie',
  'Teta drogerie',
  'Rossmann drogerie',
  'supermarket',
];

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const it of items) {
    const q = it.trim();
    if (!q) continue;
    const k = q.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(q);
  }
  return out;
}

/**
 * Expands one search query into the variants to send to the places provider.
 * Returns the localized drogerie variants for a household/drugstore need;
 * otherwise just the original query (or `[]` for empty input).
 */
export function expandPlaceQuery(raw: string): string[] {
  const q = (raw ?? '').trim();
  if (!q) return [];
  if (DROGERIE_RE.test(q) || HOUSEHOLD_PRODUCT_RE.test(q)) {
    return dedupe(DROGERIE_VARIANTS);
  }
  return [q];
}

/** True when a query reads as an everyday/local need that should be searched
 *  with tight proximity (used to keep the result near home/the anchor). */
export function isEverydayPlaceQuery(raw: string): boolean {
  return DROGERIE_RE.test(raw) || HOUSEHOLD_PRODUCT_RE.test(raw);
}
