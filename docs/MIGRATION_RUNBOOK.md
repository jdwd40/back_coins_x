# MIGRATION_RUNBOOK — Coins → self-hosted Supabase

Scope: repeatable staging migrations and the *preparation* of production
migration. No production execution without John's explicit approval (plan §13
Stage C / Task 16).

## 0. Prerequisites

- Branch `migration/supabase-rebuild` (backend + frontend).
- Read-only inventories complete:
  - `scripts/inventory/inventory-source-db.sh` (legacy DB)
  - `scripts/inventory/inventory-supabase.sh` (shared Supabase; confirms the
    `coins` schema name is free, pg_cron availability, publications, roles)
- Legacy backup: custom-format `pg_dump` of the source DB, restored to an
  isolated DB and count-verified BEFORE any export is trusted.
- Export artifacts directory is encrypted/access-restricted (contains
  normalized emails; never hashes, never secrets). Never commit it.

## 1. Apply schema migrations (staging)

```bash
for f in supabase/migrations/*.sql; do
  psql "$COINS_STAGING_DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"
done
psql "$COINS_STAGING_DATABASE_URL" -f supabase/seed.sql   # non-prod fixtures only
```

Migrations create only `coins`-owned objects plus the `coins_worker` login
role. They are additive on the shared instance. Set the worker password
out-of-band:

```sql
ALTER ROLE coins_worker PASSWORD '<from password manager>';
```

## 2. Shared-instance additive config (staging first, review each)

1. PostgREST: add `coins` to exposed schemas (`PGRST_DB_SCHEMAS`), keep
   existing entries.
2. Realtime: `ALTER PUBLICATION supabase_realtime ADD TABLE coins.assets,
   coins.market_state;` (only these two).
3. Auth: add the staging `/coins/` URL to site/redirect allowlists
   additively. Do not touch Brevo SMTP or other apps' entries.
4. Take a config backup before each change (plan §13 Stage B step 1).

## 3. Identity provisioning (staging uses synthetic emails)

```bash
node scripts/migration/create-auth-users.mjs <exportdir> identity-map.json --dry-run
SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
  node scripts/migration/create-auth-users.mjs <exportdir> identity-map.json
```

- Idempotent (checkpointed map; rerun-safe). Never logs emails/keys.
- Staging MUST use synthetic/copied emails that cannot message real users.
- Check Auth email collisions first; never attach a Coins legacy account to an
  unrelated existing Auth identity without explicit adjudication.

## 4. Export → import → rollups → verify

```bash
COINS_SOURCE_DATABASE_URL=… node scripts/migration/export-legacy.mjs <exportdir>
COINS_STAGING_DATABASE_URL=… \
  node scripts/migration/import-coins.mjs <exportdir> identity-map.json
psql "$COINS_STAGING_DATABASE_URL" -f scripts/migration/build-rollups.sql
COINS_STAGING_DATABASE_URL=… \
  node scripts/migration/verify-migration.mjs <exportdir>
```

- All gates must pass (counts, exact per-user cash/quantities, tx coverage,
  price equality, history bounds, invariants, sequence).
- Discrepancy policy (plan §7.3): report, never auto-repair. Any discrepancy
  requires documented adjudication before production cutover.
- Reproducibility: reset the staging coins schema and replay end-to-end;
  results must be identical (idempotent mapping, no duplicate rows).

## 5. Worker (staging)

```bash
cd worker && npm ci
COINS_WORKER_DATABASE_URL='postgresql://coins_worker:…@…/postgres' \
  pm2 start ecosystem.config.cjs
```

- Exactly one instance. Verify: `tick_sequence` increments every 30 s,
  heartbeat fresh, no `SEQUENCE_MISMATCH`/`TICK_IN_PROGRESS` errors.
- Prove the worker role cannot read tables or other schemas (see
  worker/README.md smoke procedure).

## 6. Scheduler decision

- If `pg_cron` is available: create `coins_`-prefixed jobs calling
  `refresh_price_candles`/`refresh_market_candles` (last 2 buckets, every
  minute/hour boundary) and daily `apply_history_retention` (only after the
  archive marker). Record pg_cron as the retention owner.
- Otherwise the worker fallback invokes the same functions; record the worker
  as the single retention owner. NEVER both.
- Retention is blocked until `coins.archive_confirmed = 'on'` is set
  (database-level setting, applied by ops after archive verification).

## 7. Evidence to capture

- inventory outputs, export manifest (counts + sha256), import logs,
  verify-migration gate output, candle coverage queries, worker logs,
  RLS/isolation test output (`npm run test:supabase`).
