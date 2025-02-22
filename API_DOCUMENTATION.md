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
    current_price: string;  // Formatted as GBP (e.g., "£150.00")
    market_cap: string;     // Formatted as GBP (e.g., "£1,000,000.00")
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
    current_price: string;  // Formatted as GBP (e.g., "£150.00")
    market_cap: string;     // Formatted as GBP (e.g., "£1,000,000.00")
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
  price?: number | string;  // Can be number or GBP string (e.g., 150.00 or "£150.00")
  current_price?: number | string;  // Alternative field name, same format as price
}
```
- **Validation Rules**:
  - Price must be between £0.01 and £1,000,000,000
  - Price must be a positive number
  - Price can be provided as a number or GBP-formatted string

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
    price: string;  // Formatted as GBP
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

## Important Notes

1. **Currency Formatting**:
   - All monetary values in responses are formatted as GBP strings (e.g., "£150.00")
   - When sending prices in requests, you can use either:
     - Plain numbers (e.g., 150.00)
     - GBP-formatted strings (e.g., "£150.00")

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
