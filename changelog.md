# Changelog

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
