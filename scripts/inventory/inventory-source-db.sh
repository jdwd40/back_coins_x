#!/usr/bin/env bash
# inventory-source-db.sh — READ-ONLY inventory of the legacy Coins database.
# Runs inside a REPEATABLE READ read-only transaction. Selects only structural
# metadata, counts, and aggregates — no PII, no secrets, no row contents.
set -euo pipefail

if [[ -n "${COINS_SOURCE_DATABASE_URL:-}" ]]; then
  CONN=("$COINS_SOURCE_DATABASE_URL")
else
  : "${PGDATABASE:?set PGDATABASE or COINS_SOURCE_DATABASE_URL}"
  # Discrete params let psql use the unix socket / peer auth when PGHOST is unset.
  CONN=(-d "$PGDATABASE")
  [[ -n "${PGUSER:-}" ]] && CONN+=(-U "$PGUSER")
  [[ -n "${PGHOST:-}" ]] && CONN+=(-h "$PGHOST")
  [[ -n "${PGPORT:-}" ]] && CONN+=(-p "$PGPORT")
fi

psql "${CONN[@]}" -v ON_ERROR_STOP=1 -X -P pager=off <<'SQL'
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '60s';

\echo '=== server identity / time ==='
SELECT current_database() AS db, version() AS server_version,
       now() AS inventory_at_utc, current_setting('TimeZone') AS db_timezone;

\echo '=== extensions ==='
SELECT extname, extversion FROM pg_extension ORDER BY extname;

\echo '=== schemas ==='
SELECT schema_name FROM information_schema.schemata
WHERE schema_name NOT LIKE 'pg\_%' AND schema_name <> 'information_schema'
ORDER BY schema_name;

\echo '=== tables (public) ==='
SELECT table_name, table_type FROM information_schema.tables
WHERE table_schema = 'public' ORDER BY table_name;

\echo '=== row counts / sizes ==='
SELECT relname AS table,
       c.reltuples::bigint AS approx_rows,
       pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r'
ORDER BY pg_total_relation_size(c.oid) DESC;

\echo '=== exact row counts (authoritative for migration manifest) ==='
SELECT 'users' AS table, count(*) FROM users
UNION ALL SELECT 'coins', count(*) FROM coins
UNION ALL SELECT 'portfolios', count(*) FROM portfolios
UNION ALL SELECT 'transactions', count(*) FROM transactions
UNION ALL SELECT 'price_history', count(*) FROM price_history
UNION ALL SELECT 'market_history', count(*) FROM market_history
UNION ALL SELECT 'coin_statistics', count(*) FROM coin_statistics;

\echo '=== columns ==='
SELECT table_name, column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
ORDER BY table_name, ordinal_position;

\echo '=== constraints ==='
SELECT conrelid::regclass AS table, conname, contype,
       pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE connamespace = 'public'::regnamespace
ORDER BY conrelid::regclass::text, contype;

\echo '=== indexes ==='
SELECT tablename, indexname, indexdef
FROM pg_indexes WHERE schemaname = 'public' ORDER BY tablename, indexname;

\echo '=== sequences ==='
SELECT sequencename, last_value, start_value, increment_by
FROM pg_sequences WHERE schemaname = 'public' ORDER BY sequencename;

\echo '=== price_history bounds ==='
SELECT min(created_at) AS min_ts, max(created_at) AS max_ts,
       count(DISTINCT coin_id) AS distinct_coins
FROM price_history;

\echo '=== market_history bounds (timestamp w/o tz; confirm UTC convention) ==='
SELECT min(created_at) AS min_ts, max(created_at) AS max_ts FROM market_history;

\echo '=== integrity anomaly counts (no PII) ==='
SELECT
  (SELECT count(*) FROM portfolios WHERE user_id IS NULL OR coin_id IS NULL) AS portfolios_null_fk,
  (SELECT count(*) FROM portfolios p WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.user_id = p.user_id)) AS portfolios_orphan_user,
  (SELECT count(*) FROM portfolios p WHERE NOT EXISTS (SELECT 1 FROM coins c WHERE c.coin_id = p.coin_id)) AS portfolios_orphan_coin,
  (SELECT count(*) FROM portfolios WHERE quantity IS NULL OR quantity < 0) AS portfolios_bad_qty,
  (SELECT count(*) FROM transactions t WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.user_id = t.user_id)) AS tx_orphan_user,
  (SELECT count(*) FROM transactions t WHERE NOT EXISTS (SELECT 1 FROM coins c WHERE c.coin_id = t.coin_id)) AS tx_orphan_coin,
  (SELECT count(*) FROM transactions WHERE quantity IS NULL OR quantity <= 0
      OR price IS NULL OR price <= 0 OR total_amount IS NULL OR total_amount <= 0) AS tx_bad_values,
  (SELECT count(*) FROM users WHERE funds IS NULL OR funds < 0) AS users_bad_funds,
  (SELECT count(*) FROM coins WHERE current_price IS NULL OR current_price <= 0) AS coins_bad_price;

\echo '=== duplicate normalized identity counts (aggregates only) ==='
SELECT
  (SELECT count(*) FROM (SELECT lower(trim(email)) e FROM users GROUP BY 1 HAVING count(*) > 1) d) AS dup_emails,
  (SELECT count(*) FROM (SELECT lower(trim(username)) u FROM users GROUP BY 1 HAVING count(*) > 1) d) AS dup_usernames;

\echo '=== bcrypt hash presence/format (aggregate only; hashes never selected) ==='
SELECT count(*) AS users_total,
       count(*) FILTER (WHERE password_hash ~ '^\$2[aby]\$\d\d\$[./A-Za-z0-9]{53}$') AS bcrypt_format_ok
FROM users;

ROLLBACK;
SQL
