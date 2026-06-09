-- Dietary preferences for itinerary personalisation.
--
-- `dietary` holds canonical tags chosen from a fixed set during onboarding
-- (e.g. {vegetarian, gluten-free}); `dietary_notes` is freeform for anything
-- the chips don't cover (allergies, "no pork", etc.). Both feed the planner so
-- it only picks food/drink venues the user can actually eat at. Defaults keep
-- existing rows valid without a backfill.

alter table public.profiles
  add column if not exists dietary text[] not null default '{}',
  add column if not exists dietary_notes text;
