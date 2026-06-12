-- Morning routine, meal windows, and wind-down preferences.
--
-- These extend the daily rhythm captured at onboarding (wake_time / bed_time)
-- so the planner can shape the day with more nuance than just "start" and
-- "end":
--   * wake_up_duration_min — how long the user takes to actually get going
--     after waking, so we keep the first stretch gentle and only expect
--     focused/productive activity once they've ramped up.
--   * breakfast/lunch/dinner windows — the times the user is comfortable
--     eating each meal, used as soft windows for "meal" blocks.
--   * wind_down_time — the point in the evening after which the planner must
--     stop adding high-energy activities and stick to calm, sleep-friendly
--     ones (reading, stretching, a bath …).
--   * allow_screen_wind_down — whether screen-heavy wind-down activities
--     (TV/movies, gaming, scrolling) are acceptable near bedtime. Defaults to
--     false (sleep-protective); the app warns about sleep quality when on.
--
-- All nullable / defaulted so existing rows stay valid without a backfill.

alter table public.profiles
  add column if not exists wake_up_duration_min integer not null default 30,
  add column if not exists breakfast_start time,
  add column if not exists breakfast_end time,
  add column if not exists lunch_start time,
  add column if not exists lunch_end time,
  add column if not exists dinner_start time,
  add column if not exists dinner_end time,
  add column if not exists wind_down_time time,
  add column if not exists allow_screen_wind_down boolean not null default false;
