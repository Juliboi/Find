-- Profiles + onboarding.
--
-- One row per auth user, created lazily (upserted) by the app once the user
-- completes onboarding. Holds the answers collected during onboarding: the
-- home anchor (label + coords), wake/bed times, and whether the user owns a
-- car. `onboarding_completed` is what the launch-time auth gate reads to decide
-- whether to send the user into the onboarding flow.
--
-- We deliberately DON'T auto-create the row with a SECURITY DEFINER trigger on
-- auth.users — the client upserts its own row under RLS instead, which keeps
-- the access model simple and avoids a privileged function in a public schema.

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  email text,
  home_label text,
  home_latitude double precision,
  home_longitude double precision,
  -- Stored as `time` (no date) — these are wall-clock daily anchors.
  wake_time time,
  bed_time time,
  has_car boolean not null default false,
  onboarding_completed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- A user may only ever touch their own row. auth.uid() is wrapped in a
-- subselect so Postgres evaluates it once per statement, not once per row.
drop policy if exists "Profiles are viewable by owner" on public.profiles;
create policy "Profiles are viewable by owner"
  on public.profiles
  for select
  to authenticated
  using ((select auth.uid()) = id);

drop policy if exists "Users can insert their own profile" on public.profiles;
create policy "Users can insert their own profile"
  on public.profiles
  for insert
  to authenticated
  with check ((select auth.uid()) = id);

-- UPDATE needs both USING (which rows are visible to update) and WITH CHECK
-- (what the row may become) so a user can't reassign their row to someone else.
drop policy if exists "Users can update their own profile" on public.profiles;
create policy "Users can update their own profile"
  on public.profiles
  for update
  to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

-- Keep updated_at honest on every write. `search_path = ''` pins resolution so
-- the function can't be hijacked by a rogue schema on the caller's path (it only
-- needs now(), which lives in the always-present pg_catalog).
create or replace function public.touch_profiles_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_profiles_touch_updated_at on public.profiles;
create trigger trg_profiles_touch_updated_at
before update on public.profiles
for each row execute function public.touch_profiles_updated_at();

-- Make sure the authenticated role can reach the table through the Data API.
-- (RLS above still restricts which rows it sees.)
grant select, insert, update on public.profiles to authenticated;
