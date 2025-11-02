# Executive Summary
- Price history is persisted as a single `price_history` heap table with `DECIMAL(20,2)` prices and `TIMESTAMP` timestamps (`db/seed.js:85-117`), which loses precision, lacks time zone context, and cannot scale to multi-year tick data without partitioning.
- `GET /api/coins/:coin_id/price-history` (`controllers/coins.controller.js:116-159`) wraps `models/coins.model.js:257-338`, executing `COUNT(*)` + `LIMIT/OFFSET` scans and returning verbose objects (`{ price_history_id, name, symbol, created_at }`) instead of chart-ready `[ts, price]` pairs.
- Coin lookups trigger per-request 24h change calculations (`models/coins.model.js:52-111`), producing N+1 queries over `price_history` for list responses and blocking price-history reads behind extra reads.
- Price ingestion is ad hoc: `updateCoinPrice` INSERTs a row after every PATCH (`models/coins.model.js:228-233`), and the market simulator writes every 30s (`models/market-simulator.js:292-314`) without idempotency, dedupe, or retention—millions of rows will accumulate quickly.
- Cleanup attempts delete rows older than 24h via `cleanup_price_history()` (`db/migrations/003_create_price_history.sql:21-34`), but the function references `recorded_at`, not the actual `created_at` column, so retention silently fails.
- Chart consumers must post-process GBP formatting and pagination metadata, slowing front-ends and wasting bandwidth.
- A TimescaleDB (or native partitioned) design with hypertables, continuous aggregates, and cursor-based APIs will cut query latency, reduce storage costs, and make chart payloads simple and cacheable.
- Rolling out requires dual writes, backfill scripts, and query fallbacks, but enables consistent ISO UTC timestamps, numerical JSON, and enforceable quotas/rate limits for heavy analytics endpoints.

# Current State (as implemented)
- **Route handlers**: `controllers/coins.controller.js:116-159` validates params, looks up the coin (calling `selectCoinById` → `get24HourPriceChange` with up to three extra queries per call), then returns `getCoinPriceHistory` data. Routes mounted under `/api/coins` (`routes/coins.routes.js:8-15`).
- **Query patterns & responses**: `models/coins.model.js:257-338` issues two statements: `SELECT COUNT(*) FROM price_history WHERE coin_id = $1 ...` and a joined select with `ORDER BY created_at DESC LIMIT $2 OFFSET $3`. Results are mapped to formatted GBP numbers and returned as `{ data: [...], pagination: { currentPage, totalPages, totalItems, hasMore } }`. Example payload today:\
  ```json
  {
    "data": [
      {
        "price_history_id": 1234,
        "coin_id": 4,
        "price": 92.1,
        "created_at": "2025-01-19T15:30:00.000Z",
        "name": "NovaCash",
        "symbol": "NVC"
      }
    ],
    "pagination": { "currentPage": 1, "totalPages": 42, "totalItems": 420, "hasMore": true }
  }
  ```
- **Database schema**: `price_history` uses `price_history_id SERIAL` PK, foreign key to `coins`, `price DECIMAL(20,2)`, `created_at TIMESTAMP` (`db/seed.js:85-90`). Indexes exist on `coin_id` and `created_at` individually (`db/seed.js:112-117`); there is no composite `(coin_id, created_at)` index, no partitioning, and no volume or source columns.
- **Data ingest/update flows**:\
  - `PATCH /api/coins/:coin_id/price` runs a transaction updating `coins.current_price` then inserts a history row with `CURRENT_TIMESTAMP` (`models/coins.model.js:210-235`).\
  - The market simulator updates every ~30s, pushing prices and inserting into `price_history` (`models/market-simulator.js:292-314`).\
  - `clear-price-history.js` truncates the table manually; no automated dedupe or backfill exists.\
  - Migration `003_create_price_history.sql` attempts hourly cron-based retention but references `recorded_at`, so deletions never run against the actual column.

# Problems & Risks
- Full-table `COUNT(*)` plus `OFFSET` pagination scales poorly beyond ~10⁵ rows per coin; latency grows with dataset size.
- Absence of a composite index or partitioning on `(coin_id, created_at)` forces repeated bitmap heap scans and bloats autovacuum.
- `DECIMAL(20,2)` truncates to cents; for low-priced assets or exchange feeds needing 6-10 decimals, precision is lost.
- `TIMESTAMP` (without time zone) relies on the DB server clock; cross-region replicas and clients may misinterpret values.
- GBP formatting at the persistence layer forces downstream consumers to strip formatting and breaks numeric aggregations.
- Retention function mismatch (`recorded_at` vs `created_at`) keeps data indefinitely, risking unbounded growth and TOAST/Autovacuum issues.
- No uniqueness constraint or dedupe—multiple ticks can share the same millisecond, leading to candle distortion.
- Shared transaction to compute 24h change and price history causes N+1 round-trips and hot contention on large lists.
- Lack of SLA, rate limiting, and consistent pagination invites abusive queries (e.g., requesting 100-item pages across multi-year ranges).

# Recommendations (Prioritized Roadmap)
1. **Schema redesign for time-series**  
   - Adopt a canonical `coin_price_ticks` table with `coin_id INT`, `ts TIMESTAMPTZ`, `price NUMERIC(38,12)`, `volume NUMERIC(38,12)`, `source SMALLINT`, `ingested_at TIMESTAMPTZ DEFAULT now()`; PK `(coin_id, ts, source)` guards against duplicates.  
   - On TimescaleDB: create a hypertable with 7-day chunks, enable native compression after 7 days, and set retention policies (raw ticks 90 days).  
   - On vanilla Postgres: range-partition by month with local BRIN indexes on `ts`, plus a global BTREE on `(coin_id, ts DESC)` for recency queries.
2. **Data modeling for charts**  
   - Store raw ticks separately from resampled aggregates. Maintain continuous aggregates/materialized tables for 1m, 5m, 15m, 1h, 4h, 1d OHLCV series.  
   - Use `OPEN`, `HIGH`, `LOW`, `CLOSE`, `volume`, `trade_count`, plus `first_ts`, `last_ts` metadata.  
   - Implement server-side downsampling using SQL rollups; expose both raw and aggregated endpoints, defaulting to aggregated data for wide ranges.
3. **API v2 for price history**  
   - Introduce `/api/v2/coins/:coinId/price-history` accepting query params `interval`, `from`, `to`, `limit`, `agg`.  
   - Return simple array payloads by default: line series as `[unix_ms, price]`; OHLC as `{ t, o, h, l, c, v }`.  
   - Support cursor pagination via `(coin_id, ts)` seek pagination; include `next_cursor` for forward paging.  
   - Enforce numeric JSON (no GBP strings) and ISO8601 UTC for metadata fields.
4. **Performance & Caching**  
   - Precompute hot aggregates via Timescale continuous aggregates or nightly materialized views; refresh asynchronously.  
   - Add Redis/KeyDB caching for top coins & recent windows (e.g., last 24h 1m candles) with 30-60s TTL and cache tags per coin.  
   - Publish cache directives (`ETag`, `Cache-Control: public, max-age=30`) for anonymous GETs; implement request budgets (target p50 < 30ms, p95 < 120ms for 24h windows).  
   - Plan rate limiting and load shedding for large `limit`/`agg` combinations.
5. **Retention & Lifecycle**  
   - Keep raw ticks 90 days, 1m aggregates 1 year, ≥1h aggregates indefinitely.  
   - Schedule jobs to promote/compress partitions, purge expired data, and rebuild aggregates.  
   - Provide backfill scripts that re-aggregate historical data when schema changes or new intervals are introduced.
6. **Reliability**  
   - Make writes idempotent by hashing `(coin_id, ts, source)`; reject duplicates gracefully.  
   - Validate inbound ticks (monotonic timestamps per source, price/volume bounds) and queue invalid payloads to a dead-letter topic.  
   - Instrument ingestion lag, hypertable chunk compression, and query latencies with Prometheus/Grafana.
7. **Security & Quotas**  
   - Apply auth scopes for heavy intervals (e.g., ≥1m data).  
   - Rate limit per API key + IP, cap `limit` (max 10k points per request), and require pagination cursor for large ranges.  
   - Log aggregation usage to forecast storage costs and enforce quota alerts.

# Concrete Artifacts
- **Proposed SQL**  
  ```sql
  CREATE TABLE coin_price_ticks (
    coin_id        INTEGER NOT NULL REFERENCES coins(coin_id),
    ts             TIMESTAMPTZ NOT NULL,
    price          NUMERIC(38,12) NOT NULL,
    volume         NUMERIC(38,12) DEFAULT 0,
    trade_count    INTEGER DEFAULT 0,
    source         SMALLINT NOT NULL DEFAULT 0,
    inserted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (coin_id, ts, source)
  );

  SELECT create_hypertable('coin_price_ticks', 'ts', chunk_time_interval => INTERVAL '7 days');
  ALTER TABLE coin_price_ticks SET (timescaledb.compress);
  SELECT add_compression_policy('coin_price_ticks', INTERVAL '7 days');
  SELECT add_retention_policy('coin_price_ticks', INTERVAL '90 days');

  CREATE INDEX ON coin_price_ticks (coin_id, ts DESC);
  CREATE INDEX ON coin_price_ticks USING BRIN (ts);

  CREATE MATERIALIZED VIEW coin_price_1m
  WITH (timescaledb.continuous) AS
  SELECT
    coin_id,
    time_bucket('1 minute', ts) AS bucket,
    first(price, ts) AS open,
    max(price) AS high,
    min(price) AS low,
    last(price, ts) AS close,
    sum(volume) AS volume,
    sum(trade_count) AS trade_count
  FROM coin_price_ticks
  GROUP BY coin_id, bucket
  WITH NO DATA;

  SELECT add_continuous_aggregate_policy('coin_price_1m',
    start_offset => INTERVAL '90 days',
    end_offset   => INTERVAL '1 minute',
    schedule_interval => INTERVAL '1 minute');
  ```
  Native Postgres alternative: partition `coin_price_ticks_2025_03` etc., attach monthly partitions, and use `BRIN` per partition; schedule `ALTER TABLE DETACH PARTITION` + archive.
- **Migration Plan**  
  1. Ship migrations creating new `coin_price_ticks` hypertable, aggregate views, and supporting indexes without touching existing endpoints.  
  2. Build backfill job that replays historical `price_history` rows into the new schema in chronological batches (order by `created_at`, insert with inferred `source=0`).  
  3. Introduce dual-write in `updateCoinPrice` and the simulator so both tables are populated; guard with feature flag.  
  4. Release API v2 reading from new structure while v1 continues using legacy table.  
  5. After parity validation (compare last 24h close values), migrate v1 reader to new tables or deprecate v1.  
  6. Enable retention/compression policies, disable dual writes, and drop legacy table after export snapshot + rollback window.
- **API Specs (OpenAPI excerpts)**  
  ```yaml
  /api/v2/coins/{coinId}/price-history:
    get:
      summary: Fetch price history ticks or aggregates.
      parameters:
        - name: coinId
          in: path
          required: true
          schema: { type: integer }
        - name: interval
          in: query
          schema: { type: string, enum: [tick, 1m, 5m, 15m, 1h, 4h, 1d], default: 1m }
        - name: agg
          in: query
          schema: { type: string, enum: [line, ohlc], default: line }
        - name: from
          in: query
          schema: { type: string, format: date-time }
        - name: to
          in: query
          schema: { type: string, format: date-time }
        - name: limit
          in: query
          schema: { type: integer, minimum: 10, maximum: 10000, default: 500 }
        - name: cursor
          in: query
          schema: { type: string }
      responses:
        '200':
          content:
            application/json:
              schema:
                oneOf:
                  - $ref: '#/components/schemas/PriceLineSeries'
                  - $ref: '#/components/schemas/PriceOhlcSeries'
  ```
- **Test Plan**  
  - Unit tests covering tick insertion idempotency and interval validation.  
  - SQL-based tests ensuring continuous aggregates produce expected OHLCV values for known fixtures.  
  - Contract tests verifying API response shape for `agg=line|ohlc`, pagination cursor behavior, and numeric typing.  
  - Regression tests comparing v1 vs v2 responses over shared windows during dual-write phase.  
  - Load tests (k6/Artillery) simulating 100 rps across mixed intervals to assert latency budgets.
- **Benchmark Plan**  
  - Generate synthetic datasets: 10 coins × 1M ticks (≈6 months at 30s cadence) + high-frequency bursts.  
  - Measure `tick` and `1m` queries with cold/warm caches, reporting p50/p95 latency, row counts, and planning time.  
  - Track hypertable compression ratios and partition vacuum cost.  
  - Acceptance thresholds: tick query p95 < 150ms for 24h range, 1y 1h aggregates p95 < 250ms, ingest pipeline sustaining ≥5k ticks/sec without lag.

# Sample Responses (Ready for frontend)
- **Line 1m (last 24h)**  
  ```json
  {
    "series": {
      "coin_id": 4,
      "interval": "1m",
      "points": [
        [1737302400000, 92.101234],
        [1737302460000, 92.214567],
        [1737302520000, 92.005432]
      ]
    },
    "next_cursor": "4|1737302520000"
  }
  ```
- **Line 1h (30d range)**  
  ```json
  {
    "series": {
      "coin_id": 4,
      "interval": "1h",
      "points": [
        [1734710400000, 88.45],
        [1734714000000, 88.91],
        [1734717600000, 89.63]
      ]
    }
  }
  ```
- **OHLC 4h with volume**  
  ```json
  {
    "series": {
      "coin_id": 4,
      "interval": "4h",
      "candles": [
        { "t": "2025-01-18T00:00:00Z", "o": 91.2, "h": 93.0, "l": 90.8, "c": 92.5, "v": 15234.77, "count": 480 },
        { "t": "2025-01-18T04:00:00Z", "o": 92.5, "h": 94.1, "l": 92.1, "c": 93.6, "v": 18942.12, "count": 480 }
      ]
    },
    "next_cursor": "4|2025-01-18T04:00:00Z"
  }
  ```

# Risks, Trade-offs, and Alternatives
- Hypertables and continuous aggregates add operational complexity (Timescale extension management, upgrade cadence). Native partitioning reduces dependencies but sacrifices real-time aggregation features.
- Precomputing multiple intervals increases storage footprint; leverage compression and retention to control costs.
- Tight retention policies may drop data needed for forensic analysis—consider archival to S3/Parquet via logical decoding or `COPY`.
- Client-side downsampling (status quo) is simpler but keeps heavy network payloads and unpredictable latency; acceptable only for very small datasets.
- DuckDB/Parquet sidecars provide cheap analytics but complicate real-time APIs and require ETL choreography.

# Appendix
- **Key snippets**
  ```js
  // controllers/coins.controller.js:116-159
  const priceHistory = await coinsModel.getCoinPriceHistory(numericId, pageNum, limitNum, range);
  res.status(200).json(priceHistory);
  ```
  ```sql
  -- models/coins.model.js:283-303
  SELECT ph.price_history_id, ph.coin_id, ph.price, ph.created_at, c.name, c.symbol
  FROM price_history ph
  JOIN coins c ON ph.coin_id = c.coin_id
  WHERE ph.coin_id = $1::integer
  ORDER BY ph.created_at DESC
  LIMIT $2 OFFSET $3;
  ```
  ```sql
  -- db/seed.js:85-117
  CREATE TABLE IF NOT EXISTS price_history (
    price_history_id SERIAL PRIMARY KEY,
    coin_id INTEGER REFERENCES coins(coin_id) ON DELETE CASCADE,
    price DECIMAL(20, 2) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_price_history_coin_id ON price_history(coin_id);
  CREATE INDEX IF NOT EXISTS idx_price_history_created_at ON price_history(created_at);
  ```
- **Files reviewed**: `controllers/coins.controller.js`, `models/coins.model.js`, `models/market-simulator.js`, `db/seed.js`, `db/migrations/003_create_price_history.sql`, `clear-price-history.js`, `routes/coins.routes.js`, `__tests__/price-history.test.js`, `docs/market-dashboard-prd.md`.

# Conclusions Round 1

## What I Reviewed
- Peer reports found: llm-opinions/claude.codes/claude.codes_round1.md; llm-opinions/cursor/cursor_round1.md
- Missing reports: none

## Key Agreements & Disagreements (TL;DR)
- Agreements
  - All reports converge on moving price history to `TIMESTAMPTZ` + high-precision `NUMERIC` with `(coin_id, ts)` uniqueness to stop duplicate ticks.
  - Every plan replaces the heap table with time-series aware storage (Timescale hypertables or range partitions) plus retention/compression.
  - We all serve server-side rollups (≥1m intervals) through a v2 API that emits numeric payloads and consistent UTC timestamps.
  - Redis/HTTP caching, rate limiting, and downsampling are shared themes to keep latency predictable.
- Disagreements
  - Cursor keeps long-lived cron-driven rollup tables; I prefer Timescale continuous aggregates to avoid custom scheduler debt.
  - Cursor caps prices at `NUMERIC(12,4)` for rollups; I retain `NUMERIC(38,12)` to support sub-cent assets and FX pairs.
  - Claude adds a persisted `price_ohlc` hypertable; I lean on continuous aggregates/views so we only maintain a single source of truth unless materialized storage proves necessary.

## Comparison Snapshot
| Dimension | My R1 Position | Best Peer Position | Notes |
| --- | --- | --- | --- |
| Schema precision & keys | `coin_price_ticks` hypertable, `NUMERIC(38,12)`, PK `(coin_id, ts, source)` | Claude: hypertable with PK `(coin_id, ts)` and optional `volume` | Align on Timescale; adopting Claude’s emphasis on mandatory volume column is reasonable. |
| Partitioning strategy | Timescale hypertable (7d chunks) or native monthly partitions with compression | Claude: hypertable + space dimension (`coin_id`) + compression policies | Will include coin-based space dimension and 7d compression policy from Claude. |
| Aggregation intervals | Continuous aggregates for raw, 1m, 5m, 15m, 1h, 4h, 1d | Claude: cascade 1h/1d from 1m view | I’ll cascade higher intervals from 1m to reduce compute, keeping 5m/15m/4h layers. |
| API contract & pagination | `/api/v2/...` with `interval`, `agg`, cursor field `next_cursor` | Claude: adds `format` switch, `auto` interval, metadata once, cursor timestamp | Adopt `auto` interval selection and `format` toggle while keeping cursor-based seek. |
| Caching & scalability | Redis TTL + ETags, target p50/p95 budgets, load shedding | Claude: Redis + LTTB downsampling + 24h stats materialized view | Incorporate LTTB downsampling trigger for >10k points and cached 24h stats. |
| Reliability & dedupe | Idempotent writes, DLQ, clock skew checks | Claude: detailed ON CONFLICT patterns + deterministic buckets | Keep my DLQ plan, add deterministic timestamp rounding for simulator writes. |
| Migration controls | Dual-write, backfill, parity validation, staged cutover | Claude: phased plan with rollback triggers | Add explicit rollback thresholds/alerts from Claude’s plan. |
| Legacy stopgaps | Focus on new schema rollout | Cursor: disable cron, convert to TIMESTAMPTZ, covering index during transition | Adopt Cursor’s immediate fixes while new pipeline is built. |

## Final Recommendation
- Stand up a TimescaleDB hypertable `coin_price_ticks` (`coin_id INT`, `ts TIMESTAMPTZ`, `price NUMERIC(38,12)`, `volume NUMERIC(38,12)`, `trade_count INT`, `source SMALLINT`, `inserted_at TIMESTAMPTZ DEFAULT now()`) with chunk interval 7 days, compressed after 7 days, and a secondary space dimension on `coin_id`.
- Build continuous aggregates for 1m, 5m, 15m, 1h, 4h, 1d; derive 1h/4h/1d from the 1m view to minimize recompute and expose metadata (`open/high/low/close/volume/count`). Keep raw-tick reads capped to ≤24h.
- Launch `/api/v2/coins/:coinId/price-history` with params `interval` (`auto|tick|1m|5m|15m|1h|4h|1d`), `agg` (`line|ohlc`), `format` (adds `compact`), `from`, `to`, `limit`, and cursor-based pagination (stringified `{coin_id}|{ts}`); default `interval=auto` selects the optimal aggregate tier. Responses return numeric arrays and optional OHLC objects with ISO8601 metadata.
- Index strategy: on ticks, keep Timescale default plus an explicit `CREATE INDEX ON coin_price_ticks (coin_id, ts DESC)` and BRIN on `ts`; on aggregates, index `(coin_id, bucket DESC)` and include covering columns. During migration, apply Cursor’s covering index to the legacy table and convert `created_at` to `TIMESTAMPTZ`.
- Caching & performance: add Redis caches (`price_history:{coin}:{interval}:{from}:{to}`) with TTL aligned to interval (60s tick, 5m 1m, etc.), emit `ETag`/`Cache-Control` headers, and apply LTTB downsampling when the server would return >10k points. Target p50 ≤30 ms and p95 ≤120 ms for 24h 1m windows; enforce rate limiting (100 req/min/IP, 500 req/min/auth user) and backpressure if pool saturation >90%.
- Retention & lifecycle: keep raw ticks 90 days, 1m aggregates 1 year, 5m/15m 2 years, ≥1h indefinitely; compress old chunks; enforce `ON CONFLICT (coin_id, ts, source) DO UPDATE` for dedupe, reject future timestamps beyond +5 s, and ship a Redis-backed DLQ for failed writes with replay workers.
- Migration: disable the broken cron cleanup, rename columns to `TIMESTAMPTZ`, add covering index, then deploy hypertable; dual-write (feature flag) from simulator and PATCH endpoint, backfill historical rows in chronological batches, monitor parity (row counts, latest close deltas, p95 latency), roll traffic to v2 reads after parity ≥99.9%, and retain the legacy table 30 days for rollback with automated alert thresholds (error rate >5% for 10 min).

## Pros & Cons of the Final Approach
- **Pros**
  - Hypertables + compression dramatically reduce I/O while keeping inserts and queries sub-linear at multi-million row scale.
  - Continuous aggregates deliver low-latency chart data across time horizons without per-request rollups.
  - API v2 outputs chart-ready payloads (line/OHLC/compact) with consistent pagination, slashing frontend transform work.
  - Redis caching + LTTB downsampling trim bandwidth and protect the database under bursty traffic.
  - Structured migration and rollback criteria minimize risk during cutover.
- **Cons**
  - TimescaleDB adds operational overhead (extension management, versioning, monitoring).
  - Continuous aggregate refresh tuning is required to avoid stale data or heavy backfills.
  - Dual-write period increases ingest complexity and demands robust observability.
  - Maintaining Redis and cache invalidation adds operational surface area.

## Actionable Next Steps (1–2 weeks)
- Disable cron cleanup, convert `price_history.created_at` to `TIMESTAMPTZ`, and add the covering index (Owner: Backend, Effort: M, Acceptance: legacy endpoint returns ≥7 days of data with <=10% latency regression).
- Provision TimescaleDB in staging and create `coin_price_ticks` hypertable with compression/retention policies (Owner: Infra/DBA, Effort: L, Acceptance: hypertable exists, chunk compression executes in staging without errors).
- Update simulator and PATCH endpoints to dual-write into `coin_price_ticks` with `ON CONFLICT` dedupe and deterministic timestamp rounding (Owner: Backend, Effort: M, Acceptance: integration tests show no duplicate ticks and parity dashboards <0.1% drift).
- Implement continuous aggregates (1m/5m/15m/1h/4h/1d) plus automated refresh policies and parity tests against materialized SQL rollups (Owner: Data/Backend, Effort: M, Acceptance: k6 load test p95 ≤120 ms for 24h 1m query).
- Ship `/api/v2/...` endpoint, Redis caching middleware, LTTB downsampling, and HTTP cache headers (Owner: Backend/API, Effort: M, Acceptance: contract tests pass, cache hit rate ≥60% in staging, responses numeric-only).
- Build cutover playbook: parity dashboards, error-rate alerts, rollback automation, and QA regression suite covering ingest and API behaviors (Owner: QA/SRE, Effort: M, Acceptance: dashboard + alerting live, regression suite green prior to production cut).
