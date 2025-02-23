const db = require('../db/connection');
const logger = require('../utils/logger');

// Market cycle types with more balanced effects
const MARKET_CYCLES = {
  STRONG_BOOM: { type: 'STRONG_BOOM', baseEffect: 0.005 },    // 0.5% max
  MILD_BOOM: { type: 'MILD_BOOM', baseEffect: 0.002 },       // 0.2% max
  STRONG_BUST: { type: 'STRONG_BUST', baseEffect: -0.005 },  // -0.5% max
  MILD_BUST: { type: 'MILD_BUST', baseEffect: -0.002 },      // -0.2% max
  STABLE: { type: 'STABLE', baseEffect: 0 }
};

// More balanced event impacts with longer durations
const COIN_EVENTS = {
  MAJOR_PARTNERSHIP: { type: 'MAJOR_PARTNERSHIP', multiplier: 1.05, duration: { min: 120000, max: 900000 } },  // +5%, 2-15 mins
  MINOR_PARTNERSHIP: { type: 'MINOR_PARTNERSHIP', multiplier: 1.02, duration: { min: 120000, max: 900000 } },  // +2%
  REGULATION_NEGATIVE: { type: 'REGULATION_NEGATIVE', multiplier: 0.95, duration: { min: 120000, max: 900000 } }, // -5%
  REGULATION_POSITIVE: { type: 'REGULATION_POSITIVE', multiplier: 1.03, duration: { min: 120000, max: 900000 } }, // +3%
  MAJOR_ADOPTION: { type: 'MAJOR_ADOPTION', multiplier: 1.08, duration: { min: 120000, max: 900000 } },        // +8%
  MINOR_ADOPTION: { type: 'MINOR_ADOPTION', multiplier: 1.03, duration: { min: 120000, max: 900000 } },        // +3%
  SCANDAL: { type: 'SCANDAL', multiplier: 0.93, duration: { min: 120000, max: 900000 } },                      // -7%
  RUMOR_POSITIVE: { type: 'RUMOR_POSITIVE', multiplier: 1.01, duration: { min: 120000, max: 900000 } },        // +1%
  RUMOR_NEGATIVE: { type: 'RUMOR_NEGATIVE', multiplier: 0.99, duration: { min: 120000, max: 900000 } }         // -1%
};

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

class MarketSimulator {
  constructor() {
    this.currentCycle = null;
    this.cycleTimeout = null;
    this.priceUpdateInterval = 30000;  // Changed to 30 seconds
    this.updateIntervalId = null;
    this.coinEvents = new Map();
    this.coinVolatility = new Map();
    this.isRunning = false;
    this.lastPrices = new Map();
    this.initialPrices = new Map();
  }

  // Initialize coin volatility profiles with more conservative values
  async initializeCoinVolatility() {
    const result = await db.query('SELECT coin_id, symbol, current_price FROM coins');
    const coins = result.rows;

    coins.forEach(coin => {
      // Store initial price for mean reversion
      this.initialPrices.set(coin.coin_id, parseFloat(coin.current_price));
      
      // Assign more conservative volatility (0.2 to 0.8)
      const baseVolatility = 0.2 + (Math.random() * 0.6);
      
      this.coinVolatility.set(coin.coin_id, {
        baseVolatility,
        lastUpdate: new Date(),
        trendDirection: Math.random() > 0.5 ? 1 : -1,
        trendStrength: Math.random() * 0.002, // 0.2% max trend effect
        trendDuration: this.getRandomDuration(30000, 60000), // 30s to 1m trend duration
        trendStartTime: new Date()
      });

      logger.log(`[MARKET] Set volatility for ${coin.symbol}: ${baseVolatility}`);
    });
  }

  // Calculate new price with mean reversion and damping
  calculateNewPrice(currentPrice, coinId) {
    const volatilityProfile = this.coinVolatility.get(coinId);
    if (!volatilityProfile) return currentPrice;

    const { baseVolatility, trendDirection, trendStrength } = volatilityProfile;
    const initialPrice = this.initialPrices.get(coinId);
    
    // Market cycle effect (reduced impact)
    const marketEffect = this.currentCycle ? 
      (this.currentCycle.type === 'STABLE' ? 0 : this.currentCycle.baseEffect * baseVolatility) : 0;

    // Coin-specific event effect
    const coinEvent = this.coinEvents.get(coinId);
    const eventEffect = coinEvent ? (coinEvent.multiplier - 1) * 0.1 * baseVolatility : 0;

    // Reduced random component (-0.2% to +0.2% * volatility)
    const randomEffect = ((Math.random() * 0.004) - 0.002) * baseVolatility;

    // Trend component with duration check
    let trendEffect = 0;
    const now = new Date();
    if (now - volatilityProfile.trendStartTime >= volatilityProfile.trendDuration) {
      // Update trend
      volatilityProfile.trendDirection *= -1; // Reverse direction
      volatilityProfile.trendStrength = Math.random() * 0.002;
      volatilityProfile.trendDuration = this.getRandomDuration(30000, 60000);
      volatilityProfile.trendStartTime = now;
      this.coinVolatility.set(coinId, volatilityProfile);
    }
    trendEffect = trendDirection * trendStrength;

    // Mean reversion effect (pulls price back towards initial price)
    const priceDeviation = (currentPrice - initialPrice) / initialPrice;
    const meanReversionStrength = 0.001; // 0.1% max reversion effect
    const meanReversionEffect = -priceDeviation * meanReversionStrength;

    // Combine all effects
    const totalEffect = marketEffect + eventEffect + randomEffect + trendEffect + meanReversionEffect;
    
    // Apply a much stricter change limit (0.5% max per update)
    const maxChange = 0.005;
    const limitedEffect = Math.max(Math.min(totalEffect, maxChange), -maxChange);
    
    // Calculate new price
    let newPrice = currentPrice * (1 + limitedEffect);

    // Enforce price bounds (between 20% and 500% of initial price)
    const minPrice = initialPrice * 0.2;
    const maxPrice = initialPrice * 5;
    newPrice = Math.min(Math.max(newPrice, minPrice), maxPrice);

    // Round based on price range
    if (newPrice < 1) {
      return Math.round(newPrice * 10000) / 10000; // 4 decimal places
    } else if (newPrice < 100) {
      return Math.round(newPrice * 100) / 100; // 2 decimal places
    } else {
      return Math.round(newPrice * 10) / 10; // 1 decimal place
    }
  }

  // Start the market simulation
  async start() {
    if (this.isRunning) {
      logger.log('[MARKET] Already running');
      return;
    }
    
    try {
      logger.log('[MARKET] Starting simulation...');
      await this.initializeCoinVolatility();
      await this.startNewMarketCycle();
      this.isRunning = true;
      this.startPriceUpdates();
      logger.log('[MARKET] Successfully started');
    } catch (error) {
      logger.error('[MARKET] Failed to start:', error);
      this.isRunning = false;
    }
  }

  // Stop the market simulation
  stop() {
    logger.log('[MARKET] Stopping simulation...');
    this.isRunning = false;
    
    if (this.updateIntervalId) {
      clearInterval(this.updateIntervalId);
      this.updateIntervalId = null;
    }
    
    if (this.cycleTimeout) {
      clearTimeout(this.cycleTimeout);
      this.cycleTimeout = null;
    }
    
    logger.log('[MARKET] Simulation stopped');
  }

  // Start a new market cycle
  async startNewMarketCycle() {
    if (!this.isRunning && this.currentCycle) return;

    if (this.cycleTimeout) {
      clearTimeout(this.cycleTimeout);
      this.cycleTimeout = null;
    }

    const cycleTypes = Object.values(MARKET_CYCLES);
    const randomCycle = cycleTypes[Math.floor(Math.random() * cycleTypes.length)];
    const duration = this.getRandomDuration(120000, 600000); // Changed to 2-10 mins

    this.currentCycle = {
      ...randomCycle,
      startTime: new Date(),
      duration: duration
    };

    logger.log(`[MARKET] New cycle: ${this.currentCycle.type}, Effect: ${this.currentCycle.baseEffect}, Duration: ${duration}ms`);

    this.cycleTimeout = setTimeout(() => {
      this.startNewMarketCycle();
    }, duration);

    await this.initializeCoinEvents();
  }

  // Initialize random events for all coins
  async initializeCoinEvents() {
    const result = await db.query('SELECT coin_id FROM coins');
    const coins = result.rows;

    coins.forEach(coin => {
      if (!this.coinEvents.has(coin.coin_id)) {
        this.startNewCoinEvent(coin.coin_id);
      }
    });
  }

  // Start a new random event for a coin
  startNewCoinEvent(coinId) {
    if (!this.isRunning) return;

    const events = Object.values(COIN_EVENTS);
    const event = events[Math.floor(Math.random() * events.length)];
    const duration = this.getRandomDuration(event.duration.min, event.duration.max);

    const coinEvent = {
      ...event,
      startTime: new Date(),
      duration: duration
    };

    this.coinEvents.set(coinId, coinEvent);

    // Schedule next event
    setTimeout(() => {
      this.startNewCoinEvent(coinId);
    }, duration);
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

  // Update prices for all coins based on current market conditions
  async updateAllPrices() {
    if (!this.isRunning) return;

    try {
      const result = await db.query('SELECT coin_id, current_price FROM coins');
      const coins = result.rows;

      for (const coin of coins) {
        const currentPrice = parseFloat(coin.current_price);
        const newPrice = this.calculateNewPrice(currentPrice, coin.coin_id);
        
        // Update current price in coins table and add to price history
        await db.query(
          'UPDATE coins SET current_price = $1 WHERE coin_id = $2',
          [newPrice, coin.coin_id]
        );
        
        await db.query(
          'INSERT INTO price_history (coin_id, price) VALUES ($1, $2)',
          [coin.coin_id, newPrice]
        );

        // Only store last price in memory for calculations
        this.lastPrices.set(coin.coin_id, newPrice);
      }
    } catch (error) {
      logger.error('[MARKET] Error updating prices:', error);
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

  // Generate a random duration within a range
  getRandomDuration(min, max) {
    return Math.floor(Math.random() * (max - min + 1) + min);
  }

  // Get current market status
  getMarketStatus() {
    if (!this.isRunning) {
      return {
        status: 'STOPPED',
        currentCycle: null,
        timeRemaining: 0,
        events: []
      };
    }

    const now = new Date();
    const cycleTimeRemaining = this.currentCycle ? 
      Math.max(0, this.currentCycle.duration - (now - this.currentCycle.startTime)) : 0;

    // Get active events with time remaining
    const activeEvents = Array.from(this.coinEvents.entries()).map(([coinId, event]) => {
      const eventTimeRemaining = Math.max(0, event.duration - (now - event.startTime));
      return {
        coinId,
        type: event.type,
        timeRemaining: this.formatTimeRemaining(eventTimeRemaining),
        effect: event.multiplier > 1 ? 'POSITIVE' : 'NEGATIVE'
      };
    });

    return {
      status: 'RUNNING',
      currentCycle: {
        type: this.currentCycle?.type || 'NONE',
        timeRemaining: this.formatTimeRemaining(cycleTimeRemaining)
      },
      events: activeEvents
    };
  }

  // Get market statistics market highs/lows
  async getMarketStats(timeRange = '30M') {
    try {
      const timeRangeMs = TIME_RANGES[timeRange] || TIME_RANGES['30M'];
      const now = new Date();
      const timeFilter = timeRangeMs ? `AND created_at >= NOW() - INTERVAL '${timeRangeMs / 1000} seconds'` : '';

      // Get market statistics including total value, highs, and lows
      const marketStats = await db.query(`
        WITH current_market AS (
          SELECT SUM(current_price) as current_value
          FROM coins
          WHERE current_price > 0
        ),
        market_history AS (
          SELECT 
            DATE_TRUNC('minute', created_at) as timestamp,
            SUM(price) as total_value
          FROM (
            SELECT DISTINCT ON (coin_id, DATE_TRUNC('minute', created_at))
              coin_id, price, created_at
            FROM price_history
            WHERE 1=1 ${timeFilter}
            ORDER BY coin_id, DATE_TRUNC('minute', created_at), created_at DESC
          ) ph
          GROUP BY DATE_TRUNC('minute', created_at)
        )
        SELECT 
          (SELECT current_value FROM current_market) as current_value,
          COALESCE(MAX(total_value), 0) as all_time_high,
          COALESCE(MIN(NULLIF(total_value, 0)), 0) as all_time_low,
          COALESCE(
            (SELECT total_value 
             FROM market_history 
             ORDER BY timestamp DESC 
             LIMIT 1
            ),
            (SELECT current_value FROM current_market)
          ) as latest_value
        FROM market_history
      `);

      // Get current market status
      const marketStatus = await this.getMarketStatus();

      return {
        currentValue: parseFloat(marketStats.rows[0].current_value) || 0,
        allTimeHigh: parseFloat(marketStats.rows[0].all_time_high) || 0,
        allTimeLow: parseFloat(marketStats.rows[0].all_time_low) || 0,
        latestValue: parseFloat(marketStats.rows[0].latest_value) || 0,
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
