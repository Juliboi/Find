/**
 * Local-first interpreter for the floating "adjust your day" input.
 *
 * It recognizes the handful of edits people ask for most — make something
 * longer/shorter, give it N more/less minutes, remove/skip it, move it to a
 * time — and turns them into an `EditOp` that applies INSTANTLY on-device.
 *
 * For anything it doesn't confidently understand, it returns `kind: 'replan'`
 * — which the caller treats as "I'm unsure", NOT as a green light to wipe the
 * day. The screen then asks the `adjust-itinerary` edge function for a small
 * op batch, and only if THAT also comes back empty does it surface an explicit
 * "Ask the planner →" chip the user has to tap to trigger a heavy replan.
 *
 * This is intentionally conservative: a wrong local guess is worse than
 * deferring upstream, so we only match when both the intent AND a target
 * block are clear.
 */

import { Itinerary, ItineraryItem } from '@/types/itinerary';
import { EditOp } from './edits';
import { flatten } from './edits';
import { minutesOfDay } from '@/utils/time';

/** Lowercased word set of a string, for cheap fuzzy matching. */
function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'add', 'make', 'more', 'less', 'time', 'min',
  'mins', 'minute', 'minutes', 'hour', 'hours', 'longer', 'shorter', 'remove',
  'skip', 'delete', 'drop', 'cancel', 'move', 'change', 'spend', 'need', 'give',
  'take', 'takes', 'want', 'set', 'this', 'that', 'now', 'later', 'earlier',
  'about', 'around', 'some', 'extra', 'bit', 'little', 'reduce', 'cut', 'have',
]);

/**
 * Finds the itinerary block the user is referring to by overlapping their
 * words with each block's title/place name. Returns null when nothing is a
 * clear match (so we don't act on a guess).
 */
function findTarget(itin: Itinerary, text: string): ItineraryItem | null {
  const words = tokens(text).filter((w) => !STOPWORDS.has(w));
  if (words.length === 0) return null;
  let best: { item: ItineraryItem; score: number } | null = null;
  for (const item of flatten(itin)) {
    const hay = `${item.title} ${item.place?.name ?? ''} ${item.place?.category ?? ''} ${item.kind}`;
    const hayTokens = new Set(tokens(hay));
    let score = 0;
    for (const w of words) if (hayTokens.has(w)) score += 1;
    if (score > 0 && (!best || score > best.score)) best = { item, score };
  }
  return best ? best.item : null;
}

/** Parses "90", "1h", "1h30", "45 min", "1 hour 30" into minutes. */
function parseMinutes(text: string): number | null {
  const hm = text.match(/(\d+)\s*h(?:ours?|rs?)?\s*(\d+)?/i);
  if (hm) {
    const h = Number(hm[1]);
    const m = hm[2] ? Number(hm[2]) : 0;
    return h * 60 + m;
  }
  const m = text.match(/(\d+)\s*(?:m|min|mins|minute|minutes)?\b/i);
  if (m) return Number(m[1]);
  return null;
}

/** Parses a clock time like "8pm", "20:00", "8:30 pm" into "HH:MM". */
function parseClock(text: string): string | null {
  const m = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ap = m[3]?.toLowerCase();
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

export type ParseResult =
  | { kind: 'op'; op: EditOp }
  | { kind: 'replan' }
  | { kind: 'empty' };

/**
 * Interprets free text against the current itinerary. Returns an `op` for a
 * confident local edit, `replan` to defer to the AI, or `empty` for blank input.
 */
export function parseAdjustCommand(itin: Itinerary, raw: string): ParseResult {
  const text = raw.trim();
  if (!text) return { kind: 'empty' };
  const lower = text.toLowerCase();

  const target = findTarget(itin, text);

  // Remove / skip / cancel a block.
  if (/\b(remove|skip|delete|drop|cancel)\b/.test(lower)) {
    if (target) return { kind: 'op', op: { type: 'remove', id: target.id } };
    return { kind: 'replan' };
  }

  // Move to a specific time ("move lunch to 1pm", "start dinner at 20:00").
  if (/\b(move|start|begin|push|shift|at)\b/.test(lower) && /\d/.test(lower)) {
    const clock = parseClock(lower);
    if (target && clock) return { kind: 'op', op: { type: 'moveTime', id: target.id, hhmm: clock } };
  }

  // Relative time nudges: "+20 min", "20 more minutes", "give it more time",
  // "make it longer/shorter", "an hour less".
  const wantsMore = /\b(more|longer|extend|extra|add)\b/.test(lower) || /\+/.test(text);
  const wantsLess = /\b(less|shorter|reduce|cut|shorten|trim)\b/.test(lower) || /-/.test(text);
  if (target && (wantsMore || wantsLess)) {
    const mins = parseMinutes(lower);
    const magnitude = mins ?? 30; // default nudge when unspecified
    const delta = wantsLess ? -magnitude : magnitude;
    return { kind: 'op', op: { type: 'adjustDuration', id: target.id, deltaMin: delta } };
  }

  // Absolute duration: "spend 2h at the museum", "make lunch 45 min".
  if (target && /\b(spend|make|set|need)\b/.test(lower) && /\d/.test(lower)) {
    const mins = parseMinutes(lower);
    if (mins && mins >= 5) return { kind: 'op', op: { type: 'setDuration', id: target.id, minutes: mins } };
  }

  // Bare "<block> 2h" with a clear target and a duration.
  if (target && /\d/.test(lower)) {
    const clock = parseClock(lower);
    const mins = parseMinutes(lower);
    // Prefer a duration reading unless it really looks like a clock time.
    if (mins && mins >= 5 && !(clock && minutesOfDay(clock) === mins)) {
      return { kind: 'op', op: { type: 'setDuration', id: target.id, minutes: mins } };
    }
  }

  // Anything else (add new things, vibe changes, "make it more relaxed") goes
  // to the model.
  return { kind: 'replan' };
}
