/**
 * Supabase read/write helpers for people (contacts) — the network half of the
 * people store's local-first sync.
 *
 * Same shape and contract as `errandsRemote.ts`: dumb, decoupled (the owning
 * `userId` is passed in, not imported), and every call no-ops gracefully when
 * Supabase isn't configured so the app stays fully usable offline. Writes are
 * fire-and-forget — the local store is the optimistic source of truth.
 */
import { isSupabaseConfigured, supabase } from '@/lib/supabase';
import type { Person } from '@/store/usePeopleStore';

const TABLE = 'people';

interface PersonRow {
  id: string;
  user_id: string;
  name: string;
  nicknames: string[] | null;
  place_label: string | null;
  place_latitude: number | null;
  place_longitude: number | null;
  place_id: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

function rowToPerson(r: PersonRow): Person {
  const label = r.place_label ?? undefined;
  return {
    id: r.id,
    name: r.name,
    nicknames: Array.isArray(r.nicknames) ? r.nicknames : [],
    place: label
      ? {
          label,
          latitude: r.place_latitude ?? undefined,
          longitude: r.place_longitude ?? undefined,
          placeId: r.place_id ?? undefined,
        }
      : null,
    notes: r.notes ?? undefined,
    createdAt: r.created_at ? Date.parse(r.created_at) : Date.now(),
    updatedAt: r.updated_at ? Date.parse(r.updated_at) : Date.now(),
  };
}

function personToRow(p: Person, userId: string): PersonRow {
  return {
    id: p.id,
    user_id: userId,
    name: p.name,
    nicknames: p.nicknames ?? [],
    place_label: p.place?.label ?? null,
    place_latitude: p.place?.latitude ?? null,
    place_longitude: p.place?.longitude ?? null,
    place_id: p.place?.placeId ?? null,
    notes: p.notes ?? null,
    created_at: new Date(p.createdAt).toISOString(),
    updated_at: new Date(p.updatedAt).toISOString(),
  };
}

/** Fetch every person for `userId`. Returns null when sync is unavailable (so
 * the caller keeps the local cache rather than wiping it to empty). */
export async function pullPeople(userId: string): Promise<Person[] | null> {
  if (!isSupabaseConfigured || !supabase) return null;
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .eq('user_id', userId);
  if (error) {
    console.warn('[people-sync] pull failed', error.message);
    return null;
  }
  return (data as PersonRow[]).map(rowToPerson);
}

/** Upsert one person. Fire-and-forget — never throws. */
export function pushPerson(person: Person, userId: string): void {
  if (!isSupabaseConfigured || !supabase) return;
  void supabase
    .from(TABLE)
    .upsert(personToRow(person, userId))
    .then(({ error }) => {
      if (error) console.warn('[people-sync] push failed', error.message);
    });
}

/** Upsert many people in one round-trip (used to flush local-only rows). */
export function pushPeople(people: Person[], userId: string): void {
  if (!isSupabaseConfigured || !supabase || people.length === 0) return;
  void supabase
    .from(TABLE)
    .upsert(people.map((p) => personToRow(p, userId)))
    .then(({ error }) => {
      if (error) console.warn('[people-sync] bulk push failed', error.message);
    });
}

/** Delete one person by id. Fire-and-forget — never throws. */
export function deletePersonRemote(id: string): void {
  if (!isSupabaseConfigured || !supabase) return;
  void supabase
    .from(TABLE)
    .delete()
    .eq('id', id)
    .then(({ error }) => {
      if (error) console.warn('[people-sync] delete failed', error.message);
    });
}
