-- Connect to the database
\c coins_x;

-- Create users table
CREATE TABLE users (
    user_id SERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create coins table
CREATE TABLE coins (
    coin_id SERIAL PRIMARY KEY,
    name VARCHAR(50) NOT NULL,
    symbol VARCHAR(10) UNIQUE NOT NULL,
    current_price DECIMAL(18, 2) NOT NULL,
    market_cap DECIMAL(18, 2) NOT NULL,
    circulating_supply INT NOT NULL,
    price_change_24h DECIMAL(5, 2),
    date_added TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create transactions table
CREATE TABLE transactions (
    transaction_id SERIAL PRIMARY KEY,
    user_id INT REFERENCES users(user_id) ON DELETE CASCADE,
    coin_id INT REFERENCES coins(coin_id) ON DELETE CASCADE,
    type VARCHAR(10) CHECK (type IN ('buy', 'sell')) NOT NULL,
    amount DECIMAL(18, 2) NOT NULL,
    price_at_transaction DECIMAL(18, 2) NOT NULL,
    transaction_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create portfolios table
CREATE TABLE portfolios (
    portfolio_id SERIAL PRIMARY KEY,
    user_id INT REFERENCES users(user_id) ON DELETE CASCADE,
    coin_id INT REFERENCES coins(coin_id) ON DELETE CASCADE,
    quantity DECIMAL(18, 2) DEFAULT 0,
    average_purchase_price DECIMAL(18, 2) DEFAULT 0,
    UNIQUE(user_id, coin_id)
);

-- Create price_history table
CREATE TABLE price_history (
    history_id SERIAL PRIMARY KEY,
    coin_id INT REFERENCES coins(coin_id) ON DELETE CASCADE,
    price DECIMAL(18, 2) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for better query performance
CREATE INDEX idx_transactions_user_id ON transactions(user_id);
CREATE INDEX idx_transactions_coin_id ON transactions(coin_id);
CREATE INDEX idx_portfolios_user_id ON portfolios(user_id);
CREATE INDEX idx_portfolios_coin_id ON portfolios(coin_id);
CREATE INDEX idx_price_history_coin_id ON price_history(coin_id);
CREATE INDEX idx_price_history_created_at ON price_history(created_at);
