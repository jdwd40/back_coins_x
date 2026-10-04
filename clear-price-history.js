// Destructive maintenance script: TRUNCATE price_history CASCADE.
//
// Usage:
//   npm run clear-price-history -- --yes
//   CONFIRM_CLEAR_PRICE_HISTORY=YES npm run clear-price-history
//
// Safety guards (issue #50) — the script REFUSES to run unless ALL hold:
//   * NODE_ENV is not "production" (mirrors the hard stop in db/seed.js);
//   * the resolved database name contains "test" AND the resolved host is
//     local (same philosophy as __tests__/helpers/testDatabaseGuard.js);
//   * explicit confirmation was given via --yes or
//     CONFIRM_CLEAR_PRICE_HISTORY=YES — otherwise it prints what it would
//     have done and aborts.
// The database connection is only required after every guard has passed, so
// a refusal never even builds a pool.

function isLocalHost(host) {
  if (['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) return true;
  // Unix-domain socket directory (e.g. /var/run/postgresql).
  return typeof host === 'string' && host.startsWith('/');
}

function refuse(reason) {
  console.error(`clear-price-history: REFUSING to run — ${reason}`);
  process.exit(1);
}

function assertSafeTarget() {
  let connection;
  let target;
  try {
    connection = require('./db/connectionConfig');
    target = connection.resolveConnectionTarget();
  } catch {
    // Parser errors can contain an entire credential-bearing URL.
    refuse('invalid database connection configuration.');
  }
  if (connection.ENV === 'production' || process.env.NODE_ENV === 'production') {
    refuse('NODE_ENV=production. This script is destructive and must never run against production.');
  }
  const { host, database } = target;
  if (typeof database !== 'string' || !/test/i.test(database)) {
    refuse('resolved database is not a disposable test database (name must contain "test").');
  }
  if (!isLocalHost(host)) {
    refuse('resolved host is not local.');
  }
  return { host, database };
}

async function clearPriceHistory() {
  assertSafeTarget();

  const confirmed = process.argv.includes('--yes') ||
    process.env.CONFIRM_CLEAR_PRICE_HISTORY === 'YES';
  if (!confirmed) {
    console.log('clear-price-history: no confirmation given — aborting WITHOUT making any changes.');
    console.log('Would have run: TRUNCATE price_history CASCADE on the resolved local test database.');
    console.log('Re-run with --yes or CONFIRM_CLEAR_PRICE_HISTORY=YES to proceed.');
    process.exit(1);
  }

  // Required only after all guards pass: a refusal never builds a pool.
  const db = require('./db/connection');
  try {
    await db.query('TRUNCATE price_history CASCADE');
    console.log('Successfully cleared price history database');
  } catch {
    console.error('Error clearing price history: database operation failed.');
    process.exitCode = 1;
  } finally {
    await db.end();
  }
}

clearPriceHistory().catch(() => {
  console.error('clear-price-history: failed safely; connection details withheld.');
  process.exitCode = 1;
});
