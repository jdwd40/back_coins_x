const db = require('../db/connection');

// Market cycle types with more balanced effects
const MARKET_CYCLES = {
  STRONG_BOOM: { type: 'STRONG_BOOM', baseEffect: 0.005 },    // 0.5% max
  MILD_BOOM: { type: 'MILD_BOOM', baseEffect: 0.002 },       // 0.2% max
  STRONG_BUST: { type: 'STRONG_BUST', baseEffect: -0.005 },  // -0.5% max
  MILD_BUST: { type: 'MILD_BUST', baseEffect: -0.002 },      // -0.2% max
  STABLE: { type: 'STABLE', baseEffect: 0 }
};

// More balanced event impacts with shorter durations
const COIN_EVENTS = {
  MAJOR_PARTNERSHIP: { type: 'MAJOR_PARTNERSHIP', multiplier: 1.05, duration: { min: 20000, max: 40000 } },  // +5%
  MINOR_PARTNERSHIP: { type: 'MINOR_PARTNERSHIP', multiplier: 1.02, duration: { min: 10000, max: 20000 } },  // +2%
  REGULATION_NEGATIVE: { type: 'REGULATION_NEGATIVE', multiplier: 0.95, duration: { min: 15000, max: 30000 } }, // -5%
  REGULATION_POSITIVE: { type: 'REGULATION_POSITIVE', multiplier: 1.03, duration: { min: 15000, max: 30000 } }, // +3%
  MAJOR_ADOPTION: { type: 'MAJOR_ADOPTION', multiplier: 1.08, duration: { min: 25000, max: 45000 } },        // +8%
  MINOR_ADOPTION: { type: 'MINOR_ADOPTION', multiplier: 1.03, duration: { min: 12000, max: 22000 } },        // +3%
  SCANDAL: { type: 'SCANDAL', multiplier: 0.93, duration: { min: 17000, max: 35000 } },                      // -7%
  RUMOR_POSITIVE: { type: 'RUMOR_POSITIVE', multiplier: 1.01, duration: { min: 7000, max: 15000 } },        // +1%
  RUMOR_NEGATIVE: { type: 'RUMOR_NEGATIVE', multiplier: 0.99, duration: { min: 7000, max: 15000 } }         // -1%
};

class MarketSimulator {
  constructor() {
    this.currentCycle = null;
    this.cycleTimeout = null;
    this.priceUpdateInterval = 5000;
    this.updateIntervalId = null;
    this.coinEvents = new Map();
    this.coinVolatility = new Map();
    this.isRunning = false;
    this.lastPrices = new Map();
    this.initialPrices = new Map();
    this.priceHistory = new Map();
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

      // Initialize price history for this coin
      this.priceHistory.set(coin.coin_id, []);

      console.log(`Set volatility for ${coin.symbol}: ${baseVolatility}`);
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

    // Store in price history (keep last 24 hours)
    const priceHistory = this.priceHistory.get(coinId) || [];
    priceHistory.push({ price: newPrice, timestamp: now });
    if (priceHistory.length > 17280) { // 24h worth of 5s intervals
      priceHistory.shift();
    }
    this.priceHistory.set(coinId, priceHistory);

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
    console.log('Starting market simulation...');
    if (this.isRunning) {
      console.log('Market simulator already running');
      return;
    }
    
    try {
      // Initialize volatility profiles first
      console.log('Initializing coin volatility...');
      await this.initializeCoinVolatility();
      
      // Start initial market cycle
      console.log('Starting market cycle...');
      await this.startNewMarketCycle();
      
      // Mark as running only after initialization is complete
      this.isRunning = true;
      
      // Start price updates
      console.log('Starting price updates...');
      this.startPriceUpdates();
    } catch (error) {
      console.error('Error starting market simulator:', error);
      this.isRunning = false;
    }
  }

  // Start a new market cycle
  async startNewMarketCycle() {
    if (!this.isRunning && this.currentCycle) return;

    // Clear existing cycle timeout if any
    if (this.cycleTimeout) {
      clearTimeout(this.cycleTimeout);
      this.cycleTimeout = null;
    }

    // Determine cycle type and duration
    const cycleTypes = Object.values(MARKET_CYCLES);
    const randomCycle = cycleTypes[Math.floor(Math.random() * cycleTypes.length)];
    const duration = this.getRandomDuration(30000, 120000); // 30s to 2m

    this.currentCycle = {
      ...randomCycle,
      startTime: new Date(),
      duration: duration
    };

    console.log('Starting new market cycle:', {
      type: this.currentCycle.type,
      baseEffect: this.currentCycle.baseEffect,
      duration: duration
    });

    // Schedule next cycle
    this.cycleTimeout = setTimeout(() => {
      this.startNewMarketCycle();
    }, duration);

    // Start random events for coins
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
    console.log('Starting price updates...');
    if (this.updateIntervalId) {
      console.log('Price updates already running');
      return;
    }

    // Initial update
    this.updateAllPrices();

    // Set interval for future updates
    this.updateIntervalId = setInterval(() => {
      this.updateAllPrices();
    }, this.priceUpdateInterval);
  }

  // Update prices for all coins based on current market conditions
  async updateAllPrices() {
    if (!this.currentCycle || !this.isRunning) {
      console.log('Market simulator not running or no current cycle');
      return;
    }

    try {
      console.log('Starting price update cycle');
      const result = await db.query('SELECT coin_id, current_price::numeric FROM coins');
      const coins = result.rows;
      console.log(`Updating prices for ${coins.length} coins`);

      await db.query('BEGIN');
      try {
        for (const coin of coins) {
          // Ensure current_price is a number
          const currentPrice = typeof coin.current_price === 'string' 
            ? parseFloat(coin.current_price) 
            : coin.current_price;

          if (isNaN(currentPrice)) {
            console.error(`Invalid price for coin ${coin.coin_id}: ${coin.current_price}`);
            continue;
          }

          const newPrice = this.calculateNewPrice(currentPrice, coin.coin_id);

          if (isNaN(newPrice)) {
            console.error(`Calculated invalid price for coin ${coin.coin_id}: ${newPrice}`);
            continue;
          }

          console.log(`Updating coin ${coin.coin_id}: ${currentPrice} -> ${newPrice}`);

          await db.query(
            `UPDATE coins 
             SET current_price = $1::decimal,
                 price_change_24h = ROUND(((($1::decimal - current_price::decimal) / current_price::decimal) * 100), 2)
             WHERE coin_id = $2`,
            [newPrice, coin.coin_id]
          );

          await db.query(
            `INSERT INTO price_history (coin_id, price)
             VALUES ($1, $2::decimal)`,
            [coin.coin_id, newPrice]
          );
        }
        await db.query('COMMIT');
        console.log('Successfully updated all coin prices and recorded history');
      } catch (error) {
        await db.query('ROLLBACK');
        throw error;
      }
    } catch (error) {
      console.error('Error updating prices:', error);
    }
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
        timeRemaining: eventTimeRemaining,
        effect: event.multiplier > 1 ? 'POSITIVE' : 'NEGATIVE'
      };
    });

    return {
      status: 'RUNNING',
      currentCycle: {
        type: this.currentCycle?.type || 'NONE',
        timeRemaining: cycleTimeRemaining
      },
      events: activeEvents
    };
  }

  // Get market statistics including all coins and market highs/lows
  async getMarketStats() {
    try {
      // Get current values of all coins
      const currentValues = await db.query(`
        SELECT 
          c.*,
          COALESCE(
            (SELECT price 
             FROM price_history ph 
             WHERE ph.coin_id = c.coin_id 
             ORDER BY created_at DESC 
             LIMIT 1
            ),
            c.current_price
          ) as latest_price
        FROM coins c
      `);

      // Get all-time market high and low
      const marketStats = await db.query(`
        WITH market_totals AS (
          SELECT 
            created_at,
            SUM(price) as total_market_value
          FROM price_history
          GROUP BY created_at
        )
        SELECT 
          MAX(total_market_value) as all_time_high,
          MIN(total_market_value) as all_time_low,
          (
            SELECT total_market_value 
            FROM market_totals 
            ORDER BY created_at DESC 
            LIMIT 1
          ) as current_market_value
        FROM market_totals
      `);

      return {
        coins: currentValues.rows,
        market_stats: marketStats.rows[0] || {
          all_time_high: null,
          all_time_low: null,
          current_market_value: null
        }
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
