-- Canonical text of everything supabase/schema.sql defines in the database: tables (RLS, replica identity, owner,
-- grants, comments), columns, constraints, indexes, policies, triggers, functions, relations of schema public and
-- publication membership. No data, no OIDs. One value, one line per object, sorted.
-- run.sh prints it after each application of schema.sql and after each upgrade; every copy must be identical,
-- so re-running the script is a no-op and an upgraded project ends up exactly like a fresh one.
select string_agg(line, E'\n' order by line) from (
  select format('table %s rls=%s force=%s replident=%s owner=%s acl=%s comment=%s',
           c.relname, c.relrowsecurity, c.relforcerowsecurity, c.relreplident, pg_get_userbyid(c.relowner),
           (select array_agg(a::text order by a::text) from unnest(c.relacl) a), obj_description(c.oid, 'pg_class')) as line
  from pg_class c
  where c.oid in ('public.transactions'::regclass, 'public.budget_settings'::regclass)
  union all
  select format('column %s.%s #%s %s notnull=%s default=%s comment=%s', c.relname, a.attname, a.attnum,
           format_type(a.atttypid, a.atttypmod), a.attnotnull, pg_get_expr(d.adbin, d.adrelid), col_description(c.oid, a.attnum))
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
  where c.oid in ('public.transactions'::regclass, 'public.budget_settings'::regclass) and a.attnum > 0 and not a.attisdropped
  union all
  select format('constraint %s.%s %s validated=%s', c.relname, k.conname, pg_get_constraintdef(k.oid), k.convalidated)
  from pg_constraint k
  join pg_class c on c.oid = k.conrelid
  where c.oid in ('public.transactions'::regclass, 'public.budget_settings'::regclass)
  union all
  select format('index %s', pg_get_indexdef(i.indexrelid))
  from pg_index i
  where i.indrelid in ('public.transactions'::regclass, 'public.budget_settings'::regclass)
  union all
  select format('policy %s.%s %s %s roles=%s using=%s check=%s', p.tablename, p.policyname, p.permissive, p.cmd, p.roles, p.qual, p.with_check)
  from pg_policies p
  where p.schemaname = 'public'
  union all
  select format('trigger %s enabled=%s', pg_get_triggerdef(g.oid), g.tgenabled)
  from pg_trigger g
  where g.tgrelid in ('public.transactions'::regclass, 'public.budget_settings'::regclass) and not g.tgisinternal
  union all
  select format('function %s config=%s secdef=%s owner=%s acl=%s def=%s', p.oid::regprocedure, p.proconfig, p.prosecdef,
           pg_get_userbyid(p.proowner), (select array_agg(a::text order by a::text) from unnest(p.proacl) a), md5(pg_get_functiondef(p.oid)))
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace
  union all
  select format('relation public.%s kind=%s', c.relname, c.relkind)
  from pg_class c
  where c.relnamespace = 'public'::regnamespace
  union all
  select format('published %s.%s', p.schemaname, p.tablename)
  from pg_publication_tables p
  where p.pubname = 'supabase_realtime' and p.schemaname = 'public'
) x;
