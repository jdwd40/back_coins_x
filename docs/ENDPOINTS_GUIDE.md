# API Endpoints Guide

This guide provides detailed documentation for the Portfolio, Transactions, and Market endpoints.

## Table of Contents
- [Authentication](#authentication)
- [Portfolio Endpoints](#portfolio-endpoints)
- [Transaction Endpoints](#transaction-endpoints)
- [Market Endpoints](#market-endpoints)

---

## Authentication

Most transaction and portfolio endpoints require authentication. Include a valid JWT token in the Authorization header:

```
Authorization: Bearer <your_jwt_token>
```

**Important:** Users can only access their own data. Attempting to access another user's portfolio or transactions will result in a `401 Unauthorized` error.

---

## Portfolio Endpoints

### Get User Portfolio

Retrieves the user's current portfolio along with their available funds.

**Endpoint:** `GET /api/transactions/portfolio/:user_id`

**Authentication:** Required ✅

**URL Parameters:**
- `user_id` (integer) - The ID of the user

**Success Response (200 OK):**
```json
{
  "portfolio": [
    {
      "portfolio_id": 1,
      "user_id": 1,
      "coin_id": 1,
      "coin_name": "Bitcoin",
      "coin_symbol": "BTC",
      "quantity": 2.5,
      "average_purchase_price": 45000.00,
      "current_price": 50000.00,
      "total_value": 125000.00,
      "profit_loss": 12500.00,
      "profit_loss_percentage": 11.11
    },
    {
      "portfolio_id": 2,
      "user_id": 1,
      "coin_id": 2,
      "coin_name": "Ethereum",
      "coin_symbol": "ETH",
      "quantity": 10.0,
      "average_purchase_price": 3000.00,
      "current_price": 3500.00,
      "total_value": 35000.00,
      "profit_loss": 5000.00,
      "profit_loss_percentage": 16.67
    }
  ],
  "user_funds": 10000.50
}
```

**Error Responses:**

| Status Code | Description |
|-------------|-------------|
| 401 | Unauthorized - Invalid token or trying to access another user's portfolio |
| 404 | User not found |

**Example Request (cURL):**
```bash
curl -X GET \
  http://localhost:9090/api/transactions/portfolio/1 \
  -H 'Authorization: Bearer YOUR_JWT_TOKEN'
```

**Example Request (JavaScript):**
```javascript
const response = await fetch('http://localhost:9090/api/transactions/portfolio/1', {
  method: 'GET',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  }
});
const data = await response.json();
```

---

## Transaction Endpoints

### 1. Buy Coins

Process a buy transaction for a specific cryptocurrency.

**Endpoint:** `POST /api/transactions/buy`

**Authentication:** Required ✅

**Request Body:**
```json
{
  "user_id": 1,
  "coin_id": 1,
  "amount": 2.5
}
```

**Parameters:**
- `user_id` (integer, required) - The ID of the user making the purchase
- `coin_id` (integer, required) - The ID of the coin to buy
- `amount` (number, required) - The quantity of coins to buy (must be > 0)

**Success Response (201 Created):**
```json
{
  "status": "success",
  "message": "Buy transaction completed successfully",
  "data": {
    "transaction_id": 123,
    "user_id": 1,
    "coin_id": 1,
    "type": "BUY",
    "quantity": 2.5,
    "price_at_transaction": 50000.00,
    "total_amount": 125000.00,
    "created_at": "2025-11-04T10:30:00.000Z",
    "new_balance": 9875000.00
  }
}
```

**Error Responses:**

| Status Code | Description | Example Response |
|-------------|-------------|------------------|
| 400 | Insufficient funds | `{ "status": "error", "message": "Insufficient funds. You need 125000.00 to complete this purchase.", "required_amount": 125000.00, "current_price": 50000.00 }` |
| 401 | Unauthorized | `{ "status": "error", "message": "Unauthorized. You can only make transactions for your own account." }` |
| 404 | Coin not found | `{ "status": "error", "message": "Coin not found. Please provide a valid coin_id." }` |

**Example Request (cURL):**
```bash
curl -X POST \
  http://localhost:9090/api/transactions/buy \
  -H 'Authorization: Bearer YOUR_JWT_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{
    "user_id": 1,
    "coin_id": 1,
    "amount": 2.5
  }'
```

---

### 2. Sell Coins

Process a sell transaction for a specific cryptocurrency.

**Endpoint:** `POST /api/transactions/sell`

**Authentication:** Required ✅

**Request Body:**
```json
{
  "user_id": 1,
  "coin_id": 1,
  "amount": 1.5
}
```

**Parameters:**
- `user_id` (integer, required) - The ID of the user making the sale
- `coin_id` (integer, required) - The ID of the coin to sell
- `amount` (number, required) - The quantity of coins to sell (must be > 0)

**Success Response (201 Created):**
```json
{
  "status": "success",
  "message": "Sell transaction completed successfully",
  "data": {
    "transaction_id": 124,
    "user_id": 1,
    "coin_id": 1,
    "type": "SELL",
    "quantity": 1.5,
    "price_at_transaction": 51000.00,
    "total_amount": 76500.00,
    "created_at": "2025-11-04T11:00:00.000Z",
    "new_balance": 9951500.00
  }
}
```

**Error Responses:**

| Status Code | Description | Example Response |
|-------------|-------------|------------------|
| 400 | Insufficient coins | `{ "status": "error", "message": "Insufficient coins in portfolio. You have 1.0 coins available to sell.", "available_amount": 1.0, "requested_amount": 1.5 }` |
| 401 | Unauthorized | `{ "status": "error", "message": "Unauthorized. You can only make transactions for your own account." }` |
| 404 | Coin not found | `{ "status": "error", "message": "Coin not found. Please provide a valid coin_id." }` |

**Example Request (JavaScript):**
```javascript
const response = await fetch('http://localhost:9090/api/transactions/sell', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    user_id: 1,
    coin_id: 1,
    amount: 1.5
  })
});
const data = await response.json();
```

---

### 3. Get User Transactions

Retrieve all transactions for a specific user.

**Endpoint:** `GET /api/transactions/user/:user_id`

**Authentication:** Required ✅

**URL Parameters:**
- `user_id` (integer) - The ID of the user

**Success Response (200 OK):**
```json
{
  "transactions": [
    {
      "transaction_id": 1,
      "user_id": 1,
      "coin_id": 1,
      "coin_name": "Bitcoin",
      "coin_symbol": "BTC",
      "type": "BUY",
      "quantity": 2.5,
      "price_at_transaction": 50000.00,
      "total_amount": 125000.00,
      "created_at": "2025-11-04T10:30:00.000Z"
    },
    {
      "transaction_id": 2,
      "user_id": 1,
      "coin_id": 2,
      "coin_name": "Ethereum",
      "coin_symbol": "ETH",
      "type": "BUY",
      "quantity": 10.0,
      "price_at_transaction": 3000.00,
      "total_amount": 30000.00,
      "created_at": "2025-11-04T09:15:00.000Z"
    }
  ]
}
```

**Error Responses:**

| Status Code | Description |
|-------------|-------------|
| 401 | Unauthorized - Invalid token or trying to access another user's transactions |
| 404 | User not found |

**Example Request (cURL):**
```bash
curl -X GET \
  http://localhost:9090/api/transactions/user/1 \
  -H 'Authorization: Bearer YOUR_JWT_TOKEN'
```

---

### 4. Get Transaction by ID

Retrieve details of a specific transaction.

**Endpoint:** `GET /api/transactions/:transaction_id`

**Authentication:** Required ✅

**URL Parameters:**
- `transaction_id` (integer) - The ID of the transaction

**Success Response (200 OK):**
```json
{
  "transaction_id": 1,
  "user_id": 1,
  "coin_id": 1,
  "coin_name": "Bitcoin",
  "coin_symbol": "BTC",
  "type": "BUY",
  "quantity": 2.5,
  "price_at_transaction": 50000.00,
  "total_amount": 125000.00,
  "created_at": "2025-11-04T10:30:00.000Z"
}
```

**Error Responses:**

| Status Code | Description |
|-------------|-------------|
| 401 | Unauthorized |
| 404 | Transaction not found |

**Example Request (cURL):**
```bash
curl -X GET \
  http://localhost:9090/api/transactions/123 \
  -H 'Authorization: Bearer YOUR_JWT_TOKEN'
```

---

### 5. Create Transaction (Legacy)

Create a transaction manually (not recommended - use `/buy` or `/sell` endpoints instead).

**Endpoint:** `POST /api/transactions`

**Authentication:** Required ✅

**Request Body:**
```json
{
  "user_id": 1,
  "coin_id": 1,
  "type": "BUY",
  "amount": 2.5,
  "price_at_transaction": 50000.00
}
```

**Parameters:**
- `user_id` (integer, required)
- `coin_id` (integer, required)
- `type` (string, required) - Either "BUY" or "SELL"
- `amount` (number, required) - Must be > 0
- `price_at_transaction` (number, required) - Must be > 0

**Success Response (201 Created):**
```json
{
  "transaction": {
    "transaction_id": 123,
    "user_id": 1,
    "coin_id": 1,
    "type": "BUY",
    "quantity": 2.5,
    "price_at_transaction": 50000.00,
    "created_at": "2025-11-04T10:30:00.000Z"
  }
}
```

**Note:** This endpoint does not automatically update the user's funds or portfolio. Use `/buy` or `/sell` endpoints for complete transaction processing.

---

## Market Endpoints

### 1. Get Market Status

Get the current status of the market simulator (running/stopped).

**Endpoint:** `GET /api/market/status`

**Authentication:** Not required ❌

**Success Response (200 OK):**
```json
{
  "isRunning": true,
  "updateInterval": 5000,
  "lastUpdate": "2025-11-04T12:00:00.000Z",
  "message": "Market simulation is running"
}
```

**Example Request (cURL):**
```bash
curl -X GET http://localhost:9090/api/market/status
```

**Example Request (JavaScript):**
```javascript
const response = await fetch('http://localhost:9090/api/market/status');
const status = await response.json();
console.log(`Market is ${status.isRunning ? 'running' : 'stopped'}`);
```

---

### 2. Get Market Statistics

Get aggregated market statistics across all coins.

**Endpoint:** `GET /api/market/stats`

**Authentication:** Not required ❌

**Success Response (200 OK):**
```json
{
  "total_market_cap": 2500000000.00,
  "total_volume_24h": 150000000.00,
  "bitcoin_dominance": 45.5,
  "ethereum_dominance": 18.2,
  "total_coins": 10,
  "market_trend": "bullish",
  "last_updated": "2025-11-04T12:00:00.000Z"
}
```

**Example Request (cURL):**
```bash
curl -X GET http://localhost:9090/api/market/stats
```

---

### 3. Get Market History

Get historical market data with optional time range filtering.

**Endpoint:** `GET /api/market/history?timeRange=30M`

**Authentication:** Not required ❌

**Query Parameters:**
- `timeRange` (string, optional) - Time range filter
  - Options: `10M`, `30M`, `1H`, `2H`, `12H`, `24H`, `ALL`
  - Default: Returns all data if not specified

**Success Response (200 OK):**
```json
{
  "history": [
    {
      "total_value": 2450000000.00,
      "market_trend": "bullish",
      "created_at": "2025-11-04T11:30:00.000Z",
      "timestamp": 1730725800000
    },
    {
      "total_value": 2480000000.00,
      "market_trend": "bullish",
      "created_at": "2025-11-04T11:45:00.000Z",
      "timestamp": 1730726700000
    }
  ],
  "count": 2
}
```

**Example Request (cURL):**
```bash
curl -X GET 'http://localhost:9090/api/market/history?timeRange=1H'
```

**Example Request (JavaScript):**
```javascript
const timeRange = '30M'; // Last 30 minutes
const response = await fetch(`http://localhost:9090/api/market/history?timeRange=${timeRange}`);
const history = await response.json();
```

---

### 4. Get Market Price History

Get detailed price history for market visualization.

**Endpoint:** `GET /api/market/price-history?timeRange=30M`

**Authentication:** Not required ❌

**Query Parameters:**
- `timeRange` (string, optional) - Time range filter
  - Options: `10M`, `30M`, `1H`, `2H`, `12H`, `24H`, `ALL`
  - Default: `30M`

**Success Response (200 OK):**
```json
{
  "history": [
    {
      "total_value": 2450000000.00,
      "market_trend": "bullish",
      "created_at": "2025-11-04T11:30:00.000Z",
      "timestamp": 1730725800000
    },
    {
      "total_value": 2480000000.00,
      "market_trend": "bullish",
      "created_at": "2025-11-04T11:45:00.000Z",
      "timestamp": 1730726700000
    }
  ],
  "timeRange": "30M",
  "count": 2
}
```

**Example Request (cURL):**
```bash
curl -X GET 'http://localhost:9090/api/market/price-history?timeRange=1H'
```

---

### 5. Start Market Simulation

Start the market price simulation.

**Endpoint:** `POST /api/market/start`

**Authentication:** Not required ❌

**Success Response (200 OK):**
```json
{
  "msg": "Market simulation started",
  "status": {
    "isRunning": true,
    "updateInterval": 5000,
    "lastUpdate": "2025-11-04T12:00:00.000Z"
  }
}
```

**Example Request (cURL):**
```bash
curl -X POST http://localhost:9090/api/market/start
```

---

### 6. Stop Market Simulation

Stop the market price simulation.

**Endpoint:** `POST /api/market/stop`

**Authentication:** Not required ❌

**Success Response (200 OK):**
```json
{
  "msg": "Market simulation stopped",
  "status": {
    "isRunning": false,
    "updateInterval": 5000,
    "lastUpdate": "2025-11-04T12:00:00.000Z"
  }
}
```

**Example Request (cURL):**
```bash
curl -X POST http://localhost:9090/api/market/stop
```

---

## Common Error Responses

All endpoints may return the following error responses:

| Status Code | Description |
|-------------|-------------|
| 400 | Bad Request - Invalid input parameters |
| 401 | Unauthorized - Missing or invalid authentication token |
| 403 | Forbidden - Valid token but insufficient permissions |
| 404 | Not Found - Requested resource doesn't exist |
| 500 | Internal Server Error - Server-side error |
| 503 | Service Unavailable - Database connection error |

**Example Error Response:**
```json
{
  "msg": "Invalid input parameters",
  "error": "Amount must be greater than 0"
}
```

---

## Best Practices

1. **Always authenticate** - Include valid JWT tokens for protected endpoints
2. **Handle errors gracefully** - Check response status codes and handle errors appropriately
3. **Use the correct endpoints** - Prefer `/buy` and `/sell` over the legacy `/transactions` POST endpoint
4. **Validate input** - Ensure amounts are positive and user_id matches the authenticated user
5. **Monitor market status** - Check `/api/market/status` to ensure the market is running before trading
6. **Rate limiting** - Be mindful of request frequency to avoid overwhelming the server

---

## Testing the API

You can test these endpoints using:
- **cURL** - Command-line tool (examples provided above)
- **Postman** - GUI-based API testing tool
- **JavaScript/fetch** - Frontend integration (examples provided above)
- **Automated tests** - See `__tests__/transactions.test.js` for examples

---

## Need Help?

For additional documentation, see:
- [API Documentation](./API_DOCUMENTATION.md)
- [Buy/Sell API Guide](./buy-sell-api.md)
- [Database Schema](./database_schema.md)

