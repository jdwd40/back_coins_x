const db = require('../db/connection');

exports.selectAllCoins = async () => {
  try {
    console.log('Starting selectAllCoins');
    const result = await db.query(`
      SELECT 
        coin_id,
        name,
        symbol,
        TO_CHAR(current_price, 'FM999999999999990.00') as current_price,
        TO_CHAR(market_cap, 'FM999999999999990.00') as market_cap,
        circulating_supply,
        COALESCE(TO_CHAR(price_change_24h, 'FM990.00'), '0.00') as price_change_24h
      FROM coins 
      ORDER BY market_cap DESC
    `);
    console.log('Successfully retrieved all coins:', result.rows);
    return result.rows;
  } catch (error) {
    console.error('Error in selectAllCoins:', error);
    throw error;
  }
};

exports.selectCoinById = async (coin_id) => {
  try {
    console.log('Starting selectCoinById with:', { coin_id });
    const result = await db.query(`
      SELECT 
        coin_id,
        name,
        symbol,
        TO_CHAR(current_price, 'FM999999999999990.00') as current_price,
        TO_CHAR(market_cap, 'FM999999999999990.00') as market_cap,
        circulating_supply,
        COALESCE(TO_CHAR(price_change_24h, 'FM990.00'), '0.00') as price_change_24h
      FROM coins 
      WHERE coin_id = $1
    `, [coin_id]);
    console.log('Successfully retrieved coin by id:', result.rows[0]);
    return result.rows[0];
  } catch (error) {
    console.error('Error in selectCoinById:', error);
    throw error;
  }
};

exports.updateCoinPrice = async (coin_id, current_price) => {
  try {
    console.log('Starting updateCoinPrice with:', { coin_id, current_price });
    
    // Validate price format (should be a valid decimal number)
    if (!/^\d+(\.\d{1,2})?$/.test(current_price.toString())) {
      console.log('Invalid price format:', current_price);
      throw new Error('Invalid price format');
    }

    // First get the current price to calculate the change
    const currentCoin = await db.query(
      'SELECT current_price FROM coins WHERE coin_id = $1',
      [coin_id]
    );
    console.log('Current coin data:', currentCoin.rows[0]);

    if (currentCoin.rows.length === 0) {
      throw new Error('Coin not found');
    }

    const oldPrice = parseFloat(currentCoin.rows[0].current_price);
    const newPrice = parseFloat(current_price);
    
    // Calculate price change percentage with a cap of ±999.99%
    let priceChange = oldPrice > 0 ? ((newPrice - oldPrice) / oldPrice) * 100 : 0;
    priceChange = Math.max(Math.min(priceChange, 999.99), -999.99);
    
    console.log('Calculated values:', { oldPrice, newPrice, priceChange });

    const result = await db.query(
      `UPDATE coins 
       SET current_price = ROUND($1::decimal, 2),
           price_change_24h = ROUND($2::decimal, 2)
       WHERE coin_id = $3
       RETURNING 
         coin_id,
         name,
         symbol,
         TO_CHAR(current_price, 'FM999999999999990.00') as current_price,
         TO_CHAR(market_cap, 'FM999999999999990.00') as market_cap,
         circulating_supply,
         COALESCE(TO_CHAR(price_change_24h, 'FM990.00'), '0.00') as price_change_24h`,
      [newPrice, priceChange, coin_id]
    );

    if (result.rows.length === 0) {
      throw new Error('Coin not found');
    }

    console.log('Successfully updated coin:', result.rows[0]);
    return result.rows[0];
  } catch (error) {
    console.error('Error in updateCoinPrice:', error);
    throw error;
  }
};

exports.updateAllCoinPrices = async () => {
  try {
    console.log('Starting updateAllCoinPrices');
    const result = await db.query('SELECT coin_id, current_price FROM coins');
    const coins = result.rows;
    
    // Begin transaction
    await db.query('BEGIN');
    console.log('Transaction started');

    for (const coin of coins) {
      // Record current price in history
      await db.query(
        `INSERT INTO price_history (coin_id, price) 
         VALUES ($1, $2)`,
        [coin.coin_id, coin.current_price]
      );
      console.log('Recorded price history for coin:', coin.coin_id);

      // Update coin price with a random change between -5% and +5%
      const priceChange = (Math.random() * 10 - 5) / 100; // -5% to +5%
      const newPrice = parseFloat(coin.current_price) * (1 + priceChange);
      
      await db.query(
        `UPDATE coins 
         SET current_price = ROUND($1::decimal, 2),
             price_change_24h = ROUND($2::decimal, 2)
         WHERE coin_id = $3`,
        [newPrice, priceChange * 100, coin.coin_id]
      );
      console.log('Updated price for coin:', coin.coin_id);
    }

    await db.query('COMMIT');
    console.log('Transaction committed');
  } catch (error) {
    await db.query('ROLLBACK');
    console.error('Error in updateAllCoinPrices:', error);
    throw error;
  }
};

exports.getCoinPriceHistory = async (coin_id) => {
  try {
    console.log('Starting getCoinPriceHistory with:', { coin_id });
    const result = await db.query(`
      SELECT 
        history_id,
        coin_id,
        TO_CHAR(price, 'FM999999999999990.00') as price,
        created_at
      FROM price_history 
      WHERE coin_id = $1 
      ORDER BY created_at DESC 
      LIMIT 24
    `, [coin_id]);
    
    if (result.rows.length === 0) {
      console.log('No price history found for coin:', coin_id);
      return null;
    }
    
    console.log('Successfully retrieved price history:', result.rows);
    return result.rows;
  } catch (error) {
    console.error('Error in getCoinPriceHistory:', error);
    throw error;
  }
};
