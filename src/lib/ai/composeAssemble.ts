/**
 * Deterministic resolve + assemble for the unified compose brain (v3).
 *
 * The brain ({@link composeItinerary}) returns an ORDERED list of day blocks
 * carrying only a PLACEMENT INTENT — never a final venue. This module turns
 * those intents into a real, renderable {@link Itinerary} with NO further model
 * calls:
 *
 *   - placement "anchor"   → the located user errand's own venue (verbatim).
 *   - placement "colocate" → shares an existing anchor's venue.
 *   - placement "find"     → place-less. Diem no longer searches venues; the
 *                            user pins a location on their errand instead.
 *   - placement "venue"    → place-less (same as find — no AI venue lookup).
 *   - placement "home"     → no venue (an at-home / online block).
 *
 * Venue truth therefore stays entirely with the user's located errands, and the
 * per-minute clock + travel + gaps are laid down afterward by the routing engine
 * (recompute-itinerary). PINNED user times are re-applied from the source errand
 * so the LLM can never corrupt a hard commitment.
 */
import { Itinerary, ItineraryPlace } from '@/types/itinerary';
import { sanitizeItinerary } from '@/lib/ai/itinerary';
import { type Coords } from '@/lib/places';
import type { ComposedBlock } from '@/lib/ai/composeItinerary';
import { errandTimeMode } from '@/utils/time';

/** A located user errand's resolved venue + any pinned time, keyed by errand id. */
export interface AssembleAnchor {
  title: string;
  place: ItineraryPlace;
  startTime?: string;
  endTime?: string;
  durationMin?: number;
}

/** An unplaced errand's pinned time, keyed by errand id (for pin enforcement). */
export interface AssembleTask {
  title: string;
  startTime?: string;
  endTime?: string;
  durationMin?: number;
}

export interface AssembleArgs {
  blocks: ComposedBlock[];
  title: string;
  summary: string;
  city: string;
  date: string;
  /** Located errands by the id the brain referenced (placement anchor/colocate). */
  anchorsById: Map<string, AssembleAnchor>;
  /** Unplaced errands by id, so a block linking one inherits its pinned time. */
  tasksById: Map<string, AssembleTask>;
  /** The day's known points (start, end, home, located errands) for find-centring. */
  dayAnchorCoords: Coords[];
  start: Coords | null;
  end: Coords | null;
  /** The user's home (kept for context/centring; no longer drives venue search). */
  home?: Coords | null;
}

export interface AssembleResult {
  itinerary: Itinerary | null;
  /** coordKey → ranked alternative venues, attached by the caller after show. */
  altByCoordKey: Map<string, ItineraryPlace[]>;
}

/**
 * Normalize a title for fuzzy dedup: trim, lowercase, collapse whitespace, drop
 * trailing punctuation. Lets the safety net recognise an errand the brain DID
 * schedule but linked with a missing/wrong id — the source of the duplicate
 * "Also today: online therapy" block.
 */
function normTitle(s: string | undefined | null): string {
  return (s ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.!?,;:]+$/, '');
}

/**
 * Buffer-like blocks the user treats as ELASTIC GAPS rather than rigid
 * activities — wind-down, calm time, decompression, leftover free time. These
 * are exactly the stretches the user expands/shrinks/fills when other blocks
 * change, so they render as gap cards (named, resizable). A block that resolved
 * to a real venue is a genuine stop and is never reclassified.
 */
const BUFFER_TITLE_RE =
  /\b(wind[\s-]*down|winddown|calm(?:\s*time)?|unwind|decompress|down[\s-]*time|chill|relax(?:ation)?|leisure|me[\s-]*time|free[\s-]*time|buffer)\b/i;

/**
 * DEV-only: how the compose brain classified each block on the most recent
 * assemble. Surfaced in the `[day-snapshot]` log so we can see, per block,
 * whether the brain chose `find` (Diem picks), `venue` (brain named a place),
 * `anchor` (a located user errand placed verbatim), etc. — the thing that
 * decides whether the find resolver even runs.
 */
export interface ComposedBlockTrace {
  i: number;
  title: string;
  placement: string;
  findQuery?: string | null;
  userQuery?: string | null;
  area?: string | null;
  anchorId?: string | null;
  /** The located errand's saved venue name + coords, when this is an anchor. */
  anchorPlace?: string | null;
  anchorCoords?: string | null;
  taskId?: string | null;
}
export let lastComposedBlocks: ComposedBlockTrace[] = [];

/**
 * Resolve every block's placement to a venue (or none) and assemble the ordered
 * {@link Itinerary}. Best-effort: a `find`/`venue` that resolves to nothing
 * becomes a place-less block (the routing pass still times it) rather than a
 * dropped activity. Returns `itinerary: null` only when there are no blocks.
 */
export async function assembleComposedDay(args: AssembleArgs): Promise<AssembleResult> {
  const altByCoordKey = new Map<string, ItineraryPlace[]>();
  const blocks = args.blocks ?? [];
  lastComposedBlocks = blocks.map((b, i) => {
    const a = b.anchorId ? args.anchorsById.get(b.anchorId) : undefined;
    const ac = a?.place.coords;
    return {
      i,
      title: b.title,
      placement: b.placement,
      findQuery: b.findQuery ?? null,
      userQuery: b.userQuery ?? null,
      area: b.area ?? null,
      anchorId: b.anchorId ?? null,
      anchorPlace: a?.place.name ?? null,
      anchorCoords: ac ? `${ac.latitude.toFixed(4)},${ac.longitude.toFixed(4)}` : null,
      taskId: b.taskId ?? null,
    };
  });
  if (blocks.length === 0) return { itinerary: null, altByCoordKey };

  // Build an ordered item per block. Only located user errands (anchor /
  // colocate) carry a venue — every other placement is place-less now, since
  // Diem no longer searches Google Places on the user's behalf.
  const referencedAnchors = new Set<string>();
  const referencedTasks = new Set<string>();
  // Normalized titles already emitted into the main plan, so the safety net can
  // skip re-adding an errand the brain scheduled but linked with a wrong/missing
  // id (the duplicate "Also today" block the user hit).
  const emittedTitles = new Set<string>();
  type RawItem = Record<string, unknown> & { __section: string; __period: string | null };
  const rawItems: RawItem[] = [];

  const pushItem = (
    b: Pick<
      ComposedBlock,
      'title' | 'kind' | 'flexibility' | 'section' | 'period' | 'description'
    >,
    opts: {
      startTime?: string | null;
      endTime?: string | null;
      durationMin?: number | null;
      /** A "between" availability window — the block flexes within [start, end]. */
      windowStart?: string | null;
      windowEnd?: string | null;
      /** Overrides the block's own flexibility (e.g. forcing 'window'). */
      flexibility?: ComposedBlock['flexibility'];
      place?: ItineraryPlace;
    },
  ) => {
    // Surface wind-down / calm / leftover-buffer blocks as elastic gaps (unless
    // they pin to a real venue) so the day's "soft" time is resizable, not a
    // fixed activity the cascade defends. A gap is always flexible.
    const asGap = !opts.place && b.kind !== 'gap' && BUFFER_TITLE_RE.test(b.title ?? '');
    rawItems.push({
      title: b.title,
      kind: asGap ? 'gap' : b.kind,
      flexibility: asGap ? 'flexible' : opts.flexibility ?? b.flexibility,
      startTime: opts.startTime ?? undefined,
      endTime: opts.endTime ?? undefined,
      durationMinutes: opts.durationMin ?? undefined,
      windowStart: opts.windowStart ?? undefined,
      windowEnd: opts.windowEnd ?? undefined,
      place: opts.place,
      description: b.description ?? undefined,
      __section: (b.section || b.period || 'Your day').toString(),
      __period: b.period ?? null,
    });
    if (b.title) emittedTitles.add(normTitle(b.title));
  };

  // How many blocks reference each source errand. More than one ⇒ refine SPLIT
  // that errand into multiple sessions (e.g. "language 1.5h" → two 45-min
  // blocks sharing the taskId), which changes how we apply its duration + pin.
  const taskRefCount = new Map<string, number>();
  const anchorRefCount = new Map<string, number>();
  for (const b of blocks) {
    if (b.taskId) taskRefCount.set(b.taskId, (taskRefCount.get(b.taskId) ?? 0) + 1);
    if (b.placement === 'anchor' && b.anchorId) {
      anchorRefCount.set(b.anchorId, (anchorRefCount.get(b.anchorId) ?? 0) + 1);
    }
  }
  // Which split errands have already consumed their single hard pin (only the
  // first session may inherit it — two sessions can't pin to the same instant).
  const splitPinConsumed = new Set<string>();

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];

    // Pinned time: a block linked to a source errand inherits THAT errand's hard
    // time (the brain can't corrupt it); otherwise use the brain's own pin.
    const anchorSrc = b.anchorId ? args.anchorsById.get(b.anchorId) : undefined;
    const taskSrc = b.taskId ? args.tasksById.get(b.taskId) : undefined;
    const inherit = b.placement === 'anchor' ? anchorSrc : undefined;
    const srcStart = inherit?.startTime ?? taskSrc?.startTime ?? null;
    const srcEnd = inherit?.endTime ?? taskSrc?.endTime ?? null;
    const srcDur = inherit?.durationMin ?? taskSrc?.durationMin ?? null;

    // Is this block one SESSION of a split errand?
    const sessionCount =
      taskSrc && (taskRefCount.get(b.taskId as string) ?? 0) > 1
        ? (taskRefCount.get(b.taskId as string) as number)
        : inherit && (anchorRefCount.get(b.anchorId as string) ?? 0) > 1
          ? (anchorRefCount.get(b.anchorId as string) as number)
          : 1;
    const isSplit = sessionCount > 1;
    const splitKey = isSplit ? (taskSrc ? `t:${b.taskId}` : `a:${b.anchorId}`) : null;
    const firstSession = isSplit && splitKey != null && !splitPinConsumed.has(splitKey);
    if (splitKey) splitPinConsumed.add(splitKey);

    let pinnedStart: string | null;
    let duration: number | null;
    if (isSplit) {
      // Sessions take their OWN (shorter) length; the source pin only lands on
      // the first one, the router times the rest.
      pinnedStart = firstSession ? srcStart ?? b.startTime ?? null : b.startTime ?? null;
      duration =
        b.durationMin ?? (srcDur != null ? Math.max(15, Math.round(srcDur / sessionCount)) : null);
    } else {
      pinnedStart = srcStart ?? b.startTime ?? null;
      duration = srcDur ?? b.durationMin ?? null;
    }
    let pinnedEnd = pinnedStart
      ? (firstSession || !isSplit ? srcEnd ?? b.endTime ?? null : b.endTime ?? null)
      : null;

    // A "between" source errand is an availability WINDOW, not a pin: the user is
    // open across [start, end] and the work (durationMin) is shorter. Emit it as
    // a duration-long "window" block the router places — and the cascade keeps —
    // INSIDE that range, instead of nailing it to the window's start.
    let windowStart: string | null = null;
    let windowEnd: string | null = null;
    let flexOverride: ComposedBlock['flexibility'] | undefined;
    if (!isSplit && errandTimeMode(srcStart, srcEnd, srcDur) === 'between') {
      windowStart = srcStart;
      windowEnd = srcEnd;
      duration = srcDur ?? duration;
      pinnedStart = null;
      pinnedEnd = null;
      flexOverride = 'window';
    }
    if (b.anchorId && anchorSrc) referencedAnchors.add(b.anchorId);
    if (b.taskId && taskSrc) referencedTasks.add(b.taskId);

    let place: ItineraryPlace | undefined;
    if ((b.placement === 'anchor' || b.placement === 'colocate') && anchorSrc) {
      // The located errand's own venue, kept verbatim.
      place = { ...anchorSrc.place, userNamed: true };
    }
    // Every other placement (find / venue / home / unresolved) is place-less —
    // the user pins a real location on the errand if they want one.

    pushItem(b, {
      startTime: pinnedStart,
      endTime: pinnedEnd,
      durationMin: duration,
      windowStart,
      windowEnd,
      flexibility: flexOverride,
      place,
    });
  }

  // 3b) Safety net — never silently drop a user errand the brain forgot to
  // reference. Append any unreferenced located/unplaced errand at the end so it
  // still lands in the day (the user can reorder it). Skip ones whose title is
  // already in the plan: the brain DID schedule them but linked a wrong/missing
  // id, so re-adding would duplicate (e.g. the "Also today: online therapy" bug).
  for (const [id, a] of args.anchorsById) {
    if (referencedAnchors.has(id)) continue;
    if (emittedTitles.has(normTitle(a.title))) continue;
    const between = errandTimeMode(a.startTime, a.endTime, a.durationMin) === 'between';
    pushItem(
      {
        title: a.title,
        kind: 'other',
        flexibility: between ? 'window' : a.startTime ? 'fixed' : 'flexible',
        section: 'Also today',
        period: null,
        description: null,
      },
      between
        ? {
            durationMin: a.durationMin ?? null,
            windowStart: a.startTime ?? null,
            windowEnd: a.endTime ?? null,
            place: { ...a.place, userNamed: true },
          }
        : {
            startTime: a.startTime ?? null,
            endTime: a.endTime ?? null,
            durationMin: a.durationMin ?? null,
            place: { ...a.place, userNamed: true },
          },
    );
  }
  for (const [id, t] of args.tasksById) {
    if (referencedTasks.has(id)) continue;
    if (emittedTitles.has(normTitle(t.title))) continue;
    const between = errandTimeMode(t.startTime, t.endTime, t.durationMin) === 'between';
    pushItem(
      {
        title: t.title,
        kind: 'other',
        flexibility: between ? 'window' : t.startTime ? 'fixed' : 'flexible',
        section: 'Also today',
        period: null,
        description: null,
      },
      between
        ? {
            durationMin: t.durationMin ?? null,
            windowStart: t.startTime ?? null,
            windowEnd: t.endTime ?? null,
          }
        : {
            startTime: t.startTime ?? null,
            endTime: t.endTime ?? null,
            durationMin: t.durationMin ?? null,
          },
    );
  }

  // 4) Group consecutive items sharing a section label into sections, then let
  // the shared sanitiser assign ids, validate kinds/flexibility, and index.
  const sections: { title: string; period?: string | null; items: RawItem[] }[] = [];
  for (const it of rawItems) {
    const label = it.__section;
    const last = sections[sections.length - 1];
    if (last && last.title === label) last.items.push(it);
    else sections.push({ title: label, period: it.__period, items: [it] });
  }

  const raw = {
    title: args.title || 'Your day',
    summary: args.summary || undefined,
    date: args.date,
    city: args.city || undefined,
    sections: sections.map((s) => ({
      title: s.title,
      period: s.period ?? undefined,
      items: s.items.map(({ __section, __period, ...rest }) => rest),
    })),
  };

  return { itinerary: sanitizeItinerary(raw), altByCoordKey };
}
