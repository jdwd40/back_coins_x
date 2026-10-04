const { Pool } = require('pg');
const { ENV, config } = require('./connectionConfig');

// Debug logging in test mode — masked credentials only, never the real
// password or a credential-bearing DATABASE_URL.
if (ENV === 'test') {
  console.log('DB Config:', '[redacted connection configuration]');
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
