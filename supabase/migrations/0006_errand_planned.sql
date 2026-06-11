-- Errands: "Planned" state.
--
-- Adds the day ("YYYY-MM-DD") an errand was folded into a plan. Its presence
-- marks the errand as "Planned" (vs the boolean `done`, which stays "Done");
-- once that day is in the past the app treats it as done. The client owns this
-- value the same way it owns the other slot text — plain text, last-write-wins
-- on the client clock — so it round-trips losslessly with `useErrandsStore`.

alter table public.errands
  add column if not exists planned_date text;
