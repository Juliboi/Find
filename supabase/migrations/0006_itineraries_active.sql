-- Active plan per day.
--
-- A day can hold several saved itineraries (one row each in `itineraries`).
-- `is_active` flags the one the user pinned as that day's plan — the one the
-- homepage shows. The client enforces "at most one active per date"; when no
-- row for a day is flagged, the app falls back to the earliest-created plan.
--
-- Rides the existing per-row last-write-wins sync (the client writes
-- `updated_at` on change), so no new policy or function is needed — the
-- itineraries RLS in 0005 already scopes this column to the owner.

alter table public.itineraries
  add column if not exists is_active boolean not null default false;
