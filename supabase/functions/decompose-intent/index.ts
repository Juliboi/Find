// Supabase Edge Function: decompose-intent
//
// The planning BRAIN. Before the base planner ever runs, this turns the
// planner's free-text field (and any vague / no-place errands) into a small set
// of well-formed, neighbourhood-aware errand ITEMS the client can resolve
// through the normal discover / auto-place pipeline. It does the spatial
// reasoning the cheap parser can't: it reads the day's already-LOCATED errands
// as fixed geography and clusters the flexible asks into the right area
// ("go to a max fitness gym" → "Max Fitness gym, Karlín, Prague"), co-locates
// compatible activities onto an existing stop ("deep work" → the café you
// already have), and keeps at-home items (skincare, reading) place-less.
//
// Unlike parse-errand (one cheap line → one errand), this is MULTI-ITEM and
// runs the stronger "brain" tier (gemini-2.5-flash + a thinking budget) because
// the positioning/clustering judgement is the whole point. Output is small, so
// cost stays low. Like parse-errand we force structured output via a
// responseSchema (guaranteed parseable JSON) and self-heal onto a known-good
// model if the configured one ever fails.
//
// Request body:
//   {
//     intent: string,                       // the free-text field
//     anchors?: [{ id, title, area?, address?, latitude?, longitude? }],
//     unresolved?: [{ id, title, placeQuery? }],
//     dayStart?: { time?, label? },
//     dayEnd?: { time?, label? },
//     context?: { ...profile... },          // buildContextPayload output
//     home?: { label, latitude, longitude },
//     date?: "YYYY-MM-DD"
//   }
//
// Response body: { items: DecomposedItem[], usage }
//
// Required env vars:
//   GEMINI_API_KEY        — Google AI Studio key (same one plan-itinerary uses).
//   GEMINI_BRAIN_MODEL    — optional override; defaults to gemini-2.5-flash.
//   GEMINI_BRAIN_THINKING — optional thinking budget (tokens, or -1 dynamic).

// deno-lint-ignore-file no-explicit-any
// @ts-nocheck Deno runtime - types resolved by Supabase tooling at deploy time.

import { geminiUsage, logTokenUsage, type TokenUsage } from '../_shared/tokenLog.ts';

// The "brain" tier: capable enough to reason about geography and clustering.
// Override with `supabase secrets set GEMINI_BRAIN_MODEL=…`.
const DEFAULT_BRAIN_MODEL = 'gemini-2.5-flash';
const CONFIGURED_BRAIN_MODEL =
  Deno.env.get('GEMINI_BRAIN_MODEL') ?? DEFAULT_BRAIN_MODEL;
// If the brain model fails, fall back to the cheap/fast lite tier (no thinking)
// rather than failing the whole plan — the client also degrades gracefully to
// today's "free-text as STYLE/NOTES" behaviour if even this returns nothing.
const FALLBACK_BRAIN_MODEL = 'gemini-2.5-flash-lite';

// Thinking budget for the brain model. "High thinking" by default (dynamic: the
// model decides how much to think), since the positioning judgement is the
// whole value here and the output is tiny. Set a positive token budget to cap
// it, or 0 to disable. Parsed from env so it's tunable without a redeploy.
function parseThinkingBudget(): number {
  const raw = Deno.env.get('GEMINI_BRAIN_THINKING');
  if (raw == null || raw.trim() === '') return -1; // dynamic
  const n = Number(raw);
  return Number.isFinite(n) ? Math.round(n) : -1;
}
const BRAIN_THINKING_BUDGET = parseThinkingBudget();

// Gemini structured-output schema (a subset of OpenAPI). Each item is ONE stop
// the client will turn into an errand. `placement` decides how it gets a
// location: find a venue from `query`, co-locate onto an existing anchor
// (`colocateWith`), or stay at home (no place).
const DECOMPOSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'placement'],
        propertyOrdering: [
          'title',
          'kind',
          'durationMin',
          'startTime',
          'endTime',
          'placement',
          'query',
          'area',
          'colocateWith',
          'sourceId',
          'notes',
        ],
        properties: {
          title: { type: 'string' },
          kind: {
            type: 'string',
            format: 'enum',
            enum: [
              'work',
              'meal',
              'activity',
              'errand',
              'break',
              'sightseeing',
              'drinks',
              'meetup',
              'event',
              'other',
            ],
          },
          durationMin: { type: 'integer', nullable: true },
          startTime: { type: 'string', nullable: true },
          endTime: { type: 'string', nullable: true },
          // How this item gets a location:
          //   find     → search a real venue using `query` (+ `area`)
          //   colocate → share the venue of the anchor/item named in `colocateWith`
          //   home     → no venue (skincare, reading, a nap, a call)
          placement: { type: 'string', format: 'enum', enum: ['find', 'colocate', 'home'] },
          query: { type: 'string', nullable: true },
          area: { type: 'string', nullable: true },
          colocateWith: { type: 'string', nullable: true },
          sourceId: { type: 'string', nullable: true },
          notes: { type: 'string', nullable: true },
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

function isISODate(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.trim());
}

function normalizeHHMM(v: unknown): string | null {
  if (!isHHMM(v)) return null;
  const [h, m] = (v as string).trim().split(':').map(Number);
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
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

// ----------------------------------------------------------- prompt

interface AnchorInput {
  id?: string;
  title?: string;
  area?: string;
  address?: string;
  latitude?: number;
  longitude?: number;
}
interface UnresolvedInput {
  id?: string;
  title?: string;
  placeQuery?: string;
  notes?: string;
}

function describeContext(ctx: any): string {
  if (!ctx || typeof ctx !== 'object') return '';
  const lines: string[] = [];
  if (ctx.home?.label) lines.push(`- Home base: ${ctx.home.label}.`);
  if (ctx.wakeTime || ctx.bedTime) {
    lines.push(
      `- Rhythm: ${ctx.wakeTime ? `wakes ~${ctx.wakeTime}` : 'wakes in the morning'}, ${
        ctx.bedTime ? `winds down ~${ctx.bedTime}` : 'ends in the evening'
      }.`,
    );
  }
  const meals = ctx.meals;
  if (meals && typeof meals === 'object') {
    const parts: string[] = [];
    for (const name of ['breakfast', 'lunch', 'dinner']) {
      const w = meals[name];
      if (w && (w.start || w.end)) {
        parts.push(`${name} ${w.start ?? ''}${w.start && w.end ? '–' : ''}${w.end ?? ''}`.trim());
      }
    }
    if (parts.length) lines.push(`- Meal windows: ${parts.join('; ')}.`);
  }
  if (ctx.car && typeof ctx.car === 'object') {
    lines.push(
      ctx.car.owns && ctx.car.useToday
        ? '- Has a car available today (so a slightly wider radius is fine).'
        : '- No car today — keep flexible venues close and clustered for walking/transit.',
    );
  }
  if (Array.isArray(ctx.dietary) && ctx.dietary.length) {
    lines.push(`- Dietary: ${ctx.dietary.join(', ')}.`);
  }
  return lines.join('\n');
}

function buildPrompt(args: {
  intent: string;
  anchors: AnchorInput[];
  unresolved: UnresolvedInput[];
  dayStart?: { time?: string; label?: string };
  dayEnd?: { time?: string; label?: string };
  context?: any;
  home?: { label?: string };
  date: string;
}): string {
  const weekday = weekdayOf(args.date);
  const home = args.home?.label ?? args.context?.home?.label;

  const anchorLines = args.anchors.length
    ? args.anchors
        .map((a, i) => {
          const id = a.id ?? `anchor-${i}`;
          const where = a.area ?? a.address ?? 'located';
          const coord =
            typeof a.latitude === 'number' && typeof a.longitude === 'number'
              ? ` [${a.latitude.toFixed(4)}, ${a.longitude.toFixed(4)}]`
              : '';
          return `  - id="${id}": "${a.title ?? 'Stop'}" @ ${where}${coord}`;
        })
        .join('\n')
    : '  (none — there are no already-located stops to cluster around)';

  const unresolvedLines = args.unresolved.length
    ? args.unresolved
        .map((u, i) => {
          const id = u.id ?? `errand-${i}`;
          const hint = u.placeQuery ? ` (current hint: "${u.placeQuery}")` : '';
          const note = u.notes ? ` — notes: "${u.notes}"` : '';
          return `  - id="${id}": "${u.title ?? ''}"${hint}${note}`;
        })
        .join('\n')
    : '  (none)';

  const frameBits = [
    args.dayStart?.time ? `heads out ~${args.dayStart.time}` : '',
    args.dayStart?.label ? `from ${args.dayStart.label}` : '',
    args.dayEnd?.time ? `finishes by ~${args.dayEnd.time}` : '',
  ].filter(Boolean);
  const frameLine = frameBits.length ? `Day frame: ${frameBits.join(', ')}.` : '';
  const ctxLines = describeContext(args.context);

  return `You are the PLANNING BRAIN. You turn a user's loose, free-text day description plus any vague errands into a small list of concrete, well-formed ITEMS that a downstream system will place on a map and schedule. Output ONLY a JSON object matching the schema.

TODAY is ${args.date}${weekday ? ` (${weekday})` : ''}.${home ? ` Home base: ${home}.` : ''}
${frameLine}
${ctxLines}

ALREADY-LOCATED STOPS (fixed geography — do NOT re-emit these; cluster everything else around them):
${anchorLines}

VAGUE / UNPLACED ERRANDS (re-emit each as one item with sourceId set, giving it a much better, neighbourhood-aware query):
${unresolvedLines}

FREE-TEXT TO DECOMPOSE (the user's own words):
"""
${args.intent || '(none)'}
"""

YOUR JOB — produce "items", each a single real stop or at-home activity:
1. SPLIT the free text into discrete activities. "deep work 2 hours at a cafe, language learning 1.5h, skincare, read before sleep, go to a max fitness gym" is FIVE-ish activities, not one.
2. POSITION flexible venues in the RIGHT neighbourhood. Look at the already-located stops + home: pick the area where the day is clearly happening and write a SPECIFIC, geocodable query that names the area, e.g. user said "go to a max fitness gym" and the day is around Karlín → query "Max Fitness gym, Karlín, Prague", area "Karlín". Keep the brand/specifics the user gave. Do NOT invent a venue name the user didn't give — name the CATEGORY + brand + area so a places search can find the real branch.
3. CO-LOCATE compatible activities. If an activity naturally happens at a stop that ALREADY exists in the located list (e.g. "deep work" or "prepare marketing" when there's a café anchor), set placement="colocate" and colocateWith=<that anchor's id>; do NOT give it its own query. Leave its query null.
4. MERGE activities that obviously share ONE venue into a SINGLE item with a combined title (e.g. "drink coffee" + "tiktok reels & marketing prep" → one item titled "Coffee & content prep", placement="find", query a café in the day's area). Prefer merging over creating two items at the same place.
5. AT-HOME / no-venue activities → placement="home", query null. These have no place; the planner schedules them at home. This covers self-care (skincare, reading before sleep, a nap, journaling, stretching) AND anything ONLINE / REMOTE: a video or phone call, telehealth or online therapy, remote work, a virtual class or webinar. If an activity's words (title OR notes) say online / virtual / remote / zoom / meet / teams / video call / phone call / by phone, it has NO venue — ALWAYS placement="home", NEVER "find", even if a clock time is given.
6. For each VAGUE ERRAND listed above, RE-EMIT it as one item: set sourceId to its id, keep its meaning, and upgrade its query to a specific neighbourhood-aware one (placement="find"), or placement="home" if it's truly place-less.
7. durationMin: convert explicit lengths ("2 hours"→120, "1.5h"→90, "45 min"→45); else null.
8. startTime/endTime: LEAVE NULL unless the user gave an explicit clock time — the downstream planner decides timing. "HH:MM" 24h when set.
9. kind: best-fit category ("work","meal","activity","errand","break","sightseeing","drinks","meetup","event","other").

RULES:
- placement="find" REQUIRES a non-empty query. placement="colocate" REQUIRES colocateWith pointing at a real id from the located list above. placement="home" has no query and no colocateWith.
- Never re-emit an already-located stop as its own item.
- Keep titles short and human ("Deep work", "Gym session", "Skincare"), without times/areas baked in.
- If the free text is empty AND there are no vague errands, return an empty items array.

EXAMPLE (located stop id="a1" is "Coffee" @ Karlín café; user free text "deep work 2 hours at a cafe, language learning 1.5h, skincare, read before sleep, go to a max fitness gym, tiktok reels & marketing prep"):
{"items":[
{"title":"Deep work","kind":"work","durationMin":120,"startTime":null,"endTime":null,"placement":"colocate","query":null,"area":null,"colocateWith":"a1","sourceId":null,"notes":null},
{"title":"Content prep","kind":"work","durationMin":null,"startTime":null,"endTime":null,"placement":"colocate","query":null,"area":null,"colocateWith":"a1","sourceId":null,"notes":"tiktok reels & marketing"},
{"title":"Language learning","kind":"activity","durationMin":90,"startTime":null,"endTime":null,"placement":"home","query":null,"area":"Karlín","colocateWith":null,"sourceId":null,"notes":null},
{"title":"Gym session","kind":"activity","durationMin":null,"startTime":null,"endTime":null,"placement":"find","query":"Max Fitness gym, Karlín, Prague","area":"Karlín","colocateWith":null,"sourceId":null,"notes":null},
{"title":"Skincare","kind":"break","durationMin":null,"startTime":null,"endTime":null,"placement":"home","query":null,"area":null,"colocateWith":null,"sourceId":null,"notes":null},
{"title":"Read before sleep","kind":"break","durationMin":null,"startTime":null,"endTime":null,"placement":"home","query":null,"area":null,"colocateWith":null,"sourceId":null,"notes":null}
]}`;
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
    temperature: 0.2,
    responseMimeType: 'application/json',
    responseSchema: DECOMPOSE_SCHEMA,
  };
  // Only attach a thinking config when we actually want thinking (>0 or dynamic
  // -1). A budget of exactly 0 disables thinking (the fallback path).
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

/** Clamp + validate the model's items into the wire shape the client expects. */
function shapeItems(parsed: any, anchorIds: Set<string>): any[] {
  const rawItems = Array.isArray(parsed?.items) ? parsed.items : [];
  const out: any[] = [];
  for (const raw of rawItems) {
    if (!raw || typeof raw !== 'object') continue;
    const title = asStr(raw.title, 120);
    if (!title) continue;

    let placement: 'find' | 'colocate' | 'home' =
      raw.placement === 'colocate'
        ? 'colocate'
        : raw.placement === 'home'
          ? 'home'
          : 'find';
    let query = asStr(raw.query, 160);
    let colocateWith = asStr(raw.colocateWith, 80);

    // Validate placement consistency, degrading to a sane shape rather than
    // dropping the item (so the activity still lands in the day).
    if (placement === 'colocate' && (!colocateWith || !anchorIds.has(colocateWith))) {
      // Co-location pointed at nothing real — fall back to finding a venue if we
      // have a query, otherwise treat it as an at-home activity.
      placement = query ? 'find' : 'home';
      colocateWith = null;
    }
    if (placement === 'find' && !query) {
      // "find" with no query is useless — keep the activity as an at-home block.
      placement = 'home';
    }
    if (placement !== 'colocate') colocateWith = null;
    if (placement !== 'find') query = null;

    const start = normalizeHHMM(raw.startTime);
    let end = normalizeHHMM(raw.endTime);
    if (!start) end = null;
    const durRaw = asNum(raw.durationMin);
    const durationMin = durRaw != null && durRaw > 0 ? Math.round(durRaw) : null;

    out.push({
      title,
      kind: asStr(raw.kind, 24) ?? 'other',
      durationMin,
      startTime: start,
      endTime: end,
      placement,
      query,
      area: asStr(raw.area, 80),
      colocateWith,
      sourceId: asStr(raw.sourceId, 80),
      notes: asStr(raw.notes, 280),
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
  const unresolved: UnresolvedInput[] = Array.isArray(payload.unresolved)
    ? payload.unresolved
    : [];
  // Nothing to reason about → return an empty list (the client falls back to its
  // existing behaviour). Avoids spending a brain call on an empty ask.
  if (!intent && unresolved.length === 0) {
    return jsonResponse({ items: [] });
  }

  const date = isISODate(payload.date) ? (payload.date as string) : todayISO();
  const anchorIds = new Set<string>();
  anchors.forEach((a, i) => anchorIds.add(a.id ?? `anchor-${i}`));

  const prompt = buildPrompt({
    intent,
    anchors,
    unresolved,
    dayStart: payload.dayStart,
    dayEnd: payload.dayEnd,
    context: payload.context,
    home: payload.home,
    date,
  });

  let modelUsed = CONFIGURED_BRAIN_MODEL;
  let gem = await callGemini({
    prompt,
    apiKey: geminiKey,
    model: CONFIGURED_BRAIN_MODEL,
    thinkingBudget: BRAIN_THINKING_BUDGET,
  });
  if (!gem.ok && CONFIGURED_BRAIN_MODEL !== FALLBACK_BRAIN_MODEL) {
    console.warn(
      `decompose-intent: model "${CONFIGURED_BRAIN_MODEL}" failed (${gem.detail}); retrying with "${FALLBACK_BRAIN_MODEL}".`,
    );
    modelUsed = FALLBACK_BRAIN_MODEL;
    // Drop thinking on the fallback for max reliability/speed.
    gem = await callGemini({
      prompt,
      apiKey: geminiKey,
      model: FALLBACK_BRAIN_MODEL,
      thinkingBudget: 0,
    });
  }
  if (!gem.ok) {
    return jsonResponse({ error: 'Decompose failed', detail: gem.detail }, gem.status);
  }

  logTokenUsage({ fn: 'decompose-intent', step: 'brain', model: modelUsed, usage: gem.usage });

  return jsonResponse({
    items: shapeItems(gem.parsed, anchorIds),
    usage: { model: modelUsed, ...gem.usage },
  });
});
