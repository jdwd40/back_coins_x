// Crypto Chaos Core 5: the single lifecycle-owned bot worker.
//
// Mirrors gameCycleWorker's contract: no timers are created at import time;
// the explicit start()/stop() lifecycle is called from the production
// application bootstrap only. Timer wakeups merely compute the deterministic
// tick id (wall-clock floored to the configured tick quantum) and delegate
// to botService.runBotTick — the DATABASE remains the duplicate-tick
// authority (apocalypse_bot_ticks UNIQUE (cycle_id, tick_id)), so even
// multiple processes can never execute the same tick twice. An in-flight
// guard additionally keeps this process single-tick at a time: a slow tick
// is never overlapped by the next wakeup.

const botService = require('./botService');
const { resolveBotConfig } = require('./botConfig');
const logger = require('../utils/logger');

class BotWorker {
  constructor() {
    this.timer = null;
    this.lastTick = null;
    this.inFlight = null;
    this.intervalMs = null;
  }

  isRunning() {
    return this.timer !== null;
  }

  // Deterministic tick identity: the wall clock floored to the configured
  // tick quantum. Every process computes the same id for the same instant,
  // which is exactly what the pg-backed claim deduplicates.
  tickIdFor(now, intervalMs = resolveBotConfig().tickIntervalMs) {
    const ms = (now instanceof Date ? now : new Date(now)).getTime();
    return Math.floor(ms / intervalMs);
  }

  runTick(now = new Date()) {
    if (this.inFlight) return this.inFlight; // single scheduler tick: never overlap
    const tickId = this.tickIdFor(now);
    this.inFlight = botService.runBotTick({ tickId, now })
      .catch((err) => {
        logger.error('[GAME] Bot tick failed:', err.message);
      })
      .finally(() => {
        this.inFlight = null;
      });
    this.lastTick = this.inFlight;
    return this.inFlight;
  }

  start() {
    if (this.timer) return this; // duplicate in-process starts are a no-op

    const config = resolveBotConfig();
    if (!config.enabled) {
      logger.log('[GAME] Bot worker disabled by configuration');
      return this;
    }
    this.intervalMs = config.tickIntervalMs;

    // Immediate tick on startup, then periodic scheduler wakeups.
    this.runTick();
    this.timer = setInterval(() => this.runTick(), this.intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    logger.log(`[GAME] Bot worker started (interval ${this.intervalMs}ms)`);
    return this;
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.log('[GAME] Bot worker stopped');
    }
  }
}

module.exports = new BotWorker();
