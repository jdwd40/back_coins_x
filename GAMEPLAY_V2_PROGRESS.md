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
