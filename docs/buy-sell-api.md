# Buy and Sell API Documentation

This document outlines the implementation details for the cryptocurrency buy/sell functionality in our trading platform.

## Table of Contents
- [Authentication](#authentication)
- [Buy Endpoint](#buy-endpoint)
- [Sell Endpoint](#sell-endpoint)
- [Error Handling](#error-handling)
- [Examples](#examples)

## Authentication

All transaction endpoints require JWT authentication. Include the JWT token in the Authorization header:

```http
Authorization: Bearer <your_jwt_token>
```

## Buy Endpoint

### Endpoint Details

- **URL**: `/transactions/buy`
- **Method**: `POST`
- **Auth Required**: Yes

### Request Body

```json
{
  "user_id": 1,         // Must match the authenticated user's ID
  "coin_id": 1,         // ID of the coin to purchase
  "amount": 10.5        // Amount of coins to buy
}
```

### Success Response

- **Code**: 201 Created
- **Content**:

```json
{
  "status": "success",
  "message": "Buy transaction completed successfully",
  "data": {
    "transaction_id": 123,
    "user_id": 1,
    "coin_id": 1,
    "type": "BUY",
    "quantity": 10.5,
    "price": 50.00,
    "total_amount": 525.00,
    "created_at": "2025-02-10T15:16:48Z"
  }
}
```

### Error Responses

1. **Invalid Input Parameters**
   - **Code**: 400 Bad Request
   ```json
   {
     "status": "error",
     "message": "Invalid input parameters. Please provide valid user_id, coin_id, and amount greater than 0."
   }
   ```

2. **Insufficient Funds**
   - **Code**: 400 Bad Request
   ```json
   {
     "status": "error",
     "message": "Insufficient funds. You need 525.00 to complete this purchase.",
     "required_amount": 525.00,
     "current_price": 50.00
   }
   ```

3. **Unauthorized**
   - **Code**: 401 Unauthorized
   ```json
   {
     "status": "error",
     "message": "Unauthorized. You can only make transactions for your own account."
   }
   ```

4. **Invalid Coin**
   - **Code**: 404 Not Found
   ```json
   {
     "status": "error",
     "message": "Coin not found. Please provide a valid coin_id."
   }
   ```

## Sell Endpoint

### Endpoint Details

- **URL**: `/transactions/sell`
- **Method**: `POST`
- **Auth Required**: Yes

### Request Body

```json
{
  "user_id": 1,         // Must match the authenticated user's ID
  "coin_id": 1,         // ID of the coin to sell
  "amount": 5.0         // Amount of coins to sell
}
```

### Success Response

- **Code**: 201 Created
- **Content**:

```json
{
  "status": "success",
  "message": "Sell transaction completed successfully",
  "data": {
    "transaction_id": 124,
    "user_id": 1,
    "coin_id": 1,
    "type": "SELL",
    "quantity": 5.0,
    "price": 50.00,
    "total_amount": 250.00,
    "created_at": "2025-02-10T15:16:48Z"
  }
}
```

### Error Responses

1. **Invalid Input Parameters**
   - **Code**: 400 Bad Request
   ```json
   {
     "status": "error",
     "message": "Invalid input parameters. Please provide valid user_id, coin_id, and amount greater than 0."
   }
   ```

2. **Insufficient Coins**
   - **Code**: 400 Bad Request
   ```json
   {
     "status": "error",
     "message": "Insufficient coins in portfolio. You have 5.0 coins available to sell.",
     "available_amount": 5.0,
     "requested_amount": 10.0
   }
   ```

3. **Unauthorized**
   - **Code**: 401 Unauthorized
   ```json
   {
     "status": "error",
     "message": "Unauthorized. You can only make transactions for your own account."
   }
   ```

4. **Invalid Coin**
   - **Code**: 404 Not Found
   ```json
   {
     "status": "error",
     "message": "Coin not found. Please provide a valid coin_id."
   }
   ```

## Error Handling

The API uses standard HTTP status codes:
- `201`: Transaction successful
- `400`: Bad request (invalid input, insufficient funds/coins)
- `401`: Unauthorized (invalid/missing token or user mismatch)
- `404`: Resource not found (invalid coin_id)
- `500`: Server error

All error responses follow the format:
```json
{
  "status": "error",
  "message": "Human-readable error message",
  // Optional additional fields depending on error type
}
```

## Examples

### Example Buy Request

```javascript
const buyCoins = async () => {
  try {
    const response = await fetch('http://your-api/transactions/buy', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${userToken}`
      },
      body: JSON.stringify({
        user_id: 1,
        coin_id: 1,
        amount: 10.5
      })
    });

    const data = await response.json();
    if (!response.ok) {
      // Handle error based on data.message
      throw new Error(data.message);
    }

    // Transaction successful
    return data;
  } catch (error) {
    console.error('Buy transaction failed:', error);
    throw error;
  }
};
```

### Example Sell Request

```javascript
const sellCoins = async () => {
  try {
    const response = await fetch('http://your-api/transactions/sell', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${userToken}`
      },
      body: JSON.stringify({
        user_id: 1,
        coin_id: 1,
        amount: 5.0
      })
    });

    const data = await response.json();
    if (!response.ok) {
      // Handle error based on data.message
      throw new Error(data.message);
    }

    // Transaction successful
    return data;
  } catch (error) {
    console.error('Sell transaction failed:', error);
    throw error;
  }
};
```

## Implementation Notes

1. Always validate the user has sufficient funds before attempting a buy transaction
2. Always validate the user has sufficient coins before attempting a sell transaction
3. Handle all error cases appropriately in the UI
4. Refresh the user's portfolio and balance after successful transactions
5. Consider implementing a loading state during transaction processing
6. Consider implementing retry logic for failed transactions
7. Keep the UI updated with real-time price information

## Security Considerations

1. Never store the JWT token in localStorage (use secure HTTP-only cookies)
2. Always validate user_id matches the authenticated user
3. Implement rate limiting for transaction endpoints
4. Validate all input on both client and server side
5. Handle API errors gracefully with user-friendly messages
