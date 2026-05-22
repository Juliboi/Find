// Supabase Edge Function: compose-day
//
// Picks the best venue for each plan, considering the chain as a whole
// (proximity between consecutive plans, business hours vs scheduled
// start time, day-end at home). This is the "smart day" pass that runs
// *after* per-plan `find-places` candidates are loaded.
//
// We deliberately don't redo place-search here — by the time the
// client calls us each plan already has 4–6 vetted candidates from
// `find-places` (which already runs its own AI re-rank). Our job is
// the cross-plan optimization that no per-plan call can see.
//
// Request body:
//   {
//     plans: [
//       {
//         id, title, rawText, startTime?, durationMinutes,
//         candidates: NearbyPlace[]
//       }, ...
//     ],
//     context: { home?, endOfDay?, currentLocation?, startTime? }
//   }
//
// Response:
//   {
//     summary: string,            // 1-2 sentence rationale
//     picks: [
//       { planId, placeId, reasoning }
//     ]
//   }
//
// Notes:
//   - If a plan has no candidates we omit it from the picks list (the
//     client keeps the picker open for that one).
//   - If OpenAI isn't configured we fall back to a deterministic
//     heuristic (greedy nearest-neighbor + rating tiebreak) so the
//     feature still works in dev / on a free deploy.

// deno-lint-ignore-file no-explicit-any
// @ts-nocheck Deno runtime - types resolved by Supabase tooling at deploy time.

const SYSTEM_PROMPT = `You are the day composer for DayFlow. The user
has 1+ plans for today. For each plan we already collected 4-6 vetted
candidate venues. Your job is to assemble the day: pick ONE venue per
plan so the whole sequence flows well.

# Inputs you'll receive (in the user message, as JSON)
- plans: ordered list. Each has { id, title, rawText, startTime?,
  durationMinutes, candidates: [{ id, name, latitude, longitude,
  rating, ratingCount, openNow, address, types, distanceM }] }
- context: { home?, endOfDay?, currentLocation?, startTime? }
  - home: where the user lives and wants the day to end (lat/lng + label)
  - endOfDay: explicit override; falls back to home if absent
  - currentLocation: where the user is RIGHT NOW (the day's starting point)
  - startTime: "HH:MM" the day starts (default 09:00)

# Optimization (in priority order, ties broken by lower-priority)
1. OPEN-NOW first. Skip candidates explicitly marked openNow=false
   unless the plan's startTime is hours later AND the place is
   plausibly open then (you don't have hours, so be conservative —
   when in doubt, prefer openNow=true).
2. CHAIN PROXIMITY. The day forms a path: currentLocation (or home if
   absent) → plan 1 venue → plan 2 venue → ... → endOfDay/home.
   Minimize TOTAL straight-line distance across the chain. A pick
   that's 0.5 km better than the alternative but breaks the chain by
   3 km is a bad pick.
3. QUALITY signals: rating ≥ 4.3 with ≥ 50 reviews is a strong
   positive; rating < 4.0 OR review count < 20 is a weak signal.
   Within ±0.3 rating, prefer higher review count.
4. ABSOLUTE DISTANCE. Don't pick a 7+ km venue if there's a similarly
   rated one at 2 km, even if it "improves" the chain — the chain
   distance is straight-line, not routing time.

# Special cases
- One plan with one candidate: just pick it.
- Plan with zero candidates: omit from picks entirely.
- All candidates closed: pick the highest-quality one and flag in
  reasoning ("Closed now, queues up well for later").
- If currentLocation is absent, use home as the chain start.

# Output (JSON only, no prose)
{
  "summary": "1-2 sentence natural rationale, like Apple Maps or
              ChatGPT — friendly, specific, mentions why this order
              flows well",
  "picks": [
    {
      "planId": "<string>",
      "placeId": "<string id from the candidates array>",
      "reasoning": "≤14 words explaining why this venue won.
                    Mention chain context when relevant (e.g.
                    'on the way home from the gym')."
    }
  ]
}

Rules for reasoning text:
- No filler ("This is a great place that..."). Lead with the win.
- Mention proximity when it's the deciding factor ("8 min from gym").
- Mention quality when it's the win ("highest-rated nearby, 4.7").
- Don't quote the user's plan text back at them.
- Don't start with "Closed now" — the UI handles that label itself.`;

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

interface Coords {
  latitude: number;
  longitude: number;
}

interface LocationPin extends Coords {
  label?: string;
}

interface Candidate extends Coords {
  id: string;
  name: string;
  rating?: number | null;
  ratingCount?: number | null;
  openNow?: boolean | null;
  address?: string | null;
  types?: string[];
  distanceM?: number;
}

interface PlanForCompose {
  id: string;
  title: string;
  rawText: string;
  startTime?: string;
  durationMinutes: number;
  candidates: Candidate[];
}

interface ComposeRequest {
  plans: PlanForCompose[];
  context?: {
    home?: LocationPin;
    /** User's office / workplace anchor — used as the chain start for
     *  WORK-STATIONARY plans the LLM resolved to "Office". */
    work?: LocationPin;
    endOfDay?: LocationPin;
    currentLocation?: Coords;
    startTime?: string;
  };
}

interface Pick {
  planId: string;
  placeId: string;
  reasoning: string;
}

interface ComposeResponse {
  summary: string;
  picks: Pick[];
}

// ----------------------------------------------------------------- utils

function haversineM(a: Coords, b: Coords): number {
  const R = 6371000;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.latitude)) *
      Math.cos(toRad(b.latitude)) *
      Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Defensive normalization. The function is called from the client
 * with TypeScript-typed data, but Edge Functions are public surfaces
 * so we still validate the shape.
 */
function normalize(input: unknown): ComposeRequest | null {
  if (!input || typeof input !== 'object') return null;
  const anyInput = input as any;
  const rawPlans = Array.isArray(anyInput.plans) ? anyInput.plans : [];
  const plans: PlanForCompose[] = [];
  for (const p of rawPlans) {
    if (!p || typeof p !== 'object') continue;
    if (typeof p.id !== 'string' || typeof p.rawText !== 'string') continue;
    const candidates: Candidate[] = [];
    if (Array.isArray(p.candidates)) {
      for (const c of p.candidates) {
        if (!c || typeof c !== 'object') continue;
        const id = typeof c.id === 'string' ? c.id : null;
        const lat = Number(c.latitude);
        const lon = Number(c.longitude);
        if (!id || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        candidates.push({
          id,
          name: typeof c.name === 'string' ? c.name : 'Unknown',
          latitude: lat,
          longitude: lon,
          rating: typeof c.rating === 'number' ? c.rating : null,
          ratingCount:
            typeof c.ratingCount === 'number' ? c.ratingCount : null,
          openNow: typeof c.openNow === 'boolean' ? c.openNow : null,
          address: typeof c.address === 'string' ? c.address : null,
          types: Array.isArray(c.types) ? c.types : [],
          distanceM: typeof c.distanceM === 'number' ? c.distanceM : undefined,
        });
      }
    }
    plans.push({
      id: p.id,
      title: typeof p.title === 'string' ? p.title : p.rawText,
      rawText: p.rawText,
      startTime: typeof p.startTime === 'string' ? p.startTime : undefined,
      durationMinutes:
        typeof p.durationMinutes === 'number' ? p.durationMinutes : 60,
      candidates,
    });
  }
  let ctx: ComposeRequest['context'] = undefined;
  if (anyInput.context && typeof anyInput.context === 'object') {
    ctx = {};
    const c = anyInput.context;
    const home = normalizePin(c.home);
    if (home) ctx.home = home;
    const work = normalizePin(c.work);
    if (work) ctx.work = work;
    const eod = normalizePin(c.endOfDay);
    if (eod) ctx.endOfDay = eod;
    if (c.currentLocation && typeof c.currentLocation === 'object') {
      const lat = Number(c.currentLocation.latitude);
      const lon = Number(c.currentLocation.longitude);
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        ctx.currentLocation = { latitude: lat, longitude: lon };
      }
    }
    if (typeof c.startTime === 'string') ctx.startTime = c.startTime;
  }
  return { plans, context: ctx };
}

function normalizePin(input: any): LocationPin | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const lat = Number(input.latitude);
  const lon = Number(input.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return undefined;
  return {
    label: typeof input.label === 'string' ? input.label : undefined,
    latitude: lat,
    longitude: lon,
  };
}

// ----------------------------------------------------------------- heuristic fallback

/**
 * Deterministic compose used when OPENAI_API_KEY isn't set. Greedy
 * nearest-neighbor with a small quality penalty so we don't grab a
 * 3.2-star joint just because it's 50 m closer. Good enough for dev.
 */
function composeHeuristic(req: ComposeRequest): ComposeResponse {
  const startPin: Coords | undefined =
    req.context?.currentLocation ?? req.context?.home;
  const picks: Pick[] = [];
  let cursor: Coords | undefined = startPin;
  for (const plan of req.plans) {
    if (plan.candidates.length === 0) continue;
    const scored = plan.candidates.map((c) => {
      const dist = cursor ? haversineM(cursor, c) : c.distanceM ?? 0;
      const rating = c.rating ?? 0;
      const reviews = c.ratingCount ?? 0;
      // Penalty roughly equivalent to 500 m per missing rating star,
      // 300 m per missing 100 reviews. Keeps quality vs proximity in
      // a reasonable balance.
      const ratingPenalty = (5 - Math.min(5, rating)) * 500;
      const reviewBonus = Math.min(reviews, 500) * -0.6;
      const closedPenalty = c.openNow === false ? 4000 : 0;
      return { c, score: dist + ratingPenalty + reviewBonus + closedPenalty };
    });
    scored.sort((a, b) => a.score - b.score);
    const winner = scored[0].c;
    cursor = winner;
    picks.push({
      planId: plan.id,
      placeId: winner.id,
      reasoning: winner.openNow === false ? 'Closed now — best match nearby.' : 'Closest well-rated option nearby.',
    });
  }
  const summary =
    picks.length === 0
      ? 'No venues to compose.'
      : `Picked ${picks.length} venue${picks.length === 1 ? '' : 's'} along the shortest sensible path.`;
  return { summary, picks };
}

// ----------------------------------------------------------------- llm path

async function composeWithLLM(
  req: ComposeRequest,
  apiKey: string,
): Promise<ComposeResponse> {
  // Trim candidates to the top 6 per plan to keep the prompt small.
  // The find-places re-rank already ordered them by relevance, so the
  // first 6 are the strongest options anyway.
  const trimmedPlans = req.plans.map((p) => ({
    id: p.id,
    title: p.title,
    rawText: p.rawText,
    startTime: p.startTime,
    durationMinutes: p.durationMinutes,
    candidates: p.candidates.slice(0, 6).map((c) => ({
      id: c.id,
      name: c.name,
      latitude: c.latitude,
      longitude: c.longitude,
      rating: c.rating,
      ratingCount: c.ratingCount,
      openNow: c.openNow,
      address: c.address,
      types: c.types?.slice(0, 4) ?? [],
      distanceM: c.distanceM,
    })),
  }));

  const userMessage = JSON.stringify({
    plans: trimmedPlans,
    context: req.context ?? {},
  });

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`OpenAI error (HTTP ${res.status}): ${detail.slice(0, 240)}`);
  }
  const completion = await res.json();
  const content: string = completion?.choices?.[0]?.message?.content ?? '{}';
  let parsed: any;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`Compose model returned invalid JSON: ${content.slice(0, 240)}`);
  }
  const summary = typeof parsed.summary === 'string' ? parsed.summary : '';
  const picks: Pick[] = [];
  if (Array.isArray(parsed.picks)) {
    for (const p of parsed.picks) {
      if (!p || typeof p !== 'object') continue;
      if (typeof p.planId !== 'string' || typeof p.placeId !== 'string') continue;
      // Validate the placeId actually belongs to that plan's candidates.
      // Without this an LLM hallucination would orphan the pick and
      // the client would silently drop it.
      const plan = req.plans.find((pl) => pl.id === p.planId);
      if (!plan) continue;
      const valid = plan.candidates.some((c) => c.id === p.placeId);
      if (!valid) continue;
      picks.push({
        planId: p.planId,
        placeId: p.placeId,
        reasoning:
          typeof p.reasoning === 'string'
            ? p.reasoning.replace(/^closed now\s*[—-]\s*/i, '').trim()
            : '',
      });
    }
  }
  return { summary, picks };
}

// ----------------------------------------------------------------- handler

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders() });
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  const normalized = normalize(body);
  if (!normalized || normalized.plans.length === 0) {
    return jsonResponse({ summary: 'Nothing to compose.', picks: [] });
  }

  const apiKey = Deno.env.get('OPENAI_API_KEY');

  // Single plan with single candidate: skip the LLM round-trip and
  // just confirm the pick. Saves ~1s of latency for trivial cases.
  if (
    normalized.plans.length === 1 &&
    normalized.plans[0].candidates.length === 1
  ) {
    const only = normalized.plans[0];
    return jsonResponse({
      summary: `Only one option for ${only.title} — picked it.`,
      picks: [
        {
          planId: only.id,
          placeId: only.candidates[0].id,
          reasoning: 'Only well-matched candidate in range.',
        },
      ],
    });
  }

  if (!apiKey) {
    return jsonResponse(composeHeuristic(normalized));
  }

  try {
    const result = await composeWithLLM(normalized, apiKey);
    // Belt-and-braces: if the LLM returned ZERO valid picks (despite
    // having candidates), fall back to the heuristic so the user
    // doesn't end up with an empty day.
    if (
      result.picks.length === 0 &&
      normalized.plans.some((p) => p.candidates.length > 0)
    ) {
      return jsonResponse(composeHeuristic(normalized));
    }
    return jsonResponse(result);
  } catch (e: any) {
    console.error('compose-day LLM failed, falling back to heuristic', e);
    return jsonResponse({
      ...composeHeuristic(normalized),
      warning: String(e?.message ?? e),
    });
  }
});
