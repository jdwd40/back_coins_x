# Coins → Self-Hosted Supabase Migration Implementation Plan

> **For the K3 implementer:** execute this plan in order on the two `migration/supabase-rebuild` branches. Use tests first for security and financial operations. Do not cut over production without John’s explicit approval.

**Goal:** Rebuild Coins on the existing self-hosted Supabase at `supabase.jdwd40.xyz`, preserving Coins production accounts and financial state while keeping the current Express deployment available as rollback until verified parity.

**Architecture:** The browser uses Supabase Auth, read-only PostgREST queries, narrowly granted PostgreSQL RPCs, and selected Realtime publications. PostgreSQL owns all financial invariants and price-history aggregation. A small PM2-managed worker remains for the 30-second, stateful market simulation and invokes one database-owned system function; `pg_cron`, if confirmed available on the Supabase host, performs deterministic aggregation and retention jobs.

**Tech stack:** self-hosted Supabase PostgreSQL/Auth/PostgREST/Realtime, versioned SQL migrations, PL/pgSQL RPCs and RLS, TypeScript/Node worker, React/Vite/TypeScript, `@supabase/supabase-js`, Chart.js 4.

---

## 0. Non-negotiable guardrails

- Work only on `migration/supabase-rebuild` in `/home/jd/work/back_coins_x` and `/home/jd/work/fcoins_y`. Never push or merge `main`/`master`; those branches auto-deploy.
- Do not reinstall Supabase, replace its volumes, alter SSH/UFW/users/sudo, or expose any secret.
- Treat `supabase.jdwd40.xyz` as a shared existing service. Inventory existing schemas, Auth users, PostgREST exposed schemas, Realtime publications, extensions, cron jobs, and redirect/CORS configuration before applying Coins migrations. Create only Coins-owned objects.
- Use a dedicated PostgreSQL schema named `coins`. Do not reuse or import unrelated Supabase player/game data. Expose `coins` through PostgREST only after confirming this additive shared configuration change is safe. The frontend must use `supabase.schema('coins')` or a typed schema-scoped client.
- Never place the service-role key in Vite variables, browser code, logs, SQL, fixtures, or committed files. The anon/publishable key is intentionally public but must still be supplied by environment configuration rather than hard-coded.
- Never give the project-wide service-role key to the long-running market worker: compromise would bypass RLS for every application on the shared Supabase project. Create a dedicated least-privilege PostgreSQL login role that has only database connect, `coins` schema usage, and execute on the exact worker functions; it receives no direct table privileges.
- Preserve the live Express API and its database unchanged through staging. No production cutover is part of this implementation run.
- Treat all trade calculations, prices, balances, holdings, ownership, and idempotency as server-owned. Browser totals are previews only.
- Every migration is versioned, additive where practical, rerunnable only where explicitly designed, and tested against a disposable/staging database before any production use.

## 1. Executive summary

The existing application is a React/Vite SPA talking to a Node/Express API backed by a separate PostgreSQL database. Public market data is polled every two seconds; authentication uses a custom 24-hour JWT stored with a user object in `localStorage`; buy/sell operations update `users.funds`, `transactions`, and `portfolios`; and an in-process singleton updates every coin and inserts raw history every 30 seconds. Production currently contains real Coins state that must be preserved: a read-only inventory at 2026-08-06 00:05 UTC found 20 users, 13 coins, 18 portfolio rows, 39 transactions, 276,380 price-history rows, and 21,260 market-history rows.

The migration will use:

- **Supabase Auth** for sessions and password-reset flows.
- **A dedicated `coins` schema** for product isolation on the shared self-hosted Supabase.
- **RLS** for all browser-accessible tables.
- **`SECURITY DEFINER` RPCs** for atomic buy/sell and other privileged state transitions.
- **Realtime** for current coin prices and market status, with ordinary queries as the initial snapshot and recovery path.
- **A minimal external worker** for stateful 30-second simulation. Edge Functions are not a reliable fit for a long-lived scheduler.
- **`pg_cron` when available** for deterministic OHLC finalisation, retention, and health checks; otherwise the same idempotent SQL jobs are called by the worker scheduler.
- **Chart.js retained**, because it is already integrated, recently rebuilt, small enough for the bounded series, and cheaper to maintain than introducing another chart stack. Misleading line smoothing will be removed.

The current Express app remains the rollback system. Production migration is a later, approved maintenance-window operation: freeze old writes, take and verify a final backup/export, import into Supabase, reconcile, switch frontend configuration, and retain a defined reverse-delta path before permitting new trades.

## 2. Current-state architecture (evidence-based)

### 2.1 Backend runtime and deployment

- `app.js` configures Express JSON parsing and CORS, mounts `/api/coins`, `/api/users`, `/api/transactions`, and `/api/market`, and starts the market simulator whenever `NODE_ENV=production`.
- CORS allows local development origins and adds the production origin from `FRONTEND_URL` (`app.js:14-52`).
- `server.js` requires a nonblank `JWT_SECRET` in production, tests PostgreSQL with `SELECT NOW()`, and listens on `PORT` or 3000.
- `db/connection.js` loads `.env.<NODE_ENV>` and accepts either `DATABASE_URL` or `PGDATABASE`, `PGUSER`, `PGPASSWORD`, `PGHOST`, and `PGPORT`.
- Production deploy is push-triggered on backend `main`; GitHub Actions SSHes to the app VPS, hard-resets `/home/jd/back_coins_x` to `origin/main`, runs `npm install`, and restarts PM2 (`.github/workflows/deploy.yml`).
- Read-only deployed inspection found `/home/jd/back_coins_x` on `main` at `7f51612`, with environment names `NODE_ENV`, PostgreSQL variables, `JWT_SECRET`, and `FRONTEND_URL`. Secret values were not read or recorded.
- `package.json` uses Express, `pg`, bcrypt, JWT, Jest/Supertest, and Node scripts for destructive seeding and history clearing.

### 2.2 Backend API inventory

The route files are authoritative; several Markdown documents are stale and use paths or response fields that no longer match code.

| Current route | Auth in code | Current behavior / migration disposition |
|---|---:|---|
| `GET /api/coins` | Public | Returns `{coins}`; values such as `current_price` and `market_cap` are formatted GBP strings. Replace with public RLS read/view returning numeric values; format only in UI. |
| `GET /api/coins/:coin_id` | Public | Returns `{coin}` and calculates 24-hour change from history. Replace with public coin detail query/view. |
| `PATCH /api/coins/:coin_id/price` | **Public** | Accepts number/GBP string; updates coin and raw history atomically. Remove from browser surface. Replace with service-only `record_price_tick`/market tick function. |
| `GET /api/coins/:coin_id/price-history?range=` | Public | Supports `10M`, `30M`, `1H`, `2H`, `24H`, `7D`, `30D`, `ALL`; returns bounded numeric OHLC-like points produced at query time. Replace with public `get_price_history` RPC. |
| `POST /api/users/register` | Public | Inserts bcrypt user with £1,000; does not return a token. Replace with `supabase.auth.signUp`. |
| `POST /api/users/login` | Public | Returns custom 24-hour JWT and user record. Replace with `signInWithPassword` and Supabase session refresh. |
| `GET /api/users/:user_id` | Bearer JWT | Returns arbitrary ID; controller does not compare path ID to authenticated user. Replace with own `profiles`/`wallets` reads under RLS. |
| `PUT /api/users/:user_id` | Bearer JWT | Can update username, email, password for arbitrary ID because ownership is not checked. Replace username update under RLS and Auth email/password APIs. |
| `DELETE /api/users/:user_id` | Bearer JWT | Can delete arbitrary ID because ownership is not checked. Do not expose initially; implement soft account-disable/admin workflow later. |
| `PATCH /api/users/:user_id/funds` | Bearer JWT | Adds arbitrary positive/negative amounts; ownership is not checked and check/update is race-prone. Remove completely from browser API. Only trade RPCs or explicit service-role admin adjustments may change cash. |
| `POST /api/transactions` | JWT + body ID check | Legacy client-priced transaction insertion; does not reliably update cash/holdings. Remove; never port this insecure contract. |
| `POST /api/transactions/buy` | JWT + body ID check | Uses server-selected current price and attempts cash/transaction/portfolio updates. Replace with `buy_coin` RPC using `auth.uid()` rather than a client user ID. |
| `POST /api/transactions/sell` | JWT + body ID check | Uses server-selected current price and attempts cash/transaction/portfolio updates. Replace with `sell_coin` RPC. |
| `GET /api/transactions/user/:user_id` | JWT + path ID check | Returns own transaction history. Replace direct/view read under RLS. |
| `GET /api/transactions/:transaction_id` | JWT only | Does not check transaction ownership. Replace direct row read under RLS. |
| `GET /api/transactions/portfolio/:user_id` | JWT + path ID check | Returns holdings derived from transactions plus user funds; frontend normalizes it. Replace `portfolio_view` plus wallet read under RLS. |
| `GET /api/market/status` | Public | Returns in-memory singleton status, cycle countdown, and events. Replace public `market_status_view` backed by persistent DB state. |
| `GET /api/market/stats` | Public | Returns aggregate values from `coins` and `market_history` plus in-memory status. Replace public stats RPC/view. |
| `GET /api/market/history` | Public | Controller references `coins.model.getMarketHistory`, which is not exported on the inspected branch. Retire or implement only if a real frontend dependency remains. |
| `GET /api/market/price-history` | Public | Returns raw aggregate history for frontend chart, with permissive/invalid range handling. Replace bounded `get_market_history` RPC. |
| `POST /api/market/start` | **Public** | Starts singleton. Replace with service-role/admin-only worker control. |
| `POST /api/market/stop` | **Public** | Stops singleton. Replace with service-role/admin-only worker control. |

### 2.3 Financial behavior and known integrity gaps

- New users receive `funds = 1000.00` (`models/users.model.js`).
- The intended buy/sell path gets the raw numeric current coin price and updates cash, a transaction row, and a portfolio row.
- `models/transactions.model.js` issues `BEGIN`, subsequent statements, and `COMMIT` through `db.query`, which delegates each call to `pool.query`. Unlike `coins.model.updateCoinPrice`, it does **not** acquire one pooled client. Atomicity is therefore not guaranteed across connections.
- The legacy `POST /transactions` accepts `price_at_transaction` from the browser and does not update cash/portfolio consistently.
- Current schema permits nullable foreign keys and non-positive financial values in several tables. It has no cash/quantity check constraints, no immutable-ledger guard, and no idempotency key.
- Current ownership checks are inconsistent, as detailed above. These are migration requirements, not behavior to preserve.

### 2.4 Market simulation, jobs, and history

- `models/market-simulator.js` is an in-memory singleton. It assigns per-process volatility, trends, cycles, and coin events; uses a 30-second interval; and bounds each update to ±0.5% and prices to 20%-500% of an in-memory initial price.
- Each tick acquires a single DB client, locks all coin rows, updates all prices, inserts one `price_history` row per coin, and inserts one `market_history` row. This tick is transaction-safe, but its state and timers disappear on restart and multiple app processes could run duplicate simulators.
- `app.js` starts the simulator automatically in every production process. Public start/stop routes also mutate it.
- `services/rollup-service.js` contains 1m/5m/15m/1h rollup and cleanup intervals but is never started by `app.js` or `server.js`. Its cleanup deletes rollups older than 24 hours, conflicting with long-range chart needs.
- Historical migrations conflict: one uses `recorded_at` with 24-hour cleanup, later migrations rename to `created_at` and specify seven-day cleanup, and rollup migrations use different database names. `001_create_tables.sql` is empty; `db/seed.js`, not the migration chain, is the clearest executable schema definition.
- Current price-history API does query-time OHLC bucketing and caps normal ranges, but `ALL` can reject data once adaptive buckets exceed the global 200-point budget.
- The production PostgreSQL instance has only `plpgsql`, no `pg_cron`, and no production rollup table. A cleanup function may exist but is not scheduled. Production raw history currently spans slightly more than seven days.

### 2.5 Current production schema and data snapshot

Read-only inspection of the existing Coins production DB on the app VPS (no values containing PII or secrets were selected) found:

| Table | Rows at snapshot | Preserve? | Notes |
|---|---:|---:|---|
| `users` | 20 | Yes | Preserve ID mapping, username, email, exact cash, timestamps. Do not copy legacy password hashes into product tables. |
| `coins` | 13 | Yes | Preserve IDs, metadata, exact current prices, supply, market cap, and timestamps. |
| `portfolios` | 18 | Yes | Preserve operational holdings after reconciliation; nullable FKs/quantities require validation. |
| `transactions` | 39 | Yes | Preserve immutable history exactly, plus legacy IDs. Reconcile against holdings/cash; do not invent repairs. |
| `price_history` | 276,380 | Yes, staged | UTC-aware rows from 2026-07-29 14:36:28 UTC through 2026-08-06 00:05:07 UTC at snapshot. Import all to staging, create rollups, verify, then apply retention only after archival. |
| `market_history` | 21,260 | Yes, staged | Timestamp-without-time-zone source; interpret using documented source timezone (expected UTC) and prove conversion on staging. |
| `coin_statistics` | present | Yes if populated | Preserve ATH/ATL and dates, while validating against imported price history. |
| `price_history_rollups` | absent | N/A | Build from imported raw history. |

Production constraints include unique usernames/emails/symbols and portfolio `(user_id, coin_id)`, but most FKs and timestamps are nullable; financial non-negativity constraints are absent. Exact counts are a point-in-time planning sample and must be regenerated during each migration run.

### 2.6 Frontend architecture and real API dependencies

- React 18/Vite/TypeScript is deployed at `/coins/` with `BrowserRouter basename="/coins"`.
- Frontend `master` auto-deploys through GitHub Actions after UI contract, TypeScript, and Vite build checks, then rsyncs `dist/` to `/var/www/jdwd40.com/html/coins/`.
- API URLs are hard-coded to `https://jdwd40.com/api-2/api` in `App.tsx`, `AuthContext.tsx`, `transactionService.ts`, `PriceChart.tsx`, and `MarketValueChart.tsx`.
- `App.tsx` polls coins, market stats, and market status every two seconds; coin detail uses the same generic polling hook. A separate 30-second trigger refreshes charts.
- `AuthContext.tsx` stores custom JWT and a user object in `localStorage`, manually decodes expiry and several possible ID claims, and has dangerous fallbacks that manufacture user ID 1/default user data. Registration performs a second login request.
- `transactionService.ts` calls buy, sell, portfolio, and user-transaction routes. It sends `user_id` from the browser and normalizes legacy string fields.
- `Profile.tsx` fetches portfolio and transactions, then copies server cash into the locally stored user object.
- `BuyForm.tsx` and `SellForm.tsx` calculate preview totals client-side and optimistically derive balances when the API response lacks `new_balance`.
- `PriceChart.tsx` consumes the current OHLC response for `24H`, `7D`, `30D`, and `ALL`; `MarketValueChart.tsx` consumes `/market/price-history` for `5M` through `ALL`.
- There are duplicate/inconsistent type definitions in `src/types.ts` and `src/types/index.ts`.
- No `VITE_*` runtime environment variables are currently declared or used.

### 2.7 Existing tests and documentation

- Backend Jest/Supertest coverage exercises registration/login/token reuse, basic protected routes, coin reads and public price patching, legacy transaction reads/writes, funds changes, simulator price/history writes, market status/stats, seven-day cleanup/index assumptions, and the current price-history range/point contract.
- The current tests do not prove RLS (none exists), buy/sell atomicity across one pooled connection, idempotency, concurrent overspend/oversell, cross-user safety for every user/transaction endpoint, scheduler restart leadership, migration replay, or long-term retention coverage. Some tests preserve insecure endpoints (public price patch, arbitrary funds route, client-priced legacy transactions) and must be replaced rather than carried forward.
- Frontend `npm run test:ui` is a source-text contract (`scripts/ui-contract.mjs`), while `priceSummary.test.ts` uses `node:test` but is not exposed by a package script. The deploy workflow runs the UI contract, `tsc --noEmit`, and Vite build; there are no component/Auth/data-service integration tests.
- Planning baseline on 2026-08-06: `npm run test:ui` passed and ESLint exited 0 with five warnings, but the meaningful app check `npx tsc -p tsconfig.app.json --noEmit` failed across chart option types, duplicate/shadowed app types, Auth/transaction exports, profile props, and Node test typings. The workflow's root `tsc --noEmit` invocation does not expose these failures and must be replaced with an explicit project/build-mode check.
- `package-lock.json` lists `lightweight-charts` while `package.json` does not. Regenerate the lockfile from the intentional Chart.js-only manifest during implementation instead of carrying dependency drift.
- The tracked frontend file `github-actions-key` was safely signature-checked without printing contents and is confirmed to contain private-key material with mode `0664`. This is an existing critical secret-management finding: do not read, copy, use, commit anew, or expose it. Removal from Git history and credential rotation require John's explicit approval and must be completed before any production deployment from the migrated branch.
- Backend and frontend Markdown API/schema guides frequently disagree with route files and runtime responses (for example `/history` versus `/price-history`, numeric versus formatted GBP values, simulator cadence, stats shape, and portfolio fields). Implementation must generate one current API/RPC contract and mark or remove stale documents only after parity tests.

## 3. Target architecture and Supabase capability decisions

### 3.1 Component map

```text
Browser at /coins/
  ├─ Supabase Auth (sessions, refresh, recovery)
  ├─ PostgREST reads in schema coins (RLS)
  ├─ RPC: buy_coin, sell_coin, chart/history queries (RLS + grants)
  └─ Realtime: coins.current_price + market_state (display freshness only)

Self-hosted Supabase PostgreSQL
  ├─ auth.users (managed by GoTrue)
  ├─ coins.profiles / wallets / holdings / trades
  ├─ coins.assets / price_ticks / price_candles
  ├─ coins.market_state / asset_simulation_state / market_snapshots
  ├─ RLS, constraints, triggers, RPCs, views
  └─ pg_cron jobs if extension is available

Minimal market worker (TypeScript/Node, PM2, app VPS or staging host)
  ├─ restricted `coins_worker` PostgreSQL login (no service-role key)
  ├─ leader/advisory-lock protected 30-second DB function call
  ├─ heartbeat/structured logs/retry with backoff
  └─ fallback invocation of aggregation/retention jobs if pg_cron unavailable
```

### 3.2 Capability decisions

| Capability | Decision |
|---|---|
| Supabase PostgreSQL | Primary application/state/ledger/history store in dedicated `coins` schema. |
| Supabase Auth | Replace custom bcrypt/JWT login and all manual token parsing. |
| RLS | Mandatory on every browser-exposed table/view; deny-by-default. |
| DB functions / RPC | Mandatory for atomic buy/sell, bounded history queries, market ticks, and admin adjustments. |
| Realtime | Use for public current prices and persistent market status/events; not as proof a trade committed. Refetch RPC result/portfolio after trades. |
| Edge Functions | Do not use for the simulator. No Edge Function is required for ordinary trading. Consider one only for a future privileged admin workflow or supported password-migration bridge. |
| Triggers | `updated_at`, immutable trade protection, and narrowly scoped audit helpers. Do **not** install an unconditional `auth.users` trigger on the shared Supabase project; bootstrap Coins accounts explicitly so unrelated app signups are untouched. |
| `pg_cron` | Use for idempotent aggregation/retention if available on the Supabase PostgreSQL. Confirm extension and configuration in staging; do not assume parity with the old DB. |
| External worker | Retain one small worker for the stateful 30-second simulator. It calls a DB function; it never computes authoritative writes in disconnected browser code. |

## 4. Schema design

All identifiers below live in `coins`; migrations must explicitly set ownership, grants, comments, RLS, and `search_path`.

### 4.1 Types

- `trade_side AS ENUM ('BUY','SELL')`
- `market_cycle AS ENUM ('STRONG_BOOM','MILD_BOOM','STRONG_BUST','MILD_BUST','STABLE')`
- `candle_interval AS ENUM ('15m','1h','6h','1d')`
- `market_candle_interval AS ENUM ('1m','15m','1h','1d')`
- Prefer integer minor units for fixed two-decimal cash **or** `numeric` consistently. For least migration risk, use `numeric(20,2)` for GBP cash/totals with checks, and `numeric(30,12)` for asset quantity. Never use floating point for financial state.
- Define reusable finite bounded domains/checks: reject numeric text values `NaN`, `Infinity`, and `-Infinity`; enforce cash/order totals `0..1e15`, quantity `0..1e18`, and price `0..1e12` (positive where required). Confirm these product ceilings against source maxima during inventory before freezing migrations.

### 4.2 Identity and financial tables

**`profiles`**

- `id uuid PRIMARY KEY REFERENCES auth.users(id)`
- `legacy_user_id bigint UNIQUE`
- `username text NOT NULL` with normalized/case-insensitive uniqueness (`lower(username)` index)
- `legacy_email text` only if operationally needed; canonical email remains in Auth
- `created_at timestamptz NOT NULL`, `updated_at timestamptz NOT NULL`, `disabled_at timestamptz`
- No password hash.

**`wallets`**

- `user_id uuid PRIMARY KEY REFERENCES profiles(id) ON DELETE RESTRICT`
- `cash_balance numeric(20,2) NOT NULL DEFAULT 1000.00 CHECK (cash_balance >= 0)`
- `version bigint NOT NULL DEFAULT 0`
- timestamps
- No client `INSERT`, `UPDATE`, or `DELETE` grants.

**`assets`** (the existing “coins” domain)

- `id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY`; import existing `coin_id` values explicitly and reset sequence.
- `legacy_coin_id bigint UNIQUE NOT NULL`
- `name varchar(50) NOT NULL`, `symbol varchar(10) NOT NULL`, unique index on `upper(symbol)`
- `current_price numeric(24,8) NOT NULL CHECK (current_price > 0)`
- `market_cap numeric(30,2) NOT NULL CHECK (market_cap >= 0)`
- `circulating_supply numeric(30,8) NOT NULL CHECK (circulating_supply >= 0)`
- `price_change_24h numeric(12,6)`, `founder text`, `listed_at timestamptz NOT NULL`, timestamps
- Public read; service-only writes.

**`holdings`**

- `user_id uuid REFERENCES profiles(id) ON DELETE RESTRICT`
- `asset_id bigint REFERENCES assets(id) ON DELETE RESTRICT`
- `quantity numeric(30,12) NOT NULL CHECK (quantity >= 0)`
- `cost_basis numeric(30,2) NOT NULL DEFAULT 0 CHECK (cost_basis >= 0)`
- timestamps; `PRIMARY KEY (user_id, asset_id)`
- No direct client writes.

**`trades`**

- `id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY`
- `legacy_transaction_id bigint UNIQUE`
- `user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT`
- `asset_id bigint NOT NULL REFERENCES assets(id) ON DELETE RESTRICT`
- `side trade_side NOT NULL`
- `quantity numeric(30,12) NOT NULL CHECK (quantity > 0)`
- `unit_price numeric(24,8) NOT NULL CHECK (unit_price > 0)`
- `total_amount numeric(30,2) NOT NULL CHECK (total_amount > 0)`
- `idempotency_key uuid`, unique `(user_id, idempotency_key)` when non-null
- `cash_balance_after numeric(20,2)`, `holding_quantity_after numeric(30,12)` for auditable results
- `executed_at timestamptz NOT NULL DEFAULT now()`, `source text NOT NULL DEFAULT 'supabase_rpc'`
- Append-only trigger rejects update/delete outside a tightly controlled migration/admin context.
- Index `(user_id, executed_at DESC, id DESC)` and `(asset_id, executed_at DESC)`.

**`balance_adjustments`**

- Optional but recommended replacement for the unsafe funds route: immutable service-only records with user, amount, before/after, reason, actor, idempotency key, timestamp. All adjustments happen through one service-only RPC.

**`legacy_identity_map`**

- `legacy_user_id bigint PRIMARY KEY`, `auth_user_id uuid UNIQUE NOT NULL`, migration batch, status, timestamps.
- Service-only; no browser grants. It makes repeated staging/prod imports deterministic.

### 4.3 Market and history tables

**`market_state`**

- Singleton row with `id boolean PRIMARY KEY DEFAULT true CHECK (id)`, `is_running`, current cycle, cycle start/end, tick sequence, last tick, worker heartbeat, worker instance ID, timestamps.
- Public read through a view; service-only mutation.

**`asset_simulation_state`**

- One row per asset: baseline price, volatility, trend direction/strength/start/end, active event type/multiplier/start/end, deterministic/random seed state as needed, timestamps.
- Persists all state currently lost on restart.

**`price_ticks`**

- `id bigint GENERATED ... PRIMARY KEY`, `asset_id NOT NULL`, `price numeric(24,8) CHECK (price > 0)`, `captured_at timestamptz NOT NULL`, `tick_sequence bigint NOT NULL`, `source text`.
- Unique `(asset_id, tick_sequence)`; index `(asset_id, captured_at DESC) INCLUDE (price)` and BRIN on `captured_at` after volume justifies it.
- Worker/function writes only; public direct reads are unnecessary.

**`price_candles`**

- `asset_id`, `interval candle_interval`, `bucket_start timestamptz`, `open/high/low/close numeric(24,8)`, `sample_count integer CHECK (>0)`, `is_complete boolean`, `updated_at`.
- `PRIMARY KEY (asset_id, interval, bucket_start)`.
- Checks: all OHLC > 0, `high >= greatest(open, close, low)`, `low <= least(open, close, high)`.
- Index `(asset_id, interval, bucket_start DESC)`.

**`market_snapshots`**

- `id`, `tick_sequence UNIQUE`, `total_value numeric(30,8)`, cycle, `captured_at timestamptz`.
- Preserve current semantic for parity: existing code sums current asset prices, not market caps. Label this an aggregate quote index in docs; changing to `sum(price * supply)` is a separate product decision.
- Index `(captured_at DESC)` and retain the tick sequence uniqueness needed for retry safety.

**`market_candles`**

- `interval market_candle_interval`, `bucket_start timestamptz`, OHLC `numeric(30,8)`, `sample_count`, completion flag, and timestamp.
- `PRIMARY KEY (interval, bucket_start)`; index `(interval, bucket_start DESC)`.
- Aggregate from `market_snapshots` with the same deterministic `(captured_at,id)` open/close order and late-data upsert rules as asset candles.

**`coin_statistics`**

- Either retain a one-row-per-asset table for imported ATH/ATL or expose values computed from durable candles. If retained: asset PK/FK, ATH/ATL price/date with checks. Treat price history as authoritative after cutover.

### 4.4 Views

- `public_assets`: numeric market fields and derived 24-hour change.
- `my_portfolio`: joins `holdings`, `assets`, and wallet-safe fields, computes current value and P/L; predicate anchored to `auth.uid()`.
- `my_trades`: stable frontend column names and descending order.
- `market_status_view`: persistent status, cycle countdown derived from timestamps, and active event JSON/list without exposing worker metadata.
- Views must use `security_invoker = true` where supported, or equivalent safe ownership/grants. Never use an owner-bypassing view accidentally.

## 5. Security and RLS model

### 5.1 Grants and policies

- Revoke default `CREATE` on the schema from public roles. Revoke all table/function privileges, then grant only the listed operations.
- `anon` and `authenticated`: `SELECT` public asset, candle/history, market status, and market snapshot surfaces.
- `authenticated`: select own profile, wallet, holdings, and trades using `auth.uid() = user_id`; update only safe profile fields. Do not allow users to change profile IDs, legacy IDs, cash, holdings, prices, or trade rows.
- `coins_worker`: a dedicated `NOINHERIT LOGIN` PostgreSQL role with only database connect, `USAGE` on `coins`, and `EXECUTE` on `run_market_tick` plus explicitly selected scheduler/heartbeat functions. It has no table DML grants; definer functions own and validate writes.
- `service_role`: reserve for short-lived, tightly controlled migration and Auth administration scripts. It bypasses RLS across the shared project and is not a worker/runtime credential.
- Do not create policies of the form `USING (true)` on financial tables.

### 5.2 Function hardening

Every `SECURITY DEFINER` function must:

1. Set a fixed safe search path, e.g. `SET search_path = coins, pg_temp`.
2. Schema-qualify referenced objects anyway.
3. Validate `auth.uid()` for user calls; never accept an authoritative `user_id` argument.
4. Validate finite positive quantity and enforce sensible maximum/order precision.
5. Revoke execute from `PUBLIC`; grant only to `authenticated`, the dedicated `coins_worker`, or tightly controlled migration administration as appropriate.
6. Return a typed, documented result/error contract.
7. Avoid dynamic SQL unless identifiers are fixed and quoted.
8. Emit structured audit information without tokens, credentials, or PII.

### 5.3 Current vulnerabilities that must not survive

- Arbitrary authenticated profile/password/email/delete/funds operations by path ID.
- Public coin-price mutation and public market start/stop.
- Client-supplied transaction prices.
- Cross-user transaction-by-ID reads.
- Manufactured frontend user ID 1/default user fallbacks.
- Direct browser updates to wallets, holdings, trades, market state, ticks, or candles.

### 5.4 CORS and browser-origin equivalent

The current Express `FRONTEND_URL` allowlist disappears when the SPA talks directly to Supabase. Before staging:

- Add staging and production `/coins/` URLs to Supabase Auth site/redirect allowlists without removing existing applications’ entries.
- Verify the existing Kong/PostgREST CORS configuration permits only required origins where configurable. Treat CORS as browser hygiene, not authorization; anon keys plus RLS remain the security boundary.
- Do not replace shared Supabase URL/SMTP settings. Preserve existing Brevo Auth SMTP.

## 6. Auth migration and identity mapping

### 6.1 New accounts

- `supabase.auth.signUp({email,password, options:{data:{username, product:'coins'}}})` creates the Auth user; the metadata is a UI hint, not an authorization boundary.
- On the first authenticated Coins session, the frontend calls an idempotent `coins.bootstrap_account(username)` RPC that inserts only that caller’s `profiles` and `wallets` rows with £1,000. This avoids a global Auth trigger creating Coins data for unrelated applications sharing the project.
- Username uniqueness is enforced in `profiles`; if Auth creation succeeds but username conflicts, surface a deterministic recovery/admin path rather than manufacturing a user. The bootstrap RPC uses `auth.uid()` and cannot bootstrap a different identity.
- Use Supabase session persistence and `onAuthStateChange`; do not manually parse JWTs or store a parallel user object as authority.
- Email and password changes use Supabase Auth APIs. Profile username updates use RLS.

### 6.2 Existing 20 accounts

Existing passwords are available only as bcrypt hashes. Do **not** assume a supported Auth import accepts those hashes and do not write directly to `auth.users.encrypted_password` without an explicitly documented, tested version-specific procedure.

Preferred solo-maintainable migration:

1. Export legacy IDs, usernames, normalized emails, cash, and timestamps to an encrypted, access-restricted migration artifact. Count and validate bcrypt hash presence/format **in place** and record only aggregate results. Do not export hashes unless the optional reviewed legacy-password bridge is explicitly selected; never import them into product tables or commits.
2. In staging, use synthetic/copied emails that cannot message real users.
3. Inventory Auth email collisions first. Never attach a Coins legacy account to an existing unrelated Auth identity merely because the email matches; require explicit ownership verification/adjudication. For non-conflicting users, create Auth users through the supported Admin API with strong random unusable passwords, then persist the **returned** Auth UUID in `legacy_identity_map`. The script is idempotent by validated email plus mapping, not by assuming the Admin API accepts a caller-selected UUID.
4. Insert/upsert the mapped profile/wallet with the exact legacy username, timestamps, and cash.
5. At approved cutover, send password-recovery links through the existing configured Auth SMTP. Users set a new password; their balances/holdings/history are already linked by UUID.
6. Record migration status (`created`, `reset_sent`, `activated`) without storing reset tokens.

A one-time “verify legacy bcrypt then set Supabase password” bridge is optional only after security review; it expands attack surface and is unnecessary for 20 users. Password reset is the default plan.

### 6.3 Account deletion

Do not reproduce hard delete/cascade. Initially support logout and profile disable only. A future admin-reviewed deletion function must preserve the immutable financial ledger or anonymize it according to an explicit retention policy.

## 7. Data migration strategy

### 7.1 Artifacts (backend repo)

Create:

- `scripts/migration/export-legacy.mjs` — repeatable `COPY`/streamed export with manifest; source read-only transaction/snapshot.
- `scripts/migration/create-auth-users.mjs` — supported Admin API, deterministic mapping, dry-run, no secret logging.
- `scripts/migration/import-coins.mjs` — ordered, idempotent staging import using service role/direct DB server-side connection.
- `scripts/migration/build-rollups.sql` — backfill candles before retention.
- `scripts/migration/verify-migration.mjs` — counts, checksums/aggregates, invariants, sampled row equality, chart coverage.
- `scripts/migration/export-supabase-delta.mjs` and `restore-legacy-delta.mjs` — prepared rollback path for post-cutover trades; dry-run only until approved.
- `.env.example` containing names/placeholders only.
- `docs/MIGRATION_RUNBOOK.md`, `docs/CUTOVER_RUNBOOK.md`, `docs/ROLLBACK_RUNBOOK.md`.

### 7.2 Backup → staging copy → transform → verify

1. **Inventory:** regenerate schemas, extensions, constraints, indexes, counts, timestamp bounds, sizes, nulls, duplicate emails/usernames, invalid quantities/prices, orphan FKs, and sequence values. Record no PII in reports.
2. **Backup:** take a consistent custom-format `pg_dump` of the Coins source DB plus schema-only and checksummed export manifest. Restore it to an isolated staging database and prove the restore opens and counts match. Do not call a backup verified until restore succeeds.
3. **Source snapshot:** export under `REPEATABLE READ`/database snapshot. Include source DB identifier, UTC start/end, table counts, min/max IDs/timestamps, and SHA-256 checksums of export files.
4. **Transform identities:** create Auth users, fill `legacy_identity_map`, then transform integer user FKs to mapped UUIDs.
5. **Import static/state tables:** assets, profiles/wallets, holdings, trades, statistics, price ticks, and market snapshots. Preserve legacy IDs in dedicated columns.
6. **Timestamp conversion:** treat old `timestamp without time zone` fields as UTC only after checking production process/database timezone. Convert explicitly with `AT TIME ZONE 'UTC'`; test DST-edge values.
7. **Reconcile:** compare exact cash per user, holdings per user/asset, transaction totals/counts, asset current prices, history bounds, and aggregate history.
8. **Backfill candles:** build all intervals from imported raw ticks, compare OHLC against independent verification queries, then test every chart range.
9. **No pruning yet:** archive and verify raw history before any retention call. Retention begins only after candles cover all imported time and rollback artifacts are retained.
10. **Staging replay:** run a second import against a freshly reset Coins staging schema and prove identical results/idempotent mapping.

### 7.3 Reconciliation policy

The old app contains paths that can make ledger, cash, and portfolio disagree. Do not “fix” production automatically.

- Import `users.funds` as the operational cash opening balance.
- Import `portfolios.quantity`/cost basis as the operational holdings opening balance.
- Import all `transactions` as legacy immutable history.
- Independently derive holdings and cash effects from transactions and produce a discrepancy report per user/asset, without PII in shared output.
- Check for portfolios without users/assets, transactions without users/assets, negative/null values, duplicate normalized emails/usernames, and totals inconsistent with quantity × price beyond the two-decimal rounding rule.
- Any discrepancy requires an explicit documented adjudication before production cutover; staging may retain both imported opening state and discrepancy metadata.

### 7.4 Verification gates

- Source and target row counts with explained differences (Auth/profile bootstrap rows, candle derivations).
- Exact per-user cash equality and per-user/per-asset quantity equality.
- Exact legacy transaction ID coverage; sums by user/side/asset.
- Asset metadata/current-price equality.
- Raw history count, min/max timestamp, per-asset count and price range equality.
- Candle OHLC/sample counts independently recalculated for sampled and boundary buckets.
- No orphan FK, negative balance/holding, duplicate mapping, or missing Auth identity.
- Sequence values above imported maximum IDs.
- Migration rerun produces no duplicate Auth users, trades, ticks, or mappings.

## 8. Backend/RPC/function design

### 8.1 `buy_coin(p_asset_id bigint, p_quantity numeric, p_idempotency_key uuid)`

Within one PostgreSQL transaction/function:

1. Require `auth.uid()` and validate quantity/scale/max.
2. Acquire locks in a fixed order: the wallet row first (serialising all trades for one user), then asset. For a missing holding, while the wallet lock is held, `INSERT ... ON CONFLICT DO NOTHING` a zero row and then `SELECT ... FOR UPDATE`; never assume `FOR UPDATE` locks a nonexistent row.
3. If `(user,idempotency_key)` exists, compare stored side, asset, quantity, and all request semantics. Return the original result only for an exact retry; otherwise return `IDEMPOTENCY_CONFLICT`.
4. Select `assets.current_price` inside the function; reject missing/halted asset.
5. Calculate rounded total using one documented GBP rule (`round(quantity * price, 2)`).
6. Atomically debit with `UPDATE ... SET cash_balance = cash_balance - total WHERE ... AND cash_balance >= total RETURNING ...`; zero rows means insufficient funds.
7. Upsert holding quantity and cost basis. Define weighted-average/cost-basis behavior and test it; do not infer from browser data.
8. Insert immutable trade with price, total, and post-state.
9. Return trade ID, server unit price, quantity, total, cash balance after, and holding after.

### 8.2 `sell_coin(...)`

Same exact idempotency comparison and lock order, including safe creation/locking of a previously absent holding:

1. Use `auth.uid()`, idempotency, server price.
2. Lock holding; atomic conditional decrement `quantity >= requested`.
3. Credit rounded proceeds to wallet.
4. Reduce cost basis proportionally or by the chosen average-cost rule; prevent negative residuals and normalize tiny exact-zero residuals.
5. Insert immutable trade and return authoritative post-state.

### 8.3 Error contract

Use stable SQLSTATE or a typed JSON result mapped by the frontend:

- `INVALID_QUANTITY`
- `ASSET_NOT_FOUND`
- `MARKET_HALTED`
- `INSUFFICIENT_FUNDS`
- `INSUFFICIENT_HOLDINGS`
- `IDEMPOTENCY_CONFLICT`
- unexpected errors logged server-side as correlation IDs, not raw DB internals.

### 8.4 Other functions

- `get_price_history(asset_id, range)` — validates allowed ranges, bounded points, returns numeric OHLC and current price.
- `get_market_history(range)` — same bounded semantics for aggregate index.
- `run_market_tick(worker_id, expected_sequence)` — `coins_worker`-only, lock-protected, updates persistent state/prices/ticks/snapshot in one transaction.
- `refresh_price_candles(interval, from, to)` — cron/`coins_worker`-only idempotent upsert, re-evaluates recently completed buckets for late/out-of-order ticks.
- `apply_history_retention()` — service/cron-only, refuses to delete raw data lacking required durable candles/archive marker.
- `set_market_running(boolean, reason)` — service/admin-only; no anonymous endpoint.

## 9. Market simulator and scheduler design

### 9.1 Why a worker remains

The current model has stateful cycles, per-asset trends/events, recovery, and 30-second cadence. Edge Functions are request-oriented and unsuitable as a durable timer. Persisting state in PostgreSQL removes process-memory loss; a tiny worker remains the simplest reliable wake-up mechanism.

### 9.2 Worker behavior

- TypeScript Node service under `worker/`, run as one PM2 process with `instances: 1` on the existing app VPS or a staging host.
- Server-only env names: `COINS_WORKER_DATABASE_URL`, `MARKET_WORKER_ID`, `TICK_INTERVAL_MS`, structured-log settings. The URL authenticates only as the restricted `coins_worker` role, uses required TLS, and is never logged or committed.
- Every 30 seconds execute the schema-qualified `coins.run_market_tick` through the restricted direct PostgreSQL connection; the function takes a transaction-level advisory lock and verifies sequence/last-tick time. Multiple accidental workers therefore cannot double-apply a tick.
- State transition rules preserve current broad behavior: cycle set, per-asset volatility/trend/event, ±0.5% per-tick cap, and 20%-500% baseline bound. Store baseline/state durably; make random source injectable/deterministic in tests.
- Tick function updates all assets, inserts all raw ticks, derives aggregate snapshot, updates cycle/event expiry, and commits atomically.
- Worker uses timeout, exponential backoff with jitter, and a circuit breaker; it never launches overlapping calls.
- Heartbeat and last successful tick are persisted. Alert/report when stale beyond two expected intervals.
- Market status derives countdown from persisted end timestamps, so restart does not reset it.

### 9.3 Aggregation scheduler

- First choice: enable/use `pg_cron` only if the existing Supabase PostgreSQL supports it and adding jobs is isolated. Jobs are named with a `coins_` prefix and checked for duplicates.
- Suggested jobs: finalise 15m candles every minute; 1h/6h/1d candles shortly after boundaries; reprocess the last two buckets for late ticks; retention daily; integrity/heartbeat check every five minutes.
- Fallback: the worker invokes the exact same idempotent SQL functions on schedule. Record which scheduler is authoritative so both cannot run retention independently (aggregation may be safely duplicate/idempotent; retention still has one owner).
- Never rely on JavaScript `setInterval` alone for rollups or cleanup.

## 10. Price-history architecture

### 10.1 Range contract

| UI range | Source | Resolution | Expected maximum |
|---|---|---:|---:|
| `24H` | `price_candles` | 15m | 96 |
| `7D` | `price_candles` | 1h | 168 |
| `30D` | `price_candles` | 6h | 120 |
| `ALL` | 6h/1d candles, adaptively rebucketed | adaptive | 200 |

The RPC returns:

- requested range, UTC `from`/`to`, resolution, server time
- numeric latest value from `assets.current_price`
- ordered points `{time, open, high, low, close, samples, complete}`
- no currency-formatted strings and no invented/interpolated data

For sparse ranges, return real points only. A single point yields zero/neutral change. Empty history is HTTP/RPC success with an empty array and current price.

### 10.2 Aggregate market chart contract

Preserve every range currently exposed by `MarketValueChart.tsx`; do not silently collapse it to the per-asset selector.

| UI range | Source | Resolution | Expected maximum |
|---|---|---:|---:|
| `5M` | `market_snapshots` | 30s tick | 10 |
| `10M` | `market_snapshots` | 30s tick | 20 |
| `30M` | `market_snapshots` | 30s tick | 60 |
| `1H` | `market_snapshots` | 30s tick | 120 |
| `2H` | `market_candles` | 1m | 120 |
| `12H` | `market_candles` | 15m | 48 |
| `24H` | `market_candles` | 15m | 96 |
| `ALL` | 1h/1d candles, adaptively rebucketed | adaptive | 200 |

`get_market_history(range)` validates exactly those values and returns UTC numeric OHLC points plus semantic label `aggregate_quote_index`; invalid input is a typed validation error, not an accidental `ALL`. Retain raw market snapshots for 48 hours, 1m candles for 14 days, 15m for 400 days, 1h for five years, and 1d indefinitely. Retention requires complete successor candles and archive evidence. Imported `market_history` is backfilled into all relevant candles before online pruning.

### 10.3 Retention

Initial policy, adjustable after observed volume:

- raw `price_ticks`: 48 hours online after archive and rollup verification
- 15m candles: 45 days
- 1h candles: 400 days
- 6h candles: 5 years
- 1d candles: indefinite
- imported raw history: retain in backup/archive even after online pruning

This supports every chart range and removes the current conflict where seven-day raw cleanup makes 30D/ALL impossible. Retention functions must check that corresponding complete candles exist before deletion.

### 10.4 Correctness details

- Use `timestamptz` and UTC bucket boundaries.
- Open/close ordering must include `(captured_at, id)` to make duplicate timestamps deterministic.
- Unique tick sequence prevents duplicate worker writes; migration reports and resolves source duplicate timestamps without dropping distinct rows.
- Recent candles are upserted, not `DO NOTHING`, so late/out-of-order ticks correct OHLC.
- Latest price and tick insertion occur in the same market-tick transaction.
- 24-hour percent change uses the latest actual price at/before the boundary (or earliest available point with an explicit sparse-history flag), not a formatted string.
- `ALL` computes a bucket width from actual span so it never exceeds 200; use durable daily candles for long spans.
- Aggregate market candles use their own retention/coverage checks and index `(interval, bucket_start DESC)`; tests cover all eight current frontend ranges and enforce the same 200-point global ceiling.
- Add query-plan tests/`EXPLAIN (ANALYZE, BUFFERS)` on staging-size data.

## 11. Frontend integration changes

### 11.1 Configuration and client

Create:

- `src/lib/supabase.ts` — singleton client using `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`, with schema-aware access.
- `.env.example` — names/placeholders only.
- generated `src/types/database.types.ts` from the migrated schema.
- `src/services/authService.ts`, `marketService.ts`, `tradingService.ts`, `portfolioService.ts`, and a shared error mapper.

Fail startup/build clearly when required public configuration is missing. Remove every hard-coded API URL.

### 11.2 Auth

Rewrite `src/context/AuthContext.tsx`:

- initialize with `supabase.auth.getSession()`
- subscribe with `onAuthStateChange`
- expose Auth user/session plus fetched `profiles`/`wallets` state
- `signUp`, `signInWithPassword`, `signOut`, password recovery/update
- no manual JWT decoding, no custom token getter, no user ID from browser payload, no default ID/user manufacture
- protect `/profile` based on session; show loading while session resolves
- remove token/user localStorage manipulation from components (Supabase client owns session persistence)

### 11.3 Data access

- Replace `useFetch` for Supabase data with typed query hooks/modules that support cancellation and stale/error state.
- Public initial queries fetch assets, stats, status, and selected asset.
- Subscribe to Realtime asset price/status changes and merge by primary key. On disconnect/reconnect, refetch a full snapshot.
- Do not subscribe to high-volume raw ticks or candles globally.
- Buy/sell calls pass only `asset_id`, quantity, and a generated idempotency UUID to RPC. Render authoritative returned price/total/balance/holding; browser previews remain labeled estimates.
- Portfolio/history queries depend on `auth.uid()` through RLS and do not accept browser user IDs.
- Remove legacy normalizers and duplicate types after parity tests.

### 11.4 Files to update/remove

- Modify: `package.json`, `src/App.tsx`, `src/context/AuthContext.tsx`, `src/components/AuthForms.tsx`, `UserMenu.tsx`, `Profile.tsx`, `BuyForm.tsx`, `SellForm.tsx`, `PriceChart.tsx`, `MarketValueChart.tsx`, `CoinDetail.tsx`, `src/types.ts`, deployment workflow.
- Replace: `src/services/transactionService.ts` with schema-specific modules after compatibility tests.
- Remove when unused: custom JWT/session helpers in `useFetch`, `DebugUserInfo.tsx` ID-fixing behavior, duplicate `src/types/index.ts` definitions, all hard-coded Express URLs.
- Keep `/coins/` router/base and existing UX unless a secure migration requires change.

## 12. Chart library decision

**Keep and improve Chart.js 4 / `react-chartjs-2`.**

Reasons:

- Already installed and integrated in both charts.
- The required series are bounded to ≤200 points, far below a performance threshold that justifies another library.
- Existing recent work already covers 24H/7D/30D/ALL, responsive sizing, tooltips, loading/empty/error states, high/low, and ARIA description.
- It is more maintainable for a solo developer than introducing Lightweight Charts while simultaneously changing auth/data architecture.

Required improvements:

- Set line tension to 0 (or use a non-inventing stepped/straight representation); current `tension: 0.35` visually smooths between real samples.
- Use OHLC high/low for period stats and close for the line. Do not fabricate missing points.
- Keep adaptive GBP formatting for tiny/large values and UTC-aware full tooltip times.
- Add keyboard-accessible range selector, visible focus, 44px targets, and a textual summary/table fallback for screen readers.
- Cancel stale range requests and retain the last good chart while refreshing.
- Test dark/light themes, mobile widths, sparse/one-point/out-of-order data, and `ALL` at the 200-point bound.
- Consider Lightweight Charts only as a later product enhancement if candlesticks/advanced crosshair are explicitly requested.

## 13. Deployment sequence (staging first; no production cutover tonight)

### Stage A — local/disposable

1. Confirm both migration branches and clean working trees.
2. Inventory self-hosted Supabase versions/extensions/config read-only; do not reinstall.
3. Create a disposable local or isolated staging Coins schema from migrations.
4. Run SQL/RLS/RPC tests and worker tests.
5. Generate TypeScript DB types and migrate frontend behind staging env variables.
6. Run frontend unit/component tests, lint, typecheck, and production build.

### Stage B — shared Supabase staging namespace

1. Take a configuration/database backup of affected Supabase metadata before additive changes.
2. Confirm `coins` schema name is unused and no migration object conflicts.
3. Apply migrations to a staging Supabase instance if available; otherwise use an explicitly staging-named isolated schema/project. Do not touch unrelated schemas/tables/Auth users.
4. Add `coins` to exposed PostgREST schemas and Realtime publication only after reviewing shared impact.
5. Configure staging redirect URL additively; preserve Brevo SMTP and other apps’ redirects.
6. Deploy one staging worker using its restricted staging `coins_worker` database role; prove it cannot read unrelated schemas or directly mutate Coins tables.
7. Restore/export production Coins data to staging, transform, verify, and run full chart/history load tests.
8. Deploy frontend to a non-production path/domain with staging public URL/anon key.
9. Complete smoke tests and 24-hour scheduler/heartbeat observation if practical.

### Stage C — production readiness package (stop before execution)

Prepare and document:

- verified source backup and restore evidence
- exact migration versions/checksums
- final export/import/verify commands
- Auth reset communication and support path
- staging test/build reports
- worker PM2 definition and health checks
- additive shared Supabase config diff
- frontend env/config diff
- maintenance/read-only switch for old Express writes
- cutover and rollback decision points

No production schema apply, final data copy, worker start, DNS/frontend switch, or write freeze occurs without John’s explicit approval.

### Approved future cutover outline

1. Announce maintenance window; stop new legacy trades (read-only UI/API) but keep reads available.
2. Stop old simulator and prove no tick is in flight.
3. Take final verified DB backup and consistent export.
4. Apply approved Supabase migrations/config; import final data; build candles; verify all gates.
5. Create/match Auth identities and send recovery links at the approved time.
6. Start one production worker; verify sequence, heartbeat, prices, and no duplicate ticks.
7. Deploy frontend configured for Supabase; smoke auth/read/trade/chart on designated accounts.
8. Keep old Express deployment and DB intact/read-only through the rollback window.
9. Monitor errors, RLS denials, RPC latency, balance invariants, tick cadence, and chart coverage.
10. Keep new-account registration disabled during the initial rollback window (recommended 24-48 hours, approved in the runbook). Existing/imported users may authenticate and trade after gates pass, but no Supabase-only identity is created until either the simple rollback window closes or a tested reverse identity-provisioning procedure exists.

## 14. Rollback plan

### Before first Supabase trade

- Revert frontend to the previous build/config pointing at `https://jdwd40.com/api-2/api`.
- Stop the Supabase market worker.
- Re-enable legacy simulator/writes only after confirming its DB is unchanged and healthy.
- Supabase Coins schema can remain isolated for investigation; do not destructively remove it during incident response.

### After Supabase trades are allowed

A simple frontend revert would lose/diverge new financial activity. Therefore:

1. Immediately freeze Supabase trade RPCs and worker ticks through service-only controls.
2. Export trades, wallet balances, holdings, asset prices, and history after the cutover watermark.
3. Run the prebuilt reverse-delta script against a restored legacy staging DB first.
4. Reconcile exact post-state and transaction IDs; obtain explicit approval before applying any reverse delta to production.
5. Apply delta in one controlled transaction/maintenance window, verify, then switch frontend back.

Supabase-only registrations are excluded from this reverse-delta path. Registration therefore remains disabled during the simple rollback window. If product requirements demand enabling it earlier, first implement and stage-test deterministic legacy user creation, uniqueness/collision handling, recovery-password delivery, and identity watermarking; otherwise rollback must quarantine those accounts and communicate manual recovery.

Rollback triggers include failed RLS isolation, any negative/inconsistent cash/holding, duplicate/missing trades, scheduler double ticks/stall, unrecoverable Auth failures, missing chart coverage, or unacceptable error/latency rates.

Keep source backups, export manifests, old frontend artifact, old Express commit/PM2 config, and cutover watermarks for the defined rollback period. Never delete source data as part of cutover.

## 15. Testing plan

### 15.1 Database schema and RLS

- Fresh migrations apply from zero in order; schema diff equals expected objects/grants/policies.
- User A can read only A’s profile/wallet/holdings/trades; User B and anon cannot.
- Public market/history surfaces are readable; underlying financial/system tables are not writable.
- Direct inserts/updates/deletes on wallets, holdings, trades, prices, ticks, simulator state fail for anon/authenticated.
- Service-only functions reject authenticated/anon execution.
- View tests prove no owner-rights RLS bypass.
- Authenticated `bootstrap_account` creates exactly one caller-owned profile/wallet and defaults £1,000; replay is idempotent and an unrelated Auth user creates no Coins rows unless it explicitly invokes the Coins RPC.

### 15.2 Trading and financial integrity

For each RPC:

- valid buy/sell and exact rounding
- invalid/null/NaN-equivalent/zero/negative/excess-scale/excess-size quantities
- missing/disabled asset and halted market
- insufficient funds/holdings with no side effects
- server price wins over any browser preview
- idempotent retry returns one trade and one state transition
- concurrent buys cannot overspend
- concurrent sells cannot create negative holdings
- buy and sell races use fixed lock order and do not deadlock
- injected failure after each internal step rolls back everything
- immutable trade update/delete fails
- returned post-state equals subsequent RLS reads

Use at least two real Supabase Auth JWTs in integration tests; do not fake `auth.uid()` only.

### 15.3 Simulator/scheduler

- deterministic seeded price calculations and bounds
- one atomic tick updates every asset/tick/snapshot/state or none
- advisory lock prevents overlapping/double worker ticks
- sequence and unique constraints make retry safe
- restart resumes persisted cycle/events rather than resetting
- stale heartbeat and recovery behavior
- halted state blocks ticks/trades according to product rule
- aggregation reruns are idempotent and correct late/out-of-order input
- retention refuses deletion without verified candles/archive
- `pg_cron` and worker fallback cannot both own destructive retention

### 15.4 History/chart API

- 24H=15m≤96, 7D=1h≤168, 30D=6h≤120, per-asset ALL≤200
- aggregate market 5M≤10, 10M≤20, 30M≤60, 1H≤120, 2H≤120, 12H≤48, 24H≤96, ALL≤200, with exact source/resolution selection
- UTC boundaries, DST dates, exact open/close ordering
- sparse, empty, single, duplicate timestamp, duplicate tick sequence, missing, late, and out-of-order ticks
- active versus complete bucket
- latest value equals current asset price after committed tick
- high/low/open/close/percentage calculations
- retention leaves every range complete
- response remains bounded and query plan uses expected indexes at production-like volume

### 15.5 Data migration

- backup restore test
- dry-run and second clean replay
- identity mapping uniqueness/idempotency
- exact row/count/aggregate and per-user state verification
- timestamp and numeric precision conversion
- discrepancies reported rather than silently repaired
- sequence reset and no duplicate IDs
- rollback delta dry-run on restored legacy staging

### 15.6 Frontend

Add Vitest/React Testing Library (or equivalent lightweight setup) rather than relying only on text-regex UI tests.

- Auth initial loading/session refresh/sign-up/sign-in/sign-out/recovery/expired session
- no user-ID/default-user fallback
- typed service success and PostgREST/RPC error mapping
- RLS-denied/cross-user UX
- buy/sell preview versus authoritative result, double-submit/idempotency, loading/error/retry
- Realtime update, disconnect, reconnect/refetch, cleanup
- chart all ranges, race cancellation, loading/stale/empty/error/sparse states, summary accuracy, mobile/dark/light/accessibility
- profile totals/history and post-trade refresh

### 15.7 Required verification commands

Exact commands should be finalized after implementation tooling exists; minimum gates:

```bash
# backend/Supabase
supabase db reset
npm test
npm run lint
npm run typecheck
npm run build
npm run test:integration
npm run migration:dry-run
npm run migration:verify

# frontend
npm ci
npm run test
npm run test:ui
npm run lint
npx tsc --noEmit
npm run build
```

If the self-hosted environment cannot use `supabase db reset`, provide an equivalent isolated PostgreSQL setup script and document it. Do not silence failures or weaken assertions for a green run.

## 16. Ordered staged checklist for the K3 implementer

### Task 1 — Baseline and safety inventory

- Backend: add `docs/CURRENT_STATE_INVENTORY.md` and safe read-only scripts under `scripts/inventory/`.
- Frontend: record hard-coded endpoints and the existing baseline (UI contract passes; ESLint has five warnings; app-project TypeScript check fails).
- Verify branches, no secrets in tracked changes, no main/master push, and exact source/Supabase inventories.
- Treat the confirmed tracked private key at `github-actions-key` as a release blocker. Do not print or reuse it. Request John's explicit approval for removal, history cleanup, and rotation; do not alter key material or access autonomously.

### Task 2 — Create Supabase project structure

- Backend create `supabase/config.toml`, `supabase/migrations/`, `supabase/seed.sql` with non-production fixtures only, `.env.example`, and package scripts.
- First migration creates the dedicated schema, extensions that are confirmed safe, types, and base tables.
- Test clean apply and rollback only on disposable databases; commit.

### Task 3 — Constraints, indexes, grants, and RLS (tests first)

- Add SQL/integration tests proving deny-by-default and A/B isolation.
- Add checks/FKs/indexes, revoke defaults, enable/force RLS, create policies/views.
- Test with anon, two authenticated users, and service role; commit only when isolation passes.

### Task 4 — Auth bootstrap and identity tooling

- Add the explicit `bootstrap_account` RPC and tests; do not add a global `auth.users` trigger on the shared project.
- Frontend add `@supabase/supabase-js`, `src/lib/supabase.ts`, generated types, and auth service/context tests.
- Implement supported Auth flows and remove custom JWT/default-user behavior.
- Build `scripts/migration/create-auth-users.mjs` with dry-run/idempotency; test only synthetic staging emails; commit.

### Task 5 — Atomic buy RPC

- Write failing SQL/integration tests for valid, invalid, insufficient, rollback, idempotent, and concurrent buys.
- Implement `buy_coin` with server price, fixed locks, conditional debit, holding upsert, immutable trade.
- Frontend implement typed buy service and update `BuyForm.tsx`; test double-submit and authoritative result; commit.

### Task 6 — Atomic sell RPC

- Write corresponding sell/concurrency/cost-basis tests.
- Implement `sell_coin`; update `SellForm.tsx`; commit after DB and UI tests pass.

### Task 7 — Portfolio and transaction reads

- Create RLS-safe views/queries and typed frontend services.
- Update `Profile.tsx`; remove user-ID parameters, legacy field normalizers, and local user cash authority.
- Test cross-user denial and exact totals; commit.

### Task 8 — Persistent market state and tick function

- Add market/simulation tables and deterministic function-level tests.
- Implement `run_market_tick`, advisory lock, sequence/idempotency, price/tick/snapshot transaction, start/stop service RPC.
- Prove all-or-nothing behavior and bounds; commit.

### Task 9 — Minimal worker

- Create `worker/package.json`, `worker/src/`, tests, `.env.example`, PM2 ecosystem template, and operations docs.
- Implement non-overlapping 30-second calls, heartbeat, retry/backoff, structured logs, graceful shutdown.
- Run restart/double-worker failure tests against staging; commit.

### Task 10 — Candles, history RPCs, and retention

- Add `price_candles`, aggregation/backfill/retention functions, and optional prefixed cron migration after extension discovery.
- Test all ranges, sparse/late/duplicate/out-of-order data and point budgets.
- Load production-size synthetic/imported staging data and inspect query plans; commit.

### Task 11 — Frontend market data and Realtime

- Create `marketService.ts`; replace hard-coded polling in `App.tsx`, `PriceChart.tsx`, and `MarketValueChart.tsx`.
- Use initial snapshot + limited Realtime subscriptions + reconnect refetch.
- Consolidate types and remove obsolete Express service paths; test lifecycle/races; commit.

### Task 12 — Chart polish without library replacement

- Keep Chart.js; remove line smoothing; preserve real OHLC/stat semantics.
- Complete mobile/dark/light/accessibility/keyboard tests and all four required ranges.
- Keep responses/rendering bounded; commit.

### Task 13 — Migration scripts and first staging replay

- Implement export, transform/import, Auth mapping, rollup backfill, verification, and encrypted artifact handling.
- Restore a source backup, import to a clean staging Coins schema, generate discrepancy report, and verify all gates.
- Repeat from clean state to prove reproducibility; commit scripts/docs, never data dumps/secrets.

### Task 14 — Deployment/runbooks

- Update frontend workflow for staging/prod environment selection without changing master deployment behavior on the migration branch.
- Add worker PM2/health/log rotation instructions and additive Supabase schema/redirect/Realtime configuration steps.
- Complete `MIGRATION_RUNBOOK.md`, `CUTOVER_RUNBOOK.md`, and `ROLLBACK_RUNBOOK.md`; commit.

### Task 15 — Full staging verification

- Run database, worker, migration, RLS, concurrency, frontend test/lint/typecheck/build gates.
- Deploy only staging resources, run smoke tests, monitor scheduler, and capture non-secret evidence.
- Resolve every high-risk failure; do not proceed to production.

### Task 16 — Production readiness handoff

- Produce a concise readiness report with commits, test output, staging URLs, source/target counts, discrepancies, open risks, exact approved cutover steps, and rollback timing.
- Stop and request John’s explicit approval for any production freeze, backup, import, shared Supabase config change, worker production start, or frontend production switch.

## 17. Risks and assumptions

### High risks

- **Legacy financial inconsistency:** pool-level pseudo-transactions and the legacy manual transaction route may have produced mismatched cash, holdings, and trades. Mitigation: exact per-user reconciliation and no automatic repair.
- **Auth password portability:** supported Supabase Auth import of existing bcrypt hashes is not assumed. Mitigation: deterministic identity mapping plus recovery flow.
- **Shared Supabase blast radius:** exposing a custom schema or changing Auth redirects/CORS/Realtime can affect other apps. Mitigation: read-only inventory, additive diff, backup, staging, explicit approval.
- **Rollback divergence:** once Supabase accepts trades, simple frontend rollback is unsafe. Mitigation: write freeze, watermark, reverse-delta scripts and verification.
- **Scheduler duplication/stall:** current simulator is process-memory based; future worker could accidentally duplicate. Mitigation: persistent sequence, DB advisory lock, heartbeat, one PM2 instance.
- **History loss:** existing cleanup/rollup design conflicts with 30D/ALL. Mitigation: backfill/verify/archive before retention and multi-resolution durable candles.
- **Timestamp ambiguity:** several legacy tables use timestamp without timezone. Mitigation: verify server/DB timezone and explicit UTC conversion.
- **Schema drift:** executable seed schema, migrations, docs, and production differ. Mitigation: production catalog inventory and new clean versioned baseline.
- **Confirmed tracked private key:** frontend `github-actions-key` is tracked, private-key-formatted, and mode `0664`; no key content was printed. Mitigation: block release, preserve confidentiality, and obtain John's explicit approval for removal/history cleanup/rotation.

### Assumptions to verify

- `supabase.jdwd40.xyz` exposes supported Auth/Admin/PostgREST/Realtime APIs and can add a dedicated exposed schema without reinstall.
- Existing Brevo SMTP remains configured and can deliver recovery emails within limits.
- Supabase PostgreSQL may support `pg_cron`; if not, worker fallback is accepted.
- The old source timestamp convention is UTC.
- Existing 20 account emails are valid enough for recovery; invalid/duplicate emails require a manual mapping plan.
- The app VPS can host one small PM2 worker and reach Supabase securely.
- Current chart UX and aggregate “market value” semantics should be preserved unless explicitly changed.

## 18. Explicit out-of-scope / do-not-touch

- No Supabase reinstall, volume replacement, upgrade, or unrelated schema/data migration.
- No import of unrelated existing Supabase player/game records into Coins.
- No production cutover, write freeze, production data mutation, DNS change, or main/master deployment without John’s approval.
- No SSH, UFW, account, sudo, or server-access changes.
- No secret rotation or deletion without approval; no secret values in commits/reports.
- No real-money deposits, withdrawals, crypto custody, payments, or financial-service features.
- No forced Edge Function simulator and no unnecessary microservices.
- No chart-library rewrite unless later requirements exceed Chart.js.
- No silent ledger/balance “correction,” destructive cleanup, or source-data deletion.
- No hard user deletion that erases financial audit history.

---

## Definition of staging-ready

Phase 2 may call the migration staging-ready only when a fresh schema is reproducibly creatable; Auth and recovery work; RLS isolation tests pass; buy/sell are atomic, idempotent, concurrent-safe, and server-priced; source data can be repeatably imported and reconciled; the simulator survives restart without duplicate ticks; every chart range is complete and bounded; retention cannot erase needed history; frontend tests/lint/typecheck/build pass; staging smoke tests pass; and cutover/rollback runbooks are complete. Production remains unchanged until separately approved.
