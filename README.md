# Coins backend

Node.js, Express, and PostgreSQL backend for **Coins / Crypto Chaos**, a fantasy cryptocurrency exchange simulator. The production game is a continuous persistent market: there are no round resets and no real money, blockchain, deposits, withdrawals, or investment services.

Repository: `jdwd40/back_coins_x`

Production branch: `main`

Frontend: [`jdwd40/fcoins_y`](https://github.com/jdwd40/fcoins_y)

Public API base: `https://jdwd40.com/api-2/api`

## What runs in production

- Express REST API with JWT authentication.
- Persistent market writer every 30 seconds.
- Adaptive Director decisions and persistent coin-event reconciliation inside the market write transaction.
- Persistent bot trader worker.
- Persistent dead-coin replacement worker.
- PostgreSQL as the authority for users, coins, prices, accounts, holdings, trades, market state, Director state, events, bots, and debt.

The old Apocalypse/cycle API and schema remain for compatibility and the internal monitor. The legacy cycle, bot, and economy workers do **not** start in production and do not drive current prices.

## Main runtime flow

```text
market world + coin state + Director state + active events
                         ↓
             deterministic price calculation
                         ↓
 coins.current_price + price_history + market_history + checkpoints
                         ↓
       persistent signals/runtime APIs and React frontend
```

Player trades use `/api/persistent/*`. The server locks the live coin price and updates cash, holdings, and the append-only transaction ledger atomically.

## Setup

Requirements: Node.js, npm, and PostgreSQL.

Create environment files as needed:

```dotenv
# .env.development or .env.test
PGDATABASE=coins_x
PGUSER=jd
PGPASSWORD=your-local-password
PGHOST=localhost
PGPORT=5432
JWT_SECRET=replace-with-a-local-secret
FRONTEND_URL=http://localhost:5173
```

Install dependencies:

```bash
npm ci
```

For a disposable local database, `npm run seed` recreates the schema and data. It is destructive and refuses to run with `NODE_ENV=production`.

```bash
NODE_ENV=development npm run seed
npm run dev
```

For an existing or production database, use the tracked migration path:

```bash
NODE_ENV=production npm run migrate
NODE_ENV=production npm run verify:game-schema
NODE_ENV=production npm run verify:persistent-world
```

Never run `npm run seed` against production. A new deployment requires a one-time explicit world provision; see [`docs/persistent-world-ops.md`](docs/persistent-world-ops.md).

## Commands

| Command | Purpose |
|---|---|
| `npm start` | Start the production server |
| `npm run dev` | Start with nodemon |
| `npm test` | Run the Jest suite serially |
| `npm run migrate` | Apply tracked migrations 007+ |
| `npm run verify:game-schema` | Verify required schema contracts |
| `npm run verify:persistent-world` | Require exactly one active world |
| `npm run provision:persistent-world -- --seed '<seed>'` | One-time world provisioning |
| `npm run simulate:persistent-horizon` | Run the persistent-market simulation harness |
| `npm run simulate:stage9` | Run Stage 9 quality gates |

## Repository map

| Path | Responsibility |
|---|---|
| `server.js`, `app.js` | Process lifecycle, middleware, routes, workers |
| `routes/`, `controllers/` | HTTP surface and request handling |
| `game/` | Persistent market, Director, events, bots, economy, death/replacement |
| `models/` | Database-backed models and the live market writer |
| `db/migrations/` | Production schema history; migrations are authoritative |
| `simulation/` | Deterministic balance and regression harnesses |
| `__tests__/` | Unit, integration, schema, concurrency, and deployment contracts |

## Documentation

- [`project_plan.md`](project_plan.md) — current source of truth and roadmap
- [`PRD.md`](PRD.md) — current product requirements
- [`API_DOCUMENTATION.md`](API_DOCUMENTATION.md) — current endpoint map
- [`docs/database_schema.md`](docs/database_schema.md) — current data model
- [`docs/persistent-world-ops.md`](docs/persistent-world-ops.md) — production runbook
- [`docs/architecture/coins-software-architecture.md`](docs/architecture/coins-software-architecture.md) — current human architecture report
- [`docs/architecture/coins-software-architecture-llm.md`](docs/architecture/coins-software-architecture-llm.md) — LLM-oriented architecture reference
- [`bugs.md`](bugs.md) — confirmed open and fixed defects
- [`new_features.md`](new_features.md) — requested and planned work
- [`changelog.md`](changelog.md) — curated release history

## Safety rules

- Prices are server-owned; clients never submit an execution price.
- One active `market_worlds` row is required.
- A successful trade updates account cash, holdings, and ledger in one PostgreSQL transaction.
- Humans cannot receive bot loans.
- A `DEAD` coin has price `0`, cannot be traded, and is never revived.
- Persistent history reads use `source = 'MARKET_TICK' AND cycle_id IS NULL`.
- Production requires a non-empty `JWT_SECRET` and exits if it is missing.
