-- Connect to the main database
\c coins_x jd;

-- Add price_change_24h column to Coins table if it doesn't exist
DO $$ 
BEGIN 
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                  WHERE table_name='coins' AND column_name='price_change_24h') THEN
        ALTER TABLE Coins
        ADD COLUMN price_change_24h DECIMAL(8, 2);
    END IF;
END $$;

-- Connect to the test database
\c coins_x_test jd;

-- Add price_change_24h column to Coins table if it doesn't exist
DO $$ 
BEGIN 
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                  WHERE table_name='coins' AND column_name='price_change_24h') THEN
        ALTER TABLE Coins
        ADD COLUMN price_change_24h DECIMAL(8, 2);
    END IF;
END $$;
