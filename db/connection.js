const { Pool } = require('pg');
const { buildPoolConfig, resolveEffectiveConnection } = require('./connectionConfig');
const ENV = process.env.NODE_ENV || 'development';

require('dotenv').config({
  path: `${__dirname}/../.env.${ENV}`,
});

const config = buildPoolConfig();

// pg only parses the config on first connect, where a malformed URL would
// surface an error carrying the raw string. Fail here, sanitised, instead.
resolveEffectiveConnection(config);

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
  // Safe client acquisition for atomic transactions using a single pooled connection.
  // Caller MUST release the client in finally block.
  getClient: () => pool.connect(),
  end: () => {
    if (!isEnded) {
      isEnded = true;
      return pool.end();
    }
    return Promise.resolve();
  }
};
