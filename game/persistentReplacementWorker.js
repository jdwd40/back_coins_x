// Persistent-market Stage 9 S9-03: lifecycle-owned replacement worker.
//
// The worker contains no market rules. It wakes periodically and delegates
// one reconciliation to persistentReplacementRuntime, whose transaction /
// durable-state rules make duplicate process wakeups safe. Importing this
// module creates no timer; production lifecycle calls start()/stop().

const replacementRuntime = require('./persistentReplacementRuntime');
const logger = require('../utils/logger');

const DEFAULT_INTERVAL_MS = 60 * 1000;

class PersistentReplacementWorker {
  constructor() {
    this.timer = null;
    this.inFlight = null;
    this.intervalMs = DEFAULT_INTERVAL_MS;
  }

  isRunning() {
    return this.timer !== null;
  }

  runTick(now = new Date()) {
    if (this.inFlight) return this.inFlight;
    const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
    this.inFlight = replacementRuntime.reconcilePersistentReplacements({ nowMs })
      .then((result) => {
        if (result.inserted.length > 0 || result.retiredCoinIds.length > 0) {
          logger.log(
            `[GAME] Persistent replacement reconciliation: retired=${result.retiredCoinIds.length}, inserted=${result.inserted.length}, active=${result.activeAfter}`
          );
        }
        return result;
      })
      .catch((err) => {
        // A missing active world during boot/provisioning is an operational
        // skip; corruption/runtime faults are logged identically and retried
        // next wakeup. The worker never fabricates a world.
        logger.error('[GAME] Persistent replacement tick failed:', err.message);
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  start() {
    if (this.timer) return this;
    this.runTick();
    this.timer = setInterval(() => this.runTick(), this.intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    logger.log(`[GAME] Persistent replacement worker started (interval ${this.intervalMs}ms)`);
    return this;
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.log('[GAME] Persistent replacement worker stopped');
    }
  }
}

module.exports = new PersistentReplacementWorker();
