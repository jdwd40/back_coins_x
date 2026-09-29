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
  'founder',
  'retired'
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

// Persistent provenance: only world-scoped writer ticks.
const PERSISTENT_PH = "source = 'MARKET_TICK' AND cycle_id IS NULL";

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
        AND ${PERSISTENT_PH}
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
        AND ${PERSISTENT_PH}
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
          AND ${PERSISTENT_PH}
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

// GET /api/coins: one statement, O(live coins) index lookups.
//
// Each live coin gets three LIMIT 1 lookups (latest persistent price, the
// persistent price at/before 24h ago, and — only when there is no 24h-old
// price — the coin's earliest persistent price). The previous CTE form ran
// DISTINCT ON over every persistent price_history row three times (full
// scans + on-disk sorts), which grew with table age and took 3-45s in
// production, saturating the pool under frontend polling.
//
// Result semantics are identical to the old query: the CASE only reads
// earliest_price when old_price IS NULL, so gating that lookup on
// `op.old_price IS NULL` cannot change the output. `created_at + INTERVAL
// '0 seconds'` in the earliest lookup deliberately stops the planner from
// walking idx_price_history_created_at from the oldest row of the whole
// table (it would filter ~1M foreign rows per coin); it instead reads only
// that coin's rows by coin_id and picks the earliest.
const SELECT_ALL_COINS_SQL = `
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
    LEFT JOIN LATERAL (
      SELECT p.price AS current_price
      FROM price_history p
      WHERE p.coin_id = c.coin_id
        AND ${PERSISTENT_PH}
      ORDER BY p.created_at DESC
      LIMIT 1
    ) lp ON true
    LEFT JOIN LATERAL (
      SELECT p.price AS old_price
      FROM price_history p
      WHERE p.coin_id = c.coin_id
        AND p.created_at <= NOW() - INTERVAL '24 hours'
        AND ${PERSISTENT_PH}
      ORDER BY p.created_at DESC
      LIMIT 1
    ) op ON true
    LEFT JOIN LATERAL (
      SELECT p.price AS earliest_price
      FROM price_history p
      WHERE op.old_price IS NULL
        AND p.coin_id = c.coin_id
        AND ${PERSISTENT_PH}
      ORDER BY p.created_at + INTERVAL '0 seconds' ASC
      LIMIT 1
    ) ep ON true
    WHERE c.retired = FALSE
    ORDER BY c.coin_id ASC;
  `;
exports.SELECT_ALL_COINS_SQL = SELECT_ALL_COINS_SQL;

/**
 * Select all live (non-retired) coins with their 24h price change.
 */
exports.selectAllCoins = async () => {
  // The planner's (pessimistic) cost estimate for the never-executed gated
  // lookup crosses jit_above_cost, so PostgreSQL would spend ~0.6-0.8s
  // JIT-compiling a sub-millisecond query. Disable JIT for this one
  // statement only (SET LOCAL is scoped to this transaction).
  const client = await db.getClient();
  let result;
  let releaseError;
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL jit = off');
    result = await client.query(SELECT_ALL_COINS_SQL);
    await client.query('COMMIT');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      // Connection is unusable: have the pool discard it, not reuse it.
      releaseError = rollbackErr;
    }
    throw err;
  } finally {
    client.release(releaseError);
  }

  // Use the calculated price change and format response
  return result.rows.map(coin => {
    // Convert calculated_price_change_24h from string to number or null
    const priceChange = coin.calculated_price_change_24h === null ? null : Number(coin.calculated_price_change_24h);
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

// Milestone 1: updateCoinPrice is removed with the PATCH price route. Coin
// prices are written only by the market simulator and the game collapse
// lifecycle (both server-owned); no model-level public entry point remains.
