// Supabase Edge Function: order-day  (V3 pipeline — Phase 2)
//
// The CHEAP ordering brain. It does ONE thing: given the day's errands trimmed
// to the geography-relevant fields (name, any fixed time, address / area /
// category, located?) plus the day frame (where/when it starts & ends), it
// returns the best GEOGRAPHIC ORDER — and nothing else.
//
//   - NO venues (those are resolved deterministically downstream by Google).
//   - NO clock (the routing engine lays the real times down later).
//   - NO scaffolding (wake / meals / sleep are added by the heavier `fill-day`).
//
// Keeping this pass tiny (minimal input, ids-only output) is the whole point:
// it's the token-light "in what order should I do these?" decision, so it can
// run on the smallest model. The client reconciles the returned ids against the
// real set, so a drift can never drop or invent an errand.
//
// Request body:
//   {
//     errands: [{ id, title, startTime?, endTime?, durationMin?, address?,
//                 located }],
//     dayStart?: { time?, label? },
//     dayEnd?:   { time?, label? },
//     home?: { label? },
//     date?: "YYYY-MM-DD"
//   }
//
// Response body: { order: string[], title, summary, city, usage }
//
// Required env vars:
//   GEMINI_API_KEY          — Google AI Studio key (shared).
//   GEMINI_ORDER_MODEL      — optional; defaults to gemini-3.1-flash-lite.
//   GEMINI_ORDER_THINKING   — optional thinking budget (tokens, 0, or -1).

// deno-lint-ignore-file no-explicit-any
// @ts-nocheck Deno runtime - types resolved by Supabase tooling at deploy time.

import { geminiUsage, logTokenUsage, type TokenUsage } from '../_shared/tokenLog.ts';

// The ordering decision is small and structured, so it runs on the lite tier.
// Override with `supabase secrets set GEMINI_ORDER_MODEL=…`.
const DEFAULT_ORDER_MODEL = 'gemini-3.1-flash-lite';
const CONFIGURED_ORDER_MODEL = Deno.env.get('GEMINI_ORDER_MODEL') ?? DEFAULT_ORDER_MODEL;
const FALLBACK_ORDER_MODEL = 'gemini-2.5-flash';

// A small bounded budget: ordering ~a dozen stops needs a little reasoning but
// nowhere near the full day-compose budget. Tune with GEMINI_ORDER_THINKING.
const DEFAULT_ORDER_THINKING = 256;
function parseThinkingBudget(): number {
  const raw = Deno.env.get('GEMINI_ORDER_THINKING');
  if (raw == null || raw.trim() === '') return DEFAULT_ORDER_THINKING;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.round(n) : DEFAULT_ORDER_THINKING;
}
const ORDER_THINKING_BUDGET = parseThinkingBudget();

const ORDER_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['order'],
  propertyOrdering: ['title', 'summary', 'city', 'order'],
  properties: {
    title: { type: 'string' },
    summary: { type: 'string' },
    city: { type: 'string' },
    // The errand ids, earliest-first.
    order: { type: 'array', items: { type: 'string' } },
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
function isISODate(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.trim());
}
function asStr(v: unknown, max = 200): string | null {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
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

interface ErrandInput {
  id?: string;
  title?: string;
  startTime?: string;
  endTime?: string;
  durationMin?: number;
  address?: string;
  located?: boolean;
}

function describeErrand(e: ErrandInput, i: number): string {
  const id = e.id ?? `errand-${i}`;
  const bits: string[] = [];
  if (e.located) {
    bits.push(`LOCATED${e.address ? ` @ ${e.address}` : ''}`);
  } else if (e.address) {
    bits.push(`@ ${e.address}`);
  } else {
    bits.push('no place');
  }
  if (isHHMM(e.startTime)) {
    bits.push(
      isHHMM(e.endTime) ? `FIXED ${e.startTime}–${e.endTime}` : `FIXED at ${e.startTime}`,
    );
  } else if (e.durationMin) {
    bits.push(`~${e.durationMin} min`);
  }
  return `  - id="${id}": "${e.title ?? 'Errand'}" (${bits.join(', ')})`;
}

function buildPrompt(args: {
  errands: ErrandInput[];
  dayStart?: { time?: string; label?: string };
  dayEnd?: { time?: string; label?: string };
  home?: { label?: string };
  date: string;
}): string {
  const weekday = weekdayOf(args.date);
  const home = args.home?.label;
  const frameBits = [
    args.dayStart?.time ? `starts ~${args.dayStart.time}` : '',
    args.dayStart?.label ? `from ${args.dayStart.label}` : '',
    args.dayEnd?.time ? `ends ~${args.dayEnd.time}` : '',
    args.dayEnd?.label ? `at ${args.dayEnd.label}` : '',
  ].filter(Boolean);
  const frameLine = frameBits.length ? `Day frame: ${frameBits.join(', ')}.` : '';
  const errandLines = args.errands.map(describeErrand).join('\n');

  return `You are the ORDERING step of a personal day planner. Your ONLY job is to decide the best ORDER to do the user's errands in — a smooth, realistic route with NO back-and-forth across town. You do NOT pick venues, set times, or add anything. Output ONLY a JSON object matching the schema.

TODAY is ${args.date}${weekday ? ` (${weekday})` : ''}.${home ? ` Home base: ${home}.` : ''}
${frameLine}

ERRANDS (order ALL of these — each line is "id: title (where, when)"):
${errandLines}

HOW TO ORDER (return "order": the ids earliest-first):
1. GEOGRAPHY FIRST: group errands in the same neighbourhood together and walk the day as a smooth path — start near the day's start location, end near the day's end location, and never zig-zag back to an area you already left.
2. FIXED TIMES ARE LAW: an errand with a FIXED time must sit in clock order relative to other fixed times (earlier fixed time → earlier in the list). Flexible errands flow around them.
3. UNPLACED errands (those that "need a <category>", e.g. a gym or a drogerie) have NO fixed geography yet — place each NEXT TO the located errand it pairs best with, so it can later be found right by that stop (e.g. a grocery run right after a nearby appointment). A purely local chore (gym, groceries, pharmacy) with nothing to pair with sits near the home end of the day.
4. Keep at-home / online / no-place errands where they fit the rhythm (quiet ones can sit early or late), but don't let them force travel.

OUTPUT:
- "order": an array containing EVERY id above EXACTLY ONCE, earliest-first. Use the ids verbatim.
- "title": a short, friendly day title. "summary": one sentence. "city": the main city, if obvious from the addresses (else "").`;
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
    responseSchema: ORDER_SCHEMA,
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

/** Keep only string ids, de-duplicated, in the model's order. The client does
 *  the final reconciliation against the real id set. */
function shapeOrder(parsed: any): string[] {
  const raw = Array.isArray(parsed?.order) ? parsed.order : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of raw) {
    const id = asStr(v, 80);
    if (id && !seen.has(id)) {
      out.push(id);
      seen.add(id);
    }
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

  const errands: ErrandInput[] = Array.isArray(payload.errands) ? payload.errands : [];
  // 0 or 1 errand → order is trivial; echo the ids (the client also short-circuits).
  if (errands.length <= 1) {
    return jsonResponse({
      order: errands.map((e, i) => e.id ?? `errand-${i}`),
      title: '',
      summary: '',
      city: '',
    });
  }

  const date = isISODate(payload.date) ? (payload.date as string) : todayISO();
  const prompt = buildPrompt({
    errands,
    dayStart: payload.dayStart,
    dayEnd: payload.dayEnd,
    home: payload.home,
    date,
  });

  let modelUsed = CONFIGURED_ORDER_MODEL;
  let gem = await callGemini({
    prompt,
    apiKey: geminiKey,
    model: CONFIGURED_ORDER_MODEL,
    thinkingBudget: ORDER_THINKING_BUDGET,
  });
  if (!gem.ok && CONFIGURED_ORDER_MODEL !== FALLBACK_ORDER_MODEL) {
    console.warn(
      `order-day: model "${CONFIGURED_ORDER_MODEL}" failed (${gem.detail}); retrying with "${FALLBACK_ORDER_MODEL}".`,
    );
    modelUsed = FALLBACK_ORDER_MODEL;
    gem = await callGemini({
      prompt,
      apiKey: geminiKey,
      model: FALLBACK_ORDER_MODEL,
      thinkingBudget: ORDER_THINKING_BUDGET,
    });
  }
  if (!gem.ok) {
    return jsonResponse({ error: 'Order failed', detail: gem.detail }, gem.status);
  }

  logTokenUsage({ fn: 'order-day', step: 'order', model: modelUsed, usage: gem.usage });

  return jsonResponse({
    order: shapeOrder(gem.parsed),
    title: asStr(gem.parsed?.title, 120) ?? '',
    summary: asStr(gem.parsed?.summary, 400) ?? '',
    city: asStr(gem.parsed?.city, 80) ?? '',
    usage: { model: modelUsed, ...gem.usage },
  });
});
