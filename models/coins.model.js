const db = require('../db/connection');
const { CurrencyFormatter } = require('../utils/currency-formatter');

// Fields to return in responses (excluding date_added)
const COIN_FIELDS = [
  'coin_id',
  'name',
  'symbol',
  'current_price',
  'market_cap',
  'circulating_supply',
  'price_change_24h',
  'founder'
].join(', ');

// Time range definitions in milliseconds
const TIME_RANGES = {
  '10M': 10 * 60 * 1000,        // 10 minutes in ms
  '30M': 30 * 60 * 1000,        // 30 minutes in ms
  '1H': 60 * 60 * 1000,         // 1 hour in ms
  '2H': 2 * 60 * 60 * 1000,     // 2 hours in ms
  '12H': 12 * 60 * 60 * 1000,   // 12 hours in ms
  '24H': 24 * 60 * 60 * 1000,   // 24 hours in ms
  'ALL': null                    // No time limit
};

/**
 * Format coin data for response
 */
function formatCoinResponse(coin) {
  return {
    ...coin,
    current_price: CurrencyFormatter.formatGBP(coin.current_price),
    market_cap: CurrencyFormatter.formatGBP(coin.market_cap),
    // Convert price_change_24h from string to number (PostgreSQL NUMERIC returns as string)
    price_change_24h: coin.price_change_24h === null ? null : Number(coin.price_change_24h)
  };
}

/**
 * Calculate price change percentage
 */
function calculatePriceChange(oldPrice, newPrice) {
  console.log('Calculating price change:', { oldPrice, newPrice });
  if (!oldPrice || oldPrice === 0) return 0;
  const change = Number(((newPrice - oldPrice) / oldPrice * 100).toFixed(2));
  console.log('Calculated change:', change);
  return change;
}

/**
 * Get the earliest price within the last 24 hours for a coin
 */
async function get24HourPriceChange(coinId) {
  try {
    const now = new Date();
    const twentyFourHoursAgo = new Date(now - 24 * 60 * 60 * 1000);
    console.log('Fetching prices for coin:', coinId, {
      now: now.toISOString(),
      twentyFourHoursAgo: twentyFourHoursAgo.toISOString()
    });

    // First get the current price
    const currentPriceResult = await db.query(`
      SELECT price, created_at
      FROM price_history
      WHERE coin_id = $1
      ORDER BY created_at DESC
      LIMIT 1
    `, [coinId]);

    console.log('Current price result:', currentPriceResult.rows[0]);

    if (currentPriceResult.rows.length === 0) {
      console.log('No current price found');
      return null;
    }
    const currentPrice = parseFloat(currentPriceResult.rows[0].price);

    // Then get the price from ~24 hours ago
    const oldPriceResult = await db.query(`
      SELECT price, created_at
      FROM price_history
      WHERE coin_id = $1
      AND created_at <= $2
      ORDER BY created_at DESC
      LIMIT 1
    `, [coinId, twentyFourHoursAgo.toISOString()]);

    console.log('Old price result:', oldPriceResult.rows[0]);

    // If no old price found, try to get the earliest price
    if (oldPriceResult.rows.length === 0) {
      console.log('No 24h old price found, getting earliest price');
      const earliestPriceResult = await db.query(`
        SELECT price, created_at
        FROM price_history
        WHERE coin_id = $1
        ORDER BY created_at ASC
        LIMIT 1
      `, [coinId]);

      if (earliestPriceResult.rows.length === 0) {
        console.log('No earliest price found');
        return null;
      }
      console.log('Using earliest price:', earliestPriceResult.rows[0]);
      const oldPrice = parseFloat(earliestPriceResult.rows[0].price);
      return calculatePriceChange(oldPrice, currentPrice);
    }

    const oldPrice = parseFloat(oldPriceResult.rows[0].price);
    return calculatePriceChange(oldPrice, currentPrice);
  } catch (error) {
    console.error('Error calculating 24h price change:', error);
    return null;
  }
}

/**
 * Select all coins from the database
 * Fixed N+1 query problem by using a single query with CTEs
 */
exports.selectAllCoins = async () => {
  const result = await db.query(`
    WITH latest_prices AS (
      SELECT DISTINCT ON (coin_id)
        coin_id,
        price AS current_price,
        created_at
      FROM price_history
      ORDER BY coin_id, created_at DESC
    ),
    old_prices_24h AS (
      SELECT DISTINCT ON (coin_id)
        coin_id,
        price AS old_price
      FROM price_history
      WHERE created_at <= NOW() - INTERVAL '24 hours'
      ORDER BY coin_id, created_at DESC
    ),
    earliest_prices AS (
      SELECT DISTINCT ON (coin_id)
        coin_id,
        price AS earliest_price
      FROM price_history
      ORDER BY coin_id, created_at ASC
    )
    SELECT 
      c.coin_id,
      c.name,
      c.symbol,
      c.current_price,
      c.market_cap,
      c.circulating_supply,
      c.price_change_24h,
      c.founder,
      CASE 
        WHEN lp.current_price IS NULL OR (op.old_price IS NULL AND ep.earliest_price IS NULL) THEN NULL
        ELSE ROUND(((lp.current_price - COALESCE(op.old_price, ep.earliest_price)) / 
                    NULLIF(COALESCE(op.old_price, ep.earliest_price), 0) * 100)::numeric, 2)
      END AS calculated_price_change_24h
    FROM coins c
    LEFT JOIN latest_prices lp ON c.coin_id = lp.coin_id
    LEFT JOIN old_prices_24h op ON c.coin_id = op.coin_id
    LEFT JOIN earliest_prices ep ON c.coin_id = ep.coin_id
    ORDER BY c.coin_id ASC;
  `);

  // Use the calculated price change and format response
  return result.rows.map(coin => {
    // Convert calculated_price_change_24h from string to number or null
    const priceChange = coin.calculated_price_change_24h === null ? null : Number(coin.calculated_price_change_24h);
    console.log(`Price change for coin ${coin.coin_id}:`, priceChange);
    return formatCoinResponse({
      ...coin,
      price_change_24h: priceChange
    });
  });
};

/**
 * Select a single coin by ID
 */
exports.selectCoinById = async (coinId) => {
  const result = await db.query(`
    SELECT ${COIN_FIELDS}
    FROM coins 
    WHERE coin_id = $1::integer;
  `, [coinId]);

  if (result.rows.length === 0) {
    return null;
  }

  const coin = result.rows[0];
  const priceChange = await get24HourPriceChange(coin.coin_id);
  
  return formatCoinResponse({
    ...coin,
    price_change_24h: priceChange
  });
};

/**
 * Update a coin's price and record the change in price history
 * @param {number} coinId - The ID of the coin to update
 * @param {number} numericPrice - The new price value
 * @returns {Promise<Object|null>} The updated coin object or null if not found
 * @throws {Error} If there's a database error
 */
exports.updateCoinPrice = async (coinId, numericPrice) => {
  try {
    console.log('DEBUG: Starting updateCoinPrice transaction with:', {
      coinId,
      numericPrice,
      type: typeof numericPrice
    });

    // Start transaction
    await db.query('BEGIN');

    // First check if coin exists and get current price
    console.log('DEBUG: Checking if coin exists');
    const currentResult = await db.query(`
      SELECT current_price 
      FROM coins 
      WHERE coin_id = $1::integer
    `, [coinId]);

    if (currentResult.rows.length === 0) {
      console.log('DEBUG: Coin not found:', coinId);
      await db.query('ROLLBACK');
      return null;
    }

    console.log('DEBUG: Found existing coin:', currentResult.rows[0]);

    const oldPrice = parseFloat(currentResult.rows[0].current_price);
    // Calculate price change as a number, not string
    const priceChange = calculatePriceChange(oldPrice, numericPrice);

    console.log('DEBUG: Calculated values:', {
      oldPrice,
      numericPrice,
      priceChange
    });

    // Update the coin with new price and calculated change
    console.log('DEBUG: Executing UPDATE query');
    const result = await db.query(`
      UPDATE coins 
      SET 
        current_price = CAST($1 AS numeric),
        price_change_24h = CAST($2 AS numeric)
      WHERE coin_id = CAST($3 AS integer)
      RETURNING ${COIN_FIELDS};
    `, [numericPrice, priceChange, coinId]);

    if (result.rows.length === 0) {
      console.error('DEBUG: Failed to update coin - no rows affected');
      await db.query('ROLLBACK');
      throw new Error('Failed to update coin price - database update failed');
    }

    console.log('DEBUG: Successfully updated coin:', result.rows[0]);

    // Log price history
    console.log('DEBUG: Recording price history');
    await db.query(`
      INSERT INTO price_history (coin_id, price, created_at)
      VALUES (CAST($1 AS integer), CAST($2 AS numeric), CURRENT_TIMESTAMP);
    `, [coinId, numericPrice]);

    await db.query('COMMIT');
    console.log('DEBUG: Transaction committed successfully');

    return formatCoinResponse(result.rows[0]);

  } catch (err) {
    console.error('DEBUG: Error in updateCoinPrice:', {
      message: err.message,
      stack: err.stack,
      code: err.code,
      detail: err.detail,
      coinId,
      numericPrice
    });
    await db.query('ROLLBACK');
    throw err;
  }
};

/**
 * Get a coin's price history
 */
exports.getCoinPriceHistory = async (coinId, page = 1, limit = 10, timeRange = '30M') => {
  console.log('DEBUG: Getting price history for:', { coinId, page, limit, timeRange });
  
  try {
    const offset = (page - 1) * limit;
    const timeRangeMs = TIME_RANGES[timeRange] || TIME_RANGES['30M'];
    console.log('DEBUG: Calculated offset:', offset, 'timeRangeMs:', timeRangeMs);

    // First check if the price_history table exists
    const tableCheck = await db.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'price_history'
      );
    `);
    console.log('DEBUG: Price history table exists:', tableCheck.rows[0].exists);

    if (!tableCheck.rows[0].exists) {
      throw new Error('Price history table does not exist');
    }

    // Build the time filter condition
    const timeFilter = timeRangeMs ? `AND ph.created_at >= NOW() - INTERVAL '${timeRangeMs / 1000} seconds'` : '';

    const [countResult, dataResult] = await Promise.all([
      db.query(`
        SELECT COUNT(*) 
        FROM price_history ph
        WHERE coin_id = $1::integer
        ${timeFilter}
      `, [coinId]),
      db.query(`
        SELECT 
          ph.price_history_id,
          ph.coin_id,
          ph.price,
          ph.created_at,
          c.name,
          c.symbol
        FROM price_history ph
        JOIN coins c ON ph.coin_id = c.coin_id
        WHERE ph.coin_id = $1::integer
        ${timeFilter}
        ORDER BY ph.created_at DESC
        LIMIT $2 OFFSET $3;
      `, [coinId, limit, offset])
    ]);

    console.log('DEBUG: Query results:', {
      countRows: countResult.rows,
      dataRows: dataResult.rows
    });

    const totalItems = parseInt(countResult.rows[0].count);
    const totalPages = Math.ceil(totalItems / limit);

    // If no price history exists, return empty data with pagination
    if (totalItems === 0) {
      return {
        data: [],
        pagination: {
          currentPage: page,
          totalPages: 0,
          totalItems: 0,
          hasMore: false
        }
      };
    }

    return {
      data: dataResult.rows.map(item => ({
        ...item,
        price: CurrencyFormatter.formatGBP(item.price)
      })),
      pagination: {
        currentPage: page,
        totalPages,
        totalItems,
        hasMore: page < totalPages
      }
    };
  } catch (error) {
    console.error('DEBUG: Error in getCoinPriceHistory:', error);
    throw error; // Re-throw to be handled by controller
  }
};

/**
 * Get price history v2 - Returns aggregated OHLC data from rollups or raw data
 * Phase 2 & 3 implementation
 * @param {Object} params - Query parameters
 * @param {number} params.coinId - Coin ID
 * @param {string} params.interval - Time interval: 'raw', '1m', '5m', '15m', '1h'
 * @param {number} params.minutes - How many minutes of data to retrieve (1-10080)
 * @param {string} params.format - Response format: 'ohlc' or 'line'
 * @returns {Object} Chart-ready price history data
 */
exports.getPriceHistoryV2 = async ({ coinId, interval, minutes, format }) => {
  try {
    let query, params;

    if (interval === 'raw') {
      // Query raw ticks for high-resolution real-time data
      query = `
        SELECT 
          created_at AS t, 
          price AS c
        FROM price_history
        WHERE coin_id = $1 
          AND created_at >= NOW() - INTERVAL '${minutes} minutes'
        ORDER BY created_at ASC
      `;
      params = [coinId];
    } else {
      // Query pre-computed rollups for aggregated candles
      query = `
        SELECT 
          bucket_start AS t, 
          open AS o, 
          high AS h, 
          low AS l, 
          close AS c, 
          tick_count AS n
        FROM price_history_rollups
        WHERE coin_id = $1 
          AND interval_type = $2
          AND bucket_start >= NOW() - INTERVAL '${minutes} minutes'
        ORDER BY bucket_start ASC
      `;
      params = [coinId, interval];
    }

    const result = await db.query(query, params);

    // Get coin metadata (only once, not repeated per row)
    const coin = await this.selectCoinById(coinId);

    // Format response based on requested format
    if (format === 'line') {
      // Simplified line format: [[timestamp, close_price], ...]
      return {
        coin_id: coin.coin_id,
        symbol: coin.symbol,
        interval,
        data: result.rows.map(row => [row.t, parseFloat(row.c)])
      };
    }

    // Default OHLC format: [{t, o, h, l, c, n}, ...]
    return {
      coin_id: coin.coin_id,
      symbol: coin.symbol,
      interval,
      data: result.rows.map(row => ({
        t: row.t,
        o: parseFloat(row.o || row.c), // For raw data, use close as open
        h: parseFloat(row.h || row.c), // For raw data, use close as high
        l: parseFloat(row.l || row.c), // For raw data, use close as low
        c: parseFloat(row.c),
        n: parseInt(row.n || 1) // For raw data, tick count is 1
      }))
    };
  } catch (error) {
    console.error('Error in getPriceHistoryV2:', error);
    throw error;
  }
};
