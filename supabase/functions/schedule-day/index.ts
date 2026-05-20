// Supabase Edge Function: schedule-day
//
// Takes the user's raw list of plans for the day and returns a structured,
// ordered schedule. Uses OpenAI when OPENAI_API_KEY is set, otherwise returns
// a 501 response so the client knows to fall back to local heuristics.
//
// Deploy:
//   supabase functions deploy schedule-day --no-verify-jwt
//   supabase secrets set OPENAI_API_KEY=sk-...
//
// Request body:
//   { plans: string[], startTime?: "HH:MM" }
//
// Response body matches `ScheduleResult` in src/lib/ai/scheduler.ts:
//   { plans: Plan[], summary: string }

// deno-lint-ignore-file no-explicit-any
// @ts-nocheck Deno runtime - types resolved by Supabase tooling at deploy time.

const SYSTEM_PROMPT = `You are DayFlow, an assistant that helps people order
their daily plans for maximum sensible flow. Given a list of free-form plan
strings, produce a JSON schedule.

Rules:
- Order plans so that the day makes sense (errands and grocery shopping early,
  workouts before meals, focused work in chunks, relaxation later).
- For each plan, propose a sensible duration in minutes (15-180).
- Break complex plans into 2-5 sub-steps when it helps (e.g. cooking ->
  prep/cook/eat/cleanup; gym -> warmup/main/cooldown). Do NOT add sub-steps if
  the plan is already atomic.
- If a plan is vague about a *location* (e.g. "go to the gym", "lunch out",
  "grocery shopping"), set status = "needs_clarification" and provide a single
  clarification_question plus 3 short suggestion chips. Suggestions should
  include "Closest highly-rated", "My usual spot", and "Find a new one".
- If a plan is vague about *what* (e.g. "cook") set the same status with a
  question about what, plus 3 suggestions including "I'll decide later".
- Otherwise status = "scheduled".
- Assign start_time strings ("HH:MM" 24h) starting from the provided startTime
  with a 10 minute buffer between plans.

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

  let payload: { plans?: string[]; startTime?: string };
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  const plans = Array.isArray(payload.plans) ? payload.plans : [];
  const startTime =
    typeof payload.startTime === 'string' ? payload.startTime : '09:00';

  if (plans.length === 0) {
    return jsonResponse({ plans: [], summary: 'Nothing to schedule yet.' });
  }

  const userMessage = JSON.stringify({ plans, startTime });

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
