npm run setup-dbsnpm run setup-dbs-- Connect to the database
\c coins_x;

-- Seed Users table
INSERT INTO Users (username, email, password_hash) VALUES
    ('john_doe', 'john@example.com', '$2b$10$rG7.dv1Z0yF9RxMPe0AoYOJ.fwkV4I6D7f7D9iZj8kS8IqX5I5Iey'),  -- password: test123
    ('jane_smith', 'jane@example.com', '$2b$10$rG7.dv1Z0yF9RxMPe0AoYOJ.fwkV4I6D7f7D9iZj8kS8IqX5I5Iey'),
    ('admin_user', 'admin@example.com', '$2b$10$rG7.dv1Z0yF9RxMPe0AoYOJ.fwkV4I6D7f7D9iZj8kS8IqX5I5Iey');

-- Seed Coins table
INSERT INTO Coins (name, symbol, current_price, supply, market_cap, description) VALUES
    ('Bitcoin', 'BTC', 42000.00, 19000000, 798000000000.00, 'The first and largest cryptocurrency by market capitalization'),
    ('Ethereum', 'ETH', 2200.00, 120000000, 264000000000.00, 'Leading smart contract platform'),
    ('Ripple', 'XRP', 0.50, 100000000000, 50000000000.00, 'Digital payment protocol and cryptocurrency'),
    ('Cardano', 'ADA', 0.40, 45000000000, 18000000000.00, 'Proof-of-stake blockchain platform'),
    ('Solana', 'SOL', 75.00, 550000000, 41250000000.00, 'High-performance blockchain platform');

-- Seed some initial price history
INSERT INTO PriceHistory (coin_id, price, recorded_at) 
SELECT 
    c.coin_id,
    c.current_price * (1 + (random() * 0.1 - 0.05)),
    NOW() - (interval '1 hour' * generate_series(1, 24))
FROM Coins c;

-- Seed some transactions for users
INSERT INTO Transactions (user_id, coin_id, type, amount, price_at_transaction) VALUES
    (1, 1, 'buy', 0.5, 41000.00),
    (1, 2, 'buy', 5.0, 2100.00),
    (2, 1, 'buy', 0.25, 42000.00),
    (2, 3, 'buy', 1000, 0.48),
    (1, 2, 'sell', 2.0, 2200.00);

-- Update portfolios based on transactions
INSERT INTO Portfolios (user_id, coin_id, quantity, average_purchase_price)
SELECT 
    t.user_id,
    t.coin_id,
    CASE 
        WHEN t.type = 'buy' THEN SUM(t.amount)
        ELSE -SUM(t.amount)
    END as quantity,
    AVG(CASE WHEN t.type = 'buy' THEN t.price_at_transaction ELSE NULL END) as avg_price
FROM Transactions t
GROUP BY t.user_id, t.coin_id
ON CONFLICT (user_id, coin_id) DO UPDATE
SET 
    quantity = EXCLUDED.quantity,
    average_purchase_price = EXCLUDED.average_purchase_price;
