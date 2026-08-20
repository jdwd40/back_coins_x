# Game Cycle API — Crypto Chaos Core 1 (Global Apocalypse Cycle)

Server-owned global game cycle for Crypto Chaos, implemented in the `coins`
Supabase schema by migration `00010_game_cycle.sql`. All authoritative state
lives in PostgreSQL; no process owns the timer.

## Concepts

- One **apocalypse round** at a time is `active`; expired rounds are kept as
  `completed` history in `coins.game_cycles`.
- Each round has a stable `apocalypse_id` (`APOC-0001`, `APOC-0002`, …) and a
  random `seed` recorded for reproducibility (plan §19).
- **Server time is the source of truth.** Clients must render countdowns from
  the returned `server_time` / `remaining_ms`, never from a local clock.

## Configuration

`coins.game_config` (singleton, service/admin only — no client grants):

| column | default | meaning |
|---|---|---|
| `cycle_duration_ms` | `1800000` (30 min) | length of each round; honoured on the NEXT cycle rollover |
| `align_to_boundary` | `true` | first round of a fresh install starts on a duration-aligned wall-clock boundary (for 30 min: :00 / :30) |

Chained rounds stay boundary-aligned because each round starts exactly at the
previous round's `ends_at`.

## Persistence & recovery semantics

- `coins.ensure_active_cycle()` is the single lifecycle writer. It is
  idempotent and serialised with a transaction-scoped advisory lock, so
  concurrent workers/reads cannot create duplicate active rounds. A partial
  unique index (`game_cycles_single_active_key`) enforces one active round at
  the row level even for callers that bypass the function.
- If the active round has expired, each fully-elapsed cycle is back-filled as
  a `completed` row and a fresh active round covering `now()` is created —
  deterministic roll-forward after any downtime (process restart, deploy,
  offline weekend). Back-fill is capped at 10000 cycles; beyond that the chain
  resumes at the current boundary (existing history is untouched).
- The market worker calls `ensure_active_cycle()` on every wake-up (even when
  the market is halted), and `get_game_state()` is self-healing, so the cycle
  advances with **no human players online** and never depends on browser
  polling.

## Public endpoint (browser-pollable)

RPC: `coins.get_game_state()` — granted to `anon` and `authenticated`.

PostgREST:

```
POST /rpc/get_game_state          (schema: coins)
```

supabase-js:

```ts
const { data, error } = await supabase.schema('coins').rpc('get_game_state');
```

Response (200):

```json
{
  "apocalypse_id": "APOC-0007",
  "cycle_number": 7,
  "seed": 1839204051,
  "starts_at": "2026-08-20T14:00:00+00:00",
  "ends_at": "2026-08-20T14:30:00+00:00",
  "duration_ms": 1800000,
  "server_time": "2026-08-20T14:11:32.512+00:00",
  "remaining_ms": 1107488,
  "apocalypse_pct": 38.42
}
```

| field | notes |
|---|---|
| `apocalypse_id` / `cycle_number` | stable round identity |
| `seed` | per-round random seed for reproducibility/debugging |
| `starts_at` / `ends_at` / `duration_ms` | persisted round window |
| `server_time` | authoritative current time |
| `remaining_ms` | `≥ 0`, never negative |
| `apocalypse_pct` | `0–100`, clamped |

Frontend contract: `GameState` in `src/types/database.ts`,
`fetchGameState()` in `src/services/gameService.ts` (fcoins_y).

`coins.game_cycles` (active + completed history) is world-readable
(`SELECT` to `anon`/`authenticated`, RLS `USING (true)`). All writes go
through the SECURITY DEFINER functions; clients have no DML grants, cannot
read `game_config`, and cannot execute `ensure_active_cycle()`.
`ensure_active_cycle()` is granted to `coins_worker` and `service_role` only.

## Tests

- `supabase/tests/t05_game_cycle.sql` — lifecycle, idempotency, derived-value
  shape, expiry roll-forward, multi-cycle downtime recovery, timing-math
  boundaries (~0% / 50% / ~100% clamped, non-negative remaining),
  single-active invariant, browser-role privileges, configurable duration,
  seed reproducibility under `setseed`.
- `scripts/test/game-cycle-concurrency-test.mjs` — 8 parallel clients on the
  public read path: cold-start race and expiry race both yield exactly one
  active round and converge on the same `apocalypse_id`.
- Run everything with `npm run test:supabase` (disposable local database;
  destroys nothing outside it).
