# Changelog

## Apocalypse Monitor Phase 2: read-only monitor diagnostics API (2026-08-29)

- **New endpoint** `GET /api/game/diagnostics/monitor` on the restricted
  diagnostics router (same `GAME_DIAGNOSTICS_TOKEN` gate; fail-closed 404
  when unset; `BEGIN READ ONLY`; no reconcile/settle/locks; authenticated
  diagnostics responses now carry `Cache-Control: no-store`).
- Returns the raw per-coin `price_history` series for one cycle with honest
  attribution: exact rows matched by `price_history.cycle_id` only (never
  timestamp-matched); legacy `cycle_id IS NULL` rows attributed by the
  half-open `[start_time, end_time)` window and marked derived
  (`attribution`: `exact`/`time_window_derived`/`mixed`, `exact` boolean,
  per-coin attribution, disclosure warnings).
- Optional `cycleId=APOC-NNNN` (omitted = currently persisted cycle, never
  reconciled) and `coinId` (positive integer; 400 invalid, 404 unknown).
- Executed collapses surface only as `source=COLLAPSE` rows; the unexecuted
  schedule and future-dated rows are never read or exposed. Retired coins
  are hidden by default unless they genuinely have selected-cycle history.
  No seed or internal `cycle_id` is exposed; reads perform zero writes.
- Docs: `API_DOCUMENTATION.md` monitor section; `docs/database_schema.md`
  index note. No gameplay, writer, or schema changes.

## Apocalypse Monitor persistence foundation (2026-08-29)

- **Migration 019** (`019_price_history_cycle_provenance.sql`): adds nullable
  `price_history.cycle_id` (FK → `apocalypse_cycles.cycle_id`), nullable
  `price_history.source` (`MARKET_TICK`/`COLLAPSE` CHECK), and index
  `idx_price_history_cycle_coin_created (cycle_id, coin_id, created_at)`.
  Additive and data-preserving; legacy rows keep NULL and are never backfilled.
- **Writers**: the normal market writer (`models/market-simulator.js`) now
  stamps every tick with the already-reconciled cycle id and
  `source='MARKET_TICK'`; the collapse writer
  (`game/collapseScheduleService.js`) stamps its £0 transition rows with the
  caller's cycle id and `source='COLLAPSE'`. Schedule execution stays the
  only collapse authority.
- No API, pricing, rollover, settlement, or gameplay changes.
