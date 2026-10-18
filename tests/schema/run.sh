#!/usr/bin/env bash
# Tests supabase/schema.sql against a throwaway PostgreSQL 16 cluster that
# imitates a Supabase project (see shim.sql). Nothing outside a temp dir is touched.
#
#   tests/schema/run.sh
#
# Env:
#   PGBIN            PostgreSQL server binaries   (default /usr/lib/postgresql/16/bin)
#   SCHEMA_TEST_DIR  cluster directory            (default: new dir under /tmp, removed afterwards)
#   KEEP=1           keep the directory (cluster is still stopped)
#   PG_OS_USER       OS user that runs postgres when this script runs as root (default postgres)
#
# Exit code 0 = schema applied twice without errors and every test passed (tests.sql), upgrades from the
# earlier releases' schemas with data work (schema-v1.sql + upgrade.sql, schema-v2.sql + upgrade-v2.sql), and
# the catalog (fingerprint.sql) is identical after every run of schema.sql: fresh install, re-runs, upgrades.
# Needs node (the largest settings document comes from tests/helpers/max-settings.mjs).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
SCHEMA="$ROOT/supabase/schema.sql"
PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
PSQL="$PGBIN/psql"
[ -x "$PSQL" ] || PSQL="$(command -v psql)"

# The postgres server refuses to run as root: switch to an unprivileged OS user.
if [ "$(id -u)" -eq 0 ]; then
  PG_OS_USER="${PG_OS_USER:-postgres}"
  as_pg() { runuser -u "$PG_OS_USER" -- "$@"; }
  base=/tmp            # must be reachable by $PG_OS_USER
else
  as_pg() { "$@"; }
  base="${TMPDIR:-/tmp}"
fi

created_dir=0
if [ -n "${SCHEMA_TEST_DIR:-}" ]; then
  WORK="$SCHEMA_TEST_DIR"
  mkdir -p "$WORK"
else
  WORK="$(mktemp -d "$base/budget-schema-test.XXXXXX")"
  created_dir=1
fi
[ "$(id -u)" -eq 0 ] && chown "$PG_OS_USER" "$WORK"
if ! as_pg test -w "$WORK"; then
  echo "error: $WORK is not writable by the postgres OS user" >&2
  exit 2
fi

DATA="$WORK/data"
LOG="$WORK/postgres.log"
PORT=5432             # unix socket only, inside $WORK: no TCP port, no clashes

cleanup() {
  as_pg "$PGBIN/pg_ctl" -D "$DATA" -m fast -w stop >/dev/null 2>&1 || true
  if [ "${KEEP:-0}" = 1 ] || [ "$created_dir" = 0 ]; then
    echo "cluster stopped; files kept in $WORK"
  else
    rm -rf "$WORK"
    echo "cluster stopped and removed"
  fi
}
trap cleanup EXIT

echo "== initdb ($DATA)"
as_pg "$PGBIN/initdb" -D "$DATA" -U supabase_admin -A trust -E UTF8 --locale=C.UTF-8 >"$WORK/initdb.log"
as_pg "$PGBIN/pg_ctl" -D "$DATA" -l "$LOG" -w \
  -o "-c listen_addresses='' -c unix_socket_directories='$WORK' -p $PORT -c wal_level=logical -c fsync=off" \
  start >/dev/null
echo "== postgres $("$PSQL" -X -At -h "$WORK" -p $PORT -U supabase_admin -d postgres -c 'show server_version')"

run_psql() {   # run_psql <db role> <file> [extra psql args]
  local role="$1" file="$2"; shift 2
  "$PSQL" -X -q -v ON_ERROR_STOP=1 -h "$WORK" -p $PORT -U "$role" "$@" -f "$file"
}

echo "== shim (Supabase-like roles, auth schema, publication)"
run_psql supabase_admin "$HERE/shim.sql" -d postgres
# identical databases for the upgrade tests (before any schema.sql touches budget_test)
for db in budget_upgrade budget_upgrade_v2; do
  "$PSQL" -X -q -v ON_ERROR_STOP=1 -h "$WORK" -p $PORT -U supabase_admin -d postgres \
    -c "create database $db template budget_test owner postgres"
done

fingerprint() {   # fingerprint <db> <name>: canonical catalog text of what schema.sql defines -> $WORK/fp-<name>.txt
  run_psql supabase_admin "$HERE/fingerprint.sql" -d "$1" -At >"$WORK/fp-$2.txt"
}
same_schema() {   # same_schema <name> <label>: "ok"/"not ok" line, compared with the fresh install (fp-pass1)
  if [ -s "$WORK/fp-pass1.txt" ] && cmp -s "$WORK/fp-pass1.txt" "$WORK/fp-$1.txt"; then
    echo "ok - schema fingerprint: $2"
  else
    echo "not ok - schema fingerprint: $2"
    diff "$WORK/fp-pass1.txt" "$WORK/fp-$1.txt" | sed 's/^/#   /' || true   # diff exits 1: not fatal under set -e
  fi
}

echo "== largest settings document (tests/helpers/max-settings.mjs)"
node "$ROOT/tests/helpers/max-settings.mjs" >"$WORK/max-settings.out"
node -e 'const o = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const fs = require("fs");
  fs.writeFileSync(process.argv[2], JSON.stringify(o.wire)); fs.writeFileSync(process.argv[3], String(o.wireBytes));' \
  "$WORK/max-settings.out" "$WORK/max-settings.json" "$WORK/max-settings.bytes"
export MAXDOC_FILE="$WORK/max-settings.json" MAXDOC_BYTES_FILE="$WORK/max-settings.bytes"
echo "   $(cat "$MAXDOC_BYTES_FILE") bytes as octet_length(data::text)"

for pass in 1 2; do
  echo "== apply supabase/schema.sql as role postgres (pass $pass)"
  if run_psql postgres "$SCHEMA" -d budget_test >"$WORK/apply$pass.out" 2>&1; then
    sed 's/^/   /' "$WORK/apply$pass.out"
  else
    sed 's/^/   /' "$WORK/apply$pass.out"
    echo "schema.sql failed on pass $pass" >&2
    exit 1
  fi
  fingerprint budget_test "pass$pass"
done
echo "   catalog: $(wc -l <"$WORK/fp-pass1.txt") objects (fingerprint.sql)"

echo "== tests"
set +e
PGOPTIONS='-c client_min_messages=warning' \
  run_psql supabase_admin "$HERE/tests.sql" -d budget_test -At >"$WORK/tests.out" 2>&1
status=$?
set -e
cat "$WORK/tests.out"
fingerprint budget_test tests

echo "== upgrade: schema-v1.sql with data, then supabase/schema.sql (twice)"
run_psql postgres "$HERE/schema-v1.sql" -d budget_upgrade >"$WORK/apply-v1.out" 2>&1 || { cat "$WORK/apply-v1.out"; exit 1; }
set +e
PGOPTIONS='-c client_min_messages=warning' \
  run_psql supabase_admin "$HERE/upgrade.sql" -d budget_upgrade -At >"$WORK/upgrade.out" 2>&1
ustatus=$?
set -e
cat "$WORK/upgrade.out"
cat "$WORK/upgrade.out" >>"$WORK/tests.out"
[ "$ustatus" -ne 0 ] && status=$ustatus
fingerprint budget_upgrade upgrade-v1

echo "== upgrade: schema-v2.sql with data, then supabase/schema.sql (three times)"
run_psql postgres "$HERE/schema-v2.sql" -d budget_upgrade_v2 >"$WORK/apply-v2.out" 2>&1 || { cat "$WORK/apply-v2.out"; exit 1; }
set +e
PGOPTIONS='-c client_min_messages=warning' \
  run_psql supabase_admin "$HERE/upgrade-v2.sql" -d budget_upgrade_v2 -At >"$WORK/upgrade-v2.out" 2>&1
ustatus=$?
set -e
cat "$WORK/upgrade-v2.out"
cat "$WORK/upgrade-v2.out" >>"$WORK/tests.out"
[ "$ustatus" -ne 0 ] && status=$ustatus
fingerprint budget_upgrade_v2 upgrade-v2

echo "== schema fingerprints (fingerprint.sql)"
{
  same_schema pass2 "a second run of schema.sql changes nothing"
  same_schema tests "after tests.sql (three more runs of schema.sql) the catalog is unchanged"
  same_schema upgrade-v1 "v1 project upgraded = fresh install"
  same_schema upgrade-v2 "v2 project upgraded = fresh install"
} >"$WORK/fingerprint.out"
cat "$WORK/fingerprint.out"
cat "$WORK/fingerprint.out" >>"$WORK/tests.out"

passed=$(grep -c '^ok ' "$WORK/tests.out" || true)
failed=$(grep -c '^not ok ' "$WORK/tests.out" || true)
echo "== $passed passed, $failed failed (psql exit $status)"
if [ "$status" -ne 0 ] || [ "$failed" -ne 0 ] || [ "$passed" -eq 0 ]; then
  echo "postgres log tail:" >&2
  tail -n 20 "$LOG" >&2 || true
  exit 1
fi
