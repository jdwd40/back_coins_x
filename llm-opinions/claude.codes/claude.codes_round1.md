# Price History System Analysis & Redesign Recommendations
**Claude.codes Round 1 Analysis**

---

# Executive Summary

- **Current system stores 24h of data only** - pg_cron job deletes rows older than 24h, severely limiting historical analysis and charting
- **No time-series optimizations** - standard table with SERIAL PK, DECIMAL(18,2) prices, TIMESTAMP w/o timezone, basic BTREE index
- **Unbounded queries possible** - `getCoinPriceHistory` paginates but lacks hard limit caps; no caching strategy
- **Mixed timestamp formats** - DB uses `TIMESTAMP` (no TZ), API responses mix ISO strings and epoch ms; inconsistent for charting libraries
- **Inefficient aggregations** - Every `selectAllCoins()` call triggers N+1 pattern: 1 query for coins + 1 per coin for 24h price change calculation
- **No rollups/downsampling** - Raw ticks only; frontend must handle aggregation for 1h/1d candles; wasteful bandwidth
- **Schema mismatch** - Migration 003 has `price_history` table with `price_history_id`, `recorded_at`; test migration 001 uses `PriceHistory` with `history_id`, `recorded_at`; docs say `created_at`
- **Market simulator writes every 30s** - ~2880 inserts/day per coin × 5 coins = 14,400 rows/day; all deleted after 24h; retention policy wastes compute
- **High-impact wins**: (1) remove/reconfigure 24h deletion; (2) add TimescaleDB hypertables + compression; (3) precompute 1m/1h/1d rollups; (4) cache 24h stats; (5) standardize timestamps to `timestamptz` + UTC ISO

---

# Current State (as implemented)

## Route handlers

**Routes** (`routes/coins.routes.js:14`):
```javascript
coinsRouter.get('/:coin_id/price-history', getPriceHistory);
```

**Controller** (`controllers/coins.controller.js:164-207`):
```javascript
const getPriceHistory = async (req, res, next) => {
  const { coin_id } = req.params;
  const { page = 1, limit = 10, range = '30M' } = req.query;
  // Validates: coin_id, page, limit (1-100), range (10M|30M|1H|2H|12H|24H|ALL)
  const priceHistory = await coinsModel.getCoinPriceHistory(numericId, pageNum, limitNum, range);
  res.status(200).json(priceHistory);
};
```

**Model** (`models/coins.model.js:257-343`):
```javascript
exports.getCoinPriceHistory = async (coinId, page = 1, limit = 10, timeRange = '30M') => {
  const offset = (page - 1) * limit;
  const timeRangeMs = TIME_RANGES[timeRange] || TIME_RANGES['30M']; // e.g. 30*60*1000
  const timeFilter = timeRangeMs ? `AND ph.created_at >= NOW() - INTERVAL '${timeRangeMs / 1000} seconds'` : '';

  const [countResult, dataResult] = await Promise.all([
    db.query(`SELECT COUNT(*) FROM price_history ph WHERE coin_id = $1::integer ${timeFilter}`, [coinId]),
    db.query(`
      SELECT ph.price_history_id, ph.coin_id, ph.price, ph.created_at, c.name, c.symbol
      FROM price_history ph
      JOIN coins c ON ph.coin_id = c.coin_id
      WHERE ph.coin_id = $1::integer ${timeFilter}
      ORDER BY ph.created_at DESC
      LIMIT $2 OFFSET $3;
    `, [coinId, limit, offset])
  ]);

  return {
    data: dataResult.rows.map(item => ({ ...item, price: CurrencyFormatter.formatGBP(item.price) })),
    pagination: { currentPage: page, totalPages, totalItems, hasMore }
  };
};
```

**Market price history** (`routes/market.routes.js:16`, `controllers/market.controller.js:55-93`):
```javascript
// GET /api/market/price-history?timeRange=30M
const query = `
  SELECT total_value, market_trend, created_at, EXTRACT(EPOCH FROM created_at) * 1000 as timestamp
  FROM market_history
  ${timeFilter}
  ORDER BY created_at ASC
`;
res.json({ history: result.rows, timeRange, count });
```

## Query patterns & response shapes

**Example response** (`GET /api/coins/4/price-history?range=30M&limit=5`):
```json
{
  "data": [
    {
      "price_history_id": 1234,
      "coin_id": 4,
      "price": "£92.10",        // String, formatted GBP
      "created_at": "2025-11-02T10:30:00.000Z",  // ISO 8601 string
      "name": "NovaCash",
      "symbol": "NVC"
    }
  ],
  "pagination": {
    "currentPage": 1,
    "totalPages": 6,
    "totalItems": 30,
    "hasMore": true
  }
}
```

**Market history response** (`GET /api/market/price-history?timeRange=30M`):
```json
{
  "history": [
    {
      "total_value": "422.54",  // String from DECIMAL
      "market_trend": "STABLE",
      "created_at": "2025-02-23T12:00:00.000Z",
      "timestamp": 1740484800000  // Epoch ms
    }
  ],
  "timeRange": "30M",
  "count": 1
}
```

## Database schema

**Production migration** (`db/migrations/003_create_price_history.sql:8-18`):
```sql
CREATE TABLE price_history (
    price_history_id SERIAL PRIMARY KEY,
    coin_id INT REFERENCES coins(coin_id) ON DELETE CASCADE,
    price DECIMAL(18, 2) NOT NULL,
    recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_coin_timestamp UNIQUE (coin_id, recorded_at)
);

CREATE INDEX idx_price_history_coin_timestamp
ON price_history(coin_id, recorded_at DESC);
```

**Test migration** (`db/migrations/001_create_test_tables.sql:49-54,62`):
```sql
CREATE TABLE PriceHistory (
    history_id SERIAL PRIMARY KEY,   -- different PK name!
    coin_id INT REFERENCES Coins(coin_id) ON DELETE CASCADE,
    price DECIMAL(18, 2) NOT NULL,
    recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_price_history_recorded_at ON PriceHistory(recorded_at);
```

**Market history** (`db/migrations/20250223_create_market_history.sql:2-7`):
```sql
CREATE TABLE market_history (
    id SERIAL PRIMARY KEY,
    total_value DECIMAL(20, 2) NOT NULL,
    market_trend VARCHAR(20) NOT NULL CHECK (market_trend IN ('STRONG_BOOM', 'MILD_BOOM', 'STRONG_BUST', 'MILD_BUST', 'STABLE')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

**Indexes**:
- `price_history`: `idx_price_history_coin_timestamp` on `(coin_id, recorded_at DESC)` - supports time-range scans
- `PriceHistory` (test): `idx_price_history_coin_id`, `idx_price_history_recorded_at` - separate indexes, less efficient for combined queries

**Data types**:
- Price: `DECIMAL(18, 2)` - correct for money; supports 16 digits + 2 decimals (up to £9,999,999,999,999,999.99)
- Time: `TIMESTAMP` (no `WITH TIME ZONE`) - stores local time; ambiguous for distributed systems
- Constraint: `UNIQUE (coin_id, recorded_at)` - prevents duplicate ticks; breaks if concurrent inserts at same second

## Data volume assumptions

- **Current retention**: 24 hours only (`db/migrations/003_create_price_history.sql:21-26`)
- **Ingest rate**: market simulator writes every 30s (`models/market-simulator.js:41,286-294`)
  - 2 writes/min × 60 min × 24h = 2,880 ticks/day/coin
  - 5 coins × 2,880 = 14,400 rows/day total
  - Max table size: ~14,400 rows (steady-state after 24h)
- **Actual usage**: frontend can request `range=ALL` but only gets last 24h of data

## Data ingest/update flows

**Primary ingest**: MarketSimulator (`models/market-simulator.js`)

1. **Initialization** (`start()`, line 138-154):
   - Loads all coins, assigns volatility profiles, stores initial prices for mean reversion
   - Starts market cycle (2-10min duration, STRONG_BOOM/MILD_BOOM/STRONG_BUST/MILD_BUST/STABLE)
   - Starts price update interval (30s)

2. **Price updates** (`updateAllPrices()`, line 277-309):
   - Every 30s: fetch all coins, calculate new price based on volatility/market cycle/events/mean reversion
   - For each coin:
     ```javascript
     updates.push(db.query('UPDATE coins SET current_price = $1 WHERE coin_id = $2', [newPrice, coin.coin_id]));
     updates.push(db.query('INSERT INTO price_history (coin_id, price) VALUES ($1, $2)', [coin.coin_id, newPrice]));
     ```
   - Inserts into `market_history`: `INSERT INTO market_history (total_value, market_trend) VALUES (totalMarketValue, currentCycle.type)`
   - All updates run in parallel (`Promise.all(updates)`)

3. **Manual updates** (`controllers/coins.controller.js:42-161`, `updatePrice` endpoint):
   - `PATCH /api/coins/:coin_id/price` with `{ price: 150.00 }`
   - Validates price (0.01 - 1B range)
   - Calls `coinsModel.updateCoinPrice()` (line 172-252):
     - Starts transaction
     - Fetches current price, calculates 24h change
     - Updates `coins.current_price` and `coins.price_change_24h`
     - Inserts into `price_history`: `INSERT INTO price_history (coin_id, price, created_at) VALUES ($1, $2, CURRENT_TIMESTAMP)`
     - Commits transaction

**Deduping**:
- `UNIQUE (coin_id, recorded_at)` constraint prevents exact timestamp duplicates
- No explicit conflict handling (`ON CONFLICT DO NOTHING`) - inserts fail on collision
- MarketSimulator inserts 30s apart, unlikely to collide unless manual updates occur

**Cleanup job** (`db/migrations/003_create_price_history.sql:21-30`):
```sql
CREATE OR REPLACE FUNCTION cleanup_price_history() RETURNS void AS $$
BEGIN
    DELETE FROM price_history WHERE recorded_at < NOW() - INTERVAL '24 hours';
END;
$$ LANGUAGE plpgsql;

CREATE EXTENSION IF NOT EXISTS pg_cron;
SELECT cron.schedule('0 * * * *', 'SELECT cleanup_price_history()');  -- runs every hour
```

**Cron/jobs**:
- pg_cron extension schedules hourly deletion of >24h data
- No other batch jobs, backfills, or archival

---

# Problems & Risks

## Performance antipatterns

1. **N+1 query in `selectAllCoins()`** (`models/coins.model.js:121-140`):
   - Fetches all coins in 1 query
   - Then `Promise.all(coins.map(coin => get24HourPriceChange(coin.coin_id)))` - 1 query per coin for 24h change
   - For 5 coins: 1 + 5 = 6 queries; for 100 coins: 101 queries
   - `get24HourPriceChange()` (line 52-116) runs 2-3 queries per coin (current price, 24h ago price, earliest price)
   - Total: **1 + (2-3 × N)** queries for N coins
   - Fix: single query with window functions or JOIN to precomputed stats

2. **Unbounded COUNT(*) on paginated endpoints**:
   - `getCoinPriceHistory()` runs `SELECT COUNT(*) FROM price_history WHERE coin_id = $1` on every call
   - For large datasets (millions of rows), COUNT(*) is expensive (sequential scan if no covering index)
   - Current 24h retention mitigates this (max 2,880 rows/coin), but after removal, cost scales linearly

3. **Missing covering index for COUNT query**:
   - Index: `(coin_id, recorded_at DESC)` - BTREE
   - COUNT query: `SELECT COUNT(*) FROM price_history WHERE coin_id = $1 AND created_at >= NOW() - INTERVAL '...'`
   - Postgres can use index-only scan if `(coin_id, recorded_at)` covers query, but adding `timeFilter` may force index scan + heap lookups
   - For millions of rows, consider: (a) approximate counts (`pg_class.reltuples`), (b) materialized rollup counters, (c) BRIN for time column

4. **No query result caching**:
   - Every request hits DB, even for identical `coin_id + range + page + limit`
   - No ETags, Cache-Control headers, or Redis cache
   - High read:write ratio (30s writes, potentially 100s req/s reads) - ideal for caching

5. **String formatting in DB layer**:
   - `CurrencyFormatter.formatGBP(item.price)` returns `"£92.10"` - forces frontend to parse string for math
   - Better: return numeric, let frontend format; or provide both `price` (number) and `price_formatted` (string)

## Incorrect types/precision

1. **DECIMAL(18, 2) for volatile crypto prices**:
   - Current: 2 decimal places (£0.01 precision)
   - Problem: some coins trade at £0.00001 (Bitcoin satoshis, meme coins)
   - Example: Ripple £0.50 OK, but altcoin £0.0000123 rounds to £0.00
   - Fix: `DECIMAL(28, 10)` or `DECIMAL(18, 8)` for sub-penny precision

2. **TIMESTAMP instead of TIMESTAMPTZ**:
   - `TIMESTAMP` stores local time w/o timezone (ambiguous for DST, multi-region deploys)
   - Recommended: `TIMESTAMPTZ` (stores UTC internally, converts on retrieval)
   - Impact: if server TZ changes or client expects UTC, timestamps shift
   - Current code uses `NOW()` (returns timestamptz) cast to timestamp - loses TZ info

3. **SERIAL for PK in time-series table**:
   - Auto-increment integer - simple but not time-optimized
   - TimescaleDB best practice: partition by time, use `(coin_id, recorded_at)` as natural key
   - Current `price_history_id` SERIAL is redundant; `(coin_id, recorded_at)` already unique

## API contract issues for charting

1. **Irregular timestamps**:
   - MarketSimulator inserts every 30s, but no guarantee of exact intervals (variance from event loop, transaction latency)
   - Manual price updates insert at arbitrary times
   - Result: data points at 10:00:03, 10:00:35, 10:01:02 - not aligned to minute/hour boundaries
   - Charting libraries expect regular intervals (1m, 5m, 1h) or require client-side binning

2. **Server-side gaps**:
   - If simulator stopped/crashed, no data written for gap period
   - Frontend receives sparse data (10:00, 10:01, [missing], 10:05)
   - No backfill, no null-filling, no "last known value" interpolation
   - Charts show discontinuities or lines connecting across gaps

3. **Mixed granularities**:
   - Raw ticks at 30s intervals for last 24h
   - No 1m, 5m, 1h, 1d aggregates
   - Frontend requesting `range=24H` gets 2,880 points/coin - wasteful for overview chart
   - Industry standard: offer multiple resolutions (1m for last hour, 1h for last month, 1d for all-time)

4. **No OHLC data**:
   - Only single `price` per tick - no Open/High/Low/Close/Volume
   - Candlestick charts need OHLC; current schema requires client to build candles from raw ticks
   - For 1h candles from 30s ticks: client must fetch 120 points, compute O/H/L/C, then render - inefficient

5. **Pagination breaks time-series semantics**:
   - `page=1, limit=10` returns 10 most recent points
   - `page=2, limit=10` returns next 10 older points
   - Problem: if new data inserted between page requests, results shift (duplicate/missing points)
   - Time-series APIs should use cursor pagination (`?from=ISO&to=ISO`) or time windows

6. **Response bloat**:
   - Every price point includes `name`, `symbol`, `coin_id`, `price_history_id` - redundant
   - For 1000 points: 1000 × ("NovaCash", "NVC", 4) - 10KB+ wasted
   - Better: return metadata once + array of `[timestamp, price]` tuples

---

# Recommendations (Prioritized Roadmap)

## 1. Schema redesign for time-series

### Proposed `price_history` table

```sql
-- Drop old table (backup first!)
DROP TABLE IF EXISTS price_history CASCADE;

-- Create TimescaleDB hypertable (requires TimescaleDB extension)
CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE price_history (
    coin_id INTEGER NOT NULL REFERENCES coins(coin_id) ON DELETE CASCADE,
    ts TIMESTAMPTZ NOT NULL,  -- Use timestamptz for UTC
    price NUMERIC(28, 10) NOT NULL,  -- Higher precision for sub-penny coins
    volume NUMERIC(28, 10) DEFAULT 0,  -- For future: track volume per tick
    CONSTRAINT pk_price_history PRIMARY KEY (coin_id, ts)
);

-- Convert to hypertable (partition by time, chunk interval = 1 week)
SELECT create_hypertable('price_history', 'ts', chunk_time_interval => INTERVAL '7 days');

-- Add space partitioning by coin_id (optional, if coin count grows)
SELECT add_dimension('price_history', 'coin_id', number_partitions => 10);

-- Indexes (TimescaleDB auto-creates index on (ts DESC) for hypertable)
-- Composite index for coin-specific queries
CREATE INDEX idx_price_history_coin_ts ON price_history (coin_id, ts DESC);

-- Unique constraint to prevent duplicate ticks (TimescaleDB supports this)
-- Already enforced by PK (coin_id, ts)
```

### OHLC aggregates table

```sql
CREATE TABLE price_ohlc (
    coin_id INTEGER NOT NULL REFERENCES coins(coin_id) ON DELETE CASCADE,
    ts TIMESTAMPTZ NOT NULL,
    interval_type TEXT NOT NULL,  -- '1m', '5m', '15m', '1h', '4h', '1d'
    open NUMERIC(28, 10) NOT NULL,
    high NUMERIC(28, 10) NOT NULL,
    low NUMERIC(28, 10) NOT NULL,
    close NUMERIC(28, 10) NOT NULL,
    volume NUMERIC(28, 10) DEFAULT 0,
    tick_count INTEGER DEFAULT 0,  -- Number of ticks aggregated
    CONSTRAINT pk_price_ohlc PRIMARY KEY (coin_id, interval_type, ts)
);

-- Convert to hypertable
SELECT create_hypertable('price_ohlc', 'ts', chunk_time_interval => INTERVAL '30 days');

-- Indexes
CREATE INDEX idx_price_ohlc_coin_interval_ts ON price_ohlc (coin_id, interval_type, ts DESC);
```

### Continuous aggregates (TimescaleDB)

```sql
-- Continuous aggregate for 1-minute candles
CREATE MATERIALIZED VIEW price_ohlc_1m
WITH (timescaledb.continuous) AS
SELECT
    coin_id,
    time_bucket('1 minute', ts) AS ts,
    '1m' AS interval_type,
    FIRST(price, ts) AS open,
    MAX(price) AS high,
    MIN(price) AS low,
    LAST(price, ts) AS close,
    SUM(volume) AS volume,
    COUNT(*) AS tick_count
FROM price_history
GROUP BY coin_id, time_bucket('1 minute', ts);

-- Refresh policy: update every 1 minute, look back 2 hours
SELECT add_continuous_aggregate_policy('price_ohlc_1m',
    start_offset => INTERVAL '2 hours',
    end_offset => INTERVAL '1 minute',
    schedule_interval => INTERVAL '1 minute');

-- 1-hour candles (aggregate from 1m view for efficiency)
CREATE MATERIALIZED VIEW price_ohlc_1h
WITH (timescaledb.continuous) AS
SELECT
    coin_id,
    time_bucket('1 hour', ts) AS ts,
    '1h' AS interval_type,
    FIRST(open, ts) AS open,
    MAX(high) AS high,
    MIN(low) AS low,
    LAST(close, ts) AS close,
    SUM(volume) AS volume,
    SUM(tick_count) AS tick_count
FROM price_ohlc_1m
GROUP BY coin_id, time_bucket('1 hour', ts);

SELECT add_continuous_aggregate_policy('price_ohlc_1h',
    start_offset => INTERVAL '7 days',
    end_offset => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour');

-- 1-day candles
CREATE MATERIALIZED VIEW price_ohlc_1d
WITH (timescaledb.continuous) AS
SELECT
    coin_id,
    time_bucket('1 day', ts) AS ts,
    '1d' AS interval_type,
    FIRST(open, ts) AS open,
    MAX(high) AS high,
    MIN(low) AS low,
    LAST(close, ts) AS close,
    SUM(volume) AS volume,
    SUM(tick_count) AS tick_count
FROM price_ohlc_1h
GROUP BY coin_id, time_bucket('1 day', ts);

SELECT add_continuous_aggregate_policy('price_ohlc_1d',
    start_offset => INTERVAL '365 days',
    end_offset => INTERVAL '1 day',
    schedule_interval => INTERVAL '1 day');
```

### Retention & compression

```sql
-- Retention policy: keep raw ticks for 90 days, then drop
SELECT add_retention_policy('price_history', INTERVAL '90 days');

-- Compression: compress chunks older than 7 days
ALTER TABLE price_history SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'coin_id',
    timescaledb.compress_orderby = 'ts DESC'
);

SELECT add_compression_policy('price_history', INTERVAL '7 days');

-- Keep 1m candles for 1 year
SELECT add_retention_policy('price_ohlc_1m', INTERVAL '365 days');
-- Keep 1h candles for 5 years
SELECT add_retention_policy('price_ohlc_1h', INTERVAL '1825 days');
-- Keep 1d candles forever (no retention policy)

-- Compress OHLC aggregates after 30 days
ALTER TABLE price_ohlc_1m SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'coin_id',
    timescaledb.compress_orderby = 'ts DESC'
);
SELECT add_compression_policy('price_ohlc_1m', INTERVAL '30 days');

-- Same for 1h, 1d
ALTER TABLE price_ohlc_1h SET (timescaledb.compress, timescaledb.compress_segmentby = 'coin_id', timescaledb.compress_orderby = 'ts DESC');
SELECT add_compression_policy('price_ohlc_1h', INTERVAL '90 days');
```

---

## 2. Data modeling for charts

### Server-side aggregation strategy

**Principles**:
- Store raw ticks (30s intervals) in `price_history` for 90 days
- Precompute OHLC at 1m, 1h, 1d intervals via continuous aggregates
- Serve aggregates for large time ranges, raw ticks for zoom-in

**Interval selection logic** (API layer):
```javascript
function selectInterval(fromTs, toTs) {
    const durationMs = toTs - fromTs;
    const hour = 3600000, day = 86400000;

    if (durationMs <= hour) return { table: 'price_history', interval: 'raw' };  // <=1h: raw ticks
    if (durationMs <= 6 * hour) return { table: 'price_ohlc_1m', interval: '1m' };  // <=6h: 1m candles
    if (durationMs <= 7 * day) return { table: 'price_ohlc_1h', interval: '1h' };  // <=1w: 1h candles
    return { table: 'price_ohlc_1d', interval: '1d' };  // >1w: 1d candles
}
```

### Sample SQL for OHLC rollups (manual, if not using TimescaleDB)

```sql
-- 1-minute candles from raw ticks
SELECT
    coin_id,
    date_trunc('minute', ts) AS ts,
    (array_agg(price ORDER BY ts ASC))[1] AS open,
    MAX(price) AS high,
    MIN(price) AS low,
    (array_agg(price ORDER BY ts DESC))[1] AS close,
    SUM(volume) AS volume,
    COUNT(*) AS tick_count
FROM price_history
WHERE coin_id = $1 AND ts >= $2 AND ts < $3
GROUP BY coin_id, date_trunc('minute', ts)
ORDER BY ts ASC;

-- Alternative using window functions for FIRST/LAST
WITH ranked AS (
    SELECT
        coin_id,
        date_trunc('minute', ts) AS bucket,
        price,
        ROW_NUMBER() OVER (PARTITION BY coin_id, date_trunc('minute', ts) ORDER BY ts ASC) AS rn_asc,
        ROW_NUMBER() OVER (PARTITION BY coin_id, date_trunc('minute', ts) ORDER BY ts DESC) AS rn_desc
    FROM price_history
    WHERE coin_id = $1 AND ts >= $2 AND ts < $3
)
SELECT
    coin_id,
    bucket AS ts,
    MAX(CASE WHEN rn_asc = 1 THEN price END) AS open,
    MAX(price) AS high,
    MIN(price) AS low,
    MAX(CASE WHEN rn_desc = 1 THEN price END) AS close
FROM ranked
GROUP BY coin_id, bucket
ORDER BY bucket ASC;
```

---

## 3. API v2 for price history

### Endpoint: `GET /api/v2/coins/:coinId/price-history`

**Query parameters**:
- `from`: ISO 8601 timestamp (UTC), e.g., `2025-11-01T00:00:00Z`
- `to`: ISO 8601 timestamp (UTC), default = NOW()
- `interval`: `raw`, `1m`, `5m`, `15m`, `1h`, `4h`, `1d`, `auto` (default: `auto` = server picks best)
- `limit`: max points to return (default: 5000, max: 10000)
- `format`: `ohlc` | `line` (default: `ohlc` for intervals, `line` for raw)

**Example requests**:
```
GET /api/v2/coins/4/price-history?from=2025-11-01T00:00:00Z&to=2025-11-01T06:00:00Z&interval=1m&limit=360
GET /api/v2/coins/4/price-history?from=2025-10-01T00:00:00Z&interval=1d&format=ohlc
GET /api/v2/coins/4/price-history?from=2025-11-02T10:00:00Z&interval=raw&limit=100
```

### Response contract: OHLC candles

```json
{
  "coin_id": 4,
  "symbol": "NVC",
  "name": "NovaCash",
  "interval": "1m",
  "from": "2025-11-01T00:00:00.000Z",
  "to": "2025-11-01T06:00:00.000Z",
  "data": [
    {
      "t": "2025-11-01T00:00:00.000Z",  // ISO 8601 UTC
      "o": 92.10,
      "h": 92.45,
      "l": 91.80,
      "c": 92.30,
      "v": 1250.50,
      "n": 120  // tick count
    },
    {
      "t": "2025-11-01T00:01:00.000Z",
      "o": 92.30,
      "h": 92.60,
      "l": 92.20,
      "c": 92.55,
      "v": 980.25,
      "n": 118
    }
  ],
  "count": 2,
  "next_cursor": "2025-11-01T00:02:00.000Z"  // For pagination
}
```

### Response contract: Line series (raw ticks or simplified)

```json
{
  "coin_id": 4,
  "symbol": "NVC",
  "name": "NovaCash",
  "interval": "raw",
  "from": "2025-11-02T10:00:00.000Z",
  "to": "2025-11-02T10:30:00.000Z",
  "data": [
    [1730545200000, 92.10],  // [timestamp_ms, price]
    [1730545230000, 92.15],
    [1730545260000, 92.08]
  ],
  "count": 3,
  "next_cursor": 1730545290000
}
```

**Notes**:
- Numeric timestamps (epoch ms) for charting libraries (Recharts, Chart.js, TradingView)
- ISO timestamps available in OHLC format for human readability
- Metadata (`coin_id`, `symbol`, `name`) returned once, not per point
- `next_cursor` for pagination: client requests `?from={next_cursor}` for next page

### OpenAPI spec excerpt

```yaml
openapi: 3.0.3
info:
  title: Coins API v2
  version: 2.0.0
paths:
  /api/v2/coins/{coinId}/price-history:
    get:
      summary: Get price history for a coin
      parameters:
        - name: coinId
          in: path
          required: true
          schema:
            type: integer
        - name: from
          in: query
          schema:
            type: string
            format: date-time
          description: Start time (ISO 8601 UTC)
        - name: to
          in: query
          schema:
            type: string
            format: date-time
          description: End time (ISO 8601 UTC, default NOW)
        - name: interval
          in: query
          schema:
            type: string
            enum: [raw, 1m, 5m, 15m, 1h, 4h, 1d, auto]
            default: auto
        - name: limit
          in: query
          schema:
            type: integer
            minimum: 1
            maximum: 10000
            default: 5000
        - name: format
          in: query
          schema:
            type: string
            enum: [ohlc, line]
            default: ohlc
      responses:
        '200':
          description: Price history data
          content:
            application/json:
              schema:
                type: object
                properties:
                  coin_id:
                    type: integer
                  symbol:
                    type: string
                  name:
                    type: string
                  interval:
                    type: string
                  from:
                    type: string
                    format: date-time
                  to:
                    type: string
                    format: date-time
                  data:
                    type: array
                    oneOf:
                      - items:  # OHLC format
                          type: object
                          properties:
                            t:
                              type: string
                              format: date-time
                            o:
                              type: number
                            h:
                              type: number
                            l:
                              type: number
                            c:
                              type: number
                            v:
                              type: number
                            n:
                              type: integer
                      - items:  # Line format
                          type: array
                          items:
                            type: number
                          minItems: 2
                          maxItems: 2
                  count:
                    type: integer
                  next_cursor:
                    type: string
        '400':
          description: Invalid parameters
        '404':
          description: Coin not found
        '429':
          description: Rate limit exceeded
```

---

## 4. Performance & Caching

### Server-side downsampling

**Problem**: Returning 100k raw ticks for `range=30d` wastes bandwidth, client memory
**Solution**: Implement LTTB (Largest Triangle Three Buckets) downsampling algorithm

```javascript
function downsampleLTTB(data, threshold) {
    if (data.length <= threshold) return data;
    const sampled = [data[0]];  // Always include first point
    const bucketSize = (data.length - 2) / (threshold - 2);

    let a = 0;
    for (let i = 0; i < threshold - 2; i++) {
        const avgRangeStart = Math.floor((i + 1) * bucketSize) + 1;
        const avgRangeEnd = Math.floor((i + 2) * bucketSize) + 1;
        const avgRangeLength = avgRangeEnd - avgRangeStart;

        let avgX = 0, avgY = 0;
        for (let j = avgRangeStart; j < avgRangeEnd; j++) {
            avgX += data[j][0]; avgY += data[j][1];
        }
        avgX /= avgRangeLength; avgY /= avgRangeLength;

        const rangeStart = Math.floor(i * bucketSize) + 1;
        const rangeEnd = Math.floor((i + 1) * bucketSize) + 1;

        let maxArea = -1, maxAreaPoint;
        for (let j = rangeStart; j < rangeEnd; j++) {
            const area = Math.abs(
                (data[a][0] - avgX) * (data[j][1] - data[a][1]) -
                (data[a][0] - data[j][0]) * (avgY - data[a][1])
            ) * 0.5;
            if (area > maxArea) {
                maxArea = area;
                maxAreaPoint = data[j];
            }
        }
        sampled.push(maxAreaPoint);
        a = sampled.length - 1;
    }
    sampled.push(data[data.length - 1]);  // Always include last point
    return sampled;
}
```

**When to use**:
- Client requests >10k points: downsample to 5k before sending
- Alternative: let client specify `downsample=5000` query param

### Materialized views for hot queries

```sql
-- Precompute 24h stats per coin (updated every 5 minutes)
CREATE MATERIALIZED VIEW coin_stats_24h AS
SELECT
    c.coin_id,
    c.symbol,
    c.current_price,
    ph_24h_ago.price AS price_24h_ago,
    ((c.current_price - ph_24h_ago.price) / ph_24h_ago.price * 100) AS price_change_24h_pct,
    ph_stats.high_24h,
    ph_stats.low_24h,
    ph_stats.volume_24h
FROM coins c
LEFT JOIN LATERAL (
    SELECT price
    FROM price_history
    WHERE coin_id = c.coin_id AND ts <= NOW() - INTERVAL '24 hours'
    ORDER BY ts DESC LIMIT 1
) ph_24h_ago ON true
LEFT JOIN LATERAL (
    SELECT
        MAX(price) AS high_24h,
        MIN(price) AS low_24h,
        SUM(volume) AS volume_24h
    FROM price_history
    WHERE coin_id = c.coin_id AND ts >= NOW() - INTERVAL '24 hours'
) ph_stats ON true;

CREATE UNIQUE INDEX ON coin_stats_24h (coin_id);

-- Refresh every 5 minutes (pg_cron or cron job)
SELECT cron.schedule('*/5 * * * *', 'REFRESH MATERIALIZED VIEW CONCURRENTLY coin_stats_24h');
```

**Usage**: `selectAllCoins()` queries `coin_stats_24h` instead of running N+1 queries

### Redis caching strategy

**Cache keys**:
- `price_history:{coin_id}:{interval}:{from}:{to}` - TTL 60s (1m intervals), 300s (1h intervals), 3600s (1d intervals)
- `coin_stats:{coin_id}` - TTL 30s (for live prices)
- `market_history:{timeRange}` - TTL 60s

**Pseudocode**:
```javascript
async function getCoinPriceHistory(coinId, from, to, interval) {
    const cacheKey = `price_history:${coinId}:${interval}:${from}:${to}`;
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const data = await db.query(/* ... */);
    const ttl = interval === '1d' ? 3600 : interval === '1h' ? 300 : 60;
    await redis.setex(cacheKey, ttl, JSON.stringify(data));
    return data;
}
```

**Cache invalidation**:
- On new price write: invalidate `price_history:{coin_id}:raw:*` (only raw caches)
- Aggregates (1m, 1h, 1d) updated by continuous aggregate policies, no manual invalidation
- ETag support: hash response JSON, return `ETag: "abc123"`, client sends `If-None-Match: "abc123"` → 304 Not Modified

### Query budget & backpressure

**Target latencies** (p95):
- Raw ticks (<1h range, <1000 points): 50ms
- 1m candles (1h-6h range): 100ms
- 1h candles (7d range): 150ms
- 1d candles (all-time): 200ms

**Rate limits**:
- Per IP: 100 req/min for price history endpoints
- Per user (authenticated): 500 req/min
- Burst allowance: 20 req/s for 5s, then drop to 10 req/s

**Load shedding**:
- If DB connection pool saturated (>90% active conns): return 503 Service Unavailable
- If query timeout (>5s): cancel query, return 504 Gateway Timeout
- Implement circuit breaker: if 50% of requests fail for 30s, return cached stale data

---

## 5. Retention & Lifecycle

### Retention policy by interval

| Interval | Retention | Storage (5 coins) | Rationale |
|----------|-----------|-------------------|-----------|
| Raw ticks (30s) | 90 days | ~2,880 × 90 × 5 = 1.3M rows | Recent detail for zoom-in |
| 1m candles | 1 year | 1,440 × 365 × 5 = 2.6M rows | Intraday analysis |
| 1h candles | 5 years | 8,760 × 5 × 5 = 219k rows | Historical trends |
| 1d candles | Forever | 365 × 10 × 5 = 18k rows | Long-term charts |

**Compression savings**:
- Uncompressed: ~50 bytes/row (coin_id=4, ts=8, price=16, volume=16, PK overhead)
- Compressed (TimescaleDB): ~10 bytes/row (80% reduction typical for time-series)
- 1.3M raw rows: 65MB uncompressed → 13MB compressed
- 2.6M 1m rows: 130MB → 26MB
- Total: ~40MB for 5 coins over 5 years (highly efficient)

### Automatic backfills

**Scenario**: Simulator stopped for 2 hours, then restarted
**Current behavior**: No data for 2h gap
**Proposed**:
1. On simulator start, check last `price_history.ts` per coin
2. If gap >5min, insert synthetic ticks using last known price (forward-fill)
3. Mark synthetic rows: add `is_synthetic BOOLEAN DEFAULT false` column
4. Alternatively: leave gaps, rely on frontend to handle (less ideal)

**Implementation**:
```javascript
async function backfillGaps() {
    const coins = await db.query('SELECT coin_id FROM coins');
    for (const coin of coins.rows) {
        const lastTick = await db.query(
            'SELECT ts, price FROM price_history WHERE coin_id = $1 ORDER BY ts DESC LIMIT 1',
            [coin.coin_id]
        );
        if (!lastTick.rows[0]) continue;

        const lastTs = new Date(lastTick.rows[0].ts);
        const now = new Date();
        const gapMs = now - lastTs;

        if (gapMs > 5 * 60 * 1000) {  // >5min gap
            console.log(`Backfilling ${gapMs / 1000}s gap for coin ${coin.coin_id}`);
            for (let ts = lastTs.getTime() + 30000; ts < now.getTime(); ts += 30000) {
                await db.query(
                    'INSERT INTO price_history (coin_id, ts, price, is_synthetic) VALUES ($1, $2, $3, true) ON CONFLICT DO NOTHING',
                    [coin.coin_id, new Date(ts), lastTick.rows[0].price]
                );
            }
        }
    }
}
```

### Compaction jobs

**TimescaleDB auto-compresses** based on policies (see schema section)
**Manual compaction** (if not using TimescaleDB):
- Run `VACUUM FULL price_history` monthly to reclaim space
- Reindex `idx_price_history_coin_ts` quarterly

---

## 6. Reliability

### Idempotent writes

**Problem**: MarketSimulator inserts same tick twice if retry/crash
**Solution**: `ON CONFLICT (coin_id, ts) DO NOTHING` or `DO UPDATE SET price = EXCLUDED.price`

```javascript
await db.query(`
    INSERT INTO price_history (coin_id, ts, price, volume)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (coin_id, ts) DO UPDATE SET
        price = EXCLUDED.price,
        volume = EXCLUDED.volume
`, [coinId, ts, price, volume]);
```

**Alternative**: Generate deterministic timestamps (e.g., round to nearest 30s interval)
```javascript
function roundToInterval(date, intervalMs) {
    return new Date(Math.floor(date.getTime() / intervalMs) * intervalMs);
}
const ts = roundToInterval(new Date(), 30000);  // Round to 30s
```

### Unique constraints & deduping

**Current**: `UNIQUE (coin_id, recorded_at)` - fails on duplicate
**Improved**: `UNIQUE (coin_id, ts)` + `ON CONFLICT DO NOTHING` - silently skip duplicates
**Best**: Use deterministic timestamps + transaction isolation (SERIALIZABLE) to prevent concurrent duplicates

### Clock skew handling

**Problem**: Server clock drifts, inserts future timestamps
**Solution**:
- Use `NOW() AT TIME ZONE 'UTC'` instead of application-generated timestamps
- If using app timestamps: validate `ts <= NOW() + 5 seconds` (reject future timestamps)
- Log warnings if `ts` differs from `NOW()` by >10s

### Input validation

```javascript
function validatePriceHistoryInsert(coinId, ts, price, volume) {
    if (!Number.isInteger(coinId) || coinId <= 0) throw new Error('Invalid coin_id');
    if (!(ts instanceof Date) || ts > new Date()) throw new Error('Invalid timestamp');
    if (typeof price !== 'number' || price <= 0 || price > 1e18) throw new Error('Invalid price');
    if (typeof volume !== 'number' || volume < 0) throw new Error('Invalid volume');
}
```

### Dead-letter strategy for failed inserts

**Problem**: Insert fails (constraint violation, DB down) - data lost
**Solution**:
1. Wrap inserts in try-catch, log failed rows to dead-letter queue (DLQ)
2. DLQ options: Redis list, PostgreSQL `failed_price_inserts` table, or file log
3. Retry worker processes DLQ every 5 minutes

```javascript
async function insertPriceWithDLQ(coinId, ts, price, volume) {
    try {
        await db.query('INSERT INTO price_history ...');
    } catch (err) {
        await redis.lpush('dlq:price_history', JSON.stringify({ coinId, ts, price, volume, error: err.message }));
        logger.error('Failed to insert price, added to DLQ:', err);
    }
}
```

---

## 7. Security & Quotas

### Rate limits per IP/key

**Express middleware** (using `express-rate-limit` + Redis):
```javascript
const rateLimit = require('express-rate-limit');
const RedisStore = require('rate-limit-redis');

const priceHistoryLimiter = rateLimit({
    store: new RedisStore({ client: redis }),
    windowMs: 60 * 1000,  // 1 minute
    max: 100,  // 100 requests per minute per IP
    message: 'Too many requests, please try again later',
    headers: true,  // Send X-RateLimit-* headers
});

app.use('/api/v2/coins/:coinId/price-history', priceHistoryLimiter);
```

**Per-user limits** (authenticated):
```javascript
const authenticatedLimiter = rateLimit({
    store: new RedisStore({ client: redis }),
    windowMs: 60 * 1000,
    max: async (req) => req.user?.isPremium ? 1000 : 500,  // Premium users get higher limit
    keyGenerator: (req) => req.user?.id || req.ip,
});
```

### Auth for heavy endpoints

**Public** (no auth):
- `GET /api/coins` - list coins
- `GET /api/coins/:id` - coin details
- `GET /api/coins/:id/price-history?limit=100` - limited history

**Authenticated** (JWT required):
- `GET /api/coins/:id/price-history?limit=10000` - full history
- `GET /api/market/price-history?timeRange=ALL` - all-time market data
- `PATCH /api/coins/:id/price` - update price (admin only)

**Implementation**:
```javascript
const authMiddleware = require('./middleware/auth.middleware');
const adminMiddleware = (req, res, next) => {
    if (!req.user?.isAdmin) return res.status(403).json({ msg: 'Forbidden' });
    next();
};

app.get('/api/coins/:id/price-history',
    (req, res, next) => {
        if (parseInt(req.query.limit) > 1000) return authMiddleware(req, res, next);
        next();
    },
    getPriceHistory
);

app.patch('/api/coins/:id/price', authMiddleware, adminMiddleware, updatePrice);
```

### Realistic limit caps

**Current**: `limit` max = 100
**Proposed**:
- Public: max 1,000 points
- Authenticated: max 10,000 points
- Premium: max 100,000 points
- Enforce in controller: `const finalLimit = Math.min(limit, req.user?.maxLimit || 1000);`

**Response headers**:
```javascript
res.set('X-Result-Count', data.length);
res.set('X-Max-Limit', maxLimit);
res.set('X-Has-More', hasMore ? 'true' : 'false');
```

---

# Concrete Artifacts

## Proposed SQL

See **Recommendations > 1. Schema redesign** for full `CREATE TABLE`, `CREATE INDEX`, hypertable, continuous aggregate, and retention policy statements.

## Migration Plan

### Phase 1: Parallel write (2 weeks)

1. **Deploy new schema** (via migration `004_create_price_history_v2.sql`):
   - Create `price_history_v2` table (with `ts TIMESTAMPTZ`, `NUMERIC(28, 10)`, PK `(coin_id, ts)`)
   - Keep old `price_history` table active
2. **Update MarketSimulator** to dual-write:
   ```javascript
   await Promise.all([
       db.query('INSERT INTO price_history (coin_id, price) VALUES ($1, $2)', [coinId, price]),  // Old
       db.query('INSERT INTO price_history_v2 (coin_id, ts, price) VALUES ($1, NOW(), $2) ON CONFLICT DO NOTHING', [coinId, price])  // New
   ]);
   ```
3. **Backfill historical data** (if any exists beyond 24h):
   ```sql
   INSERT INTO price_history_v2 (coin_id, ts, price)
   SELECT coin_id, recorded_at AT TIME ZONE 'UTC', price
   FROM price_history
   ON CONFLICT DO NOTHING;
   ```
4. **Validate data parity**: Compare row counts, spot-check prices

### Phase 2: Dual-read (1 week)

1. **Update API** to read from `price_history_v2` for new requests, fallback to `price_history` if data missing
2. **Monitor errors**, compare response checksums between old/new tables
3. **Fix discrepancies** (e.g., timestamp conversion bugs)

### Phase 3: Cutover (1 day)

1. **Stop writing to old table** (remove dual-write)
2. **Update all read queries** to use `price_history_v2` only
3. **Deploy API v2 endpoints**
4. **Announce deprecation** of v1 endpoints (sunset date = +3 months)

### Phase 4: Cleanup (1 week after cutover)

1. **Drop old table**: `DROP TABLE price_history CASCADE;`
2. **Rename new table**: `ALTER TABLE price_history_v2 RENAME TO price_history;`
3. **Remove v1 API endpoints**
4. **Update documentation**

### Rollback plan

- If critical bugs in Phase 2/3: revert API code to read from old table, halt dual-write
- Keep old table for 30 days after cutover as backup
- Automated rollback trigger: if error rate >5% for 10 minutes, auto-revert to old table

---

## API Specs (OpenAPI excerpts)

See **Recommendations > 3. API v2** for full OpenAPI spec.

---

## Test Plan

### Unit tests for aggregation

```javascript
describe('OHLC aggregation', () => {
    test('should compute correct OHLC for 1m candle', async () => {
        const ticks = [
            { ts: '2025-11-01T00:00:05Z', price: 100 },
            { ts: '2025-11-01T00:00:15Z', price: 105 },
            { ts: '2025-11-01T00:00:30Z', price: 98 },
            { ts: '2025-11-01T00:00:45Z', price: 102 },
        ];
        await insertTicks(1, ticks);

        const candle = await getOHLC(1, '2025-11-01T00:00:00Z', '1m');
        expect(candle).toEqual({
            t: '2025-11-01T00:00:00.000Z',
            o: 100,
            h: 105,
            l: 98,
            c: 102,
            v: 0,
            n: 4
        });
    });

    test('should handle empty interval (no ticks)', async () => {
        const candle = await getOHLC(1, '2025-11-01T01:00:00Z', '1m');
        expect(candle).toBeNull();
    });

    test('should respect time boundaries (exclusive end)', async () => {
        await insertTicks(1, [
            { ts: '2025-11-01T00:00:59Z', price: 100 },
            { ts: '2025-11-01T00:01:00Z', price: 200 },  // Should not be in 00:00 bucket
        ]);
        const candle = await getOHLC(1, '2025-11-01T00:00:00Z', '1m');
        expect(candle.c).toBe(100);
        expect(candle.n).toBe(1);
    });
});
```

### Contract tests for responses

```javascript
describe('GET /api/v2/coins/:id/price-history', () => {
    test('should return OHLC format for 1h interval', async () => {
        const res = await request(app)
            .get('/api/v2/coins/1/price-history?from=2025-11-01T00:00:00Z&to=2025-11-01T06:00:00Z&interval=1h')
            .expect(200);

        expect(res.body).toMatchObject({
            coin_id: 1,
            symbol: expect.any(String),
            interval: '1h',
            from: '2025-11-01T00:00:00.000Z',
            to: expect.any(String),
            data: expect.arrayContaining([
                expect.objectContaining({
                    t: expect.any(String),
                    o: expect.any(Number),
                    h: expect.any(Number),
                    l: expect.any(Number),
                    c: expect.any(Number),
                    v: expect.any(Number),
                    n: expect.any(Number)
                })
            ]),
            count: expect.any(Number)
        });
    });

    test('should return line format for raw interval', async () => {
        const res = await request(app)
            .get('/api/v2/coins/1/price-history?interval=raw&limit=10')
            .expect(200);

        expect(res.body.data).toEqual(
            expect.arrayContaining([
                [expect.any(Number), expect.any(Number)]  // [ts_ms, price]
            ])
        );
    });

    test('should respect limit parameter', async () => {
        const res = await request(app)
            .get('/api/v2/coins/1/price-history?limit=5')
            .expect(200);
        expect(res.body.data.length).toBeLessThanOrEqual(5);
    });

    test('should return 400 for invalid time range', async () => {
        await request(app)
            .get('/api/v2/coins/1/price-history?from=invalid')
            .expect(400);
    });
});
```

### Fixture generators

```javascript
async function generatePriceHistory(coinId, startTs, endTs, intervalMs = 30000) {
    const ticks = [];
    let price = 100;
    for (let ts = startTs; ts < endTs; ts += intervalMs) {
        price += (Math.random() - 0.5) * 2;  // Random walk
        ticks.push({ coin_id: coinId, ts: new Date(ts), price });
    }
    await db.query('INSERT INTO price_history (coin_id, ts, price) SELECT * FROM unnest($1::price_history[])', [ticks]);
    return ticks;
}

// Usage in tests:
beforeEach(async () => {
    const now = Date.now();
    await generatePriceHistory(1, now - 86400000, now, 30000);  // 24h of 30s ticks
});
```

### Load tests (k6)

```javascript
import http from 'k6/http';
import { check, sleep } from 'k6';

export let options = {
    stages: [
        { duration: '2m', target: 50 },   // Ramp up to 50 users
        { duration: '5m', target: 50 },   // Stay at 50 users
        { duration: '2m', target: 100 },  // Ramp up to 100
        { duration: '5m', target: 100 },
        { duration: '2m', target: 0 },    // Ramp down
    ],
    thresholds: {
        http_req_duration: ['p(95)<200', 'p(99)<500'],  // 95% < 200ms, 99% < 500ms
        http_req_failed: ['rate<0.01'],  // <1% failures
    },
};

export default function () {
    const coinId = Math.floor(Math.random() * 5) + 1;
    const interval = ['1m', '1h', '1d'][Math.floor(Math.random() * 3)];
    const res = http.get(`http://localhost:3000/api/v2/coins/${coinId}/price-history?interval=${interval}&limit=1000`);

    check(res, {
        'status is 200': (r) => r.status === 200,
        'response time < 200ms': (r) => r.timings.duration < 200,
        'has data': (r) => JSON.parse(r.body).data.length > 0,
    });

    sleep(1);
}
```

**Run**: `k6 run load-test.js`

---

## Benchmark Plan

### Datasets

1. **Small**: 5 coins × 2,880 ticks/day × 7 days = 100,800 rows
2. **Medium**: 20 coins × 2,880 × 30 days = 1.7M rows
3. **Large**: 100 coins × 2,880 × 365 days = 105M rows

### Queries to benchmark

1. **Single coin, last 1h (raw)**:
   ```sql
   SELECT ts, price FROM price_history
   WHERE coin_id = 1 AND ts >= NOW() - INTERVAL '1 hour'
   ORDER BY ts DESC;
   ```
   Expected rows: 120; Target: <10ms

2. **Single coin, last 30d (1h candles)**:
   ```sql
   SELECT ts, open, high, low, close FROM price_ohlc_1h
   WHERE coin_id = 1 AND ts >= NOW() - INTERVAL '30 days'
   ORDER BY ts ASC;
   ```
   Expected rows: 720; Target: <50ms

3. **All coins, 24h stats** (replace N+1 pattern):
   ```sql
   SELECT * FROM coin_stats_24h;
   ```
   Expected rows: 100; Target: <20ms (vs. 200+ queries in old code)

4. **COUNT(*) on large dataset**:
   ```sql
   SELECT COUNT(*) FROM price_history WHERE coin_id = 1;
   ```
   Expected: 105k rows (1 year); Target: <30ms (index-only scan)

### Tools

- **pgbench**: Test raw SQL query performance
- **Artillery**: HTTP endpoint load testing
- **EXPLAIN ANALYZE**: Verify query plans use indexes

### Acceptance thresholds

| Query | Dataset | p50 | p95 | p99 |
|-------|---------|-----|-----|-----|
| 1h raw | Large | 5ms | 15ms | 30ms |
| 30d 1h OHLC | Large | 20ms | 50ms | 100ms |
| All coins 24h stats | Large | 10ms | 20ms | 40ms |
| COUNT(*) | Large | 10ms | 30ms | 60ms |

**Failure criteria**: If p95 exceeds 2× target, investigate (missing index, bad query plan, lock contention)

---

# Sample Responses (Ready for frontend)

## Line chart (1m interval, last 1 hour)

```json
{
  "coin_id": 4,
  "symbol": "NVC",
  "name": "NovaCash",
  "interval": "1m",
  "from": "2025-11-02T09:00:00.000Z",
  "to": "2025-11-02T10:00:00.000Z",
  "data": [
    [1730541600000, 92.10],
    [1730541660000, 92.15],
    [1730541720000, 92.08],
    [1730541780000, 92.22],
    [1730541840000, 92.18]
  ],
  "count": 60,
  "next_cursor": null
}
```

**Frontend usage** (Recharts):
```jsx
<LineChart data={response.data.map(([ts, price]) => ({ time: ts, price }))}>
  <XAxis dataKey="time" type="number" domain={['dataMin', 'dataMax']} tickFormatter={(ts) => new Date(ts).toLocaleTimeString()} />
  <YAxis domain={['dataMin - 0.5', 'dataMax + 0.5']} />
  <Line type="monotone" dataKey="price" stroke="#8884d8" dot={false} />
</LineChart>
```

## OHLC candles (1h interval, last 24 hours)

```json
{
  "coin_id": 4,
  "symbol": "NVC",
  "name": "NovaCash",
  "interval": "1h",
  "from": "2025-11-01T10:00:00.000Z",
  "to": "2025-11-02T10:00:00.000Z",
  "data": [
    {
      "t": "2025-11-01T10:00:00.000Z",
      "o": 91.50,
      "h": 92.80,
      "l": 91.20,
      "c": 92.10,
      "v": 12345.67,
      "n": 120
    },
    {
      "t": "2025-11-01T11:00:00.000Z",
      "o": 92.10,
      "h": 93.00,
      "l": 91.90,
      "c": 92.55,
      "v": 10234.50,
      "n": 118
    }
  ],
  "count": 24,
  "next_cursor": null
}
```

**Frontend usage** (TradingView Lightweight Charts):
```javascript
const candleSeries = chart.addCandlestickSeries();
candleSeries.setData(response.data.map(d => ({
    time: new Date(d.t).getTime() / 1000,  // Convert to Unix timestamp
    open: d.o,
    high: d.h,
    low: d.l,
    close: d.c
})));
```

## Paginated cursor example (1d candles, all-time)

**Request 1**: `GET /api/v2/coins/4/price-history?interval=1d&limit=100`

**Response 1**:
```json
{
  "coin_id": 4,
  "interval": "1d",
  "from": "2024-01-01T00:00:00.000Z",
  "to": "2025-11-02T00:00:00.000Z",
  "data": [
    { "t": "2024-01-01T00:00:00.000Z", "o": 88.00, "h": 90.00, "l": 87.50, "c": 89.50, "v": 50000, "n": 2880 },
    { "t": "2024-01-02T00:00:00.000Z", "o": 89.50, "h": 91.20, "l": 89.00, "c": 90.80, "v": 52000, "n": 2880 }
  ],
  "count": 100,
  "next_cursor": "2024-04-10T00:00:00.000Z"
}
```

**Request 2**: `GET /api/v2/coins/4/price-history?interval=1d&limit=100&from=2024-04-10T00:00:00.000Z`

**Response 2**:
```json
{
  "data": [ /* next 100 days */ ],
  "count": 100,
  "next_cursor": "2024-07-19T00:00:00.000Z"
}
```

---

# Risks, Trade-offs, and Alternatives

## Risks

1. **TimescaleDB dependency**: Adds operational complexity (extension install, upgrades, monitoring)
   - **Mitigation**: Document setup, use Docker image with preinstalled extension, fallback to manual rollups
2. **Storage growth**: 5 years of 1h candles for 100 coins = 4.4M rows (~220MB compressed)
   - **Mitigation**: Monitor disk usage, tune retention policies, archive to S3 (Parquet) after 1 year
3. **Continuous aggregate lag**: Real-time data may lag 1-5 minutes in materialized views
   - **Mitigation**: Combine real-time aggregation (last 1h) + cached aggregates (>1h ago)
4. **Migration downtime**: Backfilling historical data may lock table for minutes
   - **Mitigation**: Use `CREATE TABLE ... AS SELECT ... WITH NO DATA` + background INSERT, low-traffic window

## Trade-offs

| Approach | Pros | Cons |
|----------|------|------|
| **Raw ticks only** (current) | Simple schema, no precomputation | Wasteful bandwidth for large ranges, client must aggregate |
| **Precomputed OHLC** (recommended) | Fast queries, chart-ready data | Storage overhead (~3× raw for 1m/1h/1d), stale data if refresh lags |
| **On-demand aggregation** | No storage cost, always fresh | High CPU cost, slow for large ranges (1M rows → 1d candles = 10s query) |
| **Hybrid** (raw + rollups) | Best performance, flexible | Most complex, requires cache invalidation logic |

**Chosen**: Hybrid (raw 90d + 1m/1h/1d rollups) - balances performance, storage, complexity

## Alternatives

### DuckDB/Parquet sidecar for analytics

**Idea**: Keep Postgres for writes, export to Parquet daily, query with DuckDB for aggregations
**Pros**: Columnar storage (10× compression), blazing-fast OLAP queries
**Cons**: Dual storage, eventual consistency, complex ETL pipeline
**When to use**: If query volume exceeds 10k req/s or data exceeds 1TB

### Push aggregation to frontend

**Idea**: Return raw ticks, let React/Vue compute OHLC in browser
**Pros**: Zero server cost for aggregation, flexible intervals
**Cons**: Wastes bandwidth (100KB response for 1h chart), slow on mobile, battery drain
**When to use**: Only for small datasets (<1000 points)

### GraphQL with field-level caching

**Idea**: Expose price history via GraphQL, cache individual fields (open, high, low, close) separately
**Pros**: Fine-grained caching, flexible queries
**Cons**: Adds GraphQL complexity, over-fetching still possible, cache invalidation harder
**When to use**: If API has many complex, nested queries beyond price history

---

# Appendix

## Code snippets from current repo

**Price history query** (`models/coins.model.js:289-303`):
```javascript
db.query(`
  SELECT ph.price_history_id, ph.coin_id, ph.price, ph.created_at, c.name, c.symbol
  FROM price_history ph
  JOIN coins c ON ph.coin_id = c.coin_id
  WHERE ph.coin_id = $1::integer ${timeFilter}
  ORDER BY ph.created_at DESC
  LIMIT $2 OFFSET $3;
`, [coinId, limit, offset])
```

**24h price change calculation** (`models/coins.model.js:62-111`):
```javascript
// First get current price
const currentPriceResult = await db.query(`
  SELECT price, created_at FROM price_history
  WHERE coin_id = $1 ORDER BY created_at DESC LIMIT 1
`, [coinId]);

// Then get price from ~24h ago
const oldPriceResult = await db.query(`
  SELECT price, created_at FROM price_history
  WHERE coin_id = $1 AND created_at <= $2
  ORDER BY created_at DESC LIMIT 1
`, [coinId, twentyFourHoursAgo.toISOString()]);

return calculatePriceChange(oldPrice, currentPrice);
```

**Market simulator price update** (`models/market-simulator.js:286-294`):
```javascript
for (const coin of coins) {
  const newPrice = this.calculateNewPrice(parseFloat(coin.current_price), coin.coin_id);
  updates.push(db.query('UPDATE coins SET current_price = $1 WHERE coin_id = $2', [newPrice, coin.coin_id]));
  updates.push(db.query('INSERT INTO price_history (coin_id, price) VALUES ($1, $2)', [coin.coin_id, newPrice]));
}
await Promise.all(updates);
```

**Cleanup function** (`db/migrations/003_create_price_history.sql:21-26`):
```sql
CREATE OR REPLACE FUNCTION cleanup_price_history() RETURNS void AS $$
BEGIN
    DELETE FROM price_history WHERE recorded_at < NOW() - INTERVAL '24 hours';
END;
$$ LANGUAGE plpgsql;
```

## File paths inspected

- `db/migrations/003_create_price_history.sql` - prod schema
- `db/migrations/001_create_test_tables.sql` - test schema
- `db/migrations/20250223_create_market_history.sql` - market history table
- `models/coins.model.js` - price history queries, 24h change logic
- `models/market-simulator.js` - price update loop, market cycles
- `controllers/coins.controller.js` - getPriceHistory endpoint
- `controllers/market.controller.js` - getMarketPriceHistory endpoint
- `routes/coins.routes.js` - route definitions
- `routes/market.routes.js` - market route definitions
- `docs/database_schema.md` - schema documentation
- `API_DOCUMENTATION.md` - API contract docs
- `__tests__/price-history.test.js` - test suite

---

**End of Report**

---

# Conclusions Round 1

## What I Reviewed
- Peer reports found:
  - `llm-opinions/cursor/cursor_round1.md` (Cursor AI, 2641 lines)
  - `llm-opinions/codex/codex_round1.md` (Codex/OpenAI/GPT, 258 lines)
- Missing reports: None.

## Key Agreements & Disagreements (TL;DR)

### Agreements
- All peers identified **24h retention deletion as critical blocker** for historical charting
- Consensus on **TIMESTAMPTZ over TIMESTAMP** for timezone safety
- Agreement on **N+1 query antipattern** in `selectAllCoins()` (1+N×3 queries vs single query with JOINs/CTEs)
- All recommend **server-side OHLC aggregation** over client-side (Cursor: rollup tables, Codex: continuous aggregates, Mine: hybrid)
- Shared view that **`DECIMAL(18,2)` insufficient** for sub-penny crypto prices
- Agreement on **cursor/time-window pagination** over OFFSET for time-series
- Consensus: **Redis caching + HTTP headers** (Cache-Control, ETag) essential for hot queries
- All advocate **numeric JSON** (no GBP strings) with UTC ISO timestamps

### Disagreements
- **Partitioning strategy**: Cursor favors native Postgres LIST/RANGE partitions (lower ops complexity), I favor TimescaleDB hypertables (auto-chunking + compression), Codex neutral but leans TimescaleDB
  - *Rationale*: TimescaleDB offers 80% compression + continuous aggregates auto-refresh; native partitioning requires manual chunk mgmt but reduces extension lock-in
- **Decimal precision**: Cursor suggests `NUMERIC(12,4)`, Codex proposes `NUMERIC(38,12)`, I recommend `NUMERIC(28,10)`
  - *Rationale*: Codex's 38-digit overkill for prices; 28 digits sufficient for $1T market caps with 10-decimal precision; Cursor's 12 total digits risks overflow for meme coins
- **Aggregation intervals**: Cursor supports 5 intervals (raw, 1m, 5m, 1h, 1d), I support 6 (raw, 1m, 5m, 15m, 1h, 4h, 1d), Codex supports 6 (tick, 1m, 5m, 15m, 1h, 4h, 1d) but uses "tick" not "raw"
  - *Rationale*: 15m/4h fill gaps for intraday traders; naming "tick" more precise than "raw" but "raw" clearer for non-traders
- **Response format**: Cursor offers 3 formats (ohlc, line, compact), I offer 2 (ohlc, line), Codex offers 1 (inferred from `agg` param)
  - *Rationale*: Compact format (columnar JSON) reduces payload ~40% but complicates parsing; line/ohlc sufficient for 95% use cases
- **API param naming**: Cursor uses `interval + format`, I use `interval + format`, Codex uses `interval + agg`
  - *Rationale*: `format` more intuitive than `agg` for frontend devs; `agg` conflates aggregation interval with response shape

## Comparison Snapshot

| Dimension | My R1 Position | Best Peer Position | Notes |
|-----------|----------------|-------------------|-------|
| **Schema types** | `NUMERIC(28,10)`, `TIMESTAMPTZ`, PK `(coin_id, ts)` | Cursor: `NUMERIC(12,4)` + microsecond precision constraint; Codex: `NUMERIC(38,12)` + source column | Codex's 38-digit overkill; Cursor's microsecond handling smart; I adopt `source` col for multi-feed dedupe |
| **Partitioning** | TimescaleDB hypertables (7d chunks) + compression | Cursor: Native Postgres monthly partitions + auto-creation function | TimescaleDB wins if extension acceptable; Cursor's native approach safer for risk-averse teams |
| **Indexes** | BTREE `(coin_id, ts DESC)`, optional BRIN for time | Cursor: Covering index `(coin_id, ts DESC) INCLUDE (price)`; Codex: BRIN + BTREE | **Cursor's covering index superior** – eliminates heap lookups; adopt `INCLUDE (price, volume)` |
| **Aggregation method** | Continuous aggregates (TimescaleDB) OR manual rollup functions | Cursor: Manual rollup functions + pg_cron; Codex: Continuous aggregates preferred | Tie – both approaches valid; continuous aggs cleaner but require extension |
| **Intervals supported** | raw, 1m, 5m, 15m, 1h, 4h, 1d | Cursor: raw, 1m, 5m, 1h, 1d; Codex: tick, 1m, 5m, 15m, 1h, 4h, 1d | **Mine + Codex complete** – 15m/4h fill intraday gaps |
| **API response shape** | `{ meta: {...}, data: [{t,o,h,l,c,v,n}] }` | Cursor: 3 formats (ohlc, line, compact); Codex: `{ series: {...}, points/candles: [...] }` | **Cursor's compact format smart** for bandwidth; Codex's `series` wrapper cleaner; I adopt `series` + optional `compact` |
| **Pagination** | Cursor (`next_cursor` timestamp), seek on `(coin_id, ts)` | Cursor: `next_cursor` ISO string; Codex: `next_cursor` as `coin_id\|ts_ms` | **Codex's pipe-delimited cursor more robust** – embeds coin_id for multi-coin queries; adopt `4\|1737302520000` format |
| **Cache strategy** | Redis (30s raw, 5m aggs), ETag, Cache-Control | Cursor: Redis 30s + middleware; Codex: 30-60s TTL + cache tags per coin | **Cursor's cache middleware cleanest**; Codex's cache tags enable bulk invalidation; I adopt both |
| **Retention policy** | 90d raw, 1y 1m, forever ≥1h | Cursor: 90d raw, 365d 1m; Codex: 90d raw, 1y 1m, 5y 1h, forever 1d | **Codex's 5y retention for 1h smart** – balances storage + forensics; adopt |
| **Migration rollout** | Dual-write → dual-read → cutover → cleanup | Cursor: 5-phase (immediate fixes → enhancements → rollups → partitioning → API v2); Codex: 6-step (schema → backfill → dual-write → v2 API → validation → cleanup) | **Cursor's phased approach safest** – fixes critical issues (24h deletion) before heavy lifting; adopt immediate-fixes phase |

## Final Recommendation

After reviewing peer analyses, my **final recommended approach** integrates best ideas from all three:

### Data model
- **Schema**: `coin_price_ticks` table with `coin_id INT`, `ts TIMESTAMPTZ`, `price NUMERIC(28,10)`, `volume NUMERIC(28,10)`, `source SMALLINT`, `inserted_at TIMESTAMPTZ`
- **PK**: `(coin_id, ts, source)` – guards multi-source duplicates (adopt from Codex)
- **Partitioning**: TimescaleDB hypertables with 7-day chunks IF extension acceptable; else native Postgres monthly partitions with auto-creation (adopt Cursor's fallback)
- **Indexes**: Covering index `(coin_id, ts DESC) INCLUDE (price, volume)` (adopt from Cursor) + BRIN on `ts` per partition
- **Precision**: `NUMERIC(28,10)` – supports $1T prices with 10-decimal sub-penny precision

### Aggregation strategy
- **Intervals**: raw, 1m, 5m, 15m, 1h, 4h, 1d (adopt 15m/4h from mine + Codex)
- **Storage**: Continuous aggregates (TimescaleDB) OR rollup tables `price_history_rollups` partitioned by `interval_type` (LIST partition per Cursor)
- **Refresh**: Every 1m for 1m aggs, every 1h for ≥1h (pg_cron schedule from Cursor)
- **Columns**: `bucket_start`, `open`, `high`, `low`, `close`, `volume`, `tick_count` (standard OHLCV)

### API v2 contract
- **Endpoint**: `GET /api/v2/coins/:coinId/price-history`
- **Params**: `interval` (raw|1m|5m|15m|1h|4h|1d), `from` (ISO8601), `to` (ISO8601), `limit` (max 10k), `format` (ohlc|line|compact)
- **Response (ohlc)**:
  ```json
  {
    "series": { "coin_id": 4, "symbol": "NVC", "interval": "1h", "from": "...", "to": "..." },
    "data": [{ "t": "2025-11-01T00:00:00.000Z", "o": 91.50, "h": 93.20, "l": 90.80, "c": 92.10, "v": 1234.56, "n": 120 }],
    "next_cursor": "4|1698800400000"
  }
  ```
  (Adopt `series` wrapper from Codex + pipe-delimited cursor)
- **Response (line)**: Same meta, `data: [[ts_ms, price], ...]`
- **Response (compact)**: Columnar arrays `{ timestamps: [...], open: [...], high: [...], ... }` (adopt from Cursor for bandwidth-sensitive clients)

### Indexing, caching, pagination
- **Covering index**: `(coin_id, ts DESC) INCLUDE (price, volume)` per Cursor – eliminates heap scans
- **Redis**: 30s TTL for raw/1m, 5m for ≥1h, cache tags `coin:{coin_id}` for bulk invalidation (Codex)
- **HTTP headers**: `Cache-Control: public, max-age=30`, `ETag: {hash}` (all peers)
- **Pagination**: Cursor-based `next_cursor = coin_id|ts_ms` (Codex format), seek queries `WHERE (coin_id, ts) < ($1, $2)`

### Retention and lifecycle
- **Raw ticks**: 90 days (all peers agree)
- **1m aggs**: 1 year (all peers)
- **1h aggs**: 5 years (adopt from Codex – better forensics than my "forever")
- **≥1d aggs**: Forever
- **Cleanup**: Batched deletions with `LIMIT 10000 + pg_sleep(1)` (Cursor's anti-lock approach)
- **Compression**: TimescaleDB auto-compress after 7d (80% savings); native Postgres: manual `VACUUM FULL` quarterly

### Migration & rollout plan
1. **Phase 0 (Day 1, zero downtime)**: Disable 24h cleanup cron, add `idx_market_history_created_at`, fix column naming (adopt Cursor's "immediate fixes" phase)
2. **Phase 1 (Week 1)**: Add covering indexes, change to TIMESTAMPTZ, update unique constraints
3. **Phase 2 (Week 2-3)**: Create new schema + rollup tables/views, backfill historical data
4. **Phase 3 (Week 4)**: Dual-write to both tables (feature flag), validate parity
5. **Phase 4 (Week 5-6)**: Deploy API v2, migrate frontend, monitor
6. **Phase 5 (Week 7+)**: Deprecate v1 (6-month sunset), enable retention policies, drop old table after 30d backup window

### If Changed My Mind

**What changed**:  
- Added `source SMALLINT` column to PK (was `(coin_id, ts)`, now `(coin_id, ts, source)`)  
- Adopted covering indexes with `INCLUDE (price, volume)` instead of plain BTREE  
- Split 1h retention from "forever" to "5 years" with separate policy for ≥1d  
- Added `compact` response format option (columnar JSON)  
- Changed cursor format from ISO string to pipe-delimited `coin_id|ts_ms`  
- Added Phase 0 "immediate fixes" before heavy schema work  

**Why**:  
- **Codex's `source` column** enables multi-feed ingestion (simulator + manual updates + future exchange feeds) without dedupe conflicts; critical for production scale  
- **Cursor's covering indexes** eliminate heap lookups – benchmarks show 3-5× speedup for time-range scans; negligible storage cost (~10%)  
- **Codex's 5y retention for 1h** better balances forensic needs vs storage; "forever" risks bloat for ≥100 coins  
- **Cursor's compact format** reduces payload 40% for bandwidth-constrained clients (mobile, embedded charts); opt-in via query param avoids breaking existing clients  
- **Codex's pipe-delimited cursor** encodes both dimensions (`coin_id`, `ts`) – prevents cursor pollution in multi-coin APIs and simplifies seek logic  
- **Cursor's immediate-fixes phase** de-risks migration by addressing critical bugs (24h deletion, column naming) before committing to hypertables/rollups; aligns with incremental delivery

## Pros & Cons of the Final Approach

### Pros
- **Performance**: Covering indexes + hypertable compression deliver <50ms p95 for 24h windows even at 10M+ rows
- **Scalability**: Automatic chunking + retention policies handle multi-year datasets with predictable costs
- **Developer experience**: Chart-ready JSON (numeric types, UTC ISO), multiple formats (ohlc/line/compact), cursor pagination
- **Operational simplicity**: Continuous aggregates auto-refresh; no manual cron choreography for rollups (TimescaleDB path)
- **Cost efficiency**: 80% compression + tiered retention (90d raw, 1y 1m, 5y 1h) vs current unbounded growth
- **Reliability**: Idempotent writes via PK, multi-source dedupe, dead-letter queue for failed ingests
- **Observability**: Prometheus metrics for chunk compression, query latencies, cache hit rates

### Cons
- **Extension dependency**: TimescaleDB path locks into extension upgrade cycles; native Postgres fallback more portable but loses compression
- **Storage overhead**: Rollup tables add ~2× raw data size (mitigated by compression + retention)
- **Migration complexity**: Dual-write phase risks inconsistency bugs; requires careful validation + rollback plan
- **Learning curve**: Team must learn hypertable/continuous aggregate concepts; TimescaleDB docs good but adds cognitive load
- **Operational burden**: Managing partitions (even automated), monitoring compression jobs, tuning refresh policies
- **Cache invalidation**: Multi-tier caching (Redis + HTTP) introduces potential stale-data bugs; requires thoughtful invalidation strategy

## Actionable Next Steps (1–2 weeks)

### Week 1: Critical Fixes & Foundation
1. **[Owner: Backend Lead, Effort: S]** Disable 24h cleanup cron job immediately  
   - Acceptance: `cron.unschedule()` confirmed, no rows deleted for 7d
2. **[Owner: Backend, Effort: M]** Add covering index `(coin_id, ts DESC) INCLUDE (price, volume)` with `CONCURRENTLY`  
   - Acceptance: `EXPLAIN ANALYZE` shows Index Only Scan for price-history queries
3. **[Owner: DBA, Effort: S]** Change `created_at` to `TIMESTAMPTZ USING created_at AT TIME ZONE 'UTC'`  
   - Acceptance: All timestamps normalized to UTC, timezone metadata preserved
4. **[Owner: Backend, Effort: M]** Refactor `selectAllCoins()` N+1 to single CTE query (window functions for 24h change)  
   - Acceptance: Query count drops from 1+(N×3) to 1, p95 latency <50ms for 100 coins
5. **[Owner: Backend, Effort: S]** Add `idx_market_history_created_at` to market_history table  
   - Acceptance: Market history API queries use index (verify in `pg_stat_statements`)

### Week 2: Schema Design & Prototyping
6. **[Owner: Architect + DBA, Effort: L]** Finalize schema decision (TimescaleDB vs native partitioning) based on ops team comfort  
   - Acceptance: Written ADR with trade-off analysis, team sign-off
7. **[Owner: Backend, Effort: L]** Implement `coin_price_ticks` schema + rollup tables/views in dev environment  
   - Acceptance: Schema deployed to dev, synthetic data inserted, continuous aggregates refreshing
8. **[Owner: Backend, Effort: M]** Build backfill script to replay existing `price_history` → `coin_price_ticks`  
   - Acceptance: Script tested on dev, row counts match, OHLC values validated against known fixtures
9. **[Owner: Backend, Effort: M]** Implement dual-write logic (feature-flagged) in `updateCoinPrice` + market simulator  
   - Acceptance: Both tables populated in dev, no insert errors, data parity checks pass
10. **[Owner: Frontend + Backend, Effort: L]** Prototype API v2 endpoint with ohlc/line formats, integrate in test UI  
    - Acceptance: Test chart renders 1h candles from v2, response contract validated

### Follow-on (Week 3+)
11. **[Owner: QA, Effort: M]** Write contract tests, load tests (k6), regression tests (v1 vs v2)  
12. **[Owner: DevOps, Effort: M]** Set up Redis cluster, configure cache middleware, add Prometheus metrics  
13. **[Owner: Backend, Effort: S]** Implement rate limiting (60 req/min per IP), query timeouts (10s)  
14. **[Owner: DBA, Effort: S]** Configure retention policies, compression policies, monitor chunk health  
15. **[Owner: Product, Effort: S]** Plan v1 deprecation timeline, draft migration guide for API consumers

---

**End of Conclusions**
