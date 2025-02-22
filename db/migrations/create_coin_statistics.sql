CREATE TABLE coin_statistics (
    stat_id SERIAL PRIMARY KEY,
    coin_id INT REFERENCES coins(coin_id) ON DELETE CASCADE,
    all_time_high DECIMAL(18, 2),
    all_time_high_date TIMESTAMP,
    all_time_low DECIMAL(18, 2),
    all_time_low_date TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Add index for faster lookups by coin_id
CREATE INDEX idx_coin_statistics_coin_id ON coin_statistics(coin_id);

-- Add a unique constraint to ensure one record per coin
ALTER TABLE coin_statistics ADD CONSTRAINT unique_coin_statistics UNIQUE (coin_id);
