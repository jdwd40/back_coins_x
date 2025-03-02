# Market API Endpoints Documentation

## Market Status Endpoint

api url address: https://jdwd40.com/api-2/

### GET /api/market/status
Returns the current market cycle and its effect on coin prices.

#### Response Format
```json
{
  "currentCycle": {
    "type": "STRONG_BOOM" | "MILD_BOOM" | "STRONG_BUST" | "MILD_BUST" | "STABLE",
    "baseEffect": number  // Range: -0.005 to 0.005 (represents -0.5% to 0.5%)
  },
  "timestamp": "2025-02-11T18:55:21Z"
}
```

#### Market Cycle Types
- `STRONG_BOOM`: Strong positive market trend (+0.5% max effect)
- `MILD_BOOM`: Mild positive market trend (+0.2% max effect)
- `STRONG_BUST`: Strong negative market trend (-0.5% max effect)
- `MILD_BUST`: Mild negative market trend (-0.2% max effect)
- `STABLE`: Neutral market trend (0% effect)

## Market Stats Endpoint

### GET /api/market/stats

Returns comprehensive statistics about all coins in the market for a specified time range.

#### Query Parameters
- `timeRange` (optional): Time range for price history data. Defaults to '30M'
  - Available options:
    - `10M`: 10 minutes
    - `30M`: 30 minutes (default)
    - `1H`: 1 hour
    - `2H`: 2 hours
    - `12H`: 12 hours
    - `24H`: 24 hours
    - `ALL`: All available history

#### Response Format
```json
{
  "timeRange": "30M",
  "marketStats": {
    "period_high": number,      // Highest total market value in the period
    "period_low": number,       // Lowest total market value in the period
    "current_market_value": number,
    "time_range_ms": number     // Time range in milliseconds (null for 'ALL')
  },
  "coins": [
    {
      "coin_id": string,
      "symbol": string,
      "current_price": number,
      "volatility": {
        "baseVolatility": number,      // Range: 0.2 to 0.8
        "trendDirection": number,      // 1 or -1
        "trendStrength": number        // Range: 0 to 0.002 (0.2% max)
      },
      "price_history": [
        {
          "price": number,
          "timestamp": string          // ISO 8601 format
        }
      ],
      "activeEvents": [
        {
          "type": string,
          "multiplier": number,
          "startTime": string,
          "endTime": string
        }
      ]
    }
  ]
}
```

#### Example Usage

```javascript
// Get default 30-minute history
const response = await fetch('/api/market/stats');
const defaultStats = await response.json();

// Get 1-hour history
const hourResponse = await fetch('/api/market/stats?timeRange=1H');
const hourStats = await hourResponse.json();

// Get all-time history
const allTimeResponse = await fetch('/api/market/stats?timeRange=ALL');
const allTimeStats = await allTimeResponse.json();
```

#### Event Types and Their Effects
- `MAJOR_PARTNERSHIP`: +5% price effect
- `MINOR_PARTNERSHIP`: +2% price effect
- `REGULATION_NEGATIVE`: -5% price effect
- `REGULATION_POSITIVE`: +3% price effect
- `MAJOR_ADOPTION`: +8% price effect
- `MINOR_ADOPTION`: +3% price effect
- `SCANDAL`: -7% price effect
- `RUMOR_POSITIVE`: +1% price effect
- `RUMOR_NEGATIVE`: -1% price effect

## Market Price History Endpoint

### GET /api/market/price-history

Returns the overall market price history including total market value and trends.

#### Query Parameters
- `timeRange` (optional): Time range for history data
  - Options: '10M', '30M', '1H', '2H', '12H', '24H', 'ALL'
  - Default: '30M'

#### Response Format
```json
{
  "history": [
    {
      "total_value": number,
      "market_trend": string,
      "created_at": string,
      "timestamp": number
    }
  ],
  "timeRange": string,
  "count": number
}
```

#### Response Example
```json
{
  "history": [
    {
      "total_value": 422.54,
      "market_trend": "STABLE",
      "created_at": "2025-02-23T12:00:00.000Z",
      "timestamp": 1740484800000
    },
    {
      "total_value": 425.30,
      "market_trend": "MILD_BOOM",
      "created_at": "2025-02-23T12:00:30.000Z",
      "timestamp": 1740484830000
    }
  ],
  "timeRange": "30M",
  "count": 2
}
```

## Usage Example

```javascript
// Fetch market status
async function getMarketStatus() {
  const response = await fetch('/api/market/status');
  const data = await response.json();
  return data;
}

// Fetch market stats
async function getMarketStats(timeRange = '30M') {
  const response = await fetch(`/api/market/stats?timeRange=${timeRange}`);
  const data = await response.json();
  return data;
}

// Fetch market price history
async function getMarketPriceHistory(timeRange = '30M') {
  const response = await fetch(`/api/market/price-history?timeRange=${timeRange}`);
  const data = await response.json();
  return data;
}

// Example usage with error handling
try {
  const marketStatus = await getMarketStatus();
  console.log('Current market cycle:', marketStatus.currentCycle.type);
  
  const marketStats = await getMarketStats();
  console.log('Total coins:', marketStats.marketStats.current_market_value);
  console.log('Active events:', marketStats.coins[0].activeEvents.length);
  
  const marketPriceHistory = await getMarketPriceHistory();
  console.log('Market price history:', marketPriceHistory.history);
} catch (error) {
  console.error('Error fetching market data:', error);
}
```

## Notes
- All endpoints update every 5 seconds
- Timestamps are in ISO 8601 format
- Price history is filtered based on the selected time range
- Base volatility is assigned per coin and remains relatively stable
- Event durations vary by event type (7-45 seconds)
- The default time range of 30 minutes provides a good balance between detail and performance
- Use the 'ALL' time range sparingly as it may return large amounts of data

# Coins API Quick Reference

## Available Endpoints

### 1. List All Coins
`GET /coins`

Returns list of all coins with their current market data:
```json
{
  "coins": [
    {
      "coin_id": 1,
      "name": "Bitcoin",
      "symbol": "BTC",
      "current_price": 45000.00,
      "market_cap": 800000000.00
    }
  ]
}
```

### 2. Get Single Coin
`GET /coins/:coin_id`

Returns detailed info for specific coin:
```json
{
  "coin": {
    "coin_id": 1,
    "name": "Bitcoin",
    "symbol": "BTC",
    "current_price": 45000.00,
    "market_cap": 800000000.00,
    "circulating_supply": 19000000,
    "price_change_24h": 2.5,
    "founder": "Satoshi Nakamoto"
  }
}
```

### 3. Update Coin Price
`PATCH /coins/:coin_id`

Update a coin's price:
```json
// Request
{
  "price": 46000.00
}
```

### 4. Get Coin Price History
`GET /coins/:coin_id/history?page=1&limit=10`

Returns paginated price history:
```json
{
  "history": [
    {
      "price": 45000.00,
      "timestamp": "2025-02-28T16:00:00Z",
      "price_change_percentage": 1.2
    }
  ],
  "pagination": {
    "currentPage": 1,
    "totalPages": 5,
    "totalItems": 50,
    "itemsPerPage": 10
  }
}
```

### 5. Get Market Price History
`GET /api/market/price-history?timeRange=30M`

Returns overall market history:
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

## Time Range Options
- 10M (10 minutes)
- 30M (30 minutes)
- 1H (1 hour)
- 2H (2 hours)
- 12H (12 hours)
- 24H (24 hours)
- ALL (All history)
