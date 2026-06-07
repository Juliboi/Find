// Supabase Edge Function: adjust-itinerary
//
// Takes a current itinerary and a free-form user adjustment ("make lunch
// shorter and skip the column") and returns a SEQUENCE OF EDIT OPS — the same
// op vocabulary the client uses for direct manipulation. The client applies
// the ops one by one through the regular pipeline, so:
//   - manual + AI edits compose naturally (both go to the same applyOp/cascade)
//   - the undo stack covers both uniformly
//   - the user keeps their in-place edits instead of having them erased by a
//     "replace the whole day" replan
//
// Falls back to a 501 when OPENAI_API_KEY is missing, so the client can show
// the "Ask the planner →" chip but still degrade gracefully.
//
// Request body:
//   { itinerary: Itinerary, adjustment: string }
//
// Response body:
//   { ops: EditOp[], explanation?: string }
//
// Required env vars:
//   OPENAI_API_KEY  — chat-completions key, used with gpt-4o-mini for cheap +
//                     fast structured output.

// deno-lint-ignore-file no-explicit-any
// @ts-nocheck Deno runtime - types resolved by Supabase tooling at deploy time.

const SYSTEM_PROMPT = `You translate a user's plain-English adjustment of
their day into a small, ordered list of structured edit operations.

You DO NOT rewrite the whole day. You output the MINIMAL set of ops that
realizes the user's ask, leaving everything else untouched. The client will
apply each op in order; cascading clock + route recomputation happens
automatically.

# Available ops (return JSON exactly matching one of these shapes)

  { "type": "setDuration",        "id": "<itemId>", "minutes": <int>=5> }
      // pin a block's length to N minutes

  { "type": "adjustDuration",     "id": "<itemId>", "deltaMin": <signed int> }
      // nudge a block longer (+) or shorter (-) by N minutes

  { "type": "moveTime",           "id": "<itemId>", "hhmm": "HH:MM" }
      // start the block at this absolute time (24h). Pins it as 'fixed'.

  { "type": "remove",             "id": "<itemId>" }
      // drop the block from the day

  { "type": "setLegMode",         "id": "<itemId>",
    "mode": "walk" | "bike" | "transit" | "drive" }
      // change how the user travels TO this block from the previous stop

  { "type": "setDayTransportMode",
    "mode": "walk" | "bike" | "transit" | "drive" }
      // apply that transport mode to EVERY leg of the day

  { "type": "reorder",            "orderedIds": ["<itemId>", "<itemId>", ...] }
      // rearrange the day. orderedIds must contain EVERY current item id
      // exactly once, in the desired new order.

# Output

Respond with strict JSON of the form:
  { "ops": [<op>, <op>, ...], "explanation": "<one short sentence>" }

Rules:
  - Use ONLY item ids that appear in the input.
  - Empty "ops" is fine if the request can't be expressed in this vocabulary.
  - Do NOT invent new venues, places, or unrelated items — there is no
    "add" or "swap place" op in this set. If the user is asking for a new
    venue, return an empty ops array and explain.
  - When you can satisfy the intent with simpler ops, prefer them
    (adjustDuration over setDuration, moveTime over reorder, etc.).
  - Keep "explanation" under 12 words.
`;

interface ItineraryItemBrief {
  id: string;
  title: string;
  kind?: string;
  flexibility?: string;
  startTime?: string;
  endTime?: string;
  durationMinutes?: number;
  place?: string;
  travelMode?: string;
}

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

/**
 * Compact the full Itinerary down to just what the model needs to choose ops.
 * Photos, polylines, transit step breakdowns, ratings — all stripped. Keeps
 * the prompt small (faster + cheaper) and reduces hallucination risk because
 * the model can't accidentally mention fields that don't matter for ops.
 */
function compactItinerary(itinerary: any): { title: string; items: ItineraryItemBrief[] } {
  const items: ItineraryItemBrief[] = [];
  const sections = Array.isArray(itinerary?.sections) ? itinerary.sections : [];
  for (const s of sections) {
    if (!s || !Array.isArray(s.items)) continue;
    for (const it of s.items) {
      if (!it || typeof it !== 'object') continue;
      const id = typeof it.id === 'string' ? it.id : null;
      const title = typeof it.title === 'string' ? it.title : null;
      if (!id || !title) continue;
      items.push({
        id,
        title,
        kind: typeof it.kind === 'string' ? it.kind : undefined,
        flexibility: typeof it.flexibility === 'string' ? it.flexibility : undefined,
        startTime: typeof it.startTime === 'string' ? it.startTime : undefined,
        endTime: typeof it.endTime === 'string' ? it.endTime : undefined,
        durationMinutes:
          typeof it.durationMinutes === 'number' ? it.durationMinutes : undefined,
        place:
          it.place && typeof it.place === 'object' && typeof it.place.name === 'string'
            ? it.place.name
            : undefined,
        travelMode:
          it.travelFromPrev && typeof it.travelFromPrev.mode === 'string'
            ? it.travelFromPrev.mode
            : undefined,
      });
    }
  }
  return {
    title: typeof itinerary?.title === 'string' ? itinerary.title : 'Your day',
    items,
  };
}

const ALLOWED_OP_TYPES = new Set([
  'setDuration',
  'adjustDuration',
  'moveTime',
  'remove',
  'setLegMode',
  'setDayTransportMode',
  'reorder',
]);

const ALLOWED_MODES = new Set(['walk', 'bike', 'transit', 'drive']);
const HHMM_RE = /^\d{1,2}:\d{2}$/;

/**
 * Validates each op the model produced against the schema AND against the
 * actual itinerary (item ids must exist). Drops anything malformed so a
 * single bad op can't poison the whole batch.
 */
function sanitizeOps(rawOps: any, validIds: Set<string>): any[] {
  if (!Array.isArray(rawOps)) return [];
  const out: any[] = [];
  for (const op of rawOps) {
    if (!op || typeof op !== 'object') continue;
    const type = op.type;
    if (!ALLOWED_OP_TYPES.has(type)) continue;
    switch (type) {
      case 'setDuration': {
        const minutes = Math.round(Number(op.minutes));
        if (typeof op.id !== 'string' || !validIds.has(op.id)) break;
        if (!Number.isFinite(minutes) || minutes < 5) break;
        out.push({ type, id: op.id, minutes });
        break;
      }
      case 'adjustDuration': {
        const deltaMin = Math.round(Number(op.deltaMin));
        if (typeof op.id !== 'string' || !validIds.has(op.id)) break;
        if (!Number.isFinite(deltaMin) || deltaMin === 0) break;
        out.push({ type, id: op.id, deltaMin });
        break;
      }
      case 'moveTime': {
        if (typeof op.id !== 'string' || !validIds.has(op.id)) break;
        if (typeof op.hhmm !== 'string' || !HHMM_RE.test(op.hhmm)) break;
        out.push({ type, id: op.id, hhmm: op.hhmm });
        break;
      }
      case 'remove': {
        if (typeof op.id !== 'string' || !validIds.has(op.id)) break;
        out.push({ type, id: op.id });
        break;
      }
      case 'setLegMode': {
        if (typeof op.id !== 'string' || !validIds.has(op.id)) break;
        if (typeof op.mode !== 'string' || !ALLOWED_MODES.has(op.mode)) break;
        out.push({ type, id: op.id, mode: op.mode });
        break;
      }
      case 'setDayTransportMode': {
        if (typeof op.mode !== 'string' || !ALLOWED_MODES.has(op.mode)) break;
        out.push({ type, mode: op.mode });
        break;
      }
      case 'reorder': {
        if (!Array.isArray(op.orderedIds)) break;
        const cleaned: string[] = [];
        const seen = new Set<string>();
        for (const id of op.orderedIds) {
          if (typeof id !== 'string' || !validIds.has(id) || seen.has(id)) continue;
          seen.add(id);
          cleaned.push(id);
        }
        // Require coverage: every existing item must appear, otherwise the
        // reorder would silently drop blocks.
        if (cleaned.length !== validIds.size) break;
        out.push({ type, orderedIds: cleaned });
        break;
      }
    }
  }
  return out;
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
      { error: 'OPENAI_API_KEY is not configured.' },
      501,
    );
  }

  let payload: { itinerary?: any; adjustment?: any };
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  const itinerary = payload.itinerary;
  if (!itinerary || !Array.isArray(itinerary.sections)) {
    return jsonResponse({ error: 'Missing or malformed `itinerary`.' }, 400);
  }
  const adjustment = typeof payload.adjustment === 'string' ? payload.adjustment.trim() : '';
  if (!adjustment) {
    return jsonResponse({ error: 'Missing `adjustment` text.' }, 400);
  }

  const brief = compactItinerary(itinerary);
  const validIds = new Set(brief.items.map((i) => i.id));
  if (validIds.size === 0) {
    return jsonResponse({ ops: [], explanation: 'No items to adjust.' });
  }

  const userMessage = JSON.stringify({
    itinerary: brief,
    adjustment,
  });

  const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0.1,
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

  const ops = sanitizeOps(parsed?.ops, validIds);
  const explanation =
    typeof parsed?.explanation === 'string' ? parsed.explanation.slice(0, 200) : undefined;
  return jsonResponse({ ops, explanation });
});
