// Supabase Edge Function: fill-day  (V3 pipeline — Phase 5)
//
// The heavy "make it a real day" brain. By the time this runs the day already
// has its ORDER (Phase 2 `order-day`), its VENUES (deterministic Google resolve)
// and a first COMMUTE pass — so the model is NOT asked to discover places or
// re-order from scratch. Instead it receives the compact, already-resolved stops
// plus the user's rhythm and:
//
//   1. WEAVES IN the non-errand scaffolding the errands never cover — wake, get
//      ready, breakfast / lunch / dinner (honouring each meal's window + home/
//      out/venue preference), an evening wind-down, and a single fixed Sleep.
//   2. FILLS open stretches (20+ min) with friendly "gap" blocks.
//   3. RESPECTS the hard constraints: fixed errand times, the wind-down cutoff,
//      and bedtime.
//
// It KEEPS every input stop (referencing it back by id so the client re-attaches
// the exact resolved venue + any pinned time) and emits the whole day in the
// SAME ordered-block shape the deterministic assembler already consumes — so the
// real clock + travel get laid down by the routing engine afterward (Phase 6).
//
// Request body:
//   {
//     stops: [{ ref, title, kind?, startTime?, endTime?, durationMin?, place?,
//               located, fixed }],
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
//   GEMINI_API_KEY        — Google AI Studio key (shared).
//   GEMINI_FILL_MODEL     — optional; defaults to gemini-2.5-flash (stronger tier).
//   GEMINI_FILL_THINKING  — optional thinking budget (tokens, 0, or -1). Default 4096.

// deno-lint-ignore-file no-explicit-any
// @ts-nocheck Deno runtime - types resolved by Supabase tooling at deploy time.

import { geminiUsage, logTokenUsage, type TokenUsage } from '../_shared/tokenLog.ts';

// This pass is where the day's quality is won, so it runs on the stronger flash
// tier with a generous thinking budget (the day frame + rhythm reasoning is
// worth the tokens). Override with `supabase secrets set GEMINI_FILL_MODEL=…`.
const DEFAULT_FILL_MODEL = 'gemini-2.5-flash';
const CONFIGURED_FILL_MODEL = Deno.env.get('GEMINI_FILL_MODEL') ?? DEFAULT_FILL_MODEL;
const FALLBACK_FILL_MODEL = 'gemini-2.5-flash';

const DEFAULT_FILL_THINKING = 4096;
function parseThinkingBudget(): number {
  const raw = Deno.env.get('GEMINI_FILL_THINKING');
  if (raw == null || raw.trim() === '') return DEFAULT_FILL_THINKING;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.round(n) : DEFAULT_FILL_THINKING;
}
const FILL_THINKING_BUDGET = parseThinkingBudget();

// Same FLAT ordered-block schema as compose-itinerary — the client assembles it
// with the identical deterministic path (resolve → route).
const FILL_SCHEMA: Record<string, unknown> = {
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
      },
    },
  },
};

// ----------------------------------------------------------- HTTP helpers

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
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

interface StopInput {
  ref?: string;
  title?: string;
  kind?: string;
  startTime?: string;
  endTime?: string;
  durationMin?: number;
  place?: string;
  located?: boolean;
  fixed?: boolean;
}

/** Onboarding rhythm lines — same source as compose-itinerary, so the morning
 *  routine, meals and wind-down land the same way. */
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
        pref = ` → at ${w.venue} (the user's OWN stop — treat THAT stop as this meal; do NOT add a separate ${name})`;
      } else if (w.mode === 'home') {
        pref = ' → AT HOME (placement="home", no venue, no travel)';
      } else if (w.mode === 'out') {
        pref = ' → OUT (find a spot near the route at that time)';
      }
      parts.push(`${name} ${win}${pref}`);
    }
    if (parts.length) {
      lines.push(
        `- Meals: ${parts.join('; ')}. Schedule each meal to START inside its window ("window" flexibility) and HONOUR each preference: "AT HOME" → placement="home"; "OUT" → placement="find" for a spot CLOSE to the neighbouring stops; a meal already covered by a stop is that stop — never duplicate it. Only "no preference" is your call.`,
      );
    }
  }
  if (ctx.windDownTime) {
    lines.push(
      `- Be HOME and winding down by ${ctx.windDownTime}: every out-and-about block AND the trip home must FINISH before ${ctx.windDownTime}. After it, ONLY calm, sleep-friendly activities AT HOME (reading, skincare, stretching, journaling) — nothing active. Anything active must END before ${ctx.windDownTime}.${
        ctx.allowScreenWindDown === false ? ' Avoid screen-heavy wind-down (TV, gaming, phone).' : ''
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

function fmtStopWhen(s?: string, e?: string, dur?: number, fixed?: boolean): string {
  if (fixed && isHHMM(s)) {
    return isHHMM(e)
      ? ` — FIXED ${s}–${e} (keep this exact time)`
      : ` — FIXED at ${s} (keep this exact time)`;
  }
  return dur ? ` (~${dur} min, time flexible)` : '';
}

function describeStop(s: StopInput, i: number): string {
  const ref = s.ref ?? `stop-${i}`;
  const where = s.located
    ? s.place
      ? `@ ${s.place}`
      : 'LOCATED'
    : 'at-home / online (no venue)';
  return `  - ref="${ref}": "${s.title ?? 'Stop'}" [${where}]${fmtStopWhen(
    s.startTime,
    s.endTime,
    s.durationMin,
    s.fixed,
  )}`;
}

function buildPrompt(args: {
  stops: StopInput[];
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

  const stopLines = args.stops.length
    ? args.stops.map(describeStop).join('\n')
    : '  (none — build a sensible day from the rhythm alone)';

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

  return `You are the FINAL "fill the day" step of a personal day planner. The user's errands are ALREADY ordered and already have real venues — your job is to turn that skeleton into a complete, realistic day by adding the everyday-life blocks the errands don't cover and filling the open time, WITHOUT discovering new places for the existing stops or shuffling them around. Output ONLY a JSON object matching the schema.

TODAY is ${args.date}${weekday ? ` (${weekday})` : ''}.${home ? ` Home base: ${home}.` : ''}
${frameLine}
${nowLine}
${ctxLines}

ORDERED STOPS (already placed & in order — KEEP every one, in this order):
${stopLines}

YOUR JOB — emit "blocks", a SINGLE ORDERED list covering the WHOLE day, start to finish:
1. KEEP EVERY STOP above, in the given order. For a LOCATED stop (has a venue) emit placement="anchor" and anchorId=<its ref> — we re-attach its exact venue. For an at-home / online stop emit placement="home" and taskId=<its ref>. Copy a FIXED stop's time verbatim and set flexibility="fixed"; leave startTime/endTime null for the rest (a router lays the clock down).
2. ADD the missing everyday scaffolding the errands don't include:${
    includeMorning
      ? ' OPEN at home with wake → get ready → breakfast (placement="home") STARTING at the day\'s start time;'
      : ''
  } place BREAKFAST/LUNCH/DINNER inside their windows honouring each preference (home → placement="home"; out → placement="find" near the neighbouring stops; a meal already covered by a stop is that stop — no duplicate);${
    args.context?.bedTime
      ? ` CLOSE with a calm wind-down then a SINGLE fixed "Sleep" block near ${args.context.bedTime}.`
      : ' end the day at a sensible time.'
  }
3. FILL open stretches of 20+ minutes with their own placement="home", kind="gap" block (a friendly title) instead of stretching activities or leaving dead air.
4. Only ADD genuinely new place-y blocks (e.g. a "dinner out" the user didn't have) as placement="find" with a SPECIFIC findQuery + area, or placement="venue" + userQuery when the user named one. Do NOT invent extra errands, and do NOT re-find or move the existing stops.
5. RESPECT the hard limits: fixed stop times stay put; everything active ENDS before the wind-down time; the day ends with one Sleep near bedtime.

RULES:
- placement="anchor" REQUIRES anchorId = one of the located refs above. placement="home" has no query (use taskId to keep an at-home stop). placement="find" REQUIRES findQuery. placement="venue" REQUIRES userQuery.
- NEVER emit coordinates and NEVER emit a "travel" block — travel is computed for you. Keep titles short and human ("Breakfast", "Wind down", "Gym session"), no times baked into the title.
- flexibility: "fixed" ONLY for a user-pinned time, a hard external commitment, and the single closing Sleep. "window" for meals / opening-hours-bound blocks. EVERYTHING else is "flexible".
- kind: best-fit ("work","meal","activity","break","gap","sightseeing","drinks","meetup","event","travel","other"). section: a short catchy headline grouping consecutive blocks ("Morning Reset","Wind Down"). period: Morning/Afternoon/Evening. description: 1 short sentence.
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
    responseSchema: FILL_SCHEMA,
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

/** Clamp + validate the model's blocks into the wire shape (same invariants as
 *  compose-itinerary, so the client's assembler can consume it unchanged). */
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
        detail: 'Set it via `supabase secrets set GEMINI_API_KEY=...` and redeploy.',
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

  const stops: StopInput[] = Array.isArray(payload.stops) ? payload.stops : [];
  const date = isISODate(payload.date) ? (payload.date as string) : todayISO();
  const now = isHHMM(payload.now) ? (payload.now as string) : undefined;
  const anchorIds = new Set<string>();
  stops.forEach((s, i) => {
    if (s.located) anchorIds.add(s.ref ?? `stop-${i}`);
  });

  const prompt = buildPrompt({
    stops,
    dayStart: payload.dayStart,
    dayEnd: payload.dayEnd,
    context: payload.context,
    home: payload.home,
    date,
    now,
  });

  let modelUsed = CONFIGURED_FILL_MODEL;
  let gem = await callGemini({
    prompt,
    apiKey: geminiKey,
    model: CONFIGURED_FILL_MODEL,
    thinkingBudget: FILL_THINKING_BUDGET,
  });
  if (!gem.ok && CONFIGURED_FILL_MODEL !== FALLBACK_FILL_MODEL) {
    console.warn(
      `fill-day: model "${CONFIGURED_FILL_MODEL}" failed (${gem.detail}); retrying with "${FALLBACK_FILL_MODEL}".`,
    );
    modelUsed = FALLBACK_FILL_MODEL;
    gem = await callGemini({
      prompt,
      apiKey: geminiKey,
      model: FALLBACK_FILL_MODEL,
      thinkingBudget: FILL_THINKING_BUDGET,
    });
  }
  if (!gem.ok) {
    return jsonResponse({ error: 'Fill failed', detail: gem.detail }, gem.status);
  }

  logTokenUsage({ fn: 'fill-day', step: 'fill', model: modelUsed, usage: gem.usage });

  return jsonResponse({
    blocks: shapeBlocks(gem.parsed, anchorIds),
    title: asStr(gem.parsed?.title, 120) ?? '',
    summary: asStr(gem.parsed?.summary, 400) ?? '',
    city: asStr(gem.parsed?.city, 80) ?? '',
    usage: { model: modelUsed, ...gem.usage },
  });
});
