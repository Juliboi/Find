# DayFlow

A mobile app that helps you plan a single day. Instead of being yet another
calendar, DayFlow is a dynamic helper that:

- accepts free-form plans you want to do today,
- orders them so the day flows logically (errands first, gym before meals, focused work in chunks, relaxation later),
- estimates how long each plan should take,
- breaks down complex plans into sensible sub-steps (e.g. cooking → prep, cook, eat, cleanup),
- asks mandatory follow-ups for vague plans that depend on a place (e.g. "go to the gym" → which gym?), with quick-pick suggestions you can tap.

Built with Expo (React Native) + Expo Router on the client, and Supabase
(Postgres + Edge Functions) on the server. The "AI" lives in a Supabase Edge
Function that calls OpenAI; if the function is not configured, the app falls
back to a built-in heuristic scheduler so it always works.

The UI is intentionally minimal and reads more like a chat than a calendar.

## Stack

- **App**: Expo SDK 51, Expo Router, TypeScript, Zustand for state, AsyncStorage for persistence.
- **Backend**: Supabase (Postgres, Auth-ready, Edge Functions).
- **AI**: OpenAI `gpt-4o-mini` via a Supabase Edge Function. Heuristic fallback when not configured.
- **Location / routing**: not in MVP. Designed to slot in later — see [Roadmap](#roadmap).

## Project layout

```
app/                        Expo Router screens
  _layout.tsx               Root stack + theme + safe area
  index.tsx                 Today's schedule
  add.tsx                   Add / edit draft plans (modal)
src/
  components/               Buttons, Input, Chip, PlanCard, EmptyState
  lib/
    supabase.ts             Supabase client (falls back to null if unconfigured)
    ai/
      heuristics.ts         Local pattern-based scheduler
      scheduler.ts          scheduleDay() — Edge Function with local fallback
  store/useDayStore.ts      Zustand store, persisted to AsyncStorage
  theme/                    Color tokens + useTheme()
  types/plan.ts             Plan / SubTask / DaySchedule
  utils/                    id + time helpers
supabase/
  config.toml               Function config
  migrations/0001_init.sql  days / plans / subtasks tables + RLS
  functions/schedule-day/   OpenAI-powered scheduler edge function
```

## Quick start

```bash
npm install
cp .env.example .env       # optional — app works without it
npm start                  # then press i / a / w
```

The app runs immediately with no configuration. Plans are kept in
AsyncStorage and ordered by the local heuristic scheduler.

## Wiring up Supabase + AI

1. Create a Supabase project at <https://supabase.com>.
2. Apply the migration:
   ```bash
   supabase link --project-ref <your-ref>
   supabase db push
   ```
3. Deploy the edge function and set the OpenAI key:
   ```bash
   supabase functions deploy schedule-day --no-verify-jwt
   supabase secrets set OPENAI_API_KEY=sk-...
   ```
4. Add the public Supabase URL + anon key to your `.env`:
   ```
   EXPO_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co
   EXPO_PUBLIC_SUPABASE_ANON_KEY=eyJ...
   ```
5. Restart `npm start`. The client will now invoke `schedule-day` for ordering
   plans; if anything fails it transparently falls back to local heuristics.

## How the AI flow works

1. User opens **Add plans**, types one plan per line (or taps suggestion chips).
2. On **Plan my day**, the client calls `scheduleDay(rawPlans)`.
3. `scheduleDay` first tries the Supabase Edge Function `schedule-day`, which
   prompts `gpt-4o-mini` with a strict JSON schema (see
   `supabase/functions/schedule-day/index.ts`). The model returns plans with:
   - `startTime`, `durationMinutes`, `orderIndex`
   - optional `subtasks[]`
   - `status: "needs_clarification"` plus a `clarificationQuestion` and
     up to 3 `clarificationSuggestions` when the plan needs a location or
     detail (e.g. "Which gym?").
4. If the function is not deployed, returns 5xx, or the network is down, the
   client uses `src/lib/ai/heuristics.ts` to produce the same shape locally.
5. The home screen renders the ordered cards. Plans that need clarification
   show their question and quick-pick chips inline; tapping a chip resolves
   the question and re-runs ordering.

## Roadmap

Items intentionally out of scope for the MVP and easy to bolt on:

- Real location autocomplete + routing (Google Places + Directions, or the
  Mapbox equivalent) replacing the suggestion chips.
- Travel time between plans factored into ordering (TSP-ish optimization).
- Push notifications when it's time to start a plan.
- Multi-day support and historical days.
- Optional chat-style iterative mode where the assistant keeps replying until
  the user explicitly confirms. The scaffolding (clarification questions and
  re-scheduling) is already in place.
- Supabase Auth and syncing days across devices using the existing schema.
