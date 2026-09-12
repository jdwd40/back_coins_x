# Apocalypse → persistent cutover audit (PR #42)

Classification of remaining cycle/Apocalypse-era modules after the player runtime removal.
**Delete policy:** only proven-unused runtime code. Diagnostics and historical tables stay.

## Live production runtime (required)

| Module | Role |
|---|---|
| `models/market-simulator.js` | Sole live price writer (Director + events + death inside batch) |
| `game/persistentBotWorker.js` / `persistentBots.js` / `persistentBotProvisioning.js` | Persistent roster bots |
| `game/persistentReplacementWorker.js` + replacement runtime | Soft-retire + authored replacements |
| `game/persistentEconomy.js`, `persistentDebt.js`, `persistentLeaderboard.js`, … | Persistent account/trade/board |
| `game/adaptiveDirector*`, `persistentCoinEvent*`, `marketDirector.js`, `persistentPricing.js` | Writer-owned market mood / pricing |
| `game/persistentRuntimeService.js`, `persistentMarketSignalsService.js` | Public read APIs |
| `routes/gameDiagnostics.routes.js` + diagnostics services | Token-gated operator monitor |
| `controllers/transactions.controller.js` + `dynamicCollapseService` | Legacy funds buy/sell + portfolio reads (still mounted; not round/cycle) |

## Diagnostics only (retain)

| Module | Notes |
|---|---|
| `game/gameDiagnosticsService.js` | Cycle monitor series / participants / bots |
| `game/persistentDiagnosticsService.js` | Persistent snapshot for the same router |

## Test / offline simulation tooling (retain for now)

Cycle island still used by Jest and offline scripts (not started in production):

- `game/botService.js` — cycle decision engine; re-exports provisioning helpers
- `game/gameRoundService.js`, `gameCycleService.js`, `gameSettlementService.js`, `economyService.js`
- `game/marketSignalsService.js`, `gameResultsService.js`, `apocalypseVolatility.js`, `priceEngine.js` (also used by persistent pricing/checkpoint seams)
- `simulation/run.js` and round modes — **npm scripts removed**; files kept for offline study until a separate deletion PR
- Large `__tests__/game-*.test.js` / `v2-*.test.js` suites

## Proven removed (this PR lineage)

- `game/gameCycleWorker.js`, `botWorker.js`, `economyWorker.js` + dedicated worker tests
- `routes/game.routes.js`, `controllers/game.controller.js` (player `/api/game/*`)
- Registration `joinRound`
- Writer `reconcileActivePeaks`
- npm scripts: `simulate`, `simulate:power`, `simulate:v2-3`, `simulate:bots`, `simulate:multi-cycle`

## Uncertain / future work (do not delete here)

- Dropping historical Apocalypse tables (needs explicit archival migration)
- Deleting the cycle test island + `simulation/run.js` once no longer needed
- Retiring `/api/transactions/buy|sell` if product fully standardises on `/api/persistent/*`
- Independent production STF / StellaFortune zero-price + missing collapse record (deployment blocker; not this cutover)

## Independent deployment blocker

Canonical coin **STF / StellaFortune** may be retired while still participating in a deployment invariant, with a zero-priced coin lacking the expected executed collapse record. **Do not** bypass the invariant, mutate production, or weaken validation in this PR. Repair separately before deploy.

## Jest HTTP suite quarantine

`jest.config.js` ignores retired player `/api/game` HTTP suites; see that file for the list. Coverage for 404s is `__tests__/game-api-cutover.test.js`.
