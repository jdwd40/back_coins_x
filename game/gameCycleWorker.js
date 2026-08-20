const { reconcileCycle } = require('./gameCycleService');
const logger = require('../utils/logger');

const DEFAULT_WORKER_INTERVAL_MS = 60 * 1000;

// Maintenance wakeups only: the database remains the cross-process authority
// and every state read also recovers rollover safely. No timers are created
// at import time; the explicit start()/stop() lifecycle is called from the
// production application bootstrap.
class GameCycleWorker {
  constructor() {
    this.timer = null;
    this.lastMaintenance = null;
    const configured = Number(process.env.GAME_CYCLE_WORKER_INTERVAL_MS);
    this.intervalMs = Number.isFinite(configured) && configured > 0
      ? Math.floor(configured)
      : DEFAULT_WORKER_INTERVAL_MS;
  }

  isRunning() {
    return this.timer !== null;
  }

  runMaintenance() {
    this.lastMaintenance = reconcileCycle({}).catch((err) => {
      logger.error('[GAME] Cycle maintenance failed:', err.message);
    });
    return this.lastMaintenance;
  }

  start() {
    if (this.timer) return this; // duplicate in-process starts are a no-op

    // Immediate recovery on startup, then periodic maintenance wakeups.
    this.runMaintenance();
    this.timer = setInterval(() => this.runMaintenance(), this.intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    logger.log(`[GAME] Cycle worker started (interval ${this.intervalMs}ms)`);
    return this;
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.log('[GAME] Cycle worker stopped');
    }
  }
}

module.exports = new GameCycleWorker();
