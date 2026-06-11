/**
 * Supabase read/write helpers for saved itineraries — the network half of the
 * saved-itineraries store's local-first sync. Mirrors `errandsRemote.ts`: dumb,
 * decoupled (takes `userId` explicitly), and a graceful no-op when Supabase
 * isn't configured. The full `Itinerary` rides along as a JSONB blob so a saved
 * day re-opens with everything intact.
 */
import { isSupabaseConfigured, supabase } from '@/lib/supabase';
import type { Itinerary } from '@/types/itinerary';
import type { SavedItinerary } from '@/store/useSavedItineraries';

const TABLE = 'itineraries';

interface ItineraryRow {
  id: string;
  user_id: string;
  title: string;
  date: string | null;
  origin: string | null;
  city: string | null;
  stop_count: number;
  thumb_url: string | null;
  is_active: boolean;
  itinerary: Itinerary;
  created_at: string;
  updated_at: string;
}

function rowToSaved(r: ItineraryRow): SavedItinerary {
  return {
    id: r.id,
    title: r.title,
    date: r.date ?? undefined,
    origin: r.origin ?? undefined,
    city: r.city ?? undefined,
    stopCount: r.stop_count ?? 0,
    thumbUrl: r.thumb_url ?? undefined,
    isActive: r.is_active ?? false,
    itinerary: r.itinerary,
    createdAt: r.created_at ? Date.parse(r.created_at) : Date.now(),
    updatedAt: r.updated_at ? Date.parse(r.updated_at) : Date.now(),
  };
}

function savedToRow(s: SavedItinerary, userId: string): ItineraryRow {
  return {
    id: s.id,
    user_id: userId,
    title: s.title,
    date: s.date ?? null,
    origin: s.origin ?? null,
    city: s.city ?? null,
    stop_count: s.stopCount ?? 0,
    thumb_url: s.thumbUrl ?? null,
    is_active: s.isActive ?? false,
    itinerary: s.itinerary,
    created_at: new Date(s.createdAt).toISOString(),
    updated_at: new Date(s.updatedAt ?? s.createdAt).toISOString(),
  };
}

/** Fetch every saved itinerary for `userId`. Null when sync is unavailable. */
export async function pullItineraries(userId: string): Promise<SavedItinerary[] | null> {
  if (!isSupabaseConfigured || !supabase) return null;
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .eq('user_id', userId);
  if (error) {
    console.warn('[itineraries-sync] pull failed', error.message);
    return null;
  }
  return (data as ItineraryRow[]).map(rowToSaved);
}

/** Upsert one saved itinerary. Fire-and-forget — never throws. */
export function pushItinerary(saved: SavedItinerary, userId: string): void {
  if (!isSupabaseConfigured || !supabase) return;
  void supabase
    .from(TABLE)
    .upsert(savedToRow(saved, userId))
    .then(({ error }) => {
      if (error) console.warn('[itineraries-sync] push failed', error.message);
    });
}

/** Upsert many saved itineraries in one round-trip (flush local-only rows). */
export function pushItineraries(items: SavedItinerary[], userId: string): void {
  if (!isSupabaseConfigured || !supabase || items.length === 0) return;
  void supabase
    .from(TABLE)
    .upsert(items.map((s) => savedToRow(s, userId)))
    .then(({ error }) => {
      if (error) console.warn('[itineraries-sync] bulk push failed', error.message);
    });
}

/** Delete one saved itinerary by id. Fire-and-forget — never throws. */
export function deleteItineraryRemote(id: string): void {
  if (!isSupabaseConfigured || !supabase) return;
  void supabase
    .from(TABLE)
    .delete()
    .eq('id', id)
    .then(({ error }) => {
      if (error) console.warn('[itineraries-sync] delete failed', error.message);
    });
}
