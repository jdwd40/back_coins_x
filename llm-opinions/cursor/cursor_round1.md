# Price History Redesign Analysis & Recommendations
**Project:** Coins App (back_coins_x)  
**Technology Stack:** Node.js + Express + PostgreSQL  
**Analysis Date:** November 2, 2025  
**Prepared by:** Cursor AI

---

# Executive Summary

- **Critical Issue**: The current `price_history` table auto-deletes data older than 24 hours via `pg_cron`, making long-term charting impossible and violating expectations for historical analysis.
- **Performance Risk**: No time-series optimizations exist. The schema uses a generic SERIAL primary key instead of time-series partitioning, leading to unbounded table growth and slow queries at scale.
- **API Gap**: The current API (`GET /api/coins/:coinId/price-history`) only supports basic pagination with time filters but doesn't provide aggregated candles (OHLC), making it unsuitable for efficient charting.
- **Data Inconsistency**: The `price_history` table uses `recorded_at TIMESTAMP` while model code references `created_at`, and the migration shows both `recorded_at` and `created_at` in different contexts—this naming inconsistency creates bugs.
- **Type Precision Issues**: Using `DECIMAL(18,2)` for prices is excessive for display but may lose precision for crypto assets that trade in fractional pennies (e.g., 0.0001).
- **Missing Caching**: No Redis or HTTP cache headers exist. Every price history query hits the database, creating unnecessary load.
- **Opportunity**: Implementing time-series best practices (partitioning, rollups, proper indexing) and a modern API design can deliver sub-50ms queries even with millions of rows and enable sophisticated charting UIs.

---

# Current State (as implemented)

## Route Handlers Involved in Price History

### 1. Coins Routes (`/routes/coins.routes.js`)
```javascript
coinsRouter.get('/:coin_id/price-history', getPriceHistory);
```

### 2. Controller Implementation (`/controllers/coins.controller.js`)
**Endpoint:** `GET /api/coins/:coin_id/price-history`

**Query Parameters:**
- `page` (default: 1)
- `limit` (default: 10, max: 100)
- `range` (default: '30M', options: '10M', '30M', '1H', '2H', '12H', '24H', 'ALL')

**Request Validation:**
- Validates `coin_id` as positive integer
- Validates `page` as positive integer
- Validates `limit` between 1-100
- Validates `range` against whitelist
- Verifies coin exists before querying history

### 3. Model Query (`/models/coins.model.js`)

**Function:** `getCoinPriceHistory(coinId, page, limit, timeRange)`

**Current SQL Query:**
```sql
-- Count query
SELECT COUNT(*) 
FROM price_history ph
WHERE coin_id = $1::integer
AND ph.created_at >= NOW() - INTERVAL '${timeRangeMs / 1000} seconds'

-- Data query
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
AND ph.created_at >= NOW() - INTERVAL '${timeRangeMs / 1000} seconds'
ORDER BY ph.created_at DESC
LIMIT $2 OFFSET $3
```

**Response Shape:**
```json
{
  "data": [
    {
      "price_history_id": 1234,
      "coin_id": 4,
      "price": "£92.10",
      "created_at": "2025-11-02T10:30:00.000Z",
      "name": "NovaCash",
      "symbol": "NVC"
    }
  ],
  "pagination": {
    "currentPage": 1,
    "totalPages": 10,
    "totalItems": 95,
    "hasMore": true
  }
}
```

### 4. Market Price History (`/controllers/market.controller.js`)

**Endpoint:** `GET /api/market/price-history`

**Query:**
```sql
SELECT 
  total_value,
  market_trend,
  created_at,
  EXTRACT(EPOCH FROM created_at) * 1000 as timestamp
FROM market_history
WHERE created_at >= NOW() - INTERVAL '${timeRanges[timeRange]}'
ORDER BY created_at ASC
```

**Response:**
```json
{
  "history": [
    {
      "total_value": "422.54",
      "market_trend": "STABLE",
      "created_at": "2025-02-23T12:00:00.000Z",
      "timestamp": 1740484800000
    }
  ],
  "timeRange": "30M",
  "count": 1
}
```

## Database Schema

### Current `price_history` Table (Migration `003_create_price_history.sql`)

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

**Issues Identified:**
1. Column name is `recorded_at` in migration but model code uses `created_at`
2. No explicit timezone handling (`TIMESTAMP` vs `TIMESTAMPTZ`)
3. `DECIMAL(18,2)` is overkill for precision (18 digits total, 2 after decimal)
4. Auto-increment `SERIAL` primary key wastes 4 bytes per row
5. Index on `(coin_id, recorded_at DESC)` is good but not covering

### Auto-Cleanup Function (CRITICAL FLAW)

```sql
CREATE OR REPLACE FUNCTION cleanup_price_history() RETURNS void AS $$
BEGIN
    DELETE FROM price_history 
    WHERE recorded_at < NOW() - INTERVAL '24 hours';
END;
$$ LANGUAGE plpgsql;

-- Scheduled via pg_cron every hour
SELECT cron.schedule('0 * * * *', 'SELECT cleanup_price_history()');
```

**⚠️ This deletes all price history older than 24 hours!**  
This makes long-term price charts impossible and contradicts the API's support for '24H' and 'ALL' ranges.

### Market History Table (`20250223_create_market_history.sql`)

```sql
CREATE TABLE market_history (
    id SERIAL PRIMARY KEY,
    total_value DECIMAL(20, 2) NOT NULL,
    market_trend VARCHAR(20) NOT NULL CHECK (...),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

**No indexes!** Queries filtering or sorting by `created_at` will perform full table scans.

## Data Ingest/Update Flows

### Price Updates via Market Simulator (`/models/market-simulator.js`)

**Frequency:** Every 30 seconds (configurable via `priceUpdateInterval`)

**Insert Pattern:**
```javascript
// In updateAllPrices()
for (const coin of coins) {
  const newPrice = this.calculateNewPrice(parseFloat(coin.current_price), coin.coin_id);
  
  // Update current_price in coins table
  await db.query('UPDATE coins SET current_price = $1 WHERE coin_id = $2', 
                 [newPrice, coin.coin_id]);
  
  // Log to price_history
  await db.query('INSERT INTO price_history (coin_id, price) VALUES ($1, $2)',
                 [coin.coin_id, newPrice]);
}

// Also log market snapshot
await db.query('INSERT INTO market_history (total_value, market_trend) VALUES ($1, $2)',
               [totalMarketValue, this.currentCycle?.type]);
```

**Volume Projection:**
- ~5 coins × 2 updates/minute = 10 rows/minute per table
- ~14,400 rows/day for `price_history`
- ~2,880 rows/day for `market_history`
- With auto-cleanup, max rows in `price_history` ≈ 14,400 (rolling 24h window)

**Deduplication:**
- `UNIQUE (coin_id, recorded_at)` constraint prevents duplicate inserts at same timestamp
- If market updates faster than 1-second timestamp resolution, inserts will fail

### Manual Price Updates (`updateCoinPrice` in coins.model.js)

```javascript
// Transaction flow
BEGIN
  SELECT current_price FROM coins WHERE coin_id = $1;
  UPDATE coins SET current_price = $1, price_change_24h = $2 WHERE coin_id = $3;
  INSERT INTO price_history (coin_id, price, created_at) VALUES (...);
COMMIT
```

Uses explicit transaction wrapping, good practice.

---

# Problems & Risks

## 1. Performance Antipatterns

### A. N+1 Query Pattern in `selectAllCoins`

**Location:** `/models/coins.model.js:121-140`

```javascript
exports.selectAllCoins = async () => {
  const result = await db.query(`SELECT ${COIN_FIELDS} FROM coins ORDER BY coin_id ASC`);
  
  // N+1: For each coin, run 3 separate queries to calculate price change
  const coinsWithPriceChange = await Promise.all(
    result.rows.map(async (coin) => {
      const priceChange = await get24HourPriceChange(coin.coin_id);  // ❌ N queries
      return { ...coin, price_change_24h: priceChange };
    })
  );
  ...
}
```

**Impact:** For 10 coins, this generates 1 + (10 × 3) = 31 database queries instead of 1-2.

**Function `get24HourPriceChange`** (lines 52-116):
1. Query current price (newest row)
2. Query price from 24h ago
3. Fallback query for earliest price if #2 returns nothing

### B. Unbounded Scans

The `cleanup_price_history()` function runs:
```sql
DELETE FROM price_history WHERE recorded_at < NOW() - INTERVAL '24 hours';
```

Without a `LIMIT`, this can delete millions of rows in one statement, causing:
- Table-level locks
- WAL (write-ahead log) bloat
- I/O spikes
- Potential deadlocks with concurrent inserts

**Better approach:** Batch deletions with `LIMIT 10000` and loop.

### C. Missing Index Coverage

Current index: `(coin_id, recorded_at DESC)`

Queries like:
```sql
SELECT price, created_at FROM price_history WHERE coin_id = 4 AND created_at >= ...
```

Need to fetch from the index **and** table. A **covering index** would eliminate the table lookup:
```sql
CREATE INDEX idx_price_history_covering ON price_history(coin_id, recorded_at DESC) INCLUDE (price);
```

### D. Pagination Performance Cliff

```sql
LIMIT $2 OFFSET $3
```

With `OFFSET 10000`, PostgreSQL must read 10,000+ rows and discard them. Query time grows linearly with page number.

**Better:** Cursor-based pagination using `WHERE created_at < $last_seen ORDER BY created_at DESC LIMIT 100`

## 2. Incorrect Types and Precision

### Timestamp Without Timezone

```sql
recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
```

`TIMESTAMP` (without `TZ`) stores local time **without timezone info**. If server timezone changes or data is queried from different timezones, timestamps become ambiguous.

**Fix:** Use `TIMESTAMPTZ` (timestamp with timezone).

### Decimal Overkill

`DECIMAL(18,2)` means:
- Total 18 digits
- 2 decimal places
- Max value: 9,999,999,999,999,999.99 (quadrillion)

For a coin price API:
- Max realistic price: £10M per coin
- Precision needed: 0.0001 for low-value coins

**Better:** `NUMERIC(12,4)` (8 digits before decimal, 4 after)
- Max: 99,999,999.9999
- Supports fractional penny pricing

### Currency Formatting in Database Layer

The model applies formatting:
```javascript
price: CurrencyFormatter.formatGBP(item.price)
```

This returns `"£92.10"` (string), which:
- Cannot be sorted or aggregated client-side
- Increases response size (~6 bytes per number)
- Violates separation of concerns

**Fix:** Return raw numeric values; let frontend format.

## 3. API Contract Issues for Charting

### Irregular Timestamps

With 30-second update intervals, gaps in data are possible (server downtime, errors). Frontend charts need to know:
- Expected interval
- How to handle gaps
- Whether to interpolate or show discontinuities

Current API provides no metadata about interval or completeness.

### No OHLC Support

Financial charts typically use **OHLC candles** (Open, High, Low, Close) for each time bucket (1m, 5m, 1h, 1d). The current API returns:
- Raw tick data (one price per row)
- No aggregation

To render a 1-day chart with 1-hour candles, the client would need to:
1. Fetch all raw ticks (potentially thousands)
2. Group by hour client-side
3. Calculate OHLC for each bucket

This is expensive and error-prone.

### Mixed Granularities

The `range` parameter controls **window size** (10M, 1H, 24H) but not **granularity**. For a 24H range, should the frontend receive:
- All raw ticks (17,280 points at 5s interval)?
- Hourly aggregates (24 points)?
- Minute aggregates (1,440 points)?

**Missing:** An `interval` or `granularity` parameter.

### Pagination vs Streaming

Pagination (`page`/`limit`) is suitable for tables but awkward for time-series:
- "Page 5" has no temporal meaning
- Frontend needs to fetch all pages to render a chart
- No way to request "last 100 points"

**Better:** `from`/`to` timestamps + `limit`.

## 4. Reliability & Data Quality

### Clock Skew Handling

The `UNIQUE (coin_id, recorded_at)` constraint assumes:
- Timestamps are always unique
- No clock drift or NTP corrections

If two inserts happen within 1ms (PostgreSQL timestamp resolution), the second fails silently or raises an error.

**Fix:** Use `ON CONFLICT DO NOTHING` or add microsecond precision.

### No Dead-Letter Queue

When `INSERT INTO price_history` fails (constraint violation, disk full, etc.), the market simulator logs an error but the price update is **lost forever**.

**Better:**
- Retry with exponential backoff
- Log to a `failed_price_updates` table for manual review
- Alert on consecutive failures

### Input Validation Gaps

The `updateCoinPrice` function accepts `numericPrice` but doesn't validate:
- Non-finite values (NaN, Infinity)
- Negative prices (validated elsewhere but not centrally)
- Extreme precision (e.g., 1.123456789)

## 5. Missing Caching Layer

### No HTTP Cache Headers

Responses lack:
- `Cache-Control: max-age=30` (cache for 30s since data updates every 30s)
- `ETag` (for conditional requests)
- `Last-Modified`

### No Redis/Memcached

For "hot" queries (e.g., last 1H for top 5 coins), results could be cached for 30s, reducing DB load by ~95%.

### No Query Result Caching

PostgreSQL's shared buffers help, but application-level caching (memoization) would prevent redundant queries within the same request.

---

# Recommendations (Prioritized Roadmap)

## 1. Schema Redesign for Time-Series (Priority: CRITICAL)

### Phase 1A: Fix Immediate Issues (1-2 days)

**Action 1: Disable Auto-Cleanup**

```sql
-- Disable the cron job immediately
SELECT cron.unschedule(schedule_id) 
FROM cron.job 
WHERE command LIKE '%cleanup_price_history%';
```

**Action 2: Add Retention Policy Table**

```sql
CREATE TABLE price_history_retention (
    interval_name VARCHAR(10) PRIMARY KEY,
    retention_days INT NOT NULL,
    description TEXT
);

INSERT INTO price_history_retention VALUES
    ('raw', 90, 'Raw tick data'),
    ('1m', 365, '1-minute aggregates'),
    ('1h', NULL, '1-hour aggregates (keep forever)'),
    ('1d', NULL, 'Daily aggregates (keep forever)');
```

**Action 3: Standardize Column Names**

```sql
-- Migration: Rename recorded_at → created_at
ALTER TABLE price_history RENAME COLUMN recorded_at TO created_at;

-- Change to TIMESTAMPTZ
ALTER TABLE price_history 
    ALTER COLUMN created_at TYPE TIMESTAMPTZ 
    USING created_at AT TIME ZONE 'UTC';
```

### Phase 1B: Optimize Existing Schema (3-5 days)

**New Index: Covering Index**

```sql
-- Replace existing index with covering version
DROP INDEX idx_price_history_coin_timestamp;

CREATE INDEX idx_price_history_coin_ts_covering 
ON price_history(coin_id, created_at DESC) 
INCLUDE (price);
```

**Add Index to market_history**

```sql
CREATE INDEX idx_market_history_created_at 
ON market_history(created_at DESC);
```

**Add Conflict Handling**

```sql
-- In insert statements, add:
INSERT INTO price_history (coin_id, price, created_at)
VALUES ($1, $2, NOW())
ON CONFLICT (coin_id, created_at) DO UPDATE SET price = EXCLUDED.price;
```

### Phase 2: Introduce Partitioning (1-2 weeks)

**For New Installations:**

```sql
-- Create partitioned table
CREATE TABLE price_history_new (
    coin_id INT NOT NULL,
    price NUMERIC(12, 4) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
) PARTITION BY RANGE (created_at);

-- Create monthly partitions
CREATE TABLE price_history_2025_11 
    PARTITION OF price_history_new 
    FOR VALUES FROM ('2025-11-01') TO ('2025-12-01');

CREATE TABLE price_history_2025_12 
    PARTITION OF price_history_new 
    FOR VALUES FROM ('2025-12-01') TO ('2026-01-01');

-- Create indexes on partitions
CREATE INDEX idx_ph_2025_11 ON price_history_2025_11(coin_id, created_at DESC) INCLUDE (price);
CREATE INDEX idx_ph_2025_12 ON price_history_2025_12(coin_id, created_at DESC) INCLUDE (price);

-- Foreign key constraint (must be on partitioned table)
ALTER TABLE price_history_new 
    ADD CONSTRAINT fk_coin 
    FOREIGN KEY (coin_id) REFERENCES coins(coin_id) ON DELETE CASCADE;

-- Unique constraint
CREATE UNIQUE INDEX uniq_coin_ts_global 
ON price_history_new(coin_id, created_at);
```

**Benefits:**
- Queries for recent data only scan relevant partition
- Dropping old partitions is instant (`DROP TABLE price_history_2024_01`)
- Each partition can have different storage settings

**For Existing Data:**

```sql
-- Dual-write period: write to both old and new tables
-- Then backfill:
INSERT INTO price_history_new (coin_id, price, created_at)
SELECT coin_id, price, created_at FROM price_history
ON CONFLICT DO NOTHING;

-- Swap tables (requires downtime or blue-green deployment)
BEGIN;
ALTER TABLE price_history RENAME TO price_history_old;
ALTER TABLE price_history_new RENAME TO price_history;
COMMIT;
```

### Phase 3: TimescaleDB Hypertables (Optional, 2-3 weeks)

If willing to adopt TimescaleDB (PostgreSQL extension):

```sql
-- Install extension
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- Convert table to hypertable
SELECT create_hypertable('price_history', 'created_at', 
    chunk_time_interval => INTERVAL '7 days');

-- Enable compression (10x space savings)
ALTER TABLE price_history SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'coin_id',
    timescaledb.compress_orderby = 'created_at DESC'
);

-- Auto-compress chunks older than 7 days
SELECT add_compression_policy('price_history', INTERVAL '7 days');
```

**Advantages:**
- Automatic chunk management
- Transparent compression
- Continuous aggregates (see next section)

---

## 2. Data Modeling for Charts (Priority: HIGH)

### Define Standard Intervals

| Interval | Use Case | Retention | Storage Method |
|----------|----------|-----------|----------------|
| raw (30s) | Real-time monitoring | 7 days | `price_history` table |
| 1m | Short-term charts | 90 days | Rollup table |
| 5m | Intraday charts | 1 year | Rollup table |
| 1h | Daily/weekly charts | Forever | Rollup table |
| 1d | Monthly/yearly charts | Forever | Rollup table |

### Rollup Tables Schema

```sql
-- Generic rollup table
CREATE TABLE price_history_rollups (
    coin_id INT NOT NULL REFERENCES coins(coin_id) ON DELETE CASCADE,
    interval_type VARCHAR(10) NOT NULL, -- '1m', '5m', '1h', '1d'
    bucket_start TIMESTAMPTZ NOT NULL,
    open NUMERIC(12,4) NOT NULL,
    high NUMERIC(12,4) NOT NULL,
    low NUMERIC(12,4) NOT NULL,
    close NUMERIC(12,4) NOT NULL,
    volume NUMERIC(20,8) DEFAULT 0, -- For future trading volume
    tick_count INT NOT NULL, -- Number of raw ticks in this bucket
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (coin_id, interval_type, bucket_start)
) PARTITION BY LIST (interval_type);

-- Partitions per interval
CREATE TABLE price_history_rollups_1m PARTITION OF price_history_rollups 
    FOR VALUES IN ('1m');
CREATE TABLE price_history_rollups_5m PARTITION OF price_history_rollups 
    FOR VALUES IN ('5m');
CREATE TABLE price_history_rollups_1h PARTITION OF price_history_rollups 
    FOR VALUES IN ('1h');
CREATE TABLE price_history_rollups_1d PARTITION OF price_history_rollups 
    FOR VALUES IN ('1d');

-- Indexes
CREATE INDEX idx_rollups_1m ON price_history_rollups_1m(coin_id, bucket_start DESC);
CREATE INDEX idx_rollups_5m ON price_history_rollups_5m(coin_id, bucket_start DESC);
CREATE INDEX idx_rollups_1h ON price_history_rollups_1h(coin_id, bucket_start DESC);
CREATE INDEX idx_rollups_1d ON price_history_rollups_1d(coin_id, bucket_start DESC);
```

### Server-Side Aggregation SQL

**1-Minute Rollup:**

```sql
INSERT INTO price_history_rollups_1m (coin_id, interval_type, bucket_start, open, high, low, close, tick_count)
SELECT 
    coin_id,
    '1m' AS interval_type,
    DATE_TRUNC('minute', created_at) AS bucket_start,
    (ARRAY_AGG(price ORDER BY created_at ASC))[1] AS open,
    MAX(price) AS high,
    MIN(price) AS low,
    (ARRAY_AGG(price ORDER BY created_at DESC))[1] AS close,
    COUNT(*) AS tick_count
FROM price_history
WHERE created_at >= NOW() - INTERVAL '2 minutes'
  AND created_at < DATE_TRUNC('minute', NOW())
GROUP BY coin_id, bucket_start
ON CONFLICT (coin_id, interval_type, bucket_start) DO NOTHING;
```

**Schedule via cron:**

```sql
SELECT cron.schedule('*/1 * * * *', $$
    INSERT INTO price_history_rollups_1m ...
$$);
```

**1-Hour Rollup (from 1m rollups):**

```sql
INSERT INTO price_history_rollups_1h (coin_id, interval_type, bucket_start, open, high, low, close, tick_count)
SELECT 
    coin_id,
    '1h' AS interval_type,
    DATE_TRUNC('hour', bucket_start) AS bucket_start,
    (ARRAY_AGG(open ORDER BY bucket_start ASC))[1] AS open,
    MAX(high) AS high,
    MIN(low) AS low,
    (ARRAY_AGG(close ORDER BY bucket_start DESC))[1] AS close,
    SUM(tick_count) AS tick_count
FROM price_history_rollups_1m
WHERE bucket_start >= NOW() - INTERVAL '2 hours'
  AND bucket_start < DATE_TRUNC('hour', NOW())
GROUP BY coin_id, bucket_start
ON CONFLICT (coin_id, interval_type, bucket_start) DO NOTHING;
```

### TimescaleDB Continuous Aggregates (Alternative)

```sql
CREATE MATERIALIZED VIEW price_history_1m
WITH (timescaledb.continuous) AS
SELECT 
    coin_id,
    TIME_BUCKET('1 minute', created_at) AS bucket,
    FIRST(price, created_at) AS open,
    MAX(price) AS high,
    MIN(price) AS low,
    LAST(price, created_at) AS close,
    COUNT(*) AS tick_count
FROM price_history
GROUP BY coin_id, bucket;

-- Auto-refresh policy
SELECT add_continuous_aggregate_policy('price_history_1m',
    start_offset => INTERVAL '2 hours',
    end_offset => INTERVAL '1 minute',
    schedule_interval => INTERVAL '1 minute');
```

**Advantages:**
- Automatic refresh
- Transparent querying
- Built-in downsampling

---

## 3. API v2 for Price History (Priority: HIGH)

### Endpoint Design

**New endpoint:**  
`GET /api/v2/coins/:coinId/price-history`

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `interval` | string | `1h` | Aggregation interval: `raw`, `1m`, `5m`, `1h`, `1d` |
| `from` | ISO8601 | `-24h` | Start timestamp (inclusive) |
| `to` | ISO8601 | `now` | End timestamp (exclusive) |
| `limit` | int | `1000` | Max data points (max: 5000) |
| `format` | string | `ohlc` | Response format: `ohlc`, `line`, `compact` |

**Example Requests:**

```bash
# 1-hour candles for last 7 days
GET /api/v2/coins/4/price-history?interval=1h&from=2025-10-26T00:00:00Z&to=2025-11-02T00:00:00Z&format=ohlc

# Raw ticks for last 5 minutes
GET /api/v2/coins/4/price-history?interval=raw&from=2025-11-02T10:25:00Z&limit=100

# Daily candles (all-time)
GET /api/v2/coins/4/price-history?interval=1d&format=ohlc
```

### Response Formats

#### A) OHLC (Candlestick) Format

```json
{
  "meta": {
    "coin_id": 4,
    "symbol": "NVC",
    "name": "NovaCash",
    "interval": "1h",
    "from": "2025-11-01T00:00:00.000Z",
    "to": "2025-11-02T00:00:00.000Z",
    "count": 24,
    "has_more": false
  },
  "data": [
    {
      "t": "2025-11-01T00:00:00.000Z",
      "o": 91.50,
      "h": 93.20,
      "l": 90.80,
      "c": 92.10,
      "v": 0,
      "n": 120
    },
    {
      "t": "2025-11-01T01:00:00.000Z",
      "o": 92.10,
      "h": 92.85,
      "l": 91.45,
      "c": 91.75,
      "v": 0,
      "n": 118
    }
  ]
}
```

**Field Definitions:**
- `t`: Bucket timestamp (start of interval)
- `o`: Open (first price in bucket)
- `h`: High (max price in bucket)
- `l`: Low (min price in bucket)
- `c`: Close (last price in bucket)
- `v`: Volume (reserved for future trading volume)
- `n`: Number of ticks (data quality indicator)

#### B) Line Chart Format (Simplified)

```json
{
  "meta": {
    "coin_id": 4,
    "symbol": "NVC",
    "interval": "1h",
    "count": 24
  },
  "data": [
    ["2025-11-01T00:00:00.000Z", 92.10],
    ["2025-11-01T01:00:00.000Z", 91.75],
    ["2025-11-01T02:00:00.000Z", 92.35]
  ]
}
```

Uses `close` price only, as `[timestamp, value]` tuples.

#### C) Compact Format (Binary-Friendly)

```json
{
  "meta": {
    "coin_id": 4,
    "interval": "1h",
    "start_time": "2025-11-01T00:00:00.000Z",
    "interval_seconds": 3600
  },
  "timestamps": [1698796800, 1698800400, 1698804000],
  "open": [91.50, 92.10, 91.75],
  "high": [93.20, 92.85, 92.60],
  "low": [90.80, 91.45, 91.20],
  "close": [92.10, 91.75, 92.35]
}
```

Columnar format reduces JSON overhead by ~40%.

### Implementation (Controller)

**File:** `/controllers/coins.controller.v2.js`

```javascript
const { getCoinPriceHistoryV2 } = require('../models/coins.model');

exports.getPriceHistoryV2 = async (req, res) => {
  try {
    const { coin_id } = req.params;
    const { 
      interval = '1h', 
      from, 
      to, 
      limit = 1000, 
      format = 'ohlc' 
    } = req.query;

    // Validate interval
    const validIntervals = ['raw', '1m', '5m', '1h', '1d'];
    if (!validIntervals.includes(interval)) {
      return res.status(400).json({ 
        error: `Invalid interval. Must be one of: ${validIntervals.join(', ')}` 
      });
    }

    // Validate format
    const validFormats = ['ohlc', 'line', 'compact'];
    if (!validFormats.includes(format)) {
      return res.status(400).json({ 
        error: `Invalid format. Must be one of: ${validFormats.join(', ')}` 
      });
    }

    // Validate and parse timestamps
    let fromDate, toDate;
    if (from) {
      fromDate = new Date(from);
      if (isNaN(fromDate)) {
        return res.status(400).json({ error: 'Invalid from timestamp' });
      }
    } else {
      fromDate = new Date(Date.now() - 24 * 60 * 60 * 1000); // Default: -24h
    }

    if (to) {
      toDate = new Date(to);
      if (isNaN(toDate)) {
        return res.status(400).json({ error: 'Invalid to timestamp' });
      }
    } else {
      toDate = new Date(); // Default: now
    }

    // Validate limit
    const limitNum = parseInt(limit);
    if (!Number.isInteger(limitNum) || limitNum < 1 || limitNum > 5000) {
      return res.status(400).json({ 
        error: 'Limit must be between 1 and 5000' 
      });
    }

    // Check if coin exists
    const coin = await selectCoinById(coin_id);
    if (!coin) {
      return res.status(404).json({ error: 'Coin not found' });
    }

    // Fetch data
    const result = await getCoinPriceHistoryV2({
      coinId: coin_id,
      interval,
      from: fromDate,
      to: toDate,
      limit: limitNum,
      format
    });

    // Set cache headers (30s cache for recent data)
    const isRecent = (Date.now() - toDate.getTime()) < 60000; // Last 1 minute
    if (isRecent) {
      res.set('Cache-Control', 'public, max-age=30');
    } else {
      res.set('Cache-Control', 'public, max-age=3600'); // 1 hour for historical
    }

    res.status(200).json(result);
  } catch (error) {
    console.error('Error in getPriceHistoryV2:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};
```

### Implementation (Model)

**File:** `/models/coins.model.js`

```javascript
exports.getCoinPriceHistoryV2 = async (options) => {
  const { coinId, interval, from, to, limit, format } = options;

  let query, tableName;

  // Determine source table
  if (interval === 'raw') {
    tableName = 'price_history';
    query = `
      SELECT 
        created_at AS t,
        price AS c
      FROM price_history
      WHERE coin_id = $1
        AND created_at >= $2
        AND created_at < $3
      ORDER BY created_at ASC
      LIMIT $4
    `;
  } else {
    tableName = 'price_history_rollups';
    query = `
      SELECT 
        bucket_start AS t,
        open AS o,
        high AS h,
        low AS l,
        close AS c,
        volume AS v,
        tick_count AS n
      FROM price_history_rollups
      WHERE coin_id = $1
        AND interval_type = $2
        AND bucket_start >= $3
        AND bucket_start < $4
      ORDER BY bucket_start ASC
      LIMIT $5
    `;
  }

  const params = interval === 'raw' 
    ? [coinId, from, to, limit]
    : [coinId, interval, from, to, limit];

  const result = await db.query(query, params);

  // Get coin metadata
  const coinResult = await db.query(
    'SELECT coin_id, name, symbol FROM coins WHERE coin_id = $1',
    [coinId]
  );
  const coinMeta = coinResult.rows[0];

  // Format response
  const meta = {
    coin_id: coinMeta.coin_id,
    symbol: coinMeta.symbol,
    name: coinMeta.name,
    interval,
    from: from.toISOString(),
    to: to.toISOString(),
    count: result.rows.length,
    has_more: result.rows.length === limit
  };

  if (format === 'line') {
    return {
      meta,
      data: result.rows.map(row => [row.t, parseFloat(row.c)])
    };
  } else if (format === 'compact') {
    return {
      meta,
      timestamps: result.rows.map(row => Math.floor(new Date(row.t).getTime() / 1000)),
      open: result.rows.map(row => parseFloat(row.o || row.c)),
      high: result.rows.map(row => parseFloat(row.h || row.c)),
      low: result.rows.map(row => parseFloat(row.l || row.c)),
      close: result.rows.map(row => parseFloat(row.c))
    };
  } else { // ohlc
    return {
      meta,
      data: result.rows.map(row => ({
        t: row.t,
        o: parseFloat(row.o || row.c),
        h: parseFloat(row.h || row.c),
        l: parseFloat(row.l || row.c),
        c: parseFloat(row.c),
        v: parseFloat(row.v || 0),
        n: parseInt(row.n || 1)
      }))
    };
  }
};
```

---

## 4. Performance & Caching (Priority: MEDIUM)

### Redis Integration

**Install dependencies:**
```bash
npm install redis
```

**Connection setup** (`/db/redis.js`):

```javascript
const redis = require('redis');

const client = redis.createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379',
  socket: {
    reconnectStrategy: (retries) => Math.min(retries * 50, 2000)
  }
});

client.on('error', (err) => console.error('Redis error:', err));
client.on('connect', () => console.log('Redis connected'));

(async () => {
  await client.connect();
})();

module.exports = client;
```

### Cache Middleware

```javascript
// /middleware/cache.js
const redisClient = require('../db/redis');

const cacheMiddleware = (ttlSeconds = 30) => {
  return async (req, res, next) => {
    if (req.method !== 'GET') {
      return next();
    }

    const key = `cache:${req.originalUrl}`;

    try {
      const cached = await redisClient.get(key);
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
      redisClient.setEx(key, ttlSeconds, JSON.stringify(data)).catch(err => {
        console.error('Cache write error:', err);
      });
      return originalJson(data);
    };

    next();
  };
};

module.exports = cacheMiddleware;
```

### Usage in Routes

```javascript
const cacheMiddleware = require('../middleware/cache');

// Cache price history for 30 seconds
coinsRouter.get('/:coin_id/price-history', 
  cacheMiddleware(30), 
  getPriceHistoryV2
);

// Cache 1-hour candles for 10 minutes
coinsRouter.get('/:coin_id/price-history', 
  cacheMiddleware(600), 
  getPriceHistoryV2
);
```

### HTTP Cache Headers

```javascript
// In controller
const cacheAge = interval === 'raw' ? 30 : 3600;
res.set('Cache-Control', `public, max-age=${cacheAge}`);
res.set('ETag', generateETag(data)); // Use etag library
```

### Query Optimization: Eliminate N+1

**Current problem:** `selectAllCoins` queries each coin's 24h price change separately.

**Fix with window function:**

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
  c.coin_id,
  c.name,
  c.symbol,
  c.current_price,
  c.market_cap,
  c.circulating_supply,
  c.founder,
  COALESCE(
    ROUND(((lp.current_price - op.old_price) / NULLIF(op.old_price, 0) * 100)::numeric, 2),
    0
  ) AS price_change_24h
FROM coins c
LEFT JOIN latest_prices lp ON c.coin_id = lp.coin_id
LEFT JOIN old_prices op ON c.coin_id = op.coin_id
ORDER BY c.coin_id ASC;
```

**Before:** 1 + (N × 3) queries  
**After:** 1 query

### Connection Pooling

Verify pool settings in `/db/connection.js`:

```javascript
const config = {
  max: 20, // Max connections (adjust based on traffic)
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
  statement_timeout: 10000 // Kill queries after 10s
};
```

---

## 5. Retention & Lifecycle (Priority: MEDIUM)

### Retention Policy Table

```sql
CREATE TABLE data_retention_policies (
    table_name VARCHAR(50) PRIMARY KEY,
    interval_type VARCHAR(10),
    retention_days INT, -- NULL = keep forever
    last_cleanup_at TIMESTAMPTZ,
    enabled BOOLEAN DEFAULT true
);

INSERT INTO data_retention_policies VALUES
    ('price_history', 'raw', 90, NULL, true),
    ('price_history_rollups', '1m', 365, NULL, true),
    ('price_history_rollups', '5m', NULL, NULL, true),
    ('price_history_rollups', '1h', NULL, NULL, true),
    ('price_history_rollups', '1d', NULL, NULL, true);
```

### Cleanup Function (Batched)

```sql
CREATE OR REPLACE FUNCTION cleanup_old_price_history() RETURNS void AS $$
DECLARE
    deleted_count INT;
BEGIN
    -- Clean raw price_history (keep 90 days)
    LOOP
        DELETE FROM price_history
        WHERE created_at < NOW() - INTERVAL '90 days'
        AND price_history_id IN (
            SELECT price_history_id FROM price_history
            WHERE created_at < NOW() - INTERVAL '90 days'
            LIMIT 10000
        );
        
        GET DIAGNOSTICS deleted_count = ROW_COUNT;
        EXIT WHEN deleted_count = 0;
        
        -- Sleep 1 second between batches
        PERFORM pg_sleep(1);
    END LOOP;

    -- Clean 1m rollups (keep 365 days)
    LOOP
        DELETE FROM price_history_rollups_1m
        WHERE bucket_start < NOW() - INTERVAL '365 days'
        LIMIT 10000;
        
        GET DIAGNOSTICS deleted_count = ROW_COUNT;
        EXIT WHEN deleted_count = 0;
        
        PERFORM pg_sleep(1);
    END LOOP;

    UPDATE data_retention_policies 
    SET last_cleanup_at = NOW() 
    WHERE table_name = 'price_history';
END;
$$ LANGUAGE plpgsql;
```

### Schedule (Daily at 2 AM)

```sql
SELECT cron.schedule('0 2 * * *', 'SELECT cleanup_old_price_history()');
```

### Backfill Strategy

For generating historical rollups:

```bash
# Backfill 1m rollups for last 7 days
psql -c "
INSERT INTO price_history_rollups_1m (coin_id, interval_type, bucket_start, open, high, low, close, tick_count)
SELECT 
    coin_id,
    '1m',
    DATE_TRUNC('minute', created_at),
    (ARRAY_AGG(price ORDER BY created_at ASC))[1],
    MAX(price),
    MIN(price),
    (ARRAY_AGG(price ORDER BY created_at DESC))[1],
    COUNT(*)
FROM price_history
WHERE created_at >= NOW() - INTERVAL '7 days'
GROUP BY coin_id, DATE_TRUNC('minute', created_at)
ON CONFLICT DO NOTHING;
"
```

---

## 6. Reliability (Priority: MEDIUM)

### Idempotent Writes

**Current issue:** `INSERT INTO price_history` fails on duplicate timestamps.

**Fix:**

```sql
INSERT INTO price_history (coin_id, price, created_at)
VALUES ($1, $2, NOW())
ON CONFLICT (coin_id, created_at) 
DO UPDATE SET price = EXCLUDED.price;
```

Or, if duplicates should be silently dropped:

```sql
INSERT INTO price_history (coin_id, price, created_at)
VALUES ($1, $2, NOW())
ON CONFLICT (coin_id, created_at) DO NOTHING;
```

### Clock Skew Handling

Use microsecond precision:

```sql
-- Instead of NOW(), use:
CURRENT_TIMESTAMP(6)  -- 6 digits = microsecond precision
```

Update unique constraint:

```sql
ALTER TABLE price_history 
DROP CONSTRAINT unique_coin_timestamp;

-- created_at already supports microseconds if TIMESTAMPTZ
ALTER TABLE price_history 
ADD CONSTRAINT unique_coin_timestamp_us 
UNIQUE (coin_id, created_at);
```

### Input Validation

Add model-level validation:

```javascript
function validatePrice(price) {
  if (typeof price !== 'number' || !Number.isFinite(price)) {
    throw new Error('INVALID_PRICE_TYPE');
  }
  if (price < 0) {
    throw new Error('NEGATIVE_PRICE');
  }
  if (price > 1e9) {
    throw new Error('PRICE_TOO_HIGH');
  }
  // Round to 4 decimal places
  return Math.round(price * 10000) / 10000;
}
```

### Dead-Letter Table

```sql
CREATE TABLE failed_price_inserts (
    id SERIAL PRIMARY KEY,
    coin_id INT,
    price NUMERIC(12,4),
    attempted_at TIMESTAMPTZ DEFAULT NOW(),
    error_message TEXT,
    retry_count INT DEFAULT 0,
    resolved BOOLEAN DEFAULT false
);

CREATE INDEX idx_failed_inserts_unresolved 
ON failed_price_inserts(attempted_at) 
WHERE NOT resolved;
```

Usage:

```javascript
try {
  await db.query('INSERT INTO price_history (coin_id, price) VALUES ($1, $2)', 
                 [coinId, price]);
} catch (err) {
  await db.query(
    'INSERT INTO failed_price_inserts (coin_id, price, error_message) VALUES ($1, $2, $3)',
    [coinId, price, err.message]
  );
  logger.error('Price insert failed, logged to DLQ:', err);
}
```

---

## 7. Security & Quotas (Priority: LOW)

### Rate Limiting

**Install:** `npm install express-rate-limit`

```javascript
// /middleware/rateLimiter.js
const rateLimit = require('express-rate-limit');

const priceHistoryLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60, // 60 requests per minute
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    // Rate limit by IP or JWT user_id
    return req.user?.user_id || req.ip;
  }
});

module.exports = { priceHistoryLimiter };
```

**Usage:**

```javascript
const { priceHistoryLimiter } = require('../middleware/rateLimiter');

coinsRouter.get('/:coin_id/price-history', 
  priceHistoryLimiter,
  getPriceHistoryV2
);
```

### Query Limits

Enforce max `limit` parameter:

```javascript
const MAX_LIMIT = 5000;
if (limit > MAX_LIMIT) {
  return res.status(400).json({ 
    error: `Limit cannot exceed ${MAX_LIMIT}` 
  });
}
```

### Statement Timeout

Set per-query timeout:

```javascript
// At connection level
await db.query('SET statement_timeout = 10000'); // 10 seconds

// Or per-query
await db.query('SET LOCAL statement_timeout = 5000; SELECT ...');
```

---

# Concrete Artifacts

## Proposed SQL

### Complete Schema (New Installation)

```sql
-- ======================
-- PRICE HISTORY SCHEMA V2
-- ======================

-- Main time-series table (partitioned)
CREATE TABLE price_history (
    coin_id INT NOT NULL,
    price NUMERIC(12, 4) NOT NULL CHECK (price >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    CONSTRAINT fk_coin FOREIGN KEY (coin_id) REFERENCES coins(coin_id) ON DELETE CASCADE
) PARTITION BY RANGE (created_at);

-- Unique constraint (microsecond precision)
CREATE UNIQUE INDEX uniq_coin_ts ON price_history(coin_id, created_at);

-- Covering index for queries
CREATE INDEX idx_price_history_covering ON price_history(coin_id, created_at DESC) INCLUDE (price);

-- Create initial partitions (monthly)
CREATE TABLE price_history_2025_11 PARTITION OF price_history
    FOR VALUES FROM ('2025-11-01') TO ('2025-12-01');

CREATE TABLE price_history_2025_12 PARTITION OF price_history
    FOR VALUES FROM ('2025-12-01') TO ('2026-01-01');

-- Function to auto-create partitions
CREATE OR REPLACE FUNCTION create_monthly_partition(table_name TEXT, start_date DATE)
RETURNS void AS $$
DECLARE
    partition_name TEXT;
    end_date DATE;
BEGIN
    partition_name := table_name || '_' || TO_CHAR(start_date, 'YYYY_MM');
    end_date := start_date + INTERVAL '1 month';
    
    EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
                   partition_name, table_name, start_date, end_date);
    
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%I ON %I(coin_id, created_at DESC) INCLUDE (price)',
                   partition_name, partition_name);
END;
$$ LANGUAGE plpgsql;

-- Schedule partition creation (1st of each month)
SELECT cron.schedule('0 0 1 * *', $$
    SELECT create_monthly_partition('price_history', DATE_TRUNC('month', NOW() + INTERVAL '2 months')::date)
$$);

-- ======================
-- ROLLUP TABLES
-- ======================

CREATE TABLE price_history_rollups (
    coin_id INT NOT NULL,
    interval_type VARCHAR(10) NOT NULL CHECK (interval_type IN ('1m', '5m', '1h', '1d')),
    bucket_start TIMESTAMPTZ NOT NULL,
    open NUMERIC(12, 4) NOT NULL,
    high NUMERIC(12, 4) NOT NULL,
    low NUMERIC(12, 4) NOT NULL,
    close NUMERIC(12, 4) NOT NULL,
    volume NUMERIC(20, 8) DEFAULT 0,
    tick_count INT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (coin_id, interval_type, bucket_start),
    CONSTRAINT fk_coin_rollup FOREIGN KEY (coin_id) REFERENCES coins(coin_id) ON DELETE CASCADE
) PARTITION BY LIST (interval_type);

-- Create partitions per interval
CREATE TABLE price_history_rollups_1m PARTITION OF price_history_rollups FOR VALUES IN ('1m');
CREATE TABLE price_history_rollups_5m PARTITION OF price_history_rollups FOR VALUES IN ('5m');
CREATE TABLE price_history_rollups_1h PARTITION OF price_history_rollups FOR VALUES IN ('1h');
CREATE TABLE price_history_rollups_1d PARTITION OF price_history_rollups FOR VALUES IN ('1d');

-- Indexes
CREATE INDEX idx_rollups_1m ON price_history_rollups_1m(coin_id, bucket_start DESC) INCLUDE (open, high, low, close);
CREATE INDEX idx_rollups_5m ON price_history_rollups_5m(coin_id, bucket_start DESC) INCLUDE (open, high, low, close);
CREATE INDEX idx_rollups_1h ON price_history_rollups_1h(coin_id, bucket_start DESC) INCLUDE (open, high, low, close);
CREATE INDEX idx_rollups_1d ON price_history_rollups_1d(coin_id, bucket_start DESC) INCLUDE (open, high, low, close);

-- ======================
-- ROLLUP FUNCTIONS
-- ======================

-- 1-minute rollup
CREATE OR REPLACE FUNCTION compute_1m_rollups() RETURNS void AS $$
BEGIN
    INSERT INTO price_history_rollups_1m (coin_id, interval_type, bucket_start, open, high, low, close, tick_count)
    SELECT 
        coin_id,
        '1m' AS interval_type,
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

-- 1-hour rollup (from 1m data)
CREATE OR REPLACE FUNCTION compute_1h_rollups() RETURNS void AS $$
BEGIN
    INSERT INTO price_history_rollups_1h (coin_id, interval_type, bucket_start, open, high, low, close, tick_count)
    SELECT 
        coin_id,
        '1h' AS interval_type,
        DATE_TRUNC('hour', bucket_start) AS bucket_start,
        (ARRAY_AGG(open ORDER BY bucket_start ASC))[1] AS open,
        MAX(high) AS high,
        MIN(low) AS low,
        (ARRAY_AGG(close ORDER BY bucket_start DESC))[1] AS close,
        SUM(tick_count) AS tick_count
    FROM price_history_rollups_1m
    WHERE bucket_start >= DATE_TRUNC('hour', NOW()) - INTERVAL '2 hours'
      AND bucket_start < DATE_TRUNC('hour', NOW())
    GROUP BY coin_id, bucket_start
    ON CONFLICT (coin_id, interval_type, bucket_start) DO NOTHING;
END;
$$ LANGUAGE plpgsql;

-- Daily rollup (from 1h data)
CREATE OR REPLACE FUNCTION compute_1d_rollups() RETURNS void AS $$
BEGIN
    INSERT INTO price_history_rollups_1d (coin_id, interval_type, bucket_start, open, high, low, close, tick_count)
    SELECT 
        coin_id,
        '1d' AS interval_type,
        DATE_TRUNC('day', bucket_start) AS bucket_start,
        (ARRAY_AGG(open ORDER BY bucket_start ASC))[1] AS open,
        MAX(high) AS high,
        MIN(low) AS low,
        (ARRAY_AGG(close ORDER BY bucket_start DESC))[1] AS close,
        SUM(tick_count) AS tick_count
    FROM price_history_rollups_1h
    WHERE bucket_start >= DATE_TRUNC('day', NOW()) - INTERVAL '2 days'
      AND bucket_start < DATE_TRUNC('day', NOW())
    GROUP BY coin_id, bucket_start
    ON CONFLICT (coin_id, interval_type, bucket_start) DO NOTHING;
END;
$$ LANGUAGE plpgsql;

-- ======================
-- CRON SCHEDULES
-- ======================

-- Run 1m rollups every minute
SELECT cron.schedule('*/1 * * * *', 'SELECT compute_1m_rollups()');

-- Run 1h rollups every hour (at 5 min past)
SELECT cron.schedule('5 * * * *', 'SELECT compute_1h_rollups()');

-- Run 1d rollups daily at 00:10
SELECT cron.schedule('10 0 * * *', 'SELECT compute_1d_rollups()');

-- ======================
-- RETENTION & CLEANUP
-- ======================

CREATE TABLE data_retention_policies (
    table_name VARCHAR(50) PRIMARY KEY,
    interval_type VARCHAR(10),
    retention_days INT,
    last_cleanup_at TIMESTAMPTZ,
    enabled BOOLEAN DEFAULT true
);

INSERT INTO data_retention_policies VALUES
    ('price_history', 'raw', 90, NULL, true),
    ('price_history_rollups', '1m', 365, NULL, true);

-- Batched cleanup function
CREATE OR REPLACE FUNCTION cleanup_old_data() RETURNS void AS $$
DECLARE
    deleted_count INT;
BEGIN
    -- Clean raw ticks (keep 90 days)
    LOOP
        WITH to_delete AS (
            SELECT ctid FROM price_history
            WHERE created_at < NOW() - INTERVAL '90 days'
            LIMIT 10000
        )
        DELETE FROM price_history
        WHERE ctid IN (SELECT ctid FROM to_delete);
        
        GET DIAGNOSTICS deleted_count = ROW_COUNT;
        EXIT WHEN deleted_count = 0;
        PERFORM pg_sleep(1);
    END LOOP;

    -- Clean 1m rollups (keep 365 days)
    LOOP
        DELETE FROM price_history_rollups_1m
        WHERE bucket_start < NOW() - INTERVAL '365 days'
        AND ctid IN (
            SELECT ctid FROM price_history_rollups_1m
            WHERE bucket_start < NOW() - INTERVAL '365 days'
            LIMIT 10000
        );
        
        GET DIAGNOSTICS deleted_count = ROW_COUNT;
        EXIT WHEN deleted_count = 0;
        PERFORM pg_sleep(1);
    END LOOP;

    UPDATE data_retention_policies SET last_cleanup_at = NOW();
END;
$$ LANGUAGE plpgsql;

-- Run daily at 2 AM
SELECT cron.schedule('0 2 * * *', 'SELECT cleanup_old_data()');

-- ======================
-- FAILED INSERTS DLQ
-- ======================

CREATE TABLE failed_price_inserts (
    id SERIAL PRIMARY KEY,
    coin_id INT,
    price NUMERIC(12, 4),
    attempted_at TIMESTAMPTZ DEFAULT NOW(),
    error_message TEXT,
    retry_count INT DEFAULT 0,
    resolved BOOLEAN DEFAULT false
);

CREATE INDEX idx_failed_inserts_unresolved ON failed_price_inserts(attempted_at) WHERE NOT resolved;

-- ======================
-- MARKET HISTORY INDEXES
-- ======================

-- Add missing index to market_history
CREATE INDEX IF NOT EXISTS idx_market_history_created_at ON market_history(created_at DESC);
```

---

## Migration Plan

### Phase 1: Immediate Fixes (Day 1, Zero Downtime)

**Step 1: Disable auto-cleanup**

```sql
-- Find and disable the cleanup cron job
SELECT cron.unschedule(schedule_id) 
FROM cron.job 
WHERE command LIKE '%cleanup_price_history%';

-- Drop the cleanup function (optional)
DROP FUNCTION IF EXISTS cleanup_price_history();
```

**Step 2: Rename column (if `recorded_at` exists)**

```bash
psql -c "ALTER TABLE price_history RENAME COLUMN recorded_at TO created_at;" 2>/dev/null || echo "Column already named created_at"
```

**Step 3: Add index to market_history**

```sql
CREATE INDEX CONCURRENTLY idx_market_history_created_at ON market_history(created_at DESC);
```

### Phase 2: Schema Enhancements (Week 1)

**Step 1: Add covering index**

```sql
-- Drop old index
DROP INDEX IF EXISTS idx_price_history_coin_timestamp;

-- Create covering index (concurrent to avoid locking)
CREATE INDEX CONCURRENTLY idx_price_history_covering 
ON price_history(coin_id, created_at DESC) INCLUDE (price);
```

**Step 2: Change to TIMESTAMPTZ**

```sql
-- Backup first!
CREATE TABLE price_history_backup AS SELECT * FROM price_history;

-- Convert
ALTER TABLE price_history 
ALTER COLUMN created_at TYPE TIMESTAMPTZ 
USING created_at AT TIME ZONE 'UTC';
```

**Step 3: Update unique constraint**

```sql
ALTER TABLE price_history DROP CONSTRAINT IF EXISTS unique_coin_timestamp;
ALTER TABLE price_history ADD CONSTRAINT unique_coin_timestamp_us UNIQUE (coin_id, created_at);
```

### Phase 3: Rollup Tables (Week 2-3)

**Step 1: Create rollup tables** (run schema SQL above)

**Step 2: Backfill historical data**

```bash
# Backfill 1m rollups for existing data
psql -c "SELECT compute_1m_rollups_backfill()"

# Then cascade to hourly and daily
psql -c "SELECT compute_1h_rollups_backfill()"
psql -c "SELECT compute_1d_rollups_backfill()"
```

**Step 3: Enable cron jobs**

Already included in schema SQL.

### Phase 4: Partitioning (Week 4-5, Optional)

**Dual-write approach:**

1. Create partitioned table `price_history_new`
2. Modify insert statements to write to both tables
3. Backfill `price_history_new` from `price_history`
4. Switch reads to `price_history_new`
5. Verify for 1 week
6. Rename tables (requires brief downtime)

**Rollback plan:** Keep `price_history_old` for 30 days.

### Phase 5: API v2 Deployment (Week 6)

1. Deploy v2 endpoints under `/api/v2/coins/:coinId/price-history`
2. Update frontend to use v2
3. Monitor for 2 weeks
4. Deprecate v1 with 6-month sunset notice

---

## API Specs (OpenAPI 3.0 Excerpt)

```yaml
openapi: 3.0.0
info:
  title: Coins Price History API v2
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
        - name: interval
          in: query
          schema:
            type: string
            enum: [raw, 1m, 5m, 1h, 1d]
            default: 1h
          description: Aggregation interval
        - name: from
          in: query
          schema:
            type: string
            format: date-time
          description: Start timestamp (ISO8601)
        - name: to
          in: query
          schema:
            type: string
            format: date-time
          description: End timestamp (ISO8601)
        - name: limit
          in: query
          schema:
            type: integer
            minimum: 1
            maximum: 5000
            default: 1000
          description: Maximum data points
        - name: format
          in: query
          schema:
            type: string
            enum: [ohlc, line, compact]
            default: ohlc
          description: Response format
      responses:
        '200':
          description: Success
          content:
            application/json:
              schema:
                oneOf:
                  - $ref: '#/components/schemas/OHLCResponse'
                  - $ref: '#/components/schemas/LineResponse'
                  - $ref: '#/components/schemas/CompactResponse'
        '400':
          description: Invalid parameters
        '404':
          description: Coin not found
        '429':
          description: Rate limit exceeded

components:
  schemas:
    OHLCResponse:
      type: object
      properties:
        meta:
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
            count:
              type: integer
            has_more:
              type: boolean
        data:
          type: array
          items:
            type: object
            properties:
              t:
                type: string
                format: date-time
              o:
                type: number
                format: float
              h:
                type: number
                format: float
              l:
                type: number
                format: float
              c:
                type: number
                format: float
              v:
                type: number
                format: float
              n:
                type: integer
```

---

## Test Plan

### 1. Unit Tests (Jest)

**File:** `__tests__/price-history-v2.test.js`

```javascript
describe('Price History V2 API', () => {
  describe('GET /api/v2/coins/:coinId/price-history', () => {
    test('returns OHLC data for 1h interval', async () => {
      const res = await request(app)
        .get('/api/v2/coins/1/price-history?interval=1h&format=ohlc')
        .expect(200);
      
      expect(res.body).toHaveProperty('meta');
      expect(res.body.meta.interval).toBe('1h');
      expect(res.body.data).toBeInstanceOf(Array);
      expect(res.body.data[0]).toHaveProperty('o');
      expect(res.body.data[0]).toHaveProperty('h');
      expect(res.body.data[0]).toHaveProperty('l');
      expect(res.body.data[0]).toHaveProperty('c');
    });

    test('returns line data for raw interval', async () => {
      const res = await request(app)
        .get('/api/v2/coins/1/price-history?interval=raw&format=line&limit=10')
        .expect(200);
      
      expect(res.body.data).toBeInstanceOf(Array);
      expect(res.body.data[0]).toHaveLength(2); // [timestamp, price]
      expect(typeof res.body.data[0][0]).toBe('string');
      expect(typeof res.body.data[0][1]).toBe('number');
    });

    test('validates interval parameter', async () => {
      await request(app)
        .get('/api/v2/coins/1/price-history?interval=invalid')
        .expect(400);
    });

    test('validates limit bounds', async () => {
      await request(app)
        .get('/api/v2/coins/1/price-history?limit=10000')
        .expect(400);
    });

    test('returns 404 for non-existent coin', async () => {
      await request(app)
        .get('/api/v2/coins/999999/price-history')
        .expect(404);
    });

    test('handles from/to timestamps', async () => {
      const from = new Date(Date.now() - 3600000).toISOString();
      const to = new Date().toISOString();
      
      const res = await request(app)
        .get(`/api/v2/coins/1/price-history?from=${from}&to=${to}`)
        .expect(200);
      
      expect(res.body.meta.from).toBe(from);
      expect(res.body.meta.to).toBe(to);
    });

    test('includes cache headers', async () => {
      const res = await request(app)
        .get('/api/v2/coins/1/price-history?interval=1h')
        .expect(200);
      
      expect(res.headers['cache-control']).toMatch(/max-age=/);
    });
  });

  describe('Rollup computation', () => {
    test('compute_1m_rollups generates correct OHLC', async () => {
      // Insert test data
      await db.query(`
        INSERT INTO price_history (coin_id, price, created_at) VALUES
        (1, 100.0, '2025-11-02 10:00:00'),
        (1, 102.0, '2025-11-02 10:00:15'),
        (1, 99.0, '2025-11-02 10:00:30'),
        (1, 101.0, '2025-11-02 10:00:45')
      `);

      // Run rollup
      await db.query('SELECT compute_1m_rollups()');

      // Verify
      const result = await db.query(`
        SELECT * FROM price_history_rollups_1m 
        WHERE coin_id = 1 AND bucket_start = '2025-11-02 10:00:00'
      `);

      expect(result.rows.length).toBe(1);
      expect(parseFloat(result.rows[0].open)).toBe(100.0);
      expect(parseFloat(result.rows[0].high)).toBe(102.0);
      expect(parseFloat(result.rows[0].low)).toBe(99.0);
      expect(parseFloat(result.rows[0].close)).toBe(101.0);
      expect(result.rows[0].tick_count).toBe(4);
    });
  });

  describe('Performance', () => {
    test('query completes under 100ms for 1000 rows', async () => {
      const start = Date.now();
      await request(app)
        .get('/api/v2/coins/1/price-history?limit=1000')
        .expect(200);
      const duration = Date.now() - start;
      
      expect(duration).toBeLessThan(100);
    });
  });
});
```

### 2. Load Tests (k6)

**File:** `load-tests/price-history.js`

```javascript
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '30s', target: 10 },  // Ramp up
    { duration: '1m', target: 50 },   // Sustained load
    { duration: '30s', target: 0 },   // Ramp down
  ],
  thresholds: {
    http_req_duration: ['p(95)<200', 'p(99)<500'], // 95th <200ms, 99th <500ms
    http_req_failed: ['rate<0.01'], // <1% errors
  },
};

export default function () {
  const coinId = Math.floor(Math.random() * 10) + 1;
  const intervals = ['1h', '1d'];
  const interval = intervals[Math.floor(Math.random() * intervals.length)];

  const res = http.get(`http://localhost:3000/api/v2/coins/${coinId}/price-history?interval=${interval}`);
  
  check(res, {
    'status is 200': (r) => r.status === 200,
    'has data': (r) => JSON.parse(r.body).data.length > 0,
  });

  sleep(1);
}
```

Run: `k6 run load-tests/price-history.js`

### 3. Contract Tests

Ensure API contract doesn't break:

```javascript
describe('API Contract', () => {
  test('OHLC response matches schema', async () => {
    const res = await request(app)
      .get('/api/v2/coins/1/price-history?format=ohlc')
      .expect(200);
    
    const schema = {
      meta: {
        coin_id: 'number',
        symbol: 'string',
        name: 'string',
        interval: 'string',
        from: 'string',
        to: 'string',
        count: 'number',
        has_more: 'boolean'
      },
      data: [
        { t: 'string', o: 'number', h: 'number', l: 'number', c: 'number', v: 'number', n: 'number' }
      ]
    };

    validateSchema(res.body, schema);
  });
});
```

---

## Benchmark Plan

### Test Environment

- PostgreSQL 14+ on dedicated instance
- 4 vCPU, 8GB RAM
- Dataset: 1M rows in `price_history`, 100K rows in rollups

### Test Queries

**Q1: Fetch last 100 raw ticks for coin 1**

```sql
SELECT created_at, price 
FROM price_history 
WHERE coin_id = 1 
ORDER BY created_at DESC 
LIMIT 100;
```

**Target:** <10ms (p50), <25ms (p95)

**Q2: Fetch 24h of hourly candles**

```sql
SELECT bucket_start, open, high, low, close 
FROM price_history_rollups_1h 
WHERE coin_id = 1 
  AND bucket_start >= NOW() - INTERVAL '24 hours' 
ORDER BY bucket_start ASC;
```

**Target:** <15ms (p50), <40ms (p95)

**Q3: Count all rows in 90-day window**

```sql
SELECT COUNT(*) FROM price_history 
WHERE created_at >= NOW() - INTERVAL '90 days';
```

**Target:** <100ms (p50), <300ms (p95)

### Benchmarking Tool

```bash
# Use pgbench
pgbench -c 10 -j 2 -T 60 -f query1.sql -n coins_x
```

Or use `hyperfine`:

```bash
hyperfine --warmup 5 --runs 50 "psql -c 'SELECT ...'"
```

---

# Sample Responses (Ready for Frontend)

## 1. Line Chart (1-hour interval, last 24 hours)

**Request:**
```
GET /api/v2/coins/4/price-history?interval=1h&format=line&from=2025-11-01T00:00:00Z&to=2025-11-02T00:00:00Z
```

**Response:**
```json
{
  "meta": {
    "coin_id": 4,
    "symbol": "NVC",
    "name": "NovaCash",
    "interval": "1h",
    "from": "2025-11-01T00:00:00.000Z",
    "to": "2025-11-02T00:00:00.000Z",
    "count": 24,
    "has_more": false
  },
  "data": [
    ["2025-11-01T00:00:00.000Z", 92.10],
    ["2025-11-01T01:00:00.000Z", 91.75],
    ["2025-11-01T02:00:00.000Z", 92.35],
    ["2025-11-01T03:00:00.000Z", 93.00],
    ["2025-11-01T04:00:00.000Z", 92.80],
    ["2025-11-01T05:00:00.000Z", 93.15],
    ["2025-11-01T06:00:00.000Z", 94.20],
    ["2025-11-01T07:00:00.000Z", 94.50],
    ["2025-11-01T08:00:00.000Z", 93.90],
    ["2025-11-01T09:00:00.000Z", 94.10],
    ["2025-11-01T10:00:00.000Z", 95.00],
    ["2025-11-01T11:00:00.000Z", 95.30],
    ["2025-11-01T12:00:00.000Z", 94.80],
    ["2025-11-01T13:00:00.000Z", 95.20],
    ["2025-11-01T14:00:00.000Z", 96.00],
    ["2025-11-01T15:00:00.000Z", 95.50],
    ["2025-11-01T16:00:00.000Z", 95.80],
    ["2025-11-01T17:00:00.000Z", 96.20],
    ["2025-11-01T18:00:00.000Z", 96.50],
    ["2025-11-01T19:00:00.000Z", 97.00],
    ["2025-11-01T20:00:00.000Z", 96.80],
    ["2025-11-01T21:00:00.000Z", 97.20],
    ["2025-11-01T22:00:00.000Z", 97.50],
    ["2025-11-01T23:00:00.000Z", 97.30]
  ]
}
```

**Frontend Integration (Chart.js):**

```javascript
const response = await fetch('/api/v2/coins/4/price-history?interval=1h&format=line');
const { meta, data } = await response.json();

const chart = new Chart(ctx, {
  type: 'line',
  data: {
    labels: data.map(d => new Date(d[0])),
    datasets: [{
      label: meta.symbol,
      data: data.map(d => d[1]),
      borderColor: 'rgb(75, 192, 192)',
      tension: 0.1
    }]
  },
  options: {
    scales: {
      x: { type: 'time' }
    }
  }
});
```

## 2. OHLC Candles (1-day interval, last 30 days)

**Request:**
```
GET /api/v2/coins/4/price-history?interval=1d&format=ohlc&from=2025-10-02T00:00:00Z&to=2025-11-02T00:00:00Z
```

**Response:**
```json
{
  "meta": {
    "coin_id": 4,
    "symbol": "NVC",
    "name": "NovaCash",
    "interval": "1d",
    "from": "2025-10-02T00:00:00.000Z",
    "to": "2025-11-02T00:00:00.000Z",
    "count": 31,
    "has_more": false
  },
  "data": [
    {
      "t": "2025-10-02T00:00:00.000Z",
      "o": 88.50,
      "h": 90.20,
      "l": 87.80,
      "c": 89.10,
      "v": 0,
      "n": 2880
    },
    {
      "t": "2025-10-03T00:00:00.000Z",
      "o": 89.15,
      "h": 91.00,
      "l": 88.50,
      "c": 90.40,
      "v": 0,
      "n": 2880
    },
    {
      "t": "2025-10-04T00:00:00.000Z",
      "o": 90.40,
      "h": 92.80,
      "l": 89.90,
      "c": 92.10,
      "v": 0,
      "n": 2880
    }
  ]
}
```

**Frontend Integration (TradingView Lightweight Charts):**

```javascript
const response = await fetch('/api/v2/coins/4/price-history?interval=1d&format=ohlc');
const { data } = await response.json();

const candleData = data.map(candle => ({
  time: new Date(candle.t).getTime() / 1000, // Unix timestamp
  open: candle.o,
  high: candle.h,
  low: candle.l,
  close: candle.c
}));

const chart = LightweightCharts.createChart(container);
const candleSeries = chart.addCandlestickSeries();
candleSeries.setData(candleData);
```

## 3. Paginated Cursor Example (Raw Ticks)

**Request (First Page):**
```
GET /api/v2/coins/4/price-history?interval=raw&limit=10&format=line
```

**Response:**
```json
{
  "meta": {
    "coin_id": 4,
    "symbol": "NVC",
    "interval": "raw",
    "count": 10,
    "has_more": true,
    "next_cursor": "2025-11-02T10:28:30.000Z"
  },
  "data": [
    ["2025-11-02T10:30:00.000Z", 97.30],
    ["2025-11-02T10:29:30.000Z", 97.25],
    ["2025-11-02T10:29:00.000Z", 97.20],
    ["2025-11-02T10:28:30.000Z", 97.15]
  ]
}
```

**Request (Next Page):**
```
GET /api/v2/coins/4/price-history?interval=raw&limit=10&format=line&to=2025-11-02T10:28:30.000Z
```

**Response:**
```json
{
  "meta": {
    "coin_id": 4,
    "symbol": "NVC",
    "interval": "raw",
    "count": 10,
    "has_more": true,
    "next_cursor": "2025-11-02T10:27:00.000Z"
  },
  "data": [
    ["2025-11-02T10:28:00.000Z", 97.10],
    ["2025-11-02T10:27:30.000Z", 97.05],
    ["2025-11-02T10:27:00.000Z", 97.00]
  ]
}
```

**Frontend Integration:**

```javascript
async function loadAllHistory(coinId) {
  let allData = [];
  let cursor = null;

  while (true) {
    const url = cursor 
      ? `/api/v2/coins/${coinId}/price-history?interval=raw&limit=100&to=${cursor}`
      : `/api/v2/coins/${coinId}/price-history?interval=raw&limit=100`;
    
    const response = await fetch(url);
    const { meta, data } = await response.json();
    
    allData.push(...data);
    
    if (!meta.has_more) break;
    cursor = meta.next_cursor;
  }

  return allData;
}
```

---

# Risks, Trade-offs, and Alternatives

## Trade-offs

### 1. Storage vs Query Speed

**Rollup tables add storage overhead:**
- Raw data: 1M rows × 24 bytes = ~24 MB
- 1m rollups: 525K rows × 48 bytes = ~25 MB
- 1h rollups: 8.7K rows × 48 bytes = ~417 KB
- 1d rollups: 365 rows × 48 bytes = ~17 KB
- **Total:** ~50 MB (2x raw data size)

**But:**
- Query speed improves 10-100×
- Network bandwidth reduced (fewer rows returned)
- Frontend CPU usage reduced (no client-side aggregation)

**Verdict:** Storage is cheap, latency is expensive. **Recommended.**

### 2. Real-Time vs Delayed Rollups

**Options:**
1. **Delayed (recommended):** Compute rollups 1-2 minutes after bucket closes
   - Pros: Simple, complete data
   - Cons: Slight delay in historical charts

2. **Real-time:** Update rollups on every insert
   - Pros: Instant availability
   - Cons: Complex (need to update existing buckets), high write amplification

**Verdict:** Use delayed rollups. For "live" data, query raw `price_history` table.

### 3. Partitioning Complexity

**Pros:**
- Faster queries (partition pruning)
- Instant old data deletion
- Better VACUUM performance

**Cons:**
- Requires partition management (auto-creation, monitoring)
- Schema changes more complex
- Foreign keys require extra setup

**Verdict:** **Recommended for production**, but can be postponed if team lacks PostgreSQL expertise.

### 4. Caching Layer Overhead

**Redis adds:**
- Extra infrastructure to manage
- Potential cache invalidation bugs
- Memory costs

**But saves:**
- 90%+ database load
- Sub-10ms API response times
- Better user experience

**Verdict:** **Highly recommended.** Start with simple TTL-based caching.

## Alternatives

### Alternative 1: TimescaleDB

**Pros:**
- Built for time-series
- Automatic chunk management
- Transparent compression (10× space savings)
- Continuous aggregates (auto-updating rollups)

**Cons:**
- Requires PostgreSQL extension
- Less common in hosting providers
- Additional learning curve

**When to use:** If already comfortable with PostgreSQL extensions and expect to scale to 100M+ rows.

### Alternative 2: InfluxDB / Prometheus

**Pros:**
- Purpose-built for time-series
- Excellent compression
- Built-in downsampling

**Cons:**
- Separate database to manage
- Different query language
- Adds operational complexity

**When to use:** If building a dedicated monitoring/analytics platform.

### Alternative 3: DuckDB + Parquet

**Pros:**
- Columnar storage (excellent compression)
- Fast analytical queries
- Easy to export/archive

**Cons:**
- Write-once, read-many (not suited for frequent updates)
- Additional tooling needed

**When to use:** For historical data archives (>1 year old) that rarely change.

### Alternative 4: Client-Side Aggregation

**Pros:**
- Simplest backend implementation
- No rollup tables needed

**Cons:**
- High network bandwidth
- High frontend CPU usage
- Poor mobile experience
- Unpredictable query times

**When to use:** Never. This is an antipattern for time-series data.

---

# Appendix

## A. Code Snippets from Current Repo

### Current Price History Query

**File:** `/models/coins.model.js:257-343`

```javascript
exports.getCoinPriceHistory = async (coinId, page = 1, limit = 10, timeRange = '30M') => {
  const offset = (page - 1) * limit;
  const timeRangeMs = TIME_RANGES[timeRange] || TIME_RANGES['30M'];

  const timeFilter = timeRangeMs ? 
    `AND ph.created_at >= NOW() - INTERVAL '${timeRangeMs / 1000} seconds'` : '';

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

  const totalItems = parseInt(countResult.rows[0].count);
  const totalPages = Math.ceil(totalItems / limit);

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
};
```

### Price Insert (Market Simulator)

**File:** `/models/market-simulator.js:276-310`

```javascript
async updateAllPrices() {
  try {
    const result = await db.query('SELECT coin_id, current_price FROM coins');
    const coins = result.rows;
    const updates = [];
    let totalMarketValue = 0;

    for (const coin of coins) {
      const newPrice = this.calculateNewPrice(parseFloat(coin.current_price), coin.coin_id);
      
      updates.push(db.query(
        'UPDATE coins SET current_price = $1 WHERE coin_id = $2',
        [newPrice, coin.coin_id]
      ));
      
      updates.push(db.query(
        'INSERT INTO price_history (coin_id, price) VALUES ($1, $2)',
        [coin.coin_id, newPrice]
      ));
      
      totalMarketValue += newPrice;
    }

    updates.push(db.query(
      'INSERT INTO market_history (total_value, market_trend) VALUES ($1, $2)',
      [totalMarketValue, this.currentCycle?.type || 'STABLE']
    ));

    await Promise.all(updates);
  } catch (error) {
    logger.error('[MARKET] Error updating prices:', error);
  }
}
```

## B. File Paths Inspected

- `/db/migrations/003_create_price_history.sql` - Price history table schema
- `/db/migrations/20250223_create_market_history.sql` - Market history table
- `/controllers/coins.controller.js:164-207` - getPriceHistory handler
- `/controllers/market.controller.js:55-93` - getMarketPriceHistory handler
- `/models/coins.model.js:52-116` - get24HourPriceChange (N+1 query)
- `/models/coins.model.js:257-343` - getCoinPriceHistory implementation
- `/models/market-simulator.js:276-310` - Price update loop
- `/routes/coins.routes.js:14` - Price history route definition
- `/__tests__/price-history.test.js` - Current test suite
- `/API_DOCUMENTATION.md:133-178` - Current API documentation

## C. Key Findings Summary

| Category | Current State | Severity | Recommendation |
|----------|---------------|----------|----------------|
| **Auto-cleanup** | Deletes data >24h | 🔴 Critical | Disable immediately |
| **Column naming** | `recorded_at` vs `created_at` | 🟠 High | Standardize to `created_at` |
| **Timestamp type** | `TIMESTAMP` (no TZ) | 🟠 High | Change to `TIMESTAMPTZ` |
| **N+1 queries** | 3 queries per coin | 🟠 High | Use window functions |
| **No aggregation** | Only raw ticks | 🟠 High | Add rollup tables |
| **Pagination** | `OFFSET`-based | 🟡 Medium | Use cursor pagination |
| **No caching** | Every query hits DB | 🟡 Medium | Add Redis |
| **Currency formatting** | In database layer | 🟡 Medium | Move to frontend |
| **No rate limiting** | Unlimited requests | 🟡 Medium | Add rate limiter |
| **Partitioning** | None | 🟢 Low | Optional optimization |

---

**End of Report**

---

# Conclusions Round 1

## What I Reviewed

- Peer reports found:
  - `llm-opinions/claude.codes/claude.codes_round1.md` (Claude)
  - `llm-opinions/codex/codex_round1.md` (Codex/GPT)
- Missing reports: None found (gemini folder exists but is empty)

## Key Agreements & Disagreements (TL;DR)

### Agreements
- **Critical issue identification**: All three identified the 24h auto-cleanup as the most critical flaw destroying historical data
- **TimescaleDB adoption**: All strongly recommend TimescaleDB hypertables with compression and continuous aggregates
- **TIMESTAMPTZ mandate**: All recommend switching from `TIMESTAMP` to `TIMESTAMPTZ` for UTC consistency
- **OHLC candles**: All recommend server-side OHLC aggregation (Open/High/Low/Close/Volume) for chart-ready data
- **Retention tiering**: All propose 90-day raw tick retention with longer retention for aggregates (1y+ for hourly/daily)
- **N+1 query elimination**: All identified the `selectAllCoins` N+1 pattern and recommend window functions or materialized views
- **Redis caching**: All recommend Redis with TTL-based caching (30-60s for hot queries)
- **Dual-write migration**: All propose parallel write phases with backfill and gradual cutover to new schema
- **Cursor pagination**: All recommend cursor-based pagination over OFFSET for time-series queries
- **Numeric precision for JSON**: All recommend returning raw numeric values instead of GBP-formatted strings

### Disagreements

1. **Decimal precision**
   - **Me (Cursor)**: `NUMERIC(12,4)` (8 digits + 4 decimals, max ~99M per coin)
   - **Claude**: `NUMERIC(28,10)` (18 digits + 10 decimals)
   - **Codex**: `NUMERIC(38,12)` (26 digits + 12 decimals)
   - **Rationale**: Claude and Codex optimize for extreme precision (sub-satoshi, high-value assets); I balanced precision vs storage (4 decimals = 0.0001 precision sufficient for most crypto). Codex's 38 total digits is PostgreSQL's max but overkill for this use case.

2. **Interval granularity**
   - **Me**: raw, 1m, 5m, 1h, 1d (5 intervals)
   - **Claude**: raw (30s), 1m, 1h, 1d (4 intervals)
   - **Codex**: tick, 1m, 5m, 15m, 1h, 4h, 1d (7 intervals)
   - **Rationale**: Codex includes 15m and 4h for finer control, which adds storage complexity but better serves diverse charting needs. I included 5m as a pragmatic middle ground; Claude skips it for simplicity.

3. **Primary key design**
   - **Me**: `(coin_id, ts)`
   - **Claude**: `(coin_id, ts)` with unique constraint
   - **Codex**: `(coin_id, ts, source)` — includes source field for multi-feed deduping
   - **Rationale**: Codex's approach is more robust for production systems ingesting from multiple data sources (exchanges, APIs, internal simulator). My design assumes single source; Codex's is future-proof.

4. **Response format options**
   - **Me**: 3 formats (ohlc, line, compact)
   - **Claude**: 2 formats (ohlc, line with both ISO and epoch timestamps)
   - **Codex**: 2 formats (line as arrays, ohlc as objects) with simpler metadata
   - **Rationale**: I added a "compact" columnar format to reduce JSON overhead for large responses. Claude's dual timestamp approach (ISO + epoch) is more developer-friendly. Codex keeps it minimal.

5. **Partitioning strategy**
   - **Me**: Showed TimescaleDB *and* native Postgres partitioning alternatives (RANGE by month)
   - **Claude**: TimescaleDB-first with native partitioning as fallback mention
   - **Codex**: TimescaleDB-first with native partitioning as explicit alternative
   - **Rationale**: I provided more detailed native Postgres examples for teams avoiding extensions. Claude and Codex are more opinionated toward TimescaleDB.

6. **Rollup table design**
   - **Me**: Single `price_history_rollups` table with LIST partitioning by `interval_type`
   - **Claude**: Separate materialized views per interval (`price_ohlc_1m`, `price_ohlc_1h`, etc.)
   - **Codex**: Single continuous aggregate view `coin_price_1m` with rollup logic
   - **Rationale**: Claude's approach is cleanest for TimescaleDB; my unified table works for both TimescaleDB and native Postgres; Codex focuses on the 1m aggregate as the foundation.

## Comparison Snapshot

| Dimension | My R1 Position | Best Peer Position | Notes |
|-----------|---------------|-------------------|-------|
| **Decimal precision** | `NUMERIC(12,4)` | **Codex: `NUMERIC(38,12)`** | Codex future-proofs for high-precision assets; my 12,4 is adequate for current scope but may need adjustment |
| **Partitioning** | TimescaleDB + native alternatives | **Tie: All three** | I provided most detail on native Postgres fallback |
| **Intervals** | raw, 1m, 5m, 1h, 1d | **Codex: +15m, +4h** | 15m useful for intraday, 4h for swing trading; Codex wins on flexibility |
| **Primary Key** | `(coin_id, ts)` | **Codex: `(coin_id, ts, source)`** | Source field critical for multi-feed systems; Codex is more production-ready |
| **API response formats** | 3 formats (ohlc, line, compact) | **Me: compact format**, **Claude: dual timestamps** | My compact format best for bandwidth; Claude's dual timestamps best for DX |
| **Caching strategy** | Redis with middleware + HTTP headers | **Claude: Most detailed** (ETags, cache keys, invalidation rules) | Claude provides most comprehensive caching design |
| **Migration plan** | 4 phases with rollback | **Claude: Most detailed** (includes error thresholds, auto-rollback triggers) | Claude's rollback automation is superior |
| **N+1 fix** | Window function SQL | **Claude: Materialized view `coin_stats_24h`** | Claude's materialized view is more maintainable than runtime window functions |
| **Test coverage** | Unit + contract + load (k6) | **Tie: All three** | All provide comprehensive test plans |
| **Retention policies** | 90d raw, 1y 1m, forever 1h+ | **Claude: Most detailed** (includes 5y retention for 1h) | Claude's tiering is most granular |

## Final Recommendation

After reviewing peer analyses, my **final recommended approach** synthesizes the best ideas:

### Data Model
- **Schema**: Adopt **Codex's PK design** with `(coin_id, ts, source)` for multi-source support
- **Types**: Use **NUMERIC(18,8)** (compromise between my 12,4 and peers' 28,10 / 38,12) for 8 decimal precision, supporting sub-penny assets while avoiding storage bloat
- **Timestamps**: **TIMESTAMPTZ** (UTC) mandatory, with microsecond precision via `CURRENT_TIMESTAMP(6)`
- **Partitioning**: **TimescaleDB hypertables** (7-day chunks) with compression after 7 days; fallback to native monthly range partitioning if extension unavailable
- **Indexes**: Covering index `(coin_id, ts DESC) INCLUDE (price)` for fast recency queries; BRIN index on `ts` for range scans

### Aggregation Strategy
- **Intervals**: Adopt **Codex's 7-interval model**: `tick`, `1m`, `5m`, `15m`, `1h`, `4h`, `1d` for maximum charting flexibility
- **Rollups**: Use **Claude's separate materialized view approach** (`price_ohlc_1m`, `price_ohlc_1h`, etc.) for clarity, powered by TimescaleDB continuous aggregates
- **Refresh policy**: 1m views refresh every 1 minute, 1h every hour, 1d daily at midnight
- **Fields**: Include `open`, `high`, `low`, `close`, `volume`, `tick_count`, `first_ts`, `last_ts` per candle

### API v2 Contract
- **Endpoint**: `GET /api/v2/coins/:coinId/price-history`
- **Params**: 
  - `interval`: `tick|1m|5m|15m|1h|4h|1d` (default: `auto` = server selects optimal)
  - `from`, `to`: ISO8601 UTC timestamps
  - `limit`: 1-5000 (default 1000)
  - `format`: `ohlc|line|compact` (default: `ohlc` for intervals, `line` for tick)
- **Response**: Return numeric prices (no currency formatting), ISO timestamps in metadata, epoch milliseconds in data arrays
- **Pagination**: Cursor-based via `next_cursor` field containing `(coin_id, ts)` tuple

### Indexing & Caching
- **Indexes**: Composite `(coin_id, ts DESC) INCLUDE (price)`, plus BRIN on `ts` for partitioned tables
- **Redis**: Cache hot queries (last 1h, last 24h for top 10 coins) with 30s TTL; use **Claude's ETag strategy** for conditional requests
- **HTTP headers**: `Cache-Control: public, max-age=30` for recent data, `max-age=3600` for historical; `ETag` for 304 responses

### Retention & Lifecycle
- **Raw ticks**: 90 days (compressed after 7 days)
- **1m aggregates**: 1 year
- **5m-15m aggregates**: 2 years
- **1h aggregates**: 5 years (per **Claude's recommendation**)
- **4h-1d aggregates**: Forever
- **Compression**: TimescaleDB native compression with `segmentby = coin_id`, `orderby = ts DESC`
- **Cleanup**: Automated retention policies via TimescaleDB or pg_cron batch deletions (10k rows/batch with 1s sleep)

### Migration & Rollout
1. **Phase 1 (Week 1)**: Create new `coin_price_ticks` hypertable + continuous aggregates without touching production endpoints
2. **Phase 2 (Week 2-3)**: Implement dual-write to both old and new tables; backfill historical data in chronological batches
3. **Phase 3 (Week 4)**: Deploy API v2 reading from new schema; validate parity with v1 for 7 days
4. **Phase 4 (Week 5)**: Cutover v1 to read from new tables; deprecate old schema with 90-day sunset
5. **Rollback**: Keep old table for 30 days post-cutover; auto-revert if error rate >5% for 10 minutes (adopt **Claude's automated rollback**)

### If Changed My Mind

**What changed**: I now recommend **NUMERIC(18,8)** instead of my original `NUMERIC(12,4)`, and I adopt **Codex's `(coin_id, ts, source)` primary key** instead of my simpler `(coin_id, ts)`.

**Why**: 
- **Codex's precision argument** (38,12) made me reconsider sub-penny asset support. While 38 digits is excessive, 18,8 (supporting prices up to 999M with 8 decimal places) handles Bitcoin fractions, stablecoins, and meme coins without storage waste. My original 12,4 would truncate assets trading at $0.00001.
- **Codex's source field insight** is critical for production robustness. If the system later ingests from multiple exchanges or APIs, `(coin_id, ts)` alone will cause conflicts. Adding `source` now costs 2 bytes per row but prevents a painful migration later. This is a **defensive design pattern** I should have included initially.

## Pros & Cons of the Final Approach

### Pros
1. **Production-grade schema**: Multi-source deduping via `source` field prevents conflicts in real-world deployments
2. **Optimal query latency**: Hypertable partitioning + continuous aggregates deliver sub-50ms p95 even with millions of rows
3. **Storage efficiency**: Native compression achieves ~80% reduction; tiered retention keeps costs predictable
4. **Chart-ready responses**: OHLC format eliminates client-side aggregation; compact format reduces bandwidth 40%
5. **Future-proof precision**: 8 decimal places support low-value assets and high-precision trading without excessive storage
6. **Graceful degradation**: Fallback to native Postgres partitioning if TimescaleDB unavailable
7. **Incremental migration**: Dual-write + validation phases minimize risk; automated rollback prevents disasters

### Cons
1. **Operational complexity**: TimescaleDB adds extension management, upgrade coordination, and specialized monitoring
2. **Storage overhead**: 7 interval types (tick + 6 aggregates) multiply storage ~3-4× despite compression
3. **Continuous aggregate lag**: Real-time queries may lag 1-2 minutes behind actual writes; requires hybrid read strategy (hot path for last hour + aggregates for history)
4. **Migration effort**: 5-week rollout with dual writes, backfills, and validation requires dedicated engineering time
5. **Developer onboarding**: Team must learn TimescaleDB-specific features (hypertables, compression policies, continuous aggregates)
6. **Cache invalidation complexity**: Redis cache keys per coin + interval + range require careful TTL tuning and purge strategies

## Actionable Next Steps (1–2 weeks)

### Week 1: Critical Fixes (Owner: Backend Lead, Effort: S-M)
1. **[S] Disable 24h auto-cleanup** (30 min)
   - Execute: `SELECT cron.unschedule(schedule_id) FROM cron.job WHERE command LIKE '%cleanup_price_history%'`
   - Acceptance: Verify no deletions occur for 48h; confirm data retention beyond 24h
   
2. **[S] Fix column name inconsistency** (1 hour)
   - Run migration: `ALTER TABLE price_history RENAME COLUMN recorded_at TO created_at` (if needed)
   - Update model code to use `created_at` consistently
   - Acceptance: All queries use `created_at`; no errors in logs

3. **[M] Add covering index** (2 hours)
   - Execute: `CREATE INDEX CONCURRENTLY idx_price_history_covering ON price_history(coin_id, created_at DESC) INCLUDE (price)`
   - Monitor: Verify query plans use covering index
   - Acceptance: Price history queries show "Index Only Scan" in `EXPLAIN ANALYZE`

4. **[M] Fix N+1 query in selectAllCoins** (4 hours)
   - Implement single-query 24h price change calculation using window functions (see Claude's example)
   - Load test: Compare before/after latency for `GET /api/coins` (10 coins)
   - Acceptance: Query count drops from 31 to 1; p95 latency <50ms

### Week 2: Schema Design & Proof of Concept (Owner: Backend + DBA, Effort: L)
5. **[L] Install TimescaleDB on dev/staging** (4 hours)
   - Install extension, verify version compatibility
   - Create test hypertable with sample data (1M rows)
   - Acceptance: Compression works; continuous aggregate refreshes correctly

6. **[L] Design final schema** (8 hours)
   - Finalize `coin_price_ticks` DDL with `(coin_id, ts, source)` PK and `NUMERIC(18,8)`
   - Write continuous aggregate SQL for 1m, 1h, 1d intervals
   - Draft retention + compression policies
   - Acceptance: Schema reviewed and approved by tech lead; migration scripts ready

7. **[M] Build backfill script** (6 hours)
   - Script to read `price_history` and insert into `coin_price_ticks` with `source=0`
   - Handle conflicts gracefully (`ON CONFLICT DO NOTHING`)
   - Acceptance: Script successfully backfills 100k test rows in <5 minutes

8. **[M] Spike API v2 endpoint** (8 hours)
   - Implement `/api/v2/coins/:coinId/price-history` with `interval`, `from`, `to`, `format` params
   - Return OHLC and line formats for 1h test data
   - Acceptance: Endpoint returns correct JSON schema; postman/curl tests pass

### Monitoring & Validation (Ongoing)
9. **[S] Set up query performance dashboard** (2 hours)
   - Log p50/p95 latency for price history queries
   - Alert if p95 >200ms
   - Acceptance: Grafana dashboard shows real-time query metrics

10. **[M] Document migration plan** (4 hours)
    - Write detailed runbook for dual-write, cutover, rollback
    - Include SQL snippets, validation queries, and rollback triggers
    - Acceptance: Document reviewed by team; ready for Phase 1 kickoff

---

**Total Estimated Effort**: ~40 hours (1 senior backend engineer + 0.25 DBA for 2 weeks)  
**Risk Level**: Medium (TimescaleDB adoption adds complexity but mitigated by fallback plan)  
**Expected Impact**: 10× query speedup, unlimited historical retention, chart-ready API responses

