/**
 * Coins market worker (plan §9).
 *
 * Every TICK_INTERVAL_MS (default 30 s) this process calls
 * coins.run_market_tick(worker_id, expected_sequence) over a direct
 * PostgreSQL connection authenticated as the restricted `coins_worker` role.
 * All pricing/ledger writes happen inside the database function; this
 * process is only a reliable wake-up mechanism.
 *
 * Safety properties:
 *  - non-overlapping: next tick is scheduled only after the previous settles
 *  - sequence tracking: passes the last known tick_sequence; the DB rejects
 *    skew and no-ops stale retries (duplicate workers cannot double-apply)
 *  - the DB function also takes a transaction advisory lock
 *  - exponential backoff with jitter + circuit breaker (opens after 5
 *    consecutive failures, half-opens after 60 s)
 *  - structured JSON logs; the connection string is never logged
 *  - graceful shutdown on SIGINT/SIGTERM
 */
import pg from 'pg';

const {
  COINS_WORKER_DATABASE_URL,
  MARKET_WORKER_ID = `worker-${process.pid}`,
  TICK_INTERVAL_MS = '30000',
} = process.env;

if (!COINS_WORKER_DATABASE_URL) {
  console.error(JSON.stringify({ level: 'fatal', msg: 'COINS_WORKER_DATABASE_URL is required' }));
  process.exit(2);
}
if (!/[/:]coins_worker[:@/]|user=coins_worker/.test(COINS_WORKER_DATABASE_URL)) {
  console.error(JSON.stringify({
    level: 'fatal',
    msg: 'COINS_WORKER_DATABASE_URL must authenticate as the restricted coins_worker role',
  }));
  process.exit(2);
}

const tickMs = Number.parseInt(TICK_INTERVAL_MS, 10);
if (!Number.isFinite(tickMs) || tickMs < 1000) {
  console.error(JSON.stringify({ level: 'fatal', msg: 'TICK_INTERVAL_MS must be >= 1000' }));
  process.exit(2);
}

const log = (level, msg, extra = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, worker: MARKET_WORKER_ID, msg, ...extra }));

const client = new pg.Client({
  connectionString: COINS_WORKER_DATABASE_URL,
  connectionTimeoutMillis: 5000,
  statement_timeout: 20000,
});

let lastSequence = null;   // last sequence confirmed by the DB
let failures = 0;          // consecutive failures (circuit breaker)
let circuitOpenUntil = 0;  // epoch ms while the breaker is open
let shuttingDown = false;

async function tickOnce() {
  const { rows } = await client.query(
    'SELECT coins.run_market_tick($1, $2) AS r',
    [MARKET_WORKER_ID, lastSequence],
  );
  const r = rows[0].r;
  lastSequence = r.tick_sequence;
  if (r.skipped) {
    log('info', 'tick skipped', { reason: r.reason, sequence: r.tick_sequence });
  } else {
    log('info', 'tick applied', {
      sequence: r.tick_sequence, assets: r.assets_updated, cycle: r.cycle,
    });
  }
}

function backoffMs() {
  const base = Math.min(30000, 1000 * 2 ** failures);
  return base + Math.floor(Math.random() * 500); // jitter
}

async function loop() {
  if (shuttingDown) return;
  const now = Date.now();
  if (now < circuitOpenUntil) {
    log('warn', 'circuit open, skipping tick', { resumeInMs: circuitOpenUntil - now });
  } else {
    try {
      await tickOnce();
      failures = 0;
    } catch (err) {
      failures += 1;
      log('error', 'tick failed', { error: err.message, failures });
      if (failures >= 5) {
        circuitOpenUntil = Date.now() + 60000;
        log('error', 'circuit breaker opened for 60s', {});
      }
      // On connection loss, try to rebuild the client once per failure.
      if (/connection|terminated|ECONNRESET/i.test(err.message)) {
        try { await client.end().catch(() => {}); await client.connect(); }
        catch (e) { log('error', 'reconnect failed', { error: e.message }); }
      }
    }
  }
  const delay = failures > 0 ? backoffMs() : tickMs;
  setTimeout(loop, delay).unref?.();
}

async function shutdown(signal) {
  shuttingDown = true;
  log('info', 'shutdown requested', { signal });
  try { await client.end(); } catch { /* already closed */ }
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

try {
  await client.connect();
  log('info', 'worker started', { tickMs });
  await loop();
} catch (err) {
  log('fatal', 'startup failed', { error: err.message });
  process.exit(1);
}
