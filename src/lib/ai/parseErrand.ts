/**
 * Client-side wrapper for the `parse-errand` Edge Function — turns one line the
 * user typed ("dentist at 18:00 at Pirktova") into a structured errand draft to
 * prefill the confirm drawer.
 *
 * Like the scheduler, this ALWAYS resolves to a usable draft: if Supabase isn't
 * configured, the function is down, or the model errors, we fall back to a local
 * regex heuristic so the drawer still opens with sensible prefilled fields. The
 * AI path is just the better extractor when it's available.
 */
import { isSupabaseConfigured, supabase } from '@/lib/supabase';
import { todayISO } from '@/utils/time';
import type { VenueOpeningHours } from '@/types/itinerary';

/** The fields the parser fills. `null` means "the user didn't say". */
export interface ErrandDraft {
  title: string;
  date: string | null;
  startTime: string | null;
  endTime: string | null;
  /**
   * Rough length in minutes, carried when re-opening an errand for editing so an
   * untimed "Anytime" errand's "how long" estimate survives the round-trip. The
   * AI never sets this (it only emits start/end); the drawer derives it.
   */
  durationMin?: number | null;
  address: string | null;
  /**
   * Resolved place data for `address`. The AI never sets these (it only reads
   * text) — they're carried when re-opening an already-located errand for
   * editing so the picked pin, photo, rating, and hours survive a round-trip.
   */
  latitude?: number | null;
  longitude?: number | null;
  placeId?: string | null;
  photoUrl?: string | null;
  rating?: number | null;
  ratingCount?: number | null;
  priceLevel?: number | null;
  openingHours?: VenueOpeningHours | null;
  notes: string | null;
}

interface ParseOptions {
  /** The user's "today" as YYYY-MM-DD, for resolving "tomorrow"/"friday". */
  date?: string;
}

export async function parseErrandRemote(
  text: string,
  options: ParseOptions = {},
): Promise<ErrandDraft> {
  const clean = text.trim();
  const today = options.date ?? todayISO();
  if (!clean) {
    return { title: '', date: null, startTime: null, endTime: null, address: null, notes: null };
  }

  if (isSupabaseConfigured && supabase) {
    try {
      const { data, error } = await supabase.functions.invoke('parse-errand', {
        body: { text: clean, date: today },
      });
      if (!error && data && typeof data === 'object' && !('error' in (data as object))) {
        const shaped = shapeRemote(data as Record<string, unknown>, clean);
        if (shaped) return shaped;
      }
    } catch (e) {
      console.warn('[parse-errand] request failed, using local parse', e);
    }
  }

  return localParseErrand(clean, today);
}

/** Validate the function's JSON into a strict ErrandDraft (defensive). */
function shapeRemote(data: Record<string, unknown>, rawText: string): ErrandDraft | null {
  const title =
    typeof data.title === 'string' && data.title.trim()
      ? data.title.trim()
      : rawText;
  const startTime = isHHMM(data.startTime) ? (data.startTime as string) : null;
  return {
    title,
    date: isISODate(data.date) ? (data.date as string) : null,
    startTime,
    endTime: startTime && isHHMM(data.endTime) ? (data.endTime as string) : null,
    address:
      typeof data.address === 'string' && data.address.trim()
        ? data.address.trim()
        : null,
    notes:
      typeof data.notes === 'string' && data.notes.trim() ? data.notes.trim() : null,
  };
}

// --------------------------------------------------------- local heuristic
//
// Best-effort offline extractor. Far less capable than the model, but enough to
// prefill the drawer with the obvious slots (a clock time, "today"/"tomorrow",
// an "at <place>" phrase) so the experience degrades gracefully rather than
// dumping the raw text into the title.

function isHHMM(v: unknown): v is string {
  return typeof v === 'string' && /^\d{1,2}:\d{2}$/.test(v.trim());
}

function isISODate(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.trim());
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function addDaysISO(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, (m || 1) - 1, d || 1);
  date.setDate(date.getDate() + days);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

const WEEKDAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
];

/** Rough duration (minutes) guess for an estimated end time, by keyword. */
function guessDurationMinutes(title: string): number {
  const t = title.toLowerCase();
  if (/\bcall|phone|ring\b/.test(t)) return 15;
  if (/\bcoffee|lunch|brunch|breakfast\b/.test(t)) return 45;
  if (/\bdentist|doctor|haircut|barber|meeting|gym|workout\b/.test(t)) return 60;
  return 30;
}

export function localParseErrand(text: string, today: string): ErrandDraft {
  let working = ` ${text.trim()} `;
  let date: string | null = null;
  let startTime: string | null = null;
  let address: string | null = null;

  // --- date ---
  if (/\btomorrow\b/i.test(working)) {
    date = addDaysISO(today, 1);
    working = working.replace(/\btomorrow\b/i, ' ');
  } else if (/\btoday\b/i.test(working)) {
    date = today;
    working = working.replace(/\btoday\b/i, ' ');
  } else {
    for (let i = 0; i < WEEKDAYS.length; i += 1) {
      const re = new RegExp(`\\b(?:on\\s+|this\\s+|next\\s+)?${WEEKDAYS[i]}\\b`, 'i');
      if (re.test(working)) {
        const todayDow = new Date(`${today}T00:00:00`).getDay();
        let delta = (i - todayDow + 7) % 7;
        if (delta === 0) delta = 7; // a named weekday means the upcoming one
        date = addDaysISO(today, delta);
        working = working.replace(re, ' ');
        break;
      }
    }
  }

  // --- time --- "18:00", "6pm", "6:30 pm", "at 6", "noon", "midnight"
  if (/\bnoon\b/i.test(working)) {
    startTime = '12:00';
    working = working.replace(/\bnoon\b/i, ' ');
  } else if (/\bmidnight\b/i.test(working)) {
    startTime = '00:00';
    working = working.replace(/\bmidnight\b/i, ' ');
  } else {
    const timeRe = /\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i;
    const m = working.match(timeRe);
    if (m) {
      let h = Number(m[1]);
      const min = m[2] ? Number(m[2]) : 0;
      const ampm = m[3]?.toLowerCase();
      const looksLikeTime =
        !!ampm || !!m[2] || /\bat\s+\d/i.test(m[0]) || (h >= 0 && h <= 23 && m[1].length <= 2);
      if (looksLikeTime && h <= 23 && min <= 59) {
        if (ampm === 'pm' && h < 12) h += 12;
        if (ampm === 'am' && h === 12) h = 0;
        startTime = `${pad2(h)}:${pad2(min)}`;
        working = working.replace(m[0], ' ');
      }
    }
  }

  // --- address --- a trailing "at/in <place>" once the time is removed.
  const addrRe = /\b(?:at|in|@)\s+(.+)$/i;
  const am = working.trim().match(addrRe);
  if (am && am[1].trim().length > 1) {
    address = am[1].trim().replace(/\s+/g, ' ');
    working = working.replace(addrRe, ' ');
  }

  // --- title --- whatever's left, cleaned up.
  let title = working.replace(/\s+/g, ' ').trim().replace(/[\s,.;:-]+$/g, '');
  title = title.length > 0 ? title.charAt(0).toUpperCase() + title.slice(1) : text.trim();

  const endTime = startTime
    ? minutesToHHMM(hhmmToMinutes(startTime) + guessDurationMinutes(title))
    : null;

  return { title, date, startTime, endTime, address, notes: null };
}

function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function minutesToHHMM(total: number): string {
  const wrapped = ((total % 1440) + 1440) % 1440;
  return `${pad2(Math.floor(wrapped / 60))}:${pad2(wrapped % 60)}`;
}
