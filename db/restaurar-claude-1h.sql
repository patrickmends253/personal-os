-- Recupera a tarefa "Claude 1h — automatizar" (2026-07-26).
--
-- Foi arrastada para dentro do "Etsy 2h" e virou subtarefa: o arrastar-para-aninhar
-- apaga a tarefa original e cria uma subtarefa com o mesmo título. Isto desfaz isso.
--
-- Correr uma vez no Supabase → SQL Editor. Pode correr-se duas vezes sem estragar nada.
--
-- ⚠️ O que NÃO volta: as marcações da semana (task_completions) foram apagadas em
-- cascata quando a tarefa desapareceu. O contador volta a 0/5 — se já fizeste alguma
-- vez esta semana, marca outra vez na app.

-- 1. apagar a subtarefa em que ela se transformou
delete from public.subtasks
where user_id = (select id from auth.users order by created_at limit 1)
  and title like 'Claude 1h%';

-- 2. abrir espaço logo a seguir ao "Etsy 2h" (só se a tarefa ainda não existir)
update public.tasks
set position = position + 1
where user_id = (select id from auth.users order by created_at limit 1)
  and position > coalesce(
    (select position from public.tasks
      where user_id = (select id from auth.users order by created_at limit 1)
        and title = 'Etsy 2h'),
    -1)
  and not exists (
    select 1 from public.tasks
    where user_id = (select id from auth.users order by created_at limit 1)
      and title = 'Claude 1h — automatizar');

-- 3. recriar a tarefa tal como estava no seed: semanal, 5×/semana
insert into public.tasks (user_id, title, cadence, quota, position)
select u.id, 'Claude 1h — automatizar', 'weekly', 5,
       coalesce((select position from public.tasks
                  where user_id = u.id and title = 'Etsy 2h'), -1) + 1
from (select id from auth.users order by created_at limit 1) u
where not exists (
  select 1 from public.tasks where user_id = u.id and title = 'Claude 1h — automatizar');

-- 4. confirmar
select title, cadence, quota, position
from public.tasks
order by position, created_at;
