const db = require('./connection');
const format = require('pg-format');
const bcrypt = require('bcrypt');
const { CurrencyFormatter } = require('../utils/currency-formatter');

const seed = async (shouldEnd = false) => {
  console.log('🌱 Starting database seeding...');
  
  try {
    const isDev = process.env.NODE_ENV === 'development';

    console.log('📦 Dropping existing tables...');
    // Drop existing tables and sequences
    await db.query(`
      DROP TABLE IF EXISTS "price_history" CASCADE;
      DROP TABLE IF EXISTS "transactions" CASCADE;
      DROP TABLE IF EXISTS "portfolios" CASCADE;
      DROP TABLE IF EXISTS "coins" CASCADE;
      DROP TABLE IF EXISTS "users" CASCADE;
      DROP TABLE IF EXISTS "coin_statistics" CASCADE;
      DROP SEQUENCE IF EXISTS users_user_id_seq CASCADE;
      DROP SEQUENCE IF EXISTS coins_coin_id_seq CASCADE;
      DROP SEQUENCE IF EXISTS portfolios_portfolio_id_seq CASCADE;
      DROP SEQUENCE IF EXISTS transactions_transaction_id_seq CASCADE;
      DROP SEQUENCE IF EXISTS price_history_price_history_id_seq CASCADE;
    `);

    console.log('📦 Creating sequences and tables...');
    // Create sequences
    await db.query(`
      CREATE SEQUENCE IF NOT EXISTS users_user_id_seq;
      CREATE SEQUENCE IF NOT EXISTS coins_coin_id_seq;
      CREATE SEQUENCE IF NOT EXISTS portfolios_portfolio_id_seq;
      CREATE SEQUENCE IF NOT EXISTS transactions_transaction_id_seq;
      CREATE SEQUENCE IF NOT EXISTS price_history_price_history_id_seq;
    `);

    // Create tables
    await db.query(`
      CREATE TABLE IF NOT EXISTS users (
        user_id INTEGER PRIMARY KEY DEFAULT nextval('users_user_id_seq'),
        username VARCHAR(50) UNIQUE NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        funds DECIMAL(18, 2) DEFAULT 1000.00 NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS coins (
        coin_id INTEGER PRIMARY KEY DEFAULT nextval('coins_coin_id_seq'),
        name VARCHAR(50) NOT NULL,
        symbol VARCHAR(10) UNIQUE NOT NULL,
        current_price DECIMAL(18, 2) NOT NULL,
        market_cap DECIMAL(18, 2) NOT NULL,
        circulating_supply INT NOT NULL,
        price_change_24h DECIMAL(5, 2),
        founder VARCHAR(50) NOT NULL,
        date_added TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS portfolios (
        portfolio_id INTEGER PRIMARY KEY DEFAULT nextval('portfolios_portfolio_id_seq'),
        user_id INTEGER REFERENCES users(user_id) ON DELETE CASCADE,
        coin_id INTEGER REFERENCES coins(coin_id) ON DELETE CASCADE,
        quantity DECIMAL(18, 2) DEFAULT 0,
        average_purchase_price DECIMAL(18, 2) DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, coin_id)
      );

      CREATE TABLE IF NOT EXISTS transactions (
        transaction_id INTEGER PRIMARY KEY DEFAULT nextval('transactions_transaction_id_seq'),
        user_id INTEGER REFERENCES users(user_id) ON DELETE CASCADE,
        coin_id INTEGER REFERENCES coins(coin_id) ON DELETE CASCADE,
        type VARCHAR(10) CHECK (type IN ('BUY', 'SELL')) NOT NULL,
        quantity DECIMAL(18, 2) NOT NULL,
        price DECIMAL(18, 2) NOT NULL,
        total_amount DECIMAL(18, 2) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS price_history (
        history_id INTEGER PRIMARY KEY DEFAULT nextval('price_history_price_history_id_seq'),
        coin_id INTEGER REFERENCES coins(coin_id) ON DELETE CASCADE,
        price DECIMAL(18, 2) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS coin_statistics (
        stat_id SERIAL PRIMARY KEY,
        coin_id INTEGER REFERENCES coins(coin_id) ON DELETE CASCADE,
        all_time_high DECIMAL(18, 2),
        all_time_high_date TIMESTAMP,
        all_time_low DECIMAL(18, 2),
        all_time_low_date TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(coin_id)
      );

      -- Create indexes for better query performance
      CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON transactions(user_id);
      CREATE INDEX IF NOT EXISTS idx_transactions_coin_id ON transactions(coin_id);
      CREATE INDEX IF NOT EXISTS idx_portfolios_user_id ON portfolios(user_id);
      CREATE INDEX IF NOT EXISTS idx_portfolios_coin_id ON portfolios(coin_id);
      CREATE INDEX IF NOT EXISTS idx_price_history_coin_id ON price_history(coin_id);
      CREATE INDEX IF NOT EXISTS idx_price_history_created_at ON price_history(created_at);
    `);

    console.log('📦 Inserting coins data...');
    // Insert coins data
    const coinsData = require(process.env.NODE_ENV === 'test' 
      ? './test_data/coins.json'
      : './development_data/coins.json');

    const coinValues = coinsData.map(coin => {
      const currentPrice = CurrencyFormatter.convertToNumber(coin.current_price);
      const marketCap = CurrencyFormatter.convertToNumber(coin.market_cap);
      const priceChange = coin.price_change_24h ? CurrencyFormatter.convertToNumber(coin.price_change_24h) : null;

      return [
        coin.name,
        coin.symbol,
        currentPrice,
        marketCap,
        coin.circulating_supply,
        priceChange,
        coin.founder
      ];
    });

    const insertedCoins = await db.query(
      format(
        'INSERT INTO coins (name, symbol, current_price, market_cap, circulating_supply, price_change_24h, founder) VALUES %L RETURNING *',
        coinValues
      )
    );

    console.log('📦 Updating prices randomly in development mode...');
    // Only update prices randomly in development mode
    if (isDev) {
      for (const coin of insertedCoins.rows) {
        const newPrice = (Math.random() * (50 - 20) + 20).toFixed(2);
        await db.query(
          'UPDATE coins SET current_price = $1 WHERE coin_id = $2 RETURNING name, current_price',
          [newPrice, coin.coin_id]
        ).then(result => {
          const updatedCoin = result.rows[0];
          console.log(`${updatedCoin.name}: £${updatedCoin.current_price}`);
        });
      }
    }

    console.log('📦 Inserting coin statistics...');
    // Insert coin statistics
    for (const coin of insertedCoins.rows) {
      const currentPrice = parseFloat(coin.current_price);
      const allTimeHigh = (currentPrice * (1 + Math.random())).toFixed(2); // ATH is higher than current price
      const allTimeLow = (currentPrice * (0.5 + Math.random() * 0.3)).toFixed(2); // ATL is lower than current price
      const allTimeHighDate = new Date(Date.now() - Math.random() * 365 * 24 * 60 * 60 * 1000); // Random date within last year
      const allTimeLowDate = new Date(Date.now() - Math.random() * 365 * 24 * 60 * 60 * 1000); // Random date within last year

      await db.query(`
        INSERT INTO coin_statistics 
        (coin_id, all_time_high, all_time_high_date, all_time_low, all_time_low_date)
        VALUES ($1, $2, $3, $4, $5)
      `, [coin.coin_id, allTimeHigh, allTimeHighDate, allTimeLow, allTimeLowDate]);
      
      if (isDev) {
        console.log(`${coin.name} - ATH: £${allTimeHigh}, ATL: £${allTimeLow}`);
      }
    }

    console.log('📦 Inserting users data...');
    // Insert users data
    const usersData = require(process.env.NODE_ENV === 'test'
      ? './test_data/users.json'
      : './development_data/users.json').users;
    const userValues = usersData.map(user => [
      user.username,
      user.email,
      user.password_hash,
      user.funds || 1000.00
    ]);

    await db.query(
      format(
        'INSERT INTO users (username, email, password_hash, funds) VALUES %L RETURNING *',
        userValues
      )
    );

    if (shouldEnd) {
      await db.end();
    }

    console.log('✅ Seeding completed successfully!');
    if (isDev) {
      console.log('🔨 Running in development mode');
    }
  } catch (err) {
    console.error('❌ Error during seeding:', err);
    throw err;
  }
};

if (require.main === module) {
  // Only run seed() if this file is run directly
  seed(true).catch(err => {
    console.error('❌ Failed to seed database:', err);
    process.exit(1);
  });
}

module.exports = seed;
