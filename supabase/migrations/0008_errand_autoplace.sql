-- Errands: "Let AI plan it" (auto-place).
--
-- Lets the user save an errand WITHOUT pinning a specific venue and instead
-- defer the choice to the day-planner: when the errand is folded into a plan,
-- the planner finds the best spot for `place_query` (closest / least detour /
-- open at the time). `auto_place` is the flag; `place_query` carries the search
-- category ("grocery store", "gas station") pulled from the discovery query.
-- Mutually exclusive with a resolved address — the client clears one when the
-- other is set. Both NULL for an ordinary errand, matching `useErrandsStore`.

alter table public.errands
  add column if not exists auto_place boolean,
  add column if not exists place_query text;
