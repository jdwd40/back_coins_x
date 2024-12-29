const db = require('./connection');
const format = require('pg-format');
const bcrypt = require('bcrypt');

const seed = async () => {
  try {
    console.log('Seeding test database...');

    // Drop existing tables and sequences if they exist
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
      DROP SEQUENCE IF EXISTS price_history_history_id_seq CASCADE;
    `);

    // Create sequences
    await db.query(`
      CREATE SEQUENCE users_user_id_seq;
      CREATE SEQUENCE coins_coin_id_seq;
      CREATE SEQUENCE portfolios_portfolio_id_seq;
      CREATE SEQUENCE transactions_transaction_id_seq;
      CREATE SEQUENCE price_history_history_id_seq;
    `);

    // Create tables
    await db.query(`
      CREATE TABLE "users" (
        user_id INTEGER PRIMARY KEY DEFAULT nextval('users_user_id_seq'),
        username VARCHAR(50) UNIQUE NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE "coins" (
        coin_id INTEGER PRIMARY KEY DEFAULT nextval('coins_coin_id_seq'),
        symbol VARCHAR(10) UNIQUE NOT NULL,
        name VARCHAR(100) NOT NULL,
        current_price DECIMAL(20, 8) NOT NULL,
        market_cap DECIMAL(20, 2),
        volume_24h DECIMAL(20, 2),
        price_change_24h DECIMAL(10, 2),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE "portfolios" (
        portfolio_id INTEGER PRIMARY KEY DEFAULT nextval('portfolios_portfolio_id_seq'),
        user_id INTEGER REFERENCES "users"(user_id) ON DELETE CASCADE,
        coin_id INTEGER REFERENCES "coins"(coin_id) ON DELETE CASCADE,
        quantity DECIMAL(20, 8) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, coin_id)
      );

      CREATE TABLE "transactions" (
        transaction_id INTEGER PRIMARY KEY DEFAULT nextval('transactions_transaction_id_seq'),
        user_id INTEGER REFERENCES "users"(user_id) ON DELETE CASCADE,
        coin_id INTEGER REFERENCES "coins"(coin_id) ON DELETE CASCADE,
        type VARCHAR(4) NOT NULL CHECK (type IN ('BUY', 'SELL')),
        quantity DECIMAL(20, 8) NOT NULL,
        price DECIMAL(20, 8) NOT NULL,
        total_amount DECIMAL(20, 8) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE "price_history" (
        history_id INTEGER PRIMARY KEY DEFAULT nextval('price_history_history_id_seq'),
        coin_id INTEGER REFERENCES "coins"(coin_id) ON DELETE CASCADE,
        price DECIMAL(20, 8) NOT NULL,
        recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Reset sequences
    await db.query(`
      SELECT setval('users_user_id_seq', 1, false);
      SELECT setval('coins_coin_id_seq', 1, false);
      SELECT setval('portfolios_portfolio_id_seq', 1, false);
      SELECT setval('transactions_transaction_id_seq', 1, false);
      SELECT setval('price_history_history_id_seq', 1, false);
    `);

    // Insert test data
    const testUsers = [
      {
        username: 'john_doe',
        email: 'john@example.com',
        password_hash: await bcrypt.hash('password123', 10)
      },
      {
        username: 'jane_smith',
        email: 'jane@example.com',
        password_hash: await bcrypt.hash('password123', 10)
      }
    ];

    const userInsertQuery = format(
      'INSERT INTO users (username, email, password_hash) VALUES %L RETURNING *',
      testUsers.map(user => [user.username, user.email, user.password_hash])
    );
    
    const insertedUsers = await db.query(userInsertQuery);

    const testCoins = [
      {
        symbol: 'BTC',
        name: 'Bitcoin',
        current_price: 50000.00,
        market_cap: 1000000000000.00,
        volume_24h: 50000000000.00,
        price_change_24h: 2.5
      },
      {
        symbol: 'ETH',
        name: 'Ethereum',
        current_price: 3000.00,
        market_cap: 350000000000.00,
        volume_24h: 20000000000.00,
        price_change_24h: 1.8
      }
    ];

    const coinInsertQuery = format(
      'INSERT INTO coins (symbol, name, current_price, market_cap, volume_24h, price_change_24h) VALUES %L RETURNING *',
      testCoins.map(coin => [coin.symbol, coin.name, coin.current_price, coin.market_cap, coin.volume_24h, coin.price_change_24h])
    );

    const insertedCoins = await db.query(coinInsertQuery);

    // Create indexes
    await db.query('CREATE INDEX idx_transactions_user_id ON "transactions"(user_id);');
    await db.query('CREATE INDEX idx_transactions_coin_id ON "transactions"(coin_id);');
    await db.query('CREATE INDEX idx_portfolios_user_id ON "portfolios"(user_id);');
    await db.query('CREATE INDEX idx_portfolios_coin_id ON "portfolios"(coin_id);');
    await db.query('CREATE INDEX idx_price_history_coin_id ON "price_history"(coin_id);');
    await db.query('CREATE INDEX idx_price_history_recorded_at ON "price_history"(recorded_at);');

    console.log('Seeding completed successfully!');
  } catch (error) {
    console.error('Error during seeding:', error);
    throw error;
  }
}

module.exports = seed;
