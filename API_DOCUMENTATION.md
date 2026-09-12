# Coins API

Current API reference for `jdwd40/back_coins_x` on `main`, verified against the mounted Express routes on 12 September 2026.

Base URL:

```text
Production: https://jdwd40.com/api-2/api
Local:      http://localhost:3000/api
```

## Authentication

Player endpoints use a JWT returned by `POST /api/users/login`:

```http
Authorization: Bearer <token>
```

Login tokens expire after 24 hours. Operator diagnostics use a separate `GAME_DIAGNOSTICS_TOKEN`; player JWTs do not grant diagnostics access.

## Persistent player API — primary

These endpoints back the current player experience.

| Method | Path | Auth | Purpose |
|---|---|---:|---|
| `POST` | `/api/persistent/trades/buy` | JWT | Buy at the server-locked live price |
| `POST` | `/api/persistent/trades/sell` | JWT | Sell at the server-locked live price |
| `GET` | `/api/persistent/account` | JWT | Current player's cash, debt, holdings, and wealth |
| `GET` | `/api/persistent/transactions?limit=N` | JWT | Current player's newest-first trade ledger; default 50, max 100 |
| `GET` | `/api/persistent/leaderboard` | Public | Humans and bots ranked by net worth |
| `GET` | `/api/persistent/signals` | Public | Persistent coin prices, status, archetypes, momentum, and broad regime |
| `GET` | `/api/persistent/runtime` | Public | Adaptive Director mode, Golden/Demon roles, active events, capped modifiers, and recent safe decision summaries |

### Buy or sell

The authenticated user is taken from the JWT. Do not send a user id, price, cycle id, or Director data.

```json
{
  "coin_id": 4,
  "quantity": 1.25
}
```

Both trade endpoints return `201` with:

```json
{
  "status": "success",
  "message": "Persistent buy executed at the server-locked live price",
  "data": {
    "transaction": {},
    "account": {}
  }
}
```

Business rejections use `{ "status": "error", "message": "..." }`. The economy enforces positive quantities, a £0.01 minimum notional, sufficient cash/holdings, ALIVE/non-retired coins, and server-owned pricing.

### Account provisioning

Registration attempts to provision one persistent account with £10,000 virtual cash. If the world is temporarily unavailable, first trade provisions it idempotently. Account and transaction reads return `provisioned: false` rather than fabricating data.

## Coins and market history

| Method | Path | Auth | Purpose |
|---|---|---:|---|
| `GET` | `/api/coins` | Public | Current non-retired coin catalogue |
| `GET` | `/api/coins/:coin_id` | Public | One coin |
| `GET` | `/api/coins/:coin_id/price-history?range=1H` | Public | Persistent price history |
| `GET` | `/api/market/status` | Public | Writer status and next-update countdown |
| `GET` | `/api/market/stats` | Public | Aggregate market statistics |
| `GET` | `/api/market/price-history?timeRange=30M` | Public | Aggregate market-value history |

Coin history ranges: `10M`, `30M`, `1H`, `2H`, `24H`, `7D`, `30D`, `ALL`. The player UI intentionally offers only `5M`, `10M`, `30M`, `1H`, and `2H`; `5M` requests `10M` then clips client-side.

Aggregate history supports `10M`, `30M`, `1H`, `2H`, `12H`, `24H`, and `ALL`. The player UI caps selectors at `12H`; its `5M` view requests `10M` then clips client-side.

Persistent coin-history reads include only world ticks with `source='MARKET_TICK'` and `cycle_id IS NULL`. They do not mix older Apocalypse rows into current charts.

## Users

| Method | Path | Auth | Purpose |
|---|---|---:|---|
| `POST` | `/api/users/register` | Public | Register with `username`, `email`, and `password` |
| `POST` | `/api/users/login` | Public | Authenticate and receive a JWT |
| `GET` | `/api/users/:user_id` | JWT | Read a profile |
| `PUT` | `/api/users/:user_id` | JWT | Update a profile |
| `DELETE` | `/api/users/:user_id` | JWT | Delete a user |
| `PATCH` | `/api/users/:user_id/funds` | JWT | Retained compatibility route; always returns `403` |

Cross-user ownership enforcement for the three profile routes is tracked as an open defect in [`bugs.md`](bugs.md).

## Legacy compatibility API

These routes remain mounted for old clients and the internal Apocalypse monitor. They are not the primary player economy and must not be used for new UI work.

| Prefix | Routes |
|---|---|
| `/api/transactions` | `POST /buy`, `POST /sell`, `GET /user/:user_id`, `GET /:transaction_id`, `GET /portfolio/:user_id` |
| `/api/game` | `GET /state`, `/market-signals`, `/leaderboard`, `/persistent-leaderboard`, `/leaderboards/recent`, `/results/:cycleId`, `/participant`; `POST /join`, `/trades/buy`, `/trades/sell` |

The root `POST /api/transactions`, manual coin-price mutation, market start/stop, and `/api/market/history` routes were deliberately removed.

## Operator diagnostics

All routes below require `Authorization: Bearer <GAME_DIAGNOSTICS_TOKEN>`, are GET-only, return `Cache-Control: no-store`, and fail closed with 404 when the token is not configured.

| Path | Purpose |
|---|---|
| `/api/game/diagnostics/persistent` | Read-only persistent-world diagnostic snapshot |
| `/api/game/diagnostics/participants` | Legacy cycle participant diagnostics |
| `/api/game/diagnostics/activity` | Legacy cycle activity diagnostics |
| `/api/game/diagnostics/bots` | Legacy cycle bot diagnostics |
| `/api/game/diagnostics/monitor` | Per-cycle price series with provenance |
| `/api/game/diagnostics/monitor/cycles` | Newest-first monitor cycle list |

Diagnostics never expose the world seed, future event schedule, or internal Director reasoning.

## Response and status conventions

- `200` successful read
- `201` successful registration or trade
- `400` invalid input or domain rejection
- `401` missing, invalid, or expired authentication
- `403` retired self-funding route
- `404` missing resource or fail-closed diagnostics
- `409` duplicate username/email
- `500` unexpected server error
- `503` database unavailable

For exact DTO validation used by the current frontend, see `src/services/persistentService.ts` in `jdwd40/fcoins_y`.
