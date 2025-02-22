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

/**
 * Format coin data for response
 */
function formatCoinResponse(coin) {
  return {
    ...coin,
    current_price: CurrencyFormatter.formatGBP(coin.current_price),
    market_cap: CurrencyFormatter.formatGBP(coin.market_cap)
  };
}

/**
 * Calculate price change percentage
 */
function calculatePriceChange(oldPrice, newPrice) {
  if (!oldPrice || oldPrice === 0) return 0;
  return Number(((newPrice - oldPrice) / oldPrice * 100).toFixed(2));
}

/**
 * Select all coins from the database
 */
exports.selectAllCoins = async () => {
  const result = await db.query(`
    SELECT ${COIN_FIELDS} FROM coins 
    ORDER BY coin_id ASC;
  `);
  return result.rows.map(formatCoinResponse);
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

  return formatCoinResponse(result.rows[0]);
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
exports.getCoinPriceHistory = async (coinId, page = 1, limit = 10) => {
  console.log('DEBUG: Getting price history for:', { coinId, page, limit });
  
  try {
    const offset = (page - 1) * limit;
    console.log('DEBUG: Calculated offset:', offset);

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

    const [countResult, dataResult] = await Promise.all([
      db.query('SELECT COUNT(*) FROM price_history WHERE coin_id = $1::integer', [coinId]),
      db.query(`
        SELECT 
          ph.history_id as price_history_id,
          ph.coin_id,
          ph.price,
          ph.created_at as timestamp,
          c.name,
          c.symbol
        FROM price_history ph
        JOIN coins c ON ph.coin_id = c.coin_id
        WHERE ph.coin_id = $1::integer
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
