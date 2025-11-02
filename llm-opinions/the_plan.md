# Simplified Price History Implementation Plan

**Created:** November 2, 2025  
**Context:** Crypto simulator for teaching "buy the dip" - fast-paced, short sessions, limited VPS storage. the sim sims prices of coins which widly fluctuate in a much shorter time then in real life.

---

## Executive Summary

This plan provides **pragmatic improvements** to the price history system tailored for a fast-paced educational crypto simulator. Unlike enterprise time-series solutions, this focuses on:

- ✅ 7-day data retention (not years)
- ✅ Visual trends over minutes/hours (not months/years)
- ✅ Simple rollups for 4 intervals: 1m, 5m, 15m, 1h
- ✅ Chart-ready API responses
- ✅ Minimal storage (<5 MB total)
- ✅ No enterprise complexity (no TimescaleDB, no partitioning)

**Total implementation effort:** 10-14 hours  
**Storage impact:** ~3.5 MB (up from ~350 KB)  
**Performance impact:** 5× faster chart data delivery

---

## Current Problems

1. **24-hour data deletion** - Users can't review yesterday's sessions
2. **N+1 query antipattern** - `selectAllCoins()` makes 1+(N×3) queries
3. **No aggregated candles** - Frontend must compute OHLC client-side
4. **Currency formatting in DB** - Returns `"£92.10"` strings instead of numbers
5. **Pagination overhead** - Multiple requests needed for simple charts
6. **Redundant metadata** - Coin name/symbol repeated in every row

---

## Phase 1: Critical Fixes (1-2 hours)

### 1.1 Extend Cleanup to 7 Days
**File:** `db/migrations/003_create_price_history.sql`

```sql
CREATE OR REPLACE FUNCTION cleanup_price_history() RETURNS void AS $$
BEGIN
    DELETE FROM price_history WHERE created_at < NOW() - INTERVAL '7 days';
END;
$$ LANGUAGE plpgsql;
```

**Why:** Allows users to review sessions from past week without hoarding years of data.

### 1.2 Standardize Timestamp Column
```sql
-- Ensure column is created_at (not recorded_at)
ALTER TABLE price_history 
    RENAME COLUMN recorded_at TO created_at;

-- Change to TIMESTAMPTZ for UTC consistency
ALTER TABLE price_history 
    ALTER COLUMN created_at TYPE TIMESTAMPTZ 
    USING created_at AT TIME ZONE 'UTC';
```

### 1.3 Add Covering Index
```sql
CREATE INDEX CONCURRENTLY idx_price_history_covering 
ON price_history(coin_id, created_at DESC) INCLUDE (price);
```

**Impact:** Eliminates heap lookups, ~3-5× faster queries.

### 1.4 Fix N+1 Query Pattern
**File:** `models/coins.model.js`

Replace `selectAllCoins()` with single query:

```sql
WITH latest_prices AS (
  SELECT DISTINCT ON (coin_id)
    coin_id,
    price AS current_price,
    created_at
  FROM price_history
  ORDER BY coin_id, created_at DESC
),
old_prices AS (
  SELECT DISTINCT ON (coin_id)
    coin_id,
    price AS old_price
  FROM price_history
  WHERE created_at <= NOW() - INTERVAL '24 hours'
  ORDER BY coin_id, created_at DESC
)
SELECT 
  c.*,
  COALESCE(
    ROUND(((lp.current_price - op.old_price) / NULLIF(op.old_price, 0) * 100)::numeric, 2),
    0
  ) AS price_change_24h
FROM coins c
LEFT JOIN latest_prices lp ON c.coin_id = lp.coin_id
LEFT JOIN old_prices op ON c.coin_id = op.coin_id
ORDER BY c.coin_id ASC;
```

**Impact:** Reduces 31 queries to 1 query for 10 coins.

---

## Phase 2: Simple Rollups (4-6 hours)

### 2.1 Create Rollup Table
**New migration:** `db/migrations/004_create_price_rollups.sql`

```sql
CREATE TABLE price_history_rollups (
    coin_id INT NOT NULL REFERENCES coins(coin_id) ON DELETE CASCADE,
    interval_type VARCHAR(10) NOT NULL CHECK (interval_type IN ('1m', '5m', '15m', '1h')),
    bucket_start TIMESTAMPTZ NOT NULL,
    open NUMERIC(12, 4) NOT NULL,
    high NUMERIC(12, 4) NOT NULL,
    low NUMERIC(12, 4) NOT NULL,
    close NUMERIC(12, 4) NOT NULL,
    tick_count INT NOT NULL,
    PRIMARY KEY (coin_id, interval_type, bucket_start)
);

CREATE INDEX idx_rollups_coin_interval 
ON price_history_rollups(coin_id, interval_type, bucket_start DESC);
```

**Storage impact:** ~360 KB for 24 hours of rollups (negligible).

### 2.2 Compute 1-Minute Rollups
```sql
CREATE OR REPLACE FUNCTION compute_1m_rollups() RETURNS void AS $$
BEGIN
    INSERT INTO price_history_rollups (coin_id, interval_type, bucket_start, open, high, low, close, tick_count)
    SELECT 
        coin_id,
        '1m',
        DATE_TRUNC('minute', created_at) AS bucket_start,
        (ARRAY_AGG(price ORDER BY created_at ASC))[1] AS open,
        MAX(price) AS high,
        MIN(price) AS low,
        (ARRAY_AGG(price ORDER BY created_at DESC))[1] AS close,
        COUNT(*) AS tick_count
    FROM price_history
    WHERE created_at >= DATE_TRUNC('minute', NOW()) - INTERVAL '2 minutes'
      AND created_at < DATE_TRUNC('minute', NOW())
    GROUP BY coin_id, bucket_start
    ON CONFLICT (coin_id, interval_type, bucket_start) DO NOTHING;
END;
$$ LANGUAGE plpgsql;

-- Run every minute
SELECT cron.schedule('*/1 * * * *', 'SELECT compute_1m_rollups()');
```

### 2.3 Compute 5-Minute Rollups
```sql
CREATE OR REPLACE FUNCTION compute_5m_rollups() RETURNS void AS $$
BEGIN
    INSERT INTO price_history_rollups (coin_id, interval_type, bucket_start, open, high, low, close, tick_count)
    SELECT 
        coin_id,
        '5m',
        DATE_TRUNC('hour', bucket_start) + 
            (EXTRACT(MINUTE FROM bucket_start)::int / 5) * INTERVAL '5 minutes' AS bucket_start,
        (ARRAY_AGG(open ORDER BY bucket_start ASC))[1] AS open,
        MAX(high) AS high,
        MIN(low) AS low,
        (ARRAY_AGG(close ORDER BY bucket_start DESC))[1] AS close,
        SUM(tick_count) AS tick_count
    FROM price_history_rollups
    WHERE interval_type = '1m'
      AND bucket_start >= NOW() - INTERVAL '10 minutes'
      AND bucket_start < DATE_TRUNC('hour', NOW()) + 
          (EXTRACT(MINUTE FROM NOW())::int / 5) * INTERVAL '5 minutes'
    GROUP BY coin_id, 
             DATE_TRUNC('hour', bucket_start) + 
             (EXTRACT(MINUTE FROM bucket_start)::int / 5) * INTERVAL '5 minutes'
    ON CONFLICT (coin_id, interval_type, bucket_start) DO NOTHING;
END;
$$ LANGUAGE plpgsql;

-- Run every 5 minutes
SELECT cron.schedule('*/5 * * * *', 'SELECT compute_5m_rollups()');
```

### 2.4 Compute 15-Minute and Hourly Rollups
Similar pattern as 5m, computing from 1m data:

```sql
-- 15-minute rollups (run every 15 minutes)
CREATE OR REPLACE FUNCTION compute_15m_rollups() RETURNS void AS $$
BEGIN
    -- Group 1m data into 15-minute buckets
    -- Similar structure to 5m function
    ...
END;
$$ LANGUAGE plpgsql;

SELECT cron.schedule('*/15 * * * *', 'SELECT compute_15m_rollups()');

-- Hourly rollups (run every hour at :05)
CREATE OR REPLACE FUNCTION compute_1h_rollups() RETURNS void AS $$
BEGIN
    -- Group 1m data into hourly buckets
    ...
END;
$$ LANGUAGE plpgsql;

SELECT cron.schedule('5 * * * *', 'SELECT compute_1h_rollups()');
```

### 2.5 Update Cleanup Function
```sql
CREATE OR REPLACE FUNCTION cleanup_old_data() RETURNS void AS $$
BEGIN
    -- Keep raw ticks for 7 days
    DELETE FROM price_history 
    WHERE created_at < NOW() - INTERVAL '7 days';
    
    -- Keep rollups for 24 hours only (charts use recent data)
    DELETE FROM price_history_rollups 
    WHERE bucket_start < NOW() - INTERVAL '24 hours';
END;
$$ LANGUAGE plpgsql;

-- Run daily at 3 AM
SELECT cron.schedule('0 3 * * *', 'SELECT cleanup_old_data()');
```

---

## Phase 3: Improved API (4-6 hours)

### 3.1 New Controller
**File:** `controllers/coins.controller.js`

```javascript
exports.getPriceHistoryV2 = async (req, res, next) => {
  try {
    const { coin_id } = req.params;
    const { 
      interval = '5m',      // 1m, 5m, 15m, 1h, raw
      minutes = 60,         // How far back
      format = 'ohlc'       // ohlc or line
    } = req.query;

    // Validate interval
    const validIntervals = ['raw', '1m', '5m', '15m', '1h'];
    if (!validIntervals.includes(interval)) {
      return res.status(400).json({ 
        error: 'Invalid interval. Must be one of: raw, 1m, 5m, 15m, 1h' 
      });
    }

    // Validate format
    const validFormats = ['ohlc', 'line'];
    if (!validFormats.includes(format)) {
      return res.status(400).json({ 
        error: 'Invalid format. Must be: ohlc or line' 
      });
    }

    // Validate minutes (max 7 days = 10080 minutes)
    const minutesNum = parseInt(minutes);
    if (isNaN(minutesNum) || minutesNum < 1 || minutesNum > 10080) {
      return res.status(400).json({ 
        error: 'Minutes must be between 1 and 10080 (7 days)' 
      });
    }

    // Check coin exists
    const coin = await coinsModel.selectCoinById(coin_id);
    if (!coin) {
      return res.status(404).json({ error: 'Coin not found' });
    }

    // Fetch data
    const result = await coinsModel.getPriceHistoryV2({
      coinId: coin_id,
      interval,
      minutes: minutesNum,
      format
    });

    // Cache headers (30s for recent data)
    res.set('Cache-Control', 'public, max-age=30');
    res.status(200).json(result);
    
  } catch (error) {
    console.error('Error in getPriceHistoryV2:', error);
    next(error);
  }
};
```

### 3.2 New Model Function
**File:** `models/coins.model.js`

```javascript
exports.getPriceHistoryV2 = async ({ coinId, interval, minutes, format }) => {
  let query, params;

  if (interval === 'raw') {
    // Query raw ticks
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
    // Query pre-computed rollups
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

  // Get coin metadata (only once)
  const coin = await this.selectCoinById(coinId);

  // Format response
  if (format === 'line') {
    // Simplified format: [timestamp, close_price]
    return {
      coin_id: coin.coin_id,
      symbol: coin.symbol,
      interval,
      data: result.rows.map(row => [row.t, parseFloat(row.c)])
    };
  }

  // OHLC format (default)
  return {
    coin_id: coin.coin_id,
    symbol: coin.symbol,
    interval,
    data: result.rows.map(row => ({
      t: row.t,
      o: parseFloat(row.o || row.c),
      h: parseFloat(row.h || row.c),
      l: parseFloat(row.l || row.c),
      c: parseFloat(row.c),
      n: parseInt(row.n || 1)
    }))
  };
};
```

### 3.3 Add Route
**File:** `routes/coins.routes.js`

```javascript
const { getPriceHistory, getPriceHistoryV2 } = require('../controllers/coins.controller');

// Keep old endpoint for backwards compatibility
coinsRouter.get('/:coin_id/price-history', getPriceHistory);

// New improved endpoint
coinsRouter.get('/:coin_id/price-history-v2', getPriceHistoryV2);
```

---

## Phase 4: Optional Enhancements

### 4.1 Redis Caching (If VPS resources tight)
**File:** `middleware/cache.js`

```javascript
const redis = require('redis');
const client = redis.createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379'
});

client.on('error', err => console.error('Redis error:', err));
client.connect();

const cacheMiddleware = (ttlSeconds = 30) => {
  return async (req, res, next) => {
    if (req.method !== 'GET') {
      return next();
    }

    const key = `cache:${req.originalUrl}`;

    try {
      const cached = await client.get(key);
      if (cached) {
        res.set('X-Cache', 'HIT');
        return res.status(200).json(JSON.parse(cached));
      }
    } catch (err) {
      console.error('Cache read error:', err);
    }

    // Override res.json to cache response
    const originalJson = res.json.bind(res);
    res.json = (data) => {
      res.set('X-Cache', 'MISS');
      client.setEx(key, ttlSeconds, JSON.stringify(data)).catch(err => {
        console.error('Cache write error:', err);
      });
      return originalJson(data);
    };

    next();
  };
};

module.exports = cacheMiddleware;
```

**Usage in routes:**
```javascript
const cacheMiddleware = require('../middleware/cache');

coinsRouter.get('/:coin_id/price-history-v2', 
  cacheMiddleware(30), 
  getPriceHistoryV2
);
```

### 4.2 Rate Limiting
```bash
npm install express-rate-limit
```

```javascript
const rateLimit = require('express-rate-limit');

const priceHistoryLimiter = rateLimit({
  windowMs: 60 * 1000,  // 1 minute
  max: 60,              // 60 requests per minute
  message: { error: 'Too many requests, please try again later' }
});

coinsRouter.get('/:coin_id/price-history-v2', 
  priceHistoryLimiter,
  getPriceHistoryV2
);
```

---

## Frontend Benefits

### Before (Current State)
```javascript
// ❌ Multiple paginated requests
const page1 = await fetch('/api/coins/4/price-history?page=1&limit=100');
const page2 = await fetch('/api/coins/4/price-history?page=2&limit=100');

// ❌ Strip currency formatting
const prices = data.map(item => parseFloat(item.price.replace('£', '')));

// ❌ Compute candles client-side (50+ lines)
const candles = computeOHLC(allData, 5); // 5-minute candles

// ❌ Transform for chart library
const chartData = candles.map(c => ({ x: c.time, y: [c.o, c.h, c.l, c.c] }));
```

### After (With Plan)
```javascript
// ✅ Single request, chart-ready data
const response = await fetch('/api/coins/4/price-history-v2?interval=5m&minutes=60');
const { data } = await response.json();

// ✅ Pass directly to chart
<CandlestickChart data={data} />
```

**Code reduction:** 80+ lines → 3 lines

### Real Example: 3-Chart Dashboard
```javascript
// Last 15 minutes (1-minute detail)
const realTime = await fetch('/api/coins/4/price-history-v2?interval=1m&minutes=15')
  .then(r => r.json());

// Last hour (5-minute overview)
const shortTerm = await fetch('/api/coins/4/price-history-v2?interval=5m&minutes=60')
  .then(r => r.json());

// Last 4 hours (15-minute trend)
const sessionView = await fetch('/api/coins/4/price-history-v2?interval=15m&minutes=240')
  .then(r => r.json());

// All three charts ready to render - zero processing!
```

---

## Storage Impact Analysis

### Current State (24-hour retention)
- Raw ticks: ~14,400 rows (2,880/coin × 5 coins)
- Storage: ~350 KB

### After Plan (7-day retention + rollups)
- Raw ticks: ~100,800 rows (20,160/coin × 5 coins) = **~3 MB**
- 1m rollups (24h): ~7,200 rows = **~180 KB**
- 5m rollups (24h): ~1,440 rows = **~36 KB**
- 15m rollups (24h): ~480 rows = **~12 KB**
- 1h rollups (24h): ~120 rows = **~3 KB**

**Total: ~3.2 MB** (negligible for modern VPS)

**Verdict:** Storage is NOT a constraint. 7-day retention is perfectly safe.

---

## Testing Strategy

### Unit Tests
**File:** `__tests__/price-history-v2.test.js`

```javascript
const request = require('supertest');
const app = require('../app');

describe('GET /api/coins/:coin_id/price-history-v2', () => {
  test('returns OHLC data for 1m interval', async () => {
    const res = await request(app)
      .get('/api/coins/1/price-history-v2?interval=1m&minutes=15')
      .expect(200);
    
    expect(res.body).toHaveProperty('data');
    expect(res.body.interval).toBe('1m');
    expect(res.body.data[0]).toHaveProperty('o');
    expect(res.body.data[0]).toHaveProperty('h');
    expect(res.body.data[0]).toHaveProperty('l');
    expect(res.body.data[0]).toHaveProperty('c');
  });

  test('returns line data format', async () => {
    const res = await request(app)
      .get('/api/coins/1/price-history-v2?interval=5m&minutes=60&format=line')
      .expect(200);
    
    expect(res.body.data).toBeInstanceOf(Array);
    expect(res.body.data[0]).toHaveLength(2); // [timestamp, price]
  });

  test('validates interval parameter', async () => {
    await request(app)
      .get('/api/coins/1/price-history-v2?interval=invalid')
      .expect(400);
  });

  test('validates minutes range', async () => {
    await request(app)
      .get('/api/coins/1/price-history-v2?minutes=999999')
      .expect(400);
  });

  test('returns 404 for non-existent coin', async () => {
    await request(app)
      .get('/api/coins/999999/price-history-v2')
      .expect(404);
  });

  test('includes cache headers', async () => {
    const res = await request(app)
      .get('/api/coins/1/price-history-v2')
      .expect(200);
    
    expect(res.headers['cache-control']).toBe('public, max-age=30');
  });
});

describe('Rollup functions', () => {
  test('compute_1m_rollups generates correct OHLC', async () => {
    // Insert test ticks
    await db.query(`
      INSERT INTO price_history (coin_id, price, created_at) VALUES
      (1, 100.0, NOW() - INTERVAL '90 seconds'),
      (1, 102.0, NOW() - INTERVAL '75 seconds'),
      (1, 99.0, NOW() - INTERVAL '60 seconds'),
      (1, 101.0, NOW() - INTERVAL '45 seconds')
    `);

    // Run rollup
    await db.query('SELECT compute_1m_rollups()');

    // Verify OHLC
    const result = await db.query(`
      SELECT * FROM price_history_rollups 
      WHERE coin_id = 1 AND interval_type = '1m'
      ORDER BY bucket_start DESC LIMIT 1
    `);

    expect(parseFloat(result.rows[0].open)).toBe(100.0);
    expect(parseFloat(result.rows[0].high)).toBe(102.0);
    expect(parseFloat(result.rows[0].low)).toBe(99.0);
    expect(parseFloat(result.rows[0].close)).toBe(101.0);
  });
});
```

### Manual Testing Checklist
1. ✅ Start market simulator
2. ✅ Wait 5 minutes for data to accumulate
3. ✅ Query: `GET /api/coins/1/price-history-v2?interval=1m&minutes=5`
4. ✅ Verify ~5 candles returned
5. ✅ Check OHLC values are reasonable
6. ✅ Query again after 30s to verify cache headers
7. ✅ Test with invalid params to verify validation
8. ✅ Check database for rollup rows: `SELECT * FROM price_history_rollups LIMIT 10`

---

## What We're NOT Doing (Deliberately)

These were in the original "enterprise-scale" recommendations but are overkill for your use case:

❌ **TimescaleDB extension** - Adds complexity, your dataset is tiny  
❌ **Table partitioning** - Unnecessary for <5 MB dataset  
❌ **Long-term retention tiers** - No need for 90d/1y/5y/forever splits  
❌ **4-hour and daily candles** - Sessions don't last that long  
❌ **Multi-source deduplication** - You have one price source (simulator)  
❌ **Complex dual-write migration** - Direct migration acceptable for simulator  
❌ **High-precision decimals** (38,12) - NUMERIC(12,4) is plenty  
❌ **Elaborate compression** - Not needed at this scale  

**Philosophy:** Keep it simple. Build for your actual needs, not hypothetical enterprise scale.

---

## Success Metrics

After implementation, you should see:

✅ **Users can view trends** for last 15min, 1hr, 4hrs  
✅ **Charts load fast** - p95 latency < 100ms  
✅ **Storage stays small** - < 10 MB for price history  
✅ **No data loss** - 7 days of session history available  
✅ **API is chart-ready** - Zero client-side aggregation needed  
✅ **Response sizes small** - ~3 KB vs 14 KB before  
✅ **Single-request charts** - No pagination loops  

---

## Implementation Checklist

### Phase 1: Critical Fixes
- [ ] Update `cleanup_price_history()` to 7 days
- [ ] Rename/fix timestamp column to `created_at TIMESTAMPTZ`
- [ ] Add covering index with `CONCURRENTLY`
- [ ] Refactor `selectAllCoins()` N+1 query
- [ ] Test: Verify data persists beyond 24 hours
- [ ] Test: Verify index is used (`EXPLAIN ANALYZE`)

### Phase 2: Rollups
- [ ] Create `price_history_rollups` table
- [ ] Write `compute_1m_rollups()` function
- [ ] Write `compute_5m_rollups()` function
- [ ] Write `compute_15m_rollups()` function
- [ ] Write `compute_1h_rollups()` function
- [ ] Schedule all cron jobs
- [ ] Update `cleanup_old_data()` function
- [ ] Test: Run simulator for 10 minutes, verify rollups populate
- [ ] Test: Check rollup accuracy against raw data

### Phase 3: API
- [ ] Implement `getPriceHistoryV2()` controller
- [ ] Implement `getPriceHistoryV2()` model function
- [ ] Add route to `coins.routes.js`
- [ ] Write unit tests
- [ ] Manual test: Query with different intervals
- [ ] Manual test: Verify response format matches spec
- [ ] Manual test: Check cache headers present

### Phase 4: Optional
- [ ] Add Redis caching middleware (if needed)
- [ ] Add rate limiting (if needed)
- [ ] Update frontend to use new endpoint
- [ ] Update API documentation

---

## Rollback Plan

If issues arise:

1. **Phase 1 rollback:** Drop covering index, revert cleanup function to 24h
2. **Phase 2 rollback:** Drop `price_history_rollups` table, unschedule cron jobs
3. **Phase 3 rollback:** Remove new route, keep old endpoint

**Safe points:**
- All changes are additive (no breaking changes to existing API)
- Old `/price-history` endpoint remains functional
- New `/price-history-v2` endpoint can be removed without impact

---

## Estimated Timeline

| Phase | Duration | Parallelizable? |
|-------|----------|-----------------|
| Phase 1: Critical Fixes | 1-2 hours | No |
| Phase 2: Rollups | 4-6 hours | Partially |
| Phase 3: API | 4-6 hours | Yes (can start once Phase 1 done) |
| Phase 4: Optional | 2-4 hours | Yes |
| Testing | 2-3 hours | After each phase |

**Total: 10-14 hours** (single developer, including testing)

**Recommended approach:** 
- Day 1: Phase 1 → deploy to production (low risk)
- Day 2: Phase 2 → test in staging
- Day 3: Phase 3 → deploy to production
- Day 4: Optional enhancements if needed

---

## Questions or Concerns?

Common questions addressed:

**Q: Will this slow down price updates?**  
A: No. Rollup computation runs asynchronously every minute, separate from price inserts.

**Q: What if cron jobs fail?**  
A: Rollups will have gaps, but raw data is still available. Charts can fall back to raw queries.

**Q: Can we change intervals later?**  
A: Yes. Just add new rollup functions (e.g., 2m, 10m) and backfill from existing 1m data.

**Q: What if we need more than 7 days?**  
A: Change cleanup interval. Storage grows linearly (~0.5 MB/day), so 30 days = ~15 MB (still tiny).

**Q: Redis required?**  
A: No, it's optional. Your dataset is small enough that PostgreSQL can handle all queries directly.

---

**END OF PLAN**

