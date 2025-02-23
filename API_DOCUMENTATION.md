# Coins API Documentation

This document explains the structure and behavior of the Coins API endpoints for frontend integration.

## Endpoints

### 1. Get All Coins
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

### 2. Get Coin by ID
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

### 3. Update Coin Price
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

### 4. Get Price History
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

### 5. Get Market Price History
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

1. **Number Formatting**:
   - All monetary values are returned as numbers with 2 decimal places
   - Frontend should handle currency formatting and display
   - When sending prices in requests, you can use:
     - Plain numbers (e.g., 150.00)
     - Strings that can be converted to numbers (e.g., "150.00")

2. **Error Handling**:
   - All endpoints return appropriate HTTP status codes:
     - 200: Success
     - 400: Bad Request (invalid input)
     - 404: Not Found (coin doesn't exist)
     - 500: Internal Server Error

3. **Price Changes**:
   - When updating a coin's price, the API automatically:
     - Calculates the price change percentage
     - Records the price history
     - Updates the price_change_24h field

4. **Pagination**:
   - The price history endpoint uses pagination
   - Default page size is 10 items
   - You can customize page size using the limit parameter
