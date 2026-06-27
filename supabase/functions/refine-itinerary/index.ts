// Supabase Edge Function: refine-itinerary
//
// The v3 "second pass" planning brain. The first pass (`compose-itinerary`)
// plans BLIND — it never sees real venues, travel times, or opening hours. The
// app then GROUNDS that plan deterministically (resolve venues via Google
// Places, route real door-to-door legs, cascade the clock, measure idle gaps).
// This function runs AFTER that, so it finally sees the day as it REALLY is and
// is allowed to actually re-plan it:
//
//   - swap / retime a venue that is CLOSED or closing at its scheduled slot,
//   - FILL a big idle gap with a useful on-theme activity,
//   - REORDER flexible stops to cut long / zig-zag travel,
//   - respect WAKE / WIND-DOWN (calm evening, single sleep block),
//   - SPLIT one overlong errand into multiple linked sessions.
//
// It emits the SAME ComposedBlock[] contract as compose, so the client reuses
// the same deterministic assemble + route to ground the revision.
//
// Request body:
//   {
//     intent?: string,
//     anchors?: AnchorInput[], tasks?: TaskInput[],   // the user's own errands
//     currentPlan: GroundedItem[],                     // the grounded day
//     dayStart?, dayEnd?, context?, date?, now?
//   }
// Response body: { changed: boolean, notes: string, blocks: ComposedBlock[], usage }
//
// Required env vars:
//   GEMINI_API_KEY          — Google AI Studio key (shared).
//   GEMINI_REFINE_MODEL     — optional; defaults to gemini-3.1-flash-lite.
//   GEMINI_REFINE_THINKING  — optional thinking budget (tokens, or -1).

// deno-lint-ignore-file no-explicit-any
// @ts-nocheck Deno runtime - types resolved by Supabase tooling at deploy time.

import { geminiUsage, logTokenUsage, type TokenUsage } from '../_shared/tokenLog.ts';

const DEFAULT_REFINE_MODEL = 'gemini-3.1-flash-lite';
const CONFIGURED_REFINE_MODEL =
  Deno.env.get('GEMINI_REFINE_MODEL') ?? DEFAULT_REFINE_MODEL;
// Self-heal onto the stronger flash tier if the lite model returns garbage; the
// client also degrades gracefully (keeps the pre-refine day) if this fails.
const FALLBACK_REFINE_MODEL = 'gemini-2.5-flash';

// Refine reasons over a whole grounded day (ordering + hours + gaps), so it gets
// a touch more thinking head-room than compose — still bounded to stay under the
// edge function wall-clock. Tune with `GEMINI_REFINE_THINKING`.
const DEFAULT_REFINE_THINKING = 1536;
function parseThinkingBudget(): number {
  const raw = Deno.env.get('GEMINI_REFINE_THINKING');
  if (raw == null || raw.trim() === '') return DEFAULT_REFINE_THINKING;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.round(n) : DEFAULT_REFINE_THINKING;
}
const REFINE_THINKING_BUDGET = parseThinkingBudget();

// One ordered block — identical contract to compose-itinerary's block, so the
// client's shapeBlocks + assembleComposedDay handle the output unchanged.
const BLOCK_ITEM_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['title', 'kind', 'flexibility', 'placement'],
  propertyOrdering: [
    'title',
    'kind',
    'flexibility',
    'section',
    'period',
    'startTime',
    'endTime',
    'durationMin',
    'description',
    'placement',
    'anchorId',
    'taskId',
    'findQuery',
    'area',
    'userQuery',
  ],
  properties: {
    title: { type: 'string' },
    kind: {
      type: 'string',
      format: 'enum',
      enum: [
        'travel',
        'work',
        'sightseeing',
        'meal',
        'event',
        'meetup',
        'drinks',
        'activity',
        'break',
        'gap',
        'other',
      ],
    },
    flexibility: { type: 'string', format: 'enum', enum: ['fixed', 'window', 'flexible'] },
    section: { type: 'string', nullable: true },
    period: {
      type: 'string',
      format: 'enum',
      nullable: true,
      enum: ['Morning', 'Afternoon', 'Evening'],
    },
    startTime: { type: 'string', nullable: true },
    endTime: { type: 'string', nullable: true },
    durationMin: { type: 'integer', nullable: true },
    description: { type: 'string', nullable: true },
    placement: {
      type: 'string',
      format: 'enum',
      enum: ['anchor', 'colocate', 'find', 'venue', 'home'],
    },
    anchorId: { type: 'string', nullable: true },
    taskId: { type: 'string', nullable: true },
    findQuery: { type: 'string', nullable: true },
    area: { type: 'string', nullable: true },
    userQuery: { type: 'string', nullable: true },
  },
};

const REFINE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['changed', 'blocks'],
  propertyOrdering: ['changed', 'notes', 'blocks'],
  properties: {
    changed: { type: 'boolean' },
    notes: { type: 'string' },
    blocks: { type: 'array', items: BLOCK_ITEM_SCHEMA },
  },
};

// ----------------------------------------------------------- HTTP helpers

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers':
      'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

// ----------------------------------------------------------- utilities

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function weekdayOf(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
}

function isHHMM(v: unknown): v is string {
  return typeof v === 'string' && /^\d{1,2}:\d{2}$/.test(v.trim());
}

function normalizeHHMM(v: unknown): string | null {
  if (!isHHMM(v)) return null;
  const [h, m] = (v as string).trim().split(':').map(Number);
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function isISODate(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.trim());
}

function asStr(v: unknown, max = 200): string | null {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
}

function asNum(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function extractJsonObject(text: string): any | null {
  if (!text) return null;
  const fenced = text.replace(/```json\s*|\s*```/g, '');
  const match = fenced.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

// ----------------------------------------------------------- prompt inputs

interface AnchorInput {
  id?: string;
  title?: string;
  name?: string;
  startTime?: string;
  endTime?: string;
  durationMin?: number;
  notes?: string;
}
interface TaskInput {
  id?: string;
  title?: string;
  startTime?: string;
  endTime?: string;
  durationMin?: number;
  notes?: string;
  atHome?: boolean;
}
interface GroundedItem {
  index?: number;
  title?: string;
  kind?: string;
  flexibility?: string;
  section?: string | null;
  start?: string | null;
  end?: string | null;
  durationMin?: number | null;
  isGap?: boolean;
  anchorId?: string | null;
  taskId?: string | null;
  venue?: { name?: string; address?: string | null; userNamed?: boolean } | null;
  travel?: { mode?: string; minutes?: number; summary?: string | null } | null;
  hours?: { status?: string; closeHHMM?: string | null; label?: string | null } | null;
}

/** Onboarding rhythm lines (shared shape with compose's describeContext). */
function describeContext(ctx: any, includeMorning: boolean): string {
  if (!ctx || typeof ctx !== 'object') return '';
  const lines: string[] = [];
  if (ctx.home?.label) lines.push(`- Home base: ${ctx.home.label}.`);
  if (includeMorning && ctx.wakeTime) {
    lines.push(
      `- The day STARTS at ${ctx.wakeTime}: open calmly AT HOME exactly then (wake → get ready → breakfast) and schedule NOTHING before ${ctx.wakeTime}.`,
    );
  }
  if (ctx.bedTime) {
    lines.push(
      `- Winds down around ${ctx.windDownTime ?? ctx.bedTime} and sleeps ~${ctx.bedTime}; the day should CLOSE with a calm wind-down then a single fixed sleep block near ${ctx.bedTime}.`,
    );
  }
  const meals = ctx.meals;
  if (meals && typeof meals === 'object') {
    const parts: string[] = [];
    for (const name of ['breakfast', 'lunch', 'dinner']) {
      const w = meals[name];
      if (!w) continue;
      const win =
        w.start || w.end
          ? `${w.start ?? ''}${w.start && w.end ? '–' : ''}${w.end ?? ''}`.trim()
          : 'anytime';
      let pref = ' (no preference)';
      if (w.venue) {
        pref = ` → at ${w.venue} (the user's OWN errand — that errand IS this meal; don't add a duplicate ${name})`;
      } else if (w.mode === 'home') {
        pref = ' → AT HOME (placement="home", no venue)';
      } else if (w.mode === 'out') {
        pref = ' → OUT (find a spot near the route)';
      }
      parts.push(`${name} ${win}${pref}`);
    }
    if (parts.length) {
      lines.push(
        `- Meals: ${parts.join('; ')}. HONOUR each meal's preference: "AT HOME" → placement="home", no venue; "OUT" → a venue near the route; a meal naming a venue is the user's errand (place THAT, no duplicate). Only "no preference" is your call.`,
      );
    }
  }
  if (ctx.windDownTime) {
    lines.push(
      `- Be HOME by ${ctx.windDownTime}: every out-and-about block AND the trip home must FINISH before ${ctx.windDownTime}. After it, ONLY calm at-home activities — nothing active (work, study, language practice, errands, eating out) may run past ${ctx.windDownTime}.${
        ctx.allowScreenWindDown === false ? ' Avoid screen-heavy wind-down.' : ''
      }`,
    );
  }
  if (ctx.car && typeof ctx.car === 'object') {
    lines.push(
      ctx.car.owns && ctx.car.useToday
        ? '- Has a car today (a slightly wider radius is OK).'
        : '- No car today — keep flexible venues close and clustered.',
    );
  }
  return lines.join('\n');
}

function fmtWhen(s?: string | null, e?: string | null, dur?: number | null): string {
  if (s) {
    return e
      ? ` — PINNED ${s}–${e} (do NOT move)`
      : ` — PINNED to START at ${s} (do NOT move)`;
  }
  return dur ? ` (~${dur} min)` : '';
}

/** Render the grounded day so the model sees venues, travel, hours, gaps. */
function describePlan(plan: GroundedItem[]): string {
  if (!plan.length) return '  (empty)';
  return plan
    .map((it) => {
      const time = it.start ? `${it.start}${it.end ? `–${it.end}` : ''}` : '--:--';
      const venue = it.venue?.name
        ? ` @ ${it.venue.name}${it.venue.userNamed ? ' (USER VENUE — keep)' : ''}`
        : '';
      const travel = it.travel?.minutes
        ? ` [travel in: ${it.travel.mode ?? '?'} ${it.travel.minutes}m${
            it.travel.summary ? ` (${it.travel.summary})` : ''
          }]`
        : '';
      const hours = it.hours?.status
        ? ` <<${it.hours.status.toUpperCase()}${
            it.hours.closeHHMM ? ` — closes ${it.hours.closeHHMM}` : ''
          }>>`
        : '';
      const gap = it.isGap ? ' <<IDLE GAP — candidate to fill>>' : '';
      // Surface the hard time-lock so the model never silently retimes or
      // reorders a pinned appointment (it only sees the CASCADED clock above,
      // which on a flexible item is just a suggestion but on a fixed one is a
      // real-world commitment — a doctor's slot, a class, a reservation).
      const lock =
        it.flexibility === 'fixed' && it.start
          ? ` <<FIXED ${it.start} — keep this exact start & order>>`
          : it.flexibility === 'window'
            ? ' <<WINDOWED — keep within its window>>'
            : '';
      const ref = it.anchorId
        ? ` {anchorId=${it.anchorId}}`
        : it.taskId
          ? ` {taskId=${it.taskId}}`
          : '';
      return `  #${it.index ?? 0} ${time} "${it.title ?? ''}" [${it.kind ?? 'other'}]${venue}${travel}${hours}${gap}${lock}${ref}`;
    })
    .join('\n');
}

function buildPrompt(args: {
  intent: string;
  anchors: AnchorInput[];
  tasks: TaskInput[];
  plan: GroundedItem[];
  dayStart?: { time?: string; label?: string };
  dayEnd?: { time?: string; label?: string };
  context?: any;
  date: string;
  now?: string;
}): string {
  const weekday = weekdayOf(args.date);
  const home = args.context?.home?.label;
  const dayUnderway = !!args.now;
  const includeMorning = !dayUnderway && !!args.context?.wakeTime;

  const anchorLines = args.anchors.length
    ? args.anchors
        .map((a, i) => {
          const id = a.id ?? `anchor-${i}`;
          const note = a.notes ? ` — ${a.notes}` : '';
          return `  - id="${id}": "${a.title ?? 'Stop'}"${fmtWhen(a.startTime, a.endTime, a.durationMin)}${note}`;
        })
        .join('\n')
    : '  (none)';

  const taskLines = args.tasks.length
    ? args.tasks
        .map((t, i) => {
          const id = t.id ?? `task-${i}`;
          const atHome = t.atHome ? ' — AT-HOME / ONLINE (no venue)' : '';
          const note = t.notes ? ` — ${t.notes}` : '';
          return `  - id="${id}": "${t.title ?? ''}"${fmtWhen(t.startTime, t.endTime, t.durationMin)}${atHome}${note}`;
        })
        .join('\n')
    : '  (none)';

  const frameBits = [
    args.dayStart?.time ? `starts the day ~${args.dayStart.time}` : '',
    args.dayStart?.label ? `from ${args.dayStart.label}` : '',
    args.dayEnd?.time ? `finishes by ~${args.dayEnd.time}` : '',
    args.dayEnd?.label ? `at ${args.dayEnd.label}` : '',
  ].filter(Boolean);
  const frameLine = frameBits.length ? `Day frame: ${frameBits.join(', ')}.` : '';
  const ctxLines = describeContext(args.context, includeMorning);
  const nowLine = dayUnderway
    ? `RIGHT NOW it is ${args.now} on ${args.date}: the day is ALREADY UNDERWAY — only touch what is at or after ${args.now}.`
    : '';

  return `You are the REFINE BRAIN for a personal day planner. An earlier pass planned this day and the app GROUNDED it for real: it resolved actual venues, computed real door-to-door travel times, looked up each venue's OPENING HOURS for its scheduled slot, and measured the real idle gaps. Look at the day AS IT REALLY IS and improve it. Output ONLY a JSON object matching the schema.

TODAY is ${args.date}${weekday ? ` (${weekday})` : ''}.${home ? ` Home base: ${home}.` : ''}
${frameLine}
${nowLine}
${ctxLines}

CURRENT PLAN — grounded, this is what the user sees right now (#index time "title" [kind] @venue [travel in] <<hours>> <<gap>> {ref}):
${describePlan(args.plan)}

THE USER'S OWN ERRANDS (must all stay in the day; reference by the given id):
ANCHORS (already-located — keep as placement="anchor" with anchorId):
${anchorLines}
TASKS:
${taskLines}

FREE-TEXT (the user's words for the day):
"""
${args.intent || '(none)'}
"""

FIX THESE PROBLEMS — only change what genuinely needs it:
1. CLOSED / CLOSING venues: a stop tagged <<CLOSED>> or <<CLOSINGSOON>> at its slot is broken. RETIME it to when the venue is open, or SWAP it via placement="find" with a better findQuery (different area, "open late", a 24h option). NEVER change the identity of a venue tagged "USER VENUE — keep" — only its time.
2. WASTED TIME: an <<IDLE GAP>> of ~30 min or more is unproductive — especially two or more in the same stretch of the day. Put it to work: fill it with a useful, on-theme activity near the neighbouring stops (placement="find", or "home" for self-care), OR pull a later flexible block earlier (deep work, language, a workout, an errand session) to use the slot, OR split a long flexible block so a piece lands in the gap. Keep the productive part of the day genuinely busy; only leave a gap when nothing sensibly fits. Never fill the calm wind-down before bed.
3. LONG / ZIG-ZAG TRAVEL: reorder FLEXIBLE stops to cut total travel and stop crossing town twice. Keep one neighbourhood's stops together.
4. WAKE / WIND-DOWN: schedule NOTHING before the day's start time. The day's HARD end is BEDTIME — the closing "Sleep" block is a single FIXED block AT bedtime, never hours early. By the WIND-DOWN hour the user must be HOME and done being out: every out-and-about block AND the trip home must FINISH before the wind-down hour — anything active (work, study, language practice, errands, a workout, eating out) ENDS before it, not merely starts before it. If the day is too full to fit a flexible block before wind-down, SHORTEN or DROP it rather than run past the wind-down hour. After it, only calm activities AT HOME (placement="home"); model the WHOLE evening stretch from the last real activity up to bedtime — wind-down / calm time / decompression / leftover free time — as kind="gap" (elastic time the user can resize or fill), NOT as rigid activities and NEVER as an early bedtime that leaves the evening empty.
5. OVERLONG ERRANDS: if one errand is long and better in pieces (e.g. "language learning 1.5h" → two 45-min sessions; skincare → morning + night), SPLIT it into multiple blocks placed at sensible DIFFERENT times of day. Give EACH split block the SAME taskId/anchorId as the source AND its own durationMin (the session length, not the total) so the app keeps them linked and sized right. Don't split short (<60 min) or pinned errands.
6. KEEP DURATIONS & NOTES: respect each errand's requested length and its notes/description. Only SHORTEN a flexible activity when the day is genuinely too tight to fit everything — and NEVER shorten, move, or reorder a fixed appointment, meeting, class, or anything with a pinned/FIXED time.
7. REALISTIC LENGTHS — NO CRUSHING: never squeeze an activity to a token sliver (a "5-min lunch", a "20-min" study stub). A meal needs ~25–45 min; a real work / study / practice session ~30+ min. If a meal AND another flexible block can't BOTH fit before a fixed appointment, keep the MEAL a normal length and MOVE the other block to a roomier slot (or drop a duplicate) — do NOT cram both into the gap. Don't schedule the SAME flexible activity twice in one day unless each session is a sensible length; prefer one solid session, or shift the catch-up to where there's genuine room (e.g. a later café work block).
8. MEALS — OBEY THE PREFERENCE: each meal in the context's Meals line carries the user's choice. "AT HOME" → placement="home", no venue. "OUT" → a venue near the route at that time. A meal that NAMES a venue is the user's OWN errand — that errand IS the meal, so don't add a duplicate. Only when a meal says "no preference" do you decide: then prefer AT HOME when going OUT would add a real detour/commute AND nearby flexible time could be used instead (e.g. rather than a short dinner OUT beside a café then a long trip home, keep studying near the café — but ONLY while it still FINISHES, with the trip home, before the wind-down hour — and eat at home afterwards). Keep a "no preference" meal OUT only when it's the point of the outing or genuinely on the way.

HARD RULES:
- Output the FULL revised day as ordered "blocks" (earliest first). EVERY anchor id and task id above MUST appear in at least one block. Use the SAME contract: placement anchor/colocate/find/venue/home, with anchorId/taskId/findQuery/area/userQuery; placement="find" REQUIRES findQuery; "venue" REQUIRES userQuery; "anchor"/"colocate" REQUIRE a real anchorId.
- NEVER move, retime, or reorder a stop tagged <<FIXED … — keep>> or any errand shown as PINNED; keep it at its exact start and in chronological order. NEVER rename/replace a "USER VENUE — keep" venue.
- At-home / online blocks (wind-down, reading, skincare, online sessions, language practice at home) use placement="home" — do NOT colocate them onto the previous venue (e.g. the dinner restaurant). The homeward trip is added for you.
- NEVER emit coordinates and NEVER emit a "travel" block — travel is recomputed for you. Leave startTime/endTime null unless the user pinned them.
- Set "changed": true ONLY if you actually improved the day; if it's already good, set "changed": false and echo the same blocks. Put one short sentence in "notes" describing the change (or "no change needed").${
    includeMorning ? "\n- Keep / add the calm morning-at-home open STARTING at the day's start time — nothing earlier." : ''
  }`;
}

// ----------------------------------------------------------- Gemini call

async function callGemini(args: {
  prompt: string;
  apiKey: string;
  model: string;
  thinkingBudget: number;
}): Promise<
  | { ok: true; parsed: any; usage: TokenUsage }
  | { ok: false; status: number; detail: string }
> {
  const generationConfig: Record<string, unknown> = {
    temperature: 0.3,
    responseMimeType: 'application/json',
    responseSchema: REFINE_SCHEMA,
  };
  if (args.thinkingBudget === -1 || args.thinkingBudget > 0) {
    generationConfig.thinkingConfig = { thinkingBudget: args.thinkingBudget };
  }
  const body = {
    contents: [{ role: 'user', parts: [{ text: args.prompt }] }],
    generationConfig,
  };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${args.model}:generateContent?key=${args.apiKey}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e: any) {
    return { ok: false, status: 502, detail: `Gemini fetch error: ${String(e?.message ?? e)}` };
  }
  if (!res.ok) {
    const detail = await res.text();
    return { ok: false, status: 502, detail: `Gemini ${res.status}: ${detail.slice(0, 400)}` };
  }
  const data = await res.json();
  const rawText: string = (data?.candidates?.[0]?.content?.parts ?? [])
    .map((p: any) => p?.text ?? '')
    .join('')
    .trim();
  const parsed = extractJsonObject(rawText);
  if (!parsed) {
    return { ok: false, status: 502, detail: `Unparseable JSON: ${rawText.slice(0, 300)}` };
  }
  return { ok: true, parsed, usage: geminiUsage(data?.usageMetadata) };
}

/** Clamp + validate the model's blocks into the shared ComposedBlock wire shape. */
function shapeBlocks(parsed: any, anchorIds: Set<string>): any[] {
  const raw = Array.isArray(parsed?.blocks) ? parsed.blocks : [];
  const out: any[] = [];
  for (const b of raw) {
    if (!b || typeof b !== 'object') continue;
    const title = asStr(b.title, 120);
    if (!title) continue;

    let placement: 'anchor' | 'colocate' | 'find' | 'venue' | 'home' =
      b.placement === 'anchor'
        ? 'anchor'
        : b.placement === 'colocate'
          ? 'colocate'
          : b.placement === 'find'
            ? 'find'
            : b.placement === 'venue'
              ? 'venue'
              : 'home';
    let anchorId = asStr(b.anchorId, 80);
    const taskId = asStr(b.taskId, 80);
    let findQuery = asStr(b.findQuery, 160);
    const area = asStr(b.area, 80);
    let userQuery = asStr(b.userQuery, 160);

    if ((placement === 'anchor' || placement === 'colocate') && (!anchorId || !anchorIds.has(anchorId))) {
      placement = findQuery ? 'find' : userQuery ? 'venue' : 'home';
      anchorId = null;
    }
    if (placement === 'find' && !findQuery) placement = userQuery ? 'venue' : 'home';
    if (placement === 'venue' && !userQuery) placement = findQuery ? 'find' : 'home';
    if (placement !== 'find') findQuery = null;
    if (placement !== 'venue') userQuery = null;
    if (placement !== 'anchor' && placement !== 'colocate') anchorId = null;

    const start = normalizeHHMM(b.startTime);
    let end = normalizeHHMM(b.endTime);
    if (!start) end = null;
    const durRaw = asNum(b.durationMin);
    const durationMin = durRaw != null && durRaw > 0 ? Math.round(durRaw) : null;

    out.push({
      title,
      kind: asStr(b.kind, 24) ?? 'other',
      flexibility:
        b.flexibility === 'fixed' || b.flexibility === 'window' ? b.flexibility : 'flexible',
      section: asStr(b.section, 80),
      period:
        b.period === 'Morning' || b.period === 'Afternoon' || b.period === 'Evening'
          ? b.period
          : null,
      startTime: start,
      endTime: end,
      durationMin,
      description: asStr(b.description, 280),
      placement,
      anchorId,
      taskId,
      findQuery,
      area,
      userQuery,
    });
  }
  return out;
}

// ----------------------------------------------------------- entrypoint

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders() });
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  const geminiKey = Deno.env.get('GEMINI_API_KEY');
  if (!geminiKey) {
    return jsonResponse(
      {
        error: 'GEMINI_API_KEY not configured on the server.',
        detail:
          'Set it via `supabase secrets set GEMINI_API_KEY=...` and redeploy this function.',
      },
      501,
    );
  }

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  const intent = typeof payload.intent === 'string' ? payload.intent.trim() : '';
  const anchors: AnchorInput[] = Array.isArray(payload.anchors) ? payload.anchors : [];
  const tasks: TaskInput[] = Array.isArray(payload.tasks) ? payload.tasks : [];
  const plan: GroundedItem[] = Array.isArray(payload.currentPlan) ? payload.currentPlan : [];
  // Nothing grounded to reason about → no change (client keeps current day).
  if (plan.length === 0) {
    return jsonResponse({ changed: false, notes: 'empty plan', blocks: [] });
  }

  const date = isISODate(payload.date) ? (payload.date as string) : todayISO();
  const now = isHHMM(payload.now) ? (payload.now as string) : undefined;
  const anchorIds = new Set<string>();
  anchors.forEach((a, i) => anchorIds.add(a.id ?? `anchor-${i}`));

  const prompt = buildPrompt({
    intent,
    anchors,
    tasks,
    plan,
    dayStart: payload.dayStart,
    dayEnd: payload.dayEnd,
    context: payload.context,
    date,
    now,
  });

  let modelUsed = CONFIGURED_REFINE_MODEL;
  let gem = await callGemini({
    prompt,
    apiKey: geminiKey,
    model: CONFIGURED_REFINE_MODEL,
    thinkingBudget: REFINE_THINKING_BUDGET,
  });
  if (!gem.ok && CONFIGURED_REFINE_MODEL !== FALLBACK_REFINE_MODEL) {
    console.warn(
      `refine-itinerary: model "${CONFIGURED_REFINE_MODEL}" failed (${gem.detail}); retrying with "${FALLBACK_REFINE_MODEL}".`,
    );
    modelUsed = FALLBACK_REFINE_MODEL;
    gem = await callGemini({
      prompt,
      apiKey: geminiKey,
      model: FALLBACK_REFINE_MODEL,
      thinkingBudget: REFINE_THINKING_BUDGET,
    });
  }
  if (!gem.ok) {
    return jsonResponse({ error: 'Refine failed', detail: gem.detail }, gem.status);
  }

  logTokenUsage({ fn: 'refine-itinerary', step: 'brain', model: modelUsed, usage: gem.usage });

  const blocks = shapeBlocks(gem.parsed, anchorIds);
  return jsonResponse({
    changed: gem.parsed?.changed === true && blocks.length > 0,
    notes: asStr(gem.parsed?.notes, 280) ?? '',
    blocks,
    usage: { model: modelUsed, ...gem.usage },
  });
});
