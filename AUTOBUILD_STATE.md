# AUTOBUILD STATE

## Current Execution

- **Current wave:** Wave 6 — Automated Multi-Cycle Simulation and Balance
- **Current ticket:** SIM-18
- **Status:** IN PROGRESS — Wave 6 simulation-harness inspection
- **Current branch:** Backend `v2-legacy-cleanup-20260825`; frontend `gameplay-overhaul-20260830`
- **Latest successful commit:** Backend `b7761d50297b411eb24c83f37feb6db42584f1e6`; frontend `1bb44543300aa067234de30cd46fd29f03cf3e9b`
- **Last pushed commit:** Backend `b7761d50297b411eb24c83f37feb6db42584f1e6` on `v2-legacy-cleanup-20260825`; frontend `1bb44543300aa067234de30cd46fd29f03cf3e9b` on `gameplay-overhaul-20260830`
- **Last deployed commit:** Not checked
- **Database migration status:** Local disposable test DB migration 022 applied and schema verification passed; production not checked or applied
- **Review status:** Wave 5 strict backend API and frontend contract/UI review passed; explicit public-field redaction, server-time countdowns, mobile wrapping, and preserved trade/auth paths verified. No unresolved significant findings.
- **Blocking issue:** None
- **Next action:** Build the accelerated multi-cycle simulation harness and quality metrics for SIM-18/19, then balance Waves 6–7 from measured runs.

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
- **Latest targeted tests:** Wave 5 backend API/fixture batch — 6 suites, 52 tests passed; seed search returned the documented safe seed; frontend UI contract passed; frontend unit tests passed 220; frontend typecheck/build passed; lint passed with 0 errors and 6 existing warnings.
- **Latest full tests:** Backend `npm test` after all Wave 5 corrections — 95 passed / 96 total suites and 985 passed / 986 total tests; the sole failure is the known 5-second timeout in `__tests__/game-public-state-no-seed.test.js`; no Wave 5 failures.

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

## Remaining Tickets

- SIM-18 Build automated multi-cycle simulation harness
- SIM-19 Add simulation quality/failure metrics
- SIM-20 Balance growth and coin-event drain
- SIM-21 Balance plateau and decline
- SIM-22 Balance crash/rally behaviour
- SIM-23 Balance dynamic collapse
- SIM-24 Full regression and readiness review
- SIM-25 Controlled playtest deployment

## Known Non-Blocking Issues

- Backend baseline contains one existing timeout failure in the public-state/results test; Wave 0 did not worsen or affect it. It remains a pre-existing suite issue to track before final readiness.
- Frontend lint has six warnings and the build reports normal bundle-size/Browserslist warnings.

## Decisions / Notes

- `project_plan.md` has now been read and confirms the preserved application behaviour and safety constraints.
- `gameplay_changes.md` defines desired new gameplay.
- `gameplay_build_plan.md` defines the implementation sequence.
- `overnight_autobuild_plan.md` defines the autonomous wave gates.
- Do not allow old scheduled collapse logic and new dynamic collapse logic to operate simultaneously.
- Stop after the exact reviewed build is deployed and verified as PLAYTEST READY.
