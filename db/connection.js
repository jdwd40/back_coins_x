const { Pool } = require('pg');
const ENV = process.env.NODE_ENV || 'development';

require('dotenv').config({
  path: `${__dirname}/../.env.${ENV}`,
});

if (!process.env.PGDATABASE && !process.env.DATABASE_URL) {
  throw new Error('PGDATABASE or DATABASE_URL not set');
}

const config = {
  database: process.env.PGDATABASE,
  user: process.env.PGUSER || 'jd',
  password: process.env.PGPASSWORD,
  host: process.env.PGHOST || 'localhost',
  port: process.env.PGPORT || 5432
};

if (ENV === 'production') {
  config.connectionString = process.env.DATABASE_URL;
  config.max = 10; // Increase max connections
  config.idleTimeoutMillis = 30000; // Close idle connections after 30 seconds
  config.connectionTimeoutMillis = 2000; // Fail fast if can't connect
}

const pool = new Pool(config);

// Add a flag to track if pool has been ended
let isEnded = false;

module.exports = {
  query: (...args) => pool.query(...args),
  end: () => {
    if (!isEnded) {
      isEnded = true;
      return pool.end();
    }
    return Promise.resolve();
  }
};
