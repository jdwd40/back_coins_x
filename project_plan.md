# Coins project plan

Single source of truth for the Coins project. Last reconciled with `back_coins_x/main` and `fcoins_y/master` on 12 September 2026.

## Product direction

Coins, presented in the UI as **Crypto Chaos**, is a persistent fantasy cryptocurrency exchange game. Players use virtual pounds to trade fictional coins while prices, events, bots, and the Director continue running whether or not a human is online.

This is not a real exchange, blockchain product, investment service, wallet, gambling app, or financial-advice product.

## Current production experience

- Register and log in with email/password authentication.
- Receive one persistent account with £10,000 virtual starting cash.
- View live fantasy coins, detail views, momentum, archetypes, and charts.
- Buy and sell fractional quantities at a server-locked live price.
- View cash, holdings, cost basis, wealth, and transaction history.
- Compete with persistent bots on a live leaderboard.
- See the current broad market regime and adaptive Director actions.
- See Golden/Demon roles and active coin events with duration/modifier information.
- Lose the full value of holdings when a coin dies.
- See dead coins retire and authored replacements enter later.
- Use a market that runs continuously with no 30-minute reset.

## Current architecture

| Layer | Repository / technology | Current responsibility |
|---|---|---|
| Frontend | `jdwd40/fcoins_y` — Vite, React, TypeScript, Tailwind, Chart.js | Player UI, strict API parsing, polling, charts, auth state |
| Backend | `jdwd40/back_coins_x` — Node.js, Express | REST API, authentication, trading, market runtime, bots, Director |
| Database | PostgreSQL | Authoritative persistent state and ledgers |
| Runtime | pm2 + Nginx on VPS | API process and static site |
| Delivery | GitHub Actions | Migrate/verify/restart backend; test/build/rsync frontend |

Production branches are backend `main` and frontend `master`.

## Authoritative runtime systems

### Market

- `models/market-simulator.js` is the only production writer of gameplay prices.
- A batch runs every 30 seconds.
- `game/persistentPricing.js` performs deterministic price calculations.
- `coins.current_price` is the live price authority.
- `price_history` stores persistent ticks with `source='MARKET_TICK'` and `cycle_id IS NULL`.
- `market_price_checkpoints` and committed Director state make restart/resume deterministic.

### Director and events

- The long-running Director regime is one of `GOLDEN_AGE`, `BOOM`, `BULL`, `BEAR`, `BUST`, or `RECESSION`.
- The adaptive short-term Director uses `NORMAL`, `BOOM`, `BUST`, and `RESCUE` modes.
- Decisions run on a one-minute cadence, use bounded observations, and enforce refractory safeguards.
- Golden/Demon roles and persistent coin events are world-scoped, persisted, bounded, and visible through `/api/persistent/runtime`.
- Coin events last 1–15 minutes, with no more than five active events per coin and capped net influence.

### Economy and bots

- `persistent_accounts`, `persistent_holdings`, and `persistent_transactions` are the primary player economy.
- Trade cash, holdings, and ledger updates are atomic.
- Bots use the same persistent economy and appear on the same leaderboard as humans.
- Bankrupt bots may receive repeated £10,000 interest-free loans; humans cannot receive them.
- Leaderboard net worth is cash + live holdings value − debt.

### Coin lifecycle

- Persistent status is `ALIVE` or `DEAD`.
- Death is an explicit, persisted transition; a dead coin is exactly £0 and cannot be bought or sold.
- Player and bot holdings in a dead coin become worthless.
- The replacement worker checks every minute; eligible deaths receive at most one authored replacement after the configured delay (currently six hours).

## Core invariants

1. Exactly one active persistent world exists in production.
2. Clients never submit or choose execution prices.
3. Users cannot buy beyond available cash or sell beyond holdings.
4. Successful trades keep cash, holdings, and transaction history consistent in one DB transaction.
5. Persistent history never mixes cycle-scoped Apocalypse ticks.
6. Dead coins remain £0, cannot trade, and are never revived.
7. Director/event modifiers are bounded and cannot directly set a final price.
8. Bot tick claims and event/decision identities are idempotent across restarts or multiple processes.
9. The world seed and internal Director reasoning are never exposed publicly.
10. Production deploys migrate and verify schema/world state before restart.

## Current UI structure

The main route is a mobile-first persistent game surface with:

1. Persistent market/Director header.
2. Player cash, wealth, and holdings status.
3. Leaderboard pressure.
4. Live coin grid and coin detail/trade panels.
5. Persistent leaderboard and player activity.
6. Secondary market statistics, aggregate chart, and full asset list.

The profile route uses the persistent account and transaction ledger. The internal `/coins/internal/apocalypse-monitor` remains available for historical cycle diagnostics and is not part of player navigation.

## Legacy compatibility boundary

The former 30-minute Apocalypse game is not the current product. Its database tables, services, diagnostics, tests, and some unmounted frontend modules remain to preserve compatibility and historical monitoring.

- Legacy game-cycle, bot, and economy workers do not start in production.
- Legacy `/api/game/*` and `/api/transactions/*` routes remain mounted.
- New player features must use `/api/persistent/*`.
- Do not delete legacy runtime code until callers and the internal monitor have been audited and removal tests exist.

## Current priorities

### P0 — protect the live game

- Preserve authentication, atomic trading, persistent price provenance, world identity, and death/replacement invariants.
- Fix the cross-user profile-route authorization defect recorded in `bugs.md`.

### P1 — playtest and tune

- Observe the market across multi-hour and multi-day play.
- Tune volatility, event frequency/severity, Director intervention frequency, bot competitiveness, coin death rate, and replacement pacing only from evidence.
- Avoid adding mechanics while core balance is still being measured.

### P1 — reduce maintenance risk

- Use the planned complexity/refactoring review to rank small behaviour-preserving improvements.
- Produce and maintain human and LLM architecture references from the current code.
- Retire proven-unreachable cycle compatibility code in a separate, tested change.

### P2 — player visibility

- Decide whether to expose a safe bot activity feed so players can inspect bot buys/sells without leaking internal strategy or future state.

## Testing and release gates

Backend changes should run the focused affected suites and the full Jest suite when feasible. Market/Director changes also require the deterministic simulation gates. Frontend changes should run:

```bash
npm run test:unit
npm run test:ui
npx tsc --noEmit
npm run lint
npm run build
```

Production releases must preserve the workflow gates in both repositories. Database changes are additive tracked migrations; `db/seed.js` is never a production migration path.

## Out of scope

- Real cryptocurrency, blockchain, wallets, custody, mining, exchange integrations, or token issuance.
- Real-money payments, deposits, withdrawals, prizes, betting, or gambling mechanics.
- Financial advice or investment recommendations.
- Unnecessary microservices, distributed infrastructure, or replacement of the existing stack.
- Large feature expansion before the persistent game is stable and play-balanced.

## Documentation ownership

- This file is the current project/roadmap authority.
- `PRD.md` defines product requirements.
- `API_DOCUMENTATION.md` maps the live API.
- `docs/database_schema.md` maps current persistence.
- `docs/persistent-world-ops.md` owns world provisioning and deploy operations.
- `bugs.md`, `new_features.md`, and `changelog.md` track defects, future work, and completed work.

