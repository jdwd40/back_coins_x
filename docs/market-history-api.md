# Market History API Documentation

## GET /api/market/history

Returns historical market data for different time ranges, including total market value, individual coin prices, and market statistics.

### Query Parameters

- `timeRange` (optional): Time range for historical data. Defaults to '30M'
  - Available options:
    - `10M`: 10 minutes
    - `30M`: 30 minutes (default)
    - `1H`: 1 hour
    - `24H`: 24 hours

### Response Format

```json
{
  "timeRange": "30M",
  "interval": "30 minutes",
  "stats": {
    "period_high": number,      // Highest total market value in the period
    "period_low": number,       // Lowest total market value in the period
    "period_average": number,   // Average market value over the period
    "current_value": number,    // Most recent market value
    "data_points": number       // Number of data points in the period
  },
  "history": [
    {
      "timestamp": "2025-02-11T20:08:38Z",  // ISO 8601 format
      "total_market_value": number,
      "coins": [
        {
          "coin_id": string,
          "symbol": string,
          "price": number,
          "market_cap": number
        }
      ]
    }
  ]
}
```

### Example Usage

```javascript
// Get default 30-minute history
const response = await fetch('/api/market/history');
const defaultHistory = await response.json();

// Get 1-hour history
const hourResponse = await fetch('/api/market/history?timeRange=1H');
const hourHistory = await hourResponse.json();

// Get 24-hour history
const dayResponse = await fetch('/api/market/history?timeRange=24H');
const dayHistory = await dayResponse.json();
```

### Error Responses

#### Invalid Time Range
```json
{
  "error": "Invalid time range. Must be one of: 10M, 30M, 1H, 24H"
}
```
Status Code: 400

#### Server Error
Status Code: 500

### Notes

1. **Data Resolution**
   - Data points are collected every 5 seconds
   - Approximate number of data points per time range:
     - 10M: ~120 points
     - 30M: ~360 points
     - 1H: ~720 points
     - 24H: ~17,280 points

2. **Market Value Calculation**
   - Total market value is calculated as: Σ(coin_price * circulating_supply)
   - Individual coin market caps are included in each data point

3. **Performance Considerations**
   - The 24H time range returns a large amount of data
   - Consider using a shorter time range for real-time updates
   - Data is aggregated at query time for maximum accuracy

4. **Timestamps**
   - All timestamps are in ISO 8601 format with UTC timezone
   - Timestamps are sorted in descending order (newest first)

5. **Caching**
   - Responses are not cached
   - Each request fetches fresh data from the database
   - Consider implementing client-side caching for frequent updates
