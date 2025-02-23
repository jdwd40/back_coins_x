-- Create market_history table
CREATE TABLE market_history (
    id SERIAL PRIMARY KEY,
    total_value DECIMAL(20, 2) NOT NULL,
    market_trend VARCHAR(20) NOT NULL CHECK (market_trend IN ('STRONG_BOOM', 'MILD_BOOM', 'STRONG_BUST', 'MILD_BUST', 'STABLE')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
