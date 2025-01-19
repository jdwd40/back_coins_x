const db = require('../db/connection');

exports.selectAllCoins = async () => {
  const result = await db.query(
    'SELECT * FROM coins ORDER BY market_cap DESC'
  );
  return result.rows;
};

exports.selectCoinById = async (coin_id) => {
  const result = await db.query(
    'SELECT * FROM coins WHERE coin_id = $1',
    [coin_id]
  );
  return result.rows[0];
};

exports.updateCoinPrice = async (coin_id, current_price) => {
  // Validate price format (should be a valid decimal number)
  if (!/^\d+(\.\d{1,2})?$/.test(current_price)) {
    throw new Error('Invalid price format');
  }

  const result = await db.query(
    `UPDATE coins 
     SET current_price = ROUND($1::decimal, 2),
         price_change_24h = ROUND(((($1::decimal - current_price) / current_price) * 100), 2)
     WHERE coin_id = $2
     RETURNING coin_id,
               name,
               symbol,
               TO_CHAR(current_price, 'FM999999999999990.00') as current_price,
               market_cap,
               volume_24h,
               TO_CHAR(price_change_24h, 'FM990.00') as price_change_24h`,
    [current_price, coin_id]
  );

  if (result.rows.length === 0) {
    throw new Error('Coin not found');
  }

  return result.rows[0];
};

exports.updateAllCoinPrices = async () => {
  const result = await db.query('SELECT coin_id, current_price FROM coins');
  const coins = result.rows;
  
  // Begin transaction
  return db.query('BEGIN')
    .then(async () => {
      // Use explicit timestamp for this batch of updates
      const updateTime = new Date().toISOString();
      
      for (const coin of coins) {
        // Generate random price change between -5% and +5%
        const changePercent = (Math.random() * 10 - 5) / 100;
        const newPrice = parseFloat(coin.current_price) * (1 + changePercent);
        const roundedPrice = Math.round(newPrice * 100) / 100;
        
        // Update current price and calculate price change
        await db.query(
          `UPDATE coins 
           SET current_price = $1,
               price_change_24h = ROUND(((($1::decimal - current_price) / current_price) * 100), 2)
           WHERE coin_id = $2`,
          [roundedPrice, coin.coin_id]
        );
        
        // Record in price history with explicit timestamp
        await db.query(
          `INSERT INTO price_history (coin_id, price, recorded_at)
           VALUES ($1, $2, $3)`,
          [coin.coin_id, roundedPrice, updateTime]
        );
      }
      
      return db.query('COMMIT');
    })
    .catch(async (error) => {
      await db.query('ROLLBACK');
      throw error;
    });
};

exports.getCoinPriceHistory = async (coin_id) => {
  const result = await db.query(
    `SELECT price_history_id, coin_id,
            TO_CHAR(price, 'FM999999999999990.00') as price,
            TO_CHAR(recorded_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as timestamp
     FROM price_history
     WHERE coin_id = $1
     ORDER BY recorded_at DESC`,
    [coin_id]
  );
  
  return result.rows;
};
