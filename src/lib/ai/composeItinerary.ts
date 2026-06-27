/**
 * Client-side wrapper for the `compose-itinerary` Edge Function — the UNIFIED
 * planning brain (v3). It replaces the two-pass `decompose-intent` +
 * `plan-itinerary` generation with ONE structured call that receives the whole
 * merged picture (located anchors + unplaced/at-home tasks + free text +
 * onboarding rhythm + day frame) and emits a single ORDERED list of day blocks,
 * each carrying a PLACEMENT INTENT (anchor / colocate / find / venue / home)
 * rather than a final venue.
 *
 * Venue truth (Google Places) and the per-minute clock (routing) are resolved
 * DETERMINISTICALLY downstream — see {@link assembleComposedDay}. Like the other
 * AI wrappers this ALWAYS resolves: on any failure it returns an EMPTY block
 * list so the caller can fall back to the legacy decompose+plan pipeline.
 */
import { isSupabaseConfigured, supabase } from '@/lib/supabase';
import { todayISO } from '@/utils/time';
import { logTokenUsage, shapeUsage, type LlmTokenUsage } from '@/lib/usage';

/** How a composed block gets a location. */
export type ComposePlacement = 'anchor' | 'colocate' | 'find' | 'venue' | 'home';

/** One ordered block of the day the brain produced. */
export interface ComposedBlock {
  title: string;
  kind: string;
  flexibility: 'fixed' | 'window' | 'flexible';
  /** Catchy headline used to group consecutive blocks into a section. */
  section: string | null;
  period: 'Morning' | 'Afternoon' | 'Evening' | null;
  /** Only when the user PINNED a clock time; else null (router lays the clock). */
  startTime: string | null;
  endTime: string | null;
  durationMin: number | null;
  description: string | null;
  placement: ComposePlacement;
  /** placement "anchor"/"colocate": the source errand / host stop id. */
  anchorId: string | null;
  /** The source task this block fulfils (carries its pinned time). */
  taskId: string | null;
  /** placement "find": a neighbourhood-aware search ("Max Fitness gym, Karlín"). */
  findQuery: string | null;
  /** The area the brain clustered this into ("Karlín"), when known. */
  area: string | null;
  /** placement "venue": the venue the user named, VERBATIM. */
  userQuery: string | null;
}

/** A located stop handed to the brain as fixed geography to cluster around. */
export interface ComposeAnchorInput {
  id: string;
  title: string;
  name?: string;
  latitude?: number;
  longitude?: number;
  startTime?: string;
  endTime?: string;
  durationMin?: number;
  notes?: string;
  locationType?: 'business' | 'residence';
}

/** An unplaced errand / commitment the brain schedules and positions. */
export interface ComposeTaskInput {
  id: string;
  title: string;
  startTime?: string;
  endTime?: string;
  durationMin?: number;
  notes?: string;
  /** At-home / online (a call, telehealth, remote work) — no physical venue. */
  atHome?: boolean;
}

export interface ComposeInput {
  intent: string;
  anchors?: ComposeAnchorInput[];
  tasks?: ComposeTaskInput[];
  dayStart?: { time?: string; label?: string };
  dayEnd?: { time?: string; label?: string };
  /** Full profile context (the `buildContextPayload` output). */
  context?: Record<string, unknown>;
  home?: { label?: string; latitude?: number; longitude?: number };
  date?: string;
  /** "HH:MM" current local time — pass ONLY when the day being planned is today
   *  and already underway, so the brain plans the remainder and skips morning. */
  now?: string;
}

export interface ComposeResult {
  blocks: ComposedBlock[];
  title: string;
  summary: string;
  city: string;
  usage?: LlmTokenUsage | null;
}

const PLACEMENTS: ComposePlacement[] = ['anchor', 'colocate', 'find', 'venue', 'home'];

function isHHMM(v: unknown): v is string {
  return typeof v === 'string' && /^\d{1,2}:\d{2}$/.test(v.trim());
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}
function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/**
 * Re-validate the function's blocks into strict {@link ComposedBlock}s. The
 * server already shapes these, but we re-validate defensively (a server bug or
 * an old deploy must never feed the assembler a malformed block) and keep the
 * same placement-consistency invariants the assembler relies on.
 */
export function shapeBlocks(raw: unknown, anchorIds: Set<string>): ComposedBlock[] {
  if (!Array.isArray(raw)) return [];
  const out: ComposedBlock[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const rec = r as Record<string, unknown>;
    const title = str(rec.title);
    if (!title) continue;

    let placement: ComposePlacement = PLACEMENTS.includes(rec.placement as ComposePlacement)
      ? (rec.placement as ComposePlacement)
      : 'home';
    let anchorId = str(rec.anchorId);
    let findQuery = str(rec.findQuery);
    let userQuery = str(rec.userQuery);

    if ((placement === 'anchor' || placement === 'colocate') && (!anchorId || !anchorIds.has(anchorId))) {
      placement = findQuery ? 'find' : userQuery ? 'venue' : 'home';
      anchorId = null;
    }
    if (placement === 'find' && !findQuery) placement = userQuery ? 'venue' : 'home';
    if (placement === 'venue' && !userQuery) placement = findQuery ? 'find' : 'home';
    if (placement !== 'find') findQuery = null;
    if (placement !== 'venue') userQuery = null;
    if (placement !== 'anchor' && placement !== 'colocate') anchorId = null;

    const startTime = isHHMM(rec.startTime) ? (rec.startTime as string).trim() : null;
    const endTime = startTime && isHHMM(rec.endTime) ? (rec.endTime as string).trim() : null;

    out.push({
      title: title.slice(0, 120),
      kind: str(rec.kind) ?? 'other',
      flexibility:
        rec.flexibility === 'fixed' || rec.flexibility === 'window'
          ? (rec.flexibility as 'fixed' | 'window')
          : 'flexible',
      section: str(rec.section),
      period:
        rec.period === 'Morning' || rec.period === 'Afternoon' || rec.period === 'Evening'
          ? rec.period
          : null,
      startTime,
      endTime,
      durationMin: num(rec.durationMin),
      description: str(rec.description),
      placement,
      anchorId,
      taskId: str(rec.taskId),
      findQuery: findQuery ? findQuery.slice(0, 160) : null,
      area: str(rec.area),
      userQuery: userQuery ? userQuery.slice(0, 160) : null,
    });
  }
  return out;
}

/**
 * Run the unified compose brain. Resolves to `{ blocks: [] }` (never throws)
 * whenever the brain is unavailable or returns nothing useful, so the caller
 * can fall back to the legacy decompose + plan pipeline.
 */
export async function composeItinerary(input: ComposeInput): Promise<ComposeResult> {
  const intent = (input.intent ?? '').trim();
  const anchors = input.anchors ?? [];
  const tasks = input.tasks ?? [];
  const empty: ComposeResult = { blocks: [], title: '', summary: '', city: '' };

  if (!intent && anchors.length === 0 && tasks.length === 0) return empty;
  if (!isSupabaseConfigured || !supabase) return empty;

  const anchorIds = new Set(anchors.map((a) => a.id));

  try {
    const { data, error } = await supabase.functions.invoke('compose-itinerary', {
      body: {
        intent,
        anchors,
        tasks,
        dayStart: input.dayStart,
        dayEnd: input.dayEnd,
        context: input.context,
        home: input.home,
        date: input.date ?? todayISO(),
        now: input.now,
      },
    });
    if (!error && data && typeof data === 'object' && !('error' in (data as object))) {
      const rec = data as Record<string, unknown>;
      const usage = shapeUsage(rec.usage);
      logTokenUsage('compose-itinerary', usage);
      return {
        blocks: shapeBlocks(rec.blocks, anchorIds),
        title: str(rec.title) ?? '',
        summary: str(rec.summary) ?? '',
        city: str(rec.city) ?? '',
        usage,
      };
    }
    if (error) {
      console.warn('[compose-itinerary] function error; falling back to legacy pipeline', error);
    }
  } catch (e) {
    console.warn('[compose-itinerary] request failed; falling back to legacy pipeline', e);
  }
  return empty;
}
