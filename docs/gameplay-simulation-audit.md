# Gameplay Simulation Audit — Wave 0 / SIM-01

Read-only audit of the current authoritative market simulation in this
backend (`back_coins_x`, branch `v2-legacy-cleanup-20260825`). Prepared for
the gameplay overhaul defined by `/home/jd/gameplay-overhaul/gameplay_changes.md`
and `gameplay_build_plan.md`. No code was modified for this audit.

## 1. Live modules that can mutate `coins.current_price`

Exactly three production write paths exist (verified by grep across the
repository, excluding tests/migrations/seed/llm-opinions):

1. **`models/market-simulator.js` — `MarketSimulator.updateAllPrices()`**
   (the normal tick writer):
   - `UPDATE coins SET current_price = $1 WHERE coin_id = $2` (line ~215),
     one row per live, non-collapsed coin, inside a `BEGIN`/`COMMIT`
     transaction that locks `SELECT ... FROM coins FOR UPDATE` first.
   - Guarded: a non-finite or `<= 0` calculated price aborts the whole batch
     (rollback); a persisted collapsed coin with a non-zero price also
     aborts the batch (fail-safe, never revives).
2. **`game/collapseScheduleService.js` — `restoreBaselinePrices(client)`**
   (line ~163): `UPDATE coins SET current_price = cycle_baseline_price`,
   runs only at a new-cycle boundary inside `startCycle()`, before that
   cycle's collapse schedule is created.
3. **`game/collapseScheduleService.js` — `executeDueCollapses(client, cycleId, now)`**
   (line ~199): `UPDATE coins SET current_price = 0 WHERE coin_id = $1` per
   due, unexecuted `coin_collapse_schedule` row (selected `FOR UPDATE`),
   inside the Core 1 lifecycle transaction.

`db/seed.js` also writes `current_price`, but only when seeding the
disposable development/test databases — never in production runtime.

Deliberately removed write paths (do not reintroduce):
- `PATCH /api/coins/:coin_id/price` was removed (Milestone 1 hardening);
  `__tests__/coin-price-mutation-removed.test.js` pins the 404 and proves a
  collapsed coin cannot be revived through the API. `routes/coins.routes.js`
  documents the absence.

## 2. Volatility / price calculation paths

- **`game/marketDomain.js`** — the single source of truth for gameplay
  prices (stated in its header; shared by the live writer and the headless
  simulator in `simulation/`):
  - `MARKET_ARCHETYPES` (ZIP/MOON/BULL/HODL/DEGEN/RUG: cycleMs, swing,
    drift, noise ranges) and `GAMEPLAY_ROSTER` (coin_id → archetype map).
  - `buildMarketCycle()` — per-(seed, coinId, index) seeded cycle
    parameters via `createSeededRandom` (`:v2-market:` separator).
  - `buildCoinNoise()` / `coinNoise()` — bounded two-sine seeded noise
    (`:v2-market-noise:` separator), continuous across cycle boundaries.
  - `getCoinStartOffsetFraction()` — seeded per-coin phase staggering
    (`:v2-market-offset:` separator).
  - `locateMarketCycle()` / `evaluateCyclePoint()` — DIP→RISE→BOOM→FALL
    segment evaluation with anchor drift (`easeSegment` shaping).
  - `evaluateMarketPoint()` — core pricing: baseline × anchor path with
    Core 2 amplitude scaling deviation-from-anchor only; floored at
    `MIN_POSITIVE_PRICE`.
  - `roundGamePrice()` (4dp gameplay precision, migration 017), `priceAt()`.
  - `getPublicCoinSignal()` — the redacted public signal (coarse phase,
    momentum, recent change over `PUBLIC_SIGNAL_LOOKBACK_MS` = 60s;
    `PUBLIC_SIGNAL_KEYS` is the enforced redaction contract).
- **`game/apocalypseVolatility.js`** — `getApocalypseVolatility(progress)`:
  bounded amplitude curve `min + (max-min)*(p/100)^exponent` (defaults
  1.0→3.0, exponent 2, absolute cap 10), plus `ESCALATION_BANDS`
  (NORMAL/ELEVATED/HIGH/EXTREME — reporting vocabulary only). Resolved once
  per batch by the market writer from Core 1 progress.
- **`game/collapseRiskDomain.js`** — `getCollapseRisk()`: coarse public risk
  vocabulary (STABLE/SHAKY/DANGER/CRITICAL) from public progress/archetype/
  stress plus schedule-independent seeded noise. Read-side signal only; it
  never mutates prices and never reads the collapse schedule.
- **`models/market-simulator.js` — `coarseMarketTrend()`** maps mean batch
  movement to the `market_history.market_trend` CHECK vocabulary
  (STRONG_BOOM/MILD_BOOM/STABLE/MILD_BUST/STRONG_BUST).

No `Math.random()` exists in any pricing path; all randomness is the SHA-256
counter-mode `game/seededRandom.js` streams keyed by the persisted cycle
seed.

## 3. Market writer / tick ownership and lifecycle

- **Owner:** the `MarketSimulator` singleton in `models/market-simulator.js`.
- **Cadence:** `priceUpdateInterval = 30000` ms `setInterval` in
  `startPriceUpdates()`; an interval error clears the interval and schedules
  a 5s recovery restart while `isRunning`.
- **Lifecycle:** started only by `app.js` (`if NODE_ENV === 'production'`
  → `marketSimulator.start()`); stopped in `server.js` `shutdown()` (after
  the game workers, before HTTP close/pool drain). There are deliberately
  no `/api/market/start|stop` routes (`routes/market.routes.js` comment).
- **Batch shape (`updateAllPrices`):** reconcile authoritative Core 1 cycle
  ONCE before opening the write transaction → derive `apocalypsePercent` →
  `getApocalypseVolatility` amplitude → read persisted collapsed set via
  `collapseScheduleService.getCollapsedCoinIds()` → one transaction: lock
  all coins `FOR UPDATE`, per live coin compute
  `calculateNewPrice()` → write `coins.current_price` + `price_history`
  row (`source='MARKET_TICK'`, stamped with the cycle id) → insert one
  `market_history` row → `gameRoundService.reconcileActivePeaks(client)`
  (set-based Core 4 peak lift) → `COMMIT`. Any error rolls back everything.
- **Observability only:** `this.lastBatch` feeds `getMarketStatus()`;
  it is never pricing state. `events: []` is a kept-but-empty API contract.

## 4. Old scheduled collapse — creation, execution, restoration, settlement

**The persisted scheduled collapse mechanism
(`coin_collapse_schedule` + `game/collapseScheduleService.js`) is the current
collapse authority. It must not run alongside the future dynamic collapse
engine (SIM-13/SIM-14): both active would mean two independent systems
zeroing coins. See §10.**

- **Creation:** `createScheduleForCycle(client, cycle)` — reads eligible
  coins (`retired = FALSE`, `FOR UPDATE`) once, canonicalises by coin_id,
  seeded Fisher–Yates (`deterministicShuffle` over the Core 1 seed),
  `computeScheduleTimes()` spaces ranks from `COLLAPSE_WINDOW_START_PERCENT
  = 70`% of the cycle to exactly cycle end; inserted atomically via
  `unnest`. Idempotent: existing rows are authoritative and returned
  unchanged — never rerolled.
- **Restoration:** `restoreBaselinePrices(client)` (see §1) runs only at a
  new-cycle boundary via `startCycle()`, so a previous cycle's £0 never
  leaks forward.
- **Execution:** `executeDueCollapses(client, cycleId, now)` — selects due
  unexecuted rows `FOR UPDATE`, sets price to exactly 0, appends the
  `price_history` `source='COLLAPSE'` £0 row, stamps `executed_at` with a
  guarded `UPDATE ... WHERE executed_at IS NULL` (`rowCount !== 1` aborts).
  Called from two owners:
  - `game/gameCycleService.js → ensureActiveCycle()` for a live cycle at
    `now` (inside the advisory-locked Core 1 transaction);
  - `game/gameSettlementService.js → settleSettlingCycle()` reconciling
    through exactly cycle end, so the final coin reaches £0 before any
    value/result is read.
- **Read side:** `getCollapsedCoinIds()` / `isCoinCollapsed()` join the
  schedule to ACTIVE/SETTLING cycles — death is never inferred from
  `current_price === 0` and a collapsed coin stays dead through settlement.

## 5. Cycle state / recovery and database authority / locks

- **`game/gameCycleService.js`**: `reconcileCycle()` is the single lifecycle
  loop (bounded `MAX_LIFECYCLE_PASSES`): Phase 1
  `settlementService.freezeExpiredActiveCycle()` → Phase 2
  `settlementService.settleSettlingCycle()` → Phase 3 `ensureActiveCycle()`.
- **Lock:** one transaction-scoped advisory lock
  `SELECT pg_advisory_xact_lock(727001)` serialises all mutating game
  lifecycle work (cycle, collapse, rounds, settlement). The key is
  re-declared locally in `gameSettlementService.js` and
  `gameRoundService.js` — never imported across the cycle boundary.
- **Durability:** cycle rows `apocalypse_cycles` (ACTIVE → SETTLING →
  COMPLETED; migration 011 partial unique index allows a single SETTLING
  cycle); `insertCycle()` uses the `PENDING` → `APOC-NNNN` id transient.
  `alignStartTime()` floors default 30-minute cycles to :00/:30 UTC.
- **Recovery:** `ensureActiveCycle()` recovers a pre-existing ACTIVE
  cycle's collapse schedule / participants / economy events idempotently
  (no baseline reset mid-cycle); long downtime chains one
  freeze/settle/successor pass per elapsed cycle. Reconciliation observes
  persisted rows, never rerolls.
- **Wakeups:** `game/gameCycleWorker.js` (default 60s) only calls
  `reconcileCycle()`; every state read (`getGameState`,
  `marketSignalsService`, bot ticks, the market writer) also reconciles
  first — the database, not any timer, is the authority.

## 6. Bot trade integration

- **`game/botWorker.js`** (lifecycle-owned singleton; tick id = wall clock
  floored to `resolveBotConfig().tickIntervalMs`) →
  **`game/botService.js → runBotTick()`**. Duplicate-tick authority is the
  `apocalypse_bot_ticks UNIQUE (cycle_id, tick_id)` claim; per-bot cooldown
  is read from persisted `apocalypse_bots.last_action_at`.
- **Same trade rules as humans: YES.** Bots are real `users` rows
  (`is_bot = true`, unusable bcrypt credentials) and trade exclusively
  through `gameRoundService.joinRound / buyRoundTrade / sellRoundTrade` —
  the exact Core 4 domain ops humans reach via `controllers/game.controller.js`.
  Same advisory lock, row locks, Power cost (`game/powerDomain.js`),
  3-position limit, min-notional rule, collapsed-coin and retired-coin
  rejections. Authoritative rejections are recorded as non-fatal skips,
  never bypassed.
- **Information legality:** decisions consume only the shaped public state
  from `buildPublicMarketState()` (live prices, recent public history,
  executed collapses, the same coarse V2 signals humans get, own
  cash/holdings/Power/positions, `apocalypsePercent`); the exact-key
  allowlists (`BOT_MARKET_STATE_KEYS` etc.) are enforced by
  `assertPublicBotState`. Future/scheduled collapse data is never read.
- **Configuration:** `game/botConfig.js` (`BOT_ROSTER`, personalities,
  phase boundaries, exposure caps, `resolveBotConfig` env validation).

## 7. Price-history write paths and provenance

Exactly two live writers into `price_history` (migration 019 added nullable
`cycle_id` + `source VARCHAR(12) CHECK (source IN ('MARKET_TICK','COLLAPSE'))`
and the `(cycle_id, coin_id, created_at)` index):

1. `models/market-simulator.js` — every normal tick, `source='MARKET_TICK'`,
   stamped with the reconciled cycle id, `created_at = CURRENT_TIMESTAMP`.
2. `game/collapseScheduleService.js → executeDueCollapses()` — the actual
   £0 transition, `source='COLLAPSE'`, at the scheduled instant.

Derived/secondary:
- `services/rollup-service.js` builds `price_history_rollups` aggregates
  from `price_history` (read-derived, never a price authority).
- Legacy rows may lack provenance; the Apocalypse Monitor diagnostics
  attribute exact vs time-window-derived legacy rows.

Readers: `models/priceHistory.model.js` (per-coin history + drill-down),
`models/coins.model.js` (display strings/change), the monitor diagnostics,
and bot history windows. Quirks: `created_at` is the timestamp column;
`price` is DECIMAL(20,2) vs coins 18,4-consistent gameplay precision;
collapsed coins carry terminal £0 rows — readers must treat £0 as dead.

## 8. Settlement and leaderboard dependencies

- **`game/gameSettlementService.js`**: `freezeExpiredActiveCycle()` commits
  the durable ACTIVE→SETTLING flip (from that commit the Core 4 live-cycle
  guard rejects all trades); `settleSettlingCycle()` runs Core 3 through
  exactly cycle end → final monotonic peak lift →
  `gameRoundService.finalizeCycleParticipants()` (status FINALIZED,
  `final_cash` from authoritative `current_cash`) → the immutable ranked
  `apocalypse_results` snapshot (rank: `final_cash DESC, participant_id
  ASC`; `ON CONFLICT DO NOTHING`; UPDATE/DELETE/TRUNCATE triggers make
  results immutable) → completeness guard → COMPLETED with `settled_at`.
  Any failure rolls back and leaves the cycle observably SETTLING, blocking
  successors.
- **`game/gameResultsService.js`** (read side): serves the immutable
  snapshot for results/recent leaderboards; live leaderboard reconciles
  then reads.
- Settlement depends on final prices only through participant cash/
  holdings valuation after the final guaranteed collapse (all holdings £0).

## 9. Game-state / market API and frontend consumers

Backend routes (`app.js` mounts):
- `GET /api/game/state` (public, reconcile-then-read; **no seed**),
  `GET /api/game/market-signals` (public coarse signals),
  `GET /api/game/leaderboard`, `GET /api/game/leaderboards/recent`,
  `GET /api/game/results/:cycleId`, `GET /api/game/participant`;
  authenticated: `POST /api/game/join`, `POST /api/game/trades/buy`,
  `POST /api/game/trades/sell` (`controllers/game.controller.js`,
  domain errors mapped by `handleGameError`).
- `GET /api/market/status`, `GET /api/market/stats`,
  `GET /api/market/price-history` (`controllers/market.controller.js`;
  `GET /api/market/history` was removed in the V2 legacy cleanup).
- `GET /api/coins`, `GET /api/coins/:coin_id`,
  `GET /api/coins/:coin_id/price-history`.
- `GET /api/game/diagnostics/{participants,activity,bots,monitor,
  monitor/cycles}` — operator-token gated (`authenticateDiagnostics`,
  fail-closed 404 when unset), read-only transactions, `no-store`.
- Legacy (`/api/transactions/...`, `/api/users/...`) read `current_price`
  for display/valuation but never write it.

Frontend (`/home/jd/work/fcoins_y`, separate repo, branch
`gameplay-overhaul-20260830`, base URL `https://jdwd40.com/api-2/api`):
- `src/services/gameService.ts` — game/state, join, trades buy/sell,
  leaderboard, leaderboards/recent, results/:id, participant,
  market-signals.
- `src/services/priceHistoryService.ts` — coin price history.
- `src/services/monitorService.ts` — diagnostics monitor endpoints.
- `src/services/transactionService.ts` — legacy transactions/portfolio.
- The frontend is out of scope for Wave 0; no frontend changes were made.

## 10. Preserved / modified later / must be retired

**Preserved (untouched by the overhaul per `project_plan.md` and the
autobuild plan):** registration/login/JWT, balances, atomic buy/sell and
ledger rules (Core 4), portfolios, transaction history, price-history
schema/provenance and writers' batching guarantees, Core 1 cycle lifecycle
and recovery, Core 6 settlement and the immutable results snapshot,
leaderboard APIs, bot legality contract (same domain ops), diagnostics
gating, deployment workflow, production data.

**Modified in later waves (not Wave 0):**
- `game/marketDomain.js` pricing model — supplemented/replaced by the
  unified price engine (SIM-08) composing lifecycle + phase + coin events +
  trading pressure + noise.
- `models/market-simulator.js` — batch internals gain event/phase/lifecycle
  inputs; remains the single tick writer until SIM-08 consolidates the one
  authoritative price path.
- `game/apocalypseVolatility.js` amplitude curve — superseded by lifecycle
  pressure; may survive as reporting vocabulary.
- `game/marketSignalsService.js` / `GET /api/game/state` — extended with
  player-facing phase/event fields (SIM-15); hidden lifecycle stays hidden.
- `game/botService.js` decision layer — panic selling / dip buying /
  momentum / contrarian reactions (SIM-12), still through Core 4 ops.
- `game/collapseRiskDomain.js` — may be adapted to dynamic collapse risk.

**Must be retired/disabled before the dynamic collapse engine is enabled
(SIM-14 gate):**
- The old persisted scheduled collapse as the *execution* authority:
  `collapseScheduleService.executeDueCollapses()` and the
  `coin_collapse_schedule` writer role, plus its two call sites
  (`gameCycleService.ensureActiveCycle`, `gameSettlementService.
  settleSettlingCycle`) and the `COLLAPSE_WINDOW_START_PERCENT` timing
  model. It is deterministic and complete-cycle-covering today; running it
  beside SIM-13's market-reactive collapse would double-zero coins and
  fight the new engine. The final "all coins £0 by cycle end" guarantee
  must be re-provided by the dynamic engine's elapsed-time safety rule
  before retirement. Baseline restoration (`restoreBaselinePrices`) or an
  equivalent per-cycle price reset must also be re-homed.
- The static `apocalypseVolatility` amplitude as a pricing input, once
  lifecycle pressure exists (risk of double-applying late-cycle violence).

## 11. Wave 0 baseline

Recorded in `AUTOBUILD_STATE.md`: backend `npm test` — 80 suites passed,
1 suite failed; 759 passed, 1 timed out in
`__tests__/game-public-state-no-seed.test.js` (pre-existing 5s timeout).
That is the baseline this wave must not worsen.
