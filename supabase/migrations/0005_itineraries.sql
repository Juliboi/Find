-- Saved itineraries (generated day plans) — cloud sync.
--
-- One row per planned day the user kept. Mirrors the local `useSavedItineraries`
-- store: a few denormalised summary columns (title/date/origin/city/stop_count/
-- thumb_url) used to render the homepage card without parsing the blob, plus the
-- full `Itinerary` object as JSONB so a saved day re-opens with its sections,
-- travel legs, and map data intact — offline included.
--
-- Same local-first contract as errands: the client owns the string id (e.g.
-- "saved_ab12") and writes `updated_at` itself so sync can resolve merges with
-- last-write-wins on the client's clock.

create table if not exists public.itineraries (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default 'Your day',
  date text,
  origin text,
  city text,
  stop_count integer not null default 0,
  thumb_url text,
  itinerary jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists itineraries_user_id_idx on public.itineraries (user_id);

alter table public.itineraries enable row level security;

drop policy if exists "Itineraries are viewable by owner" on public.itineraries;
create policy "Itineraries are viewable by owner"
  on public.itineraries
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can insert their own itineraries" on public.itineraries;
create policy "Users can insert their own itineraries"
  on public.itineraries
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update their own itineraries" on public.itineraries;
create policy "Users can update their own itineraries"
  on public.itineraries
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can delete their own itineraries" on public.itineraries;
create policy "Users can delete their own itineraries"
  on public.itineraries
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);

grant select, insert, update, delete on public.itineraries to authenticated;
