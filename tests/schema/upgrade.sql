-- Upgrade test for supabase/schema.sql, run by tests/schema/run.sh as supabase_admin on a database where
-- the previous release's schema (schema-v1.sql: no goal_id, 32 KB settings limit) was applied and used.
-- Prints "ok N - upgrade: ..." / "not ok N - upgrade: ...".

\set ON_ERROR_STOP 1
\set as_admin 'reset role; reset request.jwt.claims;'
\set as_a 'reset role; set request.jwt.claims = ''{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated"}''; set role authenticated;'
\set as_b 'reset role; set request.jwt.claims = ''{"sub":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","role":"authenticated"}''; set role authenticated;'

:as_admin
\ir helpers.sql

-- data written by the v1 app: operations (one a tombstone) and a v1 settings document with "goal"
:as_a
insert into public.transactions (id, type, amount, category, note, date, created_ms, client_updated_ms)
values ('v1a', 'saving', 1500, 'savings', 'В копилку', '2026-09-05', 1757000000000, 1000),
       ('v1b', 'expense', 45, 'cafe', '', '2026-09-06', 1757100000000, 1000);
insert into public.transactions (id, deleted, client_updated_ms) values ('v1gone', true, 1000);
insert into public.budget_settings (data, client_updated_ms) values
  ('{"startBalance": 1000, "goal": {"name": "Отпуск", "target": 6000, "deadline": "", "initial": 0}, "limits": {"cafe": 300},
     "_ms": {"startBalance": 900, "goal": 950, "limits": 1000, "at": 1000}}', 1000);
:as_admin
select count(*) as v1_rows from public.transactions \gset
select t.ok('upgrade: the v1 schema has no goal_id yet',
  not exists (select 1 from pg_attribute where attrelid = 'public.transactions'::regclass and attname = 'goal_id'));

-- the user runs the new schema.sql in the SQL editor (twice: re-running must be harmless)
\connect - postgres
\ir ../../supabase/schema.sql
\ir ../../supabase/schema.sql
\connect - supabase_admin

select t.ok('upgrade: goal_id added as a nullable text column',
  (select data_type = 'text' and is_nullable = 'YES' and column_default is null from information_schema.columns
   where table_schema = 'public' and table_name = 'transactions' and column_name = 'goal_id'));
select t.ok('upgrade: every v1 row kept, with goal_id NULL (= the first goal)',
  (select count(*) = :v1_rows and bool_and(goal_id is null) from public.transactions));
select t.ok('upgrade: the v1 settings document is untouched (the app migrates goal → goals when it reads it)',
  (select data -> 'goal' ->> 'name' = 'Отпуск' and client_updated_ms = 1000 from public.budget_settings));
select t.ok('upgrade: goal_id check and the 64 KB settings check are in place, once each',
  (select count(*) = 1 from pg_constraint where conname = 'transactions_goal_id_format')
  and (select count(*) = 1 from pg_constraint where conname = 'budget_settings_data_size'
       and pg_get_constraintdef(oid) like '%<= 65536%'));
select t.ok('upgrade: RLS forced, 4+4 policies, 2 triggers, grants unchanged',
  (select bool_and(relrowsecurity and relforcerowsecurity) from pg_class
   where oid in ('public.transactions'::regclass, 'public.budget_settings'::regclass))
  and (select count(*) = 8 from pg_policies where schemaname = 'public')
  and (select count(*) = 2 from pg_trigger where not tgisinternal
       and tgrelid in ('public.transactions'::regclass, 'public.budget_settings'::regclass))
  and not has_table_privilege('anon', 'public.transactions', 'select')
  and has_table_privilege('authenticated', 'public.transactions', 'select, insert, update, delete')
  and not has_table_privilege('authenticated', 'public.transactions', 'truncate'));

-- the v2 app pushes: the old row with a goal, a new saving, and its settings document as v2 (>32 KB is fine now)
:as_a
select t.affects('upgrade: a v2 push sets goal_id on a v1 row (newer client_updated_ms)',
  $$insert into public.transactions (user_id, id, type, amount, category, note, date, created_ms, goal_id, example, deleted, client_updated_ms)
    values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'v1a', 'saving', 1500, 'savings', 'В копилку', '2026-09-05', 1757000000000, 'g_main', false, false, 2000)
    on conflict (user_id, id) do update set type = excluded.type, amount = excluded.amount, category = excluded.category,
      note = excluded.note, date = excluded.date, created_ms = excluded.created_ms, goal_id = excluded.goal_id,
      example = excluded.example, deleted = excluded.deleted, client_updated_ms = excluded.client_updated_ms$$, 1);
select t.fails('upgrade: an invalid goal_id is refused', $$update public.transactions set goal_id = 'g main', client_updated_ms = 3000 where id = 'v1b'$$, '23514');
select t.affects('upgrade: a settings document over the old 32 KB limit is accepted now',
  $$update public.budget_settings set data = jsonb_build_object('startBalance', 1, 'goals', '[]'::jsonb, 'x', repeat('a', 40000)), client_updated_ms = 2000$$, 1);
:as_b
select t.ok('upgrade: B sees none of A''s rows or goal ids', (select count(*) from public.transactions) = 0);
select t.affects('upgrade: B cannot change A''s goal_id', $$update public.transactions set goal_id = 'g_evil', client_updated_ms = 9000000000000$$, 0);
:as_admin
select t.ok('upgrade: A''s goal_id stays', (select goal_id = 'g_main' from public.transactions where id = 'v1a'));

select format('summary (upgrade): %s checks, %s failed', count(*), count(*) filter (where not ok)) from t.results;
