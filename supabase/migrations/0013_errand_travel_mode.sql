-- Errands + recurring errands: travel preference (commute vs car).
--
-- Stores how the user wants to GET to a located errand: 'commute' (walk / public
-- transport — the planner auto-picks walk or transit by distance, never a car)
-- or 'car' (route by car when one is available). Only ever set alongside a
-- resolved place; NULL means "use the user's default" (car if they own one, else
-- commute). The planner turns this into a per-leg routing mode so Google Routes
-- prices the trip by car or by transit accordingly. Client-owned,
-- last-write-wins — it round-trips losslessly with the local stores.

alter table public.errands
  add column if not exists travel_mode text;

alter table public.recurring_errands
  add column if not exists travel_mode text;
