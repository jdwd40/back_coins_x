const db = require('./connection');
const format = require('pg-format');
const bcrypt = require('bcrypt');

const seed = async (shouldEnd = false) => {
  try {
    console.log('Seeding test database...');

    // Drop existing tables and sequences if they exist
    console.log('Dropping existing tables and sequences...');
    await db.query(`
      DROP TABLE IF EXISTS "price_history" CASCADE;
      DROP TABLE IF EXISTS "transactions" CASCADE;
      DROP TABLE IF EXISTS "portfolios" CASCADE;
      DROP TABLE IF EXISTS "coins" CASCADE;
      DROP TABLE IF EXISTS "users" CASCADE;
      DROP SEQUENCE IF EXISTS users_user_id_seq CASCADE;
      DROP SEQUENCE IF EXISTS coins_coin_id_seq CASCADE;
      DROP SEQUENCE IF EXISTS portfolios_portfolio_id_seq CASCADE;
      DROP SEQUENCE IF EXISTS transactions_transaction_id_seq CASCADE;
      DROP SEQUENCE IF EXISTS price_history_price_history_id_seq CASCADE;
    `);

    // Create sequences
    console.log('Creating sequences...');
    await db.query(`
      CREATE SEQUENCE users_user_id_seq;
      CREATE SEQUENCE coins_coin_id_seq;
      CREATE SEQUENCE portfolios_portfolio_id_seq;
      CREATE SEQUENCE transactions_transaction_id_seq;
      CREATE SEQUENCE price_history_price_history_id_seq;
    `);

    // Create tables
    console.log('Creating tables...');
    await db.query(`
      CREATE TABLE "users" (
        user_id INTEGER PRIMARY KEY DEFAULT nextval('users_user_id_seq'),
        username VARCHAR(50) UNIQUE NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        funds DECIMAL(18, 2) DEFAULT 1000.00 NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE "coins" (
        coin_id INTEGER PRIMARY KEY DEFAULT nextval('coins_coin_id_seq'),
        name VARCHAR(50) NOT NULL,
        symbol VARCHAR(10) UNIQUE NOT NULL,
        current_price DECIMAL(18, 2) NOT NULL,
        market_cap DECIMAL(18, 2) NOT NULL,
        circulating_supply INT NOT NULL,
        price_change_24h DECIMAL(5, 2),
        date_added TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE "portfolios" (
        portfolio_id INTEGER PRIMARY KEY DEFAULT nextval('portfolios_portfolio_id_seq'),
        user_id INTEGER REFERENCES users(user_id) ON DELETE CASCADE,
        coin_id INTEGER REFERENCES coins(coin_id) ON DELETE CASCADE,
        quantity DECIMAL(18, 2) DEFAULT 0,
        average_purchase_price DECIMAL(18, 2) DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, coin_id)
      );

      CREATE TABLE "transactions" (
        transaction_id INTEGER PRIMARY KEY DEFAULT nextval('transactions_transaction_id_seq'),
        user_id INTEGER REFERENCES users(user_id) ON DELETE CASCADE,
        coin_id INTEGER REFERENCES coins(coin_id) ON DELETE CASCADE,
        type VARCHAR(10) CHECK (type IN ('BUY', 'SELL')) NOT NULL,
        quantity DECIMAL(18, 2) NOT NULL,
        price DECIMAL(18, 2) NOT NULL,
        total_amount DECIMAL(18, 2) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE "price_history" (
        history_id INTEGER PRIMARY KEY DEFAULT nextval('price_history_price_history_id_seq'),
        coin_id INTEGER REFERENCES coins(coin_id) ON DELETE CASCADE,
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
    `);

    // Insert test data
    console.log('Inserting test data...');
    const testData = require('./test_data/coins.json');
    const coinValues = testData.map(coin => [
      coin.name,
      coin.symbol,
      coin.current_price,
      coin.market_cap,
      coin.circulating_supply,
      coin.price_change_24h
    ]);

    const coinsResult = await db.query(
      format(
        'INSERT INTO coins (name, symbol, current_price, market_cap, circulating_supply, price_change_24h) VALUES %L RETURNING *',
        coinValues
      )
    );

    // Create test users
    console.log('Creating test users...');
    const hashedPassword = await bcrypt.hash('testpass123', 10);
    const userValues = [
      ['john_doe', 'john@example.com', hashedPassword, 1000.00],
      ['jane_smith', 'jane@example.com', hashedPassword, 1000.00]
    ];

    const usersResult = await db.query(
      format(
        'INSERT INTO users (username, email, password_hash, funds) VALUES %L RETURNING *',
        userValues
      )
    );

    // Add initial price history for each coin
    console.log('Adding price history...');
    const coins = coinsResult.rows;
    const now = new Date();
    const priceHistoryValues = coins.flatMap(coin => {
      // Create 5 price history entries for each coin over the last 5 hours
      return Array.from({ length: 5 }, (_, i) => {
        const timestamp = new Date(now.getTime() - (i * 60 * 60 * 1000)); // i hours ago
        return [
          coin.coin_id,
          coin.current_price,
          timestamp
        ];
      });
    });

    await db.query(
      format(
        'INSERT INTO price_history (coin_id, price, created_at) VALUES %L',
        priceHistoryValues
      )
    );

    console.log('Seeding completed successfully!');
  } catch (error) {
    console.error('Error seeding database:', error);
    throw error;
  } finally {
    if (shouldEnd) {
      await db.end();
    }
  }
};

if (require.main === module) {
  // Only run seed() if this file is run directly
  seed(true).catch(err => {
    console.error('Failed to seed database:', err);
    process.exit(1);
  });
}

module.exports = seed;
