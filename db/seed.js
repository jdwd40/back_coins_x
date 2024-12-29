const db = require('./connection');
const format = require('pg-format');
const { readFile } = require('fs/promises');

async function seed() {
  try {
    const ENV = process.env.NODE_ENV || 'development';
    console.log(`Seeding ${ENV} database...`);
    
    // Read JSON data
    const coinsData = JSON.parse(
      await readFile(`${__dirname}/${ENV}_data/coins.json`, 'utf-8')
    );
    const usersData = JSON.parse(
      await readFile(`${__dirname}/${ENV}_data/users.json`, 'utf-8')
    );
    const transactionsData = JSON.parse(
      await readFile(`${__dirname}/${ENV}_data/transactions.json`, 'utf-8')
    );

    // Drop existing tables if they exist
    await db.query(`DROP TABLE IF EXISTS "transactions" CASCADE;`);
    await db.query(`DROP TABLE IF EXISTS "portfolios" CASCADE;`);
    await db.query(`DROP TABLE IF EXISTS "price_history" CASCADE;`);
    await db.query(`DROP TABLE IF EXISTS "coins" CASCADE;`);
    await db.query(`DROP TABLE IF EXISTS "users" CASCADE;`);

    // Create tables
    await db.query(`
      CREATE TABLE "users" (
        user_id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE "coins" (
        coin_id SERIAL PRIMARY KEY,
        name VARCHAR(50) NOT NULL,
        symbol VARCHAR(10) UNIQUE NOT NULL,
        current_price DECIMAL(18, 2) NOT NULL,
        supply BIGINT NOT NULL,
        market_cap DECIMAL(18, 2) NOT NULL,
        date_added TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        description TEXT
      );

      CREATE TABLE "transactions" (
        transaction_id SERIAL PRIMARY KEY,
        user_id INT REFERENCES "users"(user_id) ON DELETE CASCADE,
        coin_id INT REFERENCES "coins"(coin_id) ON DELETE CASCADE,
        type VARCHAR(10) CHECK (type IN ('buy', 'sell')) NOT NULL,
        amount DECIMAL(18, 2) NOT NULL,
        price_at_transaction DECIMAL(18, 2) NOT NULL,
        transaction_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE "portfolios" (
        portfolio_id SERIAL PRIMARY KEY,
        user_id INT REFERENCES "users"(user_id) ON DELETE CASCADE,
        coin_id INT REFERENCES "coins"(coin_id) ON DELETE CASCADE,
        quantity DECIMAL(18, 2) DEFAULT 0,
        average_purchase_price DECIMAL(18, 2) DEFAULT 0,
        UNIQUE(user_id, coin_id)
      );

      CREATE TABLE "price_history" (
        history_id SERIAL PRIMARY KEY,
        coin_id INT REFERENCES "coins"(coin_id) ON DELETE CASCADE,
        price DECIMAL(18, 2) NOT NULL,
        recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Insert data
    const insertCoinsQuery = format(
      'INSERT INTO "coins" (name, symbol, current_price, supply, market_cap, description) VALUES %L RETURNING *',
      coinsData.coins.map(({ name, symbol, current_price, supply, market_cap, description }) => 
        [name, symbol, current_price, supply, market_cap, description]
      )
    );

    const insertUsersQuery = format(
      'INSERT INTO "users" (username, email, password_hash) VALUES %L RETURNING *',
      usersData.users.map(({ username, email, password_hash }) => 
        [username, email, password_hash]
      )
    );

    await db.query(insertCoinsQuery);
    await db.query(insertUsersQuery);

    // Insert transactions
    const insertTransactionsQuery = format(
      'INSERT INTO "transactions" (user_id, coin_id, type, amount, price_at_transaction) VALUES %L',
      transactionsData.transactions.map(({ user_id, coin_id, type, amount, price_at_transaction }) => 
        [user_id, coin_id, type, amount, price_at_transaction]
      )
    );

    await db.query(insertTransactionsQuery);

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

// If this file is run directly (not required as a module), run the seed function
if (require.main === module) {
  seed()
    .then(() => db.end())
    .catch((err) => {
      console.error(err);
      db.end();
    });
}

module.exports = seed;
