-- Migração 2026-07-27: categorias por tarefa + planear o dia seguinte.
-- Correr uma vez no Supabase → SQL Editor. Pode correr-se duas vezes sem estragar nada.
--
-- ⚠️ Correr DEPOIS de db/migracao-categorias-e-historico.sql.

-- 1) Categorias passam a ser de cada tarefa, não partilhadas.
--    Decisão dele (2026-07-27): "Personal OS" faz sentido no Claude 1h e não faz
--    nenhum no Exercício físico, por isso cada tarefa tem a sua lista.
alter table public.categories
  add column if not exists task_id uuid references public.tasks(id) on delete cascade;

-- As categorias criadas antes desta mudança não pertencem a nenhuma tarefa e por isso
-- deixam de aparecer. Não são apagadas aqui de propósito — se quiseres limpá-las,
-- descomenta a linha seguinte:
-- delete from public.categories where task_id is null;

-- 2) Que tarefas foram escolhidas para um dia. Uma data por tarefa: escolher para
--    amanhã substitui a escolha anterior, que é como ele planeia (um dia de cada vez).
alter table public.tasks
  add column if not exists planned_for date;

-- 3) Qual das tarefas é a página de planeamento. É uma flag e não o título, para o
--    poder mudar de nome sem partir nada.
alter table public.tasks
  add column if not exists is_planner boolean not null default false;

update public.tasks
set is_planner = true
where title = 'Planear o dia seguinte'
  and is_planner = false;

-- confirmar
select title, cadence, planned_for, is_planner
from public.tasks
order by position, created_at;
