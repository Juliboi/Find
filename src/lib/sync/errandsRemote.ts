/**
 * Supabase read/write helpers for errands — the network half of the errands
 * store's local-first sync.
 *
 * These are intentionally dumb and decoupled: they take the owning `userId`
 * explicitly (rather than importing the auth store) so there's no import cycle
 * between the store, the sync layer, and auth. Every call no-ops gracefully
 * when Supabase isn't configured, so the app stays fully usable offline / in a
 * pure-local dev build — exactly as it did before sync existed.
 *
 * Writes are fire-and-forget from the caller's perspective: the local store is
 * the optimistic source of truth, and a failed push just means the row syncs on
 * the next successful pull/flush instead of blocking the UI.
 */
import { isSupabaseConfigured, supabase } from '@/lib/supabase';
import type { Errand, TravelPref } from '@/store/useErrandsStore';
import type { VenueOpeningHours } from '@/types/itinerary';

const TABLE = 'errands';

interface ErrandRow {
  id: string;
  user_id: string;
  title: string;
  start_time: string | null;
  end_time: string | null;
  duration_min: number | null;
  date: string | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  place_id: string | null;
  photo_url: string | null;
  rating: number | null;
  rating_count: number | null;
  price_level: number | null;
  opening_hours: VenueOpeningHours | null;
  travel_mode: string | null;
  notes: string | null;
  raw_text: string;
  planned_date: string | null;
  recurring_id: string | null;
  done: boolean;
  created_at: string;
  updated_at: string;
}

function rowToErrand(r: ErrandRow): Errand {
  return {
    id: r.id,
    title: r.title,
    startTime: r.start_time ?? undefined,
    endTime: r.end_time ?? undefined,
    durationMin: r.duration_min ?? undefined,
    date: r.date ?? undefined,
    address: r.address ?? undefined,
    latitude: r.latitude ?? undefined,
    longitude: r.longitude ?? undefined,
    placeId: r.place_id ?? undefined,
    photoUrl: r.photo_url ?? undefined,
    rating: r.rating ?? undefined,
    ratingCount: r.rating_count ?? undefined,
    priceLevel: r.price_level ?? undefined,
    openingHours: r.opening_hours ?? undefined,
    travelMode:
      r.travel_mode === 'commute' || r.travel_mode === 'car'
        ? (r.travel_mode as TravelPref)
        : undefined,
    notes: r.notes ?? undefined,
    rawText: r.raw_text ?? '',
    plannedDate: r.planned_date ?? undefined,
    recurringId: r.recurring_id ?? undefined,
    done: !!r.done,
    createdAt: r.created_at ? Date.parse(r.created_at) : Date.now(),
    updatedAt: r.updated_at ? Date.parse(r.updated_at) : Date.now(),
  };
}

function errandToRow(e: Errand, userId: string): ErrandRow {
  return {
    id: e.id,
    user_id: userId,
    title: e.title,
    start_time: e.startTime ?? null,
    end_time: e.endTime ?? null,
    duration_min: e.durationMin ?? null,
    date: e.date ?? null,
    address: e.address ?? null,
    latitude: e.latitude ?? null,
    longitude: e.longitude ?? null,
    place_id: e.placeId ?? null,
    photo_url: e.photoUrl ?? null,
    rating: e.rating ?? null,
    rating_count: e.ratingCount ?? null,
    price_level: e.priceLevel ?? null,
    opening_hours: e.openingHours ?? null,
    travel_mode: e.travelMode ?? null,
    notes: e.notes ?? null,
    raw_text: e.rawText ?? '',
    planned_date: e.plannedDate ?? null,
    recurring_id: e.recurringId ?? null,
    done: e.done,
    created_at: new Date(e.createdAt).toISOString(),
    updated_at: new Date(e.updatedAt).toISOString(),
  };
}

/** Fetch every errand for `userId`. Returns null when sync is unavailable (so
 * the caller knows to keep the local cache rather than wipe it to empty). */
export async function pullErrands(userId: string): Promise<Errand[] | null> {
  if (!isSupabaseConfigured || !supabase) return null;
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .eq('user_id', userId);
  if (error) {
    console.warn('[errands-sync] pull failed', error.message);
    return null;
  }
  return (data as ErrandRow[]).map(rowToErrand);
}

/**
 * Upsert errand rows, tolerating a server that predates the `travel_mode` column
 * (migration 0013). If the upsert is rejected because that column is missing, we
 * strip it and retry ONCE so the rest of the row still syncs — the preference
 * just stays local until the migration lands, after which full rows sync with no
 * code change. Fire-and-forget; never throws.
 */
function upsertErrandRows(rows: ErrandRow[]): void {
  if (!supabase || rows.length === 0) return;
  void supabase
    .from(TABLE)
    .upsert(rows)
    .then(({ error }) => {
      if (!error) return;
      const msg = `${error.message ?? ''} ${(error as { details?: string }).details ?? ''}`;
      if (msg.toLowerCase().includes('travel_mode')) {
        const stripped = rows.map((r) => {
          const rest = { ...r } as Partial<ErrandRow>;
          delete rest.travel_mode;
          return rest;
        });
        void supabase!
          .from(TABLE)
          .upsert(stripped)
          .then(({ error: retryError }) => {
            if (retryError) console.warn('[errands-sync] push failed', retryError.message);
          });
        return;
      }
      console.warn('[errands-sync] push failed', error.message);
    });
}

/** Upsert one errand. Fire-and-forget — never throws. */
export function pushErrand(errand: Errand, userId: string): void {
  if (!isSupabaseConfigured || !supabase) return;
  upsertErrandRows([errandToRow(errand, userId)]);
}

/** Upsert many errands in one round-trip (used to flush local-only rows). */
export function pushErrands(errands: Errand[], userId: string): void {
  if (!isSupabaseConfigured || !supabase || errands.length === 0) return;
  upsertErrandRows(errands.map((e) => errandToRow(e, userId)));
}

/** Delete one errand by id. Fire-and-forget — never throws. */
export function deleteErrandRemote(id: string): void {
  if (!isSupabaseConfigured || !supabase) return;
  void supabase
    .from(TABLE)
    .delete()
    .eq('id', id)
    .then(({ error }) => {
      if (error) console.warn('[errands-sync] delete failed', error.message);
    });
}
