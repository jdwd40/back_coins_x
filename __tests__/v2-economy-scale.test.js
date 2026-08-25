// V2-3: explicit passive-economy scale configuration.
//
// The scale is an explicit, validated multiplier in [0, 1] applied to every
// passive deduction at resolution time. Scale 1 (the default) preserves the
// legacy Core 7 amounts byte-for-byte; scale 0 disables all deductions
// through the same code path; intermediate values weaken them. The atomic
// debit path, durable tick/event claims and idempotency guarantees are
// untouched — these tests prove all of that against the disposable test
// database.

const db = require('../db/connection');
const { reconcileCycle } = require('../game/gameCycleService');
const economyService = require('../game/economyService');
const {
  resolveEconomyConfig,
  validateEconomyScale,
  scaleEconomyAmount
} = require('../game/economyConfig');
const { buildEventSchedule } = require('../game/economyService');
const {
  GAME_FEE_AMOUNT,
  GAME_TAX_AMOUNT,
  GAME_EVENT_COUNT
} = require('../game/gameConstants');

jest.setTimeout(45000);

const T0 = new Date('2026-01-05T00:00:00.000Z'); // aligned 30-min boundary
const MIN = 60 * 1000;
const at = (minutes) => new Date(T0.getTime() + minutes * MIN);

function scaledConfig(scale) {
  return resolveEconomyConfig({ GAME_ECONOMY_SCALE: String(scale) });
}

async function currentCash(cycleId) {
  const { rows } = await db.query(
    'SELECT user_id, current_cash FROM apocalypse_participants WHERE cycle_id = $1 ORDER BY user_id',
    [cycleId]
  );
  return rows.map((r) => ({ userId: r.user_id, cash: parseFloat(r.current_cash) }));
}

async function cashEvents(cycleId) {
  const { rows } = await db.query(
    'SELECT type, amount, event_key FROM apocalypse_cash_events WHERE cycle_id = $1 ORDER BY cash_event_id',
    [cycleId]
  );
  return rows.map((r) => ({ type: r.type, amount: parseFloat(r.amount), eventKey: r.event_key }));
}

// Scaled event total due by an instant, read from the PERSISTED schedule so
// seeded event timing can never make these tests flaky.
async function dueEventTotal(cycleId, nowDate) {
  const { rows } = await db.query(
    'SELECT COALESCE(SUM(amount), 0) AS total FROM apocalypse_economy_events WHERE cycle_id = $1 AND scheduled_at <= $2',
    [cycleId, nowDate.toISOString()]
  );
  return parseFloat(rows[0].total);
}

describe('V2-3 economy scale: validation', () => {
  test('absent scale resolves to 1 (legacy Core 7 behaviour preserved by default)', () => {
    expect(validateEconomyScale(undefined)).toBe(1);
    expect(validateEconomyScale('')).toBe(1);
    expect(resolveEconomyConfig({}).scale).toBe(1);
  });

  test('explicit values in [0, 1] resolve exactly', () => {
    expect(validateEconomyScale('0')).toBe(0);
    expect(validateEconomyScale('0.25')).toBe(0.25);
    expect(validateEconomyScale('1')).toBe(1);
    expect(validateEconomyScale(0.5)).toBe(0.5);
    expect(resolveEconomyConfig({ GAME_ECONOMY_SCALE: '0.25' }).scale).toBe(0.25);
  });

  test('values above 1, negatives and non-numbers are configuration errors', () => {
    expect(() => validateEconomyScale('1.5')).toThrow(/GAME_ECONOMY_SCALE/);
    expect(() => validateEconomyScale('-0.1')).toThrow(/GAME_ECONOMY_SCALE/);
    expect(() => validateEconomyScale('abc')).toThrow(/GAME_ECONOMY_SCALE/);
    expect(() => validateEconomyScale({})).toThrow(/GAME_ECONOMY_SCALE/);
    expect(() => resolveEconomyConfig({ GAME_ECONOMY_SCALE: '2' })).toThrow(/GAME_ECONOMY_SCALE/);
  });

  test('scaleEconomyAmount keeps exact 2dp money and rounds sub-penny to zero', () => {
    expect(scaleEconomyAmount(5, 1)).toBe(5);
    expect(scaleEconomyAmount(5, 0.25)).toBe(1.25);
    expect(scaleEconomyAmount(10, 0.5)).toBe(5);
    expect(scaleEconomyAmount(5, 0)).toBe(0);
    expect(scaleEconomyAmount(0.01, 0.5)).toBe(0.01); // rounds to a penny, stays
    expect(scaleEconomyAmount(0.01, 0.4)).toBe(0);     // below a penny: no debit
  });
});

describe('V2-3 economy scale: deterministic event schedule', () => {
  const SCHEDULE_SEED = 'v2-3-economy-scale-schedule-seed';
  const startTime = new Date('2026-02-01T00:00:00.000Z');
  const endTime = new Date('2026-02-01T00:30:00.000Z');

  test('scale 1 output is byte-identical to the legacy (no-scale) schedule', () => {
    const legacy = buildEventSchedule({ seed: SCHEDULE_SEED, startTime, endTime, config: resolveEconomyConfig({}) });
    const explicit = buildEventSchedule({ seed: SCHEDULE_SEED, startTime, endTime, config: scaledConfig(1) });
    expect(explicit).toEqual(legacy);
    expect(legacy).toHaveLength(GAME_EVENT_COUNT);
  });

  test('scale weakens amounts exactly, never timing, keys or descriptions', () => {
    const full = buildEventSchedule({ seed: SCHEDULE_SEED, startTime, endTime, config: scaledConfig(1) });
    const quarter = buildEventSchedule({ seed: SCHEDULE_SEED, startTime, endTime, config: scaledConfig(0.25) });
    expect(quarter).toHaveLength(full.length);
    for (let i = 0; i < full.length; i++) {
      expect(quarter[i].event_key).toBe(full[i].event_key);
      expect(quarter[i].scheduled_at).toEqual(full[i].scheduled_at);
      expect(quarter[i].description).toBe(full[i].description);
      expect(quarter[i].amount).toBe(scaleEconomyAmount(full[i].amount, 0.25));
    }
  });

  test('scale 0 produces no events at all', () => {
    expect(buildEventSchedule({ seed: SCHEDULE_SEED, startTime, endTime, config: scaledConfig(0) })).toEqual([]);
  });
});

describe('V2-3 economy scale: live debit path (disposable database)', () => {
  // The REAL configuration path: GAME_ECONOMY_SCALE in the environment is
  // read coherently by BOTH the cycle-creation schedule persistence and
  // every economy pass. These tests run the whole path at the intended
  // scale, then restore the default (scale 1 = legacy Core 7) environment.
  async function withScale(scale, fn) {
    const previous = process.env.GAME_ECONOMY_SCALE;
    process.env.GAME_ECONOMY_SCALE = String(scale);
    try {
      await fn();
    } finally {
      if (previous === undefined) delete process.env.GAME_ECONOMY_SCALE;
      else process.env.GAME_ECONOMY_SCALE = previous;
    }
  }

  // Fresh-cycle fixture. A cycle's persisted event schedule is derived
  // deterministically from the cycle seed and is authoritative for the whole
  // cycle — it is intentionally NEVER rewritten when the environment scale
  // changes mid-cycle. These tests must therefore assert against a cycle
  // whose schedule was persisted while the intended GAME_ECONOMY_SCALE was
  // set. reconcileCycle accepts a seed generator, so each test pins its own
  // seed: the schedule becomes reproducible, and the returned cycle carrying
  // THIS seed proves it was created fresh inside withScale (under the
  // intended scale) rather than recovered from a pre-existing ACTIVE cycle
  // whose schedule was persisted under a different scale — the exact
  // contamination this fixture previously asserted against silently.
  async function freshScaledCycle(seed) {
    const cycle = await reconcileCycle({ now: T0, generateSeed: () => seed });
    if (cycle.seed !== seed) {
      throw new Error(
        `v2-economy-scale fixture: expected a fresh cycle with pinned seed ${JSON.stringify(seed)} ` +
        `but recovered pre-existing ACTIVE cycle ${cycle.cycle_id} (seed ${JSON.stringify(cycle.seed)}) — ` +
        'its persisted event schedule was created under a different scale; refusing to assert against it'
      );
    }
    return cycle;
  }

  test('a scaled pass charges scaled fee amounts with full ledger evidence', async () => {
    await withScale(0.5, async () => {
      // Pinned schedule at scale 0.5 (deterministic from this seed):
      // EV-1 due ~4.35 min, £35.72 (scale 1 would persist £71.43 — above
      // the 37.5 bound, so the assertion below genuinely discriminates the
      // scale the schedule was persisted under); EV-2 due ~12.79 min.
      const cycle = await freshScaledCycle('v2-3-economy-scale-live-debit-seed-3');
      const summary = await economyService.runEconomyPass({ now: at(4.5), config: scaledConfig(0.5) });
      expect(summary.skipped).toBe(false);
      expect(summary.feeTicks).toEqual([1, 2]);

      const events = await cashEvents(cycle.cycle_id);
      const fees = events.filter((e) => e.type === 'FEE');
      expect(fees.length).toBeGreaterThan(0);
      // £5.00 fee at scale 0.5 -> exactly £2.50 per participant per tick.
      for (const fee of fees) expect(fee.amount).toBe(2.5);
      // No tax tick is due at 4.5 minutes (first lands at 5).
      expect(events.filter((e) => e.type === 'TAX')).toHaveLength(0);
      // Any persisted events due by 4.5 minutes were scheduled AND charged
      // at scale 0.5 (£150 legacy max -> £37.50 max).
      for (const ev of events.filter((e) => e.type === 'EVENT')) {
        expect(ev.amount).toBeLessThanOrEqual(37.5);
      }

      const eventTotal = await dueEventTotal(cycle.cycle_id, at(4.5));
      const expectedCash = Math.round((10000 - 2 * 2.5 - eventTotal) * 100) / 100;
      for (const p of await currentCash(cycle.cycle_id)) {
        expect(p.cash).toBe(expectedCash);
      }
    });
  });

  test('scaled passes stay idempotent across replay and catch-up', async () => {
    await withScale(0.5, async () => {
      const cycle = await freshScaledCycle('v2-3-economy-scale-replay-seed');
      await economyService.runEconomyPass({ now: at(4.5), config: scaledConfig(0.5) });
      const afterFirst = await currentCash(cycle.cycle_id);
      // Replay the same window: no tick re-charges (durable claims).
      const replay = await economyService.runEconomyPass({ now: at(4.5), config: scaledConfig(0.5) });
      expect(replay.feeTicks).toEqual([]);
      expect(await currentCash(cycle.cycle_id)).toEqual(afterFirst);
      // Catch-up to 6 minutes adds exactly one more scaled fee + scaled tax.
      const catchUp = await economyService.runEconomyPass({ now: at(6.5), config: scaledConfig(0.5) });
      expect(catchUp.feeTicks).toEqual([3]);
      expect(catchUp.taxTicks).toEqual([1]);
      const eventTotal = await dueEventTotal(cycle.cycle_id, at(6.5));
      for (const p of await currentCash(cycle.cycle_id)) {
        // £2.50 x3 fees + £5.00 tax at scale 0.5 + due scaled events.
        expect(p.cash).toBe(Math.round((10000 - 3 * 2.5 - 5 - eventTotal) * 100) / 100);
      }
    });
  });

  test('scale 0: no debits, no ledger rows, no durable tick claims, cash untouched', async () => {
    await withScale(0, async () => {
      const cycle = await freshScaledCycle('v2-3-economy-scale-scale0-seed');
      const summary = await economyService.runEconomyPass({ now: at(28), config: scaledConfig(0) });
      expect(summary.skipped).toBe(false);
      expect(summary.feeTicks).toEqual([]);
      expect(summary.taxTicks).toEqual([]);
      expect(summary.events).toEqual([]);
      expect(summary.participantsCharged).toBe(0);
      expect(await cashEvents(cycle.cycle_id)).toEqual([]);
      const { rows: ticks } = await db.query(
        'SELECT COUNT(*)::int AS n FROM apocalypse_economy_ticks WHERE cycle_id = $1',
        [cycle.cycle_id]
      );
      expect(ticks[0].n).toBe(0);
      const { rows: events } = await db.query(
        'SELECT COUNT(*)::int AS n FROM apocalypse_economy_events WHERE cycle_id = $1',
        [cycle.cycle_id]
      );
      expect(events[0].n).toBe(0);
      for (const p of await currentCash(cycle.cycle_id)) {
        expect(p.cash).toBe(10000);
      }
    });
  });

  test('concurrent scaled passes serialise on the advisory lock and never double-charge', async () => {
    await withScale(0.25, async () => {
      const cycle = await freshScaledCycle('v2-3-economy-scale-concurrency-seed');
      const config = scaledConfig(0.25);
      const [a, b] = await Promise.all([
        economyService.runEconomyPass({ now: at(4.5), config }),
        economyService.runEconomyPass({ now: at(4.5), config })
      ]);
      // Exactly one pass claimed the due ticks; the other observed them claimed.
      const claimed = [a, b].map((s) => s.feeTicks.length).sort((x, y) => x - y);
      expect(claimed).toEqual([0, 2]);
      const fees = (await cashEvents(cycle.cycle_id)).filter((e) => e.type === 'FEE');
      // £5.00 at scale 0.25 -> £1.25; exactly 2 ticks per participant.
      const { rows: participantCount } = await db.query(
        'SELECT COUNT(*)::int AS n FROM apocalypse_participants WHERE cycle_id = $1',
        [cycle.cycle_id]
      );
      expect(fees.length).toBe(2 * participantCount[0].n);
      const eventTotal = await dueEventTotal(cycle.cycle_id, at(4.5));
      for (const p of await currentCash(cycle.cycle_id)) {
        expect(p.cash).toBe(Math.round((10000 - 2 * 1.25 - eventTotal) * 100) / 100);
      }
      // Legacy amounts are exactly GAME_FEE_AMOUNT/GAME_TAX_AMOUNT at scale 1
      // (both values documented side by side for review).
      expect(GAME_FEE_AMOUNT).toBe(5);
      expect(GAME_TAX_AMOUNT).toBe(10);
      expect(scaleEconomyAmount(GAME_FEE_AMOUNT, 0.25)).toBe(1.25);
      expect(scaleEconomyAmount(GAME_TAX_AMOUNT, 0.25)).toBe(2.5);
    });
  });
});
