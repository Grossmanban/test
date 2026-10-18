-- Tests for supabase/schema.sql. Run by tests/schema/run.sh as supabase_admin
-- (superuser) against the shim database, with psql -At. Each check prints
-- "ok N - ..." or "not ok N - ...". An unexpected SQL error stops the script.
--
-- Users: A = aaaaaaaa-…, B = bbbbbbbb-… (both in auth.users),
--        C = cccccccc-… (valid JWT, but no auth.users row).

\set ON_ERROR_STOP 1

-- Session switches. PostgREST does the same: SET ROLE + request.jwt.claims.
\set as_admin 'reset role; reset request.jwt.claims;'
\set as_anon 'reset role; set request.jwt.claims = ''{"role":"anon"}''; set role anon;'
\set as_a 'reset role; set request.jwt.claims = ''{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated"}''; set role authenticated;'
\set as_b 'reset role; set request.jwt.claims = ''{"sub":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","role":"authenticated"}''; set role authenticated;'
\set as_c 'reset role; set request.jwt.claims = ''{"sub":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","role":"authenticated"}''; set role authenticated;'
\set as_nouid 'reset role; set request.jwt.claims = ''{"role":"authenticated"}''; set role authenticated;'
\set as_service 'reset role; set request.jwt.claims = ''{"role":"service_role"}''; set role service_role;'
\set A '''aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'''
-- the largest settings document of the app and its size, from tests/helpers/max-settings.mjs (run.sh)
\set maxdoc `cat "$MAXDOC_FILE"`
\set maxdoc_bytes `cat "$MAXDOC_BYTES_FILE"`
\set B '''bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'''

-- Test helpers t.ok / t.fails / t.affects (helpers.sql)
:as_admin
\ir helpers.sql

-- ---------------------------------------------------------------------
-- 1. Structure (as superuser)
-- ---------------------------------------------------------------------
select t.ok('transactions: RLS enabled and forced',
  (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.transactions'::regclass));
select t.ok('budget_settings: RLS enabled and forced',
  (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.budget_settings'::regclass));
select t.ok('tables are owned by the non-superuser role postgres',
  (select bool_and(pg_get_userbyid(relowner) = 'postgres') from pg_class
   where oid in ('public.transactions'::regclass, 'public.budget_settings'::regclass)));
select t.ok('4 policies per table, one per command, all TO authenticated',
  (select count(*) = 8 and count(distinct (tablename, cmd)) = 8 and bool_and(roles = '{authenticated}')
   from pg_policies where schemaname = 'public' and tablename in ('transactions', 'budget_settings')));
select t.ok('policies use (select auth.uid()) (initplan, evaluated once)',
  (select bool_and(coalesce(qual, '') || coalesce(with_check, '') ilike '%SELECT auth.uid()%'
                   and coalesce(qual, '') || coalesce(with_check, '') not ilike '%= auth.uid()%')
   from pg_policies where schemaname = 'public' and tablename in ('transactions', 'budget_settings')));
select t.ok('anon has no privilege at all on either table',
  not has_table_privilege('anon', 'public.transactions', 'select, insert, update, delete, truncate, references, trigger')
  and not has_table_privilege('anon', 'public.budget_settings', 'select, insert, update, delete, truncate, references, trigger'));
select t.ok('PUBLIC has no grants on either table',
  not exists (select 1 from pg_class c, aclexplode(c.relacl) a
              where c.oid in ('public.transactions'::regclass, 'public.budget_settings'::regclass) and a.grantee = 0));
select t.ok('authenticated has exactly select/insert/update/delete (no truncate/references/trigger)',
  (select bool_and(has_table_privilege('authenticated', tbl, 'select')
               and has_table_privilege('authenticated', tbl, 'insert')
               and has_table_privilege('authenticated', tbl, 'update')
               and has_table_privilege('authenticated', tbl, 'delete')
               and not has_table_privilege('authenticated', tbl, 'truncate, references, trigger'))
   from unnest(array['public.transactions', 'public.budget_settings']) tbl));
select t.ok('trigger functions not executable by API roles, search_path pinned',
  (select bool_and(not has_function_privilege('anon', p.oid, 'execute')
               and not has_function_privilege('authenticated', p.oid, 'execute')
               and p.proconfig = array['search_path=""'])
   from pg_proc p where p.proname in ('budget_tx_before_write', 'budget_settings_before_write')));
select t.ok('index transactions (user_id, updated_at) exists',
  exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'transactions'
          and indexdef like '%(user_id, updated_at)'));
select t.ok('replica identity DEFAULT on both tables',
  (select bool_and(relreplident = 'd') from pg_class
   where oid in ('public.transactions'::regclass, 'public.budget_settings'::regclass)));
select t.ok('both tables are in publication supabase_realtime',
  (select count(*) = 2 from pg_publication_tables where pubname = 'supabase_realtime'
   and schemaname = 'public' and tablename in ('transactions', 'budget_settings')));
select t.ok('primary keys are (user_id, id) and (user_id)',
  pg_get_constraintdef((select oid from pg_constraint where conname = 'transactions_pkey')) = 'PRIMARY KEY (user_id, id)'
  and pg_get_constraintdef((select oid from pg_constraint where conname = 'budget_settings_pkey')) = 'PRIMARY KEY (user_id)');
select t.ok('transactions.goal_id: nullable text without a default (v2)',
  (select data_type = 'text' and is_nullable = 'YES' and column_default is null from information_schema.columns
   where table_schema = 'public' and table_name = 'transactions' and column_name = 'goal_id'));
select t.ok('checks: goal_id format [A-Za-z0-9_-]{1,32}, settings document up to 64 KB',
  pg_get_constraintdef((select oid from pg_constraint where conname = 'transactions_goal_id_format')) like '%goal_id ~ %^[A-Za-z0-9_-]{1,32}$%'
  and pg_get_constraintdef((select oid from pg_constraint where conname = 'budget_settings_data_size')) like '%<= 65536%');
select t.ok('transactions v3 columns: account, to_account, plan_id text; plan_n, plan_of smallint; nullable, no default',
  (select count(*) = 5 and bool_and(is_nullable = 'YES' and column_default is null
          and data_type = case when column_name in ('plan_n', 'plan_of') then 'smallint' else 'text' end)
   from information_schema.columns
   where table_schema = 'public' and table_name = 'transactions'
     and column_name in ('account', 'to_account', 'plan_id', 'plan_n', 'plan_of')));
select t.ok('v3 columns are documented (column comments)',
  (select bool_and(col_description('public.transactions'::regclass, attnum) is not null) from pg_attribute
   where attrelid = 'public.transactions'::regclass and attname in ('account', 'to_account', 'plan_id', 'plan_n', 'plan_of')));
select t.ok('checks: type allows transfer; the 8 v3 checks exist once each',
  pg_get_constraintdef((select oid from pg_constraint where conname = 'transactions_type_valid')) like '%''transfer''%'
  and (select count(*) = 8 and count(distinct conname) = 8 from pg_constraint
       where conrelid = 'public.transactions'::regclass and contype = 'c' and conname in (
         'transactions_account_format', 'transactions_to_account_format', 'transactions_to_account_transfer_only',
         'transactions_transfer_accounts', 'transactions_plan_id_format', 'transactions_plan_complete',
         'transactions_plan_range', 'transactions_plan_expense_only')));
select t.ok('checks: account, to_account and plan_id use the id pattern ^[A-Za-z0-9_-]{1,32}$',
  (select count(*) = 3 and bool_and(pg_get_constraintdef(oid) like '%^[A-Za-z0-9\_-]{1,32}$%') from pg_constraint
   where conname in ('transactions_account_format', 'transactions_to_account_format', 'transactions_plan_id_format')));
select t.ok('schema applied twice: exactly one trigger per table',
  (select count(*) = 2 from pg_trigger where not tgisinternal
   and tgrelid in ('public.transactions'::regclass, 'public.budget_settings'::regclass)));

-- ---------------------------------------------------------------------
-- 2. anon: no access at all
-- ---------------------------------------------------------------------
:as_anon
select t.ok('anon: auth.role() = anon', auth.role() = 'anon');
select t.fails('anon: select transactions denied', 'select * from public.transactions', '42501');
select t.fails('anon: insert transaction denied',
  $$insert into public.transactions (user_id, id, type, amount, date) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'x', 'expense', 1, '2026-10-01')$$, '42501');
select t.fails('anon: update transactions denied', 'update public.transactions set note = ''x''', '42501');
select t.fails('anon: delete transactions denied', 'delete from public.transactions', '42501');
select t.fails('anon: select settings denied', 'select * from public.budget_settings', '42501');
select t.fails('anon: insert settings denied',
  $$insert into public.budget_settings (user_id, data) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '{}')$$, '42501');

-- ---------------------------------------------------------------------
-- 3. User A writes
-- ---------------------------------------------------------------------
:as_a
select t.ok('A: auth.uid() comes from request.jwt.claims', auth.uid() = :A);
select t.affects('A: insert without user_id (default auth.uid())',
  $$insert into public.transactions (id, type, amount, category, note, date, created_ms, client_updated_ms)
    values ('tx1', 'expense', 100.50, 'groceries', 'Пятёрочка', '2026-10-01', 1759300000000, 1000)$$, 1);
select t.affects('A: insert with explicit own user_id (what the client sends)',
  $$insert into public.transactions (user_id, id, type, amount, category, note, date, created_ms, client_updated_ms)
    values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'tx2', 'income', 50000, 'salary', '', '2026-10-05', 1759600000000, 1000)$$, 1);
select t.ok('A: default user_id = auth.uid()', (select user_id from public.transactions where id = 'tx1') = :A);
select t.affects('A: client-supplied updated_at is ignored',
  $$insert into public.transactions (id, type, amount, date, client_updated_ms, updated_at)
    values ('tx3', 'saving', 10, '2026-10-06', 1000, '2000-01-01')$$, 1);
select t.ok('A: updated_at stamped by server on insert',
  (select updated_at > now() - interval '1 minute' and updated_at <= clock_timestamp()
   from public.transactions where id = 'tx3'));
select t.ok('A: sees exactly own 3 rows', (select count(*) from public.transactions) = 3);
select t.affects('A: a saving with goal_id, as the client sends it',
  $$insert into public.transactions (user_id, id, type, amount, category, note, date, created_ms, goal_id, example, deleted, client_updated_ms)
    values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'sav1', 'saving', 500, 'savings', '', '2026-10-06', 1759700000000, 'g_car', false, false, 1000)$$, 1);
select t.ok('A: goal_id round trip', (select goal_id = 'g_car' and type = 'saving' from public.transactions where id = 'sav1'));
select t.ok('A: rows written without goal_id have NULL (= the first goal)', (select bool_and(goal_id is null) from public.transactions where id in ('tx1', 'tx2', 'tx3')));
select t.affects('A: a transfer between two accounts, as the client sends it (all columns)',
  $$insert into public.transactions (user_id, id, type, amount, category, note, date, created_ms, goal_id, account, to_account, plan_id, plan_n, plan_of, example, deleted, client_updated_ms)
    values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'tr1', 'transfer', 2000, 'transfer', 'На наличные', '2026-10-06', 1759710000000, null, 'a_leumi', 'a_cash', null, null, null, false, false, 1000)$$, 1);
select t.affects('A: a split purchase on a card, 3 parts in one PostgREST-style bulk upsert',
  $$insert into public.transactions (user_id, id, type, amount, category, note, date, created_ms, goal_id, account, to_account, plan_id, plan_n, plan_of, example, deleted, client_updated_ms)
    select user_id, id, type, amount, category, note, date, created_ms, goal_id, account, to_account, plan_id, plan_n, plan_of, example, deleted, client_updated_ms
    from json_populate_recordset(null::public.transactions, '[
      {"user_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "id": "sp1", "type": "expense", "amount": 1000, "category": "home", "date": "2026-10-06", "account": "a_max", "plan_id": "p_tv", "plan_n": 1, "plan_of": 3, "client_updated_ms": 1000},
      {"user_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "id": "sp2", "type": "expense", "amount": 1000, "category": "home", "date": "2026-11-06", "account": "a_max", "plan_id": "p_tv", "plan_n": 2, "plan_of": 3, "client_updated_ms": 1000},
      {"user_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "id": "sp3", "type": "expense", "amount": 1000.01, "category": "home", "date": "2026-12-06", "account": "a_max", "plan_id": "p_tv", "plan_n": 3, "plan_of": 3, "client_updated_ms": 1000}]')
    on conflict (user_id, id) do update set type = excluded.type, amount = excluded.amount, category = excluded.category,
      note = excluded.note, date = excluded.date, created_ms = excluded.created_ms, goal_id = excluded.goal_id,
      account = excluded.account, to_account = excluded.to_account, plan_id = excluded.plan_id, plan_n = excluded.plan_n,
      plan_of = excluded.plan_of, example = excluded.example, deleted = excluded.deleted, client_updated_ms = excluded.client_updated_ms$$, 3);
select t.ok('A: transfer round trip (type, account, to_account; no plan)',
  (select type = 'transfer' and account = 'a_leumi' and to_account = 'a_cash' and plan_id is null and plan_n is null and plan_of is null
   from public.transactions where id = 'tr1'));
select t.ok('A: split parts round trip (plan_id shared, plan_n 1..3 of 3, smallint)',
  (select count(*) = 3 and bool_and(plan_id = 'p_tv' and plan_of = 3 and account = 'a_max' and to_account is null)
          and array_agg(plan_n order by date) = array[1, 2, 3]::smallint[] and pg_typeof(min(plan_n))::text = 'smallint'
   from public.transactions where id in ('sp1', 'sp2', 'sp3')));
select t.ok('A: rows written without the v3 columns have NULL in all five',
  (select bool_and(account is null and to_account is null and plan_id is null and plan_n is null and plan_of is null)
   from public.transactions where id in ('tx1', 'tx2', 'tx3', 'sav1')));
select t.affects('A: insert own settings',
  $$insert into public.budget_settings (data, client_updated_ms) values ('{"startBalance": 1000, "goal": null, "limits": {}}', 1000)$$, 1);

-- ---------------------------------------------------------------------
-- 4. User B is isolated from A
-- ---------------------------------------------------------------------
:as_b
select t.ok('B: sees none of A''s transactions', (select count(*) from public.transactions) = 0);
select t.ok('B: sees none of A''s settings', (select count(*) from public.budget_settings) = 0);
select t.affects('B: update of A''s row affects nothing',
  $$update public.transactions set note = 'hacked', client_updated_ms = 9000000000000 where id = 'tx1'$$, 0);
select t.affects('B: delete of A''s row affects nothing', $$delete from public.transactions where id = 'tx1'$$, 0);
select t.ok('B: A''s saving and its goal_id are invisible', (select count(*) from public.transactions where id = 'sav1' or goal_id is not null) = 0);
select t.affects('B: moving A''s saving to another goal affects nothing',
  $$update public.transactions set goal_id = 'g_evil', client_updated_ms = 9000000000000 where id = 'sav1'$$, 0);
select t.fails('B: cannot upsert over A''s saving with a goal_id',
  $$insert into public.transactions (user_id, id, type, amount, date, goal_id, client_updated_ms)
    values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'sav1', 'saving', 1, '2026-10-01', 'g_evil', 9000000000000)
    on conflict (user_id, id) do update set goal_id = excluded.goal_id, client_updated_ms = excluded.client_updated_ms$$, '42501');
select t.fails('B: cannot insert a row for A',
  $$insert into public.transactions (user_id, id, type, amount, date, client_updated_ms)
    values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'evil', 'expense', 1, '2026-10-01', 1)$$, '42501');
select t.fails('B: cannot upsert over A''s row',
  $$insert into public.transactions (user_id, id, type, amount, date, note, client_updated_ms)
    values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'tx1', 'expense', 1, '2026-10-01', 'hacked', 9000000000000)
    on conflict (user_id, id) do update set note = excluded.note, client_updated_ms = excluded.client_updated_ms$$, '42501');
select t.affects('B: same id "tx1" is a separate row in B''s namespace',
  $$insert into public.transactions (user_id, id, type, amount, date, client_updated_ms)
    values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'tx1', 'expense', 7, '2026-10-02', 1)$$, 1);
select t.ok('B: sees only own tx1', (select count(*) = 1 and bool_and(user_id = :B) from public.transactions));
select t.affects('B: own saving with goal_id', $$insert into public.transactions (id, type, amount, date, goal_id, client_updated_ms)
    values ('bsav1', 'saving', 70, '2026-10-02', 'g_house', 1)$$, 1);
select t.fails('B: cannot move own row to A (user_id immutable)',
  $$update public.transactions set user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' where id = 'tx1'$$, '23514');
select t.fails('B: cannot insert settings for A',
  $$insert into public.budget_settings (user_id, data, client_updated_ms) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '{}', 1)$$, '42501');
select t.fails('B: cannot upsert over A''s settings',
  $$insert into public.budget_settings (user_id, data, client_updated_ms) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '{"x":1}', 9000000000000)
    on conflict (user_id) do update set data = excluded.data, client_updated_ms = excluded.client_updated_ms$$, '42501');
select t.affects('B: update of A''s settings affects nothing', $$update public.budget_settings set data = '{"x":1}'$$, 0);
select t.affects('B: delete of A''s settings affects nothing', $$delete from public.budget_settings$$, 0);
select t.affects('B: insert own settings', $$insert into public.budget_settings (user_id, data, client_updated_ms) values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '{"startBalance": 5}', 1)$$, 1);
select t.affects('B: update touches only own settings row', $$update public.budget_settings set data = '{"startBalance": 6}'$$, 1);
select t.ok('B: A''s transfer and split parts are invisible',
  (select count(*) from public.transactions where id in ('tr1', 'sp1', 'sp2', 'sp3') or account is not null or plan_id is not null) = 0);
select t.affects('B: redirecting A''s transfer affects nothing',
  $$update public.transactions set to_account = 'a_evil', client_updated_ms = 9000000000000 where id = 'tr1'$$, 0);
select t.affects('B: deleting A''s split parts affects nothing', $$delete from public.transactions where plan_id = 'p_tv'$$, 0);
select t.fails('B: cannot upsert over A''s transfer',
  $$insert into public.transactions (user_id, id, type, amount, date, account, to_account, client_updated_ms)
    values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'tr1', 'transfer', 1, '2026-10-01', 'a_leumi', 'a_evil', 9000000000000)
    on conflict (user_id, id) do update set to_account = excluded.to_account, client_updated_ms = excluded.client_updated_ms$$, '42501');
select t.affects('B: own transfer and own split part with the same ids as A''s',
  $$insert into public.transactions (id, type, amount, date, account, to_account, plan_id, plan_n, plan_of, client_updated_ms)
    values ('tr1', 'transfer', 5, '2026-10-02', 'a_main', 'a_wallet', null, null, null, 1),
           ('sp1', 'expense', 5, '2026-10-02', 'a_card', null, 'p_tv', 1, 2, 1)$$, 2);

:as_admin
select t.ok('A''s tx1 untouched by B', (select note = 'Пятёрочка' and client_updated_ms = 1000 from public.transactions where user_id = :A and id = 'tx1'));
select t.ok('A''s settings untouched by B', (select data ->> 'startBalance' = '1000' from public.budget_settings where user_id = :A));
select t.ok('two rows with id tx1, one per user', (select count(*) = 2 from public.transactions where id = 'tx1'));
select t.ok('A''s goal_id untouched by B, B''s own goal_id stored',
  (select goal_id = 'g_car' and client_updated_ms = 1000 from public.transactions where user_id = :A and id = 'sav1')
  and (select goal_id = 'g_house' from public.transactions where user_id = :B and id = 'bsav1'));
select t.ok('A''s transfer and split parts untouched by B, B''s own stored separately',
  (select to_account = 'a_cash' and client_updated_ms = 1000 from public.transactions where user_id = :A and id = 'tr1')
  and (select count(*) = 3 and bool_and(plan_of = 3) from public.transactions where user_id = :A and plan_id = 'p_tv')
  and (select to_account = 'a_wallet' from public.transactions where user_id = :B and id = 'tr1')
  and (select plan_of = 2 from public.transactions where user_id = :B and id = 'sp1'));

-- ---------------------------------------------------------------------
-- 5. Last writer wins on transactions (as A)
-- ---------------------------------------------------------------------
:as_a
select updated_at as u0 from public.transactions where id = 'tx1' \gset
select t.affects('LWW: older upsert (999 < 1000) is ignored',
  $$insert into public.transactions (user_id, id, type, amount, category, note, date, created_ms, example, deleted, client_updated_ms)
    values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'tx1', 'expense', 1, 'groceries', 'OLDER', '2026-10-01', 1759300000000, false, false, 999)
    on conflict (user_id, id) do update set type = excluded.type, amount = excluded.amount, category = excluded.category,
      note = excluded.note, date = excluded.date, created_ms = excluded.created_ms, example = excluded.example,
      deleted = excluded.deleted, client_updated_ms = excluded.client_updated_ms$$, 0);
select t.ok('LWW: row and updated_at unchanged after older write',
  (select note = 'Пятёрочка' and amount = 100.50 and client_updated_ms = 1000 and updated_at = :'u0'
   from public.transactions where id = 'tx1'));
select t.affects('LWW: equal client_updated_ms (re-push) is applied',
  $$insert into public.transactions (user_id, id, type, amount, category, note, date, created_ms, example, deleted, client_updated_ms)
    values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'tx1', 'expense', 100.50, 'groceries', 'EQUAL', '2026-10-01', 1759300000000, false, false, 1000)
    on conflict (user_id, id) do update set type = excluded.type, amount = excluded.amount, category = excluded.category,
      note = excluded.note, date = excluded.date, created_ms = excluded.created_ms, example = excluded.example,
      deleted = excluded.deleted, client_updated_ms = excluded.client_updated_ms$$, 1);
select t.ok('LWW: equal write stored and updated_at advanced',
  (select note = 'EQUAL' and updated_at > :'u0' from public.transactions where id = 'tx1'));
select updated_at as u1 from public.transactions where id = 'tx1' \gset
select t.affects('LWW: newer upsert (2000) is applied',
  $$insert into public.transactions (user_id, id, type, amount, category, note, date, created_ms, example, deleted, client_updated_ms)
    values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'tx1', 'expense', 200, 'cafe', 'NEWER', '2026-10-02', 1759300000000, false, false, 2000)
    on conflict (user_id, id) do update set type = excluded.type, amount = excluded.amount, category = excluded.category,
      note = excluded.note, date = excluded.date, created_ms = excluded.created_ms, example = excluded.example,
      deleted = excluded.deleted, client_updated_ms = excluded.client_updated_ms$$, 1);
select t.ok('LWW: newer write stored, updated_at advanced',
  (select note = 'NEWER' and amount = 200 and category = 'cafe' and date = '2026-10-02' and client_updated_ms = 2000
          and updated_at > :'u1' from public.transactions where id = 'tx1'));
select t.affects('LWW: plain UPDATE with older client_updated_ms is ignored',
  $$update public.transactions set note = 'OLD-UPDATE', client_updated_ms = 1500 where id = 'tx1'$$, 0);
select updated_at as u2 from public.transactions where id = 'tx1' \gset
select t.affects('UPDATE that sets updated_at itself', $$update public.transactions set updated_at = '2000-01-01' where id = 'tx1'$$, 1);
select t.ok('server re-stamps updated_at on update (client value ignored)',
  (select updated_at > :'u2' and note = 'NEWER' from public.transactions where id = 'tx1'));
select t.affects('LWW: one statement, mixed batch: tx1 older (skipped), tx2 newer, tx4 new',
  $$insert into public.transactions (user_id, id, type, amount, category, note, date, created_ms, example, deleted, client_updated_ms)
    values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'tx1', 'expense', 1, 'cafe', 'BATCH-OLD', '2026-10-02', 1, false, false, 1999),
           ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'tx2', 'income', 60000, 'salary', 'BATCH-NEW', '2026-10-05', 1, false, false, 3000),
           ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'tx4', 'expense', 3, 'other', 'BATCH-INS', '2026-10-07', 1, true, false, 3000)
    on conflict (user_id, id) do update set type = excluded.type, amount = excluded.amount, category = excluded.category,
      note = excluded.note, date = excluded.date, created_ms = excluded.created_ms, example = excluded.example,
      deleted = excluded.deleted, client_updated_ms = excluded.client_updated_ms$$, 2);
select t.ok('LWW: batch result per row',
  (select bool_and(case id when 'tx1' then note = 'NEWER' when 'tx2' then note = 'BATCH-NEW' and amount = 60000
                           when 'tx4' then note = 'BATCH-INS' and example end)
          and count(*) = 3 from public.transactions where id in ('tx1', 'tx2', 'tx4')));

select t.affects('LWW goal_id: a newer write moves the saving to another goal',
  $$insert into public.transactions (user_id, id, type, amount, category, note, date, created_ms, goal_id, example, deleted, client_updated_ms)
    values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'sav1', 'saving', 500, 'savings', '', '2026-10-06', 1759700000000, 'g_trip', false, false, 2000)
    on conflict (user_id, id) do update set type = excluded.type, amount = excluded.amount, category = excluded.category,
      note = excluded.note, date = excluded.date, created_ms = excluded.created_ms, goal_id = excluded.goal_id, example = excluded.example,
      deleted = excluded.deleted, client_updated_ms = excluded.client_updated_ms$$, 1);
select t.affects('LWW goal_id: an older write is ignored',
  $$insert into public.transactions (user_id, id, type, amount, category, note, date, created_ms, goal_id, example, deleted, client_updated_ms)
    values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'sav1', 'saving', 500, 'savings', '', '2026-10-06', 1759700000000, 'g_old', false, false, 1500)
    on conflict (user_id, id) do update set type = excluded.type, amount = excluded.amount, category = excluded.category,
      note = excluded.note, date = excluded.date, created_ms = excluded.created_ms, goal_id = excluded.goal_id, example = excluded.example,
      deleted = excluded.deleted, client_updated_ms = excluded.client_updated_ms$$, 0);
select t.ok('LWW goal_id: newer value kept', (select goal_id = 'g_trip' and client_updated_ms = 2000 from public.transactions where id = 'sav1'));
select t.affects('LWW goal_id: a newer write with NULL clears it (back to the first goal)',
  $$insert into public.transactions (user_id, id, type, amount, category, note, date, created_ms, goal_id, example, deleted, client_updated_ms)
    values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'sav1', 'saving', 500, 'savings', '', '2026-10-06', 1759700000000, null, false, false, 3000)
    on conflict (user_id, id) do update set type = excluded.type, amount = excluded.amount, category = excluded.category,
      note = excluded.note, date = excluded.date, created_ms = excluded.created_ms, goal_id = excluded.goal_id, example = excluded.example,
      deleted = excluded.deleted, client_updated_ms = excluded.client_updated_ms$$, 1);
select t.ok('LWW goal_id: cleared', (select goal_id is null from public.transactions where id = 'sav1'));
select t.affects('PostgREST-style bulk upsert with goal_id: a row without the key gets NULL',
  $$insert into public.transactions (user_id, id, type, amount, category, note, date, created_ms, goal_id, example, deleted, client_updated_ms)
    select user_id, id, type, amount, category, note, date, created_ms, goal_id, example, deleted, client_updated_ms
    from json_populate_recordset(null::public.transactions, '[
      {"user_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "id": "sav2", "type": "saving", "amount": 10, "date": "2026-10-07", "goal_id": "g_trip", "client_updated_ms": 5000},
      {"user_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "id": "sav3", "type": "saving", "amount": 20, "date": "2026-10-07", "client_updated_ms": 5000}]')
    on conflict (user_id, id) do update set type = excluded.type, amount = excluded.amount, category = excluded.category,
      note = excluded.note, date = excluded.date, created_ms = excluded.created_ms, goal_id = excluded.goal_id, example = excluded.example,
      deleted = excluded.deleted, client_updated_ms = excluded.client_updated_ms$$, 2);
select t.ok('bulk upsert: goal_id per row', (select bool_and(case id when 'sav2' then goal_id = 'g_trip' else goal_id is null end) from public.transactions where id in ('sav2', 'sav3')));

select t.affects('LWW v3: a newer write reverses the transfer',
  $$insert into public.transactions (user_id, id, type, amount, category, note, date, created_ms, goal_id, account, to_account, plan_id, plan_n, plan_of, example, deleted, client_updated_ms)
    values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'tr1', 'transfer', 2000, 'transfer', '', '2026-10-06', 1759710000000, null, 'a_cash', 'a_leumi', null, null, null, false, false, 2000)
    on conflict (user_id, id) do update set type = excluded.type, amount = excluded.amount, category = excluded.category,
      note = excluded.note, date = excluded.date, created_ms = excluded.created_ms, goal_id = excluded.goal_id,
      account = excluded.account, to_account = excluded.to_account, plan_id = excluded.plan_id, plan_n = excluded.plan_n,
      plan_of = excluded.plan_of, example = excluded.example, deleted = excluded.deleted, client_updated_ms = excluded.client_updated_ms$$, 1);
select t.affects('LWW v3: an older write with other accounts is ignored',
  $$insert into public.transactions (user_id, id, type, amount, category, note, date, created_ms, goal_id, account, to_account, plan_id, plan_n, plan_of, example, deleted, client_updated_ms)
    values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'tr1', 'transfer', 2000, 'transfer', '', '2026-10-06', 1759710000000, null, 'a_old', 'a_older', null, null, null, false, false, 1500)
    on conflict (user_id, id) do update set type = excluded.type, amount = excluded.amount, category = excluded.category,
      note = excluded.note, date = excluded.date, created_ms = excluded.created_ms, goal_id = excluded.goal_id,
      account = excluded.account, to_account = excluded.to_account, plan_id = excluded.plan_id, plan_n = excluded.plan_n,
      plan_of = excluded.plan_of, example = excluded.example, deleted = excluded.deleted, client_updated_ms = excluded.client_updated_ms$$, 0);
select t.affects('LWW v3: a plain UPDATE with an older client_updated_ms is ignored too',
  $$update public.transactions set account = 'a_old', to_account = 'a_older', client_updated_ms = 1999 where id = 'tr1'$$, 0);
select t.ok('LWW v3: the newer accounts are kept', (select account = 'a_cash' and to_account = 'a_leumi' and client_updated_ms = 2000 from public.transactions where id = 'tr1'));
select t.affects('LWW v3: a newer write turns the transfer into a split part on a card (to_account cleared)',
  $$insert into public.transactions (user_id, id, type, amount, category, note, date, created_ms, goal_id, account, to_account, plan_id, plan_n, plan_of, example, deleted, client_updated_ms)
    values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'tr1', 'expense', 600, 'tech', '', '2026-10-06', 1759710000000, null, 'a_max', null, 'p_phone', 1, 2, false, false, 3000)
    on conflict (user_id, id) do update set type = excluded.type, amount = excluded.amount, category = excluded.category,
      note = excluded.note, date = excluded.date, created_ms = excluded.created_ms, goal_id = excluded.goal_id,
      account = excluded.account, to_account = excluded.to_account, plan_id = excluded.plan_id, plan_n = excluded.plan_n,
      plan_of = excluded.plan_of, example = excluded.example, deleted = excluded.deleted, client_updated_ms = excluded.client_updated_ms$$, 1);
select t.affects('LWW v3: an older write cannot bring the transfer back',
  $$insert into public.transactions (user_id, id, type, amount, category, note, date, created_ms, goal_id, account, to_account, plan_id, plan_n, plan_of, example, deleted, client_updated_ms)
    values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'tr1', 'transfer', 2000, 'transfer', '', '2026-10-06', 1759710000000, null, 'a_cash', 'a_leumi', null, null, null, false, false, 2500)
    on conflict (user_id, id) do update set type = excluded.type, amount = excluded.amount, category = excluded.category,
      note = excluded.note, date = excluded.date, created_ms = excluded.created_ms, goal_id = excluded.goal_id,
      account = excluded.account, to_account = excluded.to_account, plan_id = excluded.plan_id, plan_n = excluded.plan_n,
      plan_of = excluded.plan_of, example = excluded.example, deleted = excluded.deleted, client_updated_ms = excluded.client_updated_ms$$, 0);
select t.ok('LWW v3: split part stored',
  (select type = 'expense' and account = 'a_max' and to_account is null and plan_id = 'p_phone' and plan_n = 1 and plan_of = 2
   from public.transactions where id = 'tr1'));
select t.affects('LWW v3: a newer write with NULLs clears the account and the plan',
  $$insert into public.transactions (user_id, id, type, amount, category, note, date, created_ms, goal_id, account, to_account, plan_id, plan_n, plan_of, example, deleted, client_updated_ms)
    values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'tr1', 'expense', 600, 'tech', '', '2026-10-06', 1759710000000, null, null, null, null, null, null, false, false, 4000)
    on conflict (user_id, id) do update set type = excluded.type, amount = excluded.amount, category = excluded.category,
      note = excluded.note, date = excluded.date, created_ms = excluded.created_ms, goal_id = excluded.goal_id,
      account = excluded.account, to_account = excluded.to_account, plan_id = excluded.plan_id, plan_n = excluded.plan_n,
      plan_of = excluded.plan_of, example = excluded.example, deleted = excluded.deleted, client_updated_ms = excluded.client_updated_ms$$, 1);
select t.ok('LWW v3: cleared', (select account is null and to_account is null and plan_id is null and plan_n is null and plan_of is null
   from public.transactions where id = 'tr1'));
select t.affects('bulk upsert v3: minimal tombstone of a split part + a new transfer + a v2-shaped row without v3 keys',
  $$insert into public.transactions (user_id, id, type, amount, category, note, date, created_ms, goal_id, account, to_account, plan_id, plan_n, plan_of, example, deleted, client_updated_ms)
    select user_id, id, type, amount, category, note, date, created_ms, goal_id, account, to_account, plan_id, plan_n, plan_of, example, deleted, client_updated_ms
    from json_populate_recordset(null::public.transactions, '[
      {"user_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "id": "sp3", "deleted": true, "client_updated_ms": 5000},
      {"user_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "id": "tr2", "type": "transfer", "amount": 3500, "category": "transfer",
       "date": "2026-10-10", "account": "a_leumi", "to_account": "a_max", "client_updated_ms": 5000},
      {"user_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "id": "tx6", "type": "expense", "amount": 12, "date": "2026-10-10", "client_updated_ms": 5000}]')
    on conflict (user_id, id) do update set type = excluded.type, amount = excluded.amount, category = excluded.category,
      note = excluded.note, date = excluded.date, created_ms = excluded.created_ms, goal_id = excluded.goal_id,
      account = excluded.account, to_account = excluded.to_account, plan_id = excluded.plan_id, plan_n = excluded.plan_n,
      plan_of = excluded.plan_of, example = excluded.example, deleted = excluded.deleted, client_updated_ms = excluded.client_updated_ms$$, 3);
select t.ok('bulk upsert v3: tombstone has no plan left, transfer and plain row stored',
  (select deleted and plan_id is null and plan_n is null and plan_of is null and account is null from public.transactions where id = 'sp3')
  and (select type = 'transfer' and account = 'a_leumi' and to_account = 'a_max' from public.transactions where id = 'tr2')
  and (select account is null and to_account is null and plan_id is null from public.transactions where id = 'tx6'));
select t.affects('undo delete v3: the split part comes back with its plan',
  $$insert into public.transactions (user_id, id, type, amount, category, note, date, created_ms, goal_id, account, to_account, plan_id, plan_n, plan_of, example, deleted, client_updated_ms)
    values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'sp3', 'expense', 1000.01, 'home', '', '2026-12-06', 1759710000000, null, 'a_max', null, 'p_tv', 3, 3, false, false, 6000)
    on conflict (user_id, id) do update set type = excluded.type, amount = excluded.amount, category = excluded.category,
      note = excluded.note, date = excluded.date, created_ms = excluded.created_ms, goal_id = excluded.goal_id,
      account = excluded.account, to_account = excluded.to_account, plan_id = excluded.plan_id, plan_n = excluded.plan_n,
      plan_of = excluded.plan_of, example = excluded.example, deleted = excluded.deleted, client_updated_ms = excluded.client_updated_ms$$, 1);
select t.affects('a v2 client''s upsert (no v3 columns in the payload) keeps the account and plan of a v3 row',
  $$insert into public.transactions (user_id, id, type, amount, category, note, date, created_ms, goal_id, example, deleted, client_updated_ms)
    values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'sp2', 'expense', 1000, 'home', 'v2 edit', '2026-11-06', 1759710000000, null, false, false, 6000)
    on conflict (user_id, id) do update set type = excluded.type, amount = excluded.amount, category = excluded.category,
      note = excluded.note, date = excluded.date, created_ms = excluded.created_ms, goal_id = excluded.goal_id,
      example = excluded.example, deleted = excluded.deleted, client_updated_ms = excluded.client_updated_ms$$, 1);
select t.ok('v2 edit stored, plan kept',
  (select note = 'v2 edit' and account = 'a_max' and plan_id = 'p_tv' and plan_n = 2 and plan_of = 3 from public.transactions where id = 'sp2')
  and (select not deleted and plan_n = 3 from public.transactions where id = 'sp3'));

-- PostgREST builds bulk upserts with json_populate_recordset; supabase-js sends
-- NULL for keys missing in some objects. Minimal tombstone + full row together:
select t.affects('PostgREST-style bulk upsert: minimal tombstone + full new row',
  $$insert into public.transactions (user_id, id, type, amount, category, note, date, created_ms, example, deleted, client_updated_ms)
    select user_id, id, type, amount, category, note, date, created_ms, example, deleted, client_updated_ms
    from json_populate_recordset(null::public.transactions, '[
      {"user_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "id": "tx2", "deleted": true, "client_updated_ms": 5000},
      {"user_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "id": "tx5", "type": "income", "amount": 1234.5,
       "category": "freelance", "date": "2026-10-07", "created_ms": 1759800000000, "client_updated_ms": 5000}]')
    on conflict (user_id, id) do update set type = excluded.type, amount = excluded.amount, category = excluded.category,
      note = excluded.note, date = excluded.date, created_ms = excluded.created_ms, example = excluded.example,
      deleted = excluded.deleted, client_updated_ms = excluded.client_updated_ms$$, 2);
select t.ok('tombstone stored (deleted, data cleared) and still visible to its owner for pulls',
  (select deleted and type is null and amount is null and client_updated_ms = 5000 from public.transactions where id = 'tx2'));
select t.ok('missing optional keys fall back to defaults (note '''', example false)',
  (select note = '' and category = 'freelance' and not example and not deleted and amount = 1234.50
   from public.transactions where id = 'tx5'));
select t.affects('undo delete: full row with newer client_updated_ms revives the tombstone',
  $$insert into public.transactions (user_id, id, type, amount, category, note, date, created_ms, example, deleted, client_updated_ms)
    values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'tx2', 'income', 60000, 'salary', '', '2026-10-05', 1759600000000, false, false, 6000)
    on conflict (user_id, id) do update set type = excluded.type, amount = excluded.amount, category = excluded.category,
      note = excluded.note, date = excluded.date, created_ms = excluded.created_ms, example = excluded.example,
      deleted = excluded.deleted, client_updated_ms = excluded.client_updated_ms$$, 1);
select t.ok('revived row is live again', (select not deleted and amount = 60000 from public.transactions where id = 'tx2'));
select t.affects('tombstone for an id the server never saw is accepted',
  $$insert into public.transactions (id, deleted, client_updated_ms) values ('never-pushed', true, 7000)$$, 1);
select t.fails('a live row cannot lose its amount', $$update public.transactions set amount = null where id = 'tx2'$$, '23514');

-- updated_at grows with every accepted write
insert into public.transactions (id, type, amount, date, client_updated_ms) values ('seq1', 'expense', 1, '2026-10-08', 1);
insert into public.transactions (id, type, amount, date, client_updated_ms) values ('seq2', 'expense', 1, '2026-10-08', 1);
update public.transactions set note = 'later' where id = 'seq1';
select t.ok('updated_at strictly increasing across successive writes',
  (select (select updated_at from public.transactions where id = 'seq2') > (select updated_at from public.transactions where id = 'tx5')
      and (select updated_at from public.transactions where id = 'seq1') > (select updated_at from public.transactions where id = 'seq2')));

-- The exact pull query of the sync engine (first page, fixed lower bound).
select t.ok('pull query: own rows only, ordered by (updated_at, id), includes tombstones',
  (with page as (
     select id, user_id, updated_at, deleted from public.transactions
     where updated_at > (:'u0'::timestamptz - interval '2 minutes')
     order by updated_at, id limit 1000 offset 0)
   select count(*) = (select count(*) from public.transactions)
      and bool_and(user_id = :A) and bool_or(deleted)
   from page));

-- ---------------------------------------------------------------------
-- 6. Constraint violations (as A)
-- ---------------------------------------------------------------------
select t.violates('type must be income/expense/saving/transfer',
  $$insert into public.transactions (id, type, amount, date) values ('c1', 'bogus', 1, '2026-10-01')$$, 'transactions_type_valid');
select t.fails('amount 0 rejected', $$insert into public.transactions (id, type, amount, date) values ('c2', 'expense', 0, '2026-10-01')$$, '23514');
select t.fails('negative amount rejected', $$insert into public.transactions (id, type, amount, date) values ('c3', 'expense', -5, '2026-10-01')$$, '23514');
select t.fails('amount 0.004 rounds to 0.00 and is rejected', $$insert into public.transactions (id, type, amount, date) values ('c4', 'expense', 0.004, '2026-10-01')$$, '23514');
select t.fails('amount 1e10 rejected (must be < 1e10)', $$insert into public.transactions (id, type, amount, date) values ('c5', 'expense', 1e10, '2026-10-01')$$, '23514');
select t.fails('amount NaN rejected', $$insert into public.transactions (id, type, amount, date) values ('c6', 'expense', 'NaN', '2026-10-01')$$, '23514');
select t.fails('amount 1e13 overflows numeric(14,2)', $$insert into public.transactions (id, type, amount, date) values ('c7', 'expense', 1e13, '2026-10-01')$$, '22003');
select t.affects('amount 9999999999.99 (max) accepted', $$insert into public.transactions (id, type, amount, date) values ('c8', 'expense', 9999999999.99, '2026-10-01')$$, 1);
select t.affects('amount 1.005 accepted, rounded to 2 decimals', $$insert into public.transactions (id, type, amount, date) values ('c9', 'expense', 1.005, '2026-10-01')$$, 1);
select t.ok('amount stored as 1.01', (select amount = 1.01 from public.transactions where id = 'c9'));
select t.fails('empty id rejected', $$insert into public.transactions (id, type, amount, date) values ('', 'expense', 1, '2026-10-01')$$, '23514');
select t.fails('id of 65 chars rejected', format($$insert into public.transactions (id, type, amount, date) values (%L, 'expense', 1, '2026-10-01')$$, repeat('a', 65)), '23514');
select t.affects('id of 64 chars accepted', format($$insert into public.transactions (id, type, amount, date) values (%L, 'expense', 1, '2026-10-01')$$, repeat('a', 64)), 1);
select t.affects('id with A-Z a-z 0-9 _ - accepted', $$insert into public.transactions (id, type, amount, date) values ('Ab_9-xZ', 'expense', 1, '2026-10-01')$$, 1);
select t.fails('id with a space rejected', $$insert into public.transactions (id, type, amount, date) values ('a b', 'expense', 1, '2026-10-01')$$, '23514');
select t.fails('id with a dot rejected', $$insert into public.transactions (id, type, amount, date) values ('a.b', 'expense', 1, '2026-10-01')$$, '23514');
select t.fails('id with a slash rejected', $$insert into public.transactions (id, type, amount, date) values ('a/b', 'expense', 1, '2026-10-01')$$, '23514');
select t.fails('id with Cyrillic rejected', $$insert into public.transactions (id, type, amount, date) values ('тест', 'expense', 1, '2026-10-01')$$, '23514');
select t.fails('id with trailing newline rejected', $$insert into public.transactions (id, type, amount, date) values (E'abc\n', 'expense', 1, '2026-10-01')$$, '23514');
select t.fails('id NULL rejected', $$insert into public.transactions (id, type, amount, date) values (null, 'expense', 1, '2026-10-01')$$, '23502');
select t.fails('category of 33 chars rejected', format($$insert into public.transactions (id, type, amount, date, category) values ('c10', 'expense', 1, '2026-10-01', %L)$$, repeat('c', 33)), '23514');
select t.affects('category of 32 chars accepted', format($$insert into public.transactions (id, type, amount, date, category) values ('c11', 'expense', 1, '2026-10-01', %L)$$, repeat('c', 32)), 1);
select t.fails('note of 201 chars rejected', format($$insert into public.transactions (id, type, amount, date, note) values ('c12', 'expense', 1, '2026-10-01', %L)$$, repeat('n', 201)), '23514');
select t.affects('note of 200 Cyrillic chars (400 bytes) accepted', format($$insert into public.transactions (id, type, amount, date, note) values ('c13', 'expense', 1, '2026-10-01', %L)$$, repeat('ж', 200)), 1);
select t.fails('date before 1900-01-01 rejected', $$insert into public.transactions (id, type, amount, date) values ('c14', 'expense', 1, '1899-12-31')$$, '23514');
select t.fails('date after 2199-12-31 rejected', $$insert into public.transactions (id, type, amount, date) values ('c15', 'expense', 1, '2200-01-01')$$, '23514');
select t.affects('date 1900-01-01 and 2199-12-31 accepted',
  $$insert into public.transactions (id, type, amount, date) values ('c16', 'expense', 1, '1900-01-01'), ('c17', 'expense', 1, '2199-12-31')$$, 2);
select t.fails('negative created_ms rejected', $$insert into public.transactions (id, type, amount, date, created_ms) values ('c18', 'expense', 1, '2026-10-01', -1)$$, '23514');
select t.fails('negative client_updated_ms rejected', $$insert into public.transactions (id, type, amount, date, client_updated_ms) values ('c19', 'expense', 1, '2026-10-01', -1)$$, '23514');
select t.fails('NULL client_updated_ms rejected', $$insert into public.transactions (id, type, amount, date, client_updated_ms) values ('c20', 'expense', 1, '2026-10-01', null)$$, '23502');
select t.fails('live row without date rejected', $$insert into public.transactions (id, type, amount) values ('c21', 'expense', 1)$$, '23514');
select t.fails('live row without type rejected', $$insert into public.transactions (id, amount, date) values ('c22', 1, '2026-10-01')$$, '23514');
select t.fails('live row without amount rejected', $$insert into public.transactions (id, type, date) values ('c23', 'expense', '2026-10-01')$$, '23514');
select t.affects('goal_id of 32 chars of [A-Za-z0-9_-] accepted',
  format($$insert into public.transactions (id, type, amount, date, goal_id) values ('g1', 'saving', 1, '2026-10-01', %L)$$, 'g_' || repeat('Z', 26) || '_-09'), 1);
select t.affects('goal_id NULL accepted', $$insert into public.transactions (id, type, amount, date, goal_id) values ('g2', 'saving', 1, '2026-10-01', null)$$, 1);
select t.fails('goal_id of 33 chars rejected', format($$insert into public.transactions (id, type, amount, date, goal_id) values ('g3', 'saving', 1, '2026-10-01', %L)$$, repeat('g', 33)), '23514');
select t.fails('empty goal_id rejected', $$insert into public.transactions (id, type, amount, date, goal_id) values ('g4', 'saving', 1, '2026-10-01', '')$$, '23514');
select t.fails('goal_id with a space rejected', $$insert into public.transactions (id, type, amount, date, goal_id) values ('g5', 'saving', 1, '2026-10-01', 'g car')$$, '23514');
select t.fails('goal_id with Cyrillic rejected', $$insert into public.transactions (id, type, amount, date, goal_id) values ('g6', 'saving', 1, '2026-10-01', 'цель')$$, '23514');
select t.fails('goal_id with a trailing newline rejected', $$insert into public.transactions (id, type, amount, date, goal_id) values ('g7', 'saving', 1, '2026-10-01', E'g_x\n')$$, '23514');
select t.fails('goal_id with a quote or a dot rejected', $$insert into public.transactions (id, type, amount, date, goal_id) values ('g8', 'saving', 1, '2026-10-01', 'g''x.y')$$, '23514');
select t.fails('an update to an invalid goal_id rejected', $$update public.transactions set goal_id = 'no good', client_updated_ms = 9999 where id = 'g1'$$, '23514');
select t.fails('tombstone with an invalid type still rejected', $$insert into public.transactions (id, type, deleted) values ('c24', 'bogus', true)$$, '23514');

-- ---------------------------------------------------------------------
-- 6b. v3: accounts, transfers, installments (as A)
--     Each negative case breaks exactly one check, named in the expectation:
--     that name is what the client gets in the 23514 error message.
-- ---------------------------------------------------------------------
select t.affects('type transfer accepted: a_main → a_cash',
  $$insert into public.transactions (id, type, amount, date, account, to_account, plan_id, plan_n, plan_of, deleted)
    values ('v3t1', 'transfer', 100, '2026-10-01', 'a_main', 'a_cash', null, null, null, false)$$, 1);
select t.affects('transfer with 32-character ids of [A-Za-z0-9_-] accepted',
  format($$insert into public.transactions (id, type, amount, date, account, to_account, plan_id, plan_n, plan_of, deleted) values ('v3t2', 'transfer', 1, '2026-10-01', %L, %L, null, null, null, false)$$,
         'A_' || repeat('z', 26) || '_-09', repeat('9', 32)), 1);
select t.affects('account on income, expense and saving accepted (without to_account)',
  $$insert into public.transactions (id, type, amount, date, account, to_account, plan_id, plan_n, plan_of, deleted)
    values ('v3a1', 'income', 1, '2026-10-01', 'a_main', null, null, null, null, false),
           ('v3a2', 'expense', 1, '2026-10-01', 'a_cash', null, null, null, null, false),
           ('v3a3', 'saving', 1, '2026-10-01', 'a_leumi', null, null, null, null, false)$$, 3);
select t.affects('NULLs everywhere: income, expense, saving without any v3 column accepted',
  $$insert into public.transactions (id, type, amount, date, account, to_account, plan_id, plan_n, plan_of, deleted)
    values ('v3n1', 'income', 1, '2026-10-01', null, null, null, null, null, false),
           ('v3n2', 'expense', 1, '2026-10-01', null, null, null, null, null, false),
           ('v3n3', 'saving', 1, '2026-10-01', null, null, null, null, null, false)$$, 3);
select t.affects('split parts 1 of 2, 2 of 2, 36 of 36 accepted',
  $$insert into public.transactions (id, type, amount, date, account, to_account, plan_id, plan_n, plan_of, deleted)
    values ('v3p1', 'expense', 1, '2026-10-01', 'a_max', null, 'p_a', 1, 2, false),
           ('v3p2', 'expense', 1, '2026-11-01', 'a_max', null, 'p_a', 2, 2, false),
           ('v3p3', 'expense', 1, '2026-10-01', 'a_max', null, 'p_b', 36, 36, false)$$, 3);
select t.affects('plan_id of 32 characters accepted, and a split part needs no account',
  format($$insert into public.transactions (id, type, amount, date, account, to_account, plan_id, plan_n, plan_of, deleted) values ('v3p4', 'expense', 1, '2026-10-01', null, null, %L, 1, 36, false)$$, 'p_' || repeat('Q', 26) || '_-09'), 1);
select t.affects('tombstones: a minimal one, a deleted transfer without accounts, a deleted transfer to itself',
  $$insert into public.transactions (id, type, amount, date, account, to_account, plan_id, plan_n, plan_of, deleted)
    values ('v3d1', null, null, null, null, null, null, null, null, true),
           ('v3d2', 'transfer', null, null, null, null, null, null, null, true),
           ('v3d3', 'transfer', 5, '2026-10-01', 'a_x', 'a_x', null, null, null, true)$$, 3);
select t.violates('transfer without to_account rejected',
  $$insert into public.transactions (id, type, amount, date, account, to_account, plan_id, plan_n, plan_of, deleted) values ('v3e1', 'transfer', 1, '2026-10-01', 'a_main', null, null, null, null, false)$$, 'transactions_transfer_accounts');
select t.violates('transfer without account rejected (a live transfer names its source)',
  $$insert into public.transactions (id, type, amount, date, account, to_account, plan_id, plan_n, plan_of, deleted) values ('v3e2', 'transfer', 1, '2026-10-01', null, 'a_cash', null, null, null, false)$$, 'transactions_transfer_accounts');
select t.violates('transfer without either account rejected',
  $$insert into public.transactions (id, type, amount, date, account, to_account, plan_id, plan_n, plan_of, deleted) values ('v3e3', 'transfer', 1, '2026-10-01', null, null, null, null, null, false)$$, 'transactions_transfer_accounts');
select t.violates('transfer to the same account rejected (to_account = account)',
  $$insert into public.transactions (id, type, amount, date, account, to_account, plan_id, plan_n, plan_of, deleted) values ('v3e4', 'transfer', 1, '2026-10-01', 'a_cash', 'a_cash', null, null, null, false)$$, 'transactions_transfer_accounts');
select t.violates('to_account on an expense rejected',
  $$insert into public.transactions (id, type, amount, date, account, to_account, plan_id, plan_n, plan_of, deleted) values ('v3e5e', 'expense', 1, '2026-10-01', 'a_main', 'a_cash', null, null, null, false)$$, 'transactions_to_account_transfer_only');
select t.violates('to_account on an income rejected',
  $$insert into public.transactions (id, type, amount, date, account, to_account, plan_id, plan_n, plan_of, deleted) values ('v3e5i', 'income', 1, '2026-10-01', 'a_main', 'a_cash', null, null, null, false)$$, 'transactions_to_account_transfer_only');
select t.violates('to_account on a saving rejected',
  $$insert into public.transactions (id, type, amount, date, account, to_account, plan_id, plan_n, plan_of, deleted) values ('v3e5s', 'saving', 1, '2026-10-01', 'a_main', 'a_cash', null, null, null, false)$$, 'transactions_to_account_transfer_only');
select t.violates('to_account on a deleted expense rejected too (only a transfer has one)',
  $$insert into public.transactions (id, type, amount, date, account, to_account, plan_id, plan_n, plan_of, deleted) values ('v3e6', 'expense', 1, '2026-10-01', 'a_main', 'a_cash', null, null, null, true)$$, 'transactions_to_account_transfer_only');
select t.violates('account with a space rejected',
  $$insert into public.transactions (id, type, amount, date, account, to_account, plan_id, plan_n, plan_of, deleted) values ('v3f', 'expense', 1, '2026-10-01', 'a main', null, null, null, null, false)$$, 'transactions_account_format');
select t.violates('account with Cyrillic rejected',
  $$insert into public.transactions (id, type, amount, date, account, to_account, plan_id, plan_n, plan_of, deleted) values ('v3f', 'expense', 1, '2026-10-01', 'счёт', null, null, null, null, false)$$, 'transactions_account_format');
select t.violates('account with a dot rejected',
  $$insert into public.transactions (id, type, amount, date, account, to_account, plan_id, plan_n, plan_of, deleted) values ('v3f', 'expense', 1, '2026-10-01', 'a.b', null, null, null, null, false)$$, 'transactions_account_format');
select t.violates('account with a trailing newline rejected',
  $$insert into public.transactions (id, type, amount, date, account, to_account, plan_id, plan_n, plan_of, deleted) values ('v3f', 'expense', 1, '2026-10-01', E'a_x\n', null, null, null, null, false)$$, 'transactions_account_format');
select t.violates('account with a quote rejected',
  $$insert into public.transactions (id, type, amount, date, account, to_account, plan_id, plan_n, plan_of, deleted) values ('v3f', 'expense', 1, '2026-10-01', 'a''b', null, null, null, null, false)$$, 'transactions_account_format');
select t.violates('empty account rejected',
  $$insert into public.transactions (id, type, amount, date, account, to_account, plan_id, plan_n, plan_of, deleted) values ('v3f', 'expense', 1, '2026-10-01', '', null, null, null, null, false)$$, 'transactions_account_format');
select t.violates('account of 33 characters rejected',
  format($$insert into public.transactions (id, type, amount, date, account, to_account, plan_id, plan_n, plan_of, deleted) values ('v3f', 'expense', 1, '2026-10-01', %L, null, null, null, null, false)$$, repeat('a', 33)), 'transactions_account_format');
select t.violates('to_account of 33 characters rejected',
  format($$insert into public.transactions (id, type, amount, date, account, to_account, plan_id, plan_n, plan_of, deleted) values ('v3f', 'transfer', 1, '2026-10-01', 'a_main', %L, null, null, null, false)$$, repeat('b', 33)), 'transactions_to_account_format');
select t.violates('to_account with a slash rejected',
  $$insert into public.transactions (id, type, amount, date, account, to_account, plan_id, plan_n, plan_of, deleted) values ('v3f', 'transfer', 1, '2026-10-01', 'a_main', 'a/b', null, null, null, false)$$, 'transactions_to_account_format');
select t.violates('empty to_account rejected',
  $$insert into public.transactions (id, type, amount, date, account, to_account, plan_id, plan_n, plan_of, deleted) values ('v3f', 'transfer', 1, '2026-10-01', 'a_main', '', null, null, null, false)$$, 'transactions_to_account_format');
select t.violates('plan_id of 33 characters rejected',
  format($$insert into public.transactions (id, type, amount, date, account, to_account, plan_id, plan_n, plan_of, deleted) values ('v3g', 'expense', 1, '2026-10-01', null, null, %L, 1, 2, false)$$, repeat('p', 33)), 'transactions_plan_id_format');
select t.violates('plan_id with a space rejected',
  $$insert into public.transactions (id, type, amount, date, account, to_account, plan_id, plan_n, plan_of, deleted) values ('v3g', 'expense', 1, '2026-10-01', null, null, 'p x', 1, 2, false)$$, 'transactions_plan_id_format');
select t.violates('empty plan_id rejected',
  $$insert into public.transactions (id, type, amount, date, account, to_account, plan_id, plan_n, plan_of, deleted) values ('v3g', 'expense', 1, '2026-10-01', null, null, '', 1, 2, false)$$, 'transactions_plan_id_format');
select t.violates('partial plan rejected: plan_id only',
  $$insert into public.transactions (id, type, amount, date, account, to_account, plan_id, plan_n, plan_of, deleted) values ('v3h', 'expense', 1, '2026-10-01', 'a_max', null, 'p_x', null, null, false)$$, 'transactions_plan_complete');
select t.violates('partial plan rejected: plan_id and plan_n without plan_of',
  $$insert into public.transactions (id, type, amount, date, account, to_account, plan_id, plan_n, plan_of, deleted) values ('v3h', 'expense', 1, '2026-10-01', 'a_max', null, 'p_x', 1, null, false)$$, 'transactions_plan_complete');
select t.violates('partial plan rejected: plan_id and plan_of without plan_n',
  $$insert into public.transactions (id, type, amount, date, account, to_account, plan_id, plan_n, plan_of, deleted) values ('v3h', 'expense', 1, '2026-10-01', 'a_max', null, 'p_x', null, 2, false)$$, 'transactions_plan_complete');
select t.violates('partial plan rejected: plan_n and plan_of without plan_id',
  $$insert into public.transactions (id, type, amount, date, account, to_account, plan_id, plan_n, plan_of, deleted) values ('v3h', 'expense', 1, '2026-10-01', 'a_max', null, null, 1, 2, false)$$, 'transactions_plan_complete');
select t.violates('partial plan rejected: plan_n only',
  $$insert into public.transactions (id, type, amount, date, account, to_account, plan_id, plan_n, plan_of, deleted) values ('v3h', 'expense', 1, '2026-10-01', 'a_max', null, null, 1, null, false)$$, 'transactions_plan_complete');
select t.violates('partial plan rejected: plan_of only',
  $$insert into public.transactions (id, type, amount, date, account, to_account, plan_id, plan_n, plan_of, deleted) values ('v3h', 'expense', 1, '2026-10-01', 'a_max', null, null, null, 2, false)$$, 'transactions_plan_complete');
select t.violates('plan out of range rejected: part 3 of 2 (n > of)',
  $$insert into public.transactions (id, type, amount, date, account, to_account, plan_id, plan_n, plan_of, deleted) values ('v3i', 'expense', 1, '2026-10-01', 'a_max', null, 'p_x', 3, 2, false)$$, 'transactions_plan_range');
select t.violates('plan out of range rejected: part 0 of 2',
  $$insert into public.transactions (id, type, amount, date, account, to_account, plan_id, plan_n, plan_of, deleted) values ('v3i', 'expense', 1, '2026-10-01', 'a_max', null, 'p_x', 0, 2, false)$$, 'transactions_plan_range');
select t.violates('plan out of range rejected: part -1 of 2',
  $$insert into public.transactions (id, type, amount, date, account, to_account, plan_id, plan_n, plan_of, deleted) values ('v3i', 'expense', 1, '2026-10-01', 'a_max', null, 'p_x', -1, 2, false)$$, 'transactions_plan_range');
select t.violates('plan out of range rejected: 1 of 1 (of = 1)',
  $$insert into public.transactions (id, type, amount, date, account, to_account, plan_id, plan_n, plan_of, deleted) values ('v3i', 'expense', 1, '2026-10-01', 'a_max', null, 'p_x', 1, 1, false)$$, 'transactions_plan_range');
select t.violates('plan out of range rejected: 1 of 37 (of = 37)',
  $$insert into public.transactions (id, type, amount, date, account, to_account, plan_id, plan_n, plan_of, deleted) values ('v3i', 'expense', 1, '2026-10-01', 'a_max', null, 'p_x', 1, 37, false)$$, 'transactions_plan_range');
select t.violates('plan out of range rejected: 37 of 37',
  $$insert into public.transactions (id, type, amount, date, account, to_account, plan_id, plan_n, plan_of, deleted) values ('v3i', 'expense', 1, '2026-10-01', 'a_max', null, 'p_x', 37, 37, false)$$, 'transactions_plan_range');
select t.violates('plan out of range rejected: 0 of 0',
  $$insert into public.transactions (id, type, amount, date, account, to_account, plan_id, plan_n, plan_of, deleted) values ('v3i', 'expense', 1, '2026-10-01', 'a_max', null, 'p_x', 0, 0, false)$$, 'transactions_plan_range');
select t.fails('plan_n beyond smallint rejected (22003)',
  $$insert into public.transactions (id, type, amount, date, account, to_account, plan_id, plan_n, plan_of, deleted) values ('v3i', 'expense', 1, '2026-10-01', 'a_max', null, 'p_x', 40000, 2, false)$$, '22003');
select t.fails('a fractional plan_n from JSON (PostgREST) rejected (22P02)',
  $$insert into public.transactions (id, type, amount, date, plan_id, plan_n, plan_of)
    select id, type, amount, date, plan_id, plan_n, plan_of from json_populate_recordset(null::public.transactions,
      '[{"id": "v3i", "type": "expense", "amount": 1, "date": "2026-10-01", "plan_id": "p_x", "plan_n": 1.5, "plan_of": 2}]')$$, '22P02');
select t.violates('plan on an income rejected (expenses only)',
  $$insert into public.transactions (id, type, amount, date, account, to_account, plan_id, plan_n, plan_of, deleted) values ('v3j', 'income', 1, '2026-10-01', 'a_main', null, 'p_x', 1, 2, false)$$, 'transactions_plan_expense_only');
select t.violates('plan on a saving rejected (expenses only)',
  $$insert into public.transactions (id, type, amount, date, account, to_account, plan_id, plan_n, plan_of, deleted) values ('v3j', 'saving', 1, '2026-10-01', 'a_main', null, 'p_x', 1, 2, false)$$, 'transactions_plan_expense_only');
select t.violates('plan on a transfer rejected (expenses only)',
  $$insert into public.transactions (id, type, amount, date, account, to_account, plan_id, plan_n, plan_of, deleted) values ('v3j', 'transfer', 1, '2026-10-01', 'a_main', 'a_max', 'p_x', 1, 2, false)$$, 'transactions_plan_expense_only');
select t.violates('update: sending a live transfer to its own source rejected',
  $$update public.transactions set to_account = account, client_updated_ms = 9000 where id = 'v3t1'$$, 'transactions_transfer_accounts');
select t.violates('update: dropping to_account from a live transfer rejected',
  $$update public.transactions set to_account = null, client_updated_ms = 9000 where id = 'v3t1'$$, 'transactions_transfer_accounts');
select t.violates('update: a transfer turned into an expense must drop to_account',
  $$update public.transactions set type = 'expense', client_updated_ms = 9000 where id = 'v3t1'$$, 'transactions_to_account_transfer_only');
select t.violates('update: a split part turned into income must drop its plan',
  $$update public.transactions set type = 'income', client_updated_ms = 9000 where id = 'v3p1'$$, 'transactions_plan_expense_only');
select t.violates('update: a split part cannot lose only plan_of',
  $$update public.transactions set plan_of = null, client_updated_ms = 9000 where id = 'v3p1'$$, 'transactions_plan_complete');
select t.violates('update: reviving a deleted transfer without its accounts rejected',
  $$update public.transactions set deleted = false, amount = 1, date = '2026-10-01', client_updated_ms = 9000 where id = 'v3d2'$$, 'transactions_transfer_accounts');
select t.affects('update: a transfer turned into an expense with to_account cleared accepted',
  $$update public.transactions set type = 'expense', to_account = null, client_updated_ms = 9000 where id = 'v3t2'$$, 1);
select t.ok('none of the rejected v3 rows was stored',
  (select count(*) = 0 from public.transactions where id ~ '^v3[e-j]'));

-- ---------------------------------------------------------------------
-- 7. Settings: LWW, validation (as A)
-- ---------------------------------------------------------------------
select updated_at as s0 from public.budget_settings \gset
select t.affects('settings LWW: older upsert ignored',
  $$insert into public.budget_settings (user_id, data, client_updated_ms) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '{"startBalance": -1}', 999)
    on conflict (user_id) do update set data = excluded.data, client_updated_ms = excluded.client_updated_ms$$, 0);
select t.ok('settings unchanged after older write',
  (select data ->> 'startBalance' = '1000' and client_updated_ms = 1000 and updated_at = :'s0' from public.budget_settings));
select t.affects('settings LWW: equal upsert applied',
  $$insert into public.budget_settings (user_id, data, client_updated_ms) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '{"startBalance": 1001}', 1000)
    on conflict (user_id) do update set data = excluded.data, client_updated_ms = excluded.client_updated_ms$$, 1);
select t.ok('settings: equal write stored, updated_at advanced',
  (select data ->> 'startBalance' = '1001' and updated_at > :'s0' from public.budget_settings));
select updated_at as s1 from public.budget_settings \gset
select t.affects('settings LWW: newer upsert applied (client updated_at ignored)',
  $$insert into public.budget_settings (user_id, data, client_updated_ms, updated_at)
    values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '{"startBalance": -250.5, "goal": {"name": "Отпуск", "target": 100000, "deadline": "", "initial": 0}, "limits": {"cafe": 5000}}', 2000, '2000-01-01')
    on conflict (user_id) do update set data = excluded.data, client_updated_ms = excluded.client_updated_ms, updated_at = excluded.updated_at$$, 1);
select t.ok('settings: newer write stored, updated_at stamped by server',
  (select (data -> 'goal' ->> 'name') = 'Отпуск' and client_updated_ms = 2000 and updated_at > :'s1' from public.budget_settings));
select t.affects('settings LWW: plain UPDATE with older client_updated_ms ignored',
  $$update public.budget_settings set data = '{}', client_updated_ms = 1500$$, 0);
select t.fails('settings: data must be an object (array)', $$update public.budget_settings set data = '[]', client_updated_ms = 3000$$, '23514');
select t.fails('settings: data must be an object (string)', $$update public.budget_settings set data = '"x"', client_updated_ms = 3000$$, '23514');
select t.fails('settings: data must be an object (json null)', $$update public.budget_settings set data = 'null', client_updated_ms = 3000$$, '23514');
select t.fails('settings: data SQL NULL rejected', $$update public.budget_settings set data = null, client_updated_ms = 3000$$, '23502');
select t.affects('settings: the largest document the app makes (20 goals, 60 categories, 100 limits, 20 accounts, _ms, _ms3) is accepted',
  format($$update public.budget_settings set data = %L::jsonb, client_updated_ms = 3000$$, :'maxdoc'), 1);
select t.ok(format('settings: its size as the server measures it (%s bytes) is what the client and the fake server compute', :'maxdoc_bytes'),
  (select octet_length(data::text) = :maxdoc_bytes from public.budget_settings));
-- the client refuses a document over 55 000 bytes and its stamps take at most 9 829 (src/store-pwa.js
-- MAX_SETTINGS_BYTES): the largest document of known fields (45 252 with stamps) leaves room for later versions
select t.ok('settings: far below the 64 KB limit (room for unknown fields and later versions)',
  (select octet_length(data::text) < 65536 - 15000 from public.budget_settings));
select t.ok('settings: stored whole (20 goals, 60 categories, 100 limits, 20 accounts, _ms3)',
  (select jsonb_array_length(data -> 'goals') = 20 and jsonb_array_length(data -> 'categories') = 60
          and jsonb_array_length(data -> 'accounts') = 20 and data ? '_ms3'
          and (select count(*) from jsonb_object_keys(data -> 'limits')) = 100 and data -> 'goals' -> 0 ->> 'name' = repeat('₪', 60)
   from public.budget_settings));
select t.affects('settings: exactly 65536 bytes accepted',
  $$update public.budget_settings set data = jsonb_build_object('x', repeat('a', 65527)), client_updated_ms = 3001$$, 1);
select t.ok('settings: (that is octet_length 65536)', (select octet_length(data::text) = 65536 from public.budget_settings));
select t.fails('settings: 65537 bytes rejected',
  $$update public.budget_settings set data = jsonb_build_object('x', repeat('a', 65528)), client_updated_ms = 3002$$, '23514');
select t.fails('settings: 64 KB of 2-byte characters counted in bytes, rejected',
  $$update public.budget_settings set data = jsonb_build_object('x', repeat('ж', 32764)), client_updated_ms = 3002$$, '23514');
select t.fails('settings: user_id cannot change',
  $$update public.budget_settings set user_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', client_updated_ms = 3000$$, '23514');
select t.affects('settings: owner can delete own settings', $$delete from public.budget_settings$$, 1);
select t.fails('settings: negative client_updated_ms rejected',
  $$insert into public.budget_settings (data, client_updated_ms) values ('{}', -1)$$, '23514');
select t.affects('settings: and insert them again', $$insert into public.budget_settings (data, client_updated_ms) values ('{}', 1)$$, 1);

-- ---------------------------------------------------------------------
-- 8. Delete, user_id immutability, missing auth (as A / no uid / unknown user)
-- ---------------------------------------------------------------------
select t.affects('A: hard delete of own row', $$delete from public.transactions where id = 'seq2'$$, 1);
select t.fails('A: cannot change user_id of own row', $$update public.transactions set user_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' where id = 'tx1'$$, '23514');
select t.fails('A: cannot change id of own row', $$update public.transactions set id = 'renamed' where id = 'tx1'$$, '23514');

:as_nouid
select t.ok('no sub claim: sees no transactions', (select count(*) from public.transactions) = 0);
select t.ok('no sub claim: sees no settings', (select count(*) from public.budget_settings) = 0);
select t.fails('no sub claim: cannot insert',
  $$insert into public.transactions (id, type, amount, date) values ('n1', 'expense', 1, '2026-10-01')$$, '42501');

:as_c
select t.fails('signed-in user without auth.users row: foreign key rejects the insert',
  $$insert into public.transactions (id, type, amount, date) values ('fk1', 'expense', 1, '2026-10-01')$$, '23503');

-- ---------------------------------------------------------------------
-- 9. service_role (secret key) bypasses RLS but not the trigger rules
-- ---------------------------------------------------------------------
:as_service
select t.ok('service_role sees rows of both users', (select count(distinct user_id) = 2 from public.transactions));
select t.fails('service_role cannot change user_id either',
  $$update public.transactions set user_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and id = 'tx1'$$, '23514');
select t.affects('service_role: older write is ignored too',
  $$update public.transactions set note = 'svc-old', client_updated_ms = 1 where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and id = 'tx1'$$, 0);
select t.violates('service_role is bound by the v3 checks too',
  $$update public.transactions set to_account = account, client_updated_ms = 9999999 where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and id = 'tr2'$$,
  'transactions_transfer_accounts');

-- ---------------------------------------------------------------------
-- 10. Realtime: a DELETE's old key in the WAL carries user_id (replica identity
--     DEFAULT = primary key), so "user_id=eq.<uid>" filters work for deletes too.
-- ---------------------------------------------------------------------
:as_admin
select slot_name from pg_create_logical_replication_slot('t_slot', 'test_decoding') \gset
delete from public.transactions where user_id = :B and id = 'tx1';
update public.transactions set note = 'via wal' where user_id = :A and id = 'tx4';
create temp table t_wal as select data from pg_logical_slot_get_changes('t_slot', null, null);
select pg_drop_replication_slot('t_slot') as dropped \gset
select t.ok('WAL: DELETE carries old key user_id + id',
  exists (select 1 from t_wal where data like 'table public.transactions: DELETE: user_id[uuid]:''bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'' id[text]:''tx1''%'));
select t.ok('WAL: UPDATE carries the full new row incl. user_id',
  exists (select 1 from t_wal where data like 'table public.transactions: UPDATE: user_id[uuid]:''aaaaaaaa-%'' id[text]:''tx4''%note[text]:''via wal''%'));

-- ---------------------------------------------------------------------
-- 11. Deleting an account removes its data (cascade works with FORCE RLS
--     even when the table owner has no BYPASSRLS)
-- ---------------------------------------------------------------------
:as_admin
select count(*) as b_rows_before from public.transactions where user_id = :B \gset
alter role postgres nobypassrls;
set role supabase_auth_admin;
select t.affects('auth admin deletes user A', $$delete from auth.users where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'$$, 1);
:as_admin
alter role postgres bypassrls;
select t.ok('cascade: A''s transactions and settings are gone',
  (select count(*) from public.transactions where user_id = :A) = 0
  and (select count(*) from public.budget_settings where user_id = :A) = 0);
select t.ok('cascade: B''s data kept',
  (select count(*) from public.transactions where user_id = :B) = :b_rows_before
  and (select count(*) from public.budget_settings where user_id = :B) = 1);

-- ---------------------------------------------------------------------
-- 12. Re-running schema.sql: with data present, without the publication,
--     with a FOR ALL TABLES publication, and with a fresh empty publication.
-- ---------------------------------------------------------------------
select count(*) as rows_before from public.transactions \gset
select count(*) as goal_rows_before from public.transactions where goal_id is not null \gset
select count(*) filter (where account is not null or to_account is not null or plan_id is not null) as v3_rows_before,
       md5(string_agg(x::text, ',' order by x.user_id, x.id)) as tx_digest_before
from public.transactions x \gset
select md5(string_agg(x::text, ',' order by x.user_id)) as settings_digest_before from public.budget_settings x \gset
drop publication supabase_realtime;
\connect - postgres
\ir ../../supabase/schema.sql
\connect - supabase_admin
select t.ok('re-run without publication succeeds and keeps data',
  (select count(*) from public.transactions) = :rows_before);

create publication supabase_realtime for all tables;
\connect - postgres
\ir ../../supabase/schema.sql
\connect - supabase_admin
select t.ok('re-run with a FOR ALL TABLES publication succeeds',
  (select puballtables from pg_publication where pubname = 'supabase_realtime'));

drop publication supabase_realtime;
create publication supabase_realtime;
alter publication supabase_realtime owner to postgres;
\connect - postgres
\ir ../../supabase/schema.sql
\connect - supabase_admin
select t.ok('re-run adds both tables to a fresh publication',
  (select count(*) = 2 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public'));
select t.ok('after all re-runs: one goal_id column, one goal_id check, goal_id values intact',
  (select count(*) = 1 from pg_attribute where attrelid = 'public.transactions'::regclass and attname = 'goal_id' and not attisdropped)
  and (select count(*) = 1 from pg_constraint where conrelid = 'public.transactions'::regclass and conname = 'transactions_goal_id_format')
  and (select count(*) = 1 from pg_constraint where conrelid = 'public.budget_settings'::regclass and conname = 'budget_settings_data_size')
  and :goal_rows_before > 0
  and (select count(*) from public.transactions where goal_id is not null) = :goal_rows_before);
select t.ok('after all re-runs: every v3 check once, v3 values intact',
  (select count(*) = 8 from pg_constraint where conrelid = 'public.transactions'::regclass and conname in (
     'transactions_account_format', 'transactions_to_account_format', 'transactions_to_account_transfer_only',
     'transactions_transfer_accounts', 'transactions_plan_id_format', 'transactions_plan_complete',
     'transactions_plan_range', 'transactions_plan_expense_only'))
  and :v3_rows_before > 0
  and (select count(*) from public.transactions where account is not null or to_account is not null or plan_id is not null) = :v3_rows_before);
select t.ok('after all re-runs: every row byte for byte the same, updated_at included (no row rewritten)',
  (select md5(string_agg(x::text, ',' order by x.user_id, x.id)) = :'tx_digest_before' from public.transactions x)
  and (select md5(string_agg(x::text, ',' order by x.user_id)) = :'settings_digest_before' from public.budget_settings x));
select t.ok('after all re-runs: still 4+4 policies, 2 triggers, data intact',
  (select count(*) = 8 from pg_policies where schemaname = 'public')
  and (select count(*) = 2 from pg_trigger where not tgisinternal
       and tgrelid in ('public.transactions'::regclass, 'public.budget_settings'::regclass))
  and (select count(*) from public.transactions) = :rows_before);

-- ---------------------------------------------------------------------
select format('summary: %s checks, %s failed', count(*), count(*) filter (where not ok)) from t.results;
