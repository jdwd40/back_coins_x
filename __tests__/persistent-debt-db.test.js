// Persistent-market Stage 8: bot-only persistent debt against the REAL
// disposable test database — migration 027 (persistent_accounts.debt +
// persistent_loans), the bankruptcy predicate, interest-free £10,000 loans,
// automatic repayment above the operating reserve, debt persistence, the
// loan ledger, and debt-adjusted wealth in the account read.
//
// Every mutating test passes through the repository's disposable test DB
// guard (jest.setup.js also reseeds before each test).

const db = require('../db/connection');
const { runMigrations } = require('../db/migrate');
const { verifyGameSchema } = require('../db/verify-game-schema');
const persistentWorld = require('../game/persistentWorld');
const persistentEconomy = require('../game/persistentEconomy');
const persistentDebt = require('../game/persistentDebt');
const coinStateModel = require('../models/marketCoinState.model');
const { assertDisposableTestDatabase } = require('./helpers/testDatabaseGuard');

jest.setTimeout(60000);

const MIGRATION_027 = '027_create_persistent_bot_debt.sql';
const WORLD_SEED = 'stage8-debt-world-seed';
const EPOCH = new Date('2026-09-02T00:00:00.000Z');

async function provisionedWorld() {
  return persistentWorld.provisionWorld(db, { seed: WORLD_SEED, epochStartedAt: EPOCH });
}

async function makeBot(userId, username) {
  await db.query(
    `INSERT INTO users (user_id, username, email, password_hash, funds, is_bot)
     VALUES ($1, $2, $3, 'x', 0, true)
     ON CONFLICT (user_id) DO UPDATE SET is_bot = true`,
    [userId, username, `${username}@bots.test`]
  );
}

// Kill coin 1 persistently: explicit state row + recorded death + £0 price.
async function killCoin1() {
  const world = await persistentWorld.resolveActiveWorld(db);
  await db.query(
    `INSERT INTO market_coin_state (coin_id, world_id, archetype, condition, structural_reference, peak_reference)
     VALUES (1, $1, 'ZIP', 0, 10, 10)`,
    [world.worldId]
  );
  await coinStateModel.recordDeath(db, { coinId: 1, worldId: world.worldId, diedAt: new Date() });
  await db.query('UPDATE coins SET current_price = 0 WHERE coin_id = 1');
}

async function accountOf(userId) {
  const { rows } = await db.query(
    'SELECT account_id, cash, debt FROM persistent_accounts WHERE user_id = $1',
    [userId]
  );
  return rows[0] || null;
}

async function loanRows(userId) {
  const { rows } = await db.query(
    'SELECT type, amount, debt_after FROM persistent_loans WHERE user_id = $1 ORDER BY persistent_loan_id',
    [userId]
  );
  return rows;
}

describe('Stage 8: tracked production migration 027', () => {
  beforeEach(async () => {
    assertDisposableTestDatabase();
    await runMigrations({ log: () => {} });
  });

  test('applies 027 to an existing database, preserving all pre-existing schema and data', async () => {
    await persistentWorld.provisionWorld(db, { seed: 'stage8-migration-world', epochStartedAt: EPOCH });
    await persistentEconomy.provisionPersistentAccount({ userId: 1 });
    const usersBefore = await db.query('SELECT count(*)::int AS n FROM users');
    const accountsBefore = await db.query('SELECT count(*)::int AS n FROM persistent_accounts');

    await db.query('DROP TABLE IF EXISTS persistent_loans CASCADE');
    await db.query('ALTER TABLE persistent_accounts DROP COLUMN debt');
    await db.query('DELETE FROM schema_migrations WHERE migration = $1', [MIGRATION_027]);
    const result = await runMigrations({ log: () => {} });
    expect(result.applied).toContain(MIGRATION_027);

    const verification = await verifyGameSchema();
    expect(verification.problems).toEqual([]);
    expect(verification.ok).toBe(true);

    // Existing accounts survive with debt 0 (the safe DEFAULT).
    expect((await db.query('SELECT count(*)::int AS n FROM users')).rows[0].n).toBe(usersBefore.rows[0].n);
    expect((await db.query('SELECT count(*)::int AS n FROM persistent_accounts')).rows[0].n).toBe(accountsBefore.rows[0].n);
    const account = await accountOf(1);
    expect(parseFloat(account.debt)).toBe(0);
  });

  test('re-running the migration on an already-migrated database is a tracked no-op', async () => {
    const result = await runMigrations({ log: () => {} });
    expect(result.applied).not.toContain(MIGRATION_027);
    const verification = await verifyGameSchema();
    expect(verification.ok).toBe(true);
  });
});

describe('Stage 8: the bankruptcy predicate (pure)', () => {
  test('bankrupt requires BOTH no usable cash AND no meaningful sellable holdings', () => {
    const MIN = 0.01;
    expect(persistentDebt.isPersistentBankrupt({ cash: 0, sellableProceeds: 0 })).toBe(true);
    expect(persistentDebt.isPersistentBankrupt({ cash: 0.004, sellableProceeds: 0.009 })).toBe(true);
    // usable cash alone defeats bankruptcy
    expect(persistentDebt.isPersistentBankrupt({ cash: MIN, sellableProceeds: 0 })).toBe(false);
    expect(persistentDebt.isPersistentBankrupt({ cash: 500, sellableProceeds: 0 })).toBe(false);
    // meaningful sellable holdings alone defeat bankruptcy
    expect(persistentDebt.isPersistentBankrupt({ cash: 0, sellableProceeds: MIN })).toBe(false);
    expect(persistentDebt.isPersistentBankrupt({ cash: 0, sellableProceeds: 250 })).toBe(false);
  });

  test('invalid inputs fail loudly, never silently classify', () => {
    expect(() => persistentDebt.isPersistentBankrupt({ cash: -1, sellableProceeds: 0 })).toThrow(/cash/);
    expect(() => persistentDebt.isPersistentBankrupt({ cash: NaN, sellableProceeds: 0 })).toThrow(/cash/);
    expect(() => persistentDebt.isPersistentBankrupt({ cash: 0, sellableProceeds: -5 })).toThrow(/sellableProceeds/);
  });
});

describe('Stage 8: bot loans and repayment', () => {
  beforeEach(async () => {
    assertDisposableTestDatabase();
    await provisionedWorld();
    await makeBot(101, 'stage8_bot_alpha');
    await db.query('UPDATE coins SET current_price = 10 WHERE coin_id = 1');
  });

  test('humans can never receive a persistent loan or carry debt', async () => {
    await persistentEconomy.provisionPersistentAccount({ userId: 1 });
    await db.query(`UPDATE persistent_accounts SET cash = 0 WHERE user_id = 1`);
    await expect(persistentDebt.issueBotLoan({ userId: 1 })).rejects.toThrow(/bot-only/);
    await expect(persistentDebt.repayBotDebt({ userId: 1 })).rejects.toThrow(/bot-only/);
    expect((await loanRows(1)).length).toBe(0);
    expect(parseFloat((await accountOf(1)).debt)).toBe(0);
  });

  test('a solvent bot is refused a loan (no unearned money)', async () => {
    await persistentEconomy.provisionPersistentAccount({ userId: 101 }); // £10,000 cash
    await expect(persistentDebt.issueBotLoan({ userId: 101 })).rejects.toThrow(/not bankrupt/);
    expect((await loanRows(101)).length).toBe(0);
  });

  test('a bot with sellable holdings but no cash is NOT bankrupt — no loan', async () => {
    await persistentEconomy.buyPersistentTrade({ userId: 101, coinId: 1, quantity: 1000 }); // £10,000 in live holdings
    const account = await accountOf(101);
    expect(parseFloat(account.cash)).toBe(0);
    await expect(persistentDebt.issueBotLoan({ userId: 101 })).rejects.toThrow(/not bankrupt/);
  });

  test('a bankrupt bot (dead holdings only) receives exactly £10,000, once per bankruptcy', async () => {
    // Buy, then the coin dies persistently: the holding becomes unsellable £0 history.
    await persistentEconomy.buyPersistentTrade({ userId: 101, coinId: 1, quantity: 1000 });
    await killCoin1();

    const loan = await persistentDebt.issueBotLoan({ userId: 101 });
    expect(loan.amount).toBe(10000);
    expect(loan.debt).toBe(10000);
    expect(loan.cash).toBe(10000);

    const account = await accountOf(101);
    expect(parseFloat(account.cash)).toBe(10000);
    expect(parseFloat(account.debt)).toBe(10000);

    // The ledger reconstructs the debt exactly.
    const ledger = await loanRows(101);
    expect(ledger.length).toBe(1);
    expect(ledger[0].type).toBe('ISSUE');
    expect(parseFloat(ledger[0].amount)).toBe(10000);
    expect(parseFloat(ledger[0].debt_after)).toBe(10000);

    // Solvent again — a second loan is refused until the next bankruptcy.
    await expect(persistentDebt.issueBotLoan({ userId: 101 })).rejects.toThrow(/not bankrupt/);
  });

  test('multiple loans are allowed, each requiring a fresh bankruptcy', async () => {
    await persistentEconomy.provisionPersistentAccount({ userId: 101 });
    await db.query(`UPDATE persistent_accounts SET cash = 0 WHERE user_id = 101`);
    await persistentDebt.issueBotLoan({ userId: 101 });
    // Spend the entire loan on live coins, then kill the coin: bankrupt again.
    await persistentEconomy.buyPersistentTrade({ userId: 101, coinId: 1, quantity: 1000 });
    await killCoin1();
    const second = await persistentDebt.issueBotLoan({ userId: 101 });
    expect(second.debt).toBe(20000);
    expect(parseFloat((await accountOf(101)).debt)).toBe(20000);
    expect((await loanRows(101)).map((r) => r.type)).toEqual(['ISSUE', 'ISSUE']);
  });

  test('concurrent loan races issue exactly once per bankruptcy', async () => {
    await persistentEconomy.provisionPersistentAccount({ userId: 101 });
    await db.query(`UPDATE persistent_accounts SET cash = 0 WHERE user_id = 101`);
    const results = await Promise.allSettled([
      persistentDebt.issueBotLoan({ userId: 101 }),
      persistentDebt.issueBotLoan({ userId: 101 }),
      persistentDebt.issueBotLoan({ userId: 101 })
    ]);
    const issued = results.filter((r) => r.status === 'fulfilled');
    const refused = results.filter(
      (r) => r.status === 'rejected' && /not bankrupt/.test(r.reason.message)
    );
    expect(issued.length).toBe(1);
    expect(issued.length + refused.length).toBe(3);
    expect(parseFloat((await accountOf(101)).debt)).toBe(10000); // exactly one loan
    expect((await loanRows(101)).length).toBe(1);
  });

  test('repayment above the reserve: debt is repaid first, the reserve floor holds', async () => {
    await persistentEconomy.provisionPersistentAccount({ userId: 101 });
    await db.query(`UPDATE persistent_accounts SET cash = 0 WHERE user_id = 101`);
    await persistentDebt.issueBotLoan({ userId: 101 }); // cash 10000, debt 10000

    // Repay: surplus = 10000 - 2000 reserve = 8000.
    const repay = await persistentDebt.repayBotDebt({ userId: 101 });
    expect(repay.repaid).toBe(8000);
    expect(repay.cash).toBe(2000); // the reserve floor is never breached
    expect(repay.debt).toBe(2000);

    // Within the reserve: a clean no-op.
    const noop = await persistentDebt.repayBotDebt({ userId: 101 });
    expect(noop.repaid).toBe(0);
    expect(noop.skipped).toBe('within-reserve');
    expect(parseFloat((await accountOf(101)).cash)).toBe(2000);
    expect(parseFloat((await accountOf(101)).debt)).toBe(2000);

    // A partial final repayment clears the remaining debt exactly.
    await db.query(`UPDATE persistent_accounts SET cash = 4000 WHERE user_id = 101`);
    const final = await persistentDebt.repayBotDebt({ userId: 101 });
    expect(final.repaid).toBe(2000); // min(surplus 2000, debt 2000)
    expect(final.debt).toBe(0);
    expect(final.cash).toBe(2000);

    const ledger = await loanRows(101);
    expect(ledger.map((r) => r.type)).toEqual(['ISSUE', 'REPAYMENT', 'REPAYMENT']);
    expect(parseFloat(ledger[2].debt_after)).toBe(0);
  });

  test('no debt is a clean no-op; a configurable reserve is honoured', async () => {
    await persistentEconomy.provisionPersistentAccount({ userId: 101 });
    const noDebt = await persistentDebt.repayBotDebt({ userId: 101 });
    expect(noDebt.repaid).toBe(0);
    expect(noDebt.skipped).toBe('no-debt');

    await db.query(`UPDATE persistent_accounts SET cash = 0 WHERE user_id = 101`);
    await persistentDebt.issueBotLoan({ userId: 101 });
    // A £9,000 reserve leaves only £1,000 repayable from the £10,000 loan cash.
    const repay = await persistentDebt.repayBotDebt({ userId: 101, reserve: 9000 });
    expect(repay.repaid).toBe(1000);
    expect(repay.cash).toBe(9000);
    expect(repay.debt).toBe(9000);
  });

  test('debt-adjusted wealth: the account read carries debt and netWealth', async () => {
    await persistentEconomy.provisionPersistentAccount({ userId: 101 });
    await db.query(`UPDATE persistent_accounts SET cash = 0 WHERE user_id = 101`);
    await persistentDebt.issueBotLoan({ userId: 101 });

    const state = await persistentEconomy.getPersistentAccountState({ userId: 101 });
    expect(state.debt).toBe(10000);
    expect(state.wealth).toBe(10000); // cash + live holdings
    expect(state.netWealth).toBe(0); // debt-adjusted: 10000 - 10000

    // Humans always read debt 0 and netWealth === wealth.
    await persistentEconomy.provisionPersistentAccount({ userId: 1 });
    const human = await persistentEconomy.getPersistentAccountState({ userId: 1 });
    expect(human.debt).toBe(0);
    expect(human.netWealth).toBe(human.wealth);
  });

  test('the bounded loan-ledger read reconstructs debt history newest first', async () => {
    await persistentEconomy.provisionPersistentAccount({ userId: 101 });
    await db.query(`UPDATE persistent_accounts SET cash = 0 WHERE user_id = 101`);
    await persistentDebt.issueBotLoan({ userId: 101 });
    await persistentDebt.repayBotDebt({ userId: 101 }); // repays 8000

    const account = await accountOf(101);
    const loans = await persistentDebt.getPersistentLoans({ accountId: account.account_id });
    expect(loans.length).toBe(2);
    expect(loans[0].type).toBe('REPAYMENT'); // newest first
    expect(loans[0].debtAfter).toBe(2000);
    expect(loans[1].type).toBe('ISSUE');
    expect(loans[1].debtAfter).toBe(10000);
  });
});
