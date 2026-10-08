// Issue #55: averageEntryPrice must not be rounded to pennies.
//
// The persistent account state rounded costBasis / quantity to 2dp, so a
// £1,000 buy of a £0.1089 coin showed an "Avg entry" of £0.1100 (position,
// Portfolio and chart entry line all read it), and the bots' profit-take /
// loss-cut thresholds were computed from the same rounded value. The
// monetary contracts are unchanged: costBasis, currentValue and
// unrealizedPnl stay 2dp money; only the PRICE ratio is returned precisely.
//
// Real-PG tests against the disposable coins_test DB (jest.setup reseeds).

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../app');
const db = require('../db/connection');
const persistentWorld = require('../game/persistentWorld');
const persistentEconomy = require('../game/persistentEconomy');
const persistentBots = require('../game/persistentBots');
const { assertDisposableTestDatabase } = require('./helpers/testDatabaseGuard');

jest.setTimeout(30000);

const ISSUE_QTY = 9182.73645546; // the playtest receipt: £1,000 of PLD
const ISSUE_PRICE = 0.1089;

function tokenFor(userId) {
  return jwt.sign({ user_id: userId }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

function formatPrice4(value) {
  return `£${value.toFixed(4)}`; // the frontend's sub-£1 display rule
}

describe('issue #55: precise average entry in the persistent account state', () => {
  beforeEach(async () => {
    assertDisposableTestDatabase();
    await persistentWorld.provisionWorld(db, { seed: 'issue55-avg-entry', epochStartedAt: new Date('2026-08-31T00:00:00.000Z') });
    await db.query('UPDATE coins SET current_price = $1 WHERE coin_id = 1', [ISSUE_PRICE]);
  });

  test('£1,000 of a £0.1089 coin: avg entry is £0.1089 (not £0.11) and cost basis stays £1,000.00', async () => {
    const buy = await request(app)
      .post('/api/persistent/trades/buy')
      .set('Authorization', `Bearer ${tokenFor(1)}`)
      .send({ coin_id: 1, quantity: ISSUE_QTY })
      .expect(201);
    expect(buy.body.data.transaction.totalAmount).toBe(1000);
    expect(buy.body.data.transaction.price).toBe(ISSUE_PRICE);

    const res = await request(app)
      .get('/api/persistent/account')
      .set('Authorization', `Bearer ${tokenFor(1)}`)
      .expect(200);
    const holding = res.body.data.holdings[0];
    expect(holding.quantity).toBe(ISSUE_QTY);
    expect(holding.costBasis).toBe(1000); // money contract: 2dp, unchanged
    expect(holding.averageEntryPrice).toBe(1000 / ISSUE_QTY); // the exact ratio
    expect(holding.averageEntryPrice).not.toBe(0.11);
    expect(Math.abs(holding.averageEntryPrice - ISSUE_PRICE)).toBeLessThan(1e-8);
    expect(formatPrice4(holding.averageEntryPrice)).toBe('£0.1089'); // matches the receipt
    // The P&L money fields remain 2dp and keep coming from costBasis.
    expect(Number.isInteger(Math.round(holding.unrealizedPnl * 100))).toBe(true);
    expect(holding.currentValue).toBe(1000);
  });

  test('a partial sale keeps the precise remaining average entry (proportional basis, 2dp money)', async () => {
    await persistentEconomy.buyPersistentTrade({ userId: 1, coinId: 1, quantity: ISSUE_QTY });
    await persistentEconomy.sellPersistentTrade({ userId: 1, coinId: 1, quantity: 4591.36822773 });
    const state = await persistentEconomy.getPersistentAccountState({ userId: 1 });
    const h = state.holdings[0];
    expect(h.costBasis).toBe(500);
    expect(h.averageEntryPrice).toBe(500 / h.quantity);
    expect(formatPrice4(h.averageEntryPrice)).toBe('£0.1089');
  });

  test('the bot shaped state carries the unrounded ratio from the account read', async () => {
    await persistentEconomy.buyPersistentTrade({ userId: 1, coinId: 1, quantity: ISSUE_QTY });
    const world = await persistentWorld.resolveActiveWorld(db);
    const account = await persistentEconomy.getPersistentAccountState({ userId: 1 });
    const state = await persistentBots.buildPublicPersistentMarketState({
      world, account, nowMs: Date.now(), snapshot: { coins: [], failures: [], liveCoinCount: 0, nowMs: Date.now() }
    });
    expect(state.holdings[0].averageEntryPrice).toBe(1000 / ISSUE_QTY);
  });
});

describe('issue #55: bot pnlFraction uses the precise average entry near decision boundaries', () => {
  const coinAt = (price) => ({
    coinId: 101, symbol: 'PLD', currentPrice: price, dead: false, history: [price],
    phase: 'RISE', momentum: 'FLAT', archetype: 'ZIP', collapseRisk: 'STABLE', recentChangePct: 0
  });
  // A holding exactly as the OLD account read produced it (avg rounded to
  // £0.11) — the money fields are authoritative and precise.
  const holdingAt = (price) => ({
    coinId: 101, symbol: 'PLD', quantity: ISSUE_QTY, costBasis: 1000, averageEntryPrice: 0.11,
    currentValue: Math.round(ISSUE_QTY * price * 100) / 100, unrealizedPnlPct: null
  });
  const decide = (strategy, price) => persistentBots.decidePersistentBotAction({
    strategy,
    state: { coins: [coinAt(price)], cash: 0, debt: 0, holdings: [holdingAt(price)] },
    random: () => 0.99 // never contrarian, never gated
  });

  test('profit-take (+30% Reckless) fires at £0.1416: precise +30.03% (the rounded entry read +28.7%)', () => {
    const decision = decide('reckless', 0.1416);
    expect(decision.type).toBe('SELL');
    expect(decision.reason).toBe('profit-take');
  });

  test('just below the profit-take boundary at £0.1415 (+29.94%) holds', () => {
    const decision = decide('reckless', 0.1415);
    expect(decision.type).not.toBe('SELL');
  });

  test('loss-cut (-50% Reckless) does NOT fire at £0.0546: precise -49.86% (the rounded entry read -50.36%)', () => {
    const decision = decide('reckless', 0.0546);
    expect(decision.type).not.toBe('SELL');
  });

  test('loss-cut fires once the precise loss crosses -50% (£0.0544, -50.05%)', () => {
    const decision = decide('reckless', 0.0544);
    expect(decision.type).toBe('SELL');
    expect(decision.reason).toBe('loss-cut');
    expect(decision.quantity).toBe(ISSUE_QTY); // full exit: the exact held quantity
  });
});
