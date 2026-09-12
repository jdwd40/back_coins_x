# Changelog

## 12 September 2026 — Apocalypse runtime cutover

- Removed the former `/api/game/*` player routes while retaining token-gated read-only diagnostics.
- Removed the cycle, cycle-bot, and cycle-economy worker modules from the server lifecycle.
- Stopped registration from creating Apocalypse participants.
- Removed legacy participant peak reconciliation from the persistent market transaction.
- Preserved historical Apocalypse tables and monitor data without destructive migrations.

Curated history of meaningful production work. This is not a commit-by-commit build log.

## Unreleased — documentation reconciliation

### Changed

- Replaced the obsolete MVP plan and PRD with the current persistent-market product direction.
- Consolidated API and schema documentation around the live `/api/persistent/*` architecture.
- Added current bug and feature registers.
- Removed completed build plans, progress journals, duplicate endpoint guides, stale design audits, and archived LLM opinion drafts.
- Added a current frontend README and removed duplicated backend documentation from the frontend repository.

## 10 September 2026 — runtime visibility and chart stability

### Added

- Public `GET /api/persistent/runtime` exposing safe adaptive Director state, Golden/Demon roles, active persistent coin events, capped net modifiers, and recent decision summaries.
- Player UI for Director activity and per-coin event visibility.

### Fixed

- Stabilised 5M/10M chart behaviour, stale-response handling, and range changes.
- Capped player chart selectors at 12H and removed the `ALL` option from the UI.

## 8 September 2026 — adaptive Director safeguards

### Added

- Adaptive `NORMAL`, `BOOM`, `BUST`, and `RESCUE` decisions using bounded market observations.
- Market-wide stagnation breadth, 20-minute intervention refractory, shorter new-emergency response, rescue corroboration, and Golden/Demon revalidation.
- Persistent Director decision history with public-safe summary codes.

### Fixed

- Persistent price-history reads now consistently select world-scoped `MARKET_TICK` rows with `cycle_id IS NULL`.
- Backend deployment now fails closed unless exactly one active persistent world exists.

## 5–6 September 2026 — persistent market cutover

### Added

- Persistent account, holding, and append-only transaction economy with one £10,000 starting grant.
- Persistent bots, bot debt/loan ledger, leaderboard, signals, diagnostics, coin death, and delayed authored replacement runtime.
- Persistent frontend provider, trading panels, player status, account activity, leaderboard, and continuous-market header.

### Changed

- The persistent market writer became the sole production gameplay price writer.
- Normal player routes moved to `/api/persistent/*`; the old cycle surface remains compatibility-only.
- Legacy cycle, bot, and economy workers stopped starting in production.

### Fixed

- First trade can provision a persistent account instead of being blocked by the frontend.
- Persistent price-history provenance is verified during deployment.

## 30–31 August 2026 — market simulation foundation

### Added

- Central simulation configuration, market phases, coin events, market state, trading pressure, dynamic collapse, pricing checkpoints, deterministic simulation harnesses, and multi-cycle quality gates.
- Public market phase and event information.

### Changed

- Unified live pricing and historical persistence through a single writer path.
- Tuned market balance using repeated deterministic simulations.

## 20–29 August 2026 — Crypto Chaos round-era release

### Added

- 30-minute Apocalypse cycles, fractional round trading, bots, passive economy events, leaderboard/results, collapse scheduling, and operator diagnostics.
- Internal Apocalypse Monitor with cycle discovery and exact/derived history provenance.

### Status

This era is retained as historical/compatibility context. It is not the current persistent player experience.

## Earlier Coins MVP

- Registration/login, fictional coin catalogue, legacy portfolios and transactions, price history, market statistics, React UI, PostgreSQL persistence, and VPS deployment.
