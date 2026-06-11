-- Errands (smart reminders) — cloud sync.
--
-- One row per errand the user jots from the composer ("call mom", "dentist at
-- 18:00 at Pirktova"). Mirrors the local `useErrandsStore` shape so the app can
-- stay local-first (instant, offline) while syncing through Supabase across
-- devices. The client owns the primary key (a stable string id like
-- "errand_ab12") so an offline-created errand keeps the same id once it reaches
-- the server — no id reconciliation needed.
--
-- `updated_at` is written by the CLIENT (not a trigger) because sync uses
-- last-write-wins on the client's clock: the device that touched the row most
-- recently wins a merge. Time/date slots are kept as plain text ("HH:MM",
-- "YYYY-MM-DD") to round-trip losslessly with the app, which treats them as
-- strings everywhere.

create table if not exists public.errands (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  start_time text,
  end_time text,
  date text,
  address text,
  latitude double precision,
  longitude double precision,
  place_id text,
  photo_url text,
  rating double precision,
  rating_count integer,
  price_level integer,
  opening_hours jsonb,
  notes text,
  raw_text text not null default '',
  done boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Fetch "my errands" cheaply (the only query the app runs).
create index if not exists errands_user_id_idx on public.errands (user_id);

alter table public.errands enable row level security;

-- A user may only ever touch their own errands. auth.uid() is wrapped in a
-- subselect so Postgres evaluates it once per statement, not once per row.
drop policy if exists "Errands are viewable by owner" on public.errands;
create policy "Errands are viewable by owner"
  on public.errands
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can insert their own errands" on public.errands;
create policy "Users can insert their own errands"
  on public.errands
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

-- UPDATE needs both USING (which rows are visible to update) and WITH CHECK
-- (what the row may become) so a user can't reassign an errand to someone else.
drop policy if exists "Users can update their own errands" on public.errands;
create policy "Users can update their own errands"
  on public.errands
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can delete their own errands" on public.errands;
create policy "Users can delete their own errands"
  on public.errands
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);

-- Reach the table through the Data API (RLS above still restricts the rows).
grant select, insert, update, delete on public.errands to authenticated;
