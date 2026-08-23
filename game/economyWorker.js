// Crypto Chaos issue #18: the single lifecycle-owned economy worker.
//
// Mirrors gameCycleWorker/botWorker's contract: no timers are created at
// import time; the explicit start()/stop() lifecycle is called from the
// production application bootstrap only. Timer wakeups merely delegate to
// economyService.runEconomyPass — the DATABASE remains the duplicate-work
// authority (apocalypse_economy_ticks claims + the cash-event ledger's
// unique logical identity), so even multiple processes can never apply the
// same debit twice. An in-flight guard additionally keeps this process
// single-pass at a time: a slow pass is never overlapped by the next
// wakeup.

const economyService = require('./economyService');
const { resolveEconomyConfig } = require('./economyConfig');
const logger = require('../utils/logger');

class EconomyWorker {
  constructor() {
    this.timer = null;
    this.lastPass = null;
    this.inFlight = null;
    this.intervalMs = null;
  }

  isRunning() {
    return this.timer !== null;
  }

  runPass(now = new Date()) {
    if (this.inFlight) return this.inFlight; // single pass: never overlap
    this.inFlight = economyService.runEconomyPass({ now })
      .catch((err) => {
        logger.error('[GAME] Economy pass failed:', err.message);
      })
      .finally(() => {
        this.inFlight = null;
      });
    this.lastPass = this.inFlight;
    return this.inFlight;
  }

  start() {
    if (this.timer) return this; // duplicate in-process starts are a no-op

    const config = resolveEconomyConfig();
    if (!config.enabled) {
      logger.log('[GAME] Economy worker disabled by configuration');
      return this;
    }
    this.intervalMs = config.workerIntervalMs;

    // Immediate recovery pass on startup, then periodic scheduler wakeups.
    this.runPass();
    this.timer = setInterval(() => this.runPass(), this.intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    logger.log(`[GAME] Economy worker started (interval ${this.intervalMs}ms)`);
    return this;
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.log('[GAME] Economy worker stopped');
    }
  }
}

module.exports = new EconomyWorker();
