const { Pool } = require('pg');
const ENV = process.env.NODE_ENV || 'development';

require('dotenv').config({
  path: `${__dirname}/../.env.${ENV}`,
});

if (!process.env.PGDATABASE && !process.env.DATABASE_URL) {
  throw new Error('PGDATABASE or DATABASE_URL not set');
}

// Build connection string or config object
let config;

// If DATABASE_URL is set (production), use it
if (process.env.DATABASE_URL) {
  config = {
    connectionString: process.env.DATABASE_URL
  };
} else {
  // Build connection URL for local development/test
  const user = process.env.PGUSER || 'jd';
  const password = process.env.PGPASSWORD;
  const host = process.env.PGHOST || 'localhost';
  const port = process.env.PGPORT || 5432;
  const database = process.env.PGDATABASE;
  
  // Build connection string with or without password
  let connectionString;
  if (password && password.trim().length > 0) {
    connectionString = `postgresql://${user}:${password}@${host}:${port}/${database}`;
  } else {
    connectionString = `postgresql://${user}@${host}:${port}/${database}`;
  }
  
  config = { connectionString };
}

// Debug logging in test mode
if (ENV === 'test') {
  console.log('DB Config connectionString:', config.connectionString);
}

// Production-specific pool settings
if (ENV === 'production') {
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
