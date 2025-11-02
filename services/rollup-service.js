const db = require('../db/connection');
const logger = require('../utils/logger');

// Configuration constants
const ROLLUP_INTERVALS = {
  ONE_MINUTE: 60000,        // 1 minute in milliseconds
  FIVE_MINUTES: 300000,     // 5 minutes in milliseconds
  FIFTEEN_MINUTES: 900000,  // 15 minutes in milliseconds
  ONE_HOUR: 3600000,        // 1 hour in milliseconds
  CLEANUP: 21600000         // 6 hours in milliseconds
};

const INITIAL_ROLLUP_DELAY = 65000; // 65 seconds - wait for initial data accumulation

/**
 * RollupService - Manages periodic aggregation of price history into rollup buckets
 * Computes OHLC (Open, High, Low, Close) candles for multiple time intervals
 */
class RollupService {
  constructor() {
    this.intervalIds = {
      '1m': null,
      '5m': null,
      '15m': null,
      '1h': null,
      'cleanup': null
    };
    this.isRunning = false;
  }

  /**
   * Start all rollup computation intervals
   */
  start() {
    if (this.isRunning) {
      logger.log('[ROLLUP] Already running');
      return;
    }

    logger.log('[ROLLUP] Starting rollup service...');
    this.isRunning = true;

    // Start 1-minute rollups
    this.intervalIds['1m'] = setInterval(() => {
      this.compute1mRollups().catch(err => {
        logger.error('[ROLLUP] Error in 1m rollup:', err);
      });
    }, ROLLUP_INTERVALS.ONE_MINUTE);

    // Start 5-minute rollups
    this.intervalIds['5m'] = setInterval(() => {
      this.compute5mRollups().catch(err => {
        logger.error('[ROLLUP] Error in 5m rollup:', err);
      });
    }, ROLLUP_INTERVALS.FIVE_MINUTES);

    // Start 15-minute rollups
    this.intervalIds['15m'] = setInterval(() => {
      this.compute15mRollups().catch(err => {
        logger.error('[ROLLUP] Error in 15m rollup:', err);
      });
    }, ROLLUP_INTERVALS.FIFTEEN_MINUTES);

    // Start 1-hour rollups
    this.intervalIds['1h'] = setInterval(() => {
      this.compute1hRollups().catch(err => {
        logger.error('[ROLLUP] Error in 1h rollup:', err);
      });
    }, ROLLUP_INTERVALS.ONE_HOUR);

    // Start cleanup
    this.intervalIds['cleanup'] = setInterval(() => {
      this.cleanupOldRollups().catch(err => {
        logger.error('[ROLLUP] Error in cleanup:', err);
      });
    }, ROLLUP_INTERVALS.CLEANUP);

    // Run initial computations after delay (let some data accumulate)
    setTimeout(() => {
      if (this.isRunning) {
        logger.log('[ROLLUP] Running initial rollup computations...');
        this.compute1mRollups().catch(err => logger.error('[ROLLUP] Initial 1m error:', err));
      }
    }, INITIAL_ROLLUP_DELAY);

    logger.log('[ROLLUP] Rollup service started successfully');
    logger.log('[ROLLUP] - 1m rollups: every 60 seconds');
    logger.log('[ROLLUP] - 5m rollups: every 5 minutes');
    logger.log('[ROLLUP] - 15m rollups: every 15 minutes');
    logger.log('[ROLLUP] - 1h rollups: every hour');
    logger.log('[ROLLUP] - Cleanup: every 6 hours');
  }

  /**
   * Stop all rollup computation intervals
   */
  stop() {
    if (!this.isRunning) {
      return;
    }

    logger.log('[ROLLUP] Stopping rollup service...');
    this.isRunning = false;

    // Clear all intervals
    Object.keys(this.intervalIds).forEach(key => {
      if (this.intervalIds[key]) {
        clearInterval(this.intervalIds[key]);
        this.intervalIds[key] = null;
      }
    });

    logger.log('[ROLLUP] Rollup service stopped');
  }

  /**
   * Compute 1-minute rollups from raw price_history data
   */
  async compute1mRollups() {
    try {
      const result = await db.query(`
        INSERT INTO price_history_rollups (coin_id, interval_type, bucket_start, open, high, low, close, tick_count)
        SELECT 
            coin_id,
            '1m' as interval_type,
            DATE_TRUNC('minute', created_at) AS bucket_start,
            (ARRAY_AGG(price ORDER BY created_at ASC))[1] AS open,
            MAX(price) AS high,
            MIN(price) AS low,
            (ARRAY_AGG(price ORDER BY created_at DESC))[1] AS close,
            COUNT(*) AS tick_count
        FROM price_history
        WHERE created_at >= DATE_TRUNC('minute', NOW()) - INTERVAL '2 minutes'
          AND created_at < DATE_TRUNC('minute', NOW())
        GROUP BY coin_id, DATE_TRUNC('minute', created_at)
        ON CONFLICT (coin_id, interval_type, bucket_start) DO NOTHING
        RETURNING bucket_start, coin_id;
      `);

      if (result.rowCount > 0) {
        logger.log(`[ROLLUP] Computed ${result.rowCount} 1m rollup(s)`);
      }
    } catch (error) {
      logger.error('[ROLLUP] Error computing 1m rollups:', error);
      // Don't throw - log and continue to keep service running
    }
  }

  /**
   * Compute 5-minute rollups from raw price_history data
   */
  async compute5mRollups() {
    try {
      const result = await db.query(`
        INSERT INTO price_history_rollups (coin_id, interval_type, bucket_start, open, high, low, close, tick_count)
        SELECT 
            coin_id,
            '5m' as interval_type,
            DATE_TRUNC('hour', created_at) + 
                (FLOOR(EXTRACT(MINUTE FROM created_at) / 5) * INTERVAL '5 minutes') AS bucket_start,
            (ARRAY_AGG(price ORDER BY created_at ASC))[1] AS open,
            MAX(price) AS high,
            MIN(price) AS low,
            (ARRAY_AGG(price ORDER BY created_at DESC))[1] AS close,
            COUNT(*) AS tick_count
        FROM price_history
        WHERE created_at >= DATE_TRUNC('hour', NOW()) + 
                (FLOOR(EXTRACT(MINUTE FROM NOW()) / 5) * INTERVAL '5 minutes') - INTERVAL '10 minutes'
          AND created_at < DATE_TRUNC('hour', NOW()) + 
                (FLOOR(EXTRACT(MINUTE FROM NOW()) / 5) * INTERVAL '5 minutes')
        GROUP BY coin_id, 
                 DATE_TRUNC('hour', created_at) + 
                 (FLOOR(EXTRACT(MINUTE FROM created_at) / 5) * INTERVAL '5 minutes')
        ON CONFLICT (coin_id, interval_type, bucket_start) DO NOTHING
        RETURNING bucket_start, coin_id;
      `);

      if (result.rowCount > 0) {
        logger.log(`[ROLLUP] Computed ${result.rowCount} 5m rollup(s)`);
      }
    } catch (error) {
      logger.error('[ROLLUP] Error computing 5m rollups:', error);
      // Don't throw - log and continue to keep service running
    }
  }

  /**
   * Compute 15-minute rollups from raw price_history data
   */
  async compute15mRollups() {
    try {
      const result = await db.query(`
        INSERT INTO price_history_rollups (coin_id, interval_type, bucket_start, open, high, low, close, tick_count)
        SELECT 
            coin_id,
            '15m' as interval_type,
            DATE_TRUNC('hour', created_at) + 
                (FLOOR(EXTRACT(MINUTE FROM created_at) / 15) * INTERVAL '15 minutes') AS bucket_start,
            (ARRAY_AGG(price ORDER BY created_at ASC))[1] AS open,
            MAX(price) AS high,
            MIN(price) AS low,
            (ARRAY_AGG(price ORDER BY created_at DESC))[1] AS close,
            COUNT(*) AS tick_count
        FROM price_history
        WHERE created_at >= DATE_TRUNC('hour', NOW()) + 
                (FLOOR(EXTRACT(MINUTE FROM NOW()) / 15) * INTERVAL '15 minutes') - INTERVAL '30 minutes'
          AND created_at < DATE_TRUNC('hour', NOW()) + 
                (FLOOR(EXTRACT(MINUTE FROM NOW()) / 15) * INTERVAL '15 minutes')
        GROUP BY coin_id, 
                 DATE_TRUNC('hour', created_at) + 
                 (FLOOR(EXTRACT(MINUTE FROM created_at) / 15) * INTERVAL '15 minutes')
        ON CONFLICT (coin_id, interval_type, bucket_start) DO NOTHING
        RETURNING bucket_start, coin_id;
      `);

      if (result.rowCount > 0) {
        logger.log(`[ROLLUP] Computed ${result.rowCount} 15m rollup(s)`);
      }
    } catch (error) {
      logger.error('[ROLLUP] Error computing 15m rollups:', error);
      // Don't throw - log and continue to keep service running
    }
  }

  /**
   * Compute 1-hour rollups from raw price_history data
   */
  async compute1hRollups() {
    try {
      const result = await db.query(`
        INSERT INTO price_history_rollups (coin_id, interval_type, bucket_start, open, high, low, close, tick_count)
        SELECT 
            coin_id,
            '1h' as interval_type,
            DATE_TRUNC('hour', created_at) AS bucket_start,
            (ARRAY_AGG(price ORDER BY created_at ASC))[1] AS open,
            MAX(price) AS high,
            MIN(price) AS low,
            (ARRAY_AGG(price ORDER BY created_at DESC))[1] AS close,
            COUNT(*) AS tick_count
        FROM price_history
        WHERE created_at >= DATE_TRUNC('hour', NOW()) - INTERVAL '2 hours'
          AND created_at < DATE_TRUNC('hour', NOW())
        GROUP BY coin_id, DATE_TRUNC('hour', created_at)
        ON CONFLICT (coin_id, interval_type, bucket_start) DO NOTHING
        RETURNING bucket_start, coin_id;
      `);

      if (result.rowCount > 0) {
        logger.log(`[ROLLUP] Computed ${result.rowCount} 1h rollup(s)`);
      }
    } catch (error) {
      logger.error('[ROLLUP] Error computing 1h rollups:', error);
      // Don't throw - log and continue to keep service running
    }
  }

  /**
   * Clean up rollups older than 24 hours
   */
  async cleanupOldRollups() {
    try {
      const result = await db.query(`
        DELETE FROM price_history_rollups 
        WHERE bucket_start < NOW() - INTERVAL '24 hours'
        RETURNING coin_id, interval_type, bucket_start;
      `);

      if (result.rowCount > 0) {
        logger.log(`[ROLLUP] Cleaned up ${result.rowCount} old rollup(s)`);
      }
    } catch (error) {
      logger.error('[ROLLUP] Error cleaning up rollups:', error);
      // Don't throw - log and continue to keep service running
    }
  }

  /**
   * Get current service status
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      activeIntervals: Object.keys(this.intervalIds)
        .filter(key => this.intervalIds[key] !== null)
    };
  }
}

// Singleton instance
const rollupService = new RollupService();

module.exports = rollupService;

