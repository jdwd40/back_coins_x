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

exports.getCoinPriceHistory = async (coinId, page = null, limit = null) => {
  try {
    console.log('Starting getCoinPriceHistory with:', { coinId, page, limit });
    
    // Base query without pagination
    let query = `
      SELECT 
        history_id,
        coin_id,
        price,
        created_at,
        TO_CHAR(created_at, 'YYYY-MM-DD HH24:MI:SS') as formatted_timestamp
      FROM price_history 
      WHERE coin_id = $1 
      ORDER BY created_at DESC
    `;
    
    const params = [coinId];
    
    // Add pagination if both page and limit are provided
    if (page !== null && limit !== null) {
      const offset = (page - 1) * limit;
      query += ` LIMIT $2 OFFSET $3`;
      params.push(limit, offset);
    }
    
    const result = await db.query(query, params);
    
    // Get total count for pagination metadata
    const countResult = await db.query(
      'SELECT COUNT(*) FROM price_history WHERE coin_id = $1',
      [coinId]
    );
    
    const totalCount = parseInt(countResult.rows[0].count);
    const totalPages = limit ? Math.ceil(totalCount / limit) : 1;
    
    console.log('Successfully retrieved price history:', result.rows);
    return {
      data: result.rows,
      pagination: {
        total_items: totalCount,
        total_pages: totalPages,
        current_page: page || 1,
        items_per_page: limit || totalCount
      }
    };
  } catch (error) {
    console.error('Error in getCoinPriceHistory:', error);
    throw error;
  }
};

// Time range options for market history
const TIME_RANGES = {
  '10M': '10 minutes',
  '30M': '30 minutes',
  '1H': '1 hour',
  '24H': '24 hours'
};

exports.getMarketHistory = async (timeRange = '30M') => {
  try {
    console.log('Starting getMarketHistory with timeRange:', timeRange);
    
    // Validate time range
    if (!TIME_RANGES[timeRange]) {
      throw new Error(`Invalid time range. Must be one of: ${Object.keys(TIME_RANGES).join(', ')}`);
    }
    
    // Base query for market snapshots with time range filter
    const snapshotsQuery = `
      WITH market_snapshots AS (
        SELECT 
          ph.created_at,
          SUM(ph.price * c.circulating_supply) as total_market_value,
          array_agg(json_build_object(
            'coin_id', c.coin_id,
            'symbol', c.symbol,
            'price', ph.price,
            'market_cap', (ph.price * c.circulating_supply)
          )) as coin_data
        FROM price_history ph
        JOIN coins c ON ph.coin_id = c.coin_id
        WHERE ph.created_at >= NOW() - INTERVAL '${TIME_RANGES[timeRange]}'
        GROUP BY ph.created_at
        ORDER BY ph.created_at DESC
      ),
      period_stats AS (
        SELECT 
          MAX(total_market_value) as period_high,
          MIN(total_market_value) as period_low,
          AVG(total_market_value) as period_average,
          (
            SELECT total_market_value 
            FROM market_snapshots 
            ORDER BY created_at DESC 
            LIMIT 1
          ) as current_value,
          COUNT(*) as data_points
        FROM market_snapshots
      )
      SELECT 
        ps.*,
        json_agg(
          json_build_object(
            'timestamp', TO_CHAR(ms.created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
            'total_market_value', ms.total_market_value,
            'coins', ms.coin_data
          ) ORDER BY ms.created_at DESC
        ) as history
      FROM period_stats ps, market_snapshots ms
      GROUP BY ps.period_high, ps.period_low, ps.period_average, ps.current_value, ps.data_points`;
    
    const result = await db.query(snapshotsQuery);
    
    const response = {
      timeRange,
      interval: TIME_RANGES[timeRange],
      stats: {
        period_high: result.rows[0].period_high,
        period_low: result.rows[0].period_low,
        period_average: result.rows[0].period_average,
        current_value: result.rows[0].current_value,
        data_points: result.rows[0].data_points
      },
      history: result.rows[0].history
    };
    
    console.log('Successfully retrieved market history');
    return response;
  } catch (error) {
    console.error('Error in getMarketHistory:', error);
    throw error;
  }
};
