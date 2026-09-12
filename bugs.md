# Bugs

Confirmed Coins defects only. Last reviewed against both production branches on 12 September 2026.

## Open

### P1 — authenticated profile routes do not enforce ownership

**Affected routes:**

- `GET /api/users/:user_id`
- `PUT /api/users/:user_id`
- `DELETE /api/users/:user_id`

**Evidence:** `authenticateToken` confirms that the JWT belongs to a real user, but the three handlers use the path `user_id` without comparing it with `req.user.user_id`. An authenticated user can therefore target another user's profile id. The transaction and portfolio handlers already perform this ownership check.

**Expected:** ordinary users may read, modify, or delete only their own profile. There is no admin role.

**Status:** confirmed; not fixed by this documentation pass.

## Fixed

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
