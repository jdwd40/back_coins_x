const db = require('../db/connection');

exports.selectAllCoins = async () => {
  try {
    console.log('Starting selectAllCoins');
    const result = await db.query('SELECT * FROM coins');
    console.log('Successfully retrieved all coins:', result.rows);
    return result.rows;
  } catch (error) {
    console.error('Error in selectAllCoins:', error);
    throw error;
  }
};

exports.selectCoinById = async (coinId) => {
  try {
    console.log('Starting selectCoinById with:', { coinId });
    const result = await db.query('SELECT * FROM coins WHERE coin_id = $1', [coinId]);
    console.log('Successfully retrieved coin by id:', result.rows[0]);
    return result.rows[0];
  } catch (error) {
    console.error('Error in selectCoinById:', error);
    throw error;
  }
};

exports.updateCoinPrice = async (coinId, currentPrice) => {
  try {
    console.log('Starting updateCoinPrice with:', { coinId, currentPrice });
    
    // Validate price format (should be a valid decimal number)
    if (!/^\d+(\.\d{1,2})?$/.test(currentPrice.toString())) {
      console.log('Invalid price format:', currentPrice);
      throw new Error('Invalid price format');
    }

    const result = await db.query(
      `UPDATE coins 
       SET current_price = $1, 
           price_change_24h = (($1 - current_price) / current_price * 100)
       WHERE coin_id = $2 
       RETURNING *`,
      [currentPrice, coinId]
    );

    if (result.rows.length === 0) {
      throw new Error('Coin not found');
    }

    // Insert into price history
    await db.query(
      'INSERT INTO price_history (coin_id, price) VALUES ($1, $2)',
      [coinId, currentPrice]
    );

    console.log('Successfully updated coin:', result.rows[0]);
    return result.rows[0];
  } catch (error) {
    console.error('Error in updateCoinPrice:', error);
    throw error;
  }
};

exports.getCoinPriceHistory = async (coinId) => {
  try {
    console.log('Starting getCoinPriceHistory with:', { coinId });
    const result = await db.query(
      `SELECT history_id, coin_id, price, created_at 
       FROM price_history 
       WHERE coin_id = $1 
         AND created_at >= NOW() - INTERVAL '2 hours'
       ORDER BY created_at ASC`,
      [coinId]
    );
    
    if (result.rows.length === 0) {
      console.log('No price history found for coin:', coinId);
      return [];
    }

    console.log('Successfully retrieved price history:', result.rows.length, 'entries');
    return result.rows;
  } catch (error) {
    console.error('Error in getCoinPriceHistory:', error);
    throw error;
  }
};
