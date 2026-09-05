// Persistent-market Stage 4 (master plan §12): server-authoritative
// PERSISTENT market writer — the runtime-authoritative path.
//
// This class owns ONLY lifecycle (start/stop of the periodic write batch)
// and persistence. All pricing mathematics live in the persistent engine
// (game/persistentPricing.js) composed over the persistent world identity
// (game/persistentWorld.js, migration 024), the per-coin committed market
// state (market_coin_state, models/marketCoinState.model.js) and the
// deterministic Market Director environment (game/marketDirector.js,
// migration 025) behind the game/marketEnvironment.js seam — the exact
// same pure calculation the persistent horizon harness
// (simulation/persistentHorizon.js) runs. There is no random walk, no
// Math.random(), no in-memory volatility/event state: prices are a pure
// function of the persisted world (seed + epoch), each coin's persisted
// market state, the persisted pricing checkpoints (migration 023) and
// authoritative time, so restarts reproduce identical prices from the
// database alone.
//
// Stage 4 runtime-authority contract:
//   * The batch NEVER reconciles, creates, rolls over or counts down an
//     Apocalypse cycle and never derives an apocalypse percentage or
//     amplitude. gameCycleService, apocalypseVolatility,
//     dynamicCollapseService and pricingContext are legacy compatibility
//     modules — retained for the old read/compatibility surface until
//     proven unreachable (Stage 13), never consulted by this writer.
//   * Death is the persistent per-coin status (market_coin_state): a DEAD
//     coin stays exactly £0 and is never priced again. Living→DEAD is an
//     EXPLICIT Stage 9 transition (game/persistentCoinDeath.js) decided
//     AFTER living pricing/condition advance when collapse risk crosses
//     the configured threshold — never because the living floor was hit.
//     The cycle-scoped apocalypse_coin_collapses records are legacy
//     history, not inputs.
//   * Every batch is atomic: new prices + price_history + per-coin market
//     state + pricing checkpoints + the Director cursor + market_history +
//     old-economy peak reconciliation commit together or roll back
//     together. World/Director state lives in its own tables (024/025),
//     separate from the pricing checkpoint table (023).
//   * Restarts are bit-identical: the pricing checkpoints resume the pure
//     engine accumulators (bit-identical to the origin walk) and the
//     Director walk resumes from the committed cursor (rebuilt and
//     verified by game/marketDirector.js#resumeDirectorCursor).
//   * Bots never see hidden Director data: the Director's rolls, chain
//     index and internals never leave this module; the only public Director
//     payload anywhere is regime + intensity (publicRegimeAt), and the bot
//     observation layer's assertPublicBotState allowlist forbids the rest.
//   * price_history provenance: persistent ticks are world-scoped, not
//     cycle-scoped — cycle_id is NULL (nullable by design, migration 019)
//     and created_at is stamped with the batch's authoritative instant so
//     simulated-time runs write a coherent timeline. source='MARKET_TICK'
//     is unchanged.
//
// Old API compatibility (until Stage 6 deployment cleanup): market status
// and market stats responses keep their existing shapes; the old-economy
// Core 4 peak reconciliation still runs in the batch transaction so the
// legacy round surface keeps observing live prices.

const db = require('../db/connection');
const logger = require('../utils/logger');
const gameRoundService = require('../game/gameRoundService');
const marketDomain = require('../game/marketDomain');
const persistentPricing = require('../game/persistentPricing');
const persistentWorld = require('../game/persistentWorld');
const marketDirector = require('../game/marketDirector');
const pricingCheckpointModel = require('./pricingCheckpoint.model');
const coinStateModel = require('./marketCoinState.model');
const directorStateModel = require('./marketDirectorState.model');
const { resolveSimulationConfig } = require('../game/simulationConfig');
const persistentCoinDeath = require('../game/persistentCoinDeath');

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

// The opening committed market state for a coin entering the persistent
// world (first batch after world provisioning, or an explicitly provisioned
// Stage 9 replacement). The archetype comes from the EXPLICIT gameplay
// roster only — never the silent MOON default (master plan §29); an
// unmapped coin aborts the batch loudly. The opening structural reference
// is the coin's live price (cutover continuity: the world opens exactly at
// the reference, so the first persistent prices continue where the market
// was), falling back to the durable restoration baseline; a coin with no
// positive reference source aborts the batch rather than fabricating one.
function initialCoinStateFor({ coin, world }) {
  const coinId = Number(coin.coin_id);
  const archetype = marketDomain.GAMEPLAY_ROSTER.get(coinId);
  if (!archetype) {
    throw new Error(
      `[MARKET] coin ${coinId} is not on the explicit gameplay roster; refusing to default an archetype (master plan §29) — aborting batch`
    );
  }
  const current = parseFloat(coin.current_price);
  const baseline = parseFloat(coin.cycle_baseline_price);
  const opening = Number.isFinite(current) && current > 0
    ? current
    : (Number.isFinite(baseline) && baseline > 0 ? baseline : NaN);
  if (!Number.isFinite(opening)) {
    throw new Error(
      `[MARKET] coin ${coinId} has no positive current price or restoration baseline to open its persistent structural reference; aborting batch`
    );
  }
  return {
    coinId,
    worldId: world.worldId,
    archetype,
    condition: 0,
    structuralReference: opening,
    peakReference: opening,
    status: 'ALIVE',
    diedAt: null
  };
}

class MarketSimulator {
  constructor() {
    this.priceUpdateInterval = 30000;  // 30 seconds
    this.updateIntervalId = null;
    this.isRunning = false;
    // Observability for GET /api/market/status only; never pricing state.
    this.lastBatch = null;
  }

  // Price one live coin through the persistent engine: the shared pure
  // calculation that the persistent horizon harness also runs, fed by the
  // coin's persisted market state and the batch's Director environment.
  // Extracted as a method so a fundamentally invalid engine result can be
  // guarded per coin and tests can observe the exact pricing calls of a
  // batch. When the persisted pricing checkpoint resumes cleanly it is
  // threaded through — the resumed calculation is bit-identical to the
  // stateless origin walk (game/persistentPricing.js), so this never
  // changes a persisted price. Returns the shared 4dp gameplay rounding.
  calculateNewPrice(coin, marketContext, coinState, storedCheckpoint = null) {
    return persistentPricing.persistentPriceAt({
      seed: marketContext.seed,
      coinId: coin.coin_id,
      archetypeId: coinState.archetype,
      originMs: marketContext.originMs,
      nowMs: marketContext.nowMs,
      structuralReference: coinState.structuralReference,
      environment: marketContext.environment,
      checkpoint: storedCheckpoint,
      config: marketContext.config
    });
  }

  // Start the market writer
  async start() {
    if (this.isRunning) {
      logger.log('[MARKET] Already running');
      return;
    }

    try {
      logger.log('[MARKET] Starting persistent market writer...');
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

  // Update prices for all live coins from the persistent world.
  //
  // nowMs is the batch's authoritative instant (default: the real clock).
  // Tests inject it for simulated-time/replay coverage; production always
  // uses the real clock. The batch instant is stamped onto every row the
  // batch writes so the persisted timeline is exactly the authoritative
  // one.
  async updateAllPrices({ nowMs } = {}) {
    let client;
    try {
      const batchNowMs = nowMs === undefined ? Date.now() : nowMs;
      if (typeof batchNowMs !== 'number' || !Number.isFinite(batchNowMs)) {
        throw new Error(`[MARKET] batch instant must be a finite number; received ${String(nowMs)}`);
      }

      // Resolve THE active persistent world ONCE per batch — before opening
      // the write transaction. A missing/corrupt world fails loudly here
      // and the batch aborts before any write; the world is provisioned
      // explicitly, never fabricated mid-batch.
      const world = await persistentWorld.resolveActiveWorld(db);
      const config = resolveSimulationConfig();

      client = await db.getClient();
      await client.query('BEGIN');
      // Lock coins for a consistent snapshot + atomic writes (the
      // coins-before-everything lock order is preserved: coin rows first,
      // then the persistent market-state rows, Director row and pricing
      // checkpoint rows — the same fixed order every batch).
      const result = await client.query('SELECT coin_id, current_price, cycle_baseline_price, retired FROM coins ORDER BY coin_id FOR UPDATE');
      const coins = result.rows;

      // The persistent committed state for this world, locked inside the
      // batch transaction. Missing coin rows mean "first batch for this
      // coin" and are initialized explicitly below; a corrupt row fails
      // loudly at the model layer and rolls the whole batch back.
      const coinStates = await coinStateModel.loadCoinStates(client, world.worldId);
      const committedDirector = await directorStateModel.loadDirectorState(client, world.worldId);
      const storedCheckpoints = await pricingCheckpointModel.loadCheckpoints(client, world.seed);

      // The Market Director behind the environment seam, resumed from the
      // committed cursor when one exists (worker restart: the walk resumes
      // at the committed regime instead of re-walking the world age; the
      // resume re-derives and bit-verifies the pure chain values). Every
      // batch rebuilds this provider from the database alone — the writer
      // holds NO in-memory pricing state across batches.
      const directorProvider = marketDirector.createMarketDirectorProvider({
        seed: world.seed,
        originMs: world.epochStartedAtMs,
        cursor: committedDirector
          ? marketDirector.resumeDirectorCursor({ seed: world.seed, state: committedDirector, config })
          : null,
        config
      });
      const marketContext = {
        seed: world.seed,
        originMs: world.epochStartedAtMs,
        nowMs: batchNowMs,
        environment: directorProvider,
        config
      };

      const windowMs = config.persistent.condition.recentReturnWindowMs;
      const batchInstant = new Date(batchNowMs).toISOString();

      let totalMarketValue = 0;
      let changePctSum = 0;
      let changePctCount = 0;

      for (const coin of coins) {
        let coinState = coinStates.get(coin.coin_id) || null;
        if (!coinState) {
          // A RETIRED catalogue coin with no persistent state is preserved
          // history (migration 014), not a persistent market member: the
          // batch leaves it untouched. A LIVE coin missing from the explicit
          // roster is genuine catalogue/roster drift and aborts loudly below
          // (master plan §29 — never the silent default).
          if (coin.retired && !marketDomain.GAMEPLAY_ROSTER.has(Number(coin.coin_id))) {
            continue;
          }
          // First persistent batch for this coin: open its committed state
          // explicitly (explicit roster archetype, live-price reference).
          coinState = initialCoinStateFor({ coin, world });
          await coinStateModel.upsertCoinState(client, coinState);
          coinStates.set(coin.coin_id, coinState);
        }

        // Persistent death (Stage 9 authority): a DEAD coin is dead
        // permanently — never priced, never revived, no new history. Its
        // price must already be exactly £0; a non-zero price is malformed
        // persisted state and aborts the whole batch safely.
        if (coinState.status === 'DEAD') {
          if (parseFloat(coin.current_price) !== 0) {
            throw new Error(
              `[MARKET] Persistently dead coin ${coin.coin_id} has non-zero price ${coin.current_price}; aborting batch to fail safe`
            );
          }
          continue;
        }

        const storedCheckpoint = storedCheckpoints.get(coin.coin_id) || null;
        // Checkpoint identity/context/future validation happens inside the
        // engine (resolvePersistentCheckpoint): a corrupt, foreign-context,
        // wrong-seed or future accumulator throws here and rolls the whole
        // batch back.
        const newPrice = this.calculateNewPrice(coin, marketContext, coinState, storedCheckpoint);
        // Never persist a corrupt value: an invalid price aborts the whole
        // batch (rollback below) instead of silently writing bad data.
        if (typeof newPrice !== 'number' || !Number.isFinite(newPrice) || newPrice <= 0) {
          throw new Error(
            `[MARKET] Refusing to write invalid price ${String(newPrice)} for coin ${coin.coin_id}; aborting batch`
          );
        }
        const detail = persistentPricing.computePersistentPrice({
          seed: world.seed,
          coinId: coin.coin_id,
          archetypeId: coinState.archetype,
          originMs: world.epochStartedAtMs,
          nowMs: batchNowMs,
          structuralReference: coinState.structuralReference,
          environment: directorProvider,
          checkpoint: storedCheckpoint,
          config
        });

        // Committed inputs for the condition transition: the recent log
        // return over the public window (reconstructed from PERSISTED
        // ticks — the window is database state, so a restart recomputes it
        // exactly), the drawdown from the DECAYING peak, and the committed
        // decaying crash damage (log space). The per-coin elapsed time is
        // the authoritative distance from the coin's last committed batch
        // instant (its checkpoint); a freshly opened coin advances zero.
        const windowOpenRows = await client.query(
          `SELECT price FROM price_history
            WHERE coin_id = $1 AND created_at >= $2 AND price > 0
            ORDER BY created_at ASC LIMIT 1`,
          [coin.coin_id, new Date(batchNowMs - windowMs).toISOString()]
        );
        const windowOpen = windowOpenRows.rows.length > 0 ? parseFloat(windowOpenRows.rows[0].price) : newPrice;
        const recentLogReturn = windowOpen > 0 ? Math.log(newPrice / windowOpen) : 0;
        const elapsedMs = storedCheckpoint ? batchNowMs - storedCheckpoint.checkpointMs : 0;
        const envNow = directorProvider.environmentAt(batchNowMs);
        const drawdown = persistentPricing.computePeakDrawdown(coinState.peakReference, newPrice);
        const logCommittedDamage = Math.log(detail.committedDamageFactor);

        const nextCondition = persistentPricing.advanceCondition({
          condition: coinState.condition,
          archetypeId: coinState.archetype,
          elapsedMs,
          recentLogReturn,
          drawdownFromPeak: drawdown,
          logCommittedDamage,
          netEventModifier: 0, // Stage 4: no persistent coin-event stream yet (recorded debt)
          environment: envNow,
          config
        });
        const nextReference = persistentPricing.advanceStructuralReference({
          structuralReference: coinState.structuralReference,
          condition: coinState.condition, // committed condition drives this batch's reference move
          environment: envNow,
          elapsedMs,
          config
        });
        const nextPeak = persistentPricing.advancePeakReference({
          peakReference: coinState.peakReference,
          price: newPrice,
          elapsedMs,
          config
        });

        // Freeze the resumable accumulator for this batch (living or death).
        const freshCheckpoint = persistentPricing.extractPersistentCheckpoint({
          seed: world.seed,
          coinId: coin.coin_id,
          archetypeId: coinState.archetype,
          originMs: world.epochStartedAtMs,
          nowMs: batchNowMs,
          reference: coinState.structuralReference,
          environment: directorProvider,
          stored: storedCheckpoint,
          config
        });

        const nextState = {
          ...coinState,
          condition: nextCondition,
          structuralReference: nextReference,
          peakReference: nextPeak
        };

        // Stage 9 S9-01: authoritative death decision AFTER living pricing
        // and condition/reference/peak advance. The living floor may have
        // clamped newPrice; that alone MUST NOT kill. Death fires only when
        // the condition-driven collapse-risk score crosses the configured
        // threshold, via the named decide/apply path.
        const recentChangePctForRisk = windowOpen > 0
          ? ((newPrice - windowOpen) / windowOpen) * 100
          : 0;
        const deathDecision = persistentCoinDeath.decideAuthoritativePersistentDeath({
          seed: world.seed,
          coinId: coin.coin_id,
          archetypeId: coinState.archetype,
          condition: nextCondition,
          phase: detail.phase,
          recentChangePct: recentChangePctForRisk,
          nowMs: batchNowMs,
          config
        });

        if (deathDecision.shouldDie) {
          await persistentCoinDeath.applyAuthoritativePersistentDeath(client, {
            coinId: coin.coin_id,
            worldId: world.worldId,
            diedAt: batchNowMs,
            nextState,
            checkpoint: freshCheckpoint,
            batchInstant
          });
          coinStates.set(coin.coin_id, {
            ...nextState,
            status: 'DEAD',
            diedAt: new Date(batchNowMs).toISOString()
          });
          // Dead coins contribute £0 and are excluded from the live trend.
          continue;
        }

        await client.query(
          'UPDATE coins SET current_price = $1 WHERE coin_id = $2',
          [newPrice, coin.coin_id]
        );
        // Persistent provenance: world-scoped tick, cycle_id NULL (nullable
        // by design, migration 019), created_at stamped with the batch's
        // authoritative instant.
        await client.query(
          `INSERT INTO price_history (coin_id, cycle_id, price, created_at, source)
           VALUES ($1, NULL, $2, $3, 'MARKET_TICK')`,
          [coin.coin_id, newPrice, batchInstant]
        );
        await pricingCheckpointModel.upsertCheckpoint(client, freshCheckpoint);
        // The committed per-coin market state advances in the same
        // transaction (the update path never touches status/died_at — death
        // transitions go exclusively through applyAuthoritativePersistentDeath).
        await coinStateModel.upsertCoinState(client, nextState);
        totalMarketValue += newPrice;

        // Coarse recent movement for the market_history trend from
        // PERSISTED ticks: the newest tick at or before one public lookback
        // behind the batch instant (index-backed, bounded; the batch's own
        // row is stamped AT the batch instant so it never self-matches).
        // A coin with no persisted tick that far back (a fresh world)
        // contributes no evidence rather than a fabricated comparison.
        const lookbackRows = await client.query(
          `SELECT price FROM price_history
            WHERE coin_id = $1 AND created_at <= $2 AND price > 0
            ORDER BY created_at DESC LIMIT 1`,
          [coin.coin_id, new Date(batchNowMs - marketDomain.PUBLIC_SIGNAL_LOOKBACK_MS).toISOString()]
        );
        if (lookbackRows.rows.length > 0) {
          const previousPrice = parseFloat(lookbackRows.rows[0].price);
          changePctSum += ((newPrice - previousPrice) / previousPrice) * 100;
          changePctCount += 1;
        }
      }

      // Commit the world's Director cursor in the SAME transaction (world/
      // Director state in its own table — never inside the pricing
      // checkpoint). Replay-safe: the cursor is a pure function of the
      // deterministic chain, so re-committing the same values is a no-op
      // write.
      const located = directorProvider.regimeAt(batchNowMs);
      await directorStateModel.upsertDirectorState(client, {
        worldId: world.worldId,
        regime: located.regime,
        regimeStartedAt: new Date(located.startMs).toISOString(),
        intensity: located.intensity,
        regimeIndex: located.regimeIndex
      });

      const meanChangePct = changePctCount > 0 ? changePctSum / changePctCount : 0;
      const trend = coarseMarketTrend(meanChangePct);

      // Insert market_history from the same snapshot
      await client.query(
        'INSERT INTO market_history (total_value, market_trend) VALUES ($1, $2)',
        [totalMarketValue, trend]
      );

      // Old-economy compatibility (until Stage 7): set-based peak
      // reconciliation. One SQL statement lifts every legacy active
      // participant's monotonic peak_wealth from the prices just written in
      // this batch — atomically with the price update itself, and with no
      // per-participant JavaScript loop. No new rounds/cycles are created.
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

  // Get current market status. Unchanged old-API shape (Stage 6 debt): the
  // writer's own cadence and the last batch's coarse trend. The events
  // field stays as a (now always empty) contract for API clients.
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
