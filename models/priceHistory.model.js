const db = require('../db/connection');

// Supported ranges per Kimi design (page/limit ignored on v1)
const TIME_RANGES_MS = {
  '10M': 10 * 60 * 1000,
  '30M': 30 * 60 * 1000,
  '1H': 60 * 60 * 1000,
  '2H': 2 * 60 * 60 * 1000,
  '24H': 24 * 60 * 60 * 1000
};

const RANGE_CONFIG = {
  '10M': { resolution: 'raw', bucketSeconds: 0, maxPoints: 20 },
  '30M': { resolution: '1m', bucketSeconds: 60, maxPoints: 30 },
  '1H': { resolution: '1m', bucketSeconds: 60, maxPoints: 60 },
  '2H': { resolution: '5m', bucketSeconds: 300, maxPoints: 24 },
  '24H': { resolution: '15m', bucketSeconds: 900, maxPoints: 96 }
};

const MAX_POINTS_BUDGET = 200;

/**
 * Get price history using query-time bucketing on raw table.
 * Returns the new one-request contract with numeric values, chronological order,
 * active bucket semantics and latestValue from coins.
 */
exports.getPriceHistory = async (coinId, range) => {
  if (!TIME_RANGES_MS[range]) {
    const err = new Error('Invalid range');
    err.status = 400;
    throw err;
  }

  const rangeMs = TIME_RANGES_MS[range];
  const config = RANGE_CONFIG[range];
  const { resolution, bucketSeconds } = config;

  const now = new Date();
  const from = new Date(now.getTime() - rangeMs);
  const lookbackMs = rangeMs;

  let rows;
  if (bucketSeconds === 0) {
    // Raw resolution for 10M: each tick is a point
    const result = await db.query(
      `SELECT
        created_at AS time,
        price AS open,
        price AS high,
        price AS low,
        price AS close,
        1::int AS samples
      FROM price_history
      WHERE coin_id = $1
        AND created_at >= NOW() - ($2 || ' milliseconds')::INTERVAL
      ORDER BY created_at ASC`,
      [coinId, lookbackMs]
    );
    rows = result.rows;
  } else {
    // Bucketed query-time aggregation
    const result = await db.query(
      `SELECT
        to_timestamp(floor(extract(epoch from created_at) / $3) * $3) AS time,
        (ARRAY_AGG(price ORDER BY created_at ASC))[1] AS open,
        MAX(price) AS high,
        MIN(price) AS low,
        (ARRAY_AGG(price ORDER BY created_at DESC))[1] AS close,
        COUNT(*)::int AS samples
      FROM price_history
      WHERE coin_id = $1
        AND created_at >= NOW() - ($2 || ' milliseconds')::INTERVAL
      GROUP BY floor(extract(epoch from created_at) / $3)
      ORDER BY time ASC`,
      [coinId, lookbackMs, bucketSeconds]
    );
    rows = result.rows;
  }

  // Map to numeric contract, chronological (query already orders ASC)
  const points = rows.map(row => {
    const timeStr = row.time instanceof Date ? row.time.toISOString() : new Date(row.time).toISOString();
    return {
      time: timeStr,
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      samples: Number(row.samples),
      complete: true // default; override for an active bucket below
    };
  });

  // A trailing window can touch one extra boundary bucket. Keep the newest
  // configured number of points so every response stays within its chart budget.
  if (points.length > config.maxPoints) {
    points.splice(0, points.length - config.maxPoints);
  }

  if (points.length > MAX_POINTS_BUDGET) {
    const err = new Error('Range would exceed 200 points; reduce range');
    err.status = 400;
    throw err;
  }

  // Calculate bucket completeness:
  // - Raw points: always true
  // - Bucketed: true when their bucket has ended relative to captured server `now`;
  //   only the bucket that is actually the current open bucket is false.
  if (bucketSeconds > 0 && points.length > 0) {
    const nowMs = now.getTime();
    const currentBucketStartSec = Math.floor(nowMs / 1000 / bucketSeconds) * bucketSeconds;
    for (const p of points) {
      const ptMs = new Date(p.time).getTime();
      const ptBucketStartSec = Math.floor(ptMs / 1000 / bucketSeconds) * bucketSeconds;
      p.complete = (ptBucketStartSec < currentBucketStartSec);
    }
  }

  // Fetch coin metadata and latestValue (always numeric)
  const coinResult = await db.query(
    'SELECT symbol, current_price FROM coins WHERE coin_id = $1',
    [coinId]
  );

  if (coinResult.rows.length === 0) {
    const err = new Error('Coin not found');
    err.status = 404;
    throw err;
  }

  const coinRow = coinResult.rows[0];
  const latestValue = Number(coinRow.current_price);
  const symbol = coinRow.symbol;

  const serverTime = now.toISOString();

  return {
    range: {
      requested: range,
      from: from.toISOString(),
      to: serverTime
    },
    resolution,
    serverTime,
    latestValue,
    coin: {
      coin_id: coinId,
      symbol
    },
    points
  };
};
