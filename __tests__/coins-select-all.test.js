// GET /api/coins (selectAllCoins): per-coin LATERAL lookups must return
// exactly what the previous DISTINCT ON CTE query returned — latest
// persistent price, 24h change vs the price at/before 24h ago, earliest
// persistent price for a coin younger than 24h, persistent provenance only,
// retired coins excluded — and must run on a released, JIT-off transaction.
const db = require('../db/connection');
const coinsModel = require('../models/coins.model');

// Reference oracle: the pre-fix query, verbatim (PERSISTENT_PH inlined).
const LEGACY_SELECT_ALL_COINS_SQL = `
    WITH latest_prices AS (
      SELECT DISTINCT ON (coin_id) coin_id, price AS current_price, created_at
      FROM price_history
      WHERE source = 'MARKET_TICK' AND cycle_id IS NULL
      ORDER BY coin_id, created_at DESC
    ),
    old_prices_24h AS (
      SELECT DISTINCT ON (coin_id) coin_id, price AS old_price
      FROM price_history
      WHERE created_at <= NOW() - INTERVAL '24 hours'
        AND source = 'MARKET_TICK' AND cycle_id IS NULL
      ORDER BY coin_id, created_at DESC
    ),
    earliest_prices AS (
      SELECT DISTINCT ON (coin_id) coin_id, price AS earliest_price
      FROM price_history
      WHERE source = 'MARKET_TICK' AND cycle_id IS NULL
      ORDER BY coin_id, created_at ASC
    )
    SELECT
      c.coin_id, c.name, c.symbol, c.current_price, c.market_cap,
      c.circulating_supply, c.price_change_24h, c.founder,
      CASE
        WHEN lp.current_price IS NULL OR (op.old_price IS NULL AND ep.earliest_price IS NULL) THEN NULL
        ELSE ROUND(((lp.current_price - COALESCE(op.old_price, ep.earliest_price)) /
                    NULLIF(COALESCE(op.old_price, ep.earliest_price), 0) * 100)::numeric, 2)
      END AS calculated_price_change_24h
    FROM coins c
    LEFT JOIN latest_prices lp ON c.coin_id = lp.coin_id
    LEFT JOIN old_prices_24h op ON c.coin_id = op.coin_id
    LEFT JOIN earliest_prices ep ON c.coin_id = ep.coin_id
    WHERE c.retired = FALSE
    ORDER BY c.coin_id ASC;
`;

async function insertHistory(coinId, price, ago, source = 'MARKET_TICK') {
  await db.query(
    `INSERT INTO price_history (coin_id, price, created_at, source, cycle_id)
     VALUES ($1, $2, NOW() - $3::interval, $4, NULL)`,
    [coinId, price, ago, source]
  );
}

async function buildFixture() {
  // Coin 1: old coin. Baseline must be the newest row at/before 24h ago (80),
  // not the earliest (50); latest is 120 → +50.00.
  await insertHistory(1, 50, '72 hours');
  await insertHistory(1, 80, '25 hours');
  await insertHistory(1, 999, '23 hours');
  await insertHistory(1, 120, '1 minute');
  // Newer non-persistent contaminants must be ignored.
  await insertHistory(1, 1, '10 seconds', null);
  await insertHistory(1, 2, '20 seconds', 'COLLAPSE');
  await insertHistory(1, 3, '30 hours', null);

  // Coin 2: younger than 24h → baseline is its earliest persistent row (40),
  // latest 50 → +25.00. An older legacy row must not become the baseline.
  await insertHistory(2, 7, '48 hours', null);
  await insertHistory(2, 40, '3 hours');
  await insertHistory(2, 45, '2 hours');
  await insertHistory(2, 50, '1 hour');

  // Coin 3: only legacy/collapse history → no persistent history → null.
  await insertHistory(3, 10, '2 hours', null);
  await insertHistory(3, 11, '1 hour', 'COLLAPSE');

  // Coin 4: price fell to zero baseline edge (NULLIF guard) → null change.
  await insertHistory(4, 0, '30 hours');
  await insertHistory(4, 5, '1 hour');

  // Coin 5: single persistent row younger than 24h → 0.00.
  await insertHistory(5, 12.5, '5 minutes');

  // Coin 6: history but retired → excluded entirely.
  await insertHistory(6, 10, '30 hours');
  await insertHistory(6, 20, '1 hour');
  await db.query('UPDATE coins SET retired = TRUE WHERE coin_id = 6');
}

describe('selectAllCoins per-coin lookups', () => {
  beforeEach(async () => {
    await buildFixture();
  });

  test('returns latest price, 24h change, young-coin baseline, provenance filter, retired exclusion', async () => {
    const coins = await coinsModel.selectAllCoins();
    const byId = new Map(coins.map((c) => [c.coin_id, c]));

    expect(coins.map((c) => c.coin_id)).toEqual([1, 2, 3, 4, 5, 7, 8, 9, 10]);
    expect(byId.has(6)).toBe(false);

    expect(byId.get(1).price_change_24h).toBe(50);
    expect(byId.get(2).price_change_24h).toBe(25);
    expect(byId.get(3).price_change_24h).toBeNull();
    expect(byId.get(4).price_change_24h).toBeNull();
    expect(byId.get(5).price_change_24h).toBe(0);
    expect(byId.get(7).price_change_24h).toBeNull();

    // Response shape/formatting unchanged.
    expect(byId.get(1)).toEqual({
      coin_id: 1,
      name: 'FutureCoin',
      symbol: 'FTR',
      current_price: '£0.10',
      market_cap: '£250.00', // price x supply, derived on read (issue #54)
      circulating_supply: 2500,
      price_change_24h: 50,
      founder: 'Roberto',
      calculated_price_change_24h: '50.00'
    });
  });

  test('new SQL returns rows identical to the legacy CTE query', async () => {
    const client = await db.getClient();
    try {
      // One snapshot and one NOW() for both statements.
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const legacy = await client.query(LEGACY_SELECT_ALL_COINS_SQL);
      const current = await client.query(coinsModel.SELECT_ALL_COINS_SQL);
      await client.query('COMMIT');
      expect(current.fields.map((f) => f.name)).toEqual(legacy.fields.map((f) => f.name));
      expect(current.rows).toEqual(legacy.rows);
      expect(current.rows.length).toBe(9);
    } finally {
      client.release();
    }
  });

  test('runs as BEGIN / SET LOCAL jit = off / query / COMMIT and releases the client', async () => {
    const realGetClient = db.getClient;
    const seen = [];
    let released = 0;
    db.getClient = async () => {
      const client = await realGetClient();
      const realQuery = client.query.bind(client);
      const realRelease = client.release.bind(client);
      client.query = (text, ...rest) => {
        seen.push(text === coinsModel.SELECT_ALL_COINS_SQL ? '<SELECT_ALL_COINS_SQL>' : text);
        return realQuery(text, ...rest);
      };
      client.release = (...args) => { released++; client.query = realQuery; client.release = realRelease; return realRelease(...args); };
      return client;
    };
    try {
      await coinsModel.selectAllCoins();
    } finally {
      db.getClient = realGetClient;
    }
    expect(seen).toEqual(['BEGIN', 'SET LOCAL jit = off', '<SELECT_ALL_COINS_SQL>', 'COMMIT']);
    expect(released).toBe(1);
  });

  test('rolls back and releases the client when the query fails', async () => {
    const realGetClient = db.getClient;
    const seen = [];
    let released = 0;
    db.getClient = async () => {
      const client = await realGetClient();
      const realQuery = client.query.bind(client);
      const realRelease = client.release.bind(client);
      client.query = (text, ...rest) => {
        seen.push(text.trim().split(/\s+/)[0]);
        if (text === coinsModel.SELECT_ALL_COINS_SQL) return Promise.reject(new Error('boom'));
        return realQuery(text, ...rest);
      };
      client.release = (...args) => { released++; client.query = realQuery; client.release = realRelease; return realRelease(...args); };
      return client;
    };
    try {
      await expect(coinsModel.selectAllCoins()).rejects.toThrow('boom');
    } finally {
      db.getClient = realGetClient;
    }
    expect(seen).toEqual(['BEGIN', 'SET', 'SELECT', 'ROLLBACK']);
    expect(released).toBe(1);
  });
});
