# CURRENT_STATE_INVENTORY — Coins backend (back_coins_x)

Baseline: branch `migration/supabase-rebuild`, plan commit `9b86745` atop `7f51612`.
Inventory refreshed 2026-08-06 (read-only; no PII, no secrets, no hash values).

This document records verifiable current state for migration planning. The
authoritative detailed analysis is `SUPABASE_MIGRATION_PLAN.md` §2; this file
captures the re-runnable evidence and points at the scripts that regenerate it.

## 1. Runtime / deployment

- Express app (`app.js`, `server.js`), PM2 on app VPS, deploy = push to `main`
  via `.github/workflows/deploy.yml` (SSH, hard reset, `npm install`, PM2 restart).
- Deployed checkout `/home/jd/back_coins_x` on app VPS at `main@7f51612`.
- Env names observed on server (values never read): `NODE_ENV`, `DATABASE_URL`
  or `PG*` variables, `JWT_SECRET`, `FRONTEND_URL`.
- CORS: `app.js` builds allowlist from `FRONTEND_URL` (`.env.production`,
  comma-separated; production = apex + www.jdwd40.com). Without it, browser
  requests 500 (rejection path previously called missing `logger.warn`).

## 2. Production data snapshot (regenerated 2026-08-06T00:37Z, read-only)

| table | rows | notes |
|---|---:|---|
| users | 20 | all 20 password hashes match bcrypt `$2[aby]$…` format (aggregate check only) |
| coins | 13 | |
| portfolios | 18 | FKs present (`user_id`, `coin_id`) |
| transactions | 39 | FKs present |
| price_history | 277,212 | `timestamptz`; span 2026-07-29 14:36:28+00 → 2026-08-06 00:37:07+00 |
| market_history | 21,324 | `timestamp without time zone`; min/max values identical to price_history span ⇒ UTC convention confirmed |
| coin_statistics | 13 | |

- Duplicate normalized emails: 0. Duplicate normalized usernames: 0.
- Extensions on source DB: `plpgsql` only. No `pg_cron`.
- Counts are a point-in-time sample; every migration run must regenerate them
  via `scripts/inventory/inventory-source-db.sh`.

Full raw output: `coins-supabase-migration/logs/source-inventory-*.txt`.

## 3. API surface (authoritative = route files)

See plan §2.2 for the full route table. Key facts re-verified in code:

- Public mutating routes exist today and must not survive migration:
  `PATCH /api/coins/:coin_id/price`, `POST /api/market/start`, `POST /api/market/stop`.
- Ownership gaps: `GET/PUT/DELETE /api/users/:user_id`, `PATCH .../funds`,
  `GET /api/transactions/:transaction_id` do not verify ownership.
- `models/transactions.model.js` issues BEGIN/COMMIT through `pool.query`
  (no single pooled client) → atomicity not guaranteed.
- Legacy `POST /api/transactions` trusts client `price_at_transaction`.

## 4. Market simulation / history

- In-memory singleton simulator (`models/market-simulator.js`), 30 s tick,
  ±0.5 % per-tick cap, 20–500 % baseline bound; state lost on restart.
- `services/rollup-service.js` exists but is never started.
- Source `price_history` spans ~7.5 days; no production rollup table.
- History ranges in current API: `10M,30M,1H,2H,24H,7D,30D,ALL` (per-coin);
  aggregate `5M..ALL` via `/api/market/price-history`.

## 5. Known integrity risks carried into migration design

- Nullable FKs and financial columns; no non-negativity checks; no
  idempotency keys; no immutable-ledger guard.
- No RLS anywhere (legacy app connects as table owner).
- Reconciliation policy (plan §7.3): import operational cash/holdings as
  opening state, import transactions as immutable history, report — never
  auto-repair — discrepancies.

## 6. How to regenerate this inventory

```bash
# Local disposable/test DB
PGDATABASE=coins_test ./scripts/inventory/inventory-source-db.sh

# Production (read-only; run from a shell with the app's env, e.g. via ssh app-vps)
# see logs/source-inventory-*.txt for the exact read-only statement set used.

# Shared Supabase instance (before applying any migration)
SUPABASE_DB_URL='postgresql://…' ./scripts/inventory/inventory-supabase.sh
```

## 7. Supabase-side inventory status

`inventory-supabase.sh` is written but has not been run against
`supabase.jdwd40.xyz` from this host — requires a read-capable DB connection
not stored locally. It must be run before applying any migration to the shared
instance (confirms `coins` schema name free, pg_cron availability, existing
publications/roles). Local disposable PostgreSQL 18 is used for all migration
development and testing until then.
