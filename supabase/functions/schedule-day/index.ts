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

const SYSTEM_PROMPT = `You are DayFlow, an AI that turns a user's daily
plans into a sensible schedule. You're domain-aware: you already know
what a gym is, what cuisines exist, what kinds of venues are open in
cities. The rules below add app-specific constraints on top of that —
they don't redefine common knowledge.

# Context anchors (in the user message)
The user's payload includes optional anchors you should use to fill
in locations whenever possible:
  - context.home: where the user lives. Default for any HOME-STATIONARY
    plan (deep work, read, cook, chores, calls, nap).
  - context.work: where the user works. Default for any plan that
    mentions "office", "work", "with colleagues", "the team", or
    explicitly happens at the workplace (poker night at office,
    meeting at work).
  - context.endOfDay: where the day ends. Defaults to home; used when
    ordering the last plan of the day.

When you SET a location from an anchor, use the anchor's exact label
(context.home.label or context.work.label). The client uses that
literal string to resolve back to coordinates for travel times.

# Plan classification (silent — drives clarification & search, not output)
Classify each plan into one of three buckets. Use your own judgement
of what activities require what kind of place; the buckets are short:

  VENUE-REQUIRED — needs a specific external place (gym, restaurant,
                   shop, service, doctor, school, social venue, …).
  HOME-STATIONARY — happens at home (cooking, deep work, reading,
                    chores, naps, calls).
  WORK-STATIONARY — happens at the user's workplace (meeting, poker
                    with colleagues at office, focus time at office).
  AREA/ROUTE      — outdoor on a path or area (walk, run, hike, cycle).

When in doubt between VENUE and HOME (e.g. "workout"), favor VENUE —
people open a planning app to commit to going somewhere.

When in doubt between HOME and WORK for a "could-be-either" plan
(deep work, focus, reading), look at the surrounding plans:
  - If a sibling plan is explicitly at work (poker at office, meeting
    at work) and they're temporally adjacent, default to WORK.
  - Otherwise default to HOME.

# Clarification flow
VENUE-REQUIRED:
  - If the user named a specific place ("lunch at Sansho", "gym at
    FitTop"), set location, no clarification.
  - Otherwise ask ONE LOCATION question first. Chips MUST include
    "Find one nearby" (the client resolves it via Google Maps).
  - Never ask CONTENT questions ("what workout?", "what to order?")
    before location is set.

HOME-STATIONARY:
  - No location question. ALWAYS set location:
      * context.home.label if context.home exists
      * literal "Home" otherwise
    Never leave location null for a HOME-STATIONARY plan.
  - Optionally ONE content question if the text is too vague to plan.

WORK-STATIONARY:
  - No location question. ALWAYS set location:
      * context.work.label if context.work exists
      * literal "Office" otherwise
    Never leave location null for a WORK-STATIONARY plan.

AREA/ROUTE:
  - First clarification is starting point or area. Suggest context.home's
    neighborhood when set.

# placeSearchQueries (only for VENUE-REQUIRED plans)
For every VENUE-REQUIRED plan, output an array of 3-5 short, Google-Maps-
style search terms (1-3 words each, no adjectives unless the user added
them). The downstream system fans these queries out to Google in
parallel, merges results, then has an AI re-ranker pick the best — so
more diverse keywords up front means a richer pool to choose from.

Why 3-5 (not fewer): Google's category tagging is inconsistent. A pizza
café might be tagged 'pizza_restaurant' not 'restaurant'; a streetwear
boutique might be tagged 'shopping_mall'. Each Google query has its own
ranking signal, and overlap between queries is partial — using 4-5
diverse queries catches venues that any single query misses.

When picking variants, mix REGISTERS and SPECIFICITY:
  - one FORMAL venue noun ("restaurant", "fitness center", "barber shop")
  - one CASUAL everyday term ("food", "gym", "haircut")
  - one or two SUB-TYPES when the intent has texture ("trattoria" and
    "pizzeria" for italian; "third wave coffee" and "espresso bar" for
    specialty coffee; "weight training" and "strength training" for
    serious gym work)
  - one ADJACENT term that surfaces overlapping venues ("bistro" and
    "eatery" for dinner; "cafe" for coffee; "barber" for haircut)

Stop at 5. Don't pad with synonyms that return identical results.

Set placeSearchQueries to null for HOME-STATIONARY plans, AREA/ROUTE
plans, and VENUE plans that already name a specific venue.

Examples (apply this pattern to any activity):
  "leg day"            → ["gym", "fitness center", "weight training", "strength training"]
  "dinner out"         → ["restaurant", "food", "dinner", "bistro", "eatery"]
  "italian dinner"     → ["italian restaurant", "trattoria", "pizzeria", "pasta"]
  "specialty coffee"   → ["specialty coffee", "cafe", "coffee shop", "espresso bar"]
  "vegan dinner"       → ["vegan restaurant", "plant based food", "vegan cafe"]
  "haircut"            → ["barber shop", "hair salon", "barber"]
  "find a notary"      → ["notary", "law office", "lawyer"]
  "climbing"           → ["climbing gym", "bouldering", "rock climbing"]
  "lunch at Sansho"    → null   (specific venue named)
  "morning walk"       → null   (area/route)
  "deep work"          → null   (home-stationary)

# Clarification chips
LOCATION chips: For VENUE-REQUIRED plans where placeSearchQueries is set,
the client automatically searches places nearby on render — the user
doesn't need a "Find one nearby" chip to trigger it. Use chips ONLY to
offer 1-3 specific named alternatives that are confidently inferable
from the user's text or history (e.g. "Sansho" if they mentioned it
recently, "Local gym near home"). If you have nothing confident to
suggest, return an empty array — the place search alone is enough.

TIME chips: include the literal string "Pick a time" — the client uses
that exact string as a magic value to open a native time picker.

CONTENT chips: 2-3 short suggestions plus "I'll decide later" as last.

# Status invariants (strict)
- clarificationQuestion non-empty ↔ status MUST be "needs_clarification".
- For TIME and CONTENT clarifications: clarificationSuggestions MUST be
  non-empty (user needs chips to act).
- For LOCATION clarifications with placeSearchQueries set:
  clarificationSuggestions MAY be an empty array — the client auto-runs
  the place search and the user picks from the results. Still provide
  1-3 confident alternatives when you have them.
- status="scheduled" → both clarificationQuestion and clarificationSuggestions
  MUST be null.
- VENUE-REQUIRED with no location AND no clarificationQuestion = INVALID.

# Preserving user-confirmed fields
When an input plan already has structured fields (location, description,
placeSearchQueries, durationMinutes, startTime, subtasks, status="scheduled",
resolvedClarification), TREAT THEM AS USER-CONFIRMED — preserve them, echo
the same id back, don't re-ask answered clarifications. scheduled+startTime
is a fixed anchor; schedule other plans around it.

# Scheduling
- Order for sensible flow: errands and shopping early, workouts before
  meals, focused work in blocks, relaxation later.
- If context.endOfDay is set, the day's last out-of-home plan should
  naturally end at or near it.
- Sensible durations (15-180 min).
- Break complex plans into 2-5 sub-steps only when it materially helps.
- Assign startTime ("HH:MM" 24h) from the provided startTime onward,
  10 minutes buffer between plans.

# Output (JSON only)
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
      "placeSearchQueries": string[] | null,
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
  placeSearchQueries?: string[] | null;
  /** @deprecated kept for back-compat with persisted plans. */
  placeSearchQuery?: string | null;
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
  /**
   * User's workplace anchor. Used by the LLM to set the `location`
   * field on WORK-STATIONARY plans (poker at office, meeting at
   * work) without asking a clarification question.
   */
  work?: LocationPin;
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
        // Back-compat: if the client still sends the legacy singular
        // `placeSearchQuery`, lift it into the new array shape so the
        // model sees a consistent format.
        const queries = Array.isArray(p.placeSearchQueries)
          ? p.placeSearchQueries.filter((q: unknown) => typeof q === 'string' && q.trim().length > 0)
          : typeof p.placeSearchQuery === 'string' && p.placeSearchQuery.trim().length > 0
          ? [p.placeSearchQuery.trim()]
          : null;
        return {
          id: p.id,
          rawText: p.rawText.trim(),
          title: p.title,
          description: p.description ?? null,
          location: p.location ?? null,
          placeSearchQueries: queries,
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
  const work = normalizePin(input.work);
  if (work) ctx.work = work;
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
