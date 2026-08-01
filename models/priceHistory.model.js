const db = require('../db/connection');

// Supported ranges per Kimi design (page/limit ignored on v1)
const TIME_RANGES_MS = {
  '10M': 10 * 60 * 1000,
  '30M': 30 * 60 * 1000,
  '1H': 60 * 60 * 1000,
  '2H': 2 * 60 * 60 * 1000,
  '24H': 24 * 60 * 60 * 1000,
  '7D': 7 * 24 * 60 * 60 * 1000,
  '30D': 30 * 24 * 60 * 60 * 1000
  // ALL is adaptive, handled specially (no fixed lookback)
};

const RANGE_CONFIG = {
  '10M': { resolution: 'raw', bucketSeconds: 0, maxPoints: 20 },
  '30M': { resolution: '1m', bucketSeconds: 60, maxPoints: 30 },
  '1H': { resolution: '1m', bucketSeconds: 60, maxPoints: 60 },
  '2H': { resolution: '5m', bucketSeconds: 300, maxPoints: 24 },
  '24H': { resolution: '15m', bucketSeconds: 900, maxPoints: 96 },
  '7D': { resolution: '1h', bucketSeconds: 3600, maxPoints: 168 },
  '30D': { resolution: '6h', bucketSeconds: 21600, maxPoints: 120 }
  // ALL resolution and bucket determined at runtime per §2.2
};

const MAX_POINTS_BUDGET = 200;

/**
 * Get price history using query-time bucketing on raw table.
 * Returns the new one-request contract with numeric values, chronological order,
 * active bucket semantics and latestValue from coins.
 */
exports.getPriceHistory = async (coinId, range) => {
  const isAll = range === 'ALL';
  if (!isAll && !TIME_RANGES_MS[range]) {
    const err = new Error('Invalid range');
    err.status = 400;
    throw err;
  }

  const now = new Date();
  const serverTime = now.toISOString();
  let rows;
  let resolution;
  let bucketSeconds;
  let from;

  if (isAll) {
    // §2.2 ALL adaptive bucketing (exact)
    const oldestRes = await db.query(
      'SELECT MIN(created_at) AS oldest FROM price_history WHERE coin_id = $1',
      [coinId]
    );
    const oldest = oldestRes.rows[0] ? oldestRes.rows[0].oldest : null;

    if (oldest === null) {
      // empty history → 200 + points:[] , resolution raw, from=to=serverTime
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
      return {
        range: {
          requested: range,
          from: serverTime,
          to: serverTime
        },
        resolution: 'raw',
        serverTime,
        latestValue: Number(coinRow.current_price),
        coin: {
          coin_id: coinId,
          symbol: coinRow.symbol
        },
        points: []
      };
    }

    const oldestDate = new Date(oldest);
    const spanMs = now.getTime() - oldestDate.getTime();
    from = oldestDate;

    if (spanMs <= 2 * 24 * 60 * 60 * 1000) {
      bucketSeconds = 900; // 15m
      resolution = '15m';
    } else if (spanMs <= 7 * 24 * 60 * 60 * 1000) {
      bucketSeconds = 3600; // 1h
      resolution = '1h';
    } else if (spanMs <= 31 * 24 * 60 * 60 * 1000) {
      bucketSeconds = 21600; // 6h
      resolution = '6h';
    } else {
      bucketSeconds = 43200; // 12h
      resolution = '12h';
    }

    // Bound bucket count before SQL so long retention cannot materialize unbounded groups.
    // Grow bucket size until estimated buckets fit the chart budget (max 200).
    const maxBucketSeconds = 7 * 24 * 3600; // 7d buckets as hard ceiling
    let estimatedBuckets = Math.ceil(spanMs / (bucketSeconds * 1000)) + 1;
    while (estimatedBuckets > MAX_POINTS_BUDGET && bucketSeconds < maxBucketSeconds) {
      bucketSeconds = Math.min(bucketSeconds * 2, maxBucketSeconds);
      estimatedBuckets = Math.ceil(spanMs / (bucketSeconds * 1000)) + 1;
    }
    if (bucketSeconds >= 86400) {
      resolution = bucketSeconds >= 7 * 86400 ? '7d' : `${Math.round(bucketSeconds / 86400)}d`;
    } else if (bucketSeconds >= 3600) {
      resolution = `${Math.round(bucketSeconds / 3600)}h`;
    } else if (bucketSeconds >= 60) {
      resolution = `${Math.round(bucketSeconds / 60)}m`;
    }

    // Query-time bucketing with an in-SQL newest-N cap (never return > MAX_POINTS_BUDGET rows).
    const result = await db.query(
      `WITH buckets AS (
        SELECT
          to_timestamp(floor(extract(epoch from created_at) / $3) * $3) AS time,
          (ARRAY_AGG(price ORDER BY created_at ASC))[1] AS open,
          MAX(price) AS high,
          MIN(price) AS low,
          (ARRAY_AGG(price ORDER BY created_at DESC))[1] AS close,
          COUNT(*)::int AS samples
        FROM price_history
        WHERE coin_id = $1
          AND created_at >= $2
        GROUP BY floor(extract(epoch from created_at) / $3)
      ),
      newest AS (
        SELECT * FROM buckets
        ORDER BY time DESC
        LIMIT $4
      )
      SELECT * FROM newest
      ORDER BY time ASC`,
      [coinId, oldest, bucketSeconds, MAX_POINTS_BUDGET]
    );
    rows = result.rows;
  } else {
    const rangeMs = TIME_RANGES_MS[range];
    const config = RANGE_CONFIG[range];
    resolution = config.resolution;
    bucketSeconds = config.bucketSeconds;
    from = new Date(now.getTime() - rangeMs);
    const lookbackMs = rangeMs;

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
  // ALL is already bounded in SQL; still enforce the global budget by trimming newest.
  if (!isAll) {
    const config = RANGE_CONFIG[range];
    if (points.length > config.maxPoints) {
      points.splice(0, points.length - config.maxPoints);
    }
  }

  if (points.length > MAX_POINTS_BUDGET) {
    points.splice(0, points.length - MAX_POINTS_BUDGET);
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

  return {
    range: {
      requested: range,
      from: from instanceof Date ? from.toISOString() : from,
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
