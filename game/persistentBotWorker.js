// Persistent-market Stage 8: the single lifecycle-owned persistent bot
// worker.
//
// Mirrors botWorker's contract: no timers are created at import time; the
// explicit start()/stop() lifecycle is called from the production
// application bootstrap only. Timer wakeups merely compute the
// deterministic tick id (wall-clock floored to the configured tick quantum)
// and delegate to persistentBots.runPersistentBotTick — the DATABASE
// remains the duplicate-tick authority (persistent_bot_ticks PRIMARY KEY
// (world_id, tick_id)), so even multiple processes can never execute the
// same tick twice. An in-flight guard additionally keeps this process
// single-tick at a time.
//
// A tick with no active persistent world is a loud skip (logged, never
// fatal): world provisioning at deployment is an explicit operational step
// (AUTOBUILD_STATE known-issues), and the worker must never fabricate one.
//
// The legacy cycle bot worker (botWorker.js) is untouched and keeps serving
// the retained old API surface until its Stage 13 retirement.

const persistentBots = require('./persistentBots');
const { resolveBotConfig } = require('./botConfig');
const logger = require('../utils/logger');

class PersistentBotWorker {
  constructor() {
    this.timer = null;
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
    this.inFlight = persistentBots.runPersistentBotTick({ tickId, nowMs: (now instanceof Date ? now : new Date(now)).getTime() })
      .catch((err) => {
        // No active world yet (pre-provisioning) is expected at boot;
        // anything else is a real fault. Either way the worker stays alive.
        logger.error('[GAME] Persistent bot tick failed:', err.message);
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  start() {
    if (this.timer) return this; // duplicate in-process starts are a no-op

    const config = resolveBotConfig();
    if (!config.enabled) {
      logger.log('[GAME] Persistent bot worker disabled by configuration');
      return this;
    }
    this.intervalMs = config.tickIntervalMs;

    // Immediate tick on startup, then periodic scheduler wakeups.
    this.runTick();
    this.timer = setInterval(() => this.runTick(), this.intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    logger.log(`[GAME] Persistent bot worker started (interval ${this.intervalMs}ms)`);
    return this;
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.log('[GAME] Persistent bot worker stopped');
    }
  }
}

module.exports = new PersistentBotWorker();
