# AUTOBUILD STATE

## Current Execution

- **Current wave:** Wave 2 — Market Index and Lifecycle (complete)
- **Current ticket:** SIM-08
- **Status:** READY FOR WAVE 3 — Wave 2 implementation, review, and gates complete
- **Current branch:** Backend `v2-legacy-cleanup-20260825`; frontend `gameplay-overhaul-20260830`
- **Latest successful commit:** Backend `e94e5bfb7ffa3b355c0bc4bce63155cc8406cc25`; frontend `67b59a6a6eec138eaa874b4e567543bc2858aae3`
- **Last pushed commit:** Backend `e94e5bfb7ffa3b355c0bc4bce63155cc8406cc25` on `v2-legacy-cleanup-20260825`; frontend remote `f06b5a903b5a4fa6b7ea04385ce37f4059e829ef`
- **Last deployed commit:** Not checked
- **Database migration status:** Local disposable test DB migrations 020 and 021 applied and verified; production not checked or applied
- **Review status:** Fresh strict Wave 2 review passed; no unresolved P0/P1 findings
- **Blocking issue:** None
- **Next action:** Read state and plan Wave 3 only: SIM-08 unified normal price calculation, then SIM-09 crash engine and SIM-10 rally/lower-high behaviour.

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
- **Latest targeted tests:** Wave 2 focused suites — 4 suites, 54 tests passed; affected regression suites — 16 suites, 213 tests passed; changed/new-file Node syntax checks and `git diff --check` passed. ESLint is not configured in this backend (`npx eslint` installed ESLint 10 and stopped because no `eslint.config.*` exists); no source change was made for that tooling mismatch.
- **Latest full tests:** Backend `npm test` — 91 suites, 916 passed, 1 failed; the one failure is the same recorded 5-second timeout in `__tests__/game-public-state-no-seed.test.js`, confirmed against the pre-Wave-2 baseline commit and unchanged in failure mode.

## Current Wave Audit Notes

- Current backend already contains an older V2 deterministic market domain (`game/marketDomain.js`) and headless simulator (`simulation/`).
- Current live price writer is `models/market-simulator.js`, which calls `marketDomain.evaluateMarketPoint()` and persists `coins.current_price` plus price history.
- Current scheduled collapse authority is `game/collapseScheduleService.js`, persisted in `coin_collapse_schedule`, reconciled by `game/gameCycleService.js` and settlement.
- Current cycle authority/recovery is `game/gameCycleService.js`; bots use `game/botWorker.js`/`game/botService.js`; price history is written by the market writer and collapse executor; settlement uses `game/gameSettlementService.js`.
- The current repository therefore requires an explicit migration design to avoid running a new dynamic collapse engine alongside the existing schedule.
- Wave 1 adds separate deterministic coin-event and market-phase engines, additive migration 020, disposable-schema wiring/verification, and Core 1 lifecycle integration. It does not alter the existing price writer, scheduled collapse authority, trade rules, portfolios, transaction history, price history, settlement, or public API shapes.
- Coin events use rolling seeded persistence, 0–5 active-per-coin cap, 1–15 minute durations, separate flavour/name and signed modifier fields, expiry by timestamp, and no portfolio/trade/price-history coupling.
- Market phases use all six required phase types, lifecycle-weighted deterministic selection with GROWTH wired until Wave 2, one contiguous persisted primary chain, and restart/idempotency coverage.
- Wave 2 adds separate `apocalypse_market_state` persistence, canonical surviving-coin market index calculation, monotonic peak/drawdown/momentum tracking, seed-generated plateau targets, and hidden legal-order lifecycle transitions. It does not write prices or price history and leaves the scheduled-collapse authority in place until Wave 4.
- Strict review correction enforced negative bias strictly above 1, non-decreasing crash probability through the lifecycle, and both positive/negative phase groups remaining possible in every lifecycle state.

## Completed Tickets

- SIM-01 Audit current authoritative market simulation
- SIM-02 Centralise simulation configuration
- SIM-03 Implement coin event engine
- SIM-04 Add coin event persistence/state recovery
- SIM-05 Implement market phase engine
- SIM-06 Add market index and peak/drawdown tracking
- SIM-07 Implement hidden lifecycle state machine

## Remaining Tickets

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
