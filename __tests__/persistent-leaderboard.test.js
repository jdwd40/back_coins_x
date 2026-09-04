// Persistent-market Stage 10A (S10-01): read-only persistent leaderboard.
//
// Proves valuation (cash + live holdings - debt), DEAD coins at £0,
// replacement holdings contributing live value, humans + bots, ranking
// (netWorth DESC, account_id ASC), fractional precision via round2,
// read-only (no mutation), public access, and no seed / internal leakage.
// Legacy GET /api/game/leaderboard remains untouched (smoke).

const request = require('supertest');
const app = require('../app');
const db = require('../db/connection');
const persistentWorld = require('../game/persistentWorld');
const persistentEconomy = require('../game/persistentEconomy');
const persistentLeaderboard = require('../game/persistentLeaderboard');
const coinStateModel = require('../models/marketCoinState.model');
const { ensureBotsProvisioned } = require('../game/botService');
const { reconcileCycle } = require('../game/gameCycleService');
const { assertDisposableTestDatabase } = require('./helpers/testDatabaseGuard');

jest.setTimeout(60000);

const WORLD_SEED = 'stage10a-leaderboard-world-seed';
const EPOCH = new Date('2026-09-04T00:00:00.000Z');
const LONG_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

function round2(value) {
  return Math.round(value * 100) / 100;
}

async function provisionedWorld() {
  return persistentWorld.provisionWorld(db, {
    seed: WORLD_SEED,
    epochStartedAt: EPOCH
  });
}

async function snapshotEconomy() {
  const accounts = await db.query(
    'SELECT account_id, cash, debt FROM persistent_accounts ORDER BY account_id'
  );
  const holdings = await db.query(
    'SELECT account_id, coin_id, quantity, cost_basis FROM persistent_holdings ORDER BY account_id, coin_id'
  );
  const prices = await db.query(
    'SELECT coin_id, current_price FROM coins ORDER BY coin_id'
  );
  const loans = await db.query(
    'SELECT persistent_loan_id, amount, debt_after FROM persistent_loans ORDER BY persistent_loan_id'
  );
  return {
    accounts: accounts.rows,
    holdings: holdings.rows,
    prices: prices.rows,
    loans: loans.rows
  };
}

async function killCoin(coinId) {
  const world = await persistentWorld.resolveActiveWorld(db);
  await db.query(
    `INSERT INTO market_coin_state (coin_id, world_id, archetype, condition, structural_reference, peak_reference)
     VALUES ($1, $2, 'ZIP', 0, 10, 10)`,
    [coinId, world.worldId]
  );
  await coinStateModel.recordDeath(db, {
    coinId,
    worldId: world.worldId,
    diedAt: new Date()
  });
  await db.query('UPDATE coins SET current_price = 0 WHERE coin_id = $1', [coinId]);
}

async function insertReplacementCoin({
  coinId = 101,
  symbol = 'PLD',
  price = 12.5
} = {}) {
  await db.query(
    `INSERT INTO coins (coin_id, name, symbol, current_price, market_cap, circulating_supply, price_change_24h, founder, cycle_baseline_price, retired)
     VALUES ($1, $2, $3, $4, 0, 0, 0, 'Stage10A', $4, false)
     ON CONFLICT (coin_id) DO UPDATE
       SET current_price = EXCLUDED.current_price,
           symbol = EXCLUDED.symbol,
           retired = false`,
    [coinId, `Replacement ${symbol}`, symbol, price]
  );
  await db.query(
    `SELECT setval(pg_get_serial_sequence('coins', 'coin_id'), (SELECT MAX(coin_id) FROM coins))`
  );
}

describe('Stage 10A S10-01: persistent leaderboard', () => {
  beforeEach(async () => {
    assertDisposableTestDatabase();
    await provisionedWorld();
    await db.query('UPDATE coins SET current_price = 10 WHERE coin_id = 1');
    await db.query('UPDATE coins SET current_price = 20 WHERE coin_id = 2');
  });

  test('is public and returns the Stage 10 envelope with empty entries when only the world exists', async () => {
    const res = await request(app).get('/api/persistent/leaderboard').expect(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data.worldId).toEqual(expect.any(Number));
    expect(typeof res.body.data.serverTime).toBe('string');
    expect(res.body.data.entries).toEqual([]);
    expect(JSON.stringify(res.body)).not.toContain(WORLD_SEED);
  });

  test('returns empty board (worldId null) when no active world is provisioned', async () => {
    await db.query('UPDATE market_worlds SET active = false');
    const res = await request(app).get('/api/persistent/leaderboard').expect(200);
    expect(res.body.data.worldId).toBeNull();
    expect(res.body.data.entries).toEqual([]);
  });

  test('cash-only participant valuation: netWorth equals cash when no holdings', async () => {
    await persistentEconomy.provisionPersistentAccount({ userId: 1 });
    const res = await request(app).get('/api/persistent/leaderboard').expect(200);
    expect(res.body.data.entries).toHaveLength(1);
    const entry = res.body.data.entries[0];
    expect(entry).toMatchObject({
      rank: 1,
      userId: 1,
      isBot: false,
      personality: null,
      cash: 10000,
      holdingsValue: 0,
      debt: 0,
      netWorth: 10000
    });
    expect(entry.accountId).toEqual(expect.any(Number));
  });

  test('holdings valued from current authoritative coin prices; multiple holdings sum with round2', async () => {
    const account = await persistentEconomy.provisionPersistentAccount({ userId: 1 });
    // Direct holdings insert (read-only leaderboard — avoid trade side effects for precision fixture).
    await db.query(
      `UPDATE persistent_accounts SET cash = 9000 WHERE account_id = $1`,
      [account.accountId]
    );
    await db.query(
      `INSERT INTO persistent_holdings (account_id, world_id, user_id, coin_id, quantity, cost_basis)
       VALUES ($1, $2, 1, 1, 5, 50), ($1, $2, 1, 2, 2, 40)`,
      [account.accountId, account.worldId]
    );

    const expectedHoldings = round2(round2(5 * 10) + round2(2 * 20)); // 50 + 40 = 90
    const res = await request(app).get('/api/persistent/leaderboard').expect(200);
    const entry = res.body.data.entries[0];
    expect(entry.cash).toBe(9000);
    expect(entry.holdingsValue).toBe(expectedHoldings);
    expect(entry.debt).toBe(0);
    expect(entry.netWorth).toBe(round2(9000 + expectedHoldings));
  });

  test('DEAD coin holdings contribute £0', async () => {
    const account = await persistentEconomy.provisionPersistentAccount({ userId: 1 });
    await db.query(
      `UPDATE persistent_accounts SET cash = 5000 WHERE account_id = $1`,
      [account.accountId]
    );
    await db.query(
      `INSERT INTO persistent_holdings (account_id, world_id, user_id, coin_id, quantity, cost_basis)
       VALUES ($1, $2, 1, 1, 100, 1000)`,
      [account.accountId, account.worldId]
    );
    await killCoin(1);

    const res = await request(app).get('/api/persistent/leaderboard').expect(200);
    const entry = res.body.data.entries[0];
    expect(entry.holdingsValue).toBe(0);
    expect(entry.netWorth).toBe(5000);
  });

  test('replacement coin holdings contribute live value', async () => {
    const account = await persistentEconomy.provisionPersistentAccount({ userId: 1 });
    await insertReplacementCoin({ coinId: 101, symbol: 'PLD', price: 12.5 });
    await db.query(
      `UPDATE persistent_accounts SET cash = 8000 WHERE account_id = $1`,
      [account.accountId]
    );
    await db.query(
      `INSERT INTO persistent_holdings (account_id, world_id, user_id, coin_id, quantity, cost_basis)
       VALUES ($1, $2, 1, 101, 4, 50)`,
      [account.accountId, account.worldId]
    );

    const expected = round2(4 * 12.5); // 50
    const res = await request(app).get('/api/persistent/leaderboard').expect(200);
    const entry = res.body.data.entries[0];
    expect(entry.holdingsValue).toBe(expected);
    expect(entry.netWorth).toBe(round2(8000 + expected));
  });

  test('debt subtracts from net worth; negative net worth is allowed', async () => {
    const account = await persistentEconomy.provisionPersistentAccount({ userId: 1 });
    await db.query(
      `UPDATE persistent_accounts SET cash = 100, debt = 500 WHERE account_id = $1`,
      [account.accountId]
    );
    // No holdings → netWorth = 100 - 500 = -400
    const res = await request(app).get('/api/persistent/leaderboard').expect(200);
    const entry = res.body.data.entries[0];
    expect(entry.debt).toBe(500);
    expect(entry.holdingsValue).toBe(0);
    expect(entry.netWorth).toBe(-400);
  });

  test('humans and bots both appear with personality from apocalypse_bots', async () => {
    await persistentEconomy.provisionPersistentAccount({ userId: 1 });
    const roster = await ensureBotsProvisioned({ queryable: db });
    expect(roster.length).toBeGreaterThan(0);
    for (const bot of roster) {
      await persistentEconomy.provisionPersistentAccount({ userId: bot.userId });
    }

    const res = await request(app).get('/api/persistent/leaderboard').expect(200);
    const entries = res.body.data.entries;
    expect(entries.length).toBe(1 + roster.length);

    const human = entries.find((e) => e.userId === 1);
    expect(human.isBot).toBe(false);
    expect(human.personality).toBeNull();

    const bots = entries.filter((e) => e.isBot === true);
    expect(bots.length).toBe(roster.length);
    for (const bot of bots) {
      expect(typeof bot.personality).toBe('string');
      expect(bot.personality.length).toBeGreaterThan(0);
    }
  });

  test('ranks by netWorth DESC with deterministic account_id ASC tie-break', async () => {
    const a1 = await persistentEconomy.provisionPersistentAccount({ userId: 1 });
    const a2 = await persistentEconomy.provisionPersistentAccount({ userId: 2 });
    // Equal net worth via equal cash; lower account_id ranks first.
    await db.query(
      `UPDATE persistent_accounts SET cash = 7500 WHERE account_id IN ($1, $2)`,
      [a1.accountId, a2.accountId]
    );

    // Third participant with higher net worth ranks #1.
    // Seed users: only 1 and 2 typically — insert a third human if needed.
    const { rows: existing } = await db.query('SELECT user_id FROM users WHERE user_id = 3');
    if (existing.length === 0) {
      await db.query(
        `INSERT INTO users (user_id, username, email, password_hash, funds, is_bot)
         VALUES (3, 'leaderboard_third', 'third@test.local', 'x', 0, false)`
      );
    }
    const a3 = await persistentEconomy.provisionPersistentAccount({ userId: 3 });
    await db.query(
      `UPDATE persistent_accounts SET cash = 9000 WHERE account_id = $1`,
      [a3.accountId]
    );

    const res = await request(app).get('/api/persistent/leaderboard').expect(200);
    const entries = res.body.data.entries;
    expect(entries.map((e) => e.rank)).toEqual([1, 2, 3]);
    expect(entries[0].userId).toBe(3);
    expect(entries[0].netWorth).toBe(9000);

    // Tied at 7500: lower account_id first.
    const tied = entries.slice(1);
    expect(tied[0].netWorth).toBe(7500);
    expect(tied[1].netWorth).toBe(7500);
    expect(tied[0].accountId).toBeLessThan(tied[1].accountId);
  });

  test('fractional holdings precision follows persistentEconomy round2', async () => {
    const account = await persistentEconomy.provisionPersistentAccount({ userId: 1 });
    // quantity 1.5 * price 10.3333 → round2(15.49995) = 15.5
    await db.query('UPDATE coins SET current_price = 10.3333 WHERE coin_id = 1');
    await db.query(
      `UPDATE persistent_accounts SET cash = 0 WHERE account_id = $1`,
      [account.accountId]
    );
    await db.query(
      `INSERT INTO persistent_holdings (account_id, world_id, user_id, coin_id, quantity, cost_basis)
       VALUES ($1, $2, 1, 1, 1.5, 15)`,
      [account.accountId, account.worldId]
    );

    const expectedLine = round2(1.5 * 10.3333);
    expect(expectedLine).toBe(15.5);

    const state = await persistentEconomy.getPersistentAccountState({ userId: 1 });
    const res = await request(app).get('/api/persistent/leaderboard').expect(200);
    expect(res.body.data.entries[0].holdingsValue).toBe(expectedLine);
    expect(res.body.data.entries[0].holdingsValue).toBe(state.holdingsValue);
    expect(res.body.data.entries[0].netWorth).toBe(state.netWealth);
  });

  test('leaderboard read does NOT mutate balances, debt, holdings, or prices', async () => {
    const account = await persistentEconomy.provisionPersistentAccount({ userId: 1 });
    await db.query(
      `INSERT INTO persistent_holdings (account_id, world_id, user_id, coin_id, quantity, cost_basis)
       VALUES ($1, $2, 1, 1, 3, 30)`,
      [account.accountId, account.worldId]
    );
    await db.query(
      `UPDATE persistent_accounts SET debt = 25 WHERE account_id = $1`,
      [account.accountId]
    );

    const before = await snapshotEconomy();
    await request(app).get('/api/persistent/leaderboard').expect(200);
    await persistentLeaderboard.getPersistentLeaderboard({});
    const after = await snapshotEconomy();
    expect(after).toEqual(before);
  });

  test('response exposes no seed / Director / bot decision internals', async () => {
    await persistentEconomy.provisionPersistentAccount({ userId: 1 });
    const roster = await ensureBotsProvisioned({ queryable: db });
    await persistentEconomy.provisionPersistentAccount({ userId: roster[0].userId });

    const res = await request(app).get('/api/persistent/leaderboard').expect(200);
    const payload = JSON.stringify(res.body);
    expect(payload).not.toContain(WORLD_SEED);
    expect(payload).not.toContain('regimeIndex');
    expect(payload).not.toContain('seed');
    expect(payload).not.toContain('Director');
    expect(payload).not.toContain('decision');
    expect(payload).not.toContain('random');

    for (const entry of res.body.data.entries) {
      const keys = Object.keys(entry).sort();
      expect(keys).toEqual([
        'accountId',
        'cash',
        'debt',
        'holdingsValue',
        'isBot',
        'netWorth',
        'personality',
        'rank',
        'userId',
        'username'
      ].sort());
    }
  });

  test('alias GET /api/game/persistent-leaderboard returns the same board', async () => {
    await persistentEconomy.provisionPersistentAccount({ userId: 1 });
    const primary = await request(app).get('/api/persistent/leaderboard').expect(200);
    const alias = await request(app).get('/api/game/persistent-leaderboard').expect(200);
    expect(alias.body.status).toBe('success');
    expect(alias.body.data.worldId).toBe(primary.body.data.worldId);
    expect(alias.body.data.entries).toEqual(primary.body.data.entries);
  });

  test('legacy GET /api/game/leaderboard still works (smoke)', async () => {
    await reconcileCycle({ now: new Date(), durationMs: LONG_DURATION_MS });
    const res = await request(app).get('/api/game/leaderboard').expect(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data).toHaveProperty('cycleId');
    expect(Array.isArray(res.body.data.entries)).toBe(true);
  });
});
