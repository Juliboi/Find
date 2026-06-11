-- Errands: duration estimate.
--
-- Adds the rough length (minutes) an errand takes. Decoupled from the start/end
-- slots so an UNTIMED ("Anytime") errand can still carry a "how long" estimate
-- the planner uses to reserve enough time in a gap. For a timed errand it mirrors
-- end_time − start_time; NULL means "any length" (no estimate given). The client
-- owns this value the same way it owns the other slots — last-write-wins on the
-- client clock — so it round-trips losslessly with `useErrandsStore`.

alter table public.errands
  add column if not exists duration_min integer;
