const app = require('./app');
const db = require('./db/connection');
const logger = require('./utils/logger');
const gameCycleWorker = require('./game/gameCycleWorker');
const botWorker = require('./game/botWorker');
const economyWorker = require('./game/economyWorker');
const persistentBotWorker = require('./game/persistentBotWorker');
const persistentReplacementWorker = require('./game/persistentReplacementWorker');
const marketSimulator = require('./models/market-simulator');

// Top-level production JWT check (executes on require, before any listen or startServer).
// Mirrors the root cause: prod only loads .env.production; sign+verify must share secret or protected routes 401.
if ((process.env.NODE_ENV || 'development') === 'production') {
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret || typeof jwtSecret !== 'string' || jwtSecret.trim() === '') {
    logger.fatal('JWT_SECRET is missing or blank in production environment.');
    logger.fatal('This is required for token signing AND verification to be consistent.');
    logger.fatal('Set JWT_SECRET in .env.production (or equivalent env var) and redeploy.');
    logger.fatal('No secret value is logged. Exiting non-zero.');
    process.exit(1);
  }
}

const PORT = process.env.PORT || 3000;
const SHUTDOWN_TIMEOUT_MS = 10000;

// Lifecycle state owned by this module. Importing server.js creates no
// listener, worker, or timer; startServer() must be called explicitly (the
// production bootstrap does so via the require.main guard at the bottom).
let httpServer = null;
let shutdownPromise = null;

// Test database connection before starting server
const startServer = async (port = PORT) => {
  console.log('Starting server initialization...');
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Database host: ${process.env.PGHOST || 'localhost'}`);

  try {
    console.log('Testing database connection...');

    // Add timeout to database query. The timer is always cleared so a
    // successful connection never leaves a stray timer behind.
    let dbTimeoutId;
    const dbTimeout = new Promise((resolve, reject) => {
      dbTimeoutId = setTimeout(() => reject(new Error('Database connection timeout after 5 seconds')), 5000);
    });

    const dbQuery = db.query('SELECT NOW()');
    const result = await Promise.race([dbQuery, dbTimeout]);
    clearTimeout(dbTimeoutId);

    console.log('Database connection successful:', result.rows[0]);

    httpServer = app.listen(port, () => {
      // S11-01 cutover: persistent market writer is the ONLY gameplay system
      // allowed to mutate live coins.current_price. Explicit lifecycle policy:
      // do NOT start dangerous legacy price-mutating workers (gameCycleWorker,
      // botWorker, economyWorker). Persistent systems (market writer via app.js,
      // persistentBotWorker, persistentReplacementWorker) still start.
      if (process.env.NODE_ENV === 'production') {
        // Legacy gameCycle/bot/economy deliberately omitted — they drive
        // restoreBaselinePrices + executeCollapse + settlement zeroing.
        // Reconcile paths remain available (HTTP compat) but are guarded
        // inside dynamicCollapseService to be price-neutral when persistent
        // world active.
        // Persistent-market Stage 8: the persistent roster bots trade THE
        // persistent economy. A tick before world provisioning is a loud
        // logged skip, never a crash (the worker never fabricates a world).
        persistentBotWorker.start();
        // Stage 9 S9-03: DEAD coins are soft-retired immediately and each
        // eligible death consumes at most one authored replacement after the
        // configured delay. DB locks + durable counters make multi-process
        // wakeups idempotent; the worker never merges/deploys anything.
        persistentReplacementWorker.start();
      }
      console.log('Express server started successfully');
      console.log(`Server is running on port ${port}`);
      console.log('Ready to accept connections');
    });
    return httpServer;
  } catch (error) {
    console.error('Server startup error:');
    console.error(`Error name: ${error.name}`);
    console.error(`Error message: ${error.message}`);
    if (error.code) {
      console.error(`PostgreSQL error code: ${error.code}`);
    }
    if (error.stack) {
      console.error('Stack trace:', error.stack);
    }
    process.exit(1);
  }
};

// Graceful, idempotent shutdown. The first call performs the work; every
// later call (including repeated signals) returns the same in-flight or
// completed promise, so shutdown can never run twice or corrupt state.
// Order: stop accepting new HTTP work and stop the background workers first,
// then drain/close the PostgreSQL pool. No timer survives: the worker
// interval is cleared and the force-exit fallback is unref'd.
const shutdown = (signal = 'unknown') => {
  if (shutdownPromise) return shutdownPromise;

  shutdownPromise = (async () => {
    console.log(`[LIFECYCLE] ${signal} received — starting graceful shutdown`);

    // Belt-and-braces: if anything below hangs, force exit. Unref'd so it
    // never keeps a cleanly drained process alive by itself.
    const forceExitId = setTimeout(() => {
      console.error(`[LIFECYCLE] Graceful shutdown exceeded ${SHUTDOWN_TIMEOUT_MS}ms — forcing exit`);
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    if (typeof forceExitId.unref === 'function') forceExitId.unref();

    // 1. Stop background workers/timers.
    try {
      gameCycleWorker.stop();
    } catch (err) {
      console.error('[LIFECYCLE] Error stopping game cycle worker:', err.message);
    }
    try {
      botWorker.stop();
    } catch (err) {
      console.error('[LIFECYCLE] Error stopping bot worker:', err.message);
    }
    try {
      persistentBotWorker.stop();
    } catch (err) {
      console.error('[LIFECYCLE] Error stopping persistent bot worker:', err.message);
    }
    try {
      persistentReplacementWorker.stop();
    } catch (err) {
      console.error('[LIFECYCLE] Error stopping persistent replacement worker:', err.message);
    }
    try {
      economyWorker.stop();
    } catch (err) {
      console.error('[LIFECYCLE] Error stopping economy worker:', err.message);
    }
    try {
      marketSimulator.stop();
    } catch (err) {
      console.error('[LIFECYCLE] Error stopping market simulator:', err.message);
    }

    // 2. Stop accepting new HTTP work and drain in-flight requests.
    if (httpServer) {
      await new Promise((resolve) => {
        if (!httpServer.listening) return resolve();
        httpServer.close(() => resolve());
      });
      httpServer = null;
      console.log('[LIFECYCLE] HTTP server closed');
    }

    // 3. Drain/close PostgreSQL resources (idempotent in db/connection).
    try {
      await db.end();
      console.log('[LIFECYCLE] Database pool closed');
    } catch (err) {
      console.error('[LIFECYCLE] Error closing database pool:', err.message);
    }

    clearTimeout(forceExitId);
    console.log('[LIFECYCLE] Shutdown complete');
  })();

  return shutdownPromise;
};

const handleSignal = (signal) => {
  shutdown(signal)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Shutdown failed:', err);
      process.exit(1);
    });
};

if (require.main === module) {
  process.on('SIGTERM', () => handleSignal('SIGTERM'));
  process.on('SIGINT', () => handleSignal('SIGINT'));
  startServer();
}

module.exports = { startServer, shutdown };
