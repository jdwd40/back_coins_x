#!/usr/bin/env bash
# run-sql-tests.sh — apply all migrations to a disposable local database and
# run the SQL test suite. Destroys nothing outside the throwaway DB it creates.
#
# Everything runs as the local postgres superuser: the OS user lacks
# CREATEDB/CREATEROLE, and this also mirrors the real Supabase migration
# executor (migrations apply as a privileged role; browser roles are
# emulated with SET ROLE, which enforces grants + RLS for privilege checks).
#
# Usage: ./scripts/test/run-sql-tests.sh [keep]
set -euo pipefail
cd "$(dirname "$0")/../.."

DB="coins_migration_test_$(date +%s)_$RANDOM"
KEEP="${1:-}"
export COINS_TEST_DB="$DB"

PSQL="sudo -n -u postgres psql -d $DB -v ON_ERROR_STOP=1 -X -q -P pager=off"

echo "== creating disposable database: $DB"
sudo -n -u postgres createdb "$DB"

cleanup() {
  if [[ "$KEEP" != "keep" ]]; then
    sudo -n -u postgres dropdb --if-exists "$DB"
    echo "== dropped $DB"
  else
    echo "== kept database: $DB"
  fi
}
trap cleanup EXIT

echo "== harness (stub auth schema/roles)"
$PSQL -f supabase/tests/000_harness.sql

echo "== applying migrations"
for f in supabase/migrations/*.sql; do
  echo "   -> $f"
  $PSQL -f "$f"
done

echo "== seed fixtures"
$PSQL -f supabase/seed.sql

# The OS user runs the node concurrency client; grant it disposable-DB-only
# broad rights + browser-role membership for SET ROLE emulation.
$PSQL <<SQL
GRANT authenticated TO "$USER";
GRANT USAGE ON SCHEMA coins TO "$USER";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA coins TO "$USER";
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA coins TO "$USER";
SQL

PASS=0; FAIL=0
for t in supabase/tests/t*.sql; do
  echo "== test: $t"
  if $PSQL -f "$t" > /tmp/sqltest.$$.out 2>&1; then
    grep -E 'NOTICE:.*ok:' /tmp/sqltest.$$.out | sed 's/^.*NOTICE:\s*/   /' || true
    PASS=$((PASS+1))
  else
    echo "   FAILED: $t"
    tail -20 /tmp/sqltest.$$.out
    FAIL=$((FAIL+1))
  fi
done
rm -f /tmp/sqltest.$$.out

echo "== result: $PASS passed, $FAIL failed"

echo "== concurrency tests (node, 8 parallel clients)"
# Local-only: the disposable DB's tables are postgres-owned, so the OS test
# client needs temporary BYPASSRLS for fixture surgery. Reverted immediately.
sudo -n -u postgres psql -d "$DB" -X -q -c "ALTER ROLE \"$USER\" BYPASSRLS"
if COINS_TEST_DB="$DB" node "$PWD/scripts/test/concurrency-test.mjs"; then
  PASS=$((PASS+1))
else
  echo "   FAILED: concurrency-test.mjs"
  FAIL=$((FAIL+1))
fi
echo "== game cycle concurrency tests (node, 8 parallel clients)"
if COINS_TEST_DB="$DB" node "$PWD/scripts/test/game-cycle-concurrency-test.mjs"; then
  PASS=$((PASS+1))
else
  echo "   FAILED: game-cycle-concurrency-test.mjs"
  FAIL=$((FAIL+1))
fi
sudo -n -u postgres psql -d "$DB" -X -q -c "ALTER ROLE \"$USER\" NOBYPASSRLS"

echo "== total: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
