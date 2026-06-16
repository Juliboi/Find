-- Link a materialized errand instance back to its recurring template.
--
-- When a recurring errand ("every Monday ping pong") is due on a day, the app
-- creates a real `errands` row for that occurrence with a DETERMINISTIC id
-- (rcr_<templateId>_<yyyymmdd>) and stamps `recurring_id` with the template id.
-- This lets the home screen group recurring occurrences in their own section
-- and lets the app find/prune generated instances. Plain user errands leave it
-- null.

alter table public.errands
  add column if not exists recurring_id text;
