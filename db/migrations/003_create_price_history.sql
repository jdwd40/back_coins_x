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

-- Create a function to clean old price history
CREATE OR REPLACE FUNCTION cleanup_price_history() RETURNS void AS $$
BEGIN
    DELETE FROM price_history 
    WHERE recorded_at < NOW() - INTERVAL '24 hours';
END;
$$ LANGUAGE plpgsql;

-- Create a scheduled job to run cleanup every hour
CREATE EXTENSION IF NOT EXISTS pg_cron;
SELECT cron.schedule('0 * * * *', 'SELECT cleanup_price_history()');

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

-- Create a function to clean old price history
CREATE OR REPLACE FUNCTION cleanup_price_history() RETURNS void AS $$
BEGIN
    DELETE FROM price_history 
    WHERE recorded_at < NOW() - INTERVAL '24 hours';
END;
$$ LANGUAGE plpgsql;

-- Create a scheduled job to run cleanup every hour
CREATE EXTENSION IF NOT EXISTS pg_cron;
SELECT cron.schedule('0 * * * *', 'SELECT cleanup_price_history()');
