// Supabase Edge Function: parse-errand
//
// Turns ONE free-form reminder the user typed ("call mom", "dentist at 18:00 at
// Pirktova Gemini A") into a structured errand the app can prefill into the
// confirm drawer:
//
//   { title, date, startTime, endTime, address, notes }
//
// Every slot except `title` is optional — the model returns null when the user
// didn't say, and the client renders those as "Any day" / "Anytime" /
// "Anywhere".
//
// This is a tiny slot-filling task, so we run the CHEAPEST + FASTEST Gemini
// model and force structured output via a responseSchema. Schema mode
// GUARANTEES parseable JSON from any model — including the flash-lite tier —
// so there's no risk of the lite model drifting into prose (the failure mode
// that forces grounded planning onto Flash). ~1s, fractions of a cent.
//
// Request body:
//   { text: string, date?: "YYYY-MM-DD" }   // date = the user's "today", to
//                                            // resolve "tomorrow"/"friday".
//
// Response body: the errand draft (see ERRAND_SCHEMA).
//
// Required env vars:
//   GEMINI_API_KEY        — Google AI Studio key (same one plan-itinerary uses).
//   GEMINI_ERRAND_MODEL   — optional override; defaults to gemini-2.5-flash-lite.

// deno-lint-ignore-file no-explicit-any
// @ts-nocheck Deno runtime - types resolved by Supabase tooling at deploy time.

// The cheapest + fastest Gemini tier. Because we constrain the output with a
// responseSchema (not Google Search grounding), flash-lite reliably emits the
// small JSON object — so we get lite-tier cost/latency with no quality risk for
// a task this simple. Override with `supabase secrets set GEMINI_ERRAND_MODEL=…`.
const DEFAULT_ERRAND_MODEL = 'gemini-2.5-flash-lite';
const CONFIGURED_ERRAND_MODEL =
  Deno.env.get('GEMINI_ERRAND_MODEL') ?? DEFAULT_ERRAND_MODEL;
// If the configured/lite model ever fails, retry once on a known-good Flash
// model rather than failing the request (the client then falls back to its own
// local parse if even this fails).
const FALLBACK_ERRAND_MODEL = 'gemini-2.5-flash';

// Gemini structured-output schema. A subset of OpenAPI — the shape Gemini's
// `responseSchema` accepts. Mirrors the ErrandDraft the client expects.
const ERRAND_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['title'],
  propertyOrdering: ['title', 'date', 'startTime', 'endTime', 'address', 'notes'],
  properties: {
    title: { type: 'string' },
    date: { type: 'string', nullable: true },
    startTime: { type: 'string', nullable: true },
    endTime: { type: 'string', nullable: true },
    address: { type: 'string', nullable: true },
    notes: { type: 'string', nullable: true },
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

/** "YYYY-MM-DD" → "Wednesday" (UTC, matches how we build the date). */
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

/** Pad a loose "9:5" into "09:05"; returns null if not a real clock time. */
function normalizeHHMM(v: unknown): string | null {
  if (!isHHMM(v)) return null;
  const [h, m] = (v as string).trim().split(':').map(Number);
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
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

function buildPrompt(text: string, today: string): string {
  const weekday = weekdayOf(today);
  return `You extract a single structured "errand" (a reminder/task) from one short line the user typed. Output ONLY a JSON object matching the schema. Set a field to null when the user did NOT clearly state it — never guess a date, time, or place that isn't implied.

TODAY is ${today}${weekday ? ` (${weekday})` : ''}.

Fields:
- title: a short, clean imperative task, Capitalized, WITHOUT the time/date/place baked in. ("call mom" → "Call mom"; "visit dentist at 6pm" → "Visit dentist").
- date: "YYYY-MM-DD" only if the user named a day. Resolve relative words against TODAY ("today", "tomorrow", "this friday", "next mon", "June 12", "12/6"). Otherwise null.
- startTime: "HH:MM" 24h if the user gave a time ("18:00", "6pm", "at 6", "noon", "half past 7"). Otherwise null.
- endTime: "HH:MM" 24h. If there is a startTime but no explicit end, estimate a realistic end from how long the task usually takes (a phone call ~15 min, coffee ~45 min, a dentist/doctor/haircut visit ~60 min, a meeting ~60 min, errands ~30 min). If there is NO startTime, set endTime null too.
- address: the place or address EXACTLY as the user wrote it, so it can be geocoded later ("Pirktova Gemini A", "mom's place", "Tesco Letňany"). Distinguish a place from a time: "at 18:00" is a time, "at Pirktova" is a place. Null if no place was given.
- notes: any leftover detail worth keeping (e.g. "bring documents"), else null.

Examples:
"call mom" → {"title":"Call mom","date":null,"startTime":null,"endTime":null,"address":null,"notes":null}
"visit dentist at pirktova gemini a" → {"title":"Visit dentist","date":null,"startTime":null,"endTime":null,"address":"pirktova gemini a","notes":null}
"visit dentist at 18:00" → {"title":"Visit dentist","date":null,"startTime":"18:00","endTime":"19:00","address":null,"notes":null}
"visit dentist at 18:00 at pirktova gemini a" → {"title":"Visit dentist","date":null,"startTime":"18:00","endTime":"19:00","address":"pirktova gemini a","notes":null}
"dentist tomorrow 9am bring xray" → {"title":"Dentist","date":"<tomorrow's date>","startTime":"09:00","endTime":"10:00","address":null,"notes":"bring xray"}

USER LINE (between triple quotes):
"""
${text}
"""`;
}

// ----------------------------------------------------------- Gemini call

async function callGemini(args: {
  prompt: string;
  apiKey: string;
  model: string;
}): Promise<{ ok: true; parsed: any } | { ok: false; status: number; detail: string }> {
  const body = {
    contents: [{ role: 'user', parts: [{ text: args.prompt }] }],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: 'application/json',
      responseSchema: ERRAND_SCHEMA,
    },
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
  return { ok: true, parsed };
}

/** Clamp + validate the model's object into the wire shape the client expects. */
function shapeDraft(parsed: any, rawText: string): {
  title: string;
  date: string | null;
  startTime: string | null;
  endTime: string | null;
  address: string | null;
  notes: string | null;
} {
  const title =
    typeof parsed?.title === 'string' && parsed.title.trim()
      ? parsed.title.trim().slice(0, 120)
      : rawText.slice(0, 120);
  const start = normalizeHHMM(parsed?.startTime);
  let end = normalizeHHMM(parsed?.endTime);
  // An end without a start is meaningless for an errand; drop it.
  if (!start) end = null;
  return {
    title,
    date: isISODate(parsed?.date) ? parsed.date.trim() : null,
    startTime: start,
    endTime: end,
    address:
      typeof parsed?.address === 'string' && parsed.address.trim()
        ? parsed.address.trim().slice(0, 200)
        : null,
    notes:
      typeof parsed?.notes === 'string' && parsed.notes.trim()
        ? parsed.notes.trim().slice(0, 300)
        : null,
  };
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

  let payload: { text?: string; date?: string };
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }
  const text = typeof payload.text === 'string' ? payload.text.trim() : '';
  if (!text) {
    return jsonResponse({ error: 'Missing `text`.' }, 400);
  }
  const today = isISODate(payload.date) ? (payload.date as string) : todayISO();

  const prompt = buildPrompt(text, today);

  let gem = await callGemini({ prompt, apiKey: geminiKey, model: CONFIGURED_ERRAND_MODEL });
  if (!gem.ok && CONFIGURED_ERRAND_MODEL !== FALLBACK_ERRAND_MODEL) {
    console.warn(
      `parse-errand: model "${CONFIGURED_ERRAND_MODEL}" failed (${gem.detail}); retrying with "${FALLBACK_ERRAND_MODEL}".`,
    );
    gem = await callGemini({ prompt, apiKey: geminiKey, model: FALLBACK_ERRAND_MODEL });
  }
  if (!gem.ok) {
    return jsonResponse({ error: 'Parse failed', detail: gem.detail }, gem.status);
  }

  return jsonResponse(shapeDraft(gem.parsed, text));
});
