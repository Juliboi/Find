// Supabase Edge Function: compose-itinerary
//
// The UNIFIED planning brain (v3). It collapses what used to be two AI passes —
// `decompose-intent` (turn free text + vague errands into neighbourhood-aware
// items) and `plan-itinerary` (compose the day's structure) — into ONE
// structured call. It receives the WHOLE merged picture at once:
//
//   - ANCHORS  : already-located user errands (real coords) = fixed geography.
//   - TASKS    : unplaced user errands (a call, "deep work", a workout) +
//                pinned-time commitments (an online therapy slot).
//   - free text: the user's loose description of the day.
//   - context  : onboarding rhythm (wake/bed, meal windows, wind-down, car…).
//   - day frame: where/when the day starts and should finish.
//
// and emits a single ORDERED list of day blocks. Crucially it does NOT name
// final venues: for a place it needs found, it emits a neighbourhood-aware
// `findQuery` + `area`; for a venue the user named, `userQuery`; for an item
// that shares an existing stop, `colocate` + `anchorId`; for at-home/online,
// nothing. Real venues are resolved DETERMINISTICALLY downstream by Google
// Places (the client's resolveAutoPlace), and the per-minute clock by the
// routing engine (recompute-itinerary). So this brain stays commute-agnostic
// and venue-agnostic — it only does the structure + geography reasoning.
//
// Request body:
//   {
//     intent?: string,
//     anchors?: [{ id, title, name, latitude, longitude, startTime?, endTime?,
//                  durationMin?, notes?, locationType? }],
//     tasks?:   [{ id, title, startTime?, endTime?, durationMin?, notes?,
//                  atHome? }],
//     dayStart?: { time?, label? },
//     dayEnd?:   { time?, label? },
//     context?: { ...buildContextPayload... },
//     home?: { label, latitude, longitude },
//     date?: "YYYY-MM-DD",
//     now?: "HH:MM"
//   }
//
// Response body: { blocks: ComposedBlock[], title, summary, city, usage }
//
// Required env vars:
//   GEMINI_API_KEY               — Google AI Studio key (shared).
//   GEMINI_COMPOSE_MODEL         — optional; defaults to gemini-3.1-flash-lite.
//   GEMINI_COMPOSE_THINKING      — optional thinking budget (tokens, or -1).

// deno-lint-ignore-file no-explicit-any
// @ts-nocheck Deno runtime - types resolved by Supabase tooling at deploy time.

import { geminiUsage, logTokenUsage, type TokenUsage } from '../_shared/tokenLog.ts';

// The unified brain runs on gemini-3.1-flash-lite: capable enough for the
// structure + geography reasoning under a strict JSON schema (NO grounding —
// venue truth comes from Google Places downstream, which is exactly the
// combination that keeps lite models from drifting empty). Override with
// `supabase secrets set GEMINI_COMPOSE_MODEL=…`.
const DEFAULT_COMPOSE_MODEL = 'gemini-3.1-flash-lite';
const CONFIGURED_COMPOSE_MODEL =
  Deno.env.get('GEMINI_COMPOSE_MODEL') ?? DEFAULT_COMPOSE_MODEL;
// If the lite model fails (empty/garbled JSON), self-heal onto the stronger
// flash tier rather than failing the whole plan. The client also degrades
// gracefully to the legacy decompose+plan pipeline if this returns nothing.
const FALLBACK_COMPOSE_MODEL = 'gemini-2.5-flash';

// Thinking budget for the compose brain. BOUNDED by default (unlike the tiny
// decompose-intent, which can afford dynamic "-1"): this brain emits the whole
// ordered day, so unbounded thinking blows past the edge function's wall-clock
// limit (a `WORKER_RESOURCE_LIMIT` failure). A modest cap keeps the positioning
// judgement while landing in a few seconds. Set `GEMINI_COMPOSE_THINKING` to
// tune (a positive token budget, 0 to disable, or -1 for dynamic) without a
// redeploy.
const DEFAULT_COMPOSE_THINKING = 1024;
function parseThinkingBudget(): number {
  const raw = Deno.env.get('GEMINI_COMPOSE_THINKING');
  if (raw == null || raw.trim() === '') return DEFAULT_COMPOSE_THINKING;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.round(n) : DEFAULT_COMPOSE_THINKING;
}
const COMPOSE_THINKING_BUDGET = parseThinkingBudget();

// Gemini structured-output schema. A FLAT ordered list of blocks (not nested
// sections) — simpler for the model to emit reliably, and the client groups
// blocks into sections by their `section`/`period` label deterministically.
const COMPOSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['title', 'city', 'blocks'],
  propertyOrdering: ['title', 'summary', 'city', 'blocks'],
  properties: {
    title: { type: 'string' },
    summary: { type: 'string' },
    city: { type: 'string' },
    blocks: {
      type: 'array',
      items: {
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
          flexibility: {
            type: 'string',
            format: 'enum',
            enum: ['fixed', 'window', 'flexible'],
          },
          // Catchy headline grouping, e.g. "Morning Reset" — consecutive blocks
          // sharing one become a section. Optional; falls back to `period`.
          section: { type: 'string', nullable: true },
          period: {
            type: 'string',
            format: 'enum',
            nullable: true,
            enum: ['Morning', 'Afternoon', 'Evening'],
          },
          // Only when the user PINNED a clock time; otherwise null (the routing
          // layer lays the real clock down deterministically afterward).
          startTime: { type: 'string', nullable: true },
          endTime: { type: 'string', nullable: true },
          durationMin: { type: 'integer', nullable: true },
          description: { type: 'string', nullable: true },
          // How this block gets a location:
          //   anchor   → IS a located user errand (anchorId → its coords)
          //   colocate → happens AT an existing anchor's venue (anchorId)
          //   find     → auto-find a real venue (findQuery + area)
          //   venue    → a venue the user NAMED verbatim (userQuery)
          //   home     → at home / online, NO venue
          placement: {
            type: 'string',
            format: 'enum',
            enum: ['anchor', 'colocate', 'find', 'venue', 'home'],
          },
          // Links a block back to the source errand so the client can enforce
          // its pinned time/duration verbatim and attach its real place.
          anchorId: { type: 'string', nullable: true },
          taskId: { type: 'string', nullable: true },
          findQuery: { type: 'string', nullable: true },
          area: { type: 'string', nullable: true },
          userQuery: { type: 'string', nullable: true },
        },
      },
    },
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
  latitude?: number;
  longitude?: number;
  startTime?: string;
  endTime?: string;
  durationMin?: number;
  notes?: string;
  locationType?: string;
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

/** Onboarding rhythm lines (mirrors plan-itinerary's context personalisation),
 *  so the brain opens with the right morning routine and closes with wind-down. */
function describeContext(ctx: any, includeMorning: boolean): string {
  if (!ctx || typeof ctx !== 'object') return '';
  const lines: string[] = [];
  if (ctx.home?.label) lines.push(`- Home base: ${ctx.home.label}.`);
  if (includeMorning && ctx.wakeTime) {
    lines.push(
      `- The day STARTS at ${ctx.wakeTime}${
        ctx.wakeUpDurationMin ? ` (~${ctx.wakeUpDurationMin} min to get ready)` : ''
      }. Open AT HOME exactly then with wake → get ready → breakfast — schedule NOTHING before ${ctx.wakeTime} — then head out to the stops.`,
    );
  }
  if (ctx.bedTime) {
    lines.push(
      `- Winds down around ${ctx.windDownTime ?? ctx.bedTime} and sleeps ~${ctx.bedTime}; CLOSE the day with a calm wind-down then a single fixed sleep block near ${ctx.bedTime}.`,
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
      let pref = ' → no preference (you decide home vs out)';
      if (w.venue) {
        pref = ` → at ${w.venue} (the user's OWN errand — treat THAT errand as this meal; do NOT add a separate ${name})`;
      } else if (w.mode === 'home') {
        pref = ' → AT HOME (placement="home", no venue, no travel)';
      } else if (w.mode === 'out') {
        pref = ' → OUT (find a spot near the route at that time)';
      }
      parts.push(`${name} ${win}${pref}`);
    }
    if (parts.length) {
      lines.push(
        `- Meals: ${parts.join('; ')}. Schedule each meal to START inside its window (use "window" flexibility) and HONOUR each preference: "AT HOME" → placement="home" with no venue; "OUT" → a venue CLOSE to the neighbouring stops; a meal that NAMES a venue is one of the user's errands, so place THAT errand as the meal and never add a duplicate. Only "no preference" is your call.`,
      );
    }
  }
  if (ctx.windDownTime) {
    lines.push(
      `- Be HOME and winding down by ${ctx.windDownTime}: every out-and-about block AND the trip home must FINISH before ${ctx.windDownTime}. After it, ONLY calm, sleep-friendly activities AT HOME (reading, skincare, stretching, journaling) — nothing active (work, study, language practice, errands, eating out, workouts). Anything active must END before ${ctx.windDownTime}, not merely start before it.${
        ctx.allowScreenWindDown === false
          ? ' Avoid screen-heavy wind-down (TV, gaming, phone).'
          : ''
      }`,
    );
  }
  if (ctx.car && typeof ctx.car === 'object') {
    lines.push(
      ctx.car.owns && ctx.car.useToday
        ? '- Has a car today (a slightly wider radius is OK), but keep short hops on foot/transit.'
        : '- No car today — keep flexible venues close and clustered for walking/transit.',
    );
  }
  if (Array.isArray(ctx.dietary) && ctx.dietary.length) {
    lines.push(`- Dietary: ${ctx.dietary.join(', ')}${ctx.dietaryNotes ? ` (${ctx.dietaryNotes})` : ''}.`);
  }
  return lines.join('\n');
}

/** Minutes since midnight for "HH:MM", or null if unparseable. */
function hhmmToMin(hhmm?: string | null): number | null {
  if (!hhmm) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function fmtWhen(s?: string | null, e?: string | null, dur?: number | null): string {
  const sMin = hhmmToMin(s);
  const eMin = hhmmToMin(e);
  // A "between" availability window: open across [s, e] with the work (dur)
  // shorter than the span — schedule it ANYWHERE inside, never pinned to s.
  if (sMin != null && eMin != null && eMin > sMin && dur != null && dur > 0 && eMin - sMin - dur > 0) {
    return ` — OPEN BETWEEN ${s}–${e}: fit its ~${dur} min ANYWHERE inside this window ("window" flexibility; leave startTime/endTime null so the router places it — do NOT pin it to ${s})`;
  }
  if (s) {
    return e
      ? ` — PINNED ${s}–${e} (START exactly at ${s}, do NOT move)`
      : ` — PINNED to START exactly at ${s} (do NOT move)`;
  }
  return dur ? ` (~${dur} min, time flexible)` : '';
}

function buildPrompt(args: {
  intent: string;
  anchors: AnchorInput[];
  tasks: TaskInput[];
  dayStart?: { time?: string; label?: string };
  dayEnd?: { time?: string; label?: string };
  context?: any;
  home?: { label?: string; latitude?: number; longitude?: number };
  date: string;
  now?: string;
}): string {
  const weekday = weekdayOf(args.date);
  const home = args.home?.label ?? args.context?.home?.label;
  const dayUnderway = !!args.now;
  const includeMorning = !dayUnderway && !!args.context?.wakeTime;

  const anchorLines = args.anchors.length
    ? args.anchors
        .map((a, i) => {
          const id = a.id ?? `anchor-${i}`;
          const coord =
            typeof a.latitude === 'number' && typeof a.longitude === 'number'
              ? ` [${a.latitude.toFixed(4)}, ${a.longitude.toFixed(4)}]`
              : '';
          const lt = a.locationType ? ` {${a.locationType}}` : '';
          const note = a.notes ? ` — ${a.notes}` : '';
          return `  - id="${id}": "${a.title ?? 'Stop'}" @ ${a.name ?? 'located'}${lt}${coord}${fmtWhen(
            a.startTime,
            a.endTime,
            a.durationMin,
          )}${note}`;
        })
        .join('\n')
    : '  (none — there are no already-located stops to cluster around)';

  const taskLines = args.tasks.length
    ? args.tasks
        .map((t, i) => {
          const id = t.id ?? `task-${i}`;
          const home = t.atHome ? ' — AT-HOME / ONLINE: no physical venue' : '';
          const note = t.notes ? ` — ${t.notes}` : '';
          return `  - id="${id}": "${t.title ?? ''}"${fmtWhen(
            t.startTime,
            t.endTime,
            t.durationMin,
          )}${home}${note}`;
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
    ? `RIGHT NOW it is ${args.now} on ${args.date}: the day is ALREADY UNDERWAY. Plan ONLY what still lies ahead (at or after ${args.now}); do NOT replay the morning or anything already past.`
    : '';

  return `You are the PLANNING BRAIN for a personal day planner. You turn a user's errands + a free-text description into ONE smooth, realistic, well-ordered day. You think about the day STRUCTURALLY (what happens, in what order) and especially GEOGRAPHICALLY (cluster things by neighbourhood to avoid back-and-forth). Output ONLY a JSON object matching the schema.

TODAY is ${args.date}${weekday ? ` (${weekday})` : ''}.${home ? ` Home base: ${home}.` : ''}
${frameLine}
${nowLine}
${ctxLines}

ALREADY-LOCATED STOPS (fixed geography — these have REAL coordinates; treat them as the backbone and cluster everything else around them):
${anchorLines}

UNPLACED ERRANDS / COMMITMENTS (schedule each; give place-y ones a neighbourhood-aware location, keep at-home ones place-less):
${taskLines}

FREE-TEXT (the user's own words for the day):
"""
${args.intent || '(none)'}
"""

YOUR JOB — emit "blocks", a SINGLE ORDERED list covering the whole day from start to finish:
1. INCLUDE every anchor and every task as a block. For an anchor, set placement="anchor" and anchorId to its id (we attach its real venue + coords). For a task, set taskId to its id.
2. SPLIT the free text into discrete activities (e.g. "deep work 2h at a cafe, language 1.5h, skincare, read before sleep, go to a max fitness gym" is FIVE activities). Add each as its own block.
3. POSITION place-y blocks in the RIGHT neighbourhood. For a flexible venue write placement="find" with a SPECIFIC, geocodable findQuery. STRIP filler from the user's words down to the core searchable venue — drop verbs/qualifiers like "go to / workout at / near / a / the / buy / pick up / get" (so task "Workout at near max fitness gym" → findQuery "Max Fitness gym", NOT the whole sentence) — and turn a PRODUCT into the SHOP that sells it ("buy domestos / cleaning supplies" → findQuery "drogerie" or "supermarket"; "pick up bread" → "bakery"). Keep a real brand the user gave (Max Fitness); do NOT invent an exact branch name. THEN decide WHERE each find searches:
   • A quick LOCAL everyday errand with no geography of its own — groceries, gym, pharmacy, drogerie/household shop, post office, drycleaner, bakery — belongs near HOME. Write findQuery as the BARE brand/category with NO neighbourhood and NO city ("Max Fitness gym", "drogerie", "supermarket") and set area=null; the planner finds the branch nearest the user's home automatically. Do NOT write a district or city into these — that is what sends the user to the wrong branch across town.
   • A find that is genuinely EN ROUTE to (or clustered with) a located anchor takes THAT anchor's real neighbourhood: put the area in BOTH findQuery and the area field (e.g. a coffee stop by a Karlín meeting → findQuery="specialty coffee, Karlín, Prague", area="Karlín").
   • NEVER guess, invent, or append a district/branch you cannot SEE from a located anchor or the user's own words. A wrong guess (e.g. tacking "Holešovice" onto a gym when home is elsewhere) sends the user across town. When unsure of the area, OMIT it and keep findQuery clean.
4. CO-LOCATE compatible activities onto a stop that ALREADY exists: if "deep work" or "content prep" can happen at a café anchor, set placement="colocate" and anchorId=<that anchor's id> (no findQuery).
5. AT-HOME / ONLINE blocks → placement="home", no query. This covers self-care (skincare, reading, a nap, journaling, stretching) AND anything online/remote (a video/phone call, telehealth/online therapy, remote work, a virtual class). If a task is marked AT-HOME, or its words say online/virtual/remote/zoom/meet/teams/video call/phone, it has NO venue — ALWAYS placement="home", even if it has a clock time.
6. A venue the USER NAMED verbatim (in a task hint or the free text, e.g. "hostinec U Mišků") → placement="venue", userQuery=<their EXACT words>.
7. ROUTINE: ${includeMorning ? 'OPEN the day at home with wake → get ready → breakfast (placement="home") STARTING at the day\'s start time — schedule nothing earlier — then ' : ''}order the out-and-about stops to MINIMISE travel (no zig-zagging across town), and ${args.context?.bedTime ? 'CLOSE with a calm wind-down then a single fixed "Sleep" block near ' + args.context.bedTime : 'end at a sensible time'}. Do NOT invent errands the user didn't mention. Give any genuine open stretch of 20+ minutes its own placement="home", kind="gap" block (a friendly title) rather than padding activities.
8. PINNED TIMES ARE LAW: copy any PINNED startTime/endTime verbatim onto that block. Leave startTime/endTime null for everything else — a downstream router lays the real clock + travel down. durationMin: convert explicit lengths ("2 hours"→120, "1.5h"→90) else leave null.
9. flexibility: "fixed" ONLY for a user-pinned clock time or a hard external commitment (reservation, appointment, class, transport) AND the single closing sleep block. EVERYTHING else (gym, deep work, self-care, meals at home, walks, gaps) is "flexible". "window" for things bound to a range (a meal window, opening hours).
10. kind: best-fit ("work","meal","activity","errand","break","gap","sightseeing","drinks","meetup","event","travel","other"). section: a short catchy headline to group consecutive blocks ("Morning Reset","Gym & Recovery","Wind Down"). period: Morning/Afternoon/Evening. description: 1 short sentence.

RULES:
- placement="find" REQUIRES findQuery. placement="colocate" REQUIRES anchorId pointing at a real located id above. placement="venue" REQUIRES userQuery. placement="anchor" REQUIRES anchorId. placement="home" has none of these.
- NEVER emit coordinates and NEVER emit a "travel" block for a short hop — travel is computed for you. Keep block titles short and human ("Deep work","Gym session","Skincare"), no times/areas baked into the title.
- Don't pile several flexible blocks (a meal + a study session + …) into a short slot right before a PINNED stop — there won't be time and they get crushed to slivers. Give a meal its own realistic slot and place extra flexible work where the day has real room (a café block, a free stretch), not crammed before an appointment. Don't list the same flexible activity twice unless each gets a sensible length.
- Prefer a meal AT HOME (placement="home") over a short meal OUT when eating out adds a real commute and nearby flexible time could be used instead.
- OBEY the per-meal preference in the Meals context line: "AT HOME" → placement="home", no venue; "OUT" → a venue near the route; a meal that NAMES a venue is the user's own errand — schedule THAT errand as the meal and add NO duplicate meal block. Only override toward home/out when the meal says "no preference".
- BEDTIME is the day's hard end: fill the evening from the last activity up to bedtime with calm wind-down (kind="gap"), then the single fixed "Sleep" block AT bedtime — never an early sleep that leaves the evening empty.
- Blocks must be in clock order (earliest first).`;
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
    responseSchema: COMPOSE_SCHEMA,
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

/** Clamp + validate the model's blocks into the wire shape the client expects,
 *  enforcing the placement invariants the client relies on. */
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

    // Degrade inconsistent placements to a sane shape rather than dropping the
    // block (so the activity still lands in the day).
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
  // Nothing to compose → empty (the client falls back to its legacy pipeline).
  if (!intent && anchors.length === 0 && tasks.length === 0) {
    return jsonResponse({ blocks: [], title: '', summary: '', city: '' });
  }

  const date = isISODate(payload.date) ? (payload.date as string) : todayISO();
  const now = isHHMM(payload.now) ? (payload.now as string) : undefined;
  const anchorIds = new Set<string>();
  anchors.forEach((a, i) => anchorIds.add(a.id ?? `anchor-${i}`));

  const prompt = buildPrompt({
    intent,
    anchors,
    tasks,
    dayStart: payload.dayStart,
    dayEnd: payload.dayEnd,
    context: payload.context,
    home: payload.home,
    date,
    now,
  });

  let modelUsed = CONFIGURED_COMPOSE_MODEL;
  let gem = await callGemini({
    prompt,
    apiKey: geminiKey,
    model: CONFIGURED_COMPOSE_MODEL,
    thinkingBudget: COMPOSE_THINKING_BUDGET,
  });
  if (!gem.ok && CONFIGURED_COMPOSE_MODEL !== FALLBACK_COMPOSE_MODEL) {
    console.warn(
      `compose-itinerary: model "${CONFIGURED_COMPOSE_MODEL}" failed (${gem.detail}); retrying with "${FALLBACK_COMPOSE_MODEL}".`,
    );
    modelUsed = FALLBACK_COMPOSE_MODEL;
    gem = await callGemini({
      prompt,
      apiKey: geminiKey,
      model: FALLBACK_COMPOSE_MODEL,
      thinkingBudget: COMPOSE_THINKING_BUDGET,
    });
  }
  if (!gem.ok) {
    return jsonResponse({ error: 'Compose failed', detail: gem.detail }, gem.status);
  }

  logTokenUsage({ fn: 'compose-itinerary', step: 'brain', model: modelUsed, usage: gem.usage });

  return jsonResponse({
    blocks: shapeBlocks(gem.parsed, anchorIds),
    title: asStr(gem.parsed?.title, 120) ?? '',
    summary: asStr(gem.parsed?.summary, 400) ?? '',
    city: asStr(gem.parsed?.city, 80) ?? '',
    usage: { model: modelUsed, ...gem.usage },
  });
});
