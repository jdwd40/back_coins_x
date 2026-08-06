#!/usr/bin/env bash
# inventory-supabase.sh — READ-ONLY inventory of the shared self-hosted
# Supabase PostgreSQL. Confirms the `coins` schema name is free, lists
# existing schemas/extensions/publications/roles, and checks for pg_cron.
# Never prints secrets. Run with any read-capable connection.
set -euo pipefail

: "${SUPABASE_DB_URL:?set SUPABASE_DB_URL (read-capable role; never commit)}"

psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -X -P pager=off <<'SQL'
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '60s';

\echo '=== server ==='
SELECT current_database() AS db, version() AS server_version,
       now() AS inventory_at_utc;

\echo '=== extensions ==='
SELECT extname, extversion, n.nspname AS schema
FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
ORDER BY extname;

\echo '=== pg_cron availability ==='
SELECT name, default_version, installed_version
FROM pg_available_extensions WHERE name = 'pg_cron';

\echo '=== non-system schemas (is coins free?) ==='
SELECT nspname AS schema, pg_get_userbyid(nspowner) AS owner
FROM pg_namespace
WHERE nspname NOT LIKE 'pg\_%' AND nspname <> 'information_schema'
ORDER BY nspname;

\echo '=== coins schema conflict check (must be 0 rows) ==='
SELECT nspname FROM pg_namespace WHERE nspname = 'coins';

\echo '=== per-schema table counts ==='
SELECT n.nspname AS schema, count(*) AS tables
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'r'
  AND n.nspname NOT LIKE 'pg\_%' AND n.nspname <> 'information_schema'
GROUP BY 1 ORDER BY 1;

\echo '=== realtime publications ==='
SELECT pubname, puballtables FROM pg_publication ORDER BY pubname;

\echo '=== publication tables (supabase_realtime) ==='
SELECT schemaname, tablename FROM pg_publication_tables
WHERE pubname = 'supabase_realtime' ORDER BY 1, 2;

\echo '=== roles (names only) ==='
SELECT rolname, rolcanlogin, rolsuper, rolbypassrls
FROM pg_roles ORDER BY rolname;

\echo '=== coins_worker role conflict check (must be 0 rows) ==='
SELECT rolname FROM pg_roles WHERE rolname = 'coins_worker';

\echo '=== auth schema summary (counts only, no PII) ==='
SELECT count(*) AS auth_users_total FROM auth.users;

ROLLBACK;
SQL

# cron.job only exists when pg_cron is installed — probe separately.
echo '=== existing cron jobs (if pg_cron present) ==='
psql "$SUPABASE_DB_URL" -X -P pager=off -tA -c \
  "SELECT 'pg_cron installed' WHERE EXISTS (SELECT 1 FROM pg_extension WHERE extname='pg_cron')" \
  | grep -q . \
  && psql "$SUPABASE_DB_URL" -X -P pager=off -c \
       "SELECT jobid, jobname, schedule, active FROM cron.job ORDER BY jobname" \
  || echo '(pg_cron not installed)'
