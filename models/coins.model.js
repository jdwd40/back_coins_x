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
      `SELECT 
        history_id,
        coin_id,
        price,
        created_at,
        TO_CHAR(created_at, 'YYYY-MM-DD HH24:MI:SS') as formatted_timestamp
      FROM price_history 
      WHERE coin_id = $1 
      ORDER BY created_at DESC`,
      [coinId]
    );
    console.log('Successfully retrieved price history:', result.rows);
    return result.rows;
  } catch (error) {
    console.error('Error in getCoinPriceHistory:', error);
    throw error;
  }
};

exports.getMarketHistory = async () => {
  try {
    console.log('Starting getMarketHistory');
    const result = await db.query(
      `WITH market_snapshots AS (
        SELECT 
          ph.recorded_at,
          SUM(ph.price * c.supply) as total_market_value
        FROM price_history ph
        JOIN coins c ON ph.coin_id = c.coin_id
        GROUP BY ph.recorded_at
        ORDER BY ph.recorded_at DESC
      ),
      market_stats AS (
        SELECT 
          MAX(total_market_value) as all_time_high,
          MIN(total_market_value) as all_time_low
        FROM market_snapshots
      )
      SELECT 
        ms.*,
        json_agg(
          json_build_object(
            'timestamp', TO_CHAR(mh.recorded_at, 'YYYY-MM-DD HH24:MI:SS'),
            'total_market_value', mh.total_market_value
          )
        ) as history
      FROM market_stats ms, market_snapshots mh
      GROUP BY ms.all_time_high, ms.all_time_low`
    );
    
    console.log('Successfully retrieved market history:', result.rows[0]);
    return result.rows[0];
  } catch (error) {
    console.error('Error in getMarketHistory:', error);
    throw error;
  }
};
