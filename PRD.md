# Product requirements document — Coins / Crypto Chaos

Status: current production product
Last reviewed: 12 September 2026

## 1. Product summary

Coins is a small-scale persistent fantasy trading game for friends and family. Players trade fictional assets with virtual British pounds while an always-on simulated market, bots, coin events, and an adaptive Director create opportunities and risk.

The experience should feel like a game, not a finance product. It must never imply that virtual performance predicts real investing outcomes.

## 2. Product goals

- Make the market understandable enough for players to form strategies.
- Keep it lively when no human is online.
- Make gains and losses visible through prices, holdings, activity, and leaderboard movement.
- Preserve trustworthy trading and account state.
- Support short visits without requiring a round start or reset.
- Remain mobile-friendly and practical to maintain on the existing VPS stack.

## 3. Primary user journey

1. A visitor opens `/coins/` and can inspect the live market, Director state, events, and leaderboard.
2. The visitor registers or logs in.
3. The backend provisions one persistent account with £10,000 virtual cash.
4. The player chooses an ALIVE coin and a fractional quantity.
5. The UI previews the trade; the backend uses the current server-owned price.
6. A successful trade atomically updates cash, holdings, and transaction history.
7. The UI adopts the returned account and continues background synchronisation.
8. The player tracks wealth, cost basis, recent activity, charts, and rank.

There is no join button, countdown, settlement screen, or scheduled reset in the normal player experience.

## 4. Functional requirements

### Authentication

- Register with unique username/email and a password of at least six characters.
- Store only a bcrypt password hash.
- Log in with email/password and return a 24-hour JWT.
- Require the JWT for personal account and trade operations.
- Never expose secrets, password hashes, the world seed, or internal Director reasoning.

### Market browsing

- Publicly show the non-retired coin catalogue and current prices.
- Show persistent status, archetype, momentum, and recent change.
- Show coin detail, current active events, and chart history.
- Show aggregate market value and high/low information.
- Keep player chart selectors bounded to a useful maximum of 12 hours.

### Persistent trading

- Provide each account exactly one £10,000 virtual starting grant per world.
- Support fractional BUY and SELL quantities.
- Calculate execution price and total on the server.
- Reject invalid quantities, trades below £0.01, insufficient cash, insufficient holdings, retired coins, and dead coins.
- Update cash, holdings, weighted-average cost basis, and append-only ledger atomically.
- Return the updated account with a successful trade.

### Portfolio and history

- Show cash, debt where applicable, holdings value, and net worth.
- Show quantity, live value, and cost basis for holdings.
- Show the authenticated player's persistent trades newest first.
- Treat dead-coin holdings as worth £0 without deleting the historical position or ledger.

### Bots and leaderboard

- Run bots continuously through the same persistent trade rules.
- Use different bot personalities/exposure limits to create varied competition.
- Rank humans and bots together by `cash + live holdings value − debt`.
- Allow a bankrupt bot, and only a bot, to receive repeated £10,000 interest-free loans.
- Keep bot actions deterministic/idempotent per claimed tick.

### Director and events

- Run a long-lived six-regime market environment.
- Observe current market conditions on a bounded lookback.
- Use short-term `NORMAL`, `BOOM`, `BUST`, or `RESCUE` interventions with cooldown safeguards.
- Create persistent coin events lasting 1–15 minutes with bounded individual and stacked effects.
- Assign temporary Golden and Demon roles.
- Publicly explain safe summaries of current/recent actions without leaking future state or raw internal reasoning.

### Coin death and replacement

- Make death an explicit persisted `ALIVE → DEAD` transition.
- Set a dead coin to exactly £0 and block both buying and selling.
- Retire dead catalogue entries.
- Add no more than one authored replacement for an eligible death after the configured delay.
- Never revive or reuse a dead coin as the replacement.

### Diagnostics

- Keep operator diagnostics read-only and separately token-gated.
- Fail closed as 404 when diagnostics are not configured.
- Preserve the internal Apocalypse monitor only as a compatibility/historical tool.

## 5. Non-functional requirements

### Correctness and reliability

- PostgreSQL is the source of truth for durable game/economy state.
- Trade writes are atomic and guarded against concurrent overspend/oversell.
- Market, event, Director, bot, debt, death, and replacement operations are restart-safe and idempotent where required.
- The production market must require exactly one active world.
- Market ticks and chart history must retain explicit provenance.

### Security

- HTTPS in production.
- Non-empty `JWT_SECRET` required in production.
- Users may act only on their own account and trades.
- No public endpoint may mutate prices or start/stop the market.
- No client-supplied price is trusted.

### Performance and usability

- Support the intended small user base with responsive interactions.
- Use bounded queries and capped history payloads.
- Prefer a mobile-first, game-like, readable interface with clear loading/error/disabled states.
- Keep persistent gameplay usable if secondary historical statistics are temporarily unavailable.

### Maintainability

- Preserve the Vite/React/TypeScript frontend and Node/Express/PostgreSQL backend.
- Prefer small, focused changes with tests.
- Keep one documented source of truth for each concern.
- Do not reintroduce removed unsafe routes or duplicate pricing/economy authorities.

## 6. Success criteria

- Registration and login work reliably.
- A player's successful buy/sell is reflected consistently in cash, holdings, ledger, and UI.
- The market continues across server restarts without resetting the world.
- Bots continue trading and leaderboard values remain explainable.
- Director actions and events create visible movement without uncontrolled collapse loops.
- Dead coins never revive or trade and replacements appear once.
- Player charts show only persistent-world history and do not glitch across short ranges.
- Production deploys fail before restart when migrations/schema/world checks fail.

## 7. Out of scope

- Real assets, real money, payment processing, deposits, withdrawals, prizes, or gambling.
- Blockchain, wallets, custody, exchange connectivity, or financial advice.
- High-scale infrastructure, microservices, or a stack rewrite.
- Admin trading/price controls unless a future requirement defines authentication and audit rules first.
