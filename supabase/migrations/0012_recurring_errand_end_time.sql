-- Recurring errands: availability window end.
--
-- Adds the "to" edge of a Between window to the recurring TEMPLATE. When
-- `end_time` is set (alongside `start_time`), the template means "I'm open
-- between start…end" and each materialized occurrence carries that window so the
-- planner fits a `duration_min` block inside it; when NULL, `start_time` is a
-- fixed time (or the template is untimed). Mirrors `errands.end_time` so an
-- occurrence inherits the same semantics. Client-owned, last-write-wins — it
-- round-trips losslessly with `useRecurringErrandsStore`.

alter table public.recurring_errands
  add column if not exists end_time text;
