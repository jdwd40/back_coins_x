// V2-2: live Power, position-limit and cost-basis behaviour in the
// authoritative round trade service (game/gameRoundService.js) against the
// guarded disposable test database.
//
// Covers: initial/max Power and lazy regeneration through the public state;
// BUY Power costs (exact formula through the locked path); zero-cost SELL;
// failed buys leaving Power/cash/holding/ledger untouched; Power persistence
// across apocalypse rollover (carry-forward + timestamp reconciliation, the
// restart/inactivity semantics); the 3-open-live-position limit (fourth
// rejected, adds allowed, sell frees a slot, collapsed positions free their
// slot); and weighted-average cost basis / unrealised P&L through multiple
// buys, partial sells, full sells, fractional quantities and dead holdings.

const db = require('../db/connection');
const { reconcileCycle } = require('../game/gameCycleService');
const {
  joinRound,
  buyRoundTrade,
  sellRoundTrade,
  getParticipantRoundState
} = require('../game/gameRoundService');
const powerDomain = require('../game/powerDomain');
const { assertDisposableTestDatabase } = require('./helpers/testDatabaseGuard');

const CYCLE_START_MS = new Date('2026-08-20T10:00:00.000Z').getTime();
const DURATION_MS = 30 * 60 * 1000;
const EARLY = new Date(CYCLE_START_MS + DURATION_MS * 0.10);
const WINDOW_START = new Date(CYCLE_START_MS + DURATION_MS * 0.70);
const AFTER_END = new Date(CYCLE_START_MS + DURATION_MS + 60 * 1000);
const LONG_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const LONG_ROUND_NOW = new Date('2020-01-01T00:00:00.000Z');

function round2(value) {
  return Math.round(value * 100) / 100;
}

async function participantRow(participantId) {
  const { rows } = await db.query(
    'SELECT * FROM apocalypse_participants WHERE participant_id = $1',
    [participantId]
  );
  return rows[0];
}

async function holdingRow(participantId, coinId) {
  const { rows } = await db.query(
    'SELECT * FROM apocalypse_holdings WHERE participant_id = $1 AND coin_id = $2',
    [participantId, coinId]
  );
  return rows[0] || null;
}

async function setPrice(coinId, price) {
  await db.query('UPDATE coins SET current_price = $1 WHERE coin_id = $2', [price, coinId]);
}

async function setPower(participantId, power, updatedAt) {
  await db.query(
    'UPDATE apocalypse_participants SET power = $1, power_updated_at = $2 WHERE participant_id = $3',
    [power, updatedAt, participantId]
  );
}

async function txRows(participantId) {
  const { rows } = await db.query(
    'SELECT * FROM apocalypse_transactions WHERE participant_id = $1 ORDER BY round_transaction_id',
    [participantId]
  );
  return rows;
}

// Fixed-time cycle (fresh 7-day window: every coin stays alive) with user 1 joined.
async function setupLongRound(userId = 1) {
  const now = LONG_ROUND_NOW;
  const cycle = await reconcileCycle({ now, durationMs: LONG_DURATION_MS });
  const participant = await joinRound({ userId, now });
  return { cycle, participant, now };
}

// Fixed-time cycle used by lifecycle tests. Dynamic collapse deaths are
// created only on actual risk evaluation; collapse-specific cases insert an
// already-executed durable death record via markDynamicCollapse below.
async function setupFixedRound(userId = 1) {
  const cycle = await reconcileCycle({ now: EARLY, durationMs: DURATION_MS, generateSeed: () => 'v2-power-fixed-seed' });
  const participant = await joinRound({ userId, now: EARLY });
  return { cycle, participant, rank0CoinId: 1 };
}

async function markDynamicCollapse(cycleId, coinId, at = WINDOW_START) {
  await db.query(
    `INSERT INTO apocalypse_coin_collapses (cycle_id, coin_id, collapse_rank, collapsed_at)
     VALUES ($1, $2, 0, $3)`,
    [cycleId, coinId, at]
  );
  await db.query('UPDATE coins SET current_price = 0 WHERE coin_id = $1', [coinId]);
}

describe('V2-2 live Power: guard', () => {
  test('this suite only runs against the approved disposable test database', () => {
    expect(assertDisposableTestDatabase().database).toMatch(/test/i);
  });
});

describe('V2-2 live Power: initial state and lazy regeneration', () => {
  test('a new participant starts at max Power and the public state exposes the full Power view', async () => {
    const { participant } = await setupLongRound();
    const row = await participantRow(participant.participantId);
    expect(Number(row.power)).toBe(100);
    expect(row.power_updated_at).toBeTruthy();

    expect(participant.power).toBeTruthy();
    expect(participant.power.current).toBe(100);
    expect(participant.power.max).toBe(100);
    expect(participant.power.regenMsPerPoint).toBe(30000);
    expect(participant.power.secondsPerPoint).toBe(30);
    expect(participant.power.nextPointAt).toBeNull(); // full: nothing to regenerate
    expect(participant.power.storedPower).toBe(100);
    expect(typeof participant.power.powerUpdatedAt).toBe('string');
    expect(typeof participant.power.asOf).toBe('string');
  });

  test('read-only state lazily reconciles stored Power without writing (restart/inactivity semantics)', async () => {
    const { participant } = await setupLongRound();
    // Simulate a process restart / long inactivity: the stored pair says 40
    // Power as of exactly 40 regen intervals ago (40 x 30s = 20 min). No
    // timer has ticked; the timestamp alone must reproduce 80 effective
    // Power at read.
    const fortyIntervalsAgo = new Date(Date.now() - 40 * 30000);
    await setPower(participant.participantId, 40, fortyIntervalsAgo);

    const state = await getParticipantRoundState(participant.participantId);
    expect(state.power.current).toBeGreaterThanOrEqual(80);
    expect(state.power.nextPointAt).not.toBeNull();

    // The read is lazy: the stored row is untouched until a spend.
    const row = await participantRow(participant.participantId);
    expect(Number(row.power)).toBe(40);
    expect(new Date(row.power_updated_at).getTime()).toBe(fortyIntervalsAgo.getTime());
  });

  test('a stored future timestamp never creates Power', async () => {
    const { participant } = await setupLongRound();
    const future = new Date(Date.now() + 3600000);
    await setPower(participant.participantId, 10, future);
    const state = await getParticipantRoundState(participant.participantId);
    expect(state.power.current).toBe(10);
  });
});

describe('V2-2 live Power: buy costs, sell is free, failures are atomic', () => {
  test('a BUY spends the exact domain Power cost; SELL spends zero', async () => {
    const { cycle, participant, now } = await setupLongRound();
    await setPrice(1, 10);

    // £250 buy -> 3 Power (1 + floor(250/125): plan target + order charge).
    const buy = await buyRoundTrade({ userId: 1, apocalypseId: cycle.apocalypse_id, coinId: 1, quantity: 25, now });
    expect(buy.transaction.totalAmount).toBe(250);
    expect(buy.participant.power.current).toBe(97);
    expect(buy.participant.power.storedPower).toBe(97);
    let row = await participantRow(participant.participantId);
    expect(Number(row.power)).toBe(97);

    // Selling everything costs zero Power.
    const sell = await sellRoundTrade({ userId: 1, apocalypseId: cycle.apocalypse_id, coinId: 1, quantity: 25, now });
    expect(sell.participant.power.current).toBe(97);
    row = await participantRow(participant.participantId);
    expect(Number(row.power)).toBe(97);
  });

  test('cost formula edge amounts through the locked path (£125 -> 2, £125.01 -> 2, tiny buy -> 1)', async () => {
    const { cycle, now } = await setupLongRound();
    await setPrice(1, 125);
    await buyRoundTrade({ userId: 1, apocalypseId: cycle.apocalypse_id, coinId: 1, quantity: 1, now }); // £125 -> 2
    let row = await participantRow((await joinRound({ userId: 1, now })).participantId);
    expect(Number(row.power)).toBe(98);

    await setPrice(2, 125.01);
    await buyRoundTrade({ userId: 1, apocalypseId: cycle.apocalypse_id, coinId: 2, quantity: 1, now }); // £125.01 -> 2
    row = await participantRow((await joinRound({ userId: 1, now })).participantId);
    expect(Number(row.power)).toBe(96);

    await setPrice(3, 1);
    await buyRoundTrade({ userId: 1, apocalypseId: cycle.apocalypse_id, coinId: 3, quantity: 1, now }); // £1 -> 1 (flat order charge)
    row = await participantRow((await joinRound({ userId: 1, now })).participantId);
    expect(Number(row.power)).toBe(95);
  });

  test('an insufficient-Power BUY is rejected and leaves Power, cash, holding and ledger unchanged', async () => {
    const { cycle, participant, now } = await setupLongRound();
    await setPrice(1, 10);
    await setPower(participant.participantId, 1, new Date());

    await expect(
      buyRoundTrade({ userId: 1, apocalypseId: cycle.apocalypse_id, coinId: 1, quantity: 25, now })
    ).rejects.toThrow(/Insufficient Power\. This buy costs 3 Power but you have 1\./);

    const row = await participantRow(participant.participantId);
    expect(Number(row.power)).toBe(1);
    expect(parseFloat(row.current_cash)).toBe(10000);
    expect(await holdingRow(participant.participantId, 1)).toBeNull();
    expect(await txRows(participant.participantId)).toHaveLength(0);
  });

  test('a failed BUY (insufficient cash) consumes no Power', async () => {
    const { cycle, participant, now } = await setupLongRound();
    await setPrice(1, 10);
    await expect(
      buyRoundTrade({ userId: 1, apocalypseId: cycle.apocalypse_id, coinId: 1, quantity: 2000, now }) // £20,000
    ).rejects.toThrow(/Insufficient round cash/);
    const row = await participantRow(participant.participantId);
    expect(Number(row.power)).toBe(100);
    expect(await txRows(participant.participantId)).toHaveLength(0);
  });

  test('no client-supplied Power values are consulted: stored server state is authoritative', async () => {
    const { cycle, participant, now } = await setupLongRound();
    await setPrice(1, 10);
    await setPower(participant.participantId, 3, new Date());
    // A "power" field smuggled into the call must be ignored entirely.
    await expect(
      buyRoundTrade({ userId: 1, apocalypseId: cycle.apocalypse_id, coinId: 1, quantity: 50, now, power: 9999 })
    ).rejects.toThrow(/Insufficient Power/);
    const row = await participantRow(participant.participantId);
    expect(Number(row.power)).toBe(3);
  });
});

describe('V2-2 live Power: persistence across apocalypse rollover', () => {
  test('stored Power carries into the next round and reconciles by real elapsed time', async () => {
    const { participant } = await setupFixedRound();
    // The player burned down to 37 Power during round 1.
    const stamp = new Date(EARLY.getTime());
    await setPower(participant.participantId, 37, stamp);

    // Roll the apocalypse over: settlement finalizes round 1 and chains the
    // successor round.
    const successor = await reconcileCycle({ now: AFTER_END });
    expect(successor.cycle_id).not.toBe(participant.cycleId);

    const rejoined = await joinRound({ userId: 1, now: AFTER_END });
    expect(rejoined.cycleId).toBe(successor.cycle_id);

    // The stored pair was carried VERBATIM; lazy reconciliation against
    // real elapsed time does the rest. (A plain state read reconciles
    // against the real wall clock — days after this fixed 2026-08-20 stamp
    // — so it reports a full 100; the spend below proves the exact
    // reconciliation off the carried pair at the game-time instant.)
    const row = await participantRow(rejoined.participantId);
    expect(Number(row.power)).toBe(37);
    expect(new Date(row.power_updated_at).getTime()).toBe(stamp.getTime());
    expect(rejoined.power.current).toBeGreaterThanOrEqual(90); // at least 37 + floor(28min / 30s)
    expect(rejoined.startingCash).toBe(10000); // cash resets; Power persists

    // Spend at the game-time instant AFTER_END: effective Power there is
    // 37 + floor(28 min / 30 s) = 93, so a £250 buy (3 Power) stores exactly 90.
    await setPrice(1, 10);
    const buy = await buyRoundTrade({ userId: 1, apocalypseId: successor.apocalypse_id, coinId: 1, quantity: 25, now: AFTER_END });
    expect(buy.participant.power.storedPower).toBe(90);
    expect(Number((await participantRow(rejoined.participantId)).power)).toBe(90);
  });

  test('a brand-new player in a later round starts at full Power (no prior participant)', async () => {
    await setupFixedRound();
    await reconcileCycle({ now: AFTER_END });
    const joined = await joinRound({ userId: 2, now: AFTER_END });
    expect(joined.power.current).toBe(100);
    expect(joined.power.storedPower).toBe(100);
  });
});

describe('V2-2 live position limit', () => {
  test('three distinct live positions are allowed; a fourth is rejected with a clear error and no writes', async () => {
    const { cycle, participant, now } = await setupLongRound();
    for (const coinId of [1, 2, 3]) {
      await setPrice(coinId, 10);
      await buyRoundTrade({ userId: 1, apocalypseId: cycle.apocalypse_id, coinId, quantity: 1, now });
    }
    await setPrice(4, 10);
    await expect(
      buyRoundTrade({ userId: 1, apocalypseId: cycle.apocalypse_id, coinId: 4, quantity: 1, now })
    ).rejects.toThrow(/Position limit reached: you may hold at most 3 different open live positions/);

    // The rejection wrote nothing: no holding, no ledger row, no Power spent.
    expect(await holdingRow(participant.participantId, 4)).toBeNull();
    expect(await txRows(participant.participantId)).toHaveLength(3);
    const row = await participantRow(participant.participantId);
    expect(Number(row.power)).toBe(97); // exactly the three £10 buys (1 each)
  });

  test('adding to an existing live position is allowed at the cap and costs Power again', async () => {
    const { cycle, now } = await setupLongRound();
    for (const coinId of [1, 2, 3]) {
      await setPrice(coinId, 10);
      await buyRoundTrade({ userId: 1, apocalypseId: cycle.apocalypse_id, coinId, quantity: 1, now });
    }
    const add = await buyRoundTrade({ userId: 1, apocalypseId: cycle.apocalypse_id, coinId: 2, quantity: 5, now });
    expect(add.transaction.totalAmount).toBe(50);
    expect(add.participant.power.current).toBe(96); // 3 + 1 more for the £50 add
    const state = await getParticipantRoundState(add.participant.participantId);
    expect(state.holdings).toHaveLength(3);
  });

  test('selling a position down fully frees the slot for a new coin', async () => {
    const { cycle, now } = await setupLongRound();
    for (const coinId of [1, 2, 3]) {
      await setPrice(coinId, 10);
      await buyRoundTrade({ userId: 1, apocalypseId: cycle.apocalypse_id, coinId, quantity: 1, now });
    }
    await sellRoundTrade({ userId: 1, apocalypseId: cycle.apocalypse_id, coinId: 2, quantity: 1, now });
    await setPrice(4, 10);
    const buy = await buyRoundTrade({ userId: 1, apocalypseId: cycle.apocalypse_id, coinId: 4, quantity: 1, now });
    const liveIds = buy.participant.holdings.map((h) => h.coinId).sort();
    expect(liveIds).toEqual([1, 3, 4]);
  });

  test('a collapsed position frees its slot immediately and stays historically visible at £0', async () => {
    const { cycle, participant, rank0CoinId } = await setupFixedRound();
    // Hold the rank-0 coin plus two others: three live positions. Pick two
    // DISTINCT setup coins from the canonical active catalogue, neither of
    // which is the rank-0 coin (the old [1, 2]-plus-increment helper could
    // re-select the rank-0 coin, collapsing the setup to two positions).
    const candidates = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const others = candidates.filter((id) => id !== rank0CoinId).slice(0, 2);
    expect(others).toHaveLength(2);
    for (const coinId of [rank0CoinId, ...others]) {
      await buyRoundTrade({ userId: 1, apocalypseId: cycle.apocalypse_id, coinId, quantity: 1, now: EARLY });
    }

    // Mark this held coin dead through the persisted dynamic authority.
    await markDynamicCollapse(cycle.cycle_id, rank0CoinId);

    // The dead holding is still there, worth exactly £0 — but no longer
    // consumes a live slot, so a fourth distinct coin can be opened. The
    // replacement comes from the same candidate list: a genuinely new coin
    // that is neither the rank-0 coin nor one of the two setup coins.
    const replacement = candidates.find((id) => id !== rank0CoinId && !others.includes(id));
    const buy = await buyRoundTrade({ userId: 1, apocalypseId: cycle.apocalypse_id, coinId: replacement, quantity: 1, now: WINDOW_START });
    const state = await getParticipantRoundState(participant.participantId);
    expect(state.holdings).toHaveLength(4); // 3 live + the dead one, preserved
    const dead = state.holdings.find((h) => h.coinId === rank0CoinId);
    expect(dead.currentPrice).toBe(0);
    expect(dead.currentValue).toBe(0);
    expect(buy.participant.holdings.map((h) => h.coinId)).toContain(replacement);
  });

  test('a zero-quantity (fully sold) holding does not consume a slot when reopening', async () => {
    const { cycle, now } = await setupLongRound();
    for (const coinId of [1, 2, 3]) {
      await setPrice(coinId, 10);
      await buyRoundTrade({ userId: 1, apocalypseId: cycle.apocalypse_id, coinId, quantity: 1, now });
    }
    // Fully sell coin 1 (row kept at quantity 0, not a slot) — a new
    // distinct coin can take the freed slot immediately.
    await sellRoundTrade({ userId: 1, apocalypseId: cycle.apocalypse_id, coinId: 1, quantity: 1, now });
    await setPrice(4, 10);
    await buyRoundTrade({ userId: 1, apocalypseId: cycle.apocalypse_id, coinId: 4, quantity: 1, now });
    // Now 2,3,4 are live (3). Reopening coin 1 is a NEW open (its zero row
    // grants no privilege) and must fail, as must any other new coin.
    await expect(
      buyRoundTrade({ userId: 1, apocalypseId: cycle.apocalypse_id, coinId: 1, quantity: 1, now })
    ).rejects.toThrow(/Position limit reached/);
    await setPrice(5, 10);
    await expect(
      buyRoundTrade({ userId: 1, apocalypseId: cycle.apocalypse_id, coinId: 5, quantity: 1, now })
    ).rejects.toThrow(/Position limit reached/);
  });
});

describe('V2-2 cost basis and unrealised P&L', () => {
  test('multiple buys produce a weighted-average entry and total cost basis', async () => {
    const { cycle, participant, now } = await setupLongRound();
    await setPrice(1, 10);
    await buyRoundTrade({ userId: 1, apocalypseId: cycle.apocalypse_id, coinId: 1, quantity: 10, now }); // £100
    await setPrice(1, 20);
    await buyRoundTrade({ userId: 1, apocalypseId: cycle.apocalypse_id, coinId: 1, quantity: 10, now }); // £200

    const holding = await holdingRow(participant.participantId, 1);
    expect(parseFloat(holding.quantity)).toBe(20);
    expect(parseFloat(holding.cost_basis)).toBe(300);

    const state = await getParticipantRoundState(participant.participantId);
    const position = state.holdings.find((h) => h.coinId === 1);
    expect(position.costBasis).toBe(300);
    expect(position.averageEntryPrice).toBe(15);
    expect(position.currentPrice).toBe(20);
    expect(position.currentValue).toBe(400);
    expect(position.unrealizedPnl).toBe(100);
    expect(position.unrealizedPnlPct).toBe(33.33);
  });

  test('partial sells remove the proportionate basis; a full sell zeroes it; ledger stays immutable', async () => {
    const { cycle, participant, now } = await setupLongRound();
    await setPrice(1, 10);
    await buyRoundTrade({ userId: 1, apocalypseId: cycle.apocalypse_id, coinId: 1, quantity: 10, now }); // £100
    await setPrice(1, 20);
    await buyRoundTrade({ userId: 1, apocalypseId: cycle.apocalypse_id, coinId: 1, quantity: 10, now }); // £200, basis £300 @ avg 15

    // Sell a quarter of the position: 5 of 20 -> basis 300 * 15/20 = 225.
    await sellRoundTrade({ userId: 1, apocalypseId: cycle.apocalypse_id, coinId: 1, quantity: 5, now });
    let holding = await holdingRow(participant.participantId, 1);
    expect(parseFloat(holding.quantity)).toBe(15);
    expect(parseFloat(holding.cost_basis)).toBe(225);

    // Sell the rest: basis exactly 0, quantity exactly 0.
    await sellRoundTrade({ userId: 1, apocalypseId: cycle.apocalypse_id, coinId: 1, quantity: 15, now });
    holding = await holdingRow(participant.participantId, 1);
    expect(parseFloat(holding.quantity)).toBe(0);
    expect(parseFloat(holding.cost_basis)).toBe(0);

    // Immutable history: all four ledger rows intact, unmodified.
    const ledger = await txRows(participant.participantId);
    expect(ledger.map((t) => t.type)).toEqual(['BUY', 'BUY', 'SELL', 'SELL']);
    expect(parseFloat(ledger[0].total_amount)).toBe(100);
    expect(parseFloat(ledger[1].total_amount)).toBe(200);
    expect(parseFloat(ledger[2].total_amount)).toBe(100); // 5 @ £20
    expect(parseFloat(ledger[3].total_amount)).toBe(300); // 15 @ £20
  });

  test('fractional quantities and rounding stay exact through buy/sell cycles', async () => {
    const { cycle, participant, now } = await setupLongRound();
    await setPrice(8, 33.48); // JDC-like fractional territory
    const q1 = 1.23456789;
    const t1 = round2(q1 * 33.48);
    await buyRoundTrade({ userId: 1, apocalypseId: cycle.apocalypse_id, coinId: 8, quantity: q1, now });
    let holding = await holdingRow(participant.participantId, 8);
    expect(parseFloat(holding.cost_basis)).toBe(t1);

    const q2 = 0.87654321;
    const t2 = round2(q2 * 33.48);
    await buyRoundTrade({ userId: 1, apocalypseId: cycle.apocalypse_id, coinId: 8, quantity: q2, now });
    holding = await holdingRow(participant.participantId, 8);
    expect(parseFloat(holding.cost_basis)).toBe(round2(t1 + t2));

    // Partial sell of an awkward fraction: proportionate 2dp-rounded basis.
    const beforeQty = q1 + q2;
    const sellQty = 0.55555555;
    const expectedBasis = round2((round2(t1 + t2) * (beforeQty - sellQty)) / beforeQty);
    await sellRoundTrade({ userId: 1, apocalypseId: cycle.apocalypse_id, coinId: 8, quantity: sellQty, now });
    holding = await holdingRow(participant.participantId, 8);
    expect(parseFloat(holding.quantity)).toBeCloseTo(beforeQty - sellQty, 8);
    expect(parseFloat(holding.cost_basis)).toBe(expectedBasis);

    // Average entry tracks the remaining basis over the remaining quantity.
    const state = await getParticipantRoundState(participant.participantId);
    const position = state.holdings.find((h) => h.coinId === 8);
    const expectedAvg = Math.round((expectedBasis / (beforeQty - sellQty)) * 10000) / 10000;
    expect(position.averageEntryPrice).toBe(expectedAvg);
  });

  test('a collapsed holding keeps its basis, is worth exactly £0, sells only for £0 and shows -100% P&L', async () => {
    const { cycle, participant, rank0CoinId } = await setupFixedRound();
    const { rows: priceRows } = await db.query('SELECT current_price FROM coins WHERE coin_id = $1', [rank0CoinId]);
    const entryPrice = parseFloat(priceRows[0].current_price);
    const quantity = entryPrice >= 1 ? 2 : 50; // keep above min notional on cheap coins
    const expectedBasis = round2(quantity * entryPrice);

    await buyRoundTrade({ userId: 1, apocalypseId: cycle.apocalypse_id, coinId: rank0CoinId, quantity, now: EARLY });
    await markDynamicCollapse(cycle.cycle_id, rank0CoinId);

    const state = await getParticipantRoundState(participant.participantId);
    const dead = state.holdings.find((h) => h.coinId === rank0CoinId);
    expect(dead.costBasis).toBe(expectedBasis);
    expect(dead.currentPrice).toBe(0);
    expect(dead.currentValue).toBe(0);
    expect(dead.unrealizedPnl).toBe(round2(-expectedBasis));
    expect(dead.unrealizedPnlPct).toBe(-100);

    // Selling the corpse: allowed at zero Power, credits exactly £0, basis zeroed.
    const powerBefore = Number((await participantRow(participant.participantId)).power);
    const sell = await sellRoundTrade({ userId: 1, apocalypseId: cycle.apocalypse_id, coinId: rank0CoinId, quantity, now: WINDOW_START });
    expect(sell.transaction.totalAmount).toBe(0);
    expect(sell.participant.currentCash).toBe(round2(10000 - expectedBasis));
    const holding = await holdingRow(participant.participantId, rank0CoinId);
    expect(parseFloat(holding.quantity)).toBe(0);
    expect(parseFloat(holding.cost_basis)).toBe(0);
    expect(Number((await participantRow(participant.participantId)).power)).toBe(powerBefore);
  });
});

describe('V2-2 public state shape', () => {
  test('participant state carries only intended Power/cost-basis fields and no seed or future data', async () => {
    const { cycle, now } = await setupLongRound();
    await setPrice(1, 10);
    const buy = await buyRoundTrade({ userId: 1, apocalypseId: cycle.apocalypse_id, coinId: 1, quantity: 5, now });

    const serialized = JSON.stringify(buy);
    expect(serialized).not.toMatch(/seed/i);
    expect(serialized).not.toMatch(/collapse/i);

    const powerKeys = Object.keys(buy.participant.power).sort();
    expect(powerKeys).toEqual([
      'asOf', 'current', 'max', 'nextPointAt', 'powerUpdatedAt', 'regenMsPerPoint', 'secondsPerPoint', 'storedPower'
    ]);
    const holdingKeys = Object.keys(buy.participant.holdings[0]).sort();
    expect(holdingKeys).toEqual([
      'averageEntryPrice', 'coinId', 'costBasis', 'currentPrice', 'currentValue', 'quantity', 'symbol', 'unrealizedPnl', 'unrealizedPnlPct'
    ]);
  });

  test('live buy cost is exactly the shared domain cost (simulator parity)', async () => {
    const { cycle, participant, now } = await setupLongRound();
    await setPrice(1, 10);
    const expectedCost = powerDomain.buyPowerCost(250);
    await buyRoundTrade({ userId: 1, apocalypseId: cycle.apocalypse_id, coinId: 1, quantity: 25, now });
    const row = await participantRow(participant.participantId);
    expect(100 - Number(row.power)).toBe(expectedCost);
  });
});
