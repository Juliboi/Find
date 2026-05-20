-- DayFlow initial schema.
--
-- Designed to support the MVP: one `day` per user per calendar date, with an
-- ordered list of `plans`, each of which may have any number of `subtasks`.
-- Row-Level Security is enabled and policies restrict access to the owning
-- auth user. For an anonymous MVP we also accept rows where `user_id` is null
-- by using the anon role (relaxed policy below); tighten this later.

create extension if not exists "pgcrypto";

create table if not exists public.days (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  date date not null,
  summary text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, date)
);

create table if not exists public.plans (
  id uuid primary key default gen_random_uuid(),
  day_id uuid not null references public.days(id) on delete cascade,
  title text not null,
  raw_text text not null,
  description text,
  location text,
  start_time time,
  duration_minutes int not null default 30,
  order_index int not null default 0,
  status text not null default 'draft'
    check (status in ('draft', 'needs_clarification', 'scheduled', 'done')),
  clarification_question text,
  clarification_suggestions jsonb,
  created_at timestamptz not null default now()
);

create index if not exists plans_day_id_idx on public.plans(day_id);
create index if not exists plans_day_order_idx on public.plans(day_id, order_index);

create table if not exists public.subtasks (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.plans(id) on delete cascade,
  title text not null,
  duration_minutes int not null default 10,
  order_index int not null default 0
);

create index if not exists subtasks_plan_id_idx on public.subtasks(plan_id);

-- Keep days.updated_at fresh on plan changes.
create or replace function public.touch_day_updated_at()
returns trigger
language plpgsql
as $$
begin
  update public.days set updated_at = now() where id = coalesce(new.day_id, old.day_id);
  return null;
end;
$$;

drop trigger if exists trg_plans_touch_day on public.plans;
create trigger trg_plans_touch_day
after insert or update or delete on public.plans
for each row execute function public.touch_day_updated_at();

-- Row Level Security.
alter table public.days enable row level security;
alter table public.plans enable row level security;
alter table public.subtasks enable row level security;

drop policy if exists "Users manage their own days" on public.days;
create policy "Users manage their own days"
  on public.days
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users manage plans on their days" on public.plans;
create policy "Users manage plans on their days"
  on public.plans
  for all
  using (
    exists (
      select 1 from public.days d
      where d.id = plans.day_id and d.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.days d
      where d.id = plans.day_id and d.user_id = auth.uid()
    )
  );

drop policy if exists "Users manage subtasks on their plans" on public.subtasks;
create policy "Users manage subtasks on their plans"
  on public.subtasks
  for all
  using (
    exists (
      select 1
      from public.plans p
      join public.days d on d.id = p.day_id
      where p.id = subtasks.plan_id and d.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
      from public.plans p
      join public.days d on d.id = p.day_id
      where p.id = subtasks.plan_id and d.user_id = auth.uid()
    )
  );
