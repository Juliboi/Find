/**
 * Supabase read/write helpers for recurring errands (templates) — the network
 * half of the recurring store's local-first sync.
 *
 * Same dumb, decoupled, fire-and-forget contract as `errandsRemote.ts`: the
 * owning `userId` is passed in, and every call no-ops gracefully when Supabase
 * isn't configured so the app stays usable offline.
 */
import { isSupabaseConfigured, supabase } from '@/lib/supabase';
import type { RecurringErrand } from '@/store/useRecurringErrandsStore';
import type { TravelPref } from '@/store/useErrandsStore';

const TABLE = 'recurring_errands';

interface RecurringErrandRow {
  id: string;
  user_id: string;
  title: string;
  weekdays: number[] | null;
  start_time: string | null;
  end_time: string | null;
  duration_min: number | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  place_id: string | null;
  travel_mode: string | null;
  notes: string | null;
  skipped_dates: string[] | null;
  created_at: string;
  updated_at: string;
}

function rowToRecurring(r: RecurringErrandRow): RecurringErrand {
  return {
    id: r.id,
    title: r.title,
    weekdays: Array.isArray(r.weekdays) ? r.weekdays : [],
    startTime: r.start_time ?? undefined,
    endTime: r.end_time ?? undefined,
    durationMin: r.duration_min ?? undefined,
    address: r.address ?? undefined,
    latitude: r.latitude ?? undefined,
    longitude: r.longitude ?? undefined,
    placeId: r.place_id ?? undefined,
    travelMode:
      r.travel_mode === 'commute' || r.travel_mode === 'car'
        ? (r.travel_mode as TravelPref)
        : undefined,
    notes: r.notes ?? undefined,
    skippedDates: Array.isArray(r.skipped_dates) ? r.skipped_dates : [],
    createdAt: r.created_at ? Date.parse(r.created_at) : Date.now(),
    updatedAt: r.updated_at ? Date.parse(r.updated_at) : Date.now(),
  };
}

function recurringToRow(e: RecurringErrand, userId: string): RecurringErrandRow {
  return {
    id: e.id,
    user_id: userId,
    title: e.title,
    weekdays: e.weekdays ?? [],
    start_time: e.startTime ?? null,
    end_time: e.endTime ?? null,
    duration_min: e.durationMin ?? null,
    address: e.address ?? null,
    latitude: e.latitude ?? null,
    longitude: e.longitude ?? null,
    place_id: e.placeId ?? null,
    travel_mode: e.travelMode ?? null,
    notes: e.notes ?? null,
    skipped_dates: e.skippedDates ?? [],
    created_at: new Date(e.createdAt).toISOString(),
    updated_at: new Date(e.updatedAt).toISOString(),
  };
}

/** Fetch every recurring errand for `userId`. Returns null when sync is
 * unavailable (so the caller keeps the local cache rather than wiping it). */
export async function pullRecurringErrands(
  userId: string,
): Promise<RecurringErrand[] | null> {
  if (!isSupabaseConfigured || !supabase) return null;
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .eq('user_id', userId);
  if (error) {
    console.warn('[recurring-sync] pull failed', error.message);
    return null;
  }
  return (data as RecurringErrandRow[]).map(rowToRecurring);
}

/**
 * Upsert recurring rows, tolerating a server that predates the `travel_mode`
 * column (migration 0013): on a missing-column rejection, strip it and retry
 * ONCE so the rest of the row still syncs. Fire-and-forget; never throws.
 */
function upsertRecurringRows(rows: RecurringErrandRow[]): void {
  if (!supabase || rows.length === 0) return;
  void supabase
    .from(TABLE)
    .upsert(rows)
    .then(({ error }) => {
      if (!error) return;
      const msg = `${error.message ?? ''} ${(error as { details?: string }).details ?? ''}`;
      if (msg.toLowerCase().includes('travel_mode')) {
        const stripped = rows.map((r) => {
          const rest = { ...r } as Partial<RecurringErrandRow>;
          delete rest.travel_mode;
          return rest;
        });
        void supabase!
          .from(TABLE)
          .upsert(stripped)
          .then(({ error: retryError }) => {
            if (retryError) console.warn('[recurring-sync] push failed', retryError.message);
          });
        return;
      }
      console.warn('[recurring-sync] push failed', error.message);
    });
}

/** Upsert one recurring errand. Fire-and-forget — never throws. */
export function pushRecurringErrand(errand: RecurringErrand, userId: string): void {
  if (!isSupabaseConfigured || !supabase) return;
  upsertRecurringRows([recurringToRow(errand, userId)]);
}

/** Upsert many recurring errands in one round-trip (flush local-only rows). */
export function pushRecurringErrands(
  errands: RecurringErrand[],
  userId: string,
): void {
  if (!isSupabaseConfigured || !supabase || errands.length === 0) return;
  upsertRecurringRows(errands.map((e) => recurringToRow(e, userId)));
}

/** Delete one recurring errand by id. Fire-and-forget — never throws. */
export function deleteRecurringErrandRemote(id: string): void {
  if (!isSupabaseConfigured || !supabase) return;
  void supabase
    .from(TABLE)
    .delete()
    .eq('id', id)
    .then(({ error }) => {
      if (error) console.warn('[recurring-sync] delete failed', error.message);
    });
}
