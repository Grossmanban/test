-- Upgrade test for supabase/schema.sql, run by tests/schema/run.sh as supabase_admin on a database where
-- the v2 release's schema (schema-v2.sql: goal_id, 64 KB settings, no accounts / transfers / installments)
-- was applied and used by the v2 app. Then the current schema.sql runs (twice) and the v3 app takes over.
-- Prints "ok N - upgrade v2: ..." / "not ok N - upgrade v2: ...".

\set ON_ERROR_STOP 1
\set as_admin 'reset role; reset request.jwt.claims;'
\set as_a 'reset role; set request.jwt.claims = ''{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated"}''; set role authenticated;'
\set as_b 'reset role; set request.jwt.claims = ''{"sub":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","role":"authenticated"}''; set role authenticated;'

:as_admin
\ir helpers.sql

-- data written by the v2 app: income, an expense, savings for two goals, an example row, a tombstone, settings
:as_a
insert into public.transactions (id, type, amount, category, note, date, created_ms, goal_id, example, client_updated_ms)
values ('v2inc', 'income', 12000, 'salary', 'Зарплата', '2026-09-01', 1756700000000, null, false, 1000),
       ('v2exp', 'expense', 89.90, 'groceries', 'Шуферсаль', '2026-09-03', 1756900000000, null, false, 1000),
       ('v2sav', 'saving', 700, 'savings', '', '2026-09-04', 1757000000000, 'g_car', false, 1000),
       ('v2sav0', 'saving', 300, 'savings', '', '2026-09-04', 1757000000001, null, false, 1000),
       ('ex_1', 'expense', 50, 'cafe', '', '2026-09-05', 1757100000000, null, true, 1000);
insert into public.transactions (id, deleted, client_updated_ms) values ('v2gone', true, 1000);
insert into public.budget_settings (data, client_updated_ms) values
  ('{"startBalance": 2500, "goals": [{"id": "g_car", "name": "Машина", "target": 40000, "deadline": "", "initial": 0, "icon": "Car", "createdAt": 1}],
     "limits": {"cafe": 300}, "categories": [], "_ms": {"startBalance": 1000, "goals": 1000, "limits": 1000, "categories": 1000, "at": 1000}}', 1000);
:as_b
insert into public.transactions (id, type, amount, category, date, client_updated_ms) values ('v2b', 'expense', 10, 'other', '2026-09-02', 1000);

:as_admin
select count(*) as v2_rows from public.transactions \gset
select md5(string_agg(x::text, ',' order by x.user_id, x.id)) as v2_digest from public.transactions x \gset
select md5(string_agg(x::text, ',' order by x.user_id)) as v2_settings_digest from public.budget_settings x \gset
select t.ok('upgrade v2: the v2 schema has goal_id but no v3 columns yet',
  exists (select 1 from pg_attribute where attrelid = 'public.transactions'::regclass and attname = 'goal_id')
  and not exists (select 1 from pg_attribute where attrelid = 'public.transactions'::regclass
                  and attname in ('account', 'to_account', 'plan_id', 'plan_n', 'plan_of')));
select t.fails('upgrade v2: the v2 schema refuses a transfer',
  $$insert into public.transactions (user_id, id, type, amount, date) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'pre', 'transfer', 1, '2026-10-01')$$,
  '23514');

-- the user runs the new schema.sql in the SQL editor (twice: re-running must be harmless)
\connect - postgres
\ir ../../supabase/schema.sql
\ir ../../supabase/schema.sql
\connect - supabase_admin

select t.ok('upgrade v2: v3 columns added (account, to_account, plan_id text; plan_n, plan_of smallint; nullable, no default)',
  (select count(*) = 5 and bool_and(is_nullable = 'YES' and column_default is null
          and data_type = case when column_name in ('plan_n', 'plan_of') then 'smallint' else 'text' end)
   from information_schema.columns
   where table_schema = 'public' and table_name = 'transactions'
     and column_name in ('account', 'to_account', 'plan_id', 'plan_n', 'plan_of')));
select t.ok('upgrade v2: every v2 row kept, NULL in all v3 columns',
  (select count(*) = :v2_rows
          and bool_and(account is null and to_account is null and plan_id is null and plan_n is null and plan_of is null)
   from public.transactions));
-- x::text before the upgrade = the v2 columns in table order; the v3 columns come after them
select t.ok('upgrade v2: the v2 columns of every row, updated_at included, are byte for byte what they were',
  (select md5(string_agg(row(x.user_id, x.id, x.type, x.amount, x.category, x.note, x.date, x.created_ms, x.example, x.deleted,
                             x.client_updated_ms, x.updated_at, x.goal_id)::text, ',' order by x.user_id, x.id))
   from public.transactions x) = :'v2_digest');
select t.ok('upgrade v2: the settings document is untouched',
  (select md5(string_agg(x::text, ',' order by x.user_id)) = :'v2_settings_digest' from public.budget_settings x));
select t.ok('upgrade v2: type allows transfer, the 8 v3 checks are in place once each, older checks still once',
  pg_get_constraintdef((select oid from pg_constraint where conname = 'transactions_type_valid')) like '%''transfer''%'
  and (select count(*) = 8 and count(distinct conname) = 8 from pg_constraint
       where conrelid = 'public.transactions'::regclass and conname in (
         'transactions_account_format', 'transactions_to_account_format', 'transactions_to_account_transfer_only',
         'transactions_transfer_accounts', 'transactions_plan_id_format', 'transactions_plan_complete',
         'transactions_plan_range', 'transactions_plan_expense_only'))
  and (select count(*) = 1 from pg_constraint where conname = 'transactions_goal_id_format')
  and (select count(*) = 1 from pg_constraint where conname = 'budget_settings_data_size'));
select t.ok('upgrade v2: RLS forced, 4+4 policies, 2 triggers, grants unchanged, both tables published',
  (select bool_and(relrowsecurity and relforcerowsecurity) from pg_class
   where oid in ('public.transactions'::regclass, 'public.budget_settings'::regclass))
  and (select count(*) = 8 from pg_policies where schemaname = 'public')
  and (select count(*) = 2 from pg_trigger where not tgisinternal
       and tgrelid in ('public.transactions'::regclass, 'public.budget_settings'::regclass))
  and not has_table_privilege('anon', 'public.transactions', 'select')
  and has_table_privilege('authenticated', 'public.transactions', 'select, insert, update, delete')
  and not has_table_privilege('authenticated', 'public.transactions', 'truncate')
  and (select count(*) = 2 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public'));

-- the v3 app pushes: old rows put on accounts, a transfer, a card bill payment, a split purchase (one bulk upsert,
-- PostgREST style: keys missing in a row arrive as NULL)
:as_a
select t.affects('upgrade v2: one v3 bulk upsert: v2 rows on accounts, a transfer, a 3-part split purchase, a tombstone',
  $$insert into public.transactions (user_id, id, type, amount, category, note, date, created_ms, goal_id, account, to_account, plan_id, plan_n, plan_of, example, deleted, client_updated_ms)
    select user_id, id, type, amount, category, note, date, created_ms, goal_id, account, to_account, plan_id, plan_n, plan_of, example, deleted, client_updated_ms
    from json_populate_recordset(null::public.transactions, '[
      {"user_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "id": "v2inc", "type": "income", "amount": 12000, "category": "salary", "note": "Зарплата",
       "date": "2026-09-01", "created_ms": 1756700000000, "account": "a_leumi", "client_updated_ms": 2000},
      {"user_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "id": "v2sav", "type": "saving", "amount": 700, "category": "savings",
       "date": "2026-09-04", "created_ms": 1757000000000, "goal_id": "g_car", "account": "a_leumi", "client_updated_ms": 2000},
      {"user_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "id": "t_cash", "type": "transfer", "amount": 400, "category": "transfer",
       "date": "2026-10-02", "account": "a_leumi", "to_account": "a_cash", "client_updated_ms": 2000},
      {"user_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "id": "t_bill", "type": "transfer", "amount": 1250.5, "category": "transfer",
       "date": "2026-10-10", "account": "a_leumi", "to_account": "a_isracard", "client_updated_ms": 2000},
      {"user_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "id": "s_1", "type": "expense", "amount": 333.33, "category": "tech",
       "date": "2026-10-05", "account": "a_isracard", "plan_id": "p_laptop", "plan_n": 1, "plan_of": 3, "client_updated_ms": 2000},
      {"user_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "id": "s_2", "type": "expense", "amount": 333.33, "category": "tech",
       "date": "2026-11-05", "account": "a_isracard", "plan_id": "p_laptop", "plan_n": 2, "plan_of": 3, "client_updated_ms": 2000},
      {"user_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "id": "s_3", "type": "expense", "amount": 333.34, "category": "tech",
       "date": "2026-12-05", "account": "a_isracard", "plan_id": "p_laptop", "plan_n": 3, "plan_of": 3, "client_updated_ms": 2000},
      {"user_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "id": "v2exp", "deleted": true, "client_updated_ms": 2000}]')
    on conflict (user_id, id) do update set type = excluded.type, amount = excluded.amount, category = excluded.category,
      note = excluded.note, date = excluded.date, created_ms = excluded.created_ms, goal_id = excluded.goal_id,
      account = excluded.account, to_account = excluded.to_account, plan_id = excluded.plan_id, plan_n = excluded.plan_n,
      plan_of = excluded.plan_of, example = excluded.example, deleted = excluded.deleted, client_updated_ms = excluded.client_updated_ms$$, 8);
select t.affects('upgrade v2: an older v2 write over a v3 row is ignored (last writer wins)',
  $$insert into public.transactions (user_id, id, type, amount, category, note, date, created_ms, goal_id, example, deleted, client_updated_ms)
    values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'v2inc', 'income', 1, 'salary', 'OLD', '2026-09-01', 1756700000000, null, false, false, 1500)
    on conflict (user_id, id) do update set type = excluded.type, amount = excluded.amount, category = excluded.category,
      note = excluded.note, date = excluded.date, created_ms = excluded.created_ms, goal_id = excluded.goal_id,
      example = excluded.example, deleted = excluded.deleted, client_updated_ms = excluded.client_updated_ms$$, 0);
select t.affects('upgrade v2: a newer v2-app write (no v3 columns) keeps the account of a v3 row',
  $$insert into public.transactions (user_id, id, type, amount, category, note, date, created_ms, goal_id, example, deleted, client_updated_ms)
    values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'v2sav', 'saving', 750, 'savings', 'v2 edit', '2026-09-04', 1757000000000, 'g_car', false, false, 3000)
    on conflict (user_id, id) do update set type = excluded.type, amount = excluded.amount, category = excluded.category,
      note = excluded.note, date = excluded.date, created_ms = excluded.created_ms, goal_id = excluded.goal_id,
      example = excluded.example, deleted = excluded.deleted, client_updated_ms = excluded.client_updated_ms$$, 1);
select t.violates('upgrade v2: a transfer without to_account is refused',
  $$insert into public.transactions (id, type, amount, date, account) values ('bad1', 'transfer', 1, '2026-10-10', 'a_leumi')$$,
  'transactions_transfer_accounts');
select t.violates('upgrade v2: an expense with to_account is refused',
  $$insert into public.transactions (id, type, amount, date, account, to_account) values ('bad2', 'expense', 1, '2026-10-10', 'a_leumi', 'a_cash')$$,
  'transactions_to_account_transfer_only');
select t.violates('upgrade v2: part 4 of 3 is refused',
  $$insert into public.transactions (id, type, amount, date, plan_id, plan_n, plan_of) values ('bad3', 'expense', 1, '2026-10-10', 'p_x', 4, 3)$$,
  'transactions_plan_range');
select t.violates('upgrade v2: a v2 row cannot get half a plan',
  $$update public.transactions set plan_id = 'p_x', client_updated_ms = 9000 where id = 'v2sav0'$$, 'transactions_plan_complete');
:as_b
select t.ok('upgrade v2: B sees only own row, none of A''s accounts or plans',
  (select count(*) = 1 and bool_and(id = 'v2b' and account is null) from public.transactions));
select t.affects('upgrade v2: B cannot redirect A''s card bill', $$update public.transactions set to_account = 'a_evil', client_updated_ms = 9000000000000 where id = 't_bill'$$, 0);
select t.affects('upgrade v2: B puts own v2 row on an account', $$update public.transactions set account = 'a_main', client_updated_ms = 2000 where id = 'v2b'$$, 1);
:as_admin
select t.ok('upgrade v2: A''s rows as the v3 app sent them',
  (select account = 'a_leumi' and note = 'Зарплата' and client_updated_ms = 2000 from public.transactions where id = 'v2inc')
  and (select account = 'a_leumi' and goal_id = 'g_car' and amount = 750 and note = 'v2 edit' from public.transactions where id = 'v2sav')
  and (select account is null and goal_id is null from public.transactions where id = 'v2sav0')
  and (select deleted and type is null from public.transactions where id = 'v2exp')
  and (select count(*) = 2 and bool_and(type = 'transfer' and account = 'a_leumi')
       from public.transactions where id in ('t_cash', 't_bill'))
  and (select count(*) = 3 and sum(amount) = 1000 and array_agg(plan_n order by plan_n) = array[1, 2, 3]::smallint[]
       from public.transactions where plan_id = 'p_laptop')
  and (select example from public.transactions where id = 'ex_1')
  and (select count(*) = 0 from public.transactions where id like 'bad%'));
select t.ok('upgrade v2: B''s row on its account, A''s card bill untouched',
  (select account = 'a_main' from public.transactions where user_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' and id = 'v2b')
  and (select to_account = 'a_isracard' from public.transactions where id = 't_bill'));

-- running schema.sql once more after v3 data exists changes nothing
select md5(string_agg(x::text, ',' order by x.user_id, x.id)) as v3_digest from public.transactions x \gset
\connect - postgres
\ir ../../supabase/schema.sql
\connect - supabase_admin
select t.ok('upgrade v2: a third run of schema.sql keeps every row byte for byte (v3 values, updated_at)',
  (select md5(string_agg(x::text, ',' order by x.user_id, x.id)) = :'v3_digest' from public.transactions x));

select format('summary (upgrade v2): %s checks, %s failed', count(*), count(*) filter (where not ok)) from t.results;
