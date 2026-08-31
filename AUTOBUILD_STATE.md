# AUTOBUILD STATE

## Current Execution

- **Current wave:** Wave 7 — Balance Passes A–F and Release Gates
- **Current ticket:** SIM-25 (complete)
- **Status:** PLAYTEST READY — reviewed backend/frontend commits deployed and public API/game smoke verified
- **Current branch:** Backend `v2-legacy-cleanup-20260825`; frontend `gameplay-overhaul-20260830`
- **Latest successful commit:** Backend deployed `12f860aebd4d305a8b0382cbc15c8007a863e1f2`; frontend deployed `1bb44543300aa067234de30cd46fd29f03cf3e9b`
- **Last pushed commit:** Backend `12f860aebd4d305a8b0382cbc15c8007a863e1f2` on `main` and `v2-legacy-cleanup-20260825`; frontend `1bb44543300aa067234de30cd46fd29f03cf3e9b` on `master` and `gameplay-overhaul-20260830`
- **Last deployed commit:** Backend `12f860aebd4d305a8b0382cbc15c8007a863e1f2` via workflow run `33395514461`; frontend `1bb44543300aa067234de30cd46fd29f03cf3e9b` via workflow run `33395833840`
- **Database migration status:** Production workflow applied migrations 020–022 and reported production game-schema verification passed; no destructive seed was run in production
- **Review status:** Wave 7 strict review passed; frontend contract/UI review passed; both deployed workflows passed; exact deployed SHAs verified from workflow logs/remote heads. Browser visual smoke was unavailable because no Chrome instance could be launched; public HTML/assets/API smoke passed.
- **Blocking issue:** None
- **Next action:** None — stop after reporting `PLAYTEST READY`; monitor the known baseline public-state timeout separately.

## Startup Safety Check

- Uploaded/readable: `gameplay_changes.md`, `gameplay_build_plan.md`, `overnight_autobuild_plan.md`, and `AUTOBUILD_STATE_TEMPLATE.md` from `/home/jd/gameplay-overhaul/`.
- `project_plan.md`: now uploaded, read from the cache document, and archived at `/home/jd/gameplay-overhaul/project_plan.md`; it confirms MVP preservation, fantasy-simulator scope, Node/Express/PostgreSQL/JWT/VPS stack, and no real-money/crypto expansion.
- State file: created at this repository path from the uploaded template.
- Backend pre-existing work: preserved. Worktree had pre-existing untracked `.hermes/`; no reset, clean, overwrite, or discard was performed.
- Backend branch/worktree: `v2-legacy-cleanup-20260825`, ahead of its remote by four commits, with pre-existing untracked `.hermes/`.
- Frontend branch/worktree: was clean on `master`; a dedicated branch `gameplay-overhaul-20260830` was created without modifying tracked files.
- Remotes: both repositories use SSH GitHub remotes under `jdwd40`.
- Push access: confirmed for both repositories with `git push --dry-run`; no push was performed.
- Backend deployment workflow: `.github/workflows/deploy.yml` deploys only pushes to backend `main`, then resets the VPS checkout, installs dependencies, runs production migrations and schema verification, restarts PM2, and checks localhost health. A separate playtest target was not identified.
- Production/system state: no migration, deployment, restart, firewall, host, or production-data action was performed.

## Tests

- **Baseline backend:** `npm test` — 80 suites passed, 1 suite failed; 759 tests passed, 1 failed due to the recorded 5-second timeout in `__tests__/game-public-state-no-seed.test.js`; total 760 tests. Treat as baseline unless changed/worsened by this overhaul.
- **Baseline frontend:** `npm run test:ui` passed; `npm run test:unit` passed 216 tests; `npm run lint` passed with 0 errors and 6 existing warnings; `npm run build` passed with standard bundle-size/Browserslist warnings.
- **Latest targeted tests:** Wave 7 SIM-20..23 — focused suites `simulation-config`, `price-engine`, `multi-cycle-simulation`, `dynamic-collapse`, and `game-bot-exit-strategy`: 134/134 passed; three 200-cycle full-scenario CLI validations passed; frontend UI contract/unit/typecheck/lint/build passed.
- **Latest full tests:** Backend fresh independent `npm test` — 96 passed / 97 total suites and 1011 passed / 1012 total tests; sole failure is the known baseline timeout in `__tests__/game-public-state-no-seed.test.js`; the prior seed-corruption run was classified as shared disposable-DB setup flake and was cleared by fresh reseed.

## Current Wave Audit Notes

- Current backend already contains an older V2 deterministic market domain (`game/marketDomain.js`) and headless simulator (`simulation/`).
- Current live price writer is `models/market-simulator.js`, which calls `marketDomain.evaluateMarketPoint()` and persists `coins.current_price` plus price history.
- Current dynamic collapse authority is `game/dynamicCollapseService.js`, persisted in `apocalypse_coin_collapses`; the legacy `coin_collapse_schedule` table is preserved historical data only and is not read or written by runtime code.
- Current cycle authority/recovery is `game/gameCycleService.js`; bots use `game/botWorker.js`/`game/botService.js`; price history is written by the market writer and dynamic collapse executor; settlement uses `game/gameSettlementService.js`.
- Wave 4 replaces the old fixed scheduled-collapse runtime with the market-reactive dynamic engine, keeps the single advisory lock, and applies the final exact-£0 settlement safety rule.
- Wave 1 adds separate deterministic coin-event and market-phase engines, additive migration 020, disposable-schema wiring/verification, and Core 1 lifecycle integration. It does not alter the existing price writer, scheduled collapse authority, trade rules, portfolios, transaction history, price history, settlement, or public API shapes.
- Coin events use rolling seeded persistence, 0–5 active-per-coin cap, 1–15 minute durations, separate flavour/name and signed modifier fields, expiry by timestamp, and no portfolio/trade/price-history coupling.
- Market phases use all six required phase types, lifecycle-weighted deterministic selection with GROWTH wired until Wave 2, one contiguous persisted primary chain, and restart/idempotency coverage.
- Wave 2 adds separate `apocalypse_market_state` persistence, canonical surviving-coin market index calculation, monotonic peak/drawdown/momentum tracking, seed-generated plateau targets, and hidden legal-order lifecycle transitions. It does not write prices or price history and leaves the scheduled-collapse authority in place until Wave 4.
- Wave 3 adds pure `game/priceEngine.js` and `game/pricingContext.js`, composing the existing market-domain baseline with bounded lifecycle/phase/event modifiers, seeded crash episodes, rally recovery, late lower-high behaviour, and shared live/headless price parity. The live market writer remains the only price/history writer; scheduled collapse remains the sole death authority until Wave 4.
- Strict review correction enforced negative bias strictly above 1, non-decreasing crash probability through the lifecycle, and both positive/negative phase groups remaining possible in every lifecycle state.

## Completed Tickets

- SIM-01 Audit current authoritative market simulation
- SIM-02 Centralise simulation configuration
- SIM-03 Implement coin event engine
- SIM-04 Add coin event persistence/state recovery
- SIM-05 Implement market phase engine
- SIM-06 Add market index and peak/drawdown tracking
- SIM-07 Implement hidden lifecycle state machine
- SIM-08 Integrate unified normal price calculation
- SIM-09 Implement crash engine
- SIM-10 Implement rally and lower-high behaviour
- SIM-11 Add bounded buy/sell pressure
- SIM-12 Adapt bot reactions to panic and dip buying
- SIM-13 Implement dynamic coin collapse pressure
- SIM-14 Retire/disable old scheduled collapse logic
- SIM-15 Extend game-state API with player-facing events/phases
- SIM-16 Add market-phase frontend UI
- SIM-17 Add active coin-event frontend UI
- SIM-18 Build automated multi-cycle simulation harness
- SIM-19 Add simulation quality/failure metrics
- SIM-20 Balance growth and coin-event drain
- SIM-21 Balance plateau and decline
- SIM-22 Balance crash/rally behaviour
- SIM-23 Balance dynamic collapse
- SIM-24 Full regression and readiness review
- SIM-25 Controlled playtest deployment

## Remaining Tickets

- None — gameplay overhaul is deployed and playtest-ready

## Wave 7 Balance Tuning Record (SIM-20..23)

- Method: K3 parameter sweeps through `simulation/run.js --mode multi-cycle` with UNMODIFIED thresholds; 100-cycle market+events sweeps per candidate to reject weak knobs, 200-cycle full-scenario CLI validations for acceptance; candidate metrics recorded under `/tmp/w7-*.json` only. Root-cause finding: the three failing flags shared one dominant driver — the dynamic-collapse pre-decline cap (0.01/30s evaluation) killed coins early, and each early death REMOVED that coin from the market index, dragging it below the starting index by 25% progress.
- Pass order followed: event bias, early growth, rally/crash, dynamic collapse (iterating as interactions were measured).
- Final config changes (all in `game/simulationConfig.js` defaults; single source of truth, production/simulation parity preserved):
  - `dynamicCollapse.preDeclineRiskCap` 0.01 -> 0.003 (SIM-23): pre-decline death now rare/variable; DECLINE/COLLAPSE risk untouched (maxRiskPerEvaluation 0.10). Dynamic collapse NOT weakened — late-game risk path unchanged.
  - `lifecycle.growthSupportModifier` 0.012 -> 0.12 (SIM-20/21): the domain baseline has no secular growth and starts scattered ~3% below baseline; measured level that keeps the early index supported.
  - `crashRally.episodeGapMs` {2-6min} -> {1-3min} and `crashRally.crashProbability` 0.02/0.04/0.08/0.12 -> 0.06/0.10/0.12/0.16 (SIM-22): enough candidate episodes and activations for reliable crash/rally cadence; non-decreasing lifecycle ordering kept.
  - `crashRally.recoveryStrength.early` {0.90-1.10} -> {1.00-1.25} (SIM-22): early crashes reliably recover to new highs (Rule 3); late range unchanged (0.40-0.80, lower highs intact).
  - Event bias UNCHANGED (negativeBiasFactor 1.25): sweeps showed event drain was not the early-growth driver; ratio stays in the 1.20-1.30 design band.
- Acceptance (200 cycles, full market+pressure+events scenarios, unmodified thresholds, exit 0 on all three):
  - default seed `sim18-multi-cycle-base-seed`: prematureMassCollapse 0/200 (<=4), noMeaningfulRally 4/200 (<=20), negativeEventsKillEarlyGrowth 44/200 (<=50); all 9 other flags PASS.
  - alt seed `wave7-alt-seed-alpha`: 0/200, 10/200, 38/200; all others PASS.
  - alt seed `wave7-alt-seed-beta`: 0/200, 5/200, 37/200; all others PASS.
- No previously passing flag worsened: lateCrashFullRecovery 0/953 full recoveries (default), negative:positive modifier ratio 1.269/1.2608/1.2397 (slight negative bias kept), peak growth max 2.2058/2.2925/2.3558x (bound 50; baseline was 2.1692x), exact final £0 with zero survivors every cycle, deterministic replay 0 mismatches, 16 distinct events / 6 phases / 0 zero-event cycles, identical collapse-order pairs 0%, forced safety collapses mean 0.65-0.70/cycle.
- Validation command: `node simulation/run.js --mode multi-cycle --cycles 200 [--base-seed <seed>]` (exit 0 = PASS).
- Focused regression updates: `__tests__/simulation-config.test.js` (three boundary tests now derive from the tuned defaults instead of pinning 0.012/0.04/1.10-era values) and `__tests__/price-engine.test.js` (composed-modifier expectation follows the 0.12 growth support). No test encodes a single seed's exact numbers.

## Known Non-Blocking Issues

- Backend baseline contains one existing timeout failure in the public-state/results test; Wave 0 did not worsen or affect it. It remains a pre-existing suite issue to track before final readiness.
- Frontend lint has six warnings and the build reports normal bundle-size/Browserslist warnings.

## Deployment Verification (2026-08-31)

- Backend remote `main` promoted by fast-forward to `12f860aebd4d305a8b0382cbc15c8007a863e1f2`; Actions run `33395514461` succeeded. Its log verified VPS reset to the exact SHA, production migrations, schema verification, PM2 restart, and localhost health.
- Frontend remote `master` promoted by fast-forward to `1bb44543300aa067234de30cd46fd29f03cf3e9b`; Actions run `33395833840` succeeded. Build, UI/type verification, SSH access, static sync, and public URL check all passed.
- Public smoke: `/coins/`, reviewed JS/CSS assets, `/api-2/api/coins`, `/api-2/api/game/state`, and `/api-2/api/game/market-signals` returned valid responses. Live state was `ACTIVE`, Apocalypse `APOC-0474`, 10 coins, public phase/event fields present, and no seed/lifecycle/sequence/peak-target/schedule data. Unauthenticated participant access returned 401; diagnostics remained fail-closed.
- The public coarse `collapseRisk` vocabulary is an existing allowed player-facing bucket (`DEAD`/`CRITICAL`/`DANGER`), not a hidden numeric probability; Wave 5 contract tests and deployed payload agree.
- Browser visual smoke was attempted but unavailable because the browser harness could not launch Chrome; no visual claim is made. Public HTML/assets and API/game smoke are verified.

## Decisions / Notes

- `project_plan.md` has now been read and confirms the preserved application behaviour and safety constraints.
- `gameplay_changes.md` defines desired new gameplay.
- `gameplay_build_plan.md` defines the implementation sequence.
- `overnight_autobuild_plan.md` defines the autonomous wave gates.
- Do not allow old scheduled collapse logic and new dynamic collapse logic to operate simultaneously.
- Stop after the exact reviewed build is deployed and verified as PLAYTEST READY.
