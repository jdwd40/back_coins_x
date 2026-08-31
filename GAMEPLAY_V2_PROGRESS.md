# Crypto Chaos V2 — Gameplay Pivot

## Preparation checkpoint

- Branch: `gameplay-v2-20260824`
- Preparation timestamp: `2026-08-24T23:02:17+01:00`
- Scope: repository preparation only. No V2 gameplay has been implemented.
- Deployment or production changes: none.
- Main/master merge or push: none.

## Starting repository state

- Repository: `jdwd40/back_coins_x`
- Origin: `git@github.com:jdwd40/back_coins_x.git`
- Starting branch: `main`
- Starting authoritative HEAD: `6efc8e2ec9c063a91daf1bad11b67cee9e94e5c0`
- Starting commit: `feat(game): add read-only round diagnostics API (#21)`
- Starting status: modified `__tests__/game-bots.test.js`, `game/botConfig.js`, and `game/botService.js`; untracked `__tests__/game-bot-exit-strategy.test.js` and `.hermes/` attachment data.

## Preservation and checkpoint

The existing tracked bot work and its accompanying test were preserved on this branch and checkpointed in:

- Checkpoint HEAD: `5c077e355eaf7bb1e760f3b725f65d75143633d1`
- Commit: `chore(game): checkpoint Milestone 1 before V2`

The pre-existing `.hermes/desktop-attachments/Screenshot at 2026-08-06 11-10-53.png` remains untracked and was not deleted or committed.

## Baseline verification

### Backend

Command:

```text
npm test -- --runInBand
```

Result: **FAIL — 1 suite and 1 test failed; 59 suites and 535 tests passed.**

Failure:

- `__tests__/game-public-state-no-seed.test.js`
- `POST /api/game/join and round trade responses carry no seed`
- Expected HTTP `201 Created`; received `400 Bad Request`.

The suite connected to the guarded local disposable database `coins_test` and reseeded it. No production database or service was targeted.

Other observed output:

- Jest reported a force-exit/open-handles warning after the run.
- `git diff --check` passed before and after the checkpoint.

### Frontend

Commands and results:

- `npm run lint` — **PASS**, 0 errors, 6 existing warnings:
  - missing React Hook dependencies in `Profile.tsx`
  - missing React Hook dependencies in `SellForm.tsx`
  - Fast Refresh export warning in `AuthContext.tsx`
  - Fast Refresh export warning in `GameContext.tsx`
  - Fast Refresh export warning in `ToastContext.tsx`
  - unused ESLint disable directive in `src/utils/priceSummary.test.ts`
- `npm run test:ui` — **PASS**, Crypto Chaos UI contract passed.
- `npm run test:unit` — **PASS**, 109 tests passed.
- `npm run build` — **PASS**. Existing warning: Browserslist/caniuse-lite data is 16 months old.

## Repository state after checkpoint

- Backend branch: `gameplay-v2-20260824`
- Backend HEAD: `5c077e355eaf7bb1e760f3b725f65d75143633d1`
- Frontend branch: `gameplay-v2-20260824`
- Frontend starting/current HEAD before this progress document: `ec190d167a9ed03f5fd6bd642196ad6a9a982330`
- The frontend Core 7 commit was already present on `master`; the V2 branch was created before any frontend commit action.
- This document records the baseline only; it does not define or implement V2 gameplay.

## Next authorised phase

Begin with V2-1 planning and the shared deterministic cyclical-market/simulation gate. Do not proceed to Power, bots, or major UI work until DIP-BOOM demonstrates a repeatable advantage over RANDOM on identical seeded paths.

---

## V2-1 — COMPLETE

Checkpoint timestamp: `2026-08-25T01:59:25+01:00`

- Status: **COMPLETE**
- Backend stage SHA: `b71f0671b0beb2c712af298232f61befef8f67f1`
- Frontend SHA: `3a2688b3111785f09321dd9f8cb8f32ff6d63357` (unchanged; no frontend implementation in V2-1)
- Commit: `feat(game): implement V2-1 cyclical market and simulation`
- Production branches/services/data: untouched.
- Existing `.hermes/` attachment: preserved untracked and not staged.

### V2-1 delivered

- Shared deterministic `game/marketDomain.js` cyclical DIP → RISE → BOOM → FALL pricing domain.
- Non-destructive gameplay roster mapping existing active coins to ZIP, MOON, BULL, HODL, DEGEN and RUG archetypes.
- Seeded variable cycle duration, swing, phase shape, anchor/regime drift, continuous bounded noise and staggered coin timelines.
- Live market writer integration using the same domain, authoritative cycle state/time and Core 2 amplitude; collapsed coins remain £0 and are excluded.
- Public coarse market signals endpoint without seed, exact timing, future peak, anchor or collapse leakage.
- Extracted shared seeded RNG module while preserving existing collapse-service exports.
- Migration `017_v2_price_precision.sql`, widening only price/value numeric scale from 2dp to 4dp with shape checks, idempotence and preservation of historical values. Wired into seed and game-schema verification.
- First-class DB-free accelerated simulator with identical seeded paths, injected clock, realistic 15-second observation cadence, live-style trade mechanics and all required strategies: RANDOM, DIP_BOOM, LATE_SELLER, HOLD_FOREVER, SPAM, PUBLIC_SIGNAL_EXPLOITER and PERFECT_INFORMATION.
- Restored/adapted legacy Core 2 and Core 3 market regression suites after independent review identified their deletion as unjustified.

### V2-1 verification evidence

Focused V2-1 set:

- 10 focused suites, 86 tests — **PASS**
- Restored legacy Core 2/Core 3 suites — 20 tests — **PASS**
- Full backend suite: `npm test -- --runInBand`
  - 65 suites passed
  - 587 tests passed
  - no test failures
  - existing Jest force-exit/open-handle warning remains
- `git diff --check` — **PASS**
- JavaScript syntax checks for changed/new domain and simulator files — **PASS**

Independent final gate run:

```text
node simulation/run.js --mode gate --rounds 2000 --json
```

- 2,000 paired seeded apocalypse rounds
- 7 strategies on identical paths
- economy enabled
- £10,000 starting cash
- 15,000ms observation cadence
- runtime: 864,311ms
- gate verdict: **PASS**

Final independent metrics:

| Strategy | Median ROI | Mean ROI | Profitable rounds |
|---|---:|---:|---:|
| RANDOM | -53.76% | -8.67% | 5.45% |
| DIP-BOOM | **271.37%** | 1,111.83% | 100% |
| LATE SELLER | 22.38% | 978.34% | 70.65% |
| HOLD FOREVER | -98.20% | -98.20% | 0% |
| SPAM | -11.46% | -10.85% | 17.25% |
| PUBLIC-SIGNAL EXPLOITER | 231.42% | 2,088.02% | 97.30% |
| PERFECT INFORMATION | 454.25% | 10,928.56% | 100% |

- DIP-BOOM vs RANDOM paired win rate: **99.55%**
- DIP-BOOM median paired advantage: **+£32,120.14**
- DIP-BOOM vs LATE SELLER paired win rate: **96.10%**
- PUBLIC-SIGNAL EXPLOITER remains below PERFECT INFORMATION and within the defined anti-trivial-exploit bound.
- All V2-1 gate criteria passed.

The original preparation failure in `game-public-state-no-seed.test.js` did not reproduce in the final V2-1 suite; it is recorded as a previously observed baseline issue, not claimed as independently fixed by V2-1.

### K3 state

- V2-1 implementation used a fresh pinned Kimi K3 task.
- A fresh K3 correction task restored the deleted regression suites.
- Latest probe after implementation: quota available; no quota exhaustion occurred.
- K3 quota status was not a blocker and was not classified as one.

### V2-1 next action

Before V2-2, read this authoritative plan, both progress files and both current repository states again. Then launch a fresh K3 implementation task for **V2-2 Power + position limit + cost basis/P&L**. Do not begin V2-3, V2-4 or UI work until the V2-2 multi-round simulation gate passes.

## V2-2 — COMPLETE

Checkpoint timestamp: `2026-08-25T03:01:00+01:00`

- Status: **COMPLETE**
- Backend implementation SHA: `84699449d71ecab305d331f17d95689eadbe942d`
- Frontend SHA: `266d67878ab90124527d5e632b971d73a6f96c2a` (unchanged; no UI work permitted yet)
- Branch: `gameplay-v2-20260824`
- Production branches/services/data: untouched.
- `.hermes/` attachment remains untracked and was not staged.

### V2-2 delivered

- Shared pure `game/powerDomain.js` used by both live locked trading and the headless simulator.
- Persistent lazy Power with timestamp reconciliation across restart, inactivity and apocalypse rollover.
- BUY-only Power cost; SELL always costs zero and remains available at zero Power.
- Anti-fragmentation cost formula: `1 + floor(buyTotal / 125)`.
- Maximum 3 distinct open live positions; collapsed and zero-quantity holdings do not consume slots.
- Atomic cash + Power deduction + buy persistence inside the existing advisory-lock transaction; failed buys consume nothing.
- Weighted cost basis, average entry price, current value, unrealised P&L £ and %, including correct partial-sell basis removal and collapsed holdings.
- Non-destructive migration `018_v2_power_and_cost_basis.sql`, deterministic ledger-replay cost-basis backfill, schema verification and seed wiring.
- Multi-process race coverage for concurrent Power spending, cash safety and position limits.
- Persistent multi-round Power study with RANDOM, DIP_BOOM, SPAM, PUBLIC_SIGNAL_EXPLOITER, CONSERVATIVE_POWER, AGGRESSIVE_POWER, SPLITTER, LATE_ENTRANT and RETURNING.
- `npm run simulate:power` CLI mode.

### V2-2 tuning and final gate

Final parameters:

- Maximum Power: `100`
- Regeneration: `+1 per 30 seconds` (tuned from the initial 120-second concept)
- Buy cost divisor: `£125`
- Buy order charge: `1 Power`
- Position limit: `3`
- Simulation cadence: `15 seconds`
- Round duration: `30 minutes`
- Starting round cash: `£10,000`
- Economy: enabled for the gate

The initial ceiling-only formula was rejected during tuning because aligned fragmentation could cost the same and perform better under scarcity. The per-order charge was selected and verified: in the identical-trades twin test, whole deployment used 18 Power versus 20 Power fragmented.

Independent final run:

```text
node simulation/run.js --mode power --sequences 40 --rounds-per-sequence 24 --json
```

- 40 sequences × 24 consecutive rounds
- 960 paired rounds per player (8,640 played records including the returning-player absences)
- Gate verdict: **PASS**
- DIP_BOOM vs RANDOM paired win rate: **82.60%**
- DIP_BOOM median ROI: **14.31%**
- RANDOM median ROI: **-7.81%**
- DIP_BOOM median paired advantage: **£2,253.78**
- SPAM median ROI: **-4.07%**, with 194,944 Power-blocked buys and 543 position-limit blocks
- PUBLIC_SIGNAL_EXPLOITER median ROI: **5.15%**
- CONSERVATIVE_POWER median ROI: **5.99%**
- AGGRESSIVE_POWER median ROI: **-35.54%**
- SPLITTER Power per £: `0.00834` versus DIP_BOOM `0.00820` (+1.7%)
- LATE_ENTRANT median ROI: **22.06%**, paired win rate against RANDOM **85.52%**
- RETURNING mean round-start Power: **39.95**
- DIP_BOOM starved-tick percentage: **1.87%**
- Zero cost-basis/accounting violations across the study
- Zero position-limit violations; the limit was exercised by SPAM and RANDOM
- Zero majority-starved rounds in the final study

### V2-2 verification evidence

- Focused V2-2 suites: **5 suites / 67 tests passed**
  - Power domain: 24 tests
  - live Power/trade/position/cost-basis: 22 tests
  - genuine multi-process races: 6 tests
  - simulator/persistent-account tests: 10 tests
  - migration 018: 5 tests
- Full backend suite: `npm test -- --runInBand` — **70 suites / 654 tests passed**
- `git diff --check`: **PASS**
- JavaScript syntax checks for changed/new files: **PASS**
- The only correction required was a duplicated-coin test fixture; a fresh K3 correction fixed the fixture without changing service code, and the focused suite was independently rerun green.
- Jest force-exit/open-handle warning remains a known test-runner warning; no V2-2 test failures remain.

### V2-2 next action

Before V2-3, read this plan, both progress files and both repository states again. Then launch a fresh K3 implementation task for **V2-3 apocalypse escalation, collapse-risk signals and passive-economy tuning**. UI work remains prohibited until V2-1 through V2-4 gates pass.

## V2-3 — COMPLETE

Checkpoint timestamp: `2026-08-25T05:43:07+01:00`

- Status: **COMPLETE**
- Backend implementation SHA: `d583d56b2371b04ae7dd5c5dfc3e124b01c5e347`
- Frontend SHA: `cc578d52ce075d5237868c76e58921288ecaa3ee` (unchanged; UI still prohibited)
- Branch: `gameplay-v2-20260824`
- Production branches/services/data: untouched.
- `.hermes/` attachment remains untracked and was not staged.

### V2-3 delivered

- Centralized escalation bands: NORMAL 0–40%, ELEVATED 40–70%, HIGH 70–90%, EXTREME 90–100%.
- Existing shared Core 2 volatility curve preserved: 1.0 → 3.0, exponent 2; no duplicate live/simulator pricing path.
- New pure `game/collapseRiskDomain.js` shared by live public market signals and simulator observations.
- Coarse risk vocabulary: STABLE, SHAKY, DANGER, CRITICAL; dead coins expose DEAD.
- Risk uses only public progress, archetype, current public market stress and independent deterministic noise; it never reads the collapse schedule, rank, timestamp or seed publicly.
- Explicit `GAME_ECONOMY_SCALE` configuration in [0,1], default 1 preserving Core 7 behavior, with selected V2 simulation scale 0.25. Existing atomic debit, durable claim and idempotency paths remain intact.
- V2-3 simulation study with economy A/B, per-band movement/opportunity/risk metrics, collapse losses, overstay strategy, risk-aware strategy and late entrant.
- `npm run simulate:v2-3` CLI mode.

### V2-3 final simulation gate

```text
node simulation/run.js --mode v2-3 --sequences 30 --rounds-per-sequence 24 --json
```

- 30 sequences × 24 consecutive rounds
- 720 paired rounds per player per economy variant
- 15-second observation cadence, £10,000 starting cash
- Power: max 100, +1 per 30 seconds, buy cost `1 + floor(total / £125)`, 3 open positions
- Legacy economy scale 1 versus selected V2 scale 0.25 on identical market paths
- Gate verdict: **PASS**, all 11 criteria

Key metrics:

- Median tick movement NORMAL → EXTREME: **2.09% → 2.95% → 4.14% → 5.15%**
- Median equal 3-minute swing NORMAL → EXTREME: **18.99% → 28.39% → 40.65% → 51.60%** (2.72× late/early)
- HIGH band: 6.5 mean live coins and 86.66% of ticks with a legal entry opportunity
- Risk ordinal NORMAL → HIGH → EXTREME: **0.611 → 1.756 → 2.503**
- Risk next-collapse classifier: **22.71%** accuracy versus **22.86%** chance baseline over 5,760 samples; no schedule leak
- DIP_BOOM median ROI: **17.11%**; RANDOM: **-5.69%**
- DIP_BOOM paired win rate: **83.06% vs RANDOM**, **73.06% vs LATE_SELLER**, **80.83% vs OVERSTAYER**
- LATE_ENTRANT median ROI: **24.66%**, paired win rate vs RANDOM **84.58%**
- HOLD_FOREVER median ROI: **-57.87%**, 0% profitable rounds
- OVERSTAYER median ROI: **-5.88%**, mean collapse loss **£2,352.38/round**
- Selected V2 economy median debits: **£80.37/round**; DIP_BOOM erased-gain rounds **0.18%**
- Zero cash, basis and position invariant violations
- Power blocked buys: **725,774**; position-limit blocked buys: **149,679**
- Extreme-band near-floor live ticks: **0.26%**, inherited from V2-1 positive-price floor and reported separately rather than hidden

### V2-3 verification evidence

- Independent focused V2-3/V2-2/V2-1 run: **15 suites / 199 tests passed**.
- Independent V2-3 simulation gate: **PASS** at 30×24.
- Independent V2-2 Power regression gate: **PASS** with unchanged 82.60% DIP_BOOM/RANDOM result.
- K3 full backend run: **74 suites / 691 tests passed**.
- Independent full backend rerun: 73 suites / 690 tests passed; one failure was the known `game-public-state-no-seed.test.js` timeout/deadlock family. The same test also failed in isolation with a deadlock in the existing settlement/collapse path; no V2-3 files are involved. It is recorded as the pre-existing baseline flake, not a V2-3 regression.
- `git diff --check`: **PASS**; `node --check` on all changed/new JS: **PASS**.
- No migration was needed; no production configuration was changed.
- Economy-scale test required a K3 correction to pin fresh cycle seeds and prevent persisted schedule contamination; service code was unchanged by the correction.

### V2-3 next action

Before V2-4, read this plan, both progress files and both repository states again. Then launch a fresh K3 implementation task to adapt the existing Conservative, Momentum, Dip Buyer and Reckless bots to V2 public signals, Power, position limits and the shared buy/sell service. UI work remains prohibited until V2-4 passes.

## V2-4 — COMPLETE

Checkpoint timestamp: `2026-08-25T07:30:59+01:00`

- Status: **COMPLETE**
- Backend implementation SHA: `bdaf1d0787abc94456ca1338a93e0d2bfd08c799`
- Frontend SHA: `2f78fa85151e717a9a5bb02aeade1fd1e7bdf7bf` (unchanged; UI remains blocked until this checkpoint is pushed and V2-5 begins)
- Branch: `gameplay-v2-20260824`
- `.hermes/desktop-attachments/` remains untracked and was not staged.
- No production service, production data, migration, deployment or protected branch was touched.

### V2-4 delivered

- Existing Core 5 roster preserved: Conservative, Momentum, Dip Buyer, Reckless.
- Exact public bot-state allowlists enforced by `assertPublicBotState` for live and simulated decisions; extra or missing keys fail closed.
- Live bot state now uses the same public phase, momentum, archetype, recent movement and collapse-risk domains as human-facing signals, plus only the bot’s own Cash, holdings/P&L, Power and open-position count.
- Hidden seed, future phase/peak, collapse schedule/rank/timestamp and other future information never enters the decision shape.
- Conservative: DIP/early-RISE, STABLE/SHAKY entries, early BOOM-stall banking and high reserve.
- Momentum: confirmed RISE+UP entries, FALL/DOWN-underwater/BOOM-stall exits.
- Dip Buyer: public DIP/early-RISE entries, larger tuned stake, BOOM ride, FALL loss cut and controlled overstay.
- Reckless: DEGEN/RUG preference, DANGER/CRITICAL tolerance, aggressive Power use and higher drawdown/collapse exposure.
- Buy decisions are Power- and position-limit-aware; shared live trade services remain authoritative.
- Power/position rejections are recorded as non-fatal bot skips; sells remain free at zero Power.
- Added deterministic `simulation/botStudy.js`, engine instrumentation, `--mode bots` and `npm run simulate:bots`.
- Updated existing bot fixtures and retirement fixture to provide the legitimate V2 public-state fields; no production behavior was weakened for tests.

### V2-4 independent bot gate

```text
node simulation/run.js --mode bots --sequences 24 --rounds-per-sequence 16 --json
```

- 24 sequences × 16 consecutive 30-minute rounds
- 384 rounds per player, persistent Power, 15-second observation cadence
- Economy enabled at selected V2 scale 0.25
- Power max 100, regeneration +1/30s, buy cost `1 + floor(total / £125)`, max 3 positions
- Gate: **PASS**, all 9 criteria

Key metrics:

- Conservative median ROI **+2.21%**, profitable rounds 69.01%, 57.03 trades/round
- Momentum median ROI **+0.45%**, profitable rounds 53.13%, 57.75 trades/round
- Dip Buyer median ROI **+13.93%**, profitable rounds 78.65%, 6.35 trades/round
- Reckless median ROI **-6.84%**, profitable rounds 39.58%, 20.26 trades/round
- DIP_BOOM benchmark median ROI **+18.55%**
- Dip Buyer vs DIP_BOOM paired win rate **34.11%**, median ROI gap **-4.62 points**; gate threshold passed
- Conservative risky-entry share **0%**; Reckless **48.99%**; Dip Buyer DIP-entry share **97.5%**; Momentum RISE-entry share **100%**
- Zero cash/basis/position invariant violations; max open positions never exceeded 3
- Median starting Power: Conservative 100, Momentum 100, Dip Buyer 31, Reckless 29; no majority-starved bot rounds
- Zero-Power sells: **73 attempted / 73 executed**
- Maximum bot round-win share **25.52%**; no dominant personality
- Reckless mean collapse loss **£1,161.86/round** vs Conservative **£281.91/round**; mean drawdown 30.59% vs 3.91%
- Hidden-information checks: **185,856 decision inputs, 0 violations**

### V2-4 verification evidence

- Independent focused run: **20 suites / 237 tests passed**.
- New V2-4 suite: **20 tests passed**.
- Independent bot study: **PASS**, all 9 criteria.
- Independent V2-2 regression: **PASS**, 82.60% DIP_BOOM/RANDOM, zero accounting/position violations.
- Independent V2-3 regression: **PASS**, all 11 criteria.
- Independent full backend run: **74 suites / 710 tests passed**, one known suite-order deadlock failure in `game-cycle-worker.test.js` during the next test’s database reseed. The worker suite passes isolated: **1 suite / 5 tests passed**. The failure is the documented pre-existing settlement/worker deadlock family and is outside V2-4 files.
- K3’s sequential full run recorded the same 74/75 and 710/711 baseline result after correcting an initial intentional DB-interference run.
- `git diff --check`: **PASS**; `node --check` on all changed/new JS: **PASS**.
- No migration was needed.

### V2-4 next action

Before V2-5, read this plan, both progress files and both repository states again. Push only `gameplay-v2-20260824` as backup, then launch a fresh K3 frontend implementation task. UI was correctly blocked until V2-4 and is now authorised to begin.

## V2-5 — COMPLETE

Checkpoint timestamp: `2026-08-25T08:29:38+01:00`

- Status: **COMPLETE**
- Backend SHA: `7ffab04c24f0b30f8bfb1b10d2d87db91991314a` (unchanged during UI work)
- Frontend implementation SHA: `018cc0f1fb677256166c2443b982b65502c45f15`
- Branch: `gameplay-v2-20260824`
- No backend, production service, production data, migration or deployment changes.

### V2-5 delivered

- Mobile-first game surface with compact `GameTopBar`, server-anchored `ApocalypseHeader`, `PlayerStatusStrip`, `LeaderboardPressure` and `GameMarketGrid`.
- Single shared `GameContext` poll now consumes the real `/api/game/market-signals` endpoint and adopts signals only for the live apocalypse.
- Real participant Power block and holding economics are typed and validated: current/max, regeneration, next point, average entry, cost basis and unrealized P&L.
- Six-plus active signal cards are scannable on mobile; owned positions lead; collapsed coins are separated and show £0/DEAD/no BUY.
- Cards expose current price, explicit movement, DIP/RISE/BOOM/FALL phase, momentum, archetype, typical cycle/swing, collapse risk, quick notional buys and Power preview.
- Quick buys use £250/£500/£1K/£2.5K notional ladder, convert down to legal quantity precision and keep server confirmation/error authoritative.
- Owned cards make average entry, current price/value, P&L £/%, risk and complete-position SELL action prominent; sell remains free at zero Power.
- Leaderboard rank, human highlight and bot/personality markers are visible near the gameplay surface.
- Existing profile, results, leaderboard, classic market and chart areas remain available as secondary surfaces.
- Responsive CSS is one-column at phone widths, adds columns only at wider breakpoints, protects 360–412px overflow and respects reduced motion.

### V2-5 readability and verification evidence

The UI contract explicitly covers all 13 answers: Cash, Power, regen rate, countdown, DIP/Rise/BOOM discovery, owned positions, P&L, buy action, Power cost preview, sell action, danger/risk and leaderboard rank.

- `npm run test:unit`: **130/130 passed**.
- `npm run test:ui`: **Crypto Chaos UI contract passed**.
- `npm run lint`: **0 errors**, six existing warnings (Profile/SellForm/AuthContext/GameContext/ToastContext/unused test directive).
- `npx tsc --noEmit`: **passed**.
- `npm run build`: **passed**; only existing Browserslist/chunk-size warnings.
- `git diff --check`: **passed**.
- Generated `dist` and `tsconfig.tsbuildinfo` remained ignored/uncommitted.
- K3 required two process attempts and was killed by `-9` during its lint/build phase after unit/UI work; Luna independently completed those remaining gates successfully. No code correction was needed after the independent gates.

### V2-5 next action

Before V2-6, read the complete plan, both progress files and both repository states again. Push only `gameplay-v2-20260824` as backup, then run final backend/frontend verification, final large simulation batches against the final gameplay code, regression checks and the complete morning report. Do not merge or deploy.

## V2-6 — COMPLETE / OVERNIGHT RUN COMPLETE

Final checkpoint timestamp: `2026-08-25T08:55:00+01:00`

### Final repository state

- Backend final HEAD: `3670f2578a6af458c38d3219178a21a1d5a0b185`
- Frontend final HEAD: `b189d6927819c4e6178377bfab5df27ccfe94574`
- Both branches: `gameplay-v2-20260824`, synchronized with origin.
- No merge, no main/master push, no deployment, no production restart, no production migration and no production-data mutation.
- `.hermes/desktop-attachments/` remains untracked and was never committed.
- Stages completed: **V2-1, V2-2, V2-3, V2-4, V2-5, V2-6**.
- Stage stopped at: **none**. The overnight goal is complete.

### Final gameplay parameters

- Market archetypes: ZIP, MOON, BULL, HODL, DEGEN, RUG; shared deterministic cycle `DIP → RISE → BOOM → FALL → DIP`.
- Shared market domain: 1×→3× apocalypse amplitude, exponent 2; normal seeded noise and archetype-specific cycle/swing parameters remain in one live/simulator domain.
- Power: max **100**, lazy regeneration **+1 per 30 seconds**, buy cost **1 + floor(total notional / £125)**, sell cost **0**.
- Position limit: **3 open live positions**, buy-only enforcement; sells unrestricted.
- Cost basis/P&L: weighted-average entry, remaining cost basis, current value, unrealized and realized P&L.
- Escalation bands: NORMAL 0–40%, ELEVATED 40–70%, HIGH 70–90%, EXTREME 90–100%.
- Collapse window: begins at 70%; public risk is coarse STABLE/SHAKY/DANGER/CRITICAL and intentionally schedule-independent.
- Selected V2 passive economy study scale: **0.25** versus legacy scale 1; live default remains explicitly configuration-controlled for compatibility.
- Bot roster: Conservative, Momentum, Dip Buyer, Reckless; all use legal public signals and shared trade/Power/position services.

### Final simulation evidence

#### V2-1 paired strategy gate — 2,000 seeded rounds

- DIP_BOOM: median ROI **271.37%**, mean ROI 1111.83%, profitable rounds 100%.
- RANDOM: median ROI **-53.76%**, mean ROI -8.67%, profitable rounds 5.45%.
- LATE_SELLER: median ROI **22.38%**, profitable rounds 70.65%.
- HOLD_FOREVER: median ROI **-98.20%**, profitable rounds 0%, worst drawdown 98.34%.
- SPAM: median ROI **-11.46%**, 229.51 trades/round.
- PUBLIC_SIGNAL_EXPLOITER: median ROI **231.42%**; it did not beat DIP_BOOM.
- PERFECT_INFORMATION: median ROI **454.25%**, confirming legal play is below an information upper bound.
- CONSERVATIVE_POWER: median ROI 94.29%.
- AGGRESSIVE_POWER: median ROI -98.83%.
- SPLITTER: median ROI 271.69%.
- OVERSTAYER: median ROI -22.90%.
- RISK_AWARE: median ROI 326.17%.
- Paired DIP_BOOM vs RANDOM: **99.55% win rate**, median final-cash difference £32,120.14.
- V2-1 gate: **PASS**; no trivial public-signal exploit.

#### V2-2 Power gate — 40 sequences × 24 consecutive rounds

- DIP_BOOM vs RANDOM: **82.60% paired win rate**.
- DIP_BOOM median ROI 14.31%; RANDOM comparison remained negative.
- SPAM median ROI -4.07%; DIP_BOOM vs SPAM 78.85%.
- Power blocks: 194,944 SPAM buys; 169,129 aggressive buys.
- DIP_BOOM median start Power 17; starved tick rate 1.87%; no majority-starved run.
- Returning player mean start Power 39.95.
- Position limit exercised; zero cash/basis/position invariant violations.
- V2-2 gate: **PASS**.

#### V2-3 escalation/risk/economy gate — 30 sequences × 24 consecutive rounds

- NORMAL→EXTREME median tick movement: 2.09% → 2.95% → 4.14% → 5.15%.
- Equal 3-minute swing: 18.99% → 28.39% → 40.65% → 51.60%; EXTREME/NORMAL ratio 2.72×.
- HIGH band: 6.5 mean live coins and 86.66% legal-entry opportunity ticks.
- Risk ordinal NORMAL→HIGH→EXTREME: 0.611 → 1.756 → 2.503.
- Public-risk next-collapse classifier: 22.71% versus 22.86% chance over 5,760 samples; no schedule leak.
- DIP_BOOM median ROI 17.11%; RANDOM -5.69%; paired win rate 83.06%.
- LATE_SELLER paired 73.06%; OVERSTAYER paired 80.83%; HOLD_FOREVER median -57.87%.
- V2 economy median debits £80.37/round; erased-gain rounds 0.18%.
- Zero cash/basis/position invariant violations; 725,774 Power blocks and 149,679 position blocks.
- V2-3 gate: **PASS**.

#### V2-4 bot gate — 24 sequences × 16 consecutive rounds

- Conservative: median ROI +2.21%, 69.01% profitable, 57.03 trades/round.
- Momentum: +0.45%, 53.13% profitable, 57.75 trades/round.
- Dip Buyer: +13.93%, 78.65% profitable, 6.35 trades/round.
- Reckless: -6.84%, 39.58% profitable, 20.26 trades/round.
- DIP_BOOM benchmark: +18.55% median ROI.
- Dip Buyer vs DIP_BOOM: 34.11% paired win rate, median gap -4.62 points; gate threshold passed.
- Conservative risky entries 0%; Reckless 48.99%; Dip Buyer DIP entries 97.5%; Momentum RISE entries 100%.
- Zero invariant violations; max open positions 3; zero-Power sells 73/73.
- No dominant bot personality; no majority-starved rounds.
- Hidden-information checks: 185,856 decisions, 0 violations.
- V2-4 gate: **PASS**, all 9 criteria.

### Final verification totals

- Backend full suite: **74 suites passed / 1 known baseline suite-order failure; 710 tests passed / 1 known baseline failure**.
- Known baseline failure: `game-public-state-no-seed.test.js` settle-lifecycle timeout/deadlock in the existing settlement/collapse path; the failing suite varies with suite order (`game-cycle-worker.test.js` also reproduced the same reseed deadlock family). The worker suite passes isolated 5/5, and the public-state suite has passed isolated in prior runs. No final V2 code path is implicated; this is explicitly retained as the pre-existing baseline failure permitted by the plan.
- Backend test schema verification: **PASS**, no reported schema problems.
- Backend focused V2/bot/race/migration run: **20 suites / 237 tests passed**.
- Frontend unit tests: **130/130 passed**.
- Frontend UI contract: **passed** and covers all 13 mobile-readability answers.
- Frontend lint: **0 errors**, six existing warnings.
- Frontend TypeScript: `npx tsc --noEmit` **passed**.
- Frontend production build: **passed**; only existing Browserslist and chunk-size warnings.
- `git diff --check`: **passed** in both repositories.

### Final regression and readiness assessment

Verified through the final backend suite, focused tests, API contracts and simulations: authentication boundaries, £10,000 starting Cash, automatic participation, ACTIVE→SETTLING→COMPLETED lifecycle, holdings, transactions, settlement/results, leaderboard, rollover, dead-coin £0 behavior, centralized frontend API, stale/offline trade blocking, profile/history preservation and production isolation remain covered. No browser/device screenshot was claimed; the frontend readiness evidence is the typed contract, 130 unit tests, UI contract, lint, TypeScript and production build.

- V2 reached the UI stage: **YES**.
- Human play-test readiness: **YES — branch ready for local inspection/play-testing**. Deployment was intentionally not performed.
- Unresolved V2 defects: the known pre-existing full-suite settlement/worker reseed deadlock flake; existing frontend lint warnings; build advisories; no newly discovered V2 gameplay gate failures.
- Final status: **Crypto Chaos V2 gameplay pivot complete and backed up on `gameplay-v2-20260824`**.
- Do not merge, deploy or begin another milestone.

---

## GAMEPLAY OVERHAUL Wave 6 — SIM-18/19 multi-cycle harness (Stage 13)

New phase after the V2-6 milestone: the `gameplay-overhaul` balancing programme.
This section documents the Stage 13 authoritative automated multi-cycle
harness; it does not change any earlier V2 verification record.

### Command

```text
node simulation/run.js --mode multi-cycle \
  [--cycles N]            # default 200; use 10-20 for a smoke run, hundreds/thousands for validation
  [--base-seed S]         # default sim18-multi-cycle-base-seed
  [--observation-ms MS]   # default 15000
  [--economy on|off]      # default on
  [--scenarios market,pressure,events]  # default all three; 'market' is always included
  [--out PATH]            # default simulation/output/multi-cycle-latest.json (git-ignored)
  [--json]                # machine-readable stdout instead of the human summary
# npm script alias: npm run simulate:multi-cycle -- --cycles 200
```

Exit code is the harness verdict: 0 = all SIM-19 quality flags pass, 1 = at
least one fails. The only non-deterministic report field is the explicitly
separate top-level `runtimeMs` (wall-clock); every other field is a pure
function of the options, so identical options produce a byte-identical report.

### What it does (`simulation/multiCycle.js`)

Runs N accelerated, complete, deterministic apocalypse cycles through the
SAME pure `roundEnvironment`/`engine` modules the other simulation studies
use — there is no second market implementation. Cycle seeds derive from the
base seed (`sha256(baseSeed:multi-cycle:N)`), never cherry-picked. Three
scenario sections run over the same deterministic cycles:

- `market` — no-trade market shape. Per cycle: starting/peak/final index,
  peak position %, crash/rally counts and largest episodes, first
  Plateau/Decline times, full collapse order with first/final natural
  collapse times and spread, coins the final safety rule had to force, event
  counts and positive/negative totals, phase ids, coin-path divergence, and
  the exact final £0 / zero-survivor assertion. Per coin: starting/peak/min
  pre-collapse price, event counts/totals, natural collapse time or explicit
  `null` when the safety rule forced it.
- `pressure` — trading/bot shape. A fixed legal roster (DIP_BOOM, RANDOM,
  SPAM) plays each cycle twice: pass A on the no-tape environment records an
  executed-trade tape (engine `recordTrades`); pass B rebuilds the same seed
  WITH the tape wired into pricing (one bounded feedback iteration) and
  re-plays, capturing tape size/notional, mean/max absolute pressure
  modifier, tape-induced price-path divergence %, collapse-order shift
  (discordant pairs) and per-strategy ROI/trade metrics.
- `events` — event bias/variety analysis over the market cycles: aggregate
  positive/negative totals, negative:positive modifier ratio, distinct event
  names and phase ids, zero-event cycles.

The first `min(10, cycles)` cycles are captured TWICE and deep-compared; any
drift raises `deterministicReplayMismatch`.

### Reading the report

`flags` carries every SIM-19 quality check with `measured` values and the
`threshold` string it was judged against (thresholds are exported as
`DEFAULT_THRESHOLDS` and echoed into the report — a run is self-describing):
prematureMassCollapse, noMeaningfulRally, lateCrashFullRecovery,
identicalCoinPaths, unboundedCoinGrowth, positiveEventsOverwhelming,
negativeEventsKillEarlyGrowth, identicalCollapseOrderAcrossSeeds,
nonzeroFinalMarketValue, deterministicReplayMismatch, noPhaseEventVariety,
latePeakInstantDeath. `verdict.pass` requires every flag.

Interpretation rules: never call one cycle (or a tiny smoke batch) a balance
conclusion — flags are aggregate judgements and small samples legitimately
fail share-based thresholds. A FAIL at hundreds of cycles is a genuine
Wave 7 balancing signal, not a harness defect; tuning belongs to Wave 7 and
must not be done by editing production config just to make the simulation
pass.

### Tests

`__tests__/multi-cycle-simulation.test.js` (26 tests): complete per-cycle/
per-coin metric capture, exact final £0 survivor assertion, deterministic
replay (two byte-identical runs + the built-in re-capture check), executed-
tape determinism, cross-seed variation, every failure flag individually
forced on synthetic aggregates, and the CLI/report shape including the
verdict exit code.
