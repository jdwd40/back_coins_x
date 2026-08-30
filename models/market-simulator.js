// V2-1: server-authoritative deterministic cyclical market writer.
//
// This class owns ONLY lifecycle (start/stop of the periodic write batch)
// and persistence (coins + price_history + market_history, atomically, with
// Core 4 peak reconciliation). All pricing mathematics live in the unified
// price engine (game/priceEngine.js, SIM-08/09/10) — the exact same pure
// calculation the headless simulator (simulation/) calls — composed over
// the shared gameplay domain baseline (game/marketDomain.js). There is no
// random walk, no Math.random(), no in-memory volatility/event state:
// prices are a pure function of the persisted apocalypse cycle (seed +
// window), each coin's persisted cycle_baseline_price, its gameplay-roster
// archetype, the persisted Wave 1/2 phase/event/lifecycle authorities
// (loaded per batch via game/pricingContext.js) and authoritative time, so
// restarts reproduce identical prices from the database alone.
//
// Core 2: the apocalypse volatility factor is resolved ONCE per batch from
// authoritative Core 1 progress and passed to the domain as the amplitude
// multiplier (it scales deviation-from-anchor, never the anchor path).
// Core 3: collapsed coins are read from the persisted execution state and
// excluded entirely — they stay exactly £0, and £0 never trips the
// invalid-write guard.

const db = require('../db/connection');
const logger = require('../utils/logger');
const gameCycleService = require('../game/gameCycleService');
const { getApocalypseVolatility } = require('../game/apocalypseVolatility');
const collapseScheduleService = require('../game/collapseScheduleService');
const gameRoundService = require('../game/gameRoundService');
const marketDomain = require('../game/marketDomain');
const priceEngine = require('../game/priceEngine');
const { loadPricingContext } = require('../game/pricingContext');

// Time range options for price history
const TIME_RANGES = {
  '10M': 10 * 60 * 1000,        // 10 minutes in ms
  '30M': 30 * 60 * 1000,        // 30 minutes in ms
  '1H': 60 * 60 * 1000,         // 1 hour in ms
  '2H': 2 * 60 * 60 * 1000,     // 2 hours in ms
  '12H': 12 * 60 * 60 * 1000,   // 12 hours in ms
  '24H': 24 * 60 * 60 * 1000,   // 24 hours in ms
  'ALL': null                    // No time limit
};

// Map the batch's mean recent movement to the coarse market_history trend
// vocabulary (the market_history CHECK constraint admits exactly these).
function coarseMarketTrend(meanChangePct) {
  if (meanChangePct >= 0.5) return 'STRONG_BOOM';
  if (meanChangePct >= 0.1) return 'MILD_BOOM';
  if (meanChangePct <= -0.5) return 'STRONG_BUST';
  if (meanChangePct <= -0.1) return 'MILD_BUST';
  return 'STABLE';
}

class MarketSimulator {
  constructor() {
    this.priceUpdateInterval = 30000;  // 30 seconds
    this.updateIntervalId = null;
    this.isRunning = false;
    // Observability for GET /api/market/status only; never pricing state.
    this.lastBatch = null;
  }

  // Price one live coin through the unified price engine (SIM-08): the
  // shared pure calculation that the headless simulator also calls, fed by
  // the persisted Wave 1/2 pricing context loaded for this batch. Extracted
  // as a method so a fundamentally invalid domain result can be guarded per
  // coin and tests can observe the exact pricing calls of a batch.
  calculateNewPrice(coin, marketContext) {
    return priceEngine.unifiedPriceAt({
      seed: marketContext.seed,
      coinId: coin.coin_id,
      baselinePrice: parseFloat(coin.cycle_baseline_price),
      roundStartMs: marketContext.roundStartMs,
      nowMs: marketContext.nowMs,
      amplitude: marketContext.amplitude,
      lifecycleState: marketContext.pricingContext.lifecycleState,
      cycleProgress: marketContext.cycleProgress,
      phaseModifier: marketContext.pricingContext.phaseModifierAt(marketContext.nowMs),
      eventModifier: marketContext.pricingContext.eventModifierFor(coin.coin_id, marketContext.nowMs)
    });
  }

  // Start the market writer
  async start() {
    if (this.isRunning) {
      logger.log('[MARKET] Already running');
      return;
    }

    try {
      logger.log('[MARKET] Starting V2 cyclical market writer...');
      this.isRunning = true;
      this.startPriceUpdates();
      logger.log('[MARKET] Successfully started');
    } catch (error) {
      logger.error('[MARKET] Failed to start:', error);
      this.isRunning = false;
    }
  }

  // Stop the market writer
  stop() {
    logger.log('[MARKET] Stopping market writer...');
    this.isRunning = false;

    if (this.updateIntervalId) {
      clearInterval(this.updateIntervalId);
      this.updateIntervalId = null;
    }

    logger.log('[MARKET] Market writer stopped');
  }

  // Start periodic price updates
  startPriceUpdates() {
    if (this.updateIntervalId) {
      return;
    }

    const startUpdateInterval = () => {
      this.updateIntervalId = setInterval(async () => {
        try {
          await this.updateAllPrices();
        } catch (error) {
          logger.error('[MARKET] Error in price update interval:', error);
          clearInterval(this.updateIntervalId);
          this.updateIntervalId = null;

          if (this.isRunning) {
            logger.log('[MARKET] Attempting recovery in 5 seconds...');
            setTimeout(() => {
              if (this.isRunning) {
                logger.log('[MARKET] Restarting price updates...');
                startUpdateInterval();
              } else {
                logger.log('[MARKET] Recovery aborted - market is stopped');
              }
            }, 5000);
          } else {
            logger.log('[MARKET] Market stopped due to error');
          }
        }
      }, this.priceUpdateInterval);
    };

    this.updateAllPrices().catch(error => {
      logger.error('[MARKET] Error in initial price update:', error);
    });

    startUpdateInterval();
  }

  // Update prices for all live coins from the shared cyclical domain.
  async updateAllPrices() {
    let client;
    try {
      // Resolve the authoritative Core 1 cycle ONCE per batch — before
      // opening the write transaction, so the cycle advisory lock and the
      // coin row locks can never interleave. reconcileCycle returns the
      // full persisted cycle row; the seed is server-internal and never
      // leaves this process. If Core 1 state is unreadable this throws here
      // and the batch aborts before any write.
      const cycle = await gameCycleService.reconcileCycle({});
      const batchNowMs = Date.now();
      const { apocalypsePercent } = gameCycleService.deriveProgress({
        startTime: cycle.start_time,
        endTime: cycle.end_time,
        durationMs: cycle.duration_ms,
        now: new Date(batchNowMs)
      });
      // Core 2: translate progress into a single bounded amplitude shared
      // by every coin calculation in this batch.
      const amplitude = getApocalypseVolatility(apocalypsePercent);

      // Core 3: the reconcileCycle() call above has already reconciled any
      // due collapses (they execute inside the Core 1 lifecycle transaction,
      // before this batch calculates prices). Read the persisted execution
      // state of the live cycle — never inferred from current_price === 0,
      // never held in memory — so collapsed coins are excluded.
      const collapsedCoinIds = await collapseScheduleService.getCollapsedCoinIds();

      // SIM-08: the persisted Wave 1/2 pricing context (hidden lifecycle
      // state, primary market phase chain, coin-event streams) for this
      // batch, read from the same reconciled authorities the cycle service
      // just extended. Internal only — never serialised publicly.
      const pricingContext = await loadPricingContext(db, cycle);

      const marketContext = {
        seed: cycle.seed,
        roundStartMs: new Date(cycle.start_time).getTime(),
        nowMs: batchNowMs,
        amplitude,
        pricingContext,
        cycleProgress: Math.min(1, Math.max(0, apocalypsePercent / 100)),
        cycleDurationMs: Number(cycle.duration_ms)
      };

      client = await db.getClient();
      await client.query('BEGIN');
      // Lock coins for consistent snapshot + atomic writes to coins + price_history + market_history
      const result = await client.query('SELECT coin_id, current_price, cycle_baseline_price FROM coins FOR UPDATE');
      const coins = result.rows;
      let totalMarketValue = 0;
      let changePctSum = 0;
      let changePctCount = 0;

      for (const coin of coins) {
        // A coin collapsed in the live cycle is dead for the rest of the
        // cycle: the writer must not calculate or write a new positive
        // price for it. It stays exactly £0; its £0 transition was already
        // appended to price_history by the collapse execution, so no
        // history row is written here either.
        if (collapsedCoinIds.has(coin.coin_id)) {
          if (parseFloat(coin.current_price) !== 0) {
            // Malformed persisted state: a collapsed coin with a non-zero
            // price. Fail the whole batch safely — write nothing, revive
            // nothing — rather than corrupt state further.
            throw new Error(
              `[MARKET] Collapsed coin ${coin.coin_id} has non-zero price ${coin.current_price}; aborting batch to fail safe`
            );
          }
          continue;
        }
        const newPrice = this.calculateNewPrice(coin, marketContext);
        // Never persist a corrupt value: an invalid price aborts the whole
        // batch (rollback below) instead of silently writing bad data.
        if (typeof newPrice !== 'number' || !Number.isFinite(newPrice) || newPrice <= 0) {
          throw new Error(
            `[MARKET] Refusing to write invalid price ${String(newPrice)} for coin ${coin.coin_id}; aborting batch`
          );
        }
        await client.query(
          'UPDATE coins SET current_price = $1 WHERE coin_id = $2',
          [newPrice, coin.coin_id]
        );
        // Apocalypse Monitor foundation: stamp every normal tick with the
        // already-reconciled authoritative cycle id (no extra lookup) and
        // its MARKET_TICK provenance.
        await client.query(
          `INSERT INTO price_history (coin_id, cycle_id, price, created_at, source)
           VALUES ($1, $2, $3, CURRENT_TIMESTAMP, 'MARKET_TICK')`,
          [coin.coin_id, cycle.cycle_id, newPrice]
        );
        totalMarketValue += newPrice;

        // Coarse recent movement for the market_history trend: the SAME
        // unified calculation, one public-lookback behind. The persisted
        // phase/event windows are evaluated exactly at the lookback
        // instant; the lifecycle input is the current persisted state (the
        // only one persisted — the trend vocabulary is coarse, so this
        // approximation is bounded by a single lifecycle step).
        const lookbackMs = marketContext.nowMs - marketDomain.PUBLIC_SIGNAL_LOOKBACK_MS;
        const previousPrice = priceEngine.unifiedPriceAt({
          seed: marketContext.seed,
          coinId: coin.coin_id,
          baselinePrice: parseFloat(coin.cycle_baseline_price),
          roundStartMs: marketContext.roundStartMs,
          nowMs: lookbackMs,
          amplitude,
          lifecycleState: marketContext.pricingContext.lifecycleState,
          cycleProgress: Math.min(1, Math.max(0, (lookbackMs - marketContext.roundStartMs) / marketContext.cycleDurationMs)),
          phaseModifier: marketContext.pricingContext.phaseModifierAt(lookbackMs),
          eventModifier: marketContext.pricingContext.eventModifierFor(coin.coin_id, lookbackMs)
        });
        changePctSum += ((newPrice - previousPrice) / previousPrice) * 100;
        changePctCount += 1;
      }

      const meanChangePct = changePctCount > 0 ? changePctSum / changePctCount : 0;
      const trend = coarseMarketTrend(meanChangePct);

      // Insert market_history from the same snapshot
      await client.query(
        'INSERT INTO market_history (total_value, market_trend) VALUES ($1, $2)',
        [totalMarketValue, trend]
      );

      // Core 4: set-based peak reconciliation. One SQL statement lifts every
      // active participant's monotonic peak_wealth from the prices just
      // written in this batch — atomically with the price update itself, and
      // with no per-participant JavaScript loop.
      await gameRoundService.reconcileActivePeaks(client);

      await client.query('COMMIT');
      this.lastBatch = { trend, at: new Date(batchNowMs) };
    } catch (error) {
      if (client) {
        try { await client.query('ROLLBACK'); } catch (_) {}
      }
      logger.error('[MARKET] Error updating prices:', error);
    } finally {
      if (client) {
        client.release();
      }
    }
  }

  // Format milliseconds to HH:MM:SS
  formatTimeRemaining(ms) {
    if (ms <= 0) return '00:00:00';
    const seconds = Math.floor((ms / 1000) % 60);
    const minutes = Math.floor((ms / (1000 * 60)) % 60);
    const hours = Math.floor(ms / (1000 * 60 * 60));
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }

  // Get current market status. V2-1: the cyclical domain holds no timers or
  // in-memory cycles, so the status reports the writer's own cadence and
  // the last batch's coarse trend. Random coin events no longer exist; the
  // events field stays as a (now always empty) contract for API clients.
  getMarketStatus() {
    if (!this.isRunning) {
      return {
        status: 'STOPPED',
        currentCycle: null,
        timeRemaining: 0,
        events: []
      };
    }

    const now = Date.now();
    const nextUpdateMs = this.lastBatch
      ? Math.max(0, this.priceUpdateInterval - (now - this.lastBatch.at.getTime()))
      : 0;

    return {
      status: 'RUNNING',
      currentCycle: {
        type: this.lastBatch?.trend || 'STABLE',
        timeRemaining: this.formatTimeRemaining(nextUpdateMs)
      },
      events: []
    };
  }

  // Get market statistics market highs/lows
  async getMarketStats(timeRange = '30M') {
    try {
      const timeRangeMs = TIME_RANGES[timeRange] || TIME_RANGES['30M'];
      const now = new Date();
      const timeFilter = timeRangeMs ? `AND created_at >= NOW() - INTERVAL '${timeRangeMs / 1000} seconds'` : '';

      // Get market statistics from market_history table
      const marketStats = await db.query(`
        WITH current_market AS (
          SELECT SUM(current_price) as current_value
          FROM coins
          WHERE current_price > 0
        ),
        market_history_stats AS (
          SELECT 
            (SELECT MAX(total_value) FROM market_history) as all_time_high,
            (SELECT MIN(total_value) FROM market_history) as all_time_low,
            (SELECT total_value 
             FROM market_history 
             WHERE created_at >= NOW() - INTERVAL '1 minute'
             ORDER BY created_at DESC 
             LIMIT 1) as latest_value,
            MAX(total_value) as period_high
          FROM market_history
          WHERE 1=1 ${timeFilter}
        )
        SELECT 
          (SELECT current_value FROM current_market) as current_value,
          COALESCE(all_time_high, 0) as all_time_high,
          COALESCE(all_time_low, 0) as all_time_low,
          COALESCE(latest_value, (SELECT current_value FROM current_market)) as latest_value,
          COALESCE(period_high, 0) as period_high
        FROM market_history_stats
      `);

      // Get current market status
      const marketStatus = await this.getMarketStatus();

      return {
        currentValue: parseFloat(marketStats.rows[0].current_value) || 0,
        allTimeHigh: parseFloat(marketStats.rows[0].all_time_high) || 0,
        allTimeLow: parseFloat(marketStats.rows[0].all_time_low) || 0,
        latestValue: parseFloat(marketStats.rows[0].latest_value) || 0,
        periodHigh: parseFloat(marketStats.rows[0].period_high) || 0,
        status: marketStatus.status || 'STOPPED',
        currentCycle: marketStatus.currentCycle || { type: 'NONE', timeRemaining: '00:00:00' },
        events: marketStatus.events || [],
        timestamp: now.toISOString()
      };

    } catch (error) {
      console.error('Error getting market stats:', error);
      throw error;
    }
  }
}

// Singleton instance
const marketSimulator = new MarketSimulator();

module.exports = marketSimulator;
