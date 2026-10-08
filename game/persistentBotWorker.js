// Persistent-market Stage 8: the single lifecycle-owned persistent bot
// worker.
//
// No timers are created at import time; the explicit start()/stop() lifecycle is called from the production
// application bootstrap only. Timer wakeups merely compute the
// deterministic tick id (wall-clock floored to the configured tick quantum)
// and delegate to persistentBots.runPersistentBotTick — the DATABASE
// remains the duplicate-tick authority (persistent_bot_ticks PRIMARY KEY
// (world_id, tick_id)), so even multiple processes can never execute the
// same tick twice. An in-flight guard additionally keeps this process
// single-tick at a time, and the tick's session advisory run lock keeps it
// single-writer across processes (issue #56).
//
// A tick with no active persistent world is a loud skip (logged, never
// fatal): world provisioning at deployment is an explicit operational step
// (docs/persistent-world-ops.md), and the worker must never fabricate one.
//
const persistentBots = require('./persistentBots');
const { resolveBotConfig, resolvePersistentBotTickLimits } = require('./botConfig');
const logger = require('../utils/logger');

// Issue #56: the in-flight guard is cleared ONLY when the tick promise has
// genuinely settled. Ticks are bounded server-side (statement/lock
// timeouts) and by a cooperative deadline inside runPersistentBotTick, so
// the promise always settles; this worker never races a timer against
// running database work and never starts an overlapping tick. A wakeup
// that finds the previous tick still running logs it (once it is older
// than one interval) instead of silently skipping.
class PersistentBotWorker {
  constructor() {
    this.timer = null;
    this.inFlight = null;
    this.inFlightTickId = null;
    this.inFlightStartedAt = null;
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

  // One concise, safe summary line per tick (no seeds, no strategy
  // internals, no raw request data).
  logTickResult(result) {
    if (!result) return;
    if (result.outcome === 'SUCCESS') {
      const s = result.summary;
      logger.info(`[GAME] Persistent bot tick ${result.tickId} SUCCESS in ${result.durationMs}ms: buy=${s.buys} sell=${s.sells} loan=${s.loans} repay=${s.repays} hold=${s.holds} skip=${s.skips}`);
    } else {
      logger.info(`[GAME] Persistent bot tick ${result.tickId} ${result.outcome}: no bot actions`);
    }
  }

  runTick(now = new Date(), { tick = persistentBots.runPersistentBotTick } = {}) {
    if (this.inFlight) {
      const ageMs = Date.now() - this.inFlightStartedAt;
      if (this.intervalMs !== null && ageMs > this.intervalMs) {
        logger.error(`[GAME] Persistent bot tick ${this.inFlightTickId} still running after ${ageMs}ms; skipping overlapping wakeup (the tick is server-bounded and will settle)`);
      }
      return this.inFlight; // single scheduler tick: never overlap
    }
    const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
    const config = resolveBotConfig();
    const tickId = this.tickIdFor(nowMs, config.tickIntervalMs);
    const limits = resolvePersistentBotTickLimits(config.tickIntervalMs);
    this.inFlightTickId = tickId;
    this.inFlightStartedAt = Date.now();
    this.inFlight = Promise.resolve()
      .then(() => tick({ tickId, nowMs, limits }))
      .then((result) => {
        this.logTickResult(result);
        return result;
      })
      .catch((err) => {
        // No active world yet (pre-provisioning) is expected at boot;
        // anything else is a real fault. Either way the worker stays alive.
        const outcome = err && err.outcome ? err.outcome : 'ERROR';
        const s = err && err.summary;
        const counts = s ? ` [buy=${s.buys} sell=${s.sells} loan=${s.loans} repay=${s.repays} hold=${s.holds} skip=${s.skips} error=${s.errors}]` : '';
        logger.error(`[GAME] Persistent bot tick failed: tick ${tickId} ${outcome}${err && err.claimed ? ' (claimed, not successful)' : ''}${counts}:`, err && err.message ? err.message : String(err));
      })
      .finally(() => {
        this.inFlight = null;
        this.inFlightTickId = null;
        this.inFlightStartedAt = null;
      });
    return this.inFlight;
  }

  start() {
    if (this.timer) return this; // duplicate in-process starts are a no-op

    const config = resolveBotConfig();
    if (!config.enabled) {
      logger.info('[GAME] Persistent bot worker disabled by configuration');
      return this;
    }
    this.intervalMs = config.tickIntervalMs;

    // Immediate tick on startup, then periodic scheduler wakeups.
    this.runTick();
    this.timer = setInterval(() => this.runTick(), this.intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    logger.info(`[GAME] Persistent bot worker started (interval ${this.intervalMs}ms)`);
    return this;
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info('[GAME] Persistent bot worker stopped');
    }
  }
}

module.exports = new PersistentBotWorker();
