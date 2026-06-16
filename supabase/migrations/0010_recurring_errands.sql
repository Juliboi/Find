-- Recurring errands (templates) — cloud sync.
--
-- One row per recurring DEFINITION the user sets up ("every Monday ping pong at
-- 18:00"). This is the TEMPLATE — the app materializes a real `errands` row
-- (an editable, skippable instance) for each matching day, linked back via
-- `errands.recurring_id`. Templates are created/edited only in onboarding +
-- Settings; the per-day occurrence is edited as an ordinary errand.
--
-- `weekdays` are JS weekday numbers (0 = Sunday … 6 = Saturday). `skipped_dates`
-- is the exception list: dates ("YYYY-MM-DD") the user skipped, so the template
-- does NOT regenerate an instance for them. Place columns mirror `errands` so an
-- occurrence inherits a pinned venue or a "let Diem find it" auto-place.
--
-- Client owns the primary key (e.g. "rcr_ab12"); `updated_at` is client-written
-- for last-write-wins sync, exactly like errands.

create table if not exists public.recurring_errands (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  -- JS weekday numbers 0..6 (0 = Sunday). Empty = never fires.
  weekdays integer[] not null default '{}',
  start_time text,
  duration_min integer,
  -- Place, mirroring errands: a pinned venue (address + coords) OR an
  -- auto-place ("let Diem find it") with a category query.
  address text,
  latitude double precision,
  longitude double precision,
  place_id text,
  auto_place boolean,
  place_query text,
  notes text,
  -- Dates ("YYYY-MM-DD") the user skipped this occurrence on.
  skipped_dates text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Fetch "my recurring errands" cheaply (the only query the app runs).
create index if not exists recurring_errands_user_id_idx
  on public.recurring_errands (user_id);

alter table public.recurring_errands enable row level security;

-- A user may only ever touch their own recurring errands. auth.uid() is wrapped
-- in a subselect so Postgres evaluates it once per statement, not once per row.
drop policy if exists "Recurring errands are viewable by owner" on public.recurring_errands;
create policy "Recurring errands are viewable by owner"
  on public.recurring_errands
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can insert their own recurring errands" on public.recurring_errands;
create policy "Users can insert their own recurring errands"
  on public.recurring_errands
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

-- UPDATE needs both USING (which rows are visible to update) and WITH CHECK
-- (what the row may become) so a user can't reassign a template to someone else.
drop policy if exists "Users can update their own recurring errands" on public.recurring_errands;
create policy "Users can update their own recurring errands"
  on public.recurring_errands
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can delete their own recurring errands" on public.recurring_errands;
create policy "Users can delete their own recurring errands"
  on public.recurring_errands
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);

-- Reach the table through the Data API (RLS above still restricts the rows).
grant select, insert, update, delete on public.recurring_errands to authenticated;
