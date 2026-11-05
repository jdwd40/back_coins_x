# Bugs

Confirmed Coins defects only. Last reviewed against both production branches on 12 September 2026.

## Open

### P1 — single-transaction read does not enforce ownership

**Affected route:** `GET /api/transactions/:transaction_id`

**Evidence:** `getTransactionById` looks up the row by id alone and never compares its `user_id` with `req.user.user_id`, so any authenticated user can read any user's transaction.

**Expected:** ordinary users may read only their own transactions.

**Status:** confirmed by code reading; not fixed.

## Fixed

### Authenticated profile routes did not enforce ownership

Any authenticated user could read, update (including password and email), or delete any account through `GET`, `PUT`, and `DELETE /api/users/:user_id`.

**Fixed 5 November 2026:** the three handlers return `403` unless `:user_id` is the authenticated user. Cross-user rejections on the transaction routes also moved from `401` to `403`.

### Short-range market charts glitched or retained the wrong data

The 5-minute view previously requested an unsupported backend range, and stale responses could remain visible while changing ranges.

**Fixed 10 September 2026:** 5M maps to a 10M API request and clips client-side; responses are sanitised/windowed; stale requests are aborted; charts remount by range; selectors are capped at 12H and `ALL` is no longer exposed in the player UI. Frontend PRs #22–#24.

### First persistent trade was blocked before account provisioning

The frontend previously gated trading on an already-provisioned account even though the backend can provision on the first trade.

**Fixed 6 September 2026:** the trade gate now allows first-trade provisioning. Frontend PR #20.

### Persistent charts could mix old Apocalypse history

Persistent reads could include cycle-scoped history from the retired round game.

**Fixed 5–8 September 2026:** reads and verification now require `source='MARKET_TICK' AND cycle_id IS NULL`. Backend PRs #34 and #38.

## Reporting rule

Add only reproducible defects. Architecture debt, feature requests, and balance preferences belong in `project_plan.md` or `new_features.md`.
