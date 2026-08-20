// Guardrail for every mutating test: prove the target database is an
// explicitly approved, disposable, LOCAL test database before any seed,
// migration test, or multi-process race test is allowed to touch it.
//
// Approved target (all must hold):
//   * NODE_ENV === 'test'
//   * the resolved database name contains "test" (e.g. coins_test)
//   * the resolved host is local: localhost / 127.0.0.1 / ::1 / a unix socket
// Anything else throws immediately, so a misconfigured environment can never
// turn the test suite loose on a development or production database.

function resolveTarget() {
  if (process.env.DATABASE_URL) {
    let url;
    try {
      url = new URL(process.env.DATABASE_URL);
    } catch (err) {
      throw new Error(`test database guard: unparseable DATABASE_URL (${err.message})`);
    }
    return {
      host: decodeURIComponent(url.hostname),
      database: decodeURIComponent(url.pathname.replace(/^\//, ''))
    };
  }
  return {
    host: decodeURIComponent(process.env.PGHOST || 'localhost'),
    database: process.env.PGDATABASE || ''
  };
}

function isLocalHost(host) {
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
  // Unix-domain socket directory (e.g. /var/run/postgresql).
  return host.startsWith('/');
}

function assertDisposableTestDatabase() {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      `test database guard: NODE_ENV must be "test" for mutating tests; received ${JSON.stringify(process.env.NODE_ENV)}`
    );
  }
  const { host, database } = resolveTarget();
  if (!/test/i.test(database)) {
    throw new Error(
      `test database guard: refusing to run mutating tests against database ${JSON.stringify(database)} — the approved disposable test database name must contain "test" (e.g. coins_test)`
    );
  }
  if (!isLocalHost(host)) {
    throw new Error(
      `test database guard: refusing to run mutating tests against non-local host ${JSON.stringify(host)}`
    );
  }
  return { host, database };
}

module.exports = { assertDisposableTestDatabase, resolveTarget, isLocalHost };
