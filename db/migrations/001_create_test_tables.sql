-- Connect to the test database
\c coins_x_test;

-- Create Users table
CREATE TABLE Users (
    user_id SERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create Coins table
CREATE TABLE Coins (
    coin_id SERIAL PRIMARY KEY,
    name VARCHAR(50) NOT NULL,
    symbol VARCHAR(10) UNIQUE NOT NULL,
    current_price DECIMAL(18, 2) NOT NULL,
    supply INT NOT NULL,
    market_cap DECIMAL(18, 2) NOT NULL,
    date_added TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    description TEXT
);

-- Create Transactions table
CREATE TABLE Transactions (
    transaction_id SERIAL PRIMARY KEY,
    user_id INT REFERENCES Users(user_id) ON DELETE CASCADE,
    coin_id INT REFERENCES Coins(coin_id) ON DELETE CASCADE,
    type VARCHAR(10) CHECK (type IN ('BUY', 'SELL', 'buy', 'sell')) NOT NULL,
    quantity DECIMAL(18, 2) NOT NULL,
    price DECIMAL(18, 2) NOT NULL,
    total_amount DECIMAL(18, 2) NOT NULL,
    transaction_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create Portfolios table
CREATE TABLE Portfolios (
    portfolio_id SERIAL PRIMARY KEY,
    user_id INT REFERENCES Users(user_id) ON DELETE CASCADE,
    coin_id INT REFERENCES Coins(coin_id) ON DELETE CASCADE,
    quantity DECIMAL(18, 2) DEFAULT 0,
    average_purchase_price DECIMAL(18, 2) DEFAULT 0,
    UNIQUE(user_id, coin_id)
);

-- Create PriceHistory table
CREATE TABLE PriceHistory (
    history_id SERIAL PRIMARY KEY,
    coin_id INT REFERENCES Coins(coin_id) ON DELETE CASCADE,
    price DECIMAL(18, 2) NOT NULL,
    recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for better query performance
CREATE INDEX idx_transactions_user_id ON Transactions(user_id);
CREATE INDEX idx_transactions_coin_id ON Transactions(coin_id);
CREATE INDEX idx_portfolios_user_id ON Portfolios(user_id);
CREATE INDEX idx_portfolios_coin_id ON Portfolios(coin_id);
CREATE INDEX idx_price_history_coin_id ON PriceHistory(coin_id);
CREATE INDEX idx_price_history_recorded_at ON PriceHistory(recorded_at);
