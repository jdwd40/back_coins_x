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
