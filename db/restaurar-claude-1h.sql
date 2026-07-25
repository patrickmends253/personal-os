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

begin;

with me as (
  select id from auth.users order by created_at limit 1
),

-- 1. apagar a subtarefa que ela virou (fica pendurada no "Etsy 2h")
limpa as (
  delete from public.subtasks s
  using public.tasks t, me
  where s.task_id = t.id
    and t.user_id = me.id
    and t.title = 'Etsy 2h'
    and s.title like 'Claude 1h%'
  returning s.id
),

-- 2. onde é que ela ficava: logo a seguir ao "Etsy 2h"
alvo as (
  select coalesce(
    (select position from public.tasks, me
      where tasks.user_id = me.id and title = 'Etsy 2h'),
    -1
  ) + 1 as pos
),

-- 3. abrir espaço nessa posição (só se a tarefa ainda não existir)
empurra as (
  update public.tasks set position = position + 1
  from me, alvo
  where tasks.user_id = me.id
    and tasks.position >= alvo.pos
    and not exists (
      select 1 from public.tasks x, me m2
      where x.user_id = m2.id and x.title = 'Claude 1h — automatizar'
    )
  returning tasks.id
)

-- 4. recriar a tarefa tal como estava no seed: semanal, 5×/semana
insert into public.tasks (user_id, title, cadence, quota, position)
select me.id, 'Claude 1h — automatizar', 'weekly', 5, alvo.pos
from me, alvo
where not exists (
  select 1 from public.tasks x where x.user_id = me.id and x.title = 'Claude 1h — automatizar'
);

commit;

-- confirmar:
select title, cadence, quota, position from public.tasks order by position, created_at;
