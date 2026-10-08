// Issue #56: bounded database work for the persistent bot tick.
//
// PostgreSQL-side timeouts are the only way to genuinely CANCEL database
// work: a JavaScript Promise.race would merely stop waiting while the
// statement (and its locks) kept running. These helpers apply validated
// integer millisecond limits so the server itself cancels a stuck statement
// (statement_timeout), gives up waiting for a lock (lock_timeout), or
// terminates a session left idle inside an open transaction
// (idle_in_transaction_session_timeout).
//
//   * applyLocalTimeouts(client, limits) — SET LOCAL inside the caller's
//     open transaction; the limits vanish at COMMIT/ROLLBACK, so a pooled
//     client is never left with altered settings.
//   * applySessionTimeouts(client, limits) — session-level SET for a
//     dedicated client the caller DESTROYS afterwards (release(true)).
//
// SET cannot take bind parameters, so every value is validated as a
// positive safe integer before it is interpolated.

const TIMEOUT_SETTINGS = Object.freeze({
  statementTimeoutMs: 'statement_timeout',
  lockTimeoutMs: 'lock_timeout',
  idleInTransactionTimeoutMs: 'idle_in_transaction_session_timeout'
});

// PostgreSQL error codes that mean "the server cancelled bounded work".
const PG_QUERY_CANCELED = '57014'; // statement_timeout (or a cancel request)
const PG_LOCK_NOT_AVAILABLE = '55P03'; // lock_timeout
const PG_IDLE_IN_TRANSACTION_TIMEOUT = '25P03';

function validateTimeoutMs(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer number of milliseconds; received ${String(value)}`);
  }
  return value;
}

function timeoutStatements(limits = {}, scope) {
  const statements = [];
  for (const [key, setting] of Object.entries(TIMEOUT_SETTINGS)) {
    if (limits[key] === undefined || limits[key] === null) continue;
    const ms = validateTimeoutMs(limits[key], key);
    statements.push(`SET ${scope}${setting} = ${ms}`);
  }
  return statements;
}

async function applyLocalTimeouts(client, limits) {
  if (!limits) return;
  for (const sql of timeoutStatements(limits, 'LOCAL ')) {
    await client.query(sql);
  }
}

async function applySessionTimeouts(client, limits) {
  if (!limits) return;
  for (const sql of timeoutStatements(limits, '')) {
    await client.query(sql);
  }
}

function isDatabaseTimeoutError(err) {
  const code = err && err.code;
  return code === PG_QUERY_CANCELED || code === PG_LOCK_NOT_AVAILABLE || code === PG_IDLE_IN_TRANSACTION_TIMEOUT;
}

module.exports = {
  PG_QUERY_CANCELED,
  PG_LOCK_NOT_AVAILABLE,
  PG_IDLE_IN_TRANSACTION_TIMEOUT,
  validateTimeoutMs,
  applyLocalTimeouts,
  applySessionTimeouts,
  isDatabaseTimeoutError
};
