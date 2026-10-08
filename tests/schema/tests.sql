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
\set B '''bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'''

-- ---------------------------------------------------------------------
-- Test helpers (security invoker: statements run as the current role)
-- ---------------------------------------------------------------------
:as_admin
create schema t;
create table t.results (n serial primary key, ok boolean not null, name text not null);
grant usage on schema t to public;
grant select, insert on t.results to public;
grant usage on sequence t.results_n_seq to public;

create function t.ok(name text, cond boolean) returns text language plpgsql as $$
declare
  passed boolean := coalesce(cond, false);
  num int;
begin
  insert into t.results (ok, name) values (passed, name) returning n into num;
  return case when passed then 'ok ' else 'not ok ' end || num || ' - ' || name;
end $$;

-- The statement must fail with the given SQLSTATE.
create function t.fails(name text, stmt text, state text) returns text language plpgsql as $$
declare
  got text;
  msg text;
begin
  begin
    execute stmt;
  exception when others then
    get stacked diagnostics got = returned_sqlstate, msg = message_text;
  end;
  return t.ok(format('%s [want %s, got %s]', name, state,
                     coalesce(got || ' ' || msg, 'success')),
              got is not distinct from state);
end $$;

-- The statement must succeed and affect exactly n rows.
create function t.affects(name text, stmt text, n bigint) returns text language plpgsql as $$
declare
  cnt bigint;
  got text;
  msg text;
begin
  begin
    execute stmt;
    get diagnostics cnt = row_count;
  exception when others then
    get stacked diagnostics got = returned_sqlstate, msg = message_text;
  end;
  return t.ok(format('%s [want %s row(s), got %s]', name, n,
                     coalesce(cnt::text, 'error ' || got || ' ' || msg)),
              got is null and cnt = n);
end $$;

grant execute on all functions in schema t to public;

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

:as_admin
select t.ok('A''s tx1 untouched by B', (select note = 'Пятёрочка' and client_updated_ms = 1000 from public.transactions where user_id = :A and id = 'tx1'));
select t.ok('A''s settings untouched by B', (select data ->> 'startBalance' = '1000' from public.budget_settings where user_id = :A));
select t.ok('two rows with id tx1, one per user', (select count(*) = 2 from public.transactions where id = 'tx1'));

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
select t.fails('type must be income/expense/saving',
  $$insert into public.transactions (id, type, amount, date) values ('c1', 'transfer', 1, '2026-10-01')$$, '23514');
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
select t.fails('tombstone with an invalid type still rejected', $$insert into public.transactions (id, type, deleted) values ('c24', 'bogus', true)$$, '23514');

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
select t.fails('settings: data over 32 KB rejected',
  $$update public.budget_settings set data = jsonb_build_object('x', repeat('a', 40000)), client_updated_ms = 3000$$, '23514');
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
select t.ok('after all re-runs: still 4+4 policies, 2 triggers, data intact',
  (select count(*) = 8 from pg_policies where schemaname = 'public')
  and (select count(*) = 2 from pg_trigger where not tgisinternal
       and tgrelid in ('public.transactions'::regclass, 'public.budget_settings'::regclass))
  and (select count(*) from public.transactions) = :rows_before);

-- ---------------------------------------------------------------------
select format('summary: %s checks, %s failed', count(*), count(*) filter (where not ok)) from t.results;
