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
 * Select a single coin by ID without display formatting.
 * Transactional paths (buy/sell) must use this: formatCoinResponse
 * renders current_price as a GBP display string (e.g. '£10,140.30'),
 * which is not valid input for numeric SQL parameters.
 */
exports.selectCoinRawById = async (coinId) => {
  const result = await db.query(`
    SELECT ${COIN_FIELDS}
    FROM coins
    WHERE coin_id = $1::integer;
  `, [coinId]);

  if (result.rows.length === 0) {
    return null;
  }

  return result.rows[0];
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
 * Uses single pooled client for atomicity (BEGIN/COMMIT on same connection).
 */
exports.updateCoinPrice = async (coinId, numericPrice) => {
  let client;
  try {
    client = await db.getClient();
    await client.query('BEGIN');

    // First check if coin exists and get current price
    const currentResult = await client.query(
      `SELECT current_price
       FROM coins
       WHERE coin_id = $1::integer`,
      [coinId]
    );

    if (currentResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return null;
    }

    const oldPrice = parseFloat(currentResult.rows[0].current_price);
    const priceChange = calculatePriceChange(oldPrice, numericPrice);

    // Update the coin with new price and calculated change
    const result = await client.query(
      `UPDATE coins
       SET
         current_price = CAST($1 AS numeric),
         price_change_24h = CAST($2 AS numeric)
       WHERE coin_id = CAST($3 AS integer)
       RETURNING ${COIN_FIELDS}`,
      [numericPrice, priceChange, coinId]
    );

    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      throw new Error('Failed to update coin price - database update failed');
    }

    // Record price history (atomic with coin update)
    await client.query(
      `INSERT INTO price_history (coin_id, price, created_at)
       VALUES (CAST($1 AS integer), CAST($2 AS numeric), CURRENT_TIMESTAMP)`,
      [coinId, numericPrice]
    );

    await client.query('COMMIT');

    return formatCoinResponse(result.rows[0]);
  } catch (err) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch (_) {}
    }
    throw err;
  } finally {
    if (client) {
      client.release();
    }
  }
};
