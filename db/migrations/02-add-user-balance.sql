\c coins_x;

-- Add balance column to users table
ALTER TABLE users
ADD COLUMN balance DECIMAL(10,2) NOT NULL DEFAULT 0;

-- Update existing users to have £1000 balance
UPDATE users SET balance = 1000.00;

-- Add constraint to ensure balance doesn't go below 0
ALTER TABLE users
ADD CONSTRAINT check_balance_non_negative CHECK (balance >= 0);
