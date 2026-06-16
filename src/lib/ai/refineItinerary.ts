/**
 * Client-side wrapper for the `refine-itinerary` Edge Function — the v3 "second
 * pass" brain. Where {@link composeItinerary} plans BLIND (no venues, no travel,
 * no hours), refine runs AFTER the deterministic resolve + route, so it finally
 * sees the day's GROUND TRUTH: real venues + coordinates, real door-to-door
 * travel (line + minutes), each venue's open/closed status at its scheduled
 * slot, and the real idle gaps. It is then allowed to actually re-plan —
 * reorder to cut travel, retime around wake/wind-down, fill big gaps with useful
 * activities, split a long errand into sessions, and swap a venue that's closed
 * at its slot.
 *
 * Output is the SAME {@link ComposedBlock}[] contract compose emits, so the
 * caller reuses {@link assembleComposedDay} + recompute to ground the revision.
 * Like the other AI wrappers it ALWAYS resolves: on any failure it returns
 * `{ changed: false, blocks: [] }` so the caller keeps the pre-refine day.
 */
import { isSupabaseConfigured, supabase } from '@/lib/supabase';
import { todayISO } from '@/utils/time';
import { logTokenUsage, shapeUsage, type LlmTokenUsage } from '@/lib/usage';
import type { Itinerary } from '@/types/itinerary';
import { getVenueHoursStatus } from '@/lib/itinerary/hours';
import {
  shapeBlocks,
  type ComposedBlock,
  type ComposeAnchorInput,
  type ComposeTaskInput,
} from '@/lib/ai/composeItinerary';

export interface RefineInput {
  /** The grounded day (post resolve + route): real venues, travel, clock. */
  itinerary: Itinerary;
  intent: string;
  date?: string;
  /** "HH:MM" current time when planning a day already underway. */
  now?: string;
  dayStart?: { time?: string; label?: string };
  dayEnd?: { time?: string; label?: string };
  /** Full profile context (the `buildContextPayload` output). */
  context?: Record<string, unknown>;
  /** Located errands (so refine can keep/reference them by id). */
  anchors?: ComposeAnchorInput[];
  /** Unplaced errands (so refine can keep/reference them by id). */
  tasks?: ComposeTaskInput[];
}

export interface RefineResult {
  blocks: ComposedBlock[];
  /** False when refine found nothing to improve (caller keeps current day). */
  changed: boolean;
  /** Short human rationale for the change, for tracing. */
  notes: string;
  usage?: LlmTokenUsage | null;
}

/** One grounded stop as refine sees it — what the user is actually looking at. */
interface GroundedItem {
  index: number;
  title: string;
  kind: string;
  flexibility: string;
  section: string | null;
  start: string | null;
  end: string | null;
  durationMin: number | null;
  isGap: boolean;
  /** The source errand this block fulfils, matched by title — echo to keep it. */
  anchorId: string | null;
  taskId: string | null;
  venue: { name: string; address: string | null; userNamed: boolean } | null;
  /** Real travel INTO this stop from the previous one. */
  travel: { mode: string; minutes: number; summary: string | null } | null;
  /** Open/closed at the SCHEDULED slot (null when hours are unknown). */
  hours: { status: string; closeHHMM: string | null; label: string | null } | null;
}

function normTitle(s: string | undefined | null): string {
  return (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.!?,;:]+$/, '');
}

/**
 * Flatten the routed itinerary into the compact ground-truth list refine reads.
 * Errand linkage (anchorId/taskId) is recovered by title so refine can echo a
 * stable reference and the assembler re-applies the verbatim venue + pinned time.
 */
function buildGroundedDay(
  itin: Itinerary,
  anchors: ComposeAnchorInput[],
  tasks: ComposeTaskInput[],
): GroundedItem[] {
  const anchorByTitle = new Map(anchors.map((a) => [normTitle(a.title), a.id]));
  const taskByTitle = new Map(tasks.map((tk) => [normTitle(tk.title), tk.id]));
  const out: GroundedItem[] = [];
  let index = 0;
  for (const section of itin.sections) {
    for (const it of section.items) {
      const place = it.place ?? null;
      const status =
        place && place.openingHours
          ? getVenueHoursStatus(place, itin.date, it.startTime, it.endTime)
          : null;
      const key = normTitle(it.title);
      out.push({
        index: index++,
        title: it.title,
        kind: it.kind,
        flexibility: it.flexibility ?? 'flexible',
        section: section.title ?? null,
        start: it.startTime ?? null,
        end: it.endTime ?? null,
        durationMin: it.durationMinutes ?? null,
        isGap: it.kind === 'gap',
        anchorId: anchorByTitle.get(key) ?? null,
        taskId: taskByTitle.get(key) ?? null,
        venue: place
          ? {
              name: place.name,
              address: place.address ?? null,
              userNamed: place.userNamed === true,
            }
          : null,
        travel: it.travelFromPrev
          ? {
              mode: it.travelFromPrev.mode,
              minutes: it.travelFromPrev.minutes,
              summary: it.travelFromPrev.summary ?? null,
            }
          : null,
        hours:
          status && status.status !== 'unknown'
            ? {
                status: status.status,
                closeHHMM: status.closeHHMM ?? null,
                label: status.statusLabel ?? null,
              }
            : null,
      });
    }
  }
  return out;
}

/**
 * Run the refine brain on a grounded day. Resolves to `{ changed: false }`
 * (never throws) whenever refine is unavailable or returns nothing useful, so
 * the caller simply keeps the current day.
 */
export async function refineItinerary(input: RefineInput): Promise<RefineResult> {
  const empty: RefineResult = { blocks: [], changed: false, notes: '' };
  if (!isSupabaseConfigured || !supabase) return empty;
  const anchors = input.anchors ?? [];
  const tasks = input.tasks ?? [];
  const currentPlan = buildGroundedDay(input.itinerary, anchors, tasks);
  if (currentPlan.length === 0) return empty;

  const anchorIds = new Set(anchors.map((a) => a.id));

  try {
    const { data, error } = await supabase.functions.invoke('refine-itinerary', {
      body: {
        intent: (input.intent ?? '').trim(),
        date: input.date ?? itinDate(input.itinerary),
        now: input.now,
        dayStart: input.dayStart,
        dayEnd: input.dayEnd,
        context: input.context,
        anchors,
        tasks,
        currentPlan,
      },
    });
    if (!error && data && typeof data === 'object' && !('error' in (data as object))) {
      const rec = data as Record<string, unknown>;
      const usage = shapeUsage(rec.usage);
      logTokenUsage('refine-itinerary', usage);
      const blocks = shapeBlocks(rec.blocks, anchorIds);
      const changed = rec.changed === true && blocks.length > 0;
      return {
        blocks,
        changed,
        notes: typeof rec.notes === 'string' ? rec.notes : '',
        usage,
      };
    }
    if (error) console.warn('[refine-itinerary] function error; keeping current day', error);
  } catch (e) {
    console.warn('[refine-itinerary] request failed; keeping current day', e);
  }
  return empty;
}

function itinDate(itin: Itinerary): string {
  return itin.date ?? todayISO();
}
