# Coins database schema

Current persistence map for `back_coins_x/main`, reviewed 12 September 2026. The SQL migration files and `db/verify-game-schema.js` are authoritative; this document explains ownership and relationships rather than duplicating every column and constraint.

## Primary persistent-world tables

| Table | Purpose | Important rules |
|---|---|---|
| `market_worlds` | Persistent world identity, immutable seed, epoch, active flag | Partial unique index permits at most one active world |
| `market_coin_state` | Per-coin archetype, condition, references, `ALIVE`/`DEAD` status | One row per coin; death/status timestamp consistency |
| `market_director_state` | Long-running six-regime deterministic Director cursor | One row per world; regime/index/intensity persisted |
| `director_control_state` | Adaptive short-term mode, roles, cooldown state, decision cursor | One row per world; `NORMAL/BOOM/BUST/RESCUE` |
| `director_decision_history` | Append-only safe decision summaries | Unique `(world_id, decision_index)` |
| `persistent_coin_events` | World-scoped active and historical coin events | Unique `(world_id, coin_id, event_seq)`; direction/sign and duration constraints |
| `market_price_checkpoints` | Restart-safe pricing checkpoint for each coin/world | Used to resume the deterministic writer |
| `persistent_accounts` | Player/bot cash and starting grant per world | Unique `(world_id, user_id)`; £10,000 granted once |
| `persistent_holdings` | Fractional quantity and weighted-average cost basis | Unique `(account_id, coin_id)`; quantity/cost basis non-negative |
| `persistent_transactions` | Append-only persistent BUY/SELL ledger | Written after successful guarded mutation in the same DB transaction |
| `persistent_loans` | Bot-only ISSUE/REPAYMENT debt ledger | Records post-operation debt; humans are rejected in domain logic |
| `persistent_bot_ticks` | Cross-process idempotency claim for bot ticks | Primary key `(world_id, tick_id)` |

## Shared catalogue and history tables

| Table | Purpose | Current authority |
|---|---|---|
| `users` | Credentials, identity, bot flag/personality | JWT authentication identity; legacy `funds` is not current gameplay cash |
| `coins` | Catalogue and live price | `current_price` is the public execution/display price; `retired` hides old/dead catalogue items |
| `price_history` | Per-coin historical prices | Persistent rows are `source='MARKET_TICK' AND cycle_id IS NULL` |
| `market_history` | Aggregate market value and coarse trend | Written by the persistent market batch |
| `price_history_rollups` | Historical aggregation support | Secondary/legacy optimisation table |
| `coin_statistics` | Stored high/low statistics | Secondary market statistics |
| `schema_migrations` | Applied/baselined migration ledger | Managed by `db/migrate.js` |

## Primary relationships

```text
users ──< persistent_accounts ──< persistent_holdings >── coins
                  │                        │
                  ├──< persistent_transactions >─────────┘
                  └──< persistent_loans

market_worlds ──< market_coin_state >── coins
      │          ├──< market_price_checkpoints
      │          └──< persistent_coin_events
      ├── market_director_state
      ├── director_control_state
      ├──< director_decision_history
      └──< persistent_bot_ticks

coins ──< price_history
```

## Sources of truth

| Concept | Source of truth | Derived/public views |
|---|---|---|
| Active world | single active `market_worlds` row | persistent APIs return `worldId` |
| Current price | `coins.current_price` | signals, account valuation, leaderboard, UI |
| Coin lifecycle | `market_coin_state.status` and `died_at` | signals/runtime; `coins.retired` controls catalogue visibility |
| Player cash/debt | `persistent_accounts` | account API and leaderboard |
| Holdings/cost basis | `persistent_holdings` | account API and leaderboard valuation |
| Trade history | `persistent_transactions` | authenticated transaction API |
| Director regime | `market_director_state` | public regime/intensity signal |
| Adaptive action/roles | `director_control_state` | runtime API projection |
| Director audit history | `director_decision_history` | safe recent decision summaries |
| Coin events | `persistent_coin_events` | runtime API; capped net modifier enters pricing once |
| Restart state | `market_price_checkpoints` plus Director cursors | market writer resume |
| Bot tick completion | `persistent_bot_ticks` | no public raw tick data |

## Atomicity and lock order

Persistent trades use one PostgreSQL client and transaction. The server resolves the active world, locks the live coin before the account/holding, validates current state and price, performs guarded cash or quantity mutation, updates cost basis, appends the ledger row, and commits. Any error rolls the whole trade back.

The market writer runs a single transaction per batch. It resolves one world, locks current market/coin/checkpoint/Director state, reconciles decisions/events, computes every live coin, writes current prices/history/checkpoints/state, commits the Director cursor and decision history, and then completes the batch. Invalid state causes rollback rather than partial pricing.

## Price-history provenance

The table contains historical data from more than one architecture:

- Persistent world: `source='MARKET_TICK' AND cycle_id IS NULL`.
- Legacy Apocalypse monitor: cycle-scoped `MARKET_TICK`/`COLLAPSE` rows.
- Pre-provenance legacy rows: nullable source/cycle fields.

New player charts must use only the persistent predicate. Do not infer persistent ownership from timestamps.

## Legacy cycle schema

The database still contains `apocalypse_*` tables for compatibility and the internal monitor: cycles, participants, holdings, transactions, bots/ticks, results, cash/economy events, phases, coin events, market state, and collapses, plus `coin_collapse_schedule`.

These are not the primary player economy. The legacy workers do not start in production. Do not drop the tables until consumers, diagnostics, rollback needs, and historical retention have been audited.

## Migration policy

- `db/migrate.js` tracks canonical `NNN_description.sql` files.
- Migrations 001–006 are recorded as an existing-schema baseline and are not executed by the tracked runner.
- Migrations 007+ run once, each inside its own transaction under an advisory lock.
- `db/seed.js` drops and recreates tables for local/test use and refuses production.
- Production deploy order is migrate → schema verify → persistent-world verify → pm2 restart → health checks.
