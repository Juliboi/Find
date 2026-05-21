// Supabase Edge Function: schedule-day
//
// Takes the user's plans for the day and returns a structured, ordered
// schedule. Uses OpenAI when OPENAI_API_KEY is set, otherwise returns a 501
// so the client falls back to local heuristics.
//
// Request body — two shapes are accepted:
//   { plans: string[], startTime?: "HH:MM", context?: Context }              // fresh
//   { plans: PlanInput[], startTime?: "HH:MM", mode?: "reschedule",          // reschedule
//     context?: Context }
//
// Context lets the model anchor planning around the user's home and current
// location so it can reason about distance, "my usual X", and finishing the
// day in the right place.

// deno-lint-ignore-file no-explicit-any
// @ts-nocheck Deno runtime - types resolved by Supabase tooling at deploy time.

const SYSTEM_PROMPT = `You are DayFlow, an assistant that helps people order
their daily plans for maximum sensible flow. Given the user's plans, produce
a JSON schedule.

# Activity classification
Classify every plan into ONE of these buckets and follow the matching rules.
You do NOT need to output the bucket — it just drives your behaviour.

1. PLACE-REQUIRED — these activities CANNOT happen without going to a specific
   external venue. Examples (NOT exhaustive):
   - gym, fitness centre, yoga studio, crossfit, climbing wall
   - grocery store, supermarket, market, bakery, pharmacy
   - restaurant, café, coffee shop, bar, pub
   - lunch out / dinner out / brunch out (eating away from home)
   - office, workplace (when the user says "office", "to the office",
     "from the office")
   - school, university, class, tutoring centre, lesson with a teacher
   - hairdresser, barber, doctor, dentist, clinic, hospital
   - bank, post office, dry cleaner, mechanic, repair shop
   - museum, gallery, cinema, theatre, concert venue
   - meet <person> at <venue>, pick up <X> from <Y>
   For these, you MUST ask a location clarification when the user has not
   already named a specific place in their text.

2. HOME-STATIONARY — happens at the user's home (use context.home as the
   implicit location). Examples:
   - cooking at home, baking, meal prep
   - "work from home", "deep work", "focused work", "emails"
     (default to home unless user says "at the office")
   - reading, studying alone, journaling
   - relax, nap, watch a movie at home
   - phone call, video call (unless a specific external venue is named)
   - chores, laundry, cleaning

3. AREA / ROUTE — happens outdoors over an area or path. Examples:
   - walk, stroll, hike, jog, run, cycle, bike ride
   Ask about the starting point or area; suggest the user's home neighborhood
   when context.home is set.

# Clarification priority (CRITICAL)
For PLACE-REQUIRED activities, the FIRST and ONLY clarification you ask
before the location is set MUST be about LOCATION. Forbidden: asking "what
kind of workout", "what to order", "cardio or strength training", "what
class", or any other content question, BEFORE the location is known. If the
user's raw text already names a specific place (e.g. "lunch at Sansho",
"gym at FitTop", "meet Anna at Café Letka"), extract that as the location
and do NOT ask about it.

If LOCATION is known but the user has not yet specified the depth/content,
you MAY ask ONE additional question (e.g. "What kind of workout today?").
Only do so when it would meaningfully change the plan. Never loop.

For HOME-STATIONARY activities, do NOT ask about location at all — they
happen at home. Set the location to the value of context.home.label if
context.home is provided; otherwise leave location null. You may ask ONE
content question only if the user's text is too vague to plan (e.g. "cook"
→ "What do you want to cook?").

For AREA / ROUTE activities, the first clarification is the area or starting
point. You may suggest the user's home neighborhood when context.home is set.

# Status / question invariant (STRICT)
- If you set clarificationQuestion to a non-empty string, status MUST be
  "needs_clarification". No exceptions.
- If status is "scheduled", clarificationQuestion MUST be null AND
  clarificationSuggestions MUST be null.
- A PLACE-REQUIRED plan with no location and no clarificationQuestion is
  INVALID — you must either set a location or ask one.

# Chip suggestions
For LOCATION clarifications on PLACE-REQUIRED activities, prefer these chips:
  - "Find one nearby"        — the client resolves this against a real Places API.
  - "My usual <category>"    — only when it makes sense semantically.
  - One specific named option if you can confidently guess from the user's history.
Avoid generic chips like "Closest highly-rated spot" unless the client cannot
do place lookups.

For TIME clarifications (when a plan needs a specific clock time), include the
EXACT literal string "Pick a time" as one of the suggestions — the client uses
that exact string to open a native time picker.

For CONTENT clarifications, 2-3 short suggestions appropriate to the activity,
including "I'll decide later" as the last one.

# Other rules
- Order plans so that the day makes sense (errands and shopping early, workouts
  before meals, focused work in chunks, relaxation later). When context.endOfDay
  is set, the final plan should be one that naturally ends at or near it; if
  the user is heading home, the day's last out-of-home activity should be
  closest to home.
- Propose a sensible duration in minutes (15-180).
- Break complex plans into 2-5 sub-steps when it helps. Don't over-decompose.
- Assign startTime strings ("HH:MM" 24h) starting from the provided startTime
  with a 10 minute buffer between plans.

# Preserving user-confirmed fields
When an input plan already has structured fields (location, description,
durationMinutes, startTime, subtasks, status=scheduled, or resolvedClarification),
TREAT THEM AS USER-CONFIRMED:
- Preserve them as-is unless ordering forces a small time adjustment.
- Do NOT re-ask a clarification the user has already answered.
- If a plan has BOTH a location AND a resolvedClarification covering depth,
  do not ask anything new.
- Always echo the same "id" field back for any plan that has one.
- If a plan has an explicit startTime AND status "scheduled", treat that
  startTime as a fixed anchor — schedule other plans around it.

# Output shape
Return ONLY a JSON object with this exact shape:
{
  "summary": string,
  "plans": [
    {
      "id": string,
      "title": string,
      "rawText": string,
      "description": string | null,
      "location": string | null,
      "subtasks": [{ "id": string, "title": string, "durationMinutes": number }],
      "durationMinutes": number,
      "startTime": string,
      "status": "scheduled" | "needs_clarification",
      "clarificationQuestion": string | null,
      "clarificationSuggestions": string[] | null,
      "orderIndex": number
    }
  ]
}`;

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

interface PlanInput {
  id?: string;
  rawText: string;
  title?: string;
  description?: string | null;
  location?: string | null;
  durationMinutes?: number;
  startTime?: string;
  subtasks?: { id?: string; title: string; durationMinutes: number }[];
  status?: 'draft' | 'needs_clarification' | 'scheduled';
  resolvedClarification?: { question: string; answer: string };
}

interface LocationPin {
  label: string;
  latitude: number;
  longitude: number;
}

interface Context {
  home?: LocationPin;
  endOfDay?: LocationPin;
  currentLocation?: { latitude: number; longitude: number };
}

function normalizePlans(input: any): PlanInput[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((p) => {
      if (typeof p === 'string') {
        const text = p.trim();
        return text ? ({ rawText: text } as PlanInput) : null;
      }
      if (p && typeof p === 'object' && typeof p.rawText === 'string') {
        return {
          id: p.id,
          rawText: p.rawText.trim(),
          title: p.title,
          description: p.description ?? null,
          location: p.location ?? null,
          durationMinutes:
            typeof p.durationMinutes === 'number' ? p.durationMinutes : undefined,
          startTime: typeof p.startTime === 'string' ? p.startTime : undefined,
          subtasks: Array.isArray(p.subtasks) ? p.subtasks : undefined,
          status: p.status,
          resolvedClarification: p.resolvedClarification,
        } as PlanInput;
      }
      return null;
    })
    .filter(Boolean) as PlanInput[];
}

function normalizePin(input: any): LocationPin | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const lat = Number(input.latitude);
  const lon = Number(input.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return undefined;
  return {
    label: typeof input.label === 'string' ? input.label : 'Pin',
    latitude: lat,
    longitude: lon,
  };
}

function normalizeContext(input: any): Context {
  if (!input || typeof input !== 'object') return {};
  const ctx: Context = {};
  const home = normalizePin(input.home);
  if (home) ctx.home = home;
  const endOfDay = normalizePin(input.endOfDay);
  if (endOfDay) ctx.endOfDay = endOfDay;
  if (input.currentLocation && typeof input.currentLocation === 'object') {
    const lat = Number(input.currentLocation.latitude);
    const lon = Number(input.currentLocation.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      ctx.currentLocation = { latitude: lat, longitude: lon };
    }
  }
  return ctx;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders() });
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  const apiKey = Deno.env.get('OPENAI_API_KEY');
  if (!apiKey) {
    return jsonResponse(
      { error: 'OPENAI_API_KEY not configured on the server.' },
      501,
    );
  }

  let payload: { plans?: any; startTime?: string; mode?: string; context?: any };
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  const plans = normalizePlans(payload.plans);
  const startTime =
    typeof payload.startTime === 'string' ? payload.startTime : '09:00';
  const mode = payload.mode === 'reschedule' ? 'reschedule' : 'fresh';
  const context = normalizeContext(payload.context);

  if (plans.length === 0) {
    return jsonResponse({ plans: [], summary: 'Nothing to schedule yet.' });
  }

  const userMessage = JSON.stringify({ plans, startTime, mode, context });

  const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0.3,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
    }),
  });

  if (!openaiRes.ok) {
    const text = await openaiRes.text();
    return jsonResponse({ error: 'OpenAI error', detail: text }, 502);
  }

  const completion = await openaiRes.json();
  const content: string = completion?.choices?.[0]?.message?.content ?? '{}';

  let parsed: any;
  try {
    parsed = JSON.parse(content);
  } catch {
    return jsonResponse({ error: 'Model returned invalid JSON', raw: content }, 502);
  }

  return jsonResponse(parsed);
});
