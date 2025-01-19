const db = require('../db/connection');

// Market cycle types
const MARKET_CYCLES = {
  BOOM: 'BOOM',
  BUST: 'BUST',
  STABLE: 'STABLE'
};

// Coin event types
const COIN_EVENTS = {
  PARTNERSHIP: { type: 'PARTNERSHIP', multiplier: 1.2 },
  REGULATION: { type: 'REGULATION', multiplier: 0.8 },
  ADOPTION: { type: 'ADOPTION', multiplier: 1.3 },
  SCANDAL: { type: 'SCANDAL', multiplier: 0.7 },
  RUMOR: { type: 'RUMOR', multiplier: 1.1 }
};

class MarketSimulator {
  constructor() {
    this.currentCycle = null;
    this.cycleTimeout = null;
    this.priceUpdateInterval = 5000; // Make this configurable
    this.updateIntervalId = null;    // Store interval ID
    this.coinEvents = new Map(); // coin_id -> event
    this.isRunning = false;
  }

  // Start the market simulation
  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    
    // Start initial market cycle
    this.startNewMarketCycle();
    
    // Start price updates
    this.startPriceUpdates();
  }

  // Stop the market simulation
  stop() {
    this.isRunning = false;
    if (this.cycleTimeout) clearTimeout(this.cycleTimeout);
    if (this.updateIntervalId) clearInterval(this.updateIntervalId);
    this.coinEvents.clear();
  }

  // Start a new market cycle
  async startNewMarketCycle() {
    if (!this.isRunning) return;

    // Determine cycle type and duration
    const cycleTypes = Object.values(MARKET_CYCLES);
    const cycleType = cycleTypes[Math.floor(Math.random() * cycleTypes.length)];
    const duration = this.getRandomDuration(30000, 120000); // 30s to 2m

    this.currentCycle = {
      type: cycleType,
      startTime: new Date(),
      duration: duration
    };

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
    const duration = this.getRandomDuration(15000, 60000); // 15s to 1m

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
    this.updateIntervalId = setInterval(async () => {
      if (!this.isRunning) return;
      await this.updateAllPrices();
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
      const result = await db.query('SELECT coin_id, current_price FROM coins');
      const coins = result.rows;
      console.log(`Updating prices for ${coins.length} coins`);

      await db.query('BEGIN');
      try {
        for (const coin of coins) {
          const newPrice = this.calculateNewPrice(
            parseFloat(coin.current_price),
            coin.coin_id
          );

          console.log(`Updating coin ${coin.coin_id}: ${coin.current_price} -> ${newPrice}`);

          await db.query(
            `UPDATE coins 
             SET current_price = $1,
                 price_change_24h = ROUND(((($1::decimal - current_price) / current_price) * 100), 2)
             WHERE coin_id = $2`,
            [newPrice, coin.coin_id]
          );

          await db.query(
            `INSERT INTO price_history (coin_id, price)
             VALUES ($1, $2)`,
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

  // Calculate new price based on market conditions
  calculateNewPrice(currentPrice, coinId) {
    const marketEffect = (() => {
      switch (this.currentCycle.type) {
        case MARKET_CYCLES.BOOM:
          return 0.02; // 2% up bias
        case MARKET_CYCLES.BUST:
          return -0.02; // 2% down bias
        default:
          return 0; // No bias in stable market
      }
    })();

    const coinEvent = this.coinEvents.get(coinId);
    const eventEffect = coinEvent ? (coinEvent.multiplier - 1) * 0.1 : 0;

    // Random component (-2% to +2%)
    const randomEffect = (Math.random() * 0.04) - 0.02;

    // Combine all effects
    const totalEffect = marketEffect + eventEffect + randomEffect;
    
    // Calculate new price with the combined effect
    let newPrice = currentPrice * (1 + totalEffect);

    // Ensure price doesn't go below 0.01
    newPrice = Math.max(0.01, newPrice);

    // Round to 2 decimal places
    return Math.round(newPrice * 100) / 100;
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
