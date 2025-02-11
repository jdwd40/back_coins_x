# Market API Endpoints Documentation

## Market Status Endpoint

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

// Example usage with error handling
try {
  const marketStatus = await getMarketStatus();
  console.log('Current market cycle:', marketStatus.currentCycle.type);
  
  const marketStats = await getMarketStats();
  console.log('Total coins:', marketStats.marketStats.current_market_value);
  console.log('Active events:', marketStats.coins[0].activeEvents.length);
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
