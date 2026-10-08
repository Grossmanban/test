-- Supabase-like environment on plain PostgreSQL, for tests/schema only.
-- Run as the cluster superuser (supabase_admin) connected to database "postgres":
--   psql -v ON_ERROR_STOP=1 -U supabase_admin -d postgres -f shim.sql
-- It mirrors what a hosted Supabase project provides before supabase/schema.sql runs:
--   * role "postgres": NOT a superuser, owns the database and runs the SQL editor
--   * API roles anon / authenticated / service_role (service_role bypasses RLS)
--   * default privileges that grant every new public table to the API roles
--     (so the REVOKE in schema.sql is really exercised)
--   * schema auth with auth.users and auth.uid() / auth.role() / auth.jwt(),
--     which read the JWT claims from the request.jwt.claims setting like PostgREST
--   * publication supabase_realtime (empty, owned by postgres)

create role postgres login createrole createdb replication bypassrls;
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create role authenticator login noinherit;
grant anon, authenticated, service_role to authenticator;
create role supabase_auth_admin login noinherit createrole;

create database budget_test owner postgres;
\connect budget_test

grant usage on schema public to anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant all on functions to anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant all on sequences to anon, authenticated, service_role;

create schema auth authorization supabase_auth_admin;
grant usage on schema auth to postgres, anon, authenticated, service_role;

create table auth.users (
  id    uuid primary key,
  email text
);
alter table auth.users owner to supabase_auth_admin;
grant select, references on auth.users to postgres;

-- Same definitions as Supabase (auth schema migrations).
create function auth.uid() returns uuid
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

create function auth.role() returns text
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;

create function auth.jwt() returns jsonb
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;

alter function auth.uid() owner to supabase_auth_admin;
alter function auth.role() owner to supabase_auth_admin;
alter function auth.jwt() owner to supabase_auth_admin;

create publication supabase_realtime;
alter publication supabase_realtime owner to postgres;

-- Two test users (a third, never registered, is used to test the foreign key).
insert into auth.users (id, email) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a@example.test'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'b@example.test');
