// Single connection configuration authority: dotenv runs before either the
// Pool or destructive-maintenance guard resolves a target. No connections here.
const ENV = process.env.NODE_ENV || 'development';
require('dotenv').config({ path: `${__dirname}/../.env.${ENV}` });

if (!process.env.PGDATABASE && !process.env.DATABASE_URL) {
  throw new Error('PGDATABASE or DATABASE_URL not set');
}

let config;
if (process.env.DATABASE_URL) {
  config = { connectionString: process.env.DATABASE_URL };
} else {
  const user = process.env.PGUSER || 'jd';
  const password = process.env.PGPASSWORD;
  const host = process.env.PGHOST || 'localhost';
  const port = process.env.PGPORT || 5432;
  const database = process.env.PGDATABASE;
  // Use discrete parameters so IPv6, sockets and reserved credential bytes
  // have exactly the same meaning for pg.Client and pg.Pool (no URI ambiguity).
  config = { user, host, port, database };
  if (password && password.trim().length > 0) config.password = password;
}

if (ENV === 'production') {
  config.max = 10;
  config.idleTimeoutMillis = 30000;
  config.connectionTimeoutMillis = 2000;
}

function resolveConnectionTarget() {
  // pg's own resolver handles URL query overrides, defaults and IPv6. A Client
  // constructor does not connect; Pool creates the same Client with this config.
  const { Client } = require('pg');
  const { host, database } = new Client(config).connectionParameters;
  return { host, database };
}

module.exports = { ENV, config, resolveConnectionTarget };
