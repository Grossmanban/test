-- =====================================================================
-- Money honey: схема базы данных для Supabase
--
-- Как применить: Supabase → SQL Editor → New query → вставьте весь файл
-- → Run. Скрипт можно запускать повторно: он ничего не удаляет из данных,
-- а только (пере)создаёт таблицы, ограничения, триггеры и правила доступа.
-- Подробная инструкция: supabase/README.md
--
-- Contract (docs/ARCHITECTURE.md, store-pwa.js):
--   * public.transactions    one row per transaction, PK (user_id, id),
--                            deletions are tombstones (deleted = true);
--                            goal_id = the goal a saving went to (NULL = the first goal);
--                            account = the account it touches (a transfer's source,
--                            NULL = the default account), to_account = a transfer's
--                            destination, plan_id/plan_n/plan_of = part n of `of` of
--                            one split purchase (installments)
--   * public.budget_settings one jsonb document per user, PK user_id
--                            ({ startBalance, goals, limits, categories, _ms })
--   * updated_at is stamped by the server (clock_timestamp()) on every
--     insert/update; clients never set it. Pull cursor = max(updated_at).
--   * Last writer wins: an UPDATE whose client_updated_ms is smaller than the
--     stored one is silently skipped (the trigger returns NULL); an equal
--     value is applied, so re-pushing the same row is idempotent.
--   * user_id (and id) never change; RLS limits every row to its owner.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------

create table if not exists public.transactions (
  user_id           uuid          not null default auth.uid()
                                  references auth.users (id) on delete cascade,
  id                text          not null,
  type              text,                     -- 'income' | 'expense' | 'saving' | 'transfer'
  amount            numeric(14,2),            -- shekels (ILS), > 0
  category          text          not null default '',
  note              text          not null default '',
  date              date,
  created_ms        bigint        not null default 0,
  example           boolean       not null default false,
  deleted           boolean       not null default false,
  client_updated_ms bigint        not null default 0,
  updated_at        timestamptz   not null default clock_timestamp(),
  constraint transactions_pkey primary key (user_id, id)
);

create table if not exists public.budget_settings (
  user_id           uuid          not null default auth.uid()
                                  references auth.users (id) on delete cascade,
  data              jsonb         not null default '{}'::jsonb,
  client_updated_ms bigint        not null default 0,
  updated_at        timestamptz   not null default clock_timestamp(),
  constraint budget_settings_pkey primary key (user_id)
);

-- Added in v2 (Money honey). "add column if not exists" upgrades a project created
-- with an older schema.sql; the existing rows get NULL (= the first goal).
alter table public.transactions add column if not exists goal_id text;

-- Added in v3 (accounts, transfers, cards, installments). Existing rows get NULL in
-- all five: the default account, not a transfer, not part of a split purchase.
alter table public.transactions
  add column if not exists account    text,
  add column if not exists to_account text,
  add column if not exists plan_id    text,
  add column if not exists plan_n     smallint,
  add column if not exists plan_of    smallint;

comment on table public.transactions is
  'Money honey: операции (доходы, расходы, копилка, переводы между счетами). Удаление = deleted:true.';
comment on table public.budget_settings is
  'Money honey: настройки пользователя (стартовый баланс, цели, лимиты, свои категории).';
comment on column public.transactions.goal_id is
  'Saving operations: id of the goal (settings.goals[].id) the money went to. NULL = the first goal.';
comment on column public.transactions.account is
  'Id of the account (settings.accounts[].id) the operation touches; a transfer''s source. NULL = the default account.';
comment on column public.transactions.to_account is
  'Transfers only: id of the destination account (differs from account).';
comment on column public.transactions.plan_id is
  'Split purchase (installments): id shared by all its parts. plan_id, plan_n, plan_of are set together or not at all.';
comment on column public.transactions.plan_n is
  'Split purchase: number of this part, 1 .. plan_of.';
comment on column public.transactions.plan_of is
  'Split purchase: number of parts, 2 .. 36.';
comment on column public.transactions.updated_at is
  'Server time of the last accepted write (trigger, clock_timestamp()). Sync cursor.';
comment on column public.transactions.client_updated_ms is
  'Client clock (ms) of the write. Older writes than the stored value are ignored.';

-- ---------------------------------------------------------------------
-- 2. Check constraints (dropped and re-added so a re-run updates them)
--
-- type / amount / date may be NULL only on tombstones (deleted = true), so a
-- minimal tombstone push {user_id, id, deleted, client_updated_ms} never gets
-- stuck; live rows must be complete. Likewise a transfer needs both accounts
-- only while it is live. Format and range checks apply to every row.
-- A CHECK fails only on false, so NULL in account / to_account / plan_* passes
-- the v3 checks: rows written with an older schema (no account, no plan) stay valid.
-- ---------------------------------------------------------------------

alter table public.transactions
  drop constraint if exists transactions_id_format,
  drop constraint if exists transactions_type_valid,
  drop constraint if exists transactions_amount_range,
  drop constraint if exists transactions_category_length,
  drop constraint if exists transactions_note_length,
  drop constraint if exists transactions_date_range,
  drop constraint if exists transactions_ms_range,
  drop constraint if exists transactions_goal_id_format,
  drop constraint if exists transactions_live_row_complete,
  drop constraint if exists transactions_account_format,
  drop constraint if exists transactions_to_account_format,
  drop constraint if exists transactions_to_account_transfer_only,
  drop constraint if exists transactions_transfer_accounts,
  drop constraint if exists transactions_plan_id_format,
  drop constraint if exists transactions_plan_complete,
  drop constraint if exists transactions_plan_range,
  drop constraint if exists transactions_plan_expense_only,
  add constraint transactions_id_format
    check (char_length(id) between 1 and 64 and id ~ '^[A-Za-z0-9_-]+$'),
  add constraint transactions_type_valid
    check (type in ('income', 'expense', 'saving', 'transfer')),
  add constraint transactions_amount_range
    check (amount > 0 and amount < 1e10),
  add constraint transactions_category_length
    check (char_length(category) <= 32),
  add constraint transactions_note_length
    check (char_length(note) <= 200),
  add constraint transactions_date_range
    check (date between date '1900-01-01' and date '2199-12-31'),
  add constraint transactions_ms_range
    check (created_ms >= 0 and client_updated_ms >= 0),
  add constraint transactions_goal_id_format
    check (goal_id ~ '^[A-Za-z0-9_-]{1,32}$'),
  add constraint transactions_live_row_complete
    check (deleted or (type is not null and amount is not null and date is not null)),
  -- v3: accounts and transfers (ids like goal_id: settings.accounts[].id)
  add constraint transactions_account_format
    check (account ~ '^[A-Za-z0-9_-]{1,32}$'),
  add constraint transactions_to_account_format
    check (to_account ~ '^[A-Za-z0-9_-]{1,32}$'),
  add constraint transactions_to_account_transfer_only
    check (to_account is null or type = 'transfer'),
  add constraint transactions_transfer_accounts
    check (deleted or type is distinct from 'transfer'
           or (account is not null and to_account is not null and account <> to_account)),
  -- v3: installments, part plan_n of plan_of of one split purchase (expenses only)
  add constraint transactions_plan_id_format
    check (plan_id ~ '^[A-Za-z0-9_-]{1,32}$'),
  add constraint transactions_plan_complete
    check ((plan_id is null) = (plan_n is null) and (plan_id is null) = (plan_of is null)),
  add constraint transactions_plan_range
    check (plan_of between 2 and 36 and plan_n between 1 and plan_of),
  add constraint transactions_plan_expense_only
    check (plan_id is null or type = 'expense');

alter table public.budget_settings
  drop constraint if exists budget_settings_data_object,
  drop constraint if exists budget_settings_data_size,
  drop constraint if exists budget_settings_ms_range,
  add constraint budget_settings_data_object
    check (jsonb_typeof(data) = 'object'),
  -- 64 KB: the app refuses a document over 55 000 bytes of this measure (20
  -- goals, 60 categories, 100 limits, 20 accounts fit in ~35 KB); the stamps it
  -- adds when pushing (_ms, _ms3) take at most 9 829 bytes, so a push is at
  -- most 64 829
  add constraint budget_settings_data_size
    check (octet_length(data::text) <= 65536),
  add constraint budget_settings_ms_range
    check (client_updated_ms >= 0);

-- Pull query: where user_id = auth.uid() and updated_at > $cursor order by updated_at, id
create index if not exists transactions_user_id_updated_at_idx
  on public.transactions (user_id, updated_at);

-- ---------------------------------------------------------------------
-- 3. Triggers: server timestamp, last-writer-wins, immutable keys
-- ---------------------------------------------------------------------

create or replace function public.budget_tx_before_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- supabase-js bulk upserts send NULL for keys that are missing in some
  -- rows of the batch; fall back to the column defaults instead of failing.
  new.category := coalesce(new.category, '');
  new.note     := coalesce(new.note, '');
  new.created_ms := coalesce(new.created_ms, 0);
  new.example  := coalesce(new.example, false);
  new.deleted  := coalesce(new.deleted, false);

  if tg_op = 'UPDATE' then
    if new.user_id is distinct from old.user_id or new.id is distinct from old.id then
      raise exception 'budget: user_id and id of a transaction cannot be changed'
        using errcode = 'check_violation';
    end if;
    -- Last writer wins: keep the stored row when this write is older.
    -- (INSERT ... ON CONFLICT DO UPDATE then simply affects 0 rows.)
    if new.client_updated_ms < old.client_updated_ms then
      return null;
    end if;
  end if;

  new.updated_at := clock_timestamp();   -- never trust the client's value
  return new;
end;
$$;

create or replace function public.budget_settings_before_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if new.user_id is distinct from old.user_id then
      raise exception 'budget: user_id of settings cannot be changed'
        using errcode = 'check_violation';
    end if;
    if new.client_updated_ms < old.client_updated_ms then
      return null;
    end if;
  end if;

  new.updated_at := clock_timestamp();
  return new;
end;
$$;

-- Trigger functions are not callable through the API; nobody needs EXECUTE.
revoke all on function public.budget_tx_before_write() from public, anon, authenticated;
revoke all on function public.budget_settings_before_write() from public, anon, authenticated;

create or replace trigger transactions_before_write
  before insert or update on public.transactions
  for each row execute function public.budget_tx_before_write();

create or replace trigger budget_settings_before_write
  before insert or update on public.budget_settings
  for each row execute function public.budget_settings_before_write();

-- ---------------------------------------------------------------------
-- 4. Privileges: signed-in users only (anon and PUBLIC get nothing).
--    TRUNCATE / REFERENCES / TRIGGER are not granted: TRUNCATE ignores RLS.
-- ---------------------------------------------------------------------

revoke all on table public.transactions, public.budget_settings from public, anon, authenticated;
grant select, insert, update, delete on table public.transactions, public.budget_settings to authenticated;

-- ---------------------------------------------------------------------
-- 5. Row Level Security: every user sees and changes only own rows.
--    (select auth.uid()) is evaluated once per statement, not per row.
-- ---------------------------------------------------------------------

alter table public.transactions enable row level security;
alter table public.transactions force row level security;
alter table public.budget_settings enable row level security;
alter table public.budget_settings force row level security;

drop policy if exists transactions_select_own on public.transactions;
drop policy if exists transactions_insert_own on public.transactions;
drop policy if exists transactions_update_own on public.transactions;
drop policy if exists transactions_delete_own on public.transactions;

create policy transactions_select_own on public.transactions
  for select to authenticated
  using (user_id = (select auth.uid()));
create policy transactions_insert_own on public.transactions
  for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy transactions_update_own on public.transactions
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy transactions_delete_own on public.transactions
  for delete to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists budget_settings_select_own on public.budget_settings;
drop policy if exists budget_settings_insert_own on public.budget_settings;
drop policy if exists budget_settings_update_own on public.budget_settings;
drop policy if exists budget_settings_delete_own on public.budget_settings;

create policy budget_settings_select_own on public.budget_settings
  for select to authenticated
  using (user_id = (select auth.uid()));
create policy budget_settings_insert_own on public.budget_settings
  for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy budget_settings_update_own on public.budget_settings
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy budget_settings_delete_own on public.budget_settings
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------
-- 6. Realtime (change notifications that trigger a pull on other devices)
--
-- REPLICA IDENTITY stays DEFAULT (= primary key) on purpose. Realtime
-- evaluates a subscription filter on a DELETE against the old key that
-- Postgres writes to the WAL; with DEFAULT that key is the primary key, and
-- both primary keys contain user_id, so a filter "user_id=eq.<uid>" also
-- matches DELETE events. FULL would log every old row on each update for no
-- gain: with RLS on, Realtime strips a DELETE's old record down to the
-- primary key anyway, and the app deletes via tombstones (UPDATE), which are
-- filtered and RLS-checked like any other update.
-- ---------------------------------------------------------------------

alter table public.transactions replica identity default;
alter table public.budget_settings replica identity default;

do $$
declare
  t text;
begin
  if not exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime') then
    raise notice 'publication supabase_realtime not found: realtime sync is skipped (the app still syncs on a timer)';
    return;
  end if;
  foreach t in array array['transactions', 'budget_settings'] loop
    if not exists (
      select 1 from pg_catalog.pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end
$$;

commit;

-- PostgREST caches the schema: make the API see a column added above right away
-- (hosted Supabase also reloads on DDL by itself).
notify pgrst, 'reload schema';
