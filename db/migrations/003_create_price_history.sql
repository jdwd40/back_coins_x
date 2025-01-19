-- Connect to the main database
\c coins_x jd;

-- Drop existing table if it exists
DROP TABLE IF EXISTS price_history;

-- Create PriceHistory table
CREATE TABLE price_history (
    price_history_id SERIAL PRIMARY KEY,
    coin_id INT REFERENCES coins(coin_id) ON DELETE CASCADE,
    price DECIMAL(18, 2) NOT NULL,
    recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_coin_timestamp UNIQUE (coin_id, recorded_at)
);

-- Create index for faster queries
CREATE INDEX idx_price_history_coin_timestamp 
ON price_history(coin_id, recorded_at DESC);

-- Connect to the test database
\c coins_x_test jd;

-- Drop existing table if it exists
DROP TABLE IF EXISTS price_history;

-- Create PriceHistory table
CREATE TABLE price_history (
    price_history_id SERIAL PRIMARY KEY,
    coin_id INT REFERENCES coins(coin_id) ON DELETE CASCADE,
    price DECIMAL(18, 2) NOT NULL,
    recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_coin_timestamp UNIQUE (coin_id, recorded_at)
);

-- Create index for faster queries
CREATE INDEX idx_price_history_coin_timestamp 
ON price_history(coin_id, recorded_at DESC);
