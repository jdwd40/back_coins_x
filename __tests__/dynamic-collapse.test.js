// SIM-13/SIM-14: the dynamic collapse engine — the SINGLE coin-death
// authority (game/dynamicCollapseService.js).
//
// Pure coverage: weighted risk inputs, the pre-decline cap (very low
// collapse chance before the late game), late escalation with market
// damage, the hard per-evaluation cap, exact input validation, seeded
// per-bucket rolls (deterministic, independent streams), bucket indexing,
// and cycle-to-cycle variation.
//
// Persistence coverage (disposable coins_test database; jest.setup.js
// reseeds before each test): dynamic execution through the real Core 1
// lifecycle, durable death records with sequential execution ranks, exact
// COLLAPSE price-history provenance, genuine no-resurrection, idempotent
// replay/recovery, the final all-coins-£0 safety rule at exactly cycle
// end, settlement compatibility, and the single-authority proof (the
// retired fixed scheduler no longer exists and no runtime path writes the
// legacy table).

const db = require('../db/connection');
const { reconcileCycle } = require('../game/gameCycleService');
const settlementService = require('../game/gameSettlementService');
const dynamicCollapseService = require('../game/dynamicCollapseService');
const { resolveSimulationConfig, COLLAPSE_INPUT_IDS } = require('../game/simulationConfig');
const { assertDisposableTestDatabase } = require('./helpers/testDatabaseGuard');

jest.setTimeout(30000);

const config = resolveSimulationConfig();
const DC = config.dynamicCollapse;

const CYCLE_START = new Date('2026-08-22T10:00:00.000Z');
const DURATION_MS = 30 * 60 * 1000;
const CYCLE_END = new Date(CYCLE_START.getTime() + DURATION_MS);
const SEED = 'dynamic-collapse-test-seed';

function at(fraction) {
  return new Date(CYCLE_START.getTime() + DURATION_MS * fraction);
}

function zeroInputs(overrides = {}) {
  const inputs = {};
  for (const id of COLLAPSE_INPUT_IDS) inputs[id] = 0;
  return { ...inputs, ...overrides };
}

// ---------------------------------------------------------------------------
// Pure risk mathematics
// ---------------------------------------------------------------------------

describe('SIM-13: weighted collapse risk inputs', () => {
  test('zero inputs produce zero risk (no collapse pressure on a healthy market)', () => {
    expect(dynamicCollapseService.computeCollapseRisk({
      inputs: zeroInputs(), lifecycleState: 'DECLINE', config
    })).toBe(0);
  });

  test('each input contributes exactly its configured weight', () => {
    for (const id of COLLAPSE_INPUT_IDS) {
      const risk = dynamicCollapseService.computeCollapseRisk({
        inputs: zeroInputs({ [id]: 1 }), lifecycleState: 'DECLINE', config
      });
      expect(risk).toBeCloseTo(Math.min(DC.maxRiskPerEvaluation, DC.inputWeights[id]), 12);
    }
  });

  test('inputs must be exactly the configured key set — a missing or extra input is a hard error', () => {
    const missing = zeroInputs();
    delete missing.marketDrawdown;
    expect(() => dynamicCollapseService.computeCollapseRisk({ inputs: missing, lifecycleState: 'DECLINE', config }))
      .toThrow(/exactly/);
    expect(() => dynamicCollapseService.computeCollapseRisk({
      inputs: zeroInputs({ secretSchedule: 1 }), lifecycleState: 'DECLINE', config
    })).toThrow(/exactly/);
  });

  test('inputs must be fractions in [0, 1]', () => {
    expect(() => dynamicCollapseService.computeCollapseRisk({
      inputs: zeroInputs({ marketDrawdown: 1.5 }), lifecycleState: 'DECLINE', config
    })).toThrow(/\[0, 1\]/);
    expect(() => dynamicCollapseService.computeCollapseRisk({
      inputs: zeroInputs({ recentSellPressure: -0.1 }), lifecycleState: 'DECLINE', config
    })).toThrow(/\[0, 1\]/);
    expect(() => dynamicCollapseService.computeCollapseRisk({
      inputs: zeroInputs({ cycleProgress: 'late' }), lifecycleState: 'DECLINE', config
    })).toThrow(/\[0, 1\]/);
  });

  test('the hard per-evaluation cap binds regardless of total damage', () => {
    const allMax = zeroInputs();
    for (const id of COLLAPSE_INPUT_IDS) allMax[id] = 1;
    expect(dynamicCollapseService.computeCollapseRisk({ inputs: allMax, lifecycleState: 'COLLAPSE', config }))
      .toBe(DC.maxRiskPerEvaluation);
  });

  test('collapse chance is very low before the late game: the pre-decline cap binds in GROWTH and PLATEAU', () => {
    const allMax = zeroInputs();
    for (const id of COLLAPSE_INPUT_IDS) allMax[id] = 1;
    expect(dynamicCollapseService.computeCollapseRisk({ inputs: allMax, lifecycleState: 'GROWTH', config }))
      .toBe(DC.preDeclineRiskCap);
    expect(dynamicCollapseService.computeCollapseRisk({ inputs: allMax, lifecycleState: 'PLATEAU', config }))
      .toBe(DC.preDeclineRiskCap);
    expect(DC.preDeclineRiskCap).toBeLessThanOrEqual(0.01);
  });

  test('risk rises with market deterioration and late progress', () => {
    const early = dynamicCollapseService.computeCollapseRisk({
      inputs: zeroInputs({ cycleProgress: 0.2 }),
      lifecycleState: 'DECLINE', config
    });
    const damaged = dynamicCollapseService.computeCollapseRisk({
      inputs: zeroInputs({ cycleProgress: 0.2, marketDrawdown: 0.05, recentCrashDamage: 0.05 }),
      lifecycleState: 'DECLINE', config
    });
    const late = dynamicCollapseService.computeCollapseRisk({
      inputs: zeroInputs({ cycleProgress: 0.4, marketDrawdown: 0.05, recentCrashDamage: 0.05 }),
      lifecycleState: 'COLLAPSE', config
    });
    expect(damaged).toBeGreaterThan(early);
    expect(late).toBeGreaterThan(damaged);
    expect(late).toBeLessThanOrEqual(DC.maxRiskPerEvaluation);
  });

  test('a vulnerable coin (deep below its peak, heavy sell pressure) has strictly more risk than a resilient one', () => {
    const vulnerable = dynamicCollapseService.computeCollapseRisk({
      inputs: zeroInputs({ coinPriceVsPeak: 0.9, recentSellPressure: 1, negativeActiveEvents: 0.8 }),
      lifecycleState: 'DECLINE', config
    });
    const resilient = dynamicCollapseService.computeCollapseRisk({
      inputs: zeroInputs({ coinPriceVsPeak: 0.05, recentSellPressure: 0, negativeActiveEvents: 0 }),
      lifecycleState: 'DECLINE', config
    });
    expect(vulnerable).toBeGreaterThan(resilient);
  });

  test('unknown lifecycle states are rejected', () => {
    expect(() => dynamicCollapseService.computeCollapseRisk({
      inputs: zeroInputs(), lifecycleState: 'MANIA', config
    })).toThrow(/unknown lifecycle state/);
    expect(() => dynamicCollapseService.lifecycleStageInput('MANIA')).toThrow(/unknown lifecycle state/);
  });

  test('the lifecycle stage input escalates in legal order', () => {
    expect(dynamicCollapseService.lifecycleStageInput('GROWTH')).toBe(0);
    expect(dynamicCollapseService.lifecycleStageInput('PLATEAU')).toBeCloseTo(1 / 3, 12);
    expect(dynamicCollapseService.lifecycleStageInput('DECLINE')).toBeCloseTo(2 / 3, 12);
    expect(dynamicCollapseService.lifecycleStageInput('COLLAPSE')).toBe(1);
  });
});

describe('SIM-13: risk input assembly (buildCollapseRiskInputs)', () => {
  const RAW = {
    marketDrawdown: 0.4,
    coinPrice: 5,
    coinPeak: 20,
    negativeEventSum: -0.03,
    coinRecentPeak: 10,
    phaseModifier: -0.02,
    sellPressure: config.tradingPressure.maxSellPressureModifier / 2,
    lifecycleState: 'DECLINE',
    cycleProgress: 0.8
  };

  test('raw measurements normalise into the exact weighted input set', () => {
    const inputs = dynamicCollapseService.buildCollapseRiskInputs({ ...RAW, config });
    expect(Object.keys(inputs).sort()).toEqual(COLLAPSE_INPUT_IDS.slice().sort());
    expect(inputs.marketDrawdown).toBe(0.4);
    expect(inputs.coinPriceVsPeak).toBeCloseTo(0.75, 12);
    expect(inputs.negativeActiveEvents).toBeCloseTo(0.03 / config.coinEvents.maxStackedModifier, 12);
    expect(inputs.recentCrashDamage).toBeCloseTo(0.5, 12);
    expect(inputs.negativeMarketPhase).toBeCloseTo(0.5, 12); // 0.02 of the 0.04 max negative phase
    expect(inputs.recentSellPressure).toBeCloseTo(0.5, 12);
    expect(inputs.lifecycleStage).toBeCloseTo(2 / 3, 12);
    expect(inputs.cycleProgress).toBe(0.8);
  });

  test('a positive phase contributes no negative-phase input; a zero peak carries no signal', () => {
    const inputs = dynamicCollapseService.buildCollapseRiskInputs({
      ...RAW, phaseModifier: 0.03, coinPeak: 0, coinRecentPeak: 0, config
    });
    expect(inputs.negativeMarketPhase).toBe(0);
    expect(inputs.coinPriceVsPeak).toBe(0);
    expect(inputs.recentCrashDamage).toBe(0);
  });

  test('out-of-range raw values clamp into [0, 1] inputs', () => {
    const inputs = dynamicCollapseService.buildCollapseRiskInputs({
      ...RAW, marketDrawdown: 1.2, negativeEventSum: -50, sellPressure: 99, config
    });
    expect(inputs.marketDrawdown).toBe(1);
    expect(inputs.negativeActiveEvents).toBe(1);
    expect(inputs.recentSellPressure).toBe(1);
  });
});

describe('SIM-13: seeded per-bucket collapse rolls', () => {
  test('rolls are deterministic per (seed, coin, bucket) and inside [0, 1)', () => {
    const a = dynamicCollapseService.drawCollapseRoll({ seed: SEED, coinId: 3, bucketIndex: 12 });
    const b = dynamicCollapseService.drawCollapseRoll({ seed: SEED, coinId: 3, bucketIndex: 12 });
    expect(b).toBe(a);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(1);
  });

  test('rolls differ across coins, buckets and cycle seeds (order varies by cycle)', () => {
    const base = dynamicCollapseService.drawCollapseRoll({ seed: SEED, coinId: 3, bucketIndex: 12 });
    expect(dynamicCollapseService.drawCollapseRoll({ seed: SEED, coinId: 4, bucketIndex: 12 })).not.toBe(base);
    expect(dynamicCollapseService.drawCollapseRoll({ seed: SEED, coinId: 3, bucketIndex: 13 })).not.toBe(base);
    expect(dynamicCollapseService.drawCollapseRoll({ seed: 'another-cycle-seed', coinId: 3, bucketIndex: 12 })).not.toBe(base);
  });

  test('the collapse order is not a fixed elapsed-time rank schedule across cycles', () => {
    // For two different cycle seeds, the first-dying coin (lowest roll
    // under a uniform damage scenario) differs across a sample of seeds.
    const firstOut = (seed) => {
      let best = null;
      for (let coinId = 1; coinId <= 10; coinId++) {
        const roll = dynamicCollapseService.drawCollapseRoll({ seed, coinId, bucketIndex: 40 });
        if (best === null || roll < best.roll) best = { coinId, roll };
      }
      return best.coinId;
    };
    const orders = new Set(['seed-a', 'seed-b', 'seed-c', 'seed-d', 'seed-e', 'seed-f'].map(firstOut));
    expect(orders.size).toBeGreaterThan(1);
  });

  test('bucket indexing is a fixed 30s grid from the cycle start', () => {
    expect(dynamicCollapseService.COLLAPSE_EVALUATION_BUCKET_MS).toBe(30 * 1000);
    expect(dynamicCollapseService.collapseBucketIndex(0)).toBe(0);
    expect(dynamicCollapseService.collapseBucketIndex(29_999)).toBe(0);
    expect(dynamicCollapseService.collapseBucketIndex(30_000)).toBe(1);
    expect(() => dynamicCollapseService.collapseBucketIndex(-1)).toThrow(/non-negative/);
  });

  test('reconciliation before a cycle starts performs no collapse query or roll', async () => {
    const client = { query: jest.fn(() => { throw new Error('should not query before cycle start'); }) };
    await expect(dynamicCollapseService.evaluateAndExecuteCollapses(
      client,
      {
        cycle_id: 123,
        seed: SEED,
        start_time: new Date(CYCLE_START.getTime() + 60_000),
        end_time: new Date(CYCLE_START.getTime() + 120_000)
      },
      CYCLE_START
    )).resolves.toEqual([]);
    expect(client.query).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Persistence: dynamic execution through the real lifecycle
// ---------------------------------------------------------------------------

async function deaths(cycleId) {
  const { rows } = await db.query(
    'SELECT coin_id, collapse_rank, collapsed_at FROM apocalypse_coin_collapses WHERE cycle_id = $1 ORDER BY collapse_rank',
    [cycleId]
  );
  return rows;
}

// Crash the whole market to force genuine market deterioration (drawdown,
// decline/collapse lifecycle, per-coin price-vs-peak damage), then walk the
// lifecycle forward through reconciles until dynamic deaths execute.
async function crashMarketAndAdvance(cycle) {
  await db.query('UPDATE coins SET current_price = GREATEST(0.0001, current_price * 0.0001)');
  await reconcileCycle({ now: at(0.56) }); // PLATEAU (progress guard)
  await reconcileCycle({ now: at(0.71) }); // DECLINE (progress guard)
  await reconcileCycle({ now: at(0.72) }); // COLLAPSE (severe drawdown)
  for (let p = 0.73; p < 1; p += 0.02) {
    await reconcileCycle({ now: at(p) });
    const rows = await deaths(cycle.cycle_id);
    if (rows.length > 0) return rows;
  }
  return deaths(cycle.cycle_id);
}

describe('SIM-13/14: dynamic execution through the Core 1 lifecycle', () => {
  beforeEach(() => {
    assertDisposableTestDatabase();
  });

  test('no death records exist at cycle start — nothing about future timing/order is persisted', async () => {
    const cycle = await reconcileCycle({ now: CYCLE_START, durationMs: DURATION_MS, generateSeed: () => SEED });
    expect(await deaths(cycle.cycle_id)).toEqual([]);
    const { rows } = await db.query('SELECT count(*)::int AS n FROM coin_collapse_schedule');
    expect(rows[0].n).toBe(0); // the legacy table is never written any more
  });

  test('a crashed market produces dynamic deaths: durable record, £0 price, COLLAPSE provenance, sequential ranks', async () => {
    const cycle = await reconcileCycle({ now: CYCLE_START, durationMs: DURATION_MS, generateSeed: () => SEED });
    const rows = await crashMarketAndAdvance(cycle);
    expect(rows.length).toBeGreaterThan(0);

    for (const row of rows) {
      // The coin is exactly £0 and the death is durable.
      const { rows: coin } = await db.query('SELECT current_price FROM coins WHERE coin_id = $1', [row.coin_id]);
      expect(parseFloat(coin[0].current_price)).toBe(0);
      // The exact COLLAPSE provenance: one £0 history row stamped at the death instant.
      const { rows: history } = await db.query(
        `SELECT price, source, cycle_id, created_at FROM price_history
         WHERE coin_id = $1 AND source = 'COLLAPSE'`,
        [row.coin_id]
      );
      expect(history).toHaveLength(1);
      expect(parseFloat(history[0].price)).toBe(0);
      expect(history[0].cycle_id).toBe(cycle.cycle_id);
      expect(new Date(history[0].created_at).getTime()).toBe(new Date(row.collapsed_at).getTime());
    }
    // Ranks are the dense execution order 0..N-1.
    expect(rows.map((r) => r.collapse_rank)).toEqual(rows.map((_, i) => i));
    // Deaths happened strictly inside the live cycle window.
    for (const row of rows) {
      expect(new Date(row.collapsed_at).getTime()).toBeGreaterThan(CYCLE_START.getTime());
      expect(new Date(row.collapsed_at).getTime()).toBeLessThanOrEqual(CYCLE_END.getTime());
    }
  });

  test('genuine no-resurrection: a dead coin stays exactly £0 across repeated reconciles', async () => {
    const cycle = await reconcileCycle({ now: CYCLE_START, durationMs: DURATION_MS, generateSeed: () => SEED });
    const rows = await crashMarketAndAdvance(cycle);
    expect(rows.length).toBeGreaterThan(0);

    // Keep reconciling inside the live window: the dead set can only grow,
    // never shrink, and dead prices never move off £0.
    for (let p = 0.9; p < 1; p += 0.02) {
      await reconcileCycle({ now: at(p) });
    }
    for (const row of rows) {
      const { rows: coin } = await db.query('SELECT current_price FROM coins WHERE coin_id = $1', [row.coin_id]);
      expect(parseFloat(coin[0].current_price)).toBe(0);
      expect(await dynamicCollapseService.isCoinCollapsed(row.coin_id)).toBe(true);
      // Exactly one death record and one COLLAPSE history row — replay
      // never duplicates either.
      const { rows: records } = await db.query(
        'SELECT count(*)::int AS n FROM apocalypse_coin_collapses WHERE cycle_id = $1 AND coin_id = $2',
        [cycle.cycle_id, row.coin_id]
      );
      expect(records[0].n).toBe(1);
      const { rows: history } = await db.query(
        `SELECT count(*)::int AS n FROM price_history WHERE coin_id = $1 AND source = 'COLLAPSE'`,
        [row.coin_id]
      );
      expect(history[0].n).toBe(1);
    }
    const collapsedIds = await dynamicCollapseService.getCollapsedCoinIds();
    for (const row of rows) expect(collapsedIds.has(row.coin_id)).toBe(true);
  });

  test('a healthy early market keeps deaths rare (very low collapse chance before the late game)', async () => {
    const cycle = await reconcileCycle({ now: CYCLE_START, durationMs: DURATION_MS, generateSeed: () => SEED });
    // Reconcile through the whole early/mid game with untouched prices.
    for (let p = 0.05; p <= 0.5; p += 0.05) {
      await reconcileCycle({ now: at(p) });
    }
    // Pre-decline risk is capped at 1% per coin per 30s bucket: deaths are
    // possible but rare — never a mass event, and far fewer than a crashed
    // late market produces.
    const rows = await deaths(cycle.cycle_id);
    const { rows: coinCount } = await db.query('SELECT count(*)::int AS n FROM coins WHERE retired = FALSE');
    expect(rows.length).toBeLessThanOrEqual(2);
    expect(rows.length).toBeLessThan(coinCount[0].n / 2);
    // Every death is exact: £0 price, one durable record, COLLAPSE provenance.
    const { rows: zeros } = await db.query('SELECT count(*)::int AS n FROM coins WHERE current_price = 0');
    expect(zeros[0].n).toBe(rows.length);
  });

  test('the final safety rule: settlement forces every remaining coin to exactly £0 at exactly cycle end', async () => {
    const cycle = await reconcileCycle({ now: CYCLE_START, durationMs: DURATION_MS, generateSeed: () => SEED });
    // No market crash: possibly no dynamic deaths at all. Settlement must
    // still kill everything at exactly end_time — freeze and settle
    // explicitly so no successor baseline restore has run yet.
    await settlementService.freezeExpiredActiveCycle({ nowMs: CYCLE_END.getTime() + 1000 });
    await settlementService.settleSettlingCycle();

    const rows = await deaths(cycle.cycle_id);
    const { rows: coinCount } = await db.query('SELECT count(*)::int AS n FROM coins WHERE retired = FALSE');
    expect(rows).toHaveLength(coinCount[0].n);
    for (const row of rows) {
      expect(new Date(row.collapsed_at).getTime()).toBe(CYCLE_END.getTime());
    }
    const { rows: nonZero } = await db.query('SELECT count(*)::int AS n FROM coins WHERE current_price <> 0');
    expect(nonZero[0].n).toBe(0);

    const stored = await db.query('SELECT status, settled_at FROM apocalypse_cycles WHERE cycle_id = $1', [cycle.cycle_id]);
    expect(stored.rows[0].status).toBe('COMPLETED');
    expect(stored.rows[0].settled_at).not.toBeNull();
  });

  test('settlement replay is a no-op: no duplicate deaths, ranks or history rows', async () => {
    const cycle = await reconcileCycle({ now: CYCLE_START, durationMs: DURATION_MS, generateSeed: () => SEED });
    await crashMarketAndAdvance(cycle);
    await reconcileCycle({ now: new Date(CYCLE_END.getTime() + 1000) });

    const before = await deaths(cycle.cycle_id);
    const { rows: historyBefore } = await db.query(`SELECT count(*)::int AS n FROM price_history WHERE source = 'COLLAPSE'`);

    const settled = await settlementService.settleSettlingCycle(); // already COMPLETED: null
    expect(settled).toBeNull();
    await reconcileCycle({ now: new Date(CYCLE_END.getTime() + 60_000) }); // successor chain

    const after = await deaths(cycle.cycle_id);
    const { rows: historyAfter } = await db.query(`SELECT count(*)::int AS n FROM price_history WHERE source = 'COLLAPSE'`);
    expect(after).toEqual(before);
    expect(historyAfter[0].n).toBe(historyBefore[0].n);
  });

  test('recovery: a new cycle restores baselines and starts with a clean death slate', async () => {
    const cycle = await reconcileCycle({ now: CYCLE_START, durationMs: DURATION_MS, generateSeed: () => SEED });
    await crashMarketAndAdvance(cycle);
    // One reconcile just past cycle end freezes, settles AND chains the
    // successor in a single deterministic pass, returning the successor
    // freshly created — before any live-cycle collapse evaluation has run
    // against it, so a legitimate rare early roll cannot kill a successor
    // coin during this fixture's setup (creation never evaluates collapses;
    // only a later recovery reconcile at a deeper `now` would).
    const successor = await reconcileCycle({ now: new Date(CYCLE_END.getTime() + 1000), durationMs: DURATION_MS, generateSeed: () => 'successor-seed' });
    expect(successor.cycle_id).not.toBe(cycle.cycle_id);
    // Baselines restored: no coin is £0 in the new cycle...
    const { rows: nonZero } = await db.query('SELECT count(*)::int AS n FROM coins WHERE current_price <> 0');
    const { rows: coinCount } = await db.query('SELECT count(*)::int AS n FROM coins');
    expect(nonZero[0].n).toBe(coinCount[0].n);
    // ...and the new cycle has no death records of its own.
    expect(await deaths(successor.cycle_id)).toEqual([]);
    // The old cycle's deaths never leak into the new cycle's collapsed set.
    expect((await dynamicCollapseService.getCollapsedCoinIds()).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Single-authority proof (SIM-14)
// ---------------------------------------------------------------------------

describe('SIM-14: exactly one collapse authority exists', () => {
  test('the retired scheduled-collapse module no longer exists', () => {
    expect(() => require('../game/collapseScheduleService')).toThrow(/Cannot find module/);
  });

  test('no runtime source references the retired controller or writes the legacy table', () => {
    const { execSync } = require('child_process');
    // No executeDueCollapses / createScheduleForCycle / buildSchedule
    // callers remain outside tests and migrations.
    const controllers = execSync(
      'grep -rn "executeDueCollapses\\|createScheduleForCycle\\|COLLAPSE_WINDOW_START_PERCENT" game models controllers simulation db --include="*.js" || true',
      { cwd: require('path').join(__dirname, '..') }
    ).toString().trim();
    expect(controllers).toBe('');
    // No runtime INSERT/UPDATE against the legacy schedule table outside
    // migrations/seed/verifier/tests.
    const writers = execSync(
      'grep -rln "INSERT INTO coin_collapse_schedule\\|UPDATE coin_collapse_schedule" game models controllers routes services simulation --include="*.js" || true',
      { cwd: require('path').join(__dirname, '..') }
    ).toString().trim();
    expect(writers).toBe('');
  });

  test('the dynamic engine is the only price-zeroing writer: deaths carry its exact provenance', async () => {
    const cycle = await reconcileCycle({ now: CYCLE_START, durationMs: DURATION_MS, generateSeed: () => SEED });
    await reconcileCycle({ now: new Date(CYCLE_END.getTime() + 1000) });
    // Every £0 price in the whole system is backed by exactly one dynamic
    // death record, and every COLLAPSE history row matches a death.
    const { rows: orphanPrices } = await db.query(
      `SELECT c.coin_id FROM coins c
       WHERE c.current_price = 0 AND NOT EXISTS (
         SELECT 1 FROM apocalypse_coin_collapses cc WHERE cc.cycle_id = $1 AND cc.coin_id = c.coin_id
       )`,
      [cycle.cycle_id]
    );
    expect(orphanPrices).toEqual([]);
    const { rows: orphanHistory } = await db.query(
      `SELECT ph.coin_id FROM price_history ph
       WHERE ph.source = 'COLLAPSE' AND ph.cycle_id = $1 AND NOT EXISTS (
         SELECT 1 FROM apocalypse_coin_collapses cc WHERE cc.cycle_id = ph.cycle_id AND cc.coin_id = ph.coin_id
       )`,
      [cycle.cycle_id]
    );
    expect(orphanHistory).toEqual([]);
  });
});
