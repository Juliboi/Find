// Supabase Edge Function: plan-day-v4
//
// The V4 planning brain — a deliberately ISOLATED, single-call experiment that
// sits next to compose-itinerary (v3) without touching it. The bet: let ONE
// strong, GROUNDED model (Gemini 3.x Flash + Google Search + high thinking) do
// almost the whole job in one shot — ORDER, TIMES, GAPS, and even an initial
// REAL venue pick for errands that have no place yet — and emit it as a small,
// flat list of blocks. Everything else stays deterministic downstream:
//   - the client GEOCODES the model's chosen venue names via Google Places
//     (model coords are never trusted), and
//   - the routing engine (recompute-itinerary) adds the real COMMUTE and
//     re-cascades the clock around the model's intended schedule.
//
// Why grounding here (and not in v3): v3 stays venue-agnostic and lets Google
// Places choose venues deterministically. V4 instead asks the model to PROPOSE
// real venues so the ORDER can reason about what's nearby ("gym in the centre →
// a pharmacy right after"). The proposal is a STARTING point — the client can
// be flipped to leave places empty for the user to choose later while keeping
// the model's order/alternatives (see V4_LET_AI_PICK_PLACES on the client).
//
// Grounding (google_search) cannot be combined with responseSchema, so we ask
// for JSON in the prompt and parse it defensively.
//
// Request body (mirrors compose-itinerary so the client can reuse its builders):
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
// Response body: { blocks: V4Block[], title, summary, city, usage }
//
// Required env vars:
//   GEMINI_API_KEY            — Google AI Studio key (shared).
//   GEMINI_V4_MODEL           — optional; defaults to gemini-3.5-flash.
//   GEMINI_V4_THINKING_LEVEL  — optional; Gemini 3.x reasoning depth
//                               (minimal|low|medium|high). Default 'low' to keep
//                               the call fast (high = ~100s ⇒ client timeouts).
//   GEMINI_V4_THINKING        — optional thinkingBudget for the 2.5 fallback
//                               (tokens, 0 disables, -1 dynamic). Default 2048.

// deno-lint-ignore-file no-explicit-any
// @ts-nocheck Deno runtime - types resolved by Supabase tooling at deploy time.

import { geminiUsage, logTokenUsage, type TokenUsage } from '../_shared/tokenLog.ts';

// One grounded, high-thinking model does the whole structure + venue reasoning.
// Default to the 3.x Flash tier (strong + grounding-capable); self-heal onto
// gemini-2.5-flash (also grounding-capable) if the primary model id isn't
// available so a single rename can't break the whole flow. Override with
// `supabase secrets set GEMINI_V4_MODEL=…`.
const DEFAULT_V4_MODEL = 'gemini-3.5-flash';
const CONFIGURED_V4_MODEL = Deno.env.get('GEMINI_V4_MODEL') ?? DEFAULT_V4_MODEL;
const FALLBACK_V4_MODEL = 'gemini-2.5-flash';

// Thinking control is MODEL-SPECIFIC:
//   - Gemini 3.x (the primary) uses `thinkingLevel` (minimal|low|medium|high).
//     CRITICAL: if you DON'T set it, Gemini 3 defaults to `high` (dynamic, max
//     depth) — which on a grounded full-day plan burns ~20k thinking tokens and
//     takes ~100s, so the mobile client times out and silently falls back to v2.
//     We default to `low` (minimises latency) so the call returns fast and
//     actually renders. Grounding is what does the heavy lifting here, not raw
//     thinking. Bump to `medium`/`high` via GEMINI_V4_THINKING_LEVEL if you want
//     deeper reasoning and can stomach the latency.
//   - Gemini 2.5 (the fallback) ignores `thinkingLevel`; it uses `thinkingBudget`
//     (a token count, 0 disables, -1 dynamic). Kept modest so the fallback is
//     also fast. Tune with GEMINI_V4_THINKING.
// You must NEVER send both on the same request (Gemini returns 400), so
// callGemini picks the right one per model.
const V4_THINKING_LEVELS = ['minimal', 'low', 'medium', 'high'];
const DEFAULT_V4_THINKING_LEVEL = 'low';
const V4_THINKING_LEVEL = (() => {
  const raw = (Deno.env.get('GEMINI_V4_THINKING_LEVEL') ?? '').trim().toLowerCase();
  return V4_THINKING_LEVELS.includes(raw) ? raw : DEFAULT_V4_THINKING_LEVEL;
})();

const DEFAULT_V4_THINKING_BUDGET = 2048;
function parseThinkingBudget(): number {
  const raw = Deno.env.get('GEMINI_V4_THINKING');
  if (raw == null || raw.trim() === '') return DEFAULT_V4_THINKING_BUDGET;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.round(n) : DEFAULT_V4_THINKING_BUDGET;
}
const V4_THINKING_BUDGET = parseThinkingBudget();

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

/** Pull the first balanced-looking JSON object out of a grounded response that
 *  may carry prose, citations, or ```json fences around it. */
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

/** Onboarding rhythm lines so the brain opens with the right morning routine,
 *  honours meal windows/prefs, and closes with wind-down → sleep. */
function describeContext(ctx: any, includeMorning: boolean): string {
  if (!ctx || typeof ctx !== 'object') return '';
  const lines: string[] = [];
  if (ctx.home?.label) lines.push(`- Home base: ${ctx.home.label}.`);
  if (includeMorning && ctx.wakeTime) {
    lines.push(
      `- MORNING ROUTINE — the very FIRST blocks, AT HOME (place=null), fixed=true, back-to-back: a "Wake up" block starting EXACTLY ${ctx.wakeTime}${
        ctx.wakeUpDurationMin ? `, then "Get ready" (~${ctx.wakeUpDurationMin} min)` : ''
      }, then BREAKFAST immediately after. Schedule NOTHING before ${ctx.wakeTime} and wedge NOTHING between these; the rest of the day only begins once breakfast ends.`,
    );
  }
  if (ctx.bedTime) {
    lines.push(
      `- Winds down around ${ctx.windDownTime ?? ctx.bedTime} and sleeps ~${ctx.bedTime}; CLOSE the day with a calm wind-down then ONE fixed Sleep block near ${ctx.bedTime}.`,
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
      let pref = ' → your call (home vs out)';
      if (w.venue) {
        pref = ` → at ${w.venue} (the user's OWN errand — treat THAT errand as this meal; add no separate ${name})`;
      } else if (w.mode === 'home') {
        pref = ' → AT HOME (place=null, no venue)';
      } else if (w.mode === 'out') {
        pref = ' → OUT (pick a real spot near the route at that time)';
      }
      parts.push(`${name} ${win}${pref}`);
    }
    if (parts.length) {
      lines.push(`- Meals: ${parts.join('; ')}. Start each meal inside its window and honour its preference.`);
    }
  }
  if (ctx.windDownTime) {
    lines.push(
      `- Be HOME and winding down by ${ctx.windDownTime}: every out-and-about block AND the trip home must FINISH before ${ctx.windDownTime}; after it ONLY calm at-home activities (reading, skincare, stretching).${
        ctx.allowScreenWindDown === false ? ' Avoid screen-heavy wind-down.' : ''
      }`,
    );
  }
  if (ctx.car && typeof ctx.car === 'object') {
    lines.push(
      ctx.car.owns && ctx.car.useToday
        ? '- Has a car today (a slightly wider radius is OK), but keep short hops walkable.'
        : '- No car today — keep venues close and clustered for walking/transit.',
    );
  }
  if (Array.isArray(ctx.dietary) && ctx.dietary.length) {
    lines.push(`- Dietary: ${ctx.dietary.join(', ')}${ctx.dietaryNotes ? ` (${ctx.dietaryNotes})` : ''}.`);
  }
  return lines.join('\n');
}

function fmtWhen(s?: string | null, e?: string | null, dur?: number | null): string {
  if (s) {
    return e ? ` — PINNED ${s}–${e} (do NOT move)` : ` — PINNED to start ${s} (do NOT move)`;
  }
  if (e) return ` — must be DONE by ${e}`;
  return dur ? ` (~${dur} min)` : '';
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
          const note = a.notes ? ` — ${a.notes}` : '';
          return `  - id="${id}": "${a.title ?? 'Stop'}" @ ${a.name ?? 'located'}${coord}${fmtWhen(
            a.startTime,
            a.endTime,
            a.durationMin,
          )}${note}`;
        })
        .join('\n')
    : '  (none)';

  const taskLines = args.tasks.length
    ? args.tasks
        .map((t, i) => {
          const id = t.id ?? `task-${i}`;
          const atHome = t.atHome ? ' — AT-HOME / ONLINE (no venue)' : '';
          const note = t.notes ? ` — ${t.notes}` : '';
          return `  - id="${id}": "${t.title ?? ''}"${fmtWhen(
            t.startTime,
            t.endTime,
            t.durationMin,
          )}${atHome}${note}`;
        })
        .join('\n')
    : '  (none)';

  const frameBits = [
    args.dayStart?.time ? `starts ~${args.dayStart.time}` : '',
    args.dayStart?.label ? `from ${args.dayStart.label}` : '',
    args.dayEnd?.time ? `finishes by ~${args.dayEnd.time}` : '',
    args.dayEnd?.label ? `at ${args.dayEnd.label}` : '',
  ].filter(Boolean);
  const frameLine = frameBits.length ? `Day frame: ${frameBits.join(', ')}.` : '';
  const ctxLines = describeContext(args.context, includeMorning);
  const nowLine = dayUnderway
    ? `RIGHT NOW it is ${args.now} on ${args.date}: the day is ALREADY UNDERWAY — plan ONLY what still lies ahead (at/after ${args.now}); do not replay the past.`
    : '';

  return `You are an expert personal day planner. In ONE pass, lay out the user's whole day: decide the ORDER, the TIMES (start+end of every block), the GAPS (free time), and — only for an errand that has NO place yet — pick a REAL venue using Google Search. Be realistic and efficient. Output ONLY a JSON object (no prose, no markdown fences).

TODAY is ${args.date}${weekday ? ` (${weekday})` : ''}.${home ? ` Home base: ${home}.` : ''}
${frameLine}
${nowLine}
${ctxLines}

ALREADY-LOCATED STOPS (real coordinates — keep their place; this is the geographic backbone):
${anchorLines}

ERRANDS WITHOUT A PLACE / COMMITMENTS (schedule each; give place-y ones a real venue, keep at-home ones place-less):
${taskLines}

FREE-TEXT (the user's own words):
"""
${args.intent || '(none)'}
"""

OUTPUT this exact JSON shape (no summary, no per-block descriptions — keep it minimal):
{
  "title": "<= 6 word day title",
  "city": "<main city>",
  "blocks": [
    {
      "ref": "<the id from the lists above that this block IS, or null>",
      "title": "<short, human, no times in it>",
      "kind": "work|meal|activity|errand|break|gap|sightseeing|drinks|meetup|event|other",
      "start": "HH:MM",
      "end": "HH:MM",
      "fixed": true|false,
      "place": "<real venue name you chose for a place-less errand, else null>",
      "area": "<that venue's neighbourhood/district, else null>",
      "alts": ["<up to 2 other real nearby venues that would also fit, else empty>"]
    }
  ]
}

RULES (do most of the job; keep instructions you don't need out):
1. Cover the WHOLE day in clock order with NO overlaps. Give EVERY block a "start" and "end". Leave realistic gaps for travel between distant stops — never schedule far-apart things back-to-back.
2. Include EVERY located stop and EVERY errand above exactly once, referencing it by its id in "ref". Keep a located stop's existing place (set place=null — we already have it). Copy any PINNED time verbatim and set fixed=true for it.
3. Split the FREE-TEXT into separate activities and add each as its own block (ref=null).
4. Add the everyday-life blocks the errands don't cover: ${
    includeMorning ? 'wake → get ready → breakfast at the start; ' : ''
  }lunch & dinner inside their windows (honour home/out prefs)${
    args.context?.bedTime ? '; a wind-down then ONE fixed "Sleep" block near bedtime' : ''
  }. Don't invent errands the user didn't mention.
5. ORDER GEOGRAPHICALLY: cluster blocks by neighbourhood, no zig-zag across town; start near the start location and finish near the end location.
6. PLACES — only for an errand/activity with no place that happens at a business: use Google Search to choose ONE real, currently-open, well-rated venue that fits the ORDER and neighbourhood (e.g. a pharmacy right after a city-centre gym you're already at; a standalone gym/groceries/pharmacy → near home). Put it in "place", its district in "area", and up to 2 more real nearby options in "alts". At-home/online/self-care/meal-at-home/gap blocks → place=null, alts=[].
7. GAPS / BREATHING ROOM (place=null, kind:"gap"): add one for genuine FREE / REST time of 20+ min (a breather, downtime, relaxing, freshening up) so the day breathes. AND when a stop is OPEN-ENDED and meant to be SAVOURED — exploring a neighbourhood, a market, a park, a museum, sightseeing, a long leisurely meal — either give it an unhurried duration OR add a short trailing gap after it, so the user isn't rushed. Do this ONLY where it makes sense: do NOT pad TRANSACTIONAL stops (appointments, quick errands, pickups, online tasks) — leave their timing to their own start/end window. NEVER use a gap (or any block) to represent getting between places — that is travel, see rule 9.
8. fixed=true ONLY for: a pinned time, a hard appointment/reservation/class, the morning wake routine above, and the single closing Sleep. Everything else fixed=false.
9. NEVER create a block for travel/commute/transit (not titled "Travel to…", "Commute home", "Drive to…", etc., and not as a gap) and NEVER output coordinates — the app draws every door-to-door commute itself afterward. Just place consecutive stops; leave the travel time BETWEEN them implicit. Keep titles short.`;
}

// ----------------------------------------------------------- Gemini call

async function callGemini(args: {
  prompt: string;
  apiKey: string;
  model: string;
  thinkingLevel: string;
  thinkingBudget: number;
}): Promise<
  | { ok: true; parsed: any; usage: TokenUsage }
  | { ok: false; status: number; detail: string }
> {
  // Gemini 3.x → thinkingLevel; Gemini 2.5 → thinkingBudget. Sending both is a
  // 400, so branch on the model. For 3.x we also DON'T set temperature/top_p —
  // Google explicitly tunes Gemini 3 for its defaults.
  const isGemini3 = /gemini-3/i.test(args.model);
  const generationConfig: Record<string, unknown> = {};
  if (isGemini3) {
    generationConfig.thinkingConfig = { thinkingLevel: args.thinkingLevel };
  } else {
    generationConfig.temperature = 0.3;
    if (args.thinkingBudget === -1 || args.thinkingBudget > 0) {
      generationConfig.thinkingConfig = { thinkingBudget: args.thinkingBudget };
    }
  }
  const body = {
    contents: [{ role: 'user', parts: [{ text: args.prompt }] }],
    // Google Search grounding — the "web" step that lets the model name REAL
    // venues. Incompatible with responseSchema, so the prompt carries the shape.
    tools: [{ google_search: {} }],
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

const KINDS = new Set([
  'work',
  'meal',
  'activity',
  'errand',
  'break',
  'gap',
  'sightseeing',
  'drinks',
  'meetup',
  'event',
  'travel',
  'other',
]);

/** Validate the model's blocks into the compact wire shape the client expects.
 *  Order is preserved; gaps are coerced place-less; alts capped at 2. */
function shapeBlocks(parsed: any, validRefs: Set<string>): any[] {
  const raw = Array.isArray(parsed?.blocks) ? parsed.blocks : [];
  const out: any[] = [];
  for (const b of raw) {
    if (!b || typeof b !== 'object') continue;
    const title = asStr(b.title, 120);
    if (!title) continue;

    const kind = asStr(b.kind, 24);
    const ref = asStr(b.ref, 80);
    const start = normalizeHHMM(b.start);
    let end = normalizeHHMM(b.end);
    if (start && end && end < start) end = null;

    // A gap is never a venue; a referenced/located block keeps its own place.
    const isGap = kind === 'gap';
    const place = isGap ? null : asStr(b.place, 120);
    const area = place ? asStr(b.area, 80) : null;
    const altsRaw = Array.isArray(b.alts) ? b.alts : [];
    const alts: string[] = [];
    for (const a of altsRaw) {
      const s = asStr(a, 120);
      if (s && s.toLowerCase() !== (place ?? '').toLowerCase()) alts.push(s);
      if (alts.length >= 2) break;
    }

    out.push({
      ref: ref && validRefs.has(ref) ? ref : null,
      title,
      kind: kind && KINDS.has(kind) ? kind : 'other',
      start,
      end,
      fixed: b.fixed === true,
      place: place && !isGap ? place : null,
      area,
      alts: place && !isGap ? alts : [],
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
  // Nothing to plan → empty (client falls back to its other pipelines).
  if (!intent && anchors.length === 0 && tasks.length === 0) {
    return jsonResponse({ blocks: [], title: '', summary: '', city: '' });
  }

  const date = isISODate(payload.date) ? (payload.date as string) : todayISO();
  const now = isHHMM(payload.now) ? (payload.now as string) : undefined;
  const validRefs = new Set<string>();
  anchors.forEach((a, i) => validRefs.add(a.id ?? `anchor-${i}`));
  tasks.forEach((t, i) => validRefs.add(t.id ?? `task-${i}`));

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

  let modelUsed = CONFIGURED_V4_MODEL;
  let gem = await callGemini({
    prompt,
    apiKey: geminiKey,
    model: CONFIGURED_V4_MODEL,
    thinkingLevel: V4_THINKING_LEVEL,
    thinkingBudget: V4_THINKING_BUDGET,
  });
  if (!gem.ok && CONFIGURED_V4_MODEL !== FALLBACK_V4_MODEL) {
    console.warn(
      `plan-day-v4: model "${CONFIGURED_V4_MODEL}" failed (${gem.detail}); retrying with "${FALLBACK_V4_MODEL}".`,
    );
    modelUsed = FALLBACK_V4_MODEL;
    gem = await callGemini({
      prompt,
      apiKey: geminiKey,
      model: FALLBACK_V4_MODEL,
      thinkingLevel: V4_THINKING_LEVEL,
      thinkingBudget: V4_THINKING_BUDGET,
    });
  }
  if (!gem.ok) {
    return jsonResponse({ error: 'Plan failed', detail: gem.detail }, gem.status);
  }

  logTokenUsage({ fn: 'plan-day-v4', step: 'brain', model: modelUsed, usage: gem.usage });

  return jsonResponse({
    blocks: shapeBlocks(gem.parsed, validRefs),
    title: asStr(gem.parsed?.title, 120) ?? '',
    summary: '', // intentionally dropped — the rail shows no description (saves tokens)
    city: asStr(gem.parsed?.city, 80) ?? '',
    usage: { model: modelUsed, ...gem.usage },
  });
});
