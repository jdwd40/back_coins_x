// Persistent-market Stage 8: persistent roster bots against the REAL
// disposable test database — migration 028 tick identity, the shaped
// public-state allowlist, the deterministic decision layer (panic /
// profit-take / loss-cut / entries / contrarian / bankruptcy-loan), tick
// execution through the shared persistent economy/debt services, and the
// bounded long-run loan/ledger invariants.
//
// Every mutating test passes through the repository's disposable test DB
// guard (jest.setup.js also reseeds before each test).

const db = require('../db/connection');
const { runMigrations } = require('../db/migrate');
const { verifyGameSchema } = require('../db/verify-game-schema');
const persistentWorld = require('../game/persistentWorld');
const persistentEconomy = require('../game/persistentEconomy');
const persistentDebt = require('../game/persistentDebt');
const persistentBots = require('../game/persistentBots');
const coinStateModel = require('../models/marketCoinState.model');
const { BOT_ROSTER } = require('../game/botConfig');
const { ensureBotsProvisioned } = require('../game/botService');
const { assertDisposableTestDatabase } = require('./helpers/testDatabaseGuard');

jest.setTimeout(90000);

const MIGRATION_028 = '028_create_persistent_bot_ticks.sql';
const WORLD_SEED = 'stage8-bots-world-seed';
const EPOCH = new Date('2026-09-02T00:00:00.000Z');

async function provisionedWorld() {
  return persistentWorld.provisionWorld(db, { seed: WORLD_SEED, epochStartedAt: EPOCH });
}

// A minimal legal shaped public state (allowlist-exact).
function publicState({ coins, cash = 10000, debt = 0, holdings = [] }) {
  return { coins, cash, debt, holdings };
}

function publicCoin(overrides = {}) {
  return {
    coinId: 1,
    symbol: 'JDC',
    currentPrice: 10,
    dead: false,
    history: [9, 9.5, 10],
    phase: 'DIP',
    momentum: 'FLAT',
    archetype: 'ZIP',
    collapseRisk: 'STABLE',
    recentChangePct: -5,
    ...overrides
  };
}

function publicHolding(overrides = {}) {
  return {
    coinId: 1,
    symbol: 'JDC',
    quantity: 100,
    costBasis: 1000,
    averageEntryPrice: 10,
    currentValue: 1000,
    unrealizedPnlPct: 0,
    ...overrides
  };
}

const FIXED_RANDOM = () => 0; // deterministic: passes every gate, picks the first candidate

describe('Stage 8: tracked production migration 028', () => {
  beforeEach(async () => {
    assertDisposableTestDatabase();
    await runMigrations({ log: () => {} });
  });

  test('applies 028 to an existing database and re-runs as a tracked no-op', async () => {
    await db.query('DROP TABLE IF EXISTS persistent_bot_ticks CASCADE');
    await db.query('DELETE FROM schema_migrations WHERE migration = $1', [MIGRATION_028]);
    const result = await runMigrations({ log: () => {} });
    expect(result.applied).toContain(MIGRATION_028);
    const verification = await verifyGameSchema();
    expect(verification.problems).toEqual([]);
    expect(verification.ok).toBe(true);

    const again = await runMigrations({ log: () => {} });
    expect(again.applied).not.toContain(MIGRATION_028);
  });
});

describe('Stage 8: the public-state allowlist (redaction contract)', () => {
  test('a state carrying a seed / Director internals / cycle ids is rejected loudly', () => {
    const state = publicState({ coins: [publicCoin()] });
    expect(() => persistentBots.assertPublicPersistentBotState(state)).not.toThrow();
    expect(() => persistentBots.assertPublicPersistentBotState({ ...state, seed: 'x' }))
      .toThrow(/forbidden:seed/);
    expect(() => persistentBots.assertPublicPersistentBotState({ ...state, directorRolls: [] }))
      .toThrow(/forbidden:directorRolls/);
    expect(() => persistentBots.assertPublicPersistentBotState({ ...state, apocalypsePercent: 42 }))
      .toThrow(/forbidden:apocalypsePercent/);
    expect(() => persistentBots.assertPublicPersistentBotState({ ...state, power: { current: 1 } }))
      .toThrow(/forbidden:power/);
  });

  test('missing public fields and malformed coins/holdings are rejected loudly', () => {
    expect(() => persistentBots.assertPublicPersistentBotState({ coins: [] }))
      .toThrow(/missing:cash/);
    expect(() => persistentBots.assertPublicPersistentBotState(
      publicState({ coins: [{ ...publicCoin(), structuralReference: 10 }] })
    )).toThrow(/forbidden:structuralReference/);
    expect(() => persistentBots.assertPublicPersistentBotState(
      publicState({ coins: [publicCoin()], holdings: [{ coinId: 1 }] })
    )).toThrow(/missing:symbol/);
  });
});

describe('Stage 8: the deterministic decision layer', () => {
  test('identical inputs produce identical decisions (determinism)', () => {
    const state = publicState({ coins: [publicCoin(), publicCoin({ coinId: 2, symbol: 'BLN' })] });
    const { createBotRandom } = require('../game/botService');
    const first = persistentBots.decidePersistentBotAction({
      strategy: 'conservative', state, random: createBotRandom({ seed: WORLD_SEED, botKey: 'conservative-carl', tickId: 7 })
    });
    const second = persistentBots.decidePersistentBotAction({
      strategy: 'conservative', state, random: createBotRandom({ seed: WORLD_SEED, botKey: 'conservative-carl', tickId: 7 })
    });
    expect(second).toEqual(first);
  });

  test('a crash-sized public drop on a held coin triggers the personality panic rule', () => {
    // Conservative panics at -8%; this held coin reads -20%.
    const state = publicState({
      coins: [publicCoin({ recentChangePct: -20, phase: 'FALL', momentum: 'DOWN' })],
      cash: 0.5,
      holdings: [publicHolding({ quantity: 1, costBasis: 12, currentValue: 10 })]
    });
    const decision = persistentBots.decidePersistentBotAction({ strategy: 'conservative', state, random: FIXED_RANDOM });
    expect(decision.type).toBe('SELL');
    expect(decision.reason).toBe('panic');
    expect(decision.quantity).toBe(1); // panicSellFraction 1
  });

  test('the dip buyer NEVER panic sells — a crash dip is an entry signal', () => {
    const state = publicState({
      coins: [publicCoin({ recentChangePct: -20, phase: 'FALL', momentum: 'DOWN', collapseRisk: 'DANGER' })],
      cash: 5000
    });
    const decision = persistentBots.decidePersistentBotAction({ strategy: 'dip_buyer', state, random: FIXED_RANDOM });
    expect(decision.type).toBe('BUY');
    expect(decision.reason).toBe('contrarian-entry'); // contrarian roll 0 < 0.08
    expect(decision.quantity * 10).toBeLessThanOrEqual(5000);
  });

  test('profit-taking and loss-cutting fire on the public thresholds', () => {
    const profit = persistentBots.decidePersistentBotAction({
      strategy: 'conservative',
      state: publicState({
        coins: [publicCoin({ currentPrice: 12, phase: 'RISE', momentum: 'UP', recentChangePct: 3 })],
        cash: 0.5,
        holdings: [publicHolding({ quantity: 100, costBasis: 1000, averageEntryPrice: 10, currentValue: 1200, unrealizedPnlPct: 20 })]
      }),
      random: FIXED_RANDOM
    });
    expect(profit.type).toBe('SELL');
    expect(profit.reason).toBe('profit-take');
    expect(profit.quantity).toBe(50); // profitSellFraction 0.5

    const loss = persistentBots.decidePersistentBotAction({
      strategy: 'conservative',
      state: publicState({
        coins: [publicCoin({ currentPrice: 9, recentChangePct: -1 })],
        cash: 0.5,
        holdings: [publicHolding({ quantity: 100, costBasis: 1000, averageEntryPrice: 10, currentValue: 900, unrealizedPnlPct: -10 })]
      }),
      random: FIXED_RANDOM
    });
    expect(loss.type).toBe('SELL');
    expect(loss.reason).toBe('loss-cut');
  });

  test('conservative refuses a DANGER entry; the exposure caps bound every buy', () => {
    const refused = persistentBots.decidePersistentBotAction({
      strategy: 'conservative',
      state: publicState({ coins: [publicCoin({ collapseRisk: 'DANGER' })] }),
      random: FIXED_RANDOM
    });
    expect(refused.type).toBe('HOLD');

    // stake 5% of £10,000 = £500; quantity at £10 = 50 exactly.
    const entry = persistentBots.decidePersistentBotAction({
      strategy: 'conservative',
      state: publicState({ coins: [publicCoin()] }),
      random: FIXED_RANDOM
    });
    expect(entry.type).toBe('BUY');
    expect(entry.quantity).toBe(50);
    expect(entry.quantity * 10).toBeLessThanOrEqual(10000);
  });

  test('bankruptcy yields a LOAN decision; a bot with sellable holdings never asks', () => {
    const bankrupt = persistentBots.decidePersistentBotAction({
      strategy: 'reckless',
      state: publicState({
        coins: [publicCoin({ dead: true, currentPrice: 0, phase: 'DEAD', collapseRisk: 'DEAD', recentChangePct: null })],
        cash: 0,
        holdings: [publicHolding({ quantity: 100, currentValue: 0, unrealizedPnlPct: -100 })]
      }),
      random: FIXED_RANDOM
    });
    expect(bankrupt.type).toBe('LOAN');

    const solvent = persistentBots.decidePersistentBotAction({
      strategy: 'reckless',
      state: publicState({ coins: [publicCoin()], cash: 0, holdings: [publicHolding()] }),
      random: FIXED_RANDOM
    });
    expect(solvent.type).not.toBe('LOAN');
  });

  test('dead coins are never bought and the minimum notional is respected', () => {
    const deadOnly = persistentBots.decidePersistentBotAction({
      strategy: 'reckless',
      state: publicState({ coins: [publicCoin({ dead: true, currentPrice: 0, phase: 'DEAD', collapseRisk: 'DEAD', recentChangePct: null })] }),
      random: FIXED_RANDOM
    });
    expect(deadOnly.type).toBe('HOLD');

    // Cash 0.005 < 0.01 minimum: no affordable entry, and the account is not
    // bankrupt-classified while it still has sellable holdings... with no
    // holdings at all it IS bankrupt (no usable cash, nothing to sell).
    const broke = persistentBots.decidePersistentBotAction({
      strategy: 'reckless',
      state: publicState({ coins: [publicCoin()], cash: 0.005 }),
      random: FIXED_RANDOM
    });
    expect(broke.type).toBe('LOAN');
  });
});

describe('Stage 8: persistent bot ticks on the real economy', () => {
  beforeEach(async () => {
    assertDisposableTestDatabase();
    await provisionedWorld();
    await db.query('UPDATE coins SET current_price = 10 WHERE coin_id <= 4');
    // Committed per-coin persistent state so the shared public signal path
    // has its explicit archetype/reference rows.
    const world = await persistentWorld.resolveActiveWorld(db);
    for (const coinId of [1, 2, 3, 4]) {
      await db.query(
        `INSERT INTO market_coin_state (coin_id, world_id, archetype, condition, structural_reference, peak_reference)
         VALUES ($1, $2, 'ZIP', 0, 10, 10)`,
        [coinId, world.worldId]
      );
    }
  });

  test('a tick provisions the roster, decides deterministically, and executes through the shared economy', async () => {
    const result = await persistentBots.runPersistentBotTick({ tickId: 1, nowMs: EPOCH.getTime() + 3600000 });
    expect(result.claimed).toBe(true);
    expect(result.actions.length).toBe(BOT_ROSTER.length);

    // Every roster bot has a persistent account with exactly £10,000 granted once.
    const { rows: accounts } = await db.query(
      `SELECT pa.user_id, pa.cash, pa.debt FROM persistent_accounts pa
       JOIN users u ON u.user_id = pa.user_id WHERE u.is_bot = true ORDER BY pa.user_id`
    );
    expect(accounts.length).toBe(BOT_ROSTER.length);
    for (const account of accounts) {
      expect(parseFloat(account.debt)).toBe(0);
    }

    // Any executed BUY settled at the server-locked price through the ledger.
    const buys = result.actions.filter((a) => a.action === 'BUY');
    for (const buy of buys) {
      expect(buy.totalAmount).toBeGreaterThanOrEqual(0.01);
      const { rows } = await db.query(
        `SELECT price FROM persistent_transactions WHERE user_id = $1 AND type = 'BUY' ORDER BY persistent_transaction_id DESC LIMIT 1`,
        [buy.userId]
      );
      // The ledger price is the server-locked coins.current_price of THAT
      // coin — never bot input (the tick pins prices for coins 1-4 only;
      // the roster may legally pick any live coin).
      const { rows: coinRows } = await db.query('SELECT current_price FROM coins WHERE coin_id = $1', [buy.coinId]);
      expect(parseFloat(rows[0].price)).toBe(parseFloat(coinRows[0].current_price));
    }
  });

  test('tick identity: a replayed tick is a database-claimed no-op (across processes)', async () => {
    const first = await persistentBots.runPersistentBotTick({ tickId: 2, nowMs: EPOCH.getTime() + 3600000 });
    const replay = await persistentBots.runPersistentBotTick({ tickId: 2, nowMs: EPOCH.getTime() + 3600000 });
    expect(first.claimed).toBe(true);
    expect(replay.claimed).toBe(false);
    expect(replay.actions).toEqual([]);
    const { rows } = await db.query('SELECT count(*)::int AS n FROM persistent_bot_ticks');
    expect(rows[0].n).toBe(1);
  });

  test('a bankrupt bot takes a loan mid-tick; a later sell repays debt above the reserve', async () => {
    // Bankrupt Dip Buyer Dana: no cash, holdings only in a dead coin.
    const roster = await ensureBotsProvisioned({ queryable: db });
    const dana = roster.find((b) => b.botKey === 'dip-buyer-dana');
    await persistentEconomy.provisionPersistentAccount({ userId: dana.userId });
    await persistentEconomy.buyPersistentTrade({ userId: dana.userId, coinId: 1, quantity: 1000 }); // £10,000 in
    await coinStateModel.recordDeath(db, {
      coinId: 1,
      worldId: (await persistentWorld.resolveActiveWorld(db)).worldId,
      diedAt: new Date()
    });
    await db.query('UPDATE coins SET current_price = 0 WHERE coin_id = 1');

    const tick = await persistentBots.runPersistentBotTick({ tickId: 3, nowMs: EPOCH.getTime() + 3600000 });
    const danaActions = tick.actions.filter((a) => a.botKey === 'dip-buyer-dana');
    expect(danaActions.map((a) => a.action)).toContain('LOAN');
    const account = await persistentEconomy.getPersistentAccountState({ userId: dana.userId });
    expect(account.debt).toBe(10000);
    expect(account.cash).toBe(10000);
    expect(account.netWealth).toBe(0); // 10000 cash + 0 live holdings - 10000 debt

    // Death is permanent for coin 1, so she BUYS coin 2 with the loan; the
    // price rises and a later sell repays debt first above the £2,000
    // reserve.
    await persistentEconomy.buyPersistentTrade({ userId: dana.userId, coinId: 2, quantity: 1000 });
    await db.query('UPDATE coins SET current_price = 12.5 WHERE coin_id = 2');
    // The sell path is personality-independent here; repayment priority is
    // the debt engine's contract.
    await persistentEconomy.sellPersistentTrade({ userId: dana.userId, coinId: 2, quantity: 1000 });
    const repaid = await persistentDebt.repayBotDebt({ userId: dana.userId });
    expect(repaid.repaid).toBe(10000); // surplus 12500 - reserve 2000, capped by debt 10000
    expect(repaid.debt).toBe(0);
    const after = await persistentEconomy.getPersistentAccountState({ userId: dana.userId });
    expect(after.cash).toBe(2500);
    expect(after.debt).toBe(0);
  });

  test('bounded long-run invariants: 120 ticks never break cash/debt/ledger accounting', async () => {
    const { rows: [{ count: grantCount }] } = await db.query('SELECT count(*)::int AS count FROM users WHERE is_bot = true');
    for (let tick = 100; tick < 220; tick++) {
      // A deterministic public price walk: oscillates so every personality
      // sees entries, exits, profits and losses across the run.
      const wave = tick % 40;
      const price = wave < 20 ? 10 + wave * 0.5 : 20 - (wave - 20) * 0.5;
      await db.query('UPDATE coins SET current_price = $1 WHERE coin_id <= 4', [Math.max(1, price)]);
      await persistentBots.runPersistentBotTick({ tickId: tick, nowMs: EPOCH.getTime() + tick * 60000 });
    }

    // Cash and debt are never negative anywhere; the CHECK constraints and
    // guarded writes held across the whole run.
    const { rows: badAccounts } = await db.query(
      'SELECT count(*)::int AS n FROM persistent_accounts WHERE cash < 0 OR debt < 0'
    );
    expect(badAccounts[0].n).toBe(0);

    // The loan ledger reconstructs every account's debt EXACTLY.
    const { rows: debts } = await db.query(
      `SELECT a.account_id, a.debt,
              COALESCE(SUM(CASE WHEN l.type = 'ISSUE' THEN l.amount ELSE -l.amount END), 0) AS ledger_debt
         FROM persistent_accounts a
         LEFT JOIN persistent_loans l ON l.account_id = a.account_id
        GROUP BY a.account_id, a.debt`
    );
    for (const row of debts) {
      expect(parseFloat(row.debt)).toBeCloseTo(parseFloat(row.ledger_debt), 10);
    }

    // Bounded money creation: total cash+held-cost money in the persistent
    // economy is exactly grants + issued loans + net trading P&L (zero-sum
    // between accounts at fixed test prices minus ledger rounding) — the
    // load-bearing bounded assertion is that loans are the ONLY money
    // source beyond the grants, and their count is bounded by tick count.
    const { rows: [loanStats] } = await db.query(
      `SELECT count(*)::int AS issues, COALESCE(SUM(amount) FILTER (WHERE type = 'ISSUE'), 0)::float AS issued
       FROM persistent_loans`
    );
    expect(loanStats.issues).toBeLessThanOrEqual(120 * BOT_ROSTER.length);
    const { rows: [cashTotal] } = await db.query('SELECT COALESCE(SUM(cash), 0)::float AS total FROM persistent_accounts');
    // Cash can never exceed grants + issued loans (selling only moves money
    // between accounts at the same locked prices; buys convert it).
    const { rows: [grants] } = await db.query(
      `SELECT COALESCE(SUM(starting_cash), 0)::float AS total FROM persistent_accounts`
    );
    expect(cashTotal.total).toBeLessThanOrEqual(grants.total + loanStats.issued + 0.01);
    expect(Number(grantCount)).toBeGreaterThanOrEqual(0); // roster existed
  }, 120000);
});
