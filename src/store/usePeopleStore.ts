import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { uid } from '@/utils/id';
import {
  deletePersonRemote,
  pullPeople,
  pushPeople,
  pushPerson,
} from '@/lib/sync/peopleRemote';

/**
 * A saved person (contact). Carries a few nicknames and ONE fixed place — the
 * home/flat/spot the errand parser uses when the user writes a possessive
 * ("chill at Ondra's place") but NOT when the person is only a companion
 * ("cinema with Ondra", "call Ondra"). Stored locally-first (AsyncStorage) and
 * synced through Supabase, exactly like errands.
 */
export interface PersonPlace {
  /** Human-readable place label, e.g. "Pařížská 30, Praha". */
  label: string;
  /** Coordinates, present once a real place was picked from search. */
  latitude?: number;
  longitude?: number;
  placeId?: string;
}

export interface Person {
  id: string;
  /** Primary name, e.g. "Ondra". */
  name: string;
  /** Extra aliases the user answers to. Matched alongside `name`. */
  nicknames: string[];
  /** The person's ONE fixed place, or null if none saved. */
  place: PersonPlace | null;
  notes?: string;
  createdAt: number;
  updatedAt: number;
}

/** The editable fields of a person — what the editor collects before saving. */
export type PersonInput = Pick<Person, 'name' | 'nicknames' | 'place' | 'notes'>;

interface PeopleState {
  items: Person[];
  /** The auth user this local cache belongs to (see errands store for why). */
  ownerId: string | null;
  add: (input: PersonInput) => string;
  update: (id: string, patch: Partial<PersonInput>) => void;
  remove: (id: string) => void;
  syncFromRemote: (userId: string) => Promise<void>;
  reset: () => void;
}

const MAX_PEOPLE = 200;

function clean(value: string | undefined | null): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function numOrUndef(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Trim + dedupe nicknames, dropping blanks. */
function cleanNicknames(list: string[] | undefined | null): string[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const v = clean(raw);
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

/** Keep a place only when it has a usable label; coords only if finite. */
function cleanPlace(place: PersonPlace | null | undefined): PersonPlace | null {
  const label = clean(place?.label);
  if (!label) return null;
  return {
    label,
    latitude: numOrUndef(place?.latitude),
    longitude: numOrUndef(place?.longitude),
    placeId: clean(place?.placeId),
  };
}

function normalizeInput(input: PersonInput): PersonInput {
  return {
    name: clean(input.name) ?? 'Someone',
    nicknames: cleanNicknames(input.nicknames),
    place: cleanPlace(input.place),
    notes: clean(input.notes),
  };
}

/** Union by id, keeping whichever copy was touched most recently. */
function mergePeople(local: Person[], remote: Person[]): Person[] {
  const byId = new Map<string, Person>();
  for (const p of local) byId.set(p.id, p);
  for (const r of remote) {
    const l = byId.get(r.id);
    if (!l || r.updatedAt >= l.updatedAt) byId.set(r.id, r);
  }
  return [...byId.values()].slice(0, MAX_PEOPLE);
}

export const usePeopleStore = create<PeopleState>()(
  persist(
    (set, get) => ({
      items: [],
      ownerId: null,
      add: (input) => {
        const id = uid('person');
        const now = Date.now();
        const entry: Person = {
          id,
          ...normalizeInput(input),
          createdAt: now,
          updatedAt: now,
        };
        set((state) => ({ items: [entry, ...state.items].slice(0, MAX_PEOPLE) }));
        const owner = get().ownerId;
        if (owner) pushPerson(entry, owner);
        return id;
      },
      update: (id, patch) => {
        set((state) => ({
          items: state.items.map((p) => {
            if (p.id !== id) return p;
            const next: Person = { ...p, updatedAt: Date.now() };
            if ('name' in patch) next.name = clean(patch.name) ?? p.name;
            if ('nicknames' in patch) next.nicknames = cleanNicknames(patch.nicknames);
            if ('place' in patch) next.place = cleanPlace(patch.place);
            if ('notes' in patch) next.notes = clean(patch.notes);
            return next;
          }),
        }));
        const owner = get().ownerId;
        const updated = get().items.find((p) => p.id === id);
        if (owner && updated) pushPerson(updated, owner);
      },
      remove: (id) => {
        set((state) => ({ items: state.items.filter((p) => p.id !== id) }));
        if (get().ownerId) deletePersonRemote(id);
      },
      syncFromRemote: async (userId) => {
        const remote = await pullPeople(userId);
        if (!remote) return; // offline / not configured — keep local untouched
        const sameUser = get().ownerId === userId;
        if (sameUser) {
          set((state) => ({ items: mergePeople(state.items, remote), ownerId: userId }));
          const remoteIds = new Set(remote.map((p) => p.id));
          const localOnly = get().items.filter((p) => !remoteIds.has(p.id));
          if (localOnly.length) pushPeople(localOnly, userId);
        } else {
          set({ items: remote.slice(0, MAX_PEOPLE), ownerId: userId });
        }
      },
      reset: () => set({ items: [], ownerId: null }),
    }),
    {
      name: 'dayflow.people.v1',
      version: 1,
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
);

/** Every label a person answers to (name + nicknames), lowercased + trimmed. */
export function personAliases(person: Person): string[] {
  return [person.name, ...person.nicknames]
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}
