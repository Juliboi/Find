-- People (contacts) — cloud sync.
--
-- One row per person the user saves ("Ondra", "Maty"). A person carries a few
-- nicknames and ONE fixed place — the home/flat/spot the parser uses when the
-- user writes a possessive ("chill at Ondra's place") but NOT when the person
-- is only a companion ("cinema with Ondra", "call Ondra"). Mirrors the local
-- `usePeopleStore` shape so the app stays local-first (instant, offline) while
-- syncing across devices.
--
-- The client owns the primary key (a stable string id like "person_ab12") so an
-- offline-created person keeps the same id once it reaches the server — no id
-- reconciliation needed. `updated_at` is written by the CLIENT because sync uses
-- last-write-wins on the client's clock.

create table if not exists public.people (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  -- Extra aliases the user answers to ("Ondra" → ["Ondrej", "Ondra K"]). The
  -- parser matches the name AND any nickname.
  nicknames text[] not null default '{}',
  -- The person's ONE fixed place. label is the human address; coords are present
  -- once a real place was picked from search (so the planner can route there).
  place_label text,
  place_latitude double precision,
  place_longitude double precision,
  place_id text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Fetch "my people" cheaply (the only query the app runs).
create index if not exists people_user_id_idx on public.people (user_id);

alter table public.people enable row level security;

-- A user may only ever touch their own people. auth.uid() is wrapped in a
-- subselect so Postgres evaluates it once per statement, not once per row.
drop policy if exists "People are viewable by owner" on public.people;
create policy "People are viewable by owner"
  on public.people
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can insert their own people" on public.people;
create policy "Users can insert their own people"
  on public.people
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

-- UPDATE needs both USING (which rows are visible to update) and WITH CHECK
-- (what the row may become) so a user can't reassign a person to someone else.
drop policy if exists "Users can update their own people" on public.people;
create policy "Users can update their own people"
  on public.people
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can delete their own people" on public.people;
create policy "Users can delete their own people"
  on public.people
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);

-- Reach the table through the Data API (RLS above still restricts the rows).
grant select, insert, update, delete on public.people to authenticated;
