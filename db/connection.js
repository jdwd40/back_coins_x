const { Pool } = require('pg');
const ENV = process.env.NODE_ENV || 'development';

require('dotenv').config({
  path: `${__dirname}/../.env.${ENV}`,
});

if (!process.env.PGDATABASE && !process.env.DATABASE_URL) {
  throw new Error('PGDATABASE or DATABASE_URL not set');
}

const config = {};

if (ENV === 'production') {
  config.connectionString = process.env.DATABASE_URL;
  config.max = 2;
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
