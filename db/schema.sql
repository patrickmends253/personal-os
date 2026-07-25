-- Personal OS — database schema (reference copy; run in Supabase SQL Editor).
-- Tables for the Tasks module. All rows are locked to the owner via RLS.

create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  cadence text not null check (cadence in ('daily', 'weekly', 'once')),
  quota int check (quota between 1 and 7),        -- weekly only: times per week
  due_date date,                                  -- once only: null = "quando puder"
  position int not null default 0,                -- flat priority order
  completed_at timestamptz,                       -- once only
  created_at timestamptz not null default now()
);

create table if not exists public.subtasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  task_id uuid not null references public.tasks(id) on delete cascade,
  title text not null,
  for_date date,                                  -- daily blocks: which day's list; null for one-off tasks
  done boolean not null default false,
  position int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.task_completions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  task_id uuid not null references public.tasks(id) on delete cascade,
  done_on date not null default current_date,
  created_at timestamptz not null default now()
);

-- One row per day that the whole plate was cleared. Written by the Tasks module
-- (self-fills when a day ends with nothing open and something done) and read by the
-- Progresso board to draw the streak/heatmap. Unique (user_id, won_on) = at most one/day.
create table if not exists public.day_wins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  won_on date not null default current_date,
  created_at timestamptz not null default now(),
  unique (user_id, won_on)
);

alter table public.tasks enable row level security;
alter table public.subtasks enable row level security;
alter table public.task_completions enable row level security;
alter table public.day_wins enable row level security;

create policy "own rows" on public.tasks
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own rows" on public.subtasks
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own rows" on public.task_completions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own rows" on public.day_wins
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- The step-3 sync smoke-test is superseded by the Tasks module:
drop table if exists public.sync_test;
