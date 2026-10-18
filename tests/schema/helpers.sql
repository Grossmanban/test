-- Test helpers for tests/schema/*.sql (security invoker: statements run as the current role).
-- Include as superuser: \ir helpers.sql
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

-- The statement must fail with check_violation (23514) raised by the named constraint
-- (the name the client sees in the PostgREST error message).
create function t.violates(name text, stmt text, conname text) returns text language plpgsql as $$
declare
  got text;
  con text;
  msg text;
begin
  begin
    execute stmt;
  exception when others then
    get stacked diagnostics got = returned_sqlstate, con = constraint_name, msg = message_text;
  end;
  return t.ok(format('%s [want 23514 %s, got %s]', name, conname,
                     coalesce(got || ' ' || coalesce(nullif(con, ''), msg), 'success')),
              got = '23514' and con = conname);
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
