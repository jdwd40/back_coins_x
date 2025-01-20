-- Connect to the database
\c coins_x;

-- Add funds column to Users table with default value of 1000
ALTER TABLE Users
ADD COLUMN funds DECIMAL(18, 2) DEFAULT 1000.00 NOT NULL;
