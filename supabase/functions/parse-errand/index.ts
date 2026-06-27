// Supabase Edge Function: parse-errand
//
// The planning ORCHESTRATOR. From ONE free-form line the user typed it does two
// jobs in a single cheap call: (1) CLASSIFY the intent, and (2) fill the errand
// slots. So the home composer stays a single text field — no "area" field, no
// "near me" toggle — and the model decides where the line should go:
//
//   { intent, title, date, startTime, endTime, address, notes, discovery }
//
//   - intent "plan":     a fixed activity/reminder → go straight to the form.
//   - intent "discover": a place to find/choose by category → open the venue
//                        suggestion step. `discovery = { query, area, nearby }`.
//
// A line can be BOTH a timed plan and a discovery ("Natalie Karlín coffee at
// 12:00") — that's "discover": we pick the café, then it becomes the 12:00
// errand. Every slot except title/intent is optional (null when unsaid).
//
// This is a tiny slot-filling + classification task, so we run the CHEAPEST +
// FASTEST Gemini tier and force structured output via a responseSchema. Schema
// mode GUARANTEES parseable JSON from any model — including flash-lite — so
// there's no risk of the lite model drifting into prose. ~1s, fractions of a
// cent.
//
// Request body:
//   { text: string, date?: "YYYY-MM-DD" }   // date = the user's "today", to
//                                            // resolve "tomorrow"/"friday".
//
// Response body: the orchestrated errand (see ERRAND_SCHEMA / shapeResult).
//
// Required env vars:
//   GEMINI_API_KEY        — Google AI Studio key (same one plan-itinerary uses).
//   GEMINI_ERRAND_MODEL   — optional override; defaults to gemini-2.5-flash-lite.

// deno-lint-ignore-file no-explicit-any
// @ts-nocheck Deno runtime - types resolved by Supabase tooling at deploy time.

import { geminiUsage, logTokenUsage, type TokenUsage } from '../_shared/tokenLog.ts';

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
// `responseSchema` accepts. Mirrors the ErrandDraft the client expects, plus the
// orchestration fields (`intent` + `discovery`) so this one cheap call both
// classifies the request AND fills the slots.
const ERRAND_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['intent', 'title'],
  propertyOrdering: [
    'intent',
    'title',
    'date',
    'startTime',
    'endTime',
    'address',
    'notes',
    'personId',
    'usePersonPlace',
    'discovery',
  ],
  properties: {
    intent: { type: 'string', format: 'enum', enum: ['plan', 'discover'] },
    title: { type: 'string' },
    date: { type: 'string', nullable: true },
    startTime: { type: 'string', nullable: true },
    endTime: { type: 'string', nullable: true },
    address: { type: 'string', nullable: true },
    notes: { type: 'string', nullable: true },
    // A saved person referenced in the line (matched against SAVED PEOPLE), and
    // whether the line means we should use THAT PERSON'S fixed place. Both null/
    // false when no saved person is referenced. See PEOPLE RULES in the prompt.
    personId: { type: 'string', nullable: true },
    usePersonPlace: { type: 'boolean', nullable: true },
    // Present (and required) only when intent="discover": the venue search shape.
    discovery: {
      type: 'object',
      nullable: true,
      propertyOrdering: ['query', 'area', 'nearby'],
      properties: {
        query: { type: 'string', nullable: true },
        area: { type: 'string', nullable: true },
        nearby: { type: 'boolean', nullable: true },
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

interface PromptPerson {
  id: string;
  names: string[];
}

function buildPeopleBlock(people: PromptPerson[]): string {
  if (!people.length) return '';
  const list = people
    .map((p) => `- id "${p.id}": ${p.names.filter(Boolean).join(', ')}`)
    .join('\n');
  return `

SAVED PEOPLE (the user's contacts — match a name in the line against any alias below, case-insensitive; tolerate a trailing possessive "'s"/"s"):
${list}

PEOPLE RULES (fill "personId" + "usePersonPlace"):
- GOING TO a saved person's home/place — a POSSESSIVE or "at <name>'s" ("chill at Ondra's place", "at Ondra's", "Ondra's place", "round Maty's", "at Maty's flat", "movie night at Ondra's") → set "personId" to that person's id and "usePersonPlace" true. The app fills in their saved address itself, so set "address" to null. This is intent "plan".
- A saved person who is only a COMPANION, or the target of a communication/task ("cinema with Ondra", "call Ondra", "lunch with Maty", "meet Maty", "drinks with Ondra") → set "personId" to that person's id and "usePersonPlace" FALSE. Do NOT use their place; classify the intent by the normal rules.
- If the line names no saved person, set "personId" null and "usePersonPlace" false.
- A place CATEGORY or named venue mentioned alongside a person wins for the venue — "padel with Maty at sport centrum" keeps that address (usePersonPlace false).`;
}

function buildPrompt(text: string, today: string, people: PromptPerson[]): string {
  const weekday = weekdayOf(today);
  return `You are the planning ORCHESTRATOR. From ONE short line the user typed, do two things: (1) classify the INTENT, and (2) extract structured fields. Output ONLY a JSON object matching the schema. Set a field to null when the user did NOT clearly state it — never invent a date, time, or place.

TODAY is ${today}${weekday ? ` (${weekday})` : ''}.${buildPeopleBlock(people)}

INTENT — choose exactly one:
- "discover": the user wants to FIND or CHOOSE a place by CATEGORY, so we should show venue suggestions to pick from. Signals:
    • an explicit search ("find", "where", "recommend", "suggest", "any");
    • proximity ("near me", "nearby", "closest", "around here");
    • a place CATEGORY combined with a NEIGHBOURHOOD/area ("coffee in Karlín", "pharmacy near Karlín", "good ramen in Žižkov");
    • a place CATEGORY anchored to a SPECIFIC landmark, hotel, business, station, mall, or venue via "near"/"around"/"close to"/"by" — the named place is just the REFERENCE POINT to search around, NOT the venue you are visiting ("gym near Hilton Prague", "coffee around Charles Bridge", "atm close to the main station", "lunch by the Anděl mall"). Keep intent "discover" and copy that landmark VERBATIM into discovery.area.
    • a SOLO place CATEGORY with no venue chosen yet — this holds EVEN when the category is the ONLY thing said, and even with a date and/or time but NO area and NO person ("gym tomorrow 18:00", "haircut at 3", "dinner at 8", "yoga Saturday morning"). Going to a TYPE of place you have not picked yet (gym, café, pharmacy, salon, pool, climbing wall, a restaurant for lunch/dinner) is "discover": we surface options and let the user pick or let Diem pick.
    • a place CATEGORY that ALSO has a person AND an area/proximity ("coffee with Admir in Karlín at 10", "Natalie Karlín coffee at 12:00").
  A quality adjective on a category is STILL a category, NOT a venue name ("good ramen", "nice coffee", "cheap sushi", "best burgers" → query "ramen"/"coffee"/"sushi"/"burgers"). The user has NOT named one specific venue. BUT a BRAND or PROPER NAME attached to that food/place word makes it ONE specific venue → that is "plan", NOT "discover": "Bugr Burger", "Black Jack Burgers", "NM Desserts", "Five Guys", "Shake Shack" are the NAMES of restaurants, NOT a search for "burgers"/"desserts". The test: a quality/type word (good, nice, cheap, best, great, top, authentic, local, the closest) describes a category and stays "discover"; an ARBITRARY proper name (Bugr, Black Jack, NM, Five Guys, Joe's) — even one you do not recognise, even all-lowercase — names a single place and is "plan". When a leading word is NOT one of those quality/type words, lean to treating the whole thing as a venue NAME ("plan"), not a category. A CITY or AREA written AFTER the name is the venue's LOCATION, not a separate search area: "NM Desserts Olomouc", "Bugr Burger Brno", "Black Jack Burgers Olomouc" stay "plan" — keep intent "plan" and put the WHOLE phrase (name + city) into "address" so it geocodes to that one spot. Do NOT split a brand+city into a category + area discovery ("nm desserts olomouc" is NOT desserts in Olomouc — it is the shop "NM Desserts").
- "plan": a fixed activity, reminder, or task. Signals:
    • a specific NAMED venue or street address you are GOING TO — named with "at"/"@", stated as the place itself, or identified by its BRAND / PROPER NAME even with NO "at" and even when that name CONTAINS a food/category word ("Kolkovna at Pankrác", "sport centrum Cimice", "Pirktova 12", "Bugr Burger", "Black Jack Burgers", "NM Desserts"). Copy the FULL venue name into "address" so it geocodes to that one spot — do NOT strip it down to the category. NOTE: a category sought NEAR/AROUND a named place ("gym near Hilton Prague") is NOT this — there the named place is only a search anchor, so it stays "discover".
    • the user's OWN HOME as the venue — "at home", "at my place", "my apartment/flat/house", "our place", "back home", "work from home", "lunch at home". This is a fixed plan AT home, so set "address" to the literal "home" (the app swaps in the user's saved home location). EXCEPTION: proximity to home ("coffee near my place", "gym near home") is NOT this — there home is only a search anchor, so it stays "discover" with nearby true.
    • a person-centric/social plan named with a PERSON but NO area/neighbourhood ("lunch with Nikol", "drinks with the team", "dinner with Sara") — the venue gets sorted out socially, so we don't surface options. (Add an area or "find" and it flips to "discover": "lunch with Nikol in Karlín".)
    • a COMMUNICATION or possession/TASK verb acting on a person or place — "call", "phone", "ring", "text", "email", "message", "book", "buy", "get", "pick up", "pay", "return" — these are reminders to DO something, NOT a place to go choose. They are "plan" EVEN when they name a category ("call the pharmacy", "buy milk", "email the dentist", "pick up a prescription");
    • a timed commitment NOT tied to a place category — a meeting, work block, or appointment ("standup at 10", "deep work 2–4", "meeting at 14:00"). NOTE: "gym/café/pharmacy/salon/dinner at <time>" DOES name a place category → that is "discover", not "plan".

Rule of thumb: a COMMUNICATION/TASK verb ("call/text/email/buy/book/pick up …") → ALWAYS "plan". A specific NAMED venue/address you are GOING TO ("at"/"@" a place, or a BRAND/PROPER NAME like "Bugr Burger"/"NM Desserts") → "plan", with that FULL name in "address". But a bare place CATEGORY you still need to pick is "discover" — EVEN when it is anchored "near/around/close to" a named landmark or business ("gym near Hilton Prague" → discover, with "Hilton Prague" as the area anchor), and even when it is just a bare category with a time ("gym at 18:00" → discover). The brand-vs-category line: "burgers"/"good burgers"/"burgers near me" → discover (a category); "Bugr Burger" → plan (a named place). Otherwise: if there's no place at all (or only a person, with no area) → "plan". A line can be a timed plan AND a discovery at once (e.g. a 12:00 coffee whose café isn't chosen yet) — that is "discover" (we pick the place, then it becomes the timed errand).

Fields (fill for BOTH intents):
- title: short, clean, Capitalized activity, WITHOUT the time/date/place baked in, but KEEP the person/context. ("Natalie Karlín coffee at 12:00" → "Coffee with Natalie"; "call the pharmacy" → "Call the pharmacy"; "buy milk" → "Buy milk"; "find a pharmacy" → "Pharmacy"). When the line is JUST a named venue with no separate activity, use the venue's OWN name as the title ("bugr burger" → "Bugr Burger"; "nm desserts" → "NM Desserts").
- date: "YYYY-MM-DD" only if the user named a day. Resolve relative words against TODAY ("today","tomorrow","this friday","next mon","June 12","12/6"). Else null.
- startTime: "HH:MM" 24h if the user gave a time ("18:00","6pm","at 6","noon","half past 7"). Else null.
- endTime: "HH:MM" 24h. If there is a startTime but no explicit end, estimate a realistic end by activity (phone call ~15 min, coffee ~45 min, dentist/doctor/haircut/meeting ~60 min, errands ~30 min). If there is NO startTime, endTime is null.
- address: for "plan", the named place/address EXACTLY as the user wrote it so it can be geocoded — keep the FULL brand/venue name, never trimmed to its category ("Pirktova Gemini A","Kolkovna Pankrác","Bugr Burger","Black Jack Burgers","NM Desserts"). When the venue is the user's OWN HOME ("at home","my place","my apartment","our flat"), set address to the literal "home". For a communication/task "plan" with no real venue ("call the pharmacy","buy milk"), address is null. For "discover", ALWAYS null (the venue is chosen later). Distinguish place from time: "at 18:00" is a time, "at Pirktova" is a place, "at home" is the user's home.
- notes: any leftover detail worth keeping ("bring documents"), else null.
- personId / usePersonPlace: see PEOPLE RULES above. Default personId null and usePersonPlace false when no saved person is referenced (or when there are no saved people).
- discovery: REQUIRED object when intent="discover", null when intent="plan":
    - query: WHAT to search, cleaned — drop lookup verbs, the area, and "near me". KEEP the two kinds of words that change WHICH places match: (a) a real BRAND or CHAIN the user named — it narrows to THAT brand, so do NOT collapse it to the generic category ("max fitness near OC Krakov" → "Max Fitness" NOT "gym"; "find a starbucks" → "Starbucks" NOT "coffee"; "dm near karlin" → "dm drogerie" NOT "drugstore"); and (b) CURATION or DISTINCTION qualifiers — superlatives and special qualities like "best", "top", "most popular", "famous", "michelin", "fine dining", "rooftop", "interesting", "romantic", "hidden gem" ("most popular clubs in prague" → "most popular clubs"; "michelin restaurant near olomouc" → "michelin restaurant"; "interesting restaurants in prague" → "interesting restaurants"). Only drop BLAND fillers that don't narrow anything ("good","nice","great","cheap","a","some"). For an OCCASION with no stated category ("where to take my gf for our anniversary","somewhere special for a birthday"), set query to the occasion intent ("romantic anniversary dinner","birthday celebration restaurant"). With no brand, qualifier, or occasion, use the bare category ("pharmacy","coffee","ramen","tennis court").
    - area: the place to search AROUND when the user named one — EITHER a neighbourhood/district ("Karlín","Žižkov","Vinohrady") OR a SPECIFIC landmark, hotel, business, station, mall, or venue used as a reference point ("Hilton Prague","Charles Bridge","Anděl","Náměstí Míru"). Copy it EXACTLY as the user wrote it: keep the FULL name, and NEVER shorten a specific place to its city or district (NOT "Hilton Prague" → "Prague", NOT "Anděl mall" → "Smíchov"). null only if the user named no place to search around.
    - nearby: true ONLY for proximity to the user ("near me","nearby","closest","around here"); else false.

Examples:
"call the pharmacy" → {"intent":"plan","title":"Call the pharmacy","date":null,"startTime":null,"endTime":null,"address":null,"notes":null,"discovery":null}
"buy milk" → {"intent":"plan","title":"Buy milk","date":null,"startTime":null,"endTime":null,"address":null,"notes":null,"discovery":null}
"call mom" → {"intent":"plan","title":"Call mom","date":null,"startTime":null,"endTime":null,"address":null,"notes":null,"discovery":null}
"lunch with nikol" → {"intent":"plan","title":"Lunch with Nikol","date":null,"startTime":null,"endTime":null,"address":null,"notes":null,"discovery":null}
"padel with maty at sport centrum cimice" → {"intent":"plan","title":"Padel with Maty","date":null,"startTime":null,"endTime":null,"address":"sport centrum cimice","notes":null,"discovery":null}
"meet admir at pirktova 12:00" → {"intent":"plan","title":"Meet Admir","date":null,"startTime":"12:00","endTime":"13:00","address":"pirktova","notes":null,"discovery":null}
"meeting at 14:00" → {"intent":"plan","title":"Meeting","date":null,"startTime":"14:00","endTime":"15:00","address":null,"notes":null,"discovery":null}
"lunch at home tomorrow" → {"intent":"plan","title":"Lunch","date":"<tomorrow's date>","startTime":null,"endTime":null,"address":"home","notes":null,"discovery":null}
"nap at my place" → {"intent":"plan","title":"Nap","date":null,"startTime":null,"endTime":null,"address":"home","notes":null,"discovery":null}
"work from home friday" → {"intent":"plan","title":"Work from home","date":"<friday's date>","startTime":null,"endTime":null,"address":"home","notes":null,"discovery":null}
"clean my apartment" → {"intent":"plan","title":"Clean my apartment","date":null,"startTime":null,"endTime":null,"address":"home","notes":null,"discovery":null}
"coffee near my place" → {"intent":"discover","title":"Coffee","date":null,"startTime":null,"endTime":null,"address":null,"notes":null,"discovery":{"query":"coffee","area":null,"nearby":true}}
"find a pharmacy" → {"intent":"discover","title":"Pharmacy","date":null,"startTime":null,"endTime":null,"address":null,"notes":null,"discovery":{"query":"pharmacy","area":null,"nearby":false}}
"pharmacy near me" → {"intent":"discover","title":"Pharmacy","date":null,"startTime":null,"endTime":null,"address":null,"notes":null,"discovery":{"query":"pharmacy","area":null,"nearby":true}}
"find a pharmacy near karlin" → {"intent":"discover","title":"Pharmacy","date":null,"startTime":null,"endTime":null,"address":null,"notes":null,"discovery":{"query":"pharmacy","area":"Karlín","nearby":false}}
"gym session near hilton prague" → {"intent":"discover","title":"Gym","date":null,"startTime":null,"endTime":null,"address":null,"notes":null,"discovery":{"query":"gym","area":"Hilton Prague","nearby":false}}
"max fitness near oc krakov" → {"intent":"discover","title":"Max Fitness","date":null,"startTime":null,"endTime":null,"address":null,"notes":null,"discovery":{"query":"Max Fitness","area":"OC Krakov","nearby":false}}
"coffee around charles bridge" → {"intent":"discover","title":"Coffee","date":null,"startTime":null,"endTime":null,"address":null,"notes":null,"discovery":{"query":"coffee","area":"Charles Bridge","nearby":false}}
"good ramen in zizkov" → {"intent":"discover","title":"Ramen","date":null,"startTime":null,"endTime":null,"address":null,"notes":null,"discovery":{"query":"ramen","area":"Žižkov","nearby":false}}
"coffee with admir in karlin tomorrow at 10" → {"intent":"discover","title":"Coffee with Admir","date":"<tomorrow's date>","startTime":"10:00","endTime":"10:45","address":null,"notes":null,"discovery":{"query":"coffee","area":"Karlín","nearby":false}}
"natalie karlin coffee at 12:00" → {"intent":"discover","title":"Coffee with Natalie","date":null,"startTime":"12:00","endTime":"12:45","address":null,"notes":null,"discovery":{"query":"coffee","area":"Karlín","nearby":false}}
"closest tennis court tomorrow" → {"intent":"discover","title":"Tennis","date":"<tomorrow's date>","startTime":null,"endTime":null,"address":null,"notes":null,"discovery":{"query":"tennis court","area":null,"nearby":true}}
"any karlin coworking or cafe" → {"intent":"discover","title":"Coworking or cafe","date":null,"startTime":null,"endTime":null,"address":null,"notes":null,"discovery":{"query":"coworking or cafe","area":"Karlín","nearby":false}}
"gym tomorrow 18:00" → {"intent":"discover","title":"Gym","date":"<tomorrow's date>","startTime":"18:00","endTime":"19:00","address":null,"notes":null,"discovery":{"query":"gym","area":null,"nearby":false}}
"dinner at 8" → {"intent":"discover","title":"Dinner","date":null,"startTime":"20:00","endTime":"21:00","address":null,"notes":null,"discovery":{"query":"restaurant","area":null,"nearby":false}}

Curated / knowledge-heavy examples — KEEP the superlative/distinction/occasion in "query" so the picker can curate (don't flatten to the bare category):
"interesting restaurants in prague" → {"intent":"discover","title":"Interesting restaurants","date":null,"startTime":null,"endTime":null,"address":null,"notes":null,"discovery":{"query":"interesting restaurants","area":"Prague","nearby":false}}
"most popular clubs in prague" → {"intent":"discover","title":"Popular clubs","date":null,"startTime":null,"endTime":null,"address":null,"notes":null,"discovery":{"query":"most popular clubs","area":"Prague","nearby":false}}
"michelin restaurant near olomouc" → {"intent":"discover","title":"Michelin restaurant","date":null,"startTime":null,"endTime":null,"address":null,"notes":null,"discovery":{"query":"michelin restaurant","area":"Olomouc","nearby":false}}
"best coffee near me" → {"intent":"discover","title":"Best coffee","date":null,"startTime":null,"endTime":null,"address":null,"notes":null,"discovery":{"query":"best coffee","area":null,"nearby":true}}
"where to take my gf for our anniversary" → {"intent":"discover","title":"Anniversary dinner","date":null,"startTime":null,"endTime":null,"address":null,"notes":null,"discovery":{"query":"romantic anniversary dinner","area":null,"nearby":false}}

Named-venue (BRAND) examples — a proper name on a food/place word is ONE venue, so "plan" with the FULL name in address, NOT a category search:
"bugr burger" → {"intent":"plan","title":"Bugr Burger","date":null,"startTime":null,"endTime":null,"address":"bugr burger","notes":null,"discovery":null}
"black jack burgers tomorrow" → {"intent":"plan","title":"Black Jack Burgers","date":"<tomorrow's date>","startTime":null,"endTime":null,"address":"black jack burgers","notes":null,"discovery":null}
"nm desserts at 16:00" → {"intent":"plan","title":"NM Desserts","date":null,"startTime":"16:00","endTime":"16:45","address":"nm desserts","notes":null,"discovery":null}
"nm desserts olomouc" → {"intent":"plan","title":"NM Desserts","date":null,"startTime":null,"endTime":null,"address":"nm desserts olomouc","notes":null,"discovery":null}
"dinner at five guys friday" → {"intent":"plan","title":"Dinner","date":"<friday's date>","startTime":null,"endTime":null,"address":"five guys","notes":null,"discovery":null}
(Contrast: "burgers" / "good burgers" / "burgers near me" stay "discover" with query "burgers" — no brand was named. But "Black Jack Burgers olomouc" is a NAMED shop → "plan" with address "black jack burgers olomouc".)

People examples (assume "Ondra" and "Maty" are SAVED PEOPLE):
"chill at ondras place" → {"intent":"plan","title":"Chill at Ondra's","date":null,"startTime":null,"endTime":null,"address":null,"notes":null,"personId":"<Ondra's id>","usePersonPlace":true,"discovery":null}
"movie night at ondra's" → {"intent":"plan","title":"Movie night at Ondra's","date":null,"startTime":null,"endTime":null,"address":null,"notes":null,"personId":"<Ondra's id>","usePersonPlace":true,"discovery":null}
"cinema with ondra" → {"intent":"plan","title":"Cinema with Ondra","date":null,"startTime":null,"endTime":null,"address":null,"notes":null,"personId":"<Ondra's id>","usePersonPlace":false,"discovery":null}
"call ondra" → {"intent":"plan","title":"Call Ondra","date":null,"startTime":null,"endTime":null,"address":null,"notes":null,"personId":"<Ondra's id>","usePersonPlace":false,"discovery":null}
"ping pong with maty at 18:00" → {"intent":"plan","title":"Ping pong with Maty","date":null,"startTime":"18:00","endTime":"19:00","address":null,"notes":null,"personId":"<Maty's id>","usePersonPlace":false,"discovery":null}

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
}): Promise<
  | { ok: true; parsed: any; usage: TokenUsage }
  | { ok: false; status: number; detail: string }
> {
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
  return { ok: true, parsed, usage: geminiUsage(data?.usageMetadata) };
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

/**
 * Adds the orchestration fields on top of the base draft: the classified
 * `intent` and, for discovery, the validated `{ query, area, nearby }` search
 * shape. Defensive — a "discover" with no usable category degrades to "plan",
 * and a discovered place must be chosen later so its address is dropped.
 */
function shapeResult(parsed: any, rawText: string) {
  const draft = shapeDraft(parsed, rawText);
  let intent: 'plan' | 'discover' = parsed?.intent === 'discover' ? 'discover' : 'plan';
  let discovery: { query: string; area: string | null; nearby: boolean } | null = null;

  // A saved person the line referenced, and whether to use THEIR place. The
  // client resolves the actual coordinates from its local people store — the
  // model only decides WHO and WHETHER, never emits a location.
  const personId =
    typeof parsed?.personId === 'string' && parsed.personId.trim()
      ? parsed.personId.trim()
      : null;
  const usePersonPlace = personId != null && parsed?.usePersonPlace === true;

  if (intent === 'discover') {
    const d = parsed?.discovery ?? {};
    const query =
      typeof d?.query === 'string' && d.query.trim() ? d.query.trim().slice(0, 120) : '';
    if (query) {
      discovery = {
        query,
        area: typeof d?.area === 'string' && d.area.trim() ? d.area.trim().slice(0, 120) : null,
        nearby: d?.nearby === true,
      };
    } else {
      // "discover" without a category is useless — treat it as an ordinary plan.
      intent = 'plan';
    }
  }

  return {
    ...draft,
    // The discovered venue is chosen in the next step, so never carry a guessed
    // address into a discovery result.
    address: intent === 'discover' ? null : draft.address,
    intent,
    discovery,
    personId,
    usePersonPlace,
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

  let payload: {
    text?: string;
    date?: string;
    people?: { id?: unknown; names?: unknown }[];
  };
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

  // Sanitize the saved people the client sent (id + a few aliases each). Capped
  // so a huge contact list can't blow up the prompt.
  const people: PromptPerson[] = Array.isArray(payload.people)
    ? payload.people
        .map((p) => ({
          id: typeof p?.id === 'string' ? p.id.trim() : '',
          names: Array.isArray(p?.names)
            ? (p.names as unknown[])
                .filter((n): n is string => typeof n === 'string' && n.trim().length > 0)
                .map((n) => n.trim().slice(0, 60))
                .slice(0, 8)
            : [],
        }))
        .filter((p) => p.id && p.names.length > 0)
        .slice(0, 60)
    : [];

  const prompt = buildPrompt(text, today, people);

  let modelUsed = CONFIGURED_ERRAND_MODEL;
  let gem = await callGemini({ prompt, apiKey: geminiKey, model: CONFIGURED_ERRAND_MODEL });
  if (!gem.ok && CONFIGURED_ERRAND_MODEL !== FALLBACK_ERRAND_MODEL) {
    console.warn(
      `parse-errand: model "${CONFIGURED_ERRAND_MODEL}" failed (${gem.detail}); retrying with "${FALLBACK_ERRAND_MODEL}".`,
    );
    modelUsed = FALLBACK_ERRAND_MODEL;
    gem = await callGemini({ prompt, apiKey: geminiKey, model: FALLBACK_ERRAND_MODEL });
  }
  if (!gem.ok) {
    return jsonResponse({ error: 'Parse failed', detail: gem.detail }, gem.status);
  }

  // Every errand line runs through this one call — log its token spend so the
  // errand system's cost is tallyable straight from the function logs.
  logTokenUsage({ fn: 'parse-errand', step: 'orchestrate', model: modelUsed, usage: gem.usage });

  // Also return the usage on the wire (model + token counts) so the client can
  // read this call's spend directly, not just from the function logs.
  return jsonResponse({
    ...shapeResult(gem.parsed, text),
    usage: { model: modelUsed, ...gem.usage },
  });
});
