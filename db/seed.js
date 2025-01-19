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
      DROP SEQUENCE IF EXISTS price_history_price_history_id_seq CASCADE;
    `);

    // Create sequences
    await db.query(`
      CREATE SEQUENCE users_user_id_seq;
      CREATE SEQUENCE coins_coin_id_seq;
      CREATE SEQUENCE portfolios_portfolio_id_seq;
      CREATE SEQUENCE transactions_transaction_id_seq;
      CREATE SEQUENCE price_history_price_history_id_seq;
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
        name VARCHAR(50) NOT NULL,
        symbol VARCHAR(10) UNIQUE NOT NULL,
        current_price DECIMAL(18, 2) NOT NULL,
        supply INT NOT NULL,
        market_cap DECIMAL(18, 2) NOT NULL,
        date_added TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        description TEXT,
        price_change_24h DECIMAL(8, 2)
      );

      CREATE TABLE "portfolios" (
        portfolio_id INTEGER PRIMARY KEY DEFAULT nextval('portfolios_portfolio_id_seq'),
        user_id INTEGER REFERENCES users(user_id) ON DELETE CASCADE,
        coin_id INTEGER REFERENCES coins(coin_id) ON DELETE CASCADE,
        quantity DECIMAL(18, 8) NOT NULL,
        average_buy_price DECIMAL(18, 2) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, coin_id)
      );

      CREATE TABLE "transactions" (
        transaction_id INTEGER PRIMARY KEY DEFAULT nextval('transactions_transaction_id_seq'),
        user_id INTEGER REFERENCES users(user_id) ON DELETE CASCADE,
        coin_id INTEGER REFERENCES coins(coin_id) ON DELETE CASCADE,
        type VARCHAR(10) CHECK (type IN ('buy', 'sell')) NOT NULL,
        amount DECIMAL(18, 2) NOT NULL,
        price_at_transaction DECIMAL(18, 2) NOT NULL,
        transaction_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE "price_history" (
        price_history_id INTEGER PRIMARY KEY DEFAULT nextval('price_history_price_history_id_seq'),
        coin_id INTEGER REFERENCES coins(coin_id) ON DELETE CASCADE,
        price DECIMAL(18, 2) NOT NULL,
        recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT unique_coin_timestamp UNIQUE (coin_id, recorded_at)
      );

      CREATE INDEX idx_price_history_coin_timestamp 
      ON price_history(coin_id, recorded_at DESC);
    `);

    // Insert test data
    const hashedPassword = await bcrypt.hash('password123', 10);
    
    const usersData = [
      ['testuser1', 'test1@example.com', hashedPassword],
      ['testuser2', 'test2@example.com', hashedPassword]
    ];

    const usersInsertSql = format(
      'INSERT INTO users (username, email, password_hash) VALUES %L RETURNING *',
      usersData
    );

    const coinsData = [
      ['Bitcoin', 'BTC', '50000.00', 19000000, '950000000000.00', 'The first and most well-known cryptocurrency.'],
      ['Ethereum', 'ETH', '3000.00', 120000000, '360000000000.00', 'A decentralized platform that runs smart contracts.']
    ];

    const coinsInsertSql = format(
      'INSERT INTO coins (name, symbol, current_price, supply, market_cap, description) VALUES %L RETURNING *',
      coinsData
    );

    await db.query(usersInsertSql);
    await db.query(coinsInsertSql);

    console.log('Seeding completed successfully!');

    // Add some initial price history
    const now = new Date();
    const priceHistoryData = [
      [1, '50000.00', new Date(now - 3600000)],  // 1 hour ago
      [1, '49500.00', new Date(now - 7200000)],  // 2 hours ago
      [2, '3000.00', new Date(now - 3600000)],   // 1 hour ago
      [2, '2950.00', new Date(now - 7200000)]    // 2 hours ago
    ];

    const priceHistoryInsertSql = format(
      'INSERT INTO price_history (coin_id, price, recorded_at) VALUES %L',
      priceHistoryData
    );

    await db.query(priceHistoryInsertSql);
    console.log('Seeding completed successfully!');

  } catch (error) {
    console.error('Error seeding:', error);
    throw error;
  }
};

module.exports = seed;
