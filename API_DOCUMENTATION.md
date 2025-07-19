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
