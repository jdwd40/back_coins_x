// Persistent-market Stage 5: THE one writable persistent gameplay economy
// against the REAL disposable test database — migration 026, exactly-once
// £10,000 provisioning, and the atomic locked-price persistent trades with
// their overspend/oversell/rollback/race guarantees.
//
// Every mutating test passes through the repository's disposable test DB
// guard (jest.setup.js also reseeds before each test).

const db = require('../db/connection');
const { runMigrations } = require('../db/migrate');
const { verifyGameSchema } = require('../db/verify-game-schema');
const persistentWorld = require('../game/persistentWorld');
const persistentEconomy = require('../game/persistentEconomy');
const coinStateModel = require('../models/marketCoinState.model');
const { assertDisposableTestDatabase } = require('./helpers/testDatabaseGuard');

jest.setTimeout(60000);

const MIGRATION_026 = '026_create_persistent_economy.sql';
const WORLD_SEED = 'stage5-economy-world-seed';
const EPOCH = new Date('2026-08-31T00:00:00.000Z');

async function provisionedWorld() {
  return persistentWorld.provisionWorld(db, { seed: WORLD_SEED, epochStartedAt: EPOCH });
}

async function accountRow(userId) {
  const { rows } = await db.query(
    'SELECT account_id, world_id, user_id, starting_cash, cash FROM persistent_accounts WHERE user_id = $1',
    [userId]
  );
  return rows;
}

async function holdingRow(userId, coinId) {
  const { rows } = await db.query(
    'SELECT quantity, cost_basis FROM persistent_holdings WHERE user_id = $1 AND coin_id = $2',
    [userId, coinId]
  );
  return rows[0] || null;
}

async function ledgerRows(userId) {
  const { rows } = await db.query(
    'SELECT type, coin_id, quantity, price, total_amount FROM persistent_transactions WHERE user_id = $1 ORDER BY persistent_transaction_id',
    [userId]
  );
  return rows;
}

describe('Stage 5: tracked production migration 026', () => {
  beforeEach(async () => {
    assertDisposableTestDatabase();
    await runMigrations({ log: () => {} });
  });

  test('applies 026 to an existing database, preserving all pre-existing schema and data', async () => {
    const usersBefore = await db.query('SELECT count(*)::int AS n FROM users');
    const coinsBefore = await db.query('SELECT count(*)::int AS n FROM coins');

    await db.query('DROP TABLE IF EXISTS persistent_loans CASCADE');
    await db.query('DROP TABLE IF EXISTS persistent_transactions CASCADE');
    await db.query('DROP TABLE IF EXISTS persistent_holdings CASCADE');
    await db.query('DROP TABLE IF EXISTS persistent_accounts CASCADE');
    await db.query('DELETE FROM schema_migrations WHERE migration = ANY($1)', [[MIGRATION_026, '027_create_persistent_bot_debt.sql']]);
    const result = await runMigrations({ log: () => {} });
    expect(result.applied).toContain(MIGRATION_026);
    expect(result.applied).toContain('027_create_persistent_bot_debt.sql');

    const verification = await verifyGameSchema();
    expect(verification.problems).toEqual([]);
    expect(verification.ok).toBe(true);

    expect((await db.query('SELECT count(*)::int AS n FROM users')).rows[0].n).toBe(usersBefore.rows[0].n);
    expect((await db.query('SELECT count(*)::int AS n FROM coins')).rows[0].n).toBe(coinsBefore.rows[0].n);
    const legacy = await db.query(`SELECT to_regclass('public.apocalypse_cycles') AS r`);
    expect(legacy.rows[0].r).not.toBeNull();
  });

  test('re-running the migration on an already-migrated database is a tracked no-op', async () => {
    const result = await runMigrations({ log: () => {} });
    expect(result.applied).not.toContain(MIGRATION_026);
    const verification = await verifyGameSchema();
    expect(verification.ok).toBe(true);
  });
});

describe('Stage 5: exactly-once £10,000 provisioning', () => {
  beforeEach(async () => {
    assertDisposableTestDatabase();
    await provisionedWorld();
  });

  test('provisioning grants exactly £10,000 once and replay is a no-op', async () => {
    const first = await persistentEconomy.provisionPersistentAccount({ userId: 1 });
    expect(first.startingCash).toBe(persistentEconomy.PERSISTENT_STARTING_CASH);
    expect(first.cash).toBe(10000);

    const replay = await persistentEconomy.provisionPersistentAccount({ userId: 1 });
    expect(replay.accountId).toBe(first.accountId);
    expect(replay.cash).toBe(10000);
    expect((await accountRow(1)).length).toBe(1);
  });

  test('provisioning replay after spending never re-grants', async () => {
    await persistentEconomy.provisionPersistentAccount({ userId: 1 });
    await db.query(`UPDATE coins SET current_price = 10 WHERE coin_id = 1`);
    await persistentEconomy.buyPersistentTrade({ userId: 1, coinId: 1, quantity: 10 }); // £100 spent

    const replay = await persistentEconomy.provisionPersistentAccount({ userId: 1 });
    expect(replay.cash).toBe(9900); // unchanged — exactly once
    expect((await accountRow(1)).length).toBe(1);
  });

  test('concurrent first provisioning races grant exactly once', async () => {
    const results = await Promise.allSettled([
      persistentEconomy.provisionPersistentAccount({ userId: 2 }),
      persistentEconomy.provisionPersistentAccount({ userId: 2 }),
      persistentEconomy.provisionPersistentAccount({ userId: 2 })
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    expect(fulfilled.length).toBe(3);
    const ids = new Set(fulfilled.map((a) => a.accountId));
    expect(ids.size).toBe(1);
    const rows = await accountRow(2);
    expect(rows.length).toBe(1);
    expect(parseFloat(rows[0].cash)).toBe(10000);
  });

  test('one account per user is enforced structurally (UNIQUE world_id, user_id)', async () => {
    await persistentEconomy.provisionPersistentAccount({ userId: 2 });
    const world = await persistentWorld.resolveActiveWorld(db);
    await expect(
      db.query(
        `INSERT INTO persistent_accounts (world_id, user_id, starting_cash, cash) VALUES ($1, 2, 10000, 10000)`,
        [world.worldId]
      )
    ).rejects.toThrow();
    expect(parseFloat((await accountRow(2))[0].cash)).toBe(10000);
  });

  test('provisioning with no active world fails loudly (never fabricates one)', async () => {
    await db.query('DELETE FROM market_worlds');
    await expect(
      persistentEconomy.provisionPersistentAccount({ userId: 1 })
    ).rejects.toThrow(/no active market world/);
    expect((await accountRow(1)).length).toBe(0);
  });
});

describe('Stage 5: persistent BUY — atomicity, validation, ledger', () => {
  beforeEach(async () => {
    assertDisposableTestDatabase();
    await provisionedWorld();
    await db.query('UPDATE coins SET current_price = 10 WHERE coin_id = 1');
  });

  test('a buy debits cash exactly, opens the holding with cost basis, and writes the ledger after success', async () => {
    const result = await persistentEconomy.buyPersistentTrade({ userId: 1, coinId: 1, quantity: 10 });
    expect(result.transaction.type).toBe('BUY');
    expect(result.transaction.price).toBe(10); // server-locked price
    expect(result.transaction.totalAmount).toBe(100);

    const rows = await accountRow(1);
    expect(rows.length).toBe(1); // provisioned inside the trade, exactly once
    expect(parseFloat(rows[0].cash)).toBe(9900);
    expect(parseFloat(rows[0].starting_cash)).toBe(10000);

    const holding = await holdingRow(1, 1);
    expect(parseFloat(holding.quantity)).toBe(10);
    expect(parseFloat(holding.cost_basis)).toBe(100);

    const ledger = await ledgerRows(1);
    expect(ledger.length).toBe(1);
    expect(ledger[0].type).toBe('BUY');
    expect(parseFloat(ledger[0].price)).toBe(10);
    expect(parseFloat(ledger[0].total_amount)).toBe(100);

    expect(result.account.wealth).toBe(10000); // 9900 cash + £100 holdings
  });

  test('overspend is rejected and writes nothing (rollback leaves no trace)', async () => {
    await persistentEconomy.provisionPersistentAccount({ userId: 1 });
    await expect(
      persistentEconomy.buyPersistentTrade({ userId: 1, coinId: 1, quantity: 1001 }) // £10,010 > £10,000
    ).rejects.toThrow(/Insufficient persistent cash/);

    expect(parseFloat((await accountRow(1))[0].cash)).toBe(10000);
    expect(await holdingRow(1, 1)).toBeNull();
    expect((await ledgerRows(1)).length).toBe(0);
  });

  test('the minimum notional is enforced (a sub-penny buy mints nothing)', async () => {
    await db.query('UPDATE coins SET current_price = 0.0001 WHERE coin_id = 1');
    await expect(
      persistentEconomy.buyPersistentTrade({ userId: 1, coinId: 1, quantity: 10 }) // £0.001 < £0.01
    ).rejects.toThrow(/at least £0\.01/);
    expect((await accountRow(1)).length).toBe(0); // nothing provisioned by the failed trade
  });

  test.each([
    ['zero', 0],
    ['negative', -5],
    ['NaN', NaN],
    ['too many decimals', '1.000000001']
  ])('an invalid quantity (%s) is rejected before any write', async (_label, quantity) => {
    await expect(
      persistentEconomy.buyPersistentTrade({ userId: 1, coinId: 1, quantity })
    ).rejects.toThrow(/Invalid quantity/);
    expect((await accountRow(1)).length).toBe(0);
  });

  test('a persistently DEAD coin cannot be bought (trading stops at death)', async () => {
    const world = await persistentWorld.resolveActiveWorld(db);
    await db.query(
      `INSERT INTO market_coin_state (coin_id, world_id, archetype, condition, structural_reference, peak_reference)
       VALUES (1, $1, 'ZIP', 0, 10, 10)`,
      [world.worldId]
    );
    await coinStateModel.recordDeath(db, { coinId: 1, worldId: world.worldId, diedAt: new Date() });
    await db.query('UPDATE coins SET current_price = 0 WHERE coin_id = 1');

    await expect(
      persistentEconomy.buyPersistentTrade({ userId: 1, coinId: 1, quantity: 1 })
    ).rejects.toThrow(/permanently dead/);
    expect((await accountRow(1)).length).toBe(0);
  });

  test('a retired catalogue coin cannot be bought', async () => {
    await db.query('UPDATE coins SET retired = TRUE WHERE coin_id = 1');
    await expect(
      persistentEconomy.buyPersistentTrade({ userId: 1, coinId: 1, quantity: 1 })
    ).rejects.toThrow(/retired/);
    expect((await accountRow(1)).length).toBe(0);
  });

  test('concurrent buys can never overspend: exactly the affordable subset lands', async () => {
    await persistentEconomy.provisionPersistentAccount({ userId: 1 });
    // Two £8,000 buys against £10,000: exactly one can succeed.
    const results = await Promise.allSettled([
      persistentEconomy.buyPersistentTrade({ userId: 1, coinId: 1, quantity: 800 }),
      persistentEconomy.buyPersistentTrade({ userId: 1, coinId: 1, quantity: 800 })
    ]);
    const succeeded = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    expect(succeeded.length).toBe(1);
    expect(failed.length).toBe(1);
    expect(String(failed[0].reason.message)).toMatch(/Insufficient persistent cash/);

    const cash = parseFloat((await accountRow(1))[0].cash);
    expect(cash).toBe(2000);
    expect(cash).toBeGreaterThanOrEqual(0); // never negative
    const holding = await holdingRow(1, 1);
    expect(parseFloat(holding.quantity)).toBe(800);
    expect((await ledgerRows(1)).length).toBe(1);
  });

  test('weighted-average cost basis accumulates across buys at different prices', async () => {
    await persistentEconomy.buyPersistentTrade({ userId: 1, coinId: 1, quantity: 10 }); // £100 @ £10
    await db.query('UPDATE coins SET current_price = 20 WHERE coin_id = 1');
    await persistentEconomy.buyPersistentTrade({ userId: 1, coinId: 1, quantity: 10 }); // £200 @ £20

    const holding = await holdingRow(1, 1);
    expect(parseFloat(holding.quantity)).toBe(20);
    expect(parseFloat(holding.cost_basis)).toBe(300);
  });
});

describe('Stage 5: persistent SELL — oversell guard, cost basis, ledger', () => {
  beforeEach(async () => {
    assertDisposableTestDatabase();
    await provisionedWorld();
    await db.query('UPDATE coins SET current_price = 10 WHERE coin_id = 1');
    await persistentEconomy.buyPersistentTrade({ userId: 1, coinId: 1, quantity: 10 }); // £100
  });

  test('a sell credits cash exactly, decrements the holding and writes the ledger', async () => {
    const result = await persistentEconomy.sellPersistentTrade({ userId: 1, coinId: 1, quantity: 4 });
    expect(result.transaction.type).toBe('SELL');
    expect(result.transaction.price).toBe(10);
    expect(result.transaction.totalAmount).toBe(40);

    expect(parseFloat((await accountRow(1))[0].cash)).toBe(9940); // 9900 + 40
    const holding = await holdingRow(1, 1);
    expect(parseFloat(holding.quantity)).toBe(6);
    expect(parseFloat(holding.cost_basis)).toBe(60); // proportionate remainder

    const ledger = await ledgerRows(1);
    expect(ledger.map((r) => r.type)).toEqual(['BUY', 'SELL']);
  });

  test('a full sale zeroes the cost basis', async () => {
    await persistentEconomy.sellPersistentTrade({ userId: 1, coinId: 1, quantity: 10 });
    const holding = await holdingRow(1, 1);
    expect(parseFloat(holding.quantity)).toBe(0);
    expect(parseFloat(holding.cost_basis)).toBe(0);
    expect(parseFloat((await accountRow(1))[0].cash)).toBe(10000);
  });

  test('oversell is rejected and writes nothing', async () => {
    await expect(
      persistentEconomy.sellPersistentTrade({ userId: 1, coinId: 1, quantity: 11 })
    ).rejects.toThrow(/Insufficient persistent holdings/);
    expect(parseFloat((await accountRow(1))[0].cash)).toBe(9900);
    expect(parseFloat((await holdingRow(1, 1)).quantity)).toBe(10);
    expect((await ledgerRows(1)).length).toBe(1); // only the buy
  });

  test('selling a coin with no holding is rejected', async () => {
    await expect(
      persistentEconomy.sellPersistentTrade({ userId: 1, coinId: 2, quantity: 1 })
    ).rejects.toThrow(/Insufficient persistent holdings/);
  });

  test('a persistently DEAD coin cannot be sold (trading stops at death; holding stays on the books)', async () => {
    const world = await persistentWorld.resolveActiveWorld(db);
    await db.query(
      `INSERT INTO market_coin_state (coin_id, world_id, archetype, condition, structural_reference, peak_reference)
       VALUES (1, $1, 'ZIP', 0, 10, 10)`,
      [world.worldId]
    );
    await coinStateModel.recordDeath(db, { coinId: 1, worldId: world.worldId, diedAt: new Date() });
    await db.query('UPDATE coins SET current_price = 0 WHERE coin_id = 1');

    await expect(
      persistentEconomy.sellPersistentTrade({ userId: 1, coinId: 1, quantity: 1 })
    ).rejects.toThrow(/permanently dead/);
    expect(parseFloat((await holdingRow(1, 1)).quantity)).toBe(10); // untouched
    expect(parseFloat((await accountRow(1))[0].cash)).toBe(9900);
  });

  test('concurrent sells can never oversell: exactly the sellable subset lands', async () => {
    // Holding 10; two concurrent sells of 6: exactly one can succeed.
    const results = await Promise.allSettled([
      persistentEconomy.sellPersistentTrade({ userId: 1, coinId: 1, quantity: 6 }),
      persistentEconomy.sellPersistentTrade({ userId: 1, coinId: 1, quantity: 6 })
    ]);
    const succeeded = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    expect(succeeded.length).toBe(1);
    expect(failed.length).toBe(1);
    expect(String(failed[0].reason.message)).toMatch(/Insufficient persistent holdings/);

    const holding = await holdingRow(1, 1);
    expect(parseFloat(holding.quantity)).toBe(4);
    expect(parseFloat(holding.quantity)).toBeGreaterThanOrEqual(0); // never negative
    expect(parseFloat((await accountRow(1))[0].cash)).toBe(9960); // 9900 + 60
    expect((await ledgerRows(1)).length).toBe(2); // buy + one sell
  });
});

describe('Stage 5: persistent account state reads', () => {
  beforeEach(async () => {
    assertDisposableTestDatabase();
    await provisionedWorld();
  });

  test('an unprovisioned user reads null (the caller decides; trades provision)', async () => {
    expect(await persistentEconomy.getPersistentAccountState({ userId: 2 })).toBeNull();
  });

  test('wealth = cash + live holdings value at current server prices', async () => {
    await db.query('UPDATE coins SET current_price = 10 WHERE coin_id = 1');
    await persistentEconomy.buyPersistentTrade({ userId: 1, coinId: 1, quantity: 10 });
    await db.query('UPDATE coins SET current_price = 12 WHERE coin_id = 1'); // price moved

    const state = await persistentEconomy.getPersistentAccountState({ userId: 1 });
    expect(state.cash).toBe(9900);
    expect(state.holdings.length).toBe(1);
    expect(state.holdings[0].currentValue).toBe(120);
    expect(state.holdingsValue).toBe(120);
    expect(state.wealth).toBe(10020);
  });
});
