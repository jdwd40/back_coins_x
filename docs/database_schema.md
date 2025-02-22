# Database Schema Documentation

This document describes the database schema for the Coins application. The database contains five main tables that manage users, cryptocurrencies, portfolios, transactions, and price history.

## Tables

### 1. Users (`users`)

Stores user account information and their available funds.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| user_id | integer | PRIMARY KEY | Unique identifier for users |
| username | varchar(50) | NOT NULL, UNIQUE | User's display name |
| email | varchar(100) | NOT NULL, UNIQUE | User's email address |
| password_hash | varchar(255) | NOT NULL | Hashed password |
| funds | numeric(18,2) | NOT NULL, DEFAULT 1000.00 | User's available funds |
| created_at | timestamp | DEFAULT CURRENT_TIMESTAMP | Account creation timestamp |
| updated_at | timestamp | DEFAULT CURRENT_TIMESTAMP | Last update timestamp |

### 2. Coins (`coins`)

Stores information about different cryptocurrencies.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| coin_id | integer | PRIMARY KEY | Unique identifier for coins |
| name | varchar(50) | NOT NULL | Name of the cryptocurrency |
| symbol | varchar(10) | NOT NULL, UNIQUE | Trading symbol |
| current_price | numeric(18,2) | NOT NULL | Current market price |
| market_cap | numeric(18,2) | NOT NULL | Market capitalization |
| circulating_supply | integer | NOT NULL | Number of coins in circulation |
| price_change_24h | numeric(5,2) | | 24-hour price change percentage |
| founder | varchar(50) | NOT NULL | Founder of the cryptocurrency |
| date_added | timestamp | DEFAULT CURRENT_TIMESTAMP | When the coin was added |

### 3. Portfolios (`portfolios`)

Tracks users' cryptocurrency holdings.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| portfolio_id | integer | PRIMARY KEY | Unique identifier for portfolio entries |
| user_id | integer | FOREIGN KEY | Reference to users table |
| coin_id | integer | FOREIGN KEY | Reference to coins table |
| quantity | numeric(18,2) | DEFAULT 0 | Number of coins held |
| average_purchase_price | numeric(18,2) | DEFAULT 0 | Average price paid per coin |
| created_at | timestamp | DEFAULT CURRENT_TIMESTAMP | When the portfolio was created |
| updated_at | timestamp | DEFAULT CURRENT_TIMESTAMP | Last update timestamp |

**Note:** There is a unique constraint on (user_id, coin_id) to prevent duplicate portfolio entries.

### 4. Transactions (`transactions`)

Records all buy and sell transactions.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| transaction_id | integer | PRIMARY KEY | Unique identifier for transactions |
| user_id | integer | FOREIGN KEY | Reference to users table |
| coin_id | integer | FOREIGN KEY | Reference to coins table |
| type | varchar(10) | NOT NULL, CHECK | Transaction type ('BUY' or 'SELL') |
| quantity | numeric(18,2) | NOT NULL | Number of coins traded |
| price | numeric(18,2) | NOT NULL | Price per coin at transaction time |
| total_amount | numeric(18,2) | NOT NULL | Total transaction amount |
| created_at | timestamp | DEFAULT CURRENT_TIMESTAMP | Transaction timestamp |

### 5. Price History (`price_history`)

Tracks historical price data for cryptocurrencies.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| history_id | integer | PRIMARY KEY | Unique identifier for price records |
| coin_id | integer | FOREIGN KEY | Reference to coins table |
| price | numeric(18,2) | NOT NULL | Historical price |
| created_at | timestamp | DEFAULT CURRENT_TIMESTAMP | When the price was recorded |

## Indexes

### Users Table
- PRIMARY KEY on `user_id`
- UNIQUE INDEX on `username`
- UNIQUE INDEX on `email`

### Coins Table
- PRIMARY KEY on `coin_id`
- UNIQUE INDEX on `symbol`

### Portfolios Table
- PRIMARY KEY on `portfolio_id`
- INDEX on `user_id`
- INDEX on `coin_id`
- UNIQUE INDEX on (`user_id`, `coin_id`)

### Transactions Table
- PRIMARY KEY on `transaction_id`
- INDEX on `user_id`
- INDEX on `coin_id`

### Price History Table
- PRIMARY KEY on `history_id`
- INDEX on `coin_id`
- INDEX on `created_at`

## Foreign Key Relationships

1. `portfolios.user_id` → `users.user_id` (ON DELETE CASCADE)
2. `portfolios.coin_id` → `coins.coin_id` (ON DELETE CASCADE)
3. `transactions.user_id` → `users.user_id` (ON DELETE CASCADE)
4. `transactions.coin_id` → `coins.coin_id` (ON DELETE CASCADE)
5. `price_history.coin_id` → `coins.coin_id` (ON DELETE CASCADE)

## Data Types

The schema uses the following PostgreSQL data types:
- `integer`: For IDs and whole numbers
- `numeric(18,2)`: For precise decimal numbers (financial calculations)
- `varchar`: For variable-length character strings
- `timestamp`: For date and time information
