#!/usr/bin/env bash
# Shared setup for the db tests. Sourced, not executed.
#
# Every test starts its OWN throwaway Postgres cluster in a temp directory, applies the
# migrations, and deletes the cluster on exit. These tests must never run against Supabase:
# the connection host is hard-checked to be localhost, all libpq/Supabase env vars are
# scrubbed, and every psql call goes through pg(), which re-checks the host.

set -u

# --- Refuse anything that isn't localhost -----------------------------------------------
TEST_PG_HOST="${TEST_PG_HOST:-localhost}"
TEST_PG_PORT="${TEST_PG_PORT:-54329}"

assert_localhost() {
  case "$TEST_PG_HOST" in
    localhost|127.0.0.1|::1) ;;
    *) echo "REFUSING TO RUN: TEST_PG_HOST='$TEST_PG_HOST' is not localhost." >&2
       echo "These tests only run against a throwaway local cluster, never Supabase." >&2
       exit 2 ;;
  esac
}
assert_localhost

# Scrub every env var that could redirect psql/libpq (PGHOSTADDR overrides -h!) or leak keys.
unset PGHOST PGHOSTADDR PGPORT PGUSER PGDATABASE PGPASSWORD PGPASSFILE PGSERVICE \
      PGSERVICEFILE PGSSLMODE PGOPTIONS DATABASE_URL \
      SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY SUPABASE_ANON_KEY 2>/dev/null || true

# --- Paths (Git Bash on Windows needs Windows-style paths inside SQL strings) --------------
winpath() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else echo "$1"; fi; }
REPO="$(winpath "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)")"

if [ -z "${PG_BIN:-}" ]; then
  if command -v initdb >/dev/null 2>&1; then PG_BIN="$(dirname "$(command -v initdb)")"
  else PG_BIN="$(ls -d "/c/Program Files/PostgreSQL/"*/bin 2>/dev/null | sort -V | tail -1)"; fi
fi
if [ ! -x "$PG_BIN/initdb" ] && [ ! -x "$PG_BIN/initdb.exe" ]; then
  echo "Postgres binaries not found. Set PG_BIN to the directory containing initdb, pg_ctl and psql." >&2
  exit 2
fi

# --- psql wrapper: the only way tests talk to a database ---------------------------------
pg() {
  assert_localhost
  "$PG_BIN/psql" -X -h "$TEST_PG_HOST" -p "$TEST_PG_PORT" -U postgres -d postgres \
    -v ON_ERROR_STOP=1 -q "$@"
}

# --- Throwaway cluster lifecycle ---------------------------------------------------------
start_cluster() {
  TEST_TMP="$(winpath "$(mktemp -d)")"
  "$PG_BIN/initdb" -D "$TEST_TMP/data" -U postgres -A trust -E UTF8 >/dev/null || exit 2
  # Listen on localhost only. Fails (and the test aborts) if the port is already taken,
  # so we can never end up running against some other server on that port.
  if ! "$PG_BIN/pg_ctl" -D "$TEST_TMP/data" -o "-p $TEST_PG_PORT -c listen_addresses=localhost" \
       -l "$TEST_TMP/log.txt" -w start >/dev/null; then
    echo "Could not start throwaway cluster on port $TEST_PG_PORT (port in use?)." >&2
    rm -rf "$TEST_TMP"; exit 2
  fi
  trap stop_cluster EXIT
}

stop_cluster() {
  "$PG_BIN/pg_ctl" -D "$TEST_TMP/data" -w stop -m fast >/dev/null 2>&1 || true
  rm -rf "$TEST_TMP"
  echo "--- throwaway cluster removed"
}

# Simulate Supabase's roles and default privileges (Supabase grants ALL on new tables and
# functions in public to anon/authenticated/service_role), then apply every migration.
setup_supabase_like_schema() {
  pg <<'SQL' || exit 2
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables    to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
SQL
  local f
  for f in "$REPO"/db/migrations/*.sql; do
    pg -f "$f" || { echo "migration failed: $f" >&2; return 1; }
  done
}

load_seed_csvs() {
  pg -c "\copy customers from '$REPO/assets/seed-data/customers.csv' csv header" &&
  pg -c "\copy transactions from '$REPO/assets/seed-data/transactions.csv' csv header" &&
  pg -c "\copy payouts from '$REPO/assets/seed-data/payouts.csv' csv header"
}
