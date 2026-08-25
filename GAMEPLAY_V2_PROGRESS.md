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

## V2-2 — NOT STARTED
