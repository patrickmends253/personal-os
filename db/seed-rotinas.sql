-- Seed: his weekly operating structure as recurring tasks (source: context.md,
-- transcribed from his iPad handwritten plan). Safe to re-run — skips titles that exist.
-- Order reflects his stated priorities: Etsy #1, AI system #2; evening ritual last.
-- No clock times are stored on purpose (§8: no clock-gating, no timers).

insert into public.tasks (user_id, title, cadence, quota, position)
select u.id, t.title, t.cadence, t.quota, t.position
from (select id from auth.users order by created_at limit 1) u
cross join (values
  ('Etsy 2h',                     'daily',  null::int, 0),
  ('Claude 1h — automatizar',     'weekly', 5,         1),
  ('Exercício físico 30 min',     'weekly', 5,         2),
  ('Escrever 20 min',             'weekly', 5,         3),
  ('Aprender / melhorar algo 1h', 'weekly', 5,         4),
  ('Ler livro 1h',                'weekly', 5,         5),
  ('Treino intenso',              'weekly', 1,         6),
  ('Brainstorm com Claude',       'weekly', 1,         7),
  ('Planear o dia seguinte',      'daily',  null,      8)
) as t(title, cadence, quota, position)
where not exists (
  select 1 from public.tasks x where x.user_id = u.id and x.title = t.title
);
