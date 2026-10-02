# Coins Software Architecture — LLM Report

**As of:** 2026-09-12  
**BE:** `/workspace/coins-arch-be` @ `4601dfa` (runtime base `e69c019`)  
**FE notes:** `/workspace/arch-notes-fe.md` @ `012631e`  
**Prod:** BE `main`, FE `master` · API `https://jdwd40.com/api-2/api` · UI `https://jdwd40.com/coins/`  
**Rule:** code wins; mark UNCERTAIN; do not invent beyond notes.

---

## 1. Repo orientation

| Item | Value |
|---|---|
| Entry | `server.js` (`npm start` → `node server.js`); `package.json` `"main":"index.js"` MISMATCH |
| App | `app.js` Express factory |
| Env | `db/connection.js` loads `.env.${NODE_ENV\|\|development}` |
| Prod process | pm2 `back_coins_x` |
| Migrations | `db/migrate.js` runs canonical `007`–`032`; baselines `001`–`006` |
| Latest mig | `032_create_director_decision_history.sql` (+ `030`/`031` refractory) |
| Tests | Jest `__tests__/` `--runInBand` |
| FE basename | `/coins` (`vite.config.ts` + `BrowserRouter`) |

---

## 2. Entry points & runtime processes

| Process | Start site | Gate | Cadence | Function |
|---|---|---|---|---|
| HTTP | `server.js` `startServer` → `app.listen` | always | — | PORT\|\|3000 |
| Market writer | `app.js` L148–150 `marketSimulator.start()` | `NODE_ENV==='production'` | 30s | `MarketSimulator.startPriceUpdates` → `updateAllPrices` |
| Bot worker | `server.js` listen cb | production | default 60s | `persistentBotWorker.start` → `persistentBots.runPersistentBotTick` |
| Replacement | `server.js` listen cb | production | 60s hardcoded | `persistentReplacementWorker.start` → `reconcilePersistentReplacements` |
| Adaptive Director | inside writer | — | per batch / endsAt | `adaptiveDirectorRuntime.runAdaptiveDirectorEvaluation` |
| Legacy cycle/bot/economy workers | imported `server.js` | **never `.start()` in prod** | — | — |
| `services/rollup-service.js` | nowhere | DEAD | — | — |

Shutdown (`server.js` `shutdown`): stop all known workers + marketSimulator → close HTTP → `db.end()`; force after 10s.

JWT prod gate: blank `JWT_SECRET` → `process.exit(1)` before listen (`server.js`).

---

## 3. Module responsibility map (production-critical)

### `server.js`
- **Responsibility:** bootstrap, JWT gate, listen, prod workers, SIGTERM/SIGINT shutdown
- **Called by:** `npm start` / `require.main`
- **Calls:** `app`, `persistentBotWorker`, `persistentReplacementWorker`, db ping
- **Reads/Writes:** process env; no game tables
- **Invariants:** workers only after successful listen; import alone starts nothing
- **Tests:** `server-lifecycle.test.js`

### `app.js`
- **Responsibility:** Express, CORS, mounts, error middleware, prod market start
- **Calls:** routers; `marketSimulator.start()` if production
- **Invariants:** CORS allows FRONTEND_URL + localhost set; credentials true

### `middleware/auth.middleware.js` — `authenticateToken`
- Bearer split → `jwt.verify(token, getJwtSecret())` → `selectUserById(decoded.user_id)` → `req.user`
- 401 on missing/invalid/expired/gone user
- **Danger:** profile routes use path `user_id` without comparing `req.user.user_id` (P1)

### `utils/jwtSecret.js` — `getJwtSecret`
- Prod throw if blank; test/dev fallbacks

### `routes/persistent.routes.js` + `controllers/persistent.controller.js`
| Handler | Calls |
|---|---|
| `buyPersistent` | `persistentEconomy.buyPersistentTrade` |
| `sellPersistent` | `persistentEconomy.sellPersistentTrade` |
| `getMyPersistentAccount` | `getPersistentAccountState` |
| `getMyPersistentTransactions` | `getPersistentTransactions` |
| `getPersistentLeaderboard` | `persistentLeaderboard.getPersistentLeaderboard` |
| `getPersistentMarketSignals` | `persistentMarketSignalsService.getPersistentMarketSignals` |
| `getPersistentRuntime` | `persistentRuntimeService.getPersistentRuntime` |

Auth: buy/sell/account/transactions JWT; leaderboard/signals/runtime public.

### `game/persistentEconomy.js`
- **Writes:** `persistent_accounts`, `persistent_holdings`, `persistent_transactions`
- **Reads:** `coins`, world, holdings
- **Invariants:** server price; min £0.01; qty ≤8 dp; coins FOR UPDATE before account; DEAD blocked both sides; **retired blocked on buy only**
- **Called by:** persistent controller, `persistentBots`
- **Tests:** `persistent-economy-db.test.js`, `persistent-api.test.js`

### `models/market-simulator.js` — `MarketSimulator`
- **Cadence:** `priceUpdateInterval=30000`
- **Core:** `updateAllPrices({nowMs})` (see §7)
- **Memory:** `lastBatch` only for `/market/status`
- **Lock order:** coins → world → director/state/checkpoints
- **Tests:** `market-persistent-writer.test.js`, `wave3-writer-event-runtime.test.js`

### `game/persistentPricing.js` — `persistentPriceAt` / `computePersistentPrice`
- Consumes director environment + eventModifier + coin state
- Depends on `priceEngine` (active shared)

### `game/marketDirector.js`
- Pure seeded regimes; `createMarketDirectorProvider`; `resumeDirectorCursor`; `publicRegimeAt`
- Persist via `marketDirectorState.model` `upsertDirectorState` / `loadDirectorState`

### `game/adaptiveDirector.js` + `adaptiveDirectorRuntime.js` + `adaptiveDirectorObservation.js` + `adaptiveDirectorEventPlan.js`
- Modes NORMAL|BOOM|BUST|RESCUE; refractory ~20m; Golden/Demon
- Runtime: load control → observe → evaluate → upsert; commit → append decision
- Planner → event targets for reconcile
- **Public:** summaryCode only via `persistentRuntimeService`
- **Stale:** `simulationConfig` comments “NOT wired” — ignore
- **Tests:** `adaptive-director*.test.js`, `director-decision-history-model.test.js`

### `game/persistentCoinEventRuntime.js` + `persistentCoinEventDomain.js`
- `reconcilePersistentCoinEvents`; `netActiveModifierCapped`; duration 1–15m; max 5 active/coin
- Table `persistent_coin_events` UNIQUE `(world_id,coin_id,event_seq)`

### `game/persistentCoinDeath.js`
- `decideAuthoritativePersistentDeath` after living price; `applyAuthoritativePersistentDeath` (price 0, history, checkpoint, recordDeath)

### `game/persistentBots.js` + `persistentBotWorker.js` + `botConfig.js` + `persistentDebt.js`
- Claim `persistent_bot_ticks`; 4 personalities; same economy; bot loans only
- RNG: `botService.createBotRandom` (shared helper; cycle worker not started)

### `game/persistentReplacementRuntime.js` + `persistentReplacementWorker.js` + `replacementPool.js`
- Delay `replacementDelayMs: 6*HOUR_MS`; ≤1 authored insert per eligible death; soft-retire DEAD

### `game/persistentWorld.js` — `resolveActiveWorld`
- Fail loud if none/corrupt; used before economy txn and before writer txn

### Models (state)
| PATH | Writes | Reads |
|---|---|---|
| `models/marketCoinState.model.js` | upsertCoinState | loadCoinStates |
| `models/marketDirectorState.model.js` | upsertDirectorState | loadDirectorState |
| `models/directorControlState.model.js` | upsert | load |
| `models/directorDecisionHistory.model.js` | appendDirectorDecision | recent |
| `models/pricingCheckpoint.model.js` | upsertCheckpoint | loadCheckpoints |
| `models/persistentCoinEvents.model.js` | insert/reconcile | active |
| `models/priceHistory.model.js` | — | getPriceHistory MARKET_TICK+null cycle |
| `models/users.model.js` | create/auth jwt.sign 24h | selectUserById |
| `models/coins.model.js` | — | catalogue |

### FE critical modules (from FE notes)
| PATH | Responsibility |
|---|---|
| `src/App.tsx` | basename `/coins`; PlayerShell; routes; classic 2s useFetch |
| `src/context/AuthContext.tsx` | register/login; localStorage `token`/`user`; fabricated funds 1000 fallback |
| `src/context/PersistentContext.tsx` | 5s allSettled; trade; sync gate; runtime 15s stale |
| `src/services/persistentService.ts` | parsers; forbidCycleFields; trade `{coin_id,quantity}` |
| `src/services/apiConfig.ts` | DEFAULT `https://jdwd40.com/api-2/api` |
| `src/utils/persistentSyncGate.ts` | account apply generation |
| Unmounted | GameProvider, BuyForm, SellForm, ApocalypseHeader, Results* |

---

## 4. API map

### Primary `/api/persistent`
| Method | Path | Auth | Downstream |
|---|---|---|---|
| POST | `/trades/buy` | JWT | `buyPersistentTrade` |
| POST | `/trades/sell` | JWT | `sellPersistentTrade` |
| GET | `/account` | JWT | `getPersistentAccountState` |
| GET | `/transactions` | JWT | `getPersistentTransactions` |
| GET | `/leaderboard` | public | `getPersistentLeaderboard` |
| GET | `/signals` | public | signals; director `{regime,intensity}` only |
| GET | `/runtime` | public | mode/direction/roles/events/recentDecisions.summaryCode |

### Supporting
| Mount | Notes |
|---|---|
| GET `/api/coins`, `/:id`, `/:id/price-history` | public; history provenance filter |
| GET `/api/market/status\|stats\|price-history` | public; status events field empty |
| POST `/api/users/register\|login` | public; register provisions persistent best-effort + joinRound best-effort |
| GET/PUT/DELETE `/api/users/:user_id` | JWT **no ownership** — P1 |
| PATCH `/api/users/:user_id/funds` | JWT → always 403 retired |
| `/api/game/*` | legacy cycle compat still mounted |
| `/api/transactions/*` | legacy users.funds/portfolios still writable |
| `/api/game/diagnostics/*` | `GAME_DIAGNOSTICS_TOKEN`; unset → 404 |

---

## 5. Database map

### Persistent primary
`market_worlds`, `market_coin_state`, `market_director_state`, `director_control_state`, `director_decision_history`, `persistent_coin_events`, `market_price_checkpoints`, `persistent_accounts`, `persistent_holdings`, `persistent_transactions`, `persistent_loans`, `persistent_bot_ticks`, `users`, `coins`, `price_history`, `market_history`, `schema_migrations`

### Legacy retained
`apocalypse_*` (cycles, participants, holdings, transactions, bots, events, phases, collapses, …), `portfolios`, `transactions`, `users.funds`

### Non-executed SQL present
`02-add-user-balance.sql`, `20250223_create_market_history.sql`, `create_coin_statistics.sql`, `*.bak`

---

## 6. Invariants (enforce in agents)

1. Single active `market_worlds` or fail closed.
2. Live price authority = `coins.current_price` mutated by writer/death/replacement — not clients.
3. Player chart rows: `source='MARKET_TICK' AND cycle_id IS NULL`.
4. Trade body never trusts client price; JWT user only.
5. Lock order coins → account (economy); coins → world → director (writer). Inverse = deadlock risk.
6. DEAD ⇒ price 0; never revive; no buy/sell.
7. Buy rejects `retired`; sell does **not** check retired (asymmetry).
8. Adaptive public API: no seed, raw reason, decisionIndex, future schedule.
9. Bot ticks claimed via `persistent_bot_ticks` PK before trading.
10. Migrations additive; deploy does not auto-provision world.
11. FE player routes must not mount GameProvider (ui-contract).
12. FE trade payload exactly `{coin_id, quantity}`.

---

## 7. Exact call chains

### Buy
`authenticateToken` → `controllers/persistent.controller.js:buyPersistent` → `persistentEconomy.buyPersistentTrade`  
→ `validateIds`/`validateQuantity` → `persistentWorld.resolveActiveWorld(db)`  
→ `BEGIN` → `SELECT coins … FOR UPDATE` → reject retired/DEAD/price≤0  
→ `lockOrProvisionAccount` (£10000 ON CONFLICT DO NOTHING then FOR UPDATE)  
→ `assertMinTradeValue` → `UPDATE cash WHERE cash>=total` → holdings upsert cost_basis+=total  
→ `INSERT persistent_transactions BUY` → `getPersistentAccountState` → `COMMIT`  
→ HTTP 201 `{transaction, account}` → FE adopt + `syncNow`

### Sell
Same chain with `sellPersistentTrade`: no retired check; lock holding; proportionate cost_basis; credit cash; `SELL` ledger.

### Market tick `updateAllPrices({nowMs})`
1. `batchNowMs`  
2. `persistentWorld.resolveActiveWorld(db)` **before** txn  
3. `resolveSimulationConfig()`  
4. `BEGIN`  
5. `SELECT … FROM coins ORDER BY coin_id FOR UPDATE`  
6. `loadCoinStates` / `loadDirectorState` / `loadCheckpoints`  
7. `adaptiveDirectorRuntime.runAdaptiveDirectorEvaluation`  
8. if committed → `appendDirectorDecision` (`summaryCodeForReason`)  
9. `planAdaptiveEventTargets`  
10. `persistentCoinEventRuntime.reconcilePersistentCoinEvents` → `activeEventsByCoin`  
11. `marketDirector.createMarketDirectorProvider` + `resumeDirectorCursor`  
12. Per coin: skip retired non-roster; init state; DEAD must price===0 else abort;  
    `netActiveModifierCapped` → `calculateNewPrice`→`persistentPriceAt` + `computePersistentPrice`;  
    recentLogReturn from `price_history` PERSISTENT_PH; `advanceCondition`/`advanceStructuralReference`/`advancePeakReference`;  
    `extractPersistentCheckpoint`; `decideAuthoritativePersistentDeath`; if die → `applyAuthoritativePersistentDeath` continue;  
    else UPDATE price, INSERT price_history (`cycle_id NULL`, `source MARKET_TICK`, `created_at=batchInstant`), upsertCheckpoint, upsertCoinState, accumulate value  
13. `upsertDirectorState` (long regime)  
14. INSERT `market_history`  
15. `gameRoundService.reconcileActivePeaks` (legacy)  
16. `COMMIT` / rollback; set `lastBatch`

### Bot tick
`persistentBotWorker` → `tickId=floor(now/interval)` → claim `persistent_bot_ticks` → if claimed `runPersistentBotTick` → personalities → `buyPersistentTrade`/`sellPersistentTrade` + optional `persistentDebt.issueBotLoan`

---

## 8. Director / event / bot internals (dense)

**Long:** regimes GOLDEN_AGE|BOOM|BULL|BEAR|BUST|RECESSION; seeded `createSeededRandom(\`${seed}:persistent-director:regime:${index}\`)`; hours; `market_director_state`.

**Adaptive:** observe 30m lookback; retain window until endsAt unless RESCUE/role rotation; NORMAL swing 8–14m; intervention 2–10m; refractory 20m / emergency 5m; Golden/Demon 10–30m exclusive; events via planner not direct price set; history unique `(world_id, decision_index)`.

**Events:** sources NORMAL|GOLDEN|DEMON|RESCUE|DIRECTOR; individual mod ≤0.05; net ≤0.06; expire historically (no surplus trim).

**Bots:** `GAME_BOTS_ENABLED` can disable; loan amount `PERSISTENT_BOT_LOAN_AMOUNT` default 10000; leaderboard `netWorth=cash+holdingsValue-debt`.

---

## 9. FE data contracts

| Endpoint | Parser | Key fields |
|---|---|---|
| `/persistent/signals` | `parsePersistentMarketSignals` | coins price/dead/status/archetype/momentum; director regime+intensity |
| `/persistent/runtime` | `parsePersistentRuntime` | director mode/direction/roles/recentDecisions; per-coin events |
| `/persistent/account` | `parsePersistentAccountResponse` | provisioned false\|true+account |
| `/persistent/trades/*` | `parsePersistentTradeResult` | body `{coin_id,quantity}` |
| `/persistent/leaderboard` | `parsePersistentLeaderboard` | authoritative rank; no client re-sort |

Poll: `PERSISTENT_POLL_INTERVAL_MS=5000`; runtime stale 15s; classic secondary 2000ms. Charts: 5M→request 10M then window. Token: localStorage; monitor token memory-only.

---

## 10. Price provenance

| Pattern | Writer | Use |
|---|---|---|
| MARKET_TICK + cycle_id NULL | writer / death | player charts, signals lookbacks, observation |
| MARKET_TICK/COLLAPSE + cycle_id | legacy apocalypse | monitor |
| NULL provenance | pre-mig 019 | must not treat as persistent |

---

## 11. Txn boundaries & concurrency

| Path | Boundary | Locks |
|---|---|---|
| buy/sell | single client BEGIN…COMMIT | coin then account (sell: holding) |
| market tick | single client BEGIN…COMMIT | all coins ordered, then world/director/state |
| bot tick claim | INSERT ON CONFLICT DO NOTHING | PK tick |
| Adaptive eval | inside writer txn | control state upsert |

**Dangerous zones:** inverse lock order; multi-pm2 writers (UNCERTAIN ops); legacy `/api/transactions` mutating funds; profile IDOR; dual registration provision side-effects; starting legacy workers would race prices.

---

## 12. Legacy inventory

| Item | Status |
|---|---|
| `/api/game/*`, gameCycleService, joinRound | Compatibility-only |
| botWorker / economyWorker / gameCycleWorker | Not started prod |
| `/api/transactions` funds/portfolios | Compatibility writable |
| Apocalypse monitor diagnostics | Active internal |
| rollup-service, Nest src/market | DEAD |
| FE GameContext, BuyForm/SellForm, ApocalypseHeader, Results* | Unmounted leftover |
| Writer `reconcileActivePeaks` | Active side-effect of writer (compat) |

---

## 13. Testing map

BE strong: `persistent-economy-db`, `persistent-api`, `market-persistent-writer`, `adaptive-director*`, `persistent-coin-event*`, `persistent-bots`, `persistent-coin-death`, `persistent-replacement*`, `persistent-runtime-api`, `deploy-workflow`, `verify-persistent-world`, `verify-price-history-provenance`, lock-order/atomicity suites. Cycle-era suites still execute.

FE: `test:unit` (tsx node:test); `test:ui` scripts/ui-contract.mjs; deploy = ui+tsc+build only.

---

## 14. Deploy / migration rules

BE on push `main`: fetch/reset → npm install → migrate → verify:game-schema → verify:persistent-world → pm2 restart → curl coins → curl signals (worldId + coins.length>0). No provision on deploy.

FE on push `master`: npm ci → test:ui → tsc → build → rsync dist to `/var/www/jdwd40.com/html/coins` → curl UI.

Migrations: only `NNN_*.sql` 007+; never invent schema; additive preferred.

---

## 15. Doc vs code (record)

- FE `index.html` title Apocalypse Exchange
- Auth fabricated funds 1000 vs £10k persistent
- FE README omits Wave4 PersistentDirectorPanel (code has it)
- Classic useFetch 2s vs persistent 5s
- FE deploy skips test:unit
- Secondary CoinDetail `/market/status` events vs primary runtime events
- users/:user_id ownership bug
- market/status events always empty
- package.json main index.js vs server.js
- project_plan Wave4 “not deployed” → NOW deployed (e69c019 + FE #21)
- simulationConfig “NOT wired” comments stale
- sell does not check retired (buy does)

---

## 16. Known questions (UNCERTAIN)

1. Multi-instance pm2 for `back_coins_x`?
2. Sell-without-retired intentional?
3. `market_history.created_at` default vs explicit stamp?
4. Full apocalypse_* constraint DDL detail
5. External cron starting legacy workers?
6. Live env values (bot interval, diagnostics token, FRONTEND_URL)
7. Nest src/market ever live historically?
8. Exact `persistent.death.riskThreshold` numeric (see simulationConfig)
9. Importance of reconcileActivePeaks without cycle worker
10. Whether non-canonical SQL created rollups/statistics in prod DB
11. FE nginx SPA fallback for `/coins/profile` and internal routes
12. Whether register always provisions before first trade in prod (FE treats provisioned:false as real)

---

## 17. Agent Quick Start

Repos: `jdwd40/back_coins_x` @ `4601dfa` (this doc set); `jdwd40/fcoins_y` @ `012631e`.

If changing authentication, inspect:
- `middleware/auth.middleware.js`, `utils/jwtSecret.js`, `server.js` (prod JWT gate)
- `models/users.model.js` (`jwt.sign` 24h), `controllers/users.controller.js`
- FE `src/context/AuthContext.tsx`, `src/services/apiConfig.ts`
- `bugs.md` (profile IDOR)

If changing trading, inspect:
- `routes/persistent.routes.js`, `controllers/persistent.controller.js`
- `game/persistentEconomy.js` (`buyPersistentTrade`, `sellPersistentTrade`)
- FE `src/services/persistentService.ts`, `src/context/PersistentContext.tsx` (`trade`)
- `src/components/PersistentTradePanel.tsx`, `src/utils/persistentTrading.ts`

If changing portfolio logic, inspect:
- `game/persistentEconomy.js` (`getPersistentAccountState`, holdings upsert / proportionate basis)
- `persistent_accounts`, `persistent_holdings`, `persistent_transactions`
- FE `PlayerStatusStrip`, `Profile`, `PlayerRoundPanel`

If changing pricing, inspect:
- `models/market-simulator.js` `updateAllPrices` / `calculateNewPrice`
- `game/persistentPricing.js` (`persistentPriceAt`, `computePersistentPrice`, condition/reference/peak)
- `models/pricingCheckpoint.model.js`, `market_price_checkpoints`
- Provenance: `source='MARKET_TICK' AND cycle_id IS NULL`

If changing Director behaviour, inspect:
- Long: `game/marketDirector.js`, `models/marketDirectorState.model.js`
- Adaptive: `game/adaptiveDirector.js`, `adaptiveDirectorRuntime.js`, `adaptiveDirectorObservation.js`
- `models/directorControlState.model.js`, `models/directorDecisionHistory.model.js`
- Public: `game/persistentRuntimeService.js` — never leak seed/raw reason

If changing events, inspect:
- `game/adaptiveDirectorEventPlan.js`, `persistentCoinEventRuntime.js`, `persistentCoinEventDomain.js`
- `models/persistentCoinEvents.model.js`, migration `029`
- FE `PersistentDirectorPanel`, `GameCoinDetail`, `persistentCountdown.ts`

If changing bots, inspect:
- `game/persistentBotWorker.js`, `persistentBots.js`, `botConfig.js`, `persistentDebt.js`
- Same economy functions as humans; `persistent_bot_ticks` claim
- Do not start `game/botWorker.js` in production

If changing charts/history, inspect:
- BE `models/priceHistory.model.js`, `controllers/market.controller.js` `getMarketPriceHistory`
- FE `src/utils/marketHistoryChart.ts`, `MarketValueChart.tsx`, `PriceChart.tsx`, `src/utils/sparkline.ts`
- 5M → API 10M + client window; no ALL/>12h in player selectors

If changing deployment, inspect:
- BE `.github/workflows/deploy.yml`, `db/migrate.js`, `db/verify-game-schema.js`, `db/verify-persistent-world.js`
- `docs/persistent-world-ops.md`
- FE `.github/workflows/deploy.yml` (test:ui + tsc + build + rsync)

Do not:
- start legacy workers on the production path
- trust client prices
- invert coins-before-world lock order
- expose Director seed or raw reason
- mix cycle `price_history` into player charts
- mount `GameProvider` on player FE routes
- invent migrations or change app source in doc-only tasks

---

*End LLM report — 12 Sep 2026.*
