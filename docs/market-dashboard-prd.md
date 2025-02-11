# Market Statistics Dashboard PRD

## Overview
The Market Statistics Dashboard will provide real-time visualization and analysis of cryptocurrency market data, leveraging our market simulation engine to display comprehensive market insights.

## Technical Requirements

### API Endpoints

#### 1. Market Status Endpoint
```
GET /api/market/status
```
Returns current market cycle and overall market status.

Response format:
```json
{
  "currentCycle": {
    "type": "STRONG_BOOM" | "MILD_BOOM" | "STRONG_BUST" | "MILD_BUST" | "STABLE",
    "baseEffect": number
  },
  "timestamp": string
}
```

#### 2. Coin Prices Endpoint
```
GET /api/market/prices
```
Returns current prices and recent price history for all coins.

Response format:
```json
{
  "coins": [
    {
      "coin_id": string,
      "symbol": string,
      "current_price": number,
      "price_history": [
        {
          "price": number,
          "timestamp": string
        }
      ],
      "volatility": number,
      "trend_direction": number,
      "active_events": [
        {
          "type": string,
          "multiplier": number,
          "duration": {
            "start": string,
            "end": string
          }
        }
      ]
    }
  ]
}
```

#### 3. Market Events Endpoint
```
GET /api/market/events
```
Returns active market events affecting coin prices.

Response format:
```json
{
  "events": [
    {
      "coin_id": string,
      "type": string,
      "multiplier": number,
      "start_time": string,
      "end_time": string,
      "description": string
    }
  ]
}
```

## UI Components

### 1. Market Overview Panel
- Display current market cycle type with visual indicator
- Show market trend direction
- Display timestamp of last update

### 2. Coin Price Grid
- Sortable table showing all coins with:
  - Current price
  - 24h change percentage
  - Volatility indicator
  - Active events badge

### 3. Price Charts
- Interactive line charts showing price history
- Ability to overlay multiple coins
- Time range selector (1h, 24h, 7d)
- Event markers on the timeline

### 4. Active Events Panel
- List of current market events
- Impact indicators
- Duration countdown
- Event type categorization

## Technical Implementation Notes

1. **Real-time Updates**
   - Implement WebSocket connection for live price updates
   - Update frequency: Every 5 seconds (matching simulator interval)

2. **Data Caching**
   - Cache price history data client-side
   - Implement progressive loading for historical data

3. **Error Handling**
   - Display connection status indicator
   - Implement retry mechanism for failed API calls
   - Show placeholder content during data loading

4. **Performance Considerations**
   - Implement virtual scrolling for large datasets
   - Optimize chart rendering for multiple datasets
   - Use efficient data structures for real-time updates

## Getting Started

1. Install required dependencies:
```bash
npm install @material-ui/core @material-ui/icons recharts socket.io-client
```

2. Configure API endpoint in your environment:
```javascript
const API_BASE_URL = process.env.REACT_APP_API_BASE_URL || 'http://localhost:3000/api';
```

3. Initialize WebSocket connection:
```javascript
const socket = io(API_BASE_URL);
socket.on('market_update', (data) => {
  // Handle real-time updates
});
```

## Success Metrics
- Dashboard load time < 2 seconds
- Real-time updates delivered within 100ms
- Chart rendering performance < 16ms per frame
- Zero data loss during WebSocket reconnections
