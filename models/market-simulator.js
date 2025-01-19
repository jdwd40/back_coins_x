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
    if (!this.currentCycle || !this.isRunning) return;

    try {
      const result = await db.query('SELECT coin_id, current_price FROM coins');
      const coins = result.rows;

      await db.query('BEGIN');
      try {
        for (const coin of coins) {
          const newPrice = this.calculateNewPrice(
            parseFloat(coin.current_price),
            coin.coin_id
          );

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
      } catch (error) {
        await db.query('ROLLBACK');
        throw error;
      }
    } catch (error) {
      console.error('Error updating prices:', error);
      // Stop the simulation if we encounter database errors
      this.stop();
    }
  }

  // Calculate new price based on market conditions
  calculateNewPrice(currentPrice, coinId) {
    let adjustment = 0;

    // Market cycle effect (±0.5% to ±2% per update)
    const cycleEffect = this.currentCycle.type === MARKET_CYCLES.BOOM ? 1 : 
                       this.currentCycle.type === MARKET_CYCLES.BUST ? -1 : 0;
    adjustment += (Math.random() * 0.015 + 0.005) * cycleEffect;

    // Coin-specific event effect
    const event = this.coinEvents.get(coinId);
    if (event) {
      const eventProgress = (new Date() - event.startTime) / event.duration;
      const eventEffect = (event.multiplier - 1) * (1 - eventProgress);
      adjustment += eventEffect * 0.01; // Scale down the effect
    }

    // Apply the adjustment
    const newPrice = currentPrice * (1 + adjustment);
    return Math.round(newPrice * 100) / 100; // Round to 2 decimal places
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
}

// Singleton instance
const marketSimulator = new MarketSimulator();

module.exports = marketSimulator;
