-- Upgrade test for supabase/schema.sql, run by tests/schema/run.sh as supabase_admin on a database where
-- the first release's schema (schema-v1.sql: no goal_id, 32 KB settings limit, no v3 columns) was applied and
-- used. Straight from v1 to the current schema (v3: accounts, transfers, installments).
-- Prints "ok N - upgrade: ..." / "not ok N - upgrade: ...". (upgrade-v2.sql does the same from v2.)

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
select md5(string_agg(format('%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s', user_id, id, type, amount, category, note, date, created_ms,
                             example, deleted, client_updated_ms, updated_at), ',' order by user_id, id)) as v1_digest
from public.transactions \gset
select t.ok('upgrade: the v1 schema has no goal_id and no v3 columns yet',
  not exists (select 1 from pg_attribute where attrelid = 'public.transactions'::regclass
              and attname in ('goal_id', 'account', 'to_account', 'plan_id', 'plan_n', 'plan_of')));
select t.fails('upgrade: the v1 schema refuses a transfer', $$insert into public.transactions (user_id, id, type, amount, date) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'pre', 'transfer', 1, '2026-10-01')$$,
  '23514');

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
select t.ok('upgrade: v3 columns added (account, to_account, plan_id text; plan_n, plan_of smallint; nullable, no default)',
  (select count(*) = 5 and bool_and(is_nullable = 'YES' and column_default is null
          and data_type = case when column_name in ('plan_n', 'plan_of') then 'smallint' else 'text' end)
   from information_schema.columns
   where table_schema = 'public' and table_name = 'transactions'
     and column_name in ('account', 'to_account', 'plan_id', 'plan_n', 'plan_of')));
select t.ok('upgrade: every v1 row unchanged (values and updated_at), NULL in all v3 columns',
  (select md5(string_agg(format('%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s', user_id, id, type, amount, category, note, date, created_ms,
                                example, deleted, client_updated_ms, updated_at), ',' order by user_id, id)) = :'v1_digest'
          and bool_and(account is null and to_account is null and plan_id is null and plan_n is null and plan_of is null)
   from public.transactions));
select t.ok('upgrade: type allows transfer, the 8 v3 checks are in place once each',
  pg_get_constraintdef((select oid from pg_constraint where conname = 'transactions_type_valid')) like '%''transfer''%'
  and (select count(*) = 8 and count(distinct conname) = 8 from pg_constraint
       where conrelid = 'public.transactions'::regclass and conname in (
         'transactions_account_format', 'transactions_to_account_format', 'transactions_to_account_transfer_only',
         'transactions_transfer_accounts', 'transactions_plan_id_format', 'transactions_plan_complete',
         'transactions_plan_range', 'transactions_plan_expense_only')));
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

-- the v3 app pushes: an old v1 expense moved onto a card, a transfer, and a split purchase
:as_a
select t.affects('upgrade: a v3 push puts a v1 row on an account (newer client_updated_ms)',
  $$insert into public.transactions (user_id, id, type, amount, category, note, date, created_ms, goal_id, account, to_account, plan_id, plan_n, plan_of, example, deleted, client_updated_ms)
    values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'v1b', 'expense', 45, 'cafe', '', '2026-09-06', 1757100000000, null, 'a_max', null, null, null, null, false, false, 4000)
    on conflict (user_id, id) do update set type = excluded.type, amount = excluded.amount, category = excluded.category,
      note = excluded.note, date = excluded.date, created_ms = excluded.created_ms, goal_id = excluded.goal_id,
      account = excluded.account, to_account = excluded.to_account, plan_id = excluded.plan_id, plan_n = excluded.plan_n,
      plan_of = excluded.plan_of, example = excluded.example, deleted = excluded.deleted, client_updated_ms = excluded.client_updated_ms$$, 1);
select t.affects('upgrade: a v3 transfer and a 2-part split purchase are accepted',
  $$insert into public.transactions (id, type, amount, category, date, account, to_account, plan_id, plan_n, plan_of, client_updated_ms)
    values ('v3tr', 'transfer', 300, 'transfer', '2026-10-10', 'a_main', 'a_max', null, null, null, 4000),
           ('v3s1', 'expense', 500, 'tech', '2026-10-10', 'a_max', null, 'p_phone', 1, 2, 4000),
           ('v3s2', 'expense', 500, 'tech', '2026-11-10', 'a_max', null, 'p_phone', 2, 2, 4000)$$, 3);
select t.violates('upgrade: a transfer to the same account is refused',
  $$insert into public.transactions (id, type, amount, date, account, to_account) values ('v3bad', 'transfer', 1, '2026-10-10', 'a_max', 'a_max')$$,
  'transactions_transfer_accounts');
select t.violates('upgrade: a plan on income is refused',
  $$insert into public.transactions (id, type, amount, date, plan_id, plan_n, plan_of) values ('v3bad', 'income', 1, '2026-10-10', 'p_x', 1, 2)$$,
  'transactions_plan_expense_only');
:as_b
select t.affects('upgrade: B cannot redirect A''s transfer', $$update public.transactions set to_account = 'a_evil', client_updated_ms = 9000000000000$$, 0);
:as_admin
select t.ok('upgrade: A''s v3 rows stored as sent',
  (select account = 'a_max' and plan_id is null from public.transactions where id = 'v1b')
  and (select to_account = 'a_max' from public.transactions where id = 'v3tr')
  and (select count(*) = 2 and bool_and(plan_of = 2) from public.transactions where plan_id = 'p_phone'));

select format('summary (upgrade): %s checks, %s failed', count(*), count(*) filter (where not ok)) from t.results;
