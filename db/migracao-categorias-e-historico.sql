-- Migração 2026-07-26: categorias nas subtarefas + histórico por tarefa.
-- Correr uma vez no Supabase → SQL Editor. Pode correr-se duas vezes sem estragar nada.
--
-- 1) categories  — etiquetas dele ("Personal OS", "Dashboards", …) com cor, para marcar
--    subtarefas. São globais: a mesma categoria serve em qualquer tarefa.
-- 2) task_days   — quanto do plano de cada dia ficou feito, por tarefa. É daqui que sai o
--    quadro verde/laranja/vermelho de cada página. Guarda os NÚMEROS (done/total); as
--    cores são uma decisão de desenho, decidida na altura de desenhar, não aqui.

create table if not exists public.categories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  color text not null,                            -- hex da paleta fixa em tasks.js
  position int not null default 0,
  created_at timestamptz not null default now()
);

-- apagar uma categoria não apaga subtarefas: só as deixa sem etiqueta
alter table public.subtasks
  add column if not exists category_id uuid references public.categories(id) on delete set null;

create table if not exists public.task_days (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  task_id uuid not null references public.tasks(id) on delete cascade,
  day date not null,
  done int not null default 0,                    -- passos feitos nesse dia
  total int not null default 0,                   -- passos planeados nesse dia
  created_at timestamptz not null default now(),
  unique (user_id, task_id, day)
);

alter table public.categories enable row level security;
alter table public.task_days enable row level security;

drop policy if exists "own rows" on public.categories;
create policy "own rows" on public.categories
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own rows" on public.task_days;
create policy "own rows" on public.task_days
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- confirmar
select 'categories' as tabela, count(*) from public.categories
union all
select 'task_days', count(*) from public.task_days;
