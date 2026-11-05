const ConnectionParameters = require('pg/lib/connection-parameters');

// Single source of truth for what the Pool connects to. The destructive-test
// guard evaluates this same config, so it cannot approve one target while the
// Pool reaches another.
function buildPoolConfig() {
  if (!process.env.PGDATABASE && !process.env.DATABASE_URL) {
    throw new Error('PGDATABASE or DATABASE_URL not set');
  }

  // If DATABASE_URL is set (production), use it
  if (process.env.DATABASE_URL) {
    return { connectionString: process.env.DATABASE_URL };
  }

  // Discrete fields rather than an interpolated URL: values reach pg literally,
  // so reserved characters in a password cannot change the target, and a
  // unix-socket PGHOST works.
  const config = {
    user: process.env.PGUSER || 'jd',
    host: process.env.PGHOST || 'localhost',
    port: process.env.PGPORT || 5432,
    database: process.env.PGDATABASE,
  };

  const password = process.env.PGPASSWORD;
  if (password && password.trim().length > 0) {
    config.password = password;
  }

  return config;
}

// Resolves a Pool config exactly as each pg Client will. pg's parse failures
// carry the raw connection string in `err.input`, so they are replaced with a
// message that holds nothing from the input.
function resolveEffectiveConnection(config) {
  try {
    return new ConnectionParameters(config);
  } catch {
    throw new Error('invalid database connection configuration');
  }
}

module.exports = { buildPoolConfig, resolveEffectiveConnection };
