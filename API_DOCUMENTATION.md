# Coins API Documentation

This document explains the structure and behavior of the Coins API endpoints for frontend integration.

## Authentication

Most endpoints require JWT authentication. Users must first register and then login to receive a JWT token.

### Authentication Flow
1. **Register** a new account (if you don't have one)
2. **Login** to receive a JWT token
3. **Include the token** in the Authorization header for protected endpoints

## Endpoints

### 1. User Registration
- **Endpoint**: `POST /api/users/register`
- **Description**: Creates a new user account
- **Request Body**:
```typescript
{
  username: string;    // Required, unique username
  email: string;       // Required, valid email format
  password: string;    // Required, minimum 6 characters
}
```
- **Response Format**:
```typescript
{
  success: boolean;
  msg: string;
  user: {
    user_id: number;
    username: string;
    email: string;
    funds: number;        // Initial funds: 1000.00
    created_at: string;   // ISO date string
  }
}
```
- **Status Codes**:
  - 201: User created successfully
  - 400: Missing required fields or validation failed
  - 409: Username or email already exists

### 2. User Login
- **Endpoint**: `POST /api/users/login`
- **Description**: Authenticates user and returns JWT token
- **Request Body**:
```typescript
{
  email: string;       // Required, user's email
  password: string;    // Required, user's password
}
```
- **Response Format**:
```typescript
{
  success: boolean;
  msg: string;
  user: {
    user_id: number;
    username: string;
    email: string;
    funds: number;
    created_at: string;
  };
  token: string;       // JWT token for authentication
}
```
- **Status Codes**:
  - 200: Login successful
  - 400: Missing required fields
  - 401: Invalid credentials

### 3. Get All Coins
- **Endpoint**: `GET /coins`
- **Description**: Retrieves all coins in the database
- **Response Format**:
```typescript
{
  coins: {
    coin_id: number;
    name: string;
    symbol: string;
    current_price: number;  // Price in GBP with 2 decimal places
    market_cap: number;     // Value in GBP with 2 decimal places
    circulating_supply: number;
    price_change_24h: number;
    founder: string;
  }[]
}
```

### 4. Get Coin by ID
- **Endpoint**: `GET /coins/:coin_id`
- **Description**: Retrieves a specific coin by its ID
- **Parameters**: 
  - `coin_id`: number (path parameter)
- **Response Format**:
```typescript
{
  coin: {
    coin_id: number;
    name: string;
    symbol: string;
    current_price: number;  // Price in GBP with 2 decimal places
    market_cap: number;     // Value in GBP with 2 decimal places
    circulating_supply: number;
    price_change_24h: number;
    founder: string;
  }
}
```

### 5. Update Coin Price
- **Endpoint**: `PATCH /coins/:coin_id`
- **Description**: Updates the price of a specific coin
- **Parameters**:
  - `coin_id`: number (path parameter)
- **Request Body**:
```typescript
{
  price?: number;  // Price in GBP with up to 2 decimal places
  current_price?: number;  // Alternative field name, same format as price
}
```
- **Validation Rules**:
  - Price must be between 0.01 and 1,000,000,000
  - Price must be a positive number
  - Price will be rounded to 2 decimal places

### 6. Get Price History
- **Endpoint**: `GET /coins/:coin_id/history`
- **Description**: Retrieves the price history for a specific coin
- **Parameters**:
  - `coin_id`: number (path parameter)
  - `page`: number (query parameter, default: 1)
  - `limit`: number (query parameter, default: 10)
- **Response Format**:
```typescript
{
  history: {
    price: number;  // Price in GBP with 2 decimal places
    timestamp: string;  // ISO date string
    price_change_percentage: number;
  }[];
  pagination: {
    currentPage: number;
    totalPages: number;
    totalItems: number;
    itemsPerPage: number;
  }
}
```

### 7. Get Market Price History
- **Endpoint**: `GET /api/market/price-history`
- **Description**: Returns the overall market price history including total market value and trends.
- **Query Parameters**:
  - `timeRange` (optional): Time range for history data
    - Options: '10M', '30M', '1H', '2H', '12H', '24H', 'ALL'
    - Default: '30M'
- **Response Format**:
```json
{
  "history": [
    {
      "total_value": "422.54",
      "market_trend": "STABLE",
      "created_at": "2025-02-23T12:00:00.000Z",
      "timestamp": 1740484800000
    }
  ],
  "timeRange": "30M",
  "count": 1
}
```

## Important Notes

1. **Authentication**:
   - JWT tokens expire after 24 hours
   - Include token in Authorization header: `Authorization: Bearer <token>`
   - Protected endpoints return 401 for missing or invalid tokens
   - Users can only access their own data (transactions, portfolio, etc.)

2. **Number Formatting**:
   - All monetary values are returned as numbers with 2 decimal places
   - Frontend should handle currency formatting and display
   - When sending prices in requests, you can use:
     - Plain numbers (e.g., 150.00)
     - Strings that can be converted to numbers (e.g., "150.00")

3. **Error Handling**:
   - All endpoints return appropriate HTTP status codes:
     - 200: Success
     - 201: Created (registration)
     - 400: Bad Request (invalid input)
     - 401: Unauthorized (authentication required)
     - 404: Not Found (coin doesn't exist)
     - 409: Conflict (username/email already exists)
     - 500: Internal Server Error

4. **Price Changes**:
   - When updating a coin's price, the API automatically:
     - Calculates the price change percentage
     - Records the price history
     - Updates the price_change_24h field

5. **Pagination**:
   - The price history endpoint uses pagination
   - Default page size is 10 items
   - You can customize page size using the limit parameter

6. **User Funds**:
   - New users start with 1000.00 in funds
   - Transaction endpoints validate sufficient funds before processing
   - Funds are automatically updated after buy/sell transactions

## Crypto Chaos Operator Diagnostics (issue #21)

Read-only diagnostics for one Apocalypse cycle (current or completed). All
four routes are GET-only and run inside a PostgreSQL `BEGIN READ ONLY`
transaction — they cannot reconcile, settle, roll over or mutate any game
state, and they never take the game advisory lock. Authenticated responses
carry `Cache-Control: no-store` (live operator views are never cacheable).

### Access control

This backend has no admin role, and the player JWT only establishes a
player identity, so diagnostics are gated by a dedicated operator bearer
token instead:

- Server env var `GAME_DIAGNOSTICS_TOKEN` (high-entropy secret; never
  committed, never exposed to the frontend).
- Send `Authorization: Bearer <token>`.
- Token unset/blank on the server: every diagnostics route answers
  `404 { "message": "Route not found" }` (fail closed — the API is
  indistinguishable from absent).
- Missing or wrong token: `401 { "msg": "Authentication required" }`
  (timing-safe comparison).

Nothing internal is ever exposed: no cycle seed, no future (unexecuted)
collapse/event schedule, no auth data. Only EXECUTED cash-event ledger rows
are read.

### Cycle selection

All routes accept optional `?cycleId=APOC-NNNN`. Omitted means the current
cycle: the ACTIVE cycle when one exists, otherwise the most recent cycle of
any status as persisted (diagnostics never force a rollover). Unknown id:
404; malformed id: 400.

### GET /api/game/diagnostics/participants

Per-participant summary for the cycle:

```json
{
  "status": "success",
  "data": {
    "cycleId": "APOC-0007",
    "status": "ACTIVE",
    "startTime": "…", "endTime": "…", "settledAt": null,
    "participantCount": 6,
    "participants": [
      {
        "participantId": 42, "userId": 9, "username": "bot-momentum",
        "kind": "BOT", "personality": "momentum",
        "joinedAt": "…",
        "startingCash": 10000, "currentCash": 9870.5, "finalCash": null,
        "status": "ACTIVE",
        "holdings": [{ "coinId": 3, "symbol": "…", "quantity": 12.5 }],
        "buyCount": 4, "sellCount": 1,
        "passiveDebitCount": 3, "passiveDebitTotal": 45.75
      }
    ]
  }
}
```

`kind` is `HUMAN` or `BOT` (from `users.is_bot`); `personality` is the Core
5 roster strategy for bots, null for humans. `currentCash`/`finalCash` come
from the authoritative `apocalypse_participants` row, never from replaying
any stream. `passiveDebitCount`/`passiveDebitTotal` aggregate the #18
FEE/TAX/EVENT ledger. Retired coins keep their history readable.

### GET /api/game/diagnostics/activity

Bounded, paginated merged activity stream: BUY/SELL from
`apocalypse_transactions` plus FEE/TAX/EVENT from `apocalypse_cash_events`.

Query params: `limit` (integer 1–200, default 50), `offset` (integer ≥ 0,
default 0), `order` (`asc`|`desc`, default `desc` — reverse-chronological).
Invalid values are a 400, never silently coerced.

Each row: `cycleId`, `source` (`TRADE`|`LEDGER`), `type`
(`BUY`|`SELL`|`FEE`|`TAX`|`EVENT`), `participantId`, `userId`, `username`,
`kind`, `amount` (trade total or debit amount), trade-only `coinId`,
`symbol`, `quantity`, `price`, human-readable `description`, and the
authoritative `occurredAt` timestamp. The envelope also carries `total`
(all activity rows in the cycle), `returned`, `limit`, `offset`, `order`.
Empty cycles return `total: 0, activities: []`.

### GET /api/game/diagnostics/bots

Aggregate bot behaviour for the cycle, from `apocalypse_bot_ticks` (no
manual JSON parsing required):

```json
{
  "status": "success",
  "data": {
    "cycleId": "APOC-0007", "status": "ACTIVE",
    "startTime": "…", "endTime": "…", "settledAt": null,
    "tickCount": 12, "firstTickAt": "…", "lastTickAt": "…",
    "actionsRecorded": 48,
    "executed": { "total": 20, "buy": 14, "sell": 6 },
    "skipped": { "total": 26, "hold": 10, "byReason": { "hold": 10, "cooldown": 16 } },
    "rejected": { "total": 2, "byReason": { "Insufficient round holdings.": 2 } },
    "perBot": [
      { "botKey": "…", "personality": "momentum", "actions": 12,
        "executedBuys": 5, "executedSells": 2, "holds": 3,
        "skipped": 5, "rejected": 0 }
    ]
  }
}
```

`skipped.byReason` breaks down every skip (`hold`, `cooldown`,
`max-actions-per-tick`, `min-trade-value`, `trade-size-cap`); `hold` counts
deliberate HOLD decisions separately. `rejected.total` counts domain
rejections recorded in the tick ledger, with `rejected.byReason` breaking
down their (already player-facing) GameRoundError messages.

### GET /api/game/diagnostics/monitor

Apocalypse Monitor Phase 2: the raw per-coin `price_history` series for one
cycle, with honest provenance attribution. Query params: optional `cycleId`
(same selection rules as above) and optional `coinId` (positive integer;
400 invalid, 404 unknown coin).

```json
{
  "status": "success",
  "data": {
    "cycle": {
      "cycleId": "APOC-0007", "status": "ACTIVE",
      "startTime": "…", "endTime": "…",
      "settlementStartedAt": null, "settledAt": null,
      "observedAt": "…"
    },
    "attribution": "exact",
    "exact": true,
    "coins": [
      {
        "coinId": 1, "name": "FutureCoin", "symbol": "FTR",
        "history": {
          "sampleCount": 60,
          "firstObservedAt": "…", "lastObservedAt": "…",
          "attribution": "exact",
          "points": [{ "time": "…", "price": 10.5, "source": "MARKET_TICK" }]
        }
      }
    ],
    "warnings": []
  }
}
```

Attribution: rows carrying the selected cycle's provenance (migration 019)
are matched by `price_history.cycle_id` only — never by timestamp. Legacy
rows (`cycle_id IS NULL`, never backfilled) fall back to the half-open
window `created_at >= startTime AND < endTime` and are marked derived.
`data.attribution` is `exact` / `time_window_derived` / `mixed` over the
whole selected dataset (mirrored per coin in `history.attribution`), and
`exact` is false whenever any derived row is used; legacy points carry
`source: null` and a warning discloses the derived count. Executed
collapses appear only as `source: "COLLAPSE"` rows; the unexecuted collapse
schedule is never read, and future-dated rows are never exposed. Retired
coins are omitted by default unless they genuinely have selected-cycle
exact rows or legacy rows in the window (an explicit `coinId` always works).
Points are chronological and capped at 1000 per coin (truncation is
disclosed in `warnings`). `observedAt` is the database clock at read time.
