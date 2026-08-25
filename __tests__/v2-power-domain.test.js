// V2-2: shared Power domain (game/powerDomain.js) — pure unit tests, no DB.
//
// Covers: the exact buy-cost formula and its edge amounts, the
// fragmentation-resistance proof by exhaustive comparison, lazy
// regeneration after 0 / one / multiple intervals, clamping to [0, max],
// future/invalid timestamps never creating Power, spend semantics
// (affordability, atomicity of the returned pair, sub-interval phase
// preservation) and the position-limit predicate (live vs collapsed vs
// zero-quantity holdings).

const powerDomain = require('../game/powerDomain');
const {
  GAME_POWER_MAX,
  GAME_POWER_REGEN_MS_PER_POINT,
  GAME_POWER_BUY_COST_DIVISOR,
  GAME_MAX_OPEN_POSITIONS
} = require('../game/gameConstants');

const CONFIG = { maxPower: 100, regenMsPerPoint: 120000, buyCostDivisor: 125, maxOpenPositions: 3 };

describe('V2-2 Power domain: buy cost formula', () => {
  test('matches the plan targets with the default divisor', () => {
    expect(GAME_POWER_BUY_COST_DIVISOR).toBe(125);
    expect(powerDomain.buyPowerCost(250)).toBe(3);
    expect(powerDomain.buyPowerCost(500)).toBe(5);
    expect(powerDomain.buyPowerCost(1000)).toBe(9);
    expect(powerDomain.buyPowerCost(2500)).toBe(21);
  });

  test('exact formula: 1 + floor(total / divisor) including edge amounts', () => {
    expect(powerDomain.buyPowerCost(0.01)).toBe(1);   // the flat order charge is the minimum
    expect(powerDomain.buyPowerCost(124.99)).toBe(1);
    expect(powerDomain.buyPowerCost(125)).toBe(2);    // one full divisor unit + the order charge
    expect(powerDomain.buyPowerCost(125.01)).toBe(2);
    expect(powerDomain.buyPowerCost(249.99)).toBe(2);
    expect(powerDomain.buyPowerCost(250)).toBe(3);
    expect(powerDomain.buyPowerCost(10000)).toBe(81); // full starting-cash deployment
    expect(powerDomain.buyPowerCost(0.04)).toBe(1);
  });

  test('rejects non-positive or non-finite totals', () => {
    expect(() => powerDomain.buyPowerCost(0)).toThrow(/positive/);
    expect(() => powerDomain.buyPowerCost(-5)).toThrow(/positive/);
    expect(() => powerDomain.buyPowerCost(NaN)).toThrow(/finite/);
    expect(() => powerDomain.buyPowerCost(Infinity)).toThrow(/finite/);
    expect(() => powerDomain.buyPowerCost('250')).toThrow(/finite/);
  });

  test('fragmentation never reduces cost: splitting any buy into any fragments costs at least as much', () => {
    // Exhaustive over a representative grid: every way of splitting T into
    // k positive parts costs >= the single-buy cost of T.
    const totals = [1, 50, 124.99, 125, 125.01, 250, 500, 1000, 2500, 10000];
    for (const total of totals) {
      const single = powerDomain.buyPowerCost(total);
      for (let parts = 2; parts <= 10; parts++) {
        // Even split plus a penny-shifted uneven split.
        const even = total / parts;
        let splitSum = 0;
        for (let i = 0; i < parts; i++) splitSum += powerDomain.buyPowerCost(even);
        expect(splitSum).toBeGreaterThanOrEqual(single);
        let unevenSum = powerDomain.buyPowerCost(0.01) + powerDomain.buyPowerCost(total - 0.01);
        expect(unevenSum).toBeGreaterThanOrEqual(single);
      }
    }
  });

  test('many tiny buys are bounded by the +1 minimum (spam cannot be free)', () => {
    // 200 x £1 buys = £200 deployed for 200 Power vs a single £200 buy = 2.
    const tinyTotal = 200 * powerDomain.buyPowerCost(1);
    expect(tinyTotal).toBe(200);
    expect(powerDomain.buyPowerCost(200)).toBe(2);
    expect(tinyTotal).toBeGreaterThan(powerDomain.buyPowerCost(200));
  });

  test('explicit divisor override is honoured and validated', () => {
    expect(powerDomain.buyPowerCost(250, { buyCostDivisor: 250 })).toBe(2);
    expect(powerDomain.buyPowerCost(251, { buyCostDivisor: 250 })).toBe(2);
    expect(powerDomain.buyPowerCost(500, { buyCostDivisor: 250 })).toBe(3);
    expect(() => powerDomain.buyPowerCost(250, { buyCostDivisor: 0 })).toThrow(/positive/);
    expect(() => powerDomain.buyPowerCost(250, { buyCostDivisor: 125.001 })).toThrow(/two decimal/);
  });
});

describe('V2-2 Power domain: lazy reconciliation', () => {
  const base = { storedPower: 50, updatedAtMs: 1_000_000, maxPower: 100, regenMsPerPoint: 120000 };

  test('zero elapsed intervals: stored value returned unchanged', () => {
    const { power, nextPointAtMs } = powerDomain.reconcilePower({ ...base, nowMs: base.updatedAtMs });
    expect(power).toBe(50);
    expect(nextPointAtMs).toBe(base.updatedAtMs + 120000);
    // Partial interval does not count.
    expect(powerDomain.reconcilePower({ ...base, nowMs: base.updatedAtMs + 119999 }).power).toBe(50);
  });

  test('exactly one interval adds exactly one point', () => {
    const { power, nextPointAtMs } = powerDomain.reconcilePower({ ...base, nowMs: base.updatedAtMs + 120000 });
    expect(power).toBe(51);
    expect(nextPointAtMs).toBe(base.updatedAtMs + 240000);
  });

  test('multiple intervals add multiple points', () => {
    expect(powerDomain.reconcilePower({ ...base, nowMs: base.updatedAtMs + 10 * 120000 }).power).toBe(60);
    expect(powerDomain.reconcilePower({ ...base, nowMs: base.updatedAtMs + 10 * 120000 + 119999 }).power).toBe(60);
    expect(powerDomain.reconcilePower({ ...base, nowMs: base.updatedAtMs + 11 * 120000 }).power).toBe(61);
  });

  test('clamps at max and reports no next point when full', () => {
    const full = powerDomain.reconcilePower({ ...base, nowMs: base.updatedAtMs + 1000 * 120000 });
    expect(full.power).toBe(100);
    expect(full.nextPointAtMs).toBeNull();
    // Stored values above max (e.g. after a downward retune) clamp too.
    expect(powerDomain.reconcilePower({ ...base, storedPower: 250, nowMs: base.updatedAtMs }).power).toBe(100);
  });

  test('a future nowMs never creates Power', () => {
    const result = powerDomain.reconcilePower({ ...base, nowMs: base.updatedAtMs - 10 * 120000 });
    expect(result.power).toBe(50);
  });

  test('a stored future timestamp freezes regeneration until real time catches up', () => {
    const future = base.updatedAtMs + 3600000;
    expect(powerDomain.reconcilePower({ storedPower: 10, updatedAtMs: future, nowMs: base.updatedAtMs, maxPower: 100, regenMsPerPoint: 120000 }).power).toBe(10);
    // Still frozen 30 minutes later (before the stored future stamp).
    expect(powerDomain.reconcilePower({ storedPower: 10, updatedAtMs: future, nowMs: base.updatedAtMs + 1800000, maxPower: 100, regenMsPerPoint: 120000 }).power).toBe(10);
    // Regen resumes from the stored stamp, not from the past.
    expect(powerDomain.reconcilePower({ storedPower: 10, updatedAtMs: future, nowMs: future + 120000, maxPower: 100, regenMsPerPoint: 120000 }).power).toBe(11);
  });

  test('invalid timestamps and stored values never create Power and never NaN', () => {
    expect(powerDomain.reconcilePower({ storedPower: 40, updatedAtMs: NaN, nowMs: 2000, maxPower: 100, regenMsPerPoint: 120000 }).power).toBe(40);
    expect(powerDomain.reconcilePower({ storedPower: 40, updatedAtMs: 1000, nowMs: NaN, maxPower: 100, regenMsPerPoint: 120000 }).power).toBe(40);
    expect(powerDomain.reconcilePower({ storedPower: NaN, updatedAtMs: 1000, nowMs: 2000, maxPower: 100, regenMsPerPoint: 120000 }).power).toBe(0);
    expect(powerDomain.reconcilePower({ storedPower: -30, updatedAtMs: 1000, nowMs: 1000, maxPower: 100, regenMsPerPoint: 120000 }).power).toBe(0);
    expect(powerDomain.reconcilePower({ storedPower: 40.9, updatedAtMs: 1000, nowMs: 1000, maxPower: 100, regenMsPerPoint: 120000 }).power).toBe(40);
  });

  test('default config comes from the shared game constants', () => {
    expect(GAME_POWER_MAX).toBe(100);
    expect(GAME_POWER_REGEN_MS_PER_POINT).toBe(30000); // tuned by the multi-round study
    expect(GAME_MAX_OPEN_POSITIONS).toBe(3);
    const { power } = powerDomain.reconcilePower({ storedPower: 0, updatedAtMs: 0, nowMs: GAME_POWER_REGEN_MS_PER_POINT * 5 });
    expect(power).toBe(5);
  });
});

describe('V2-2 Power domain: spending', () => {
  const base = { storedPower: 50, updatedAtMs: 1_000_000, maxPower: 100, regenMsPerPoint: 120000 };

  test('an affordable spend returns the post-spend pair; an unaffordable one returns null', () => {
    const spend = powerDomain.spendPower({ ...base, nowMs: base.updatedAtMs, cost: 20 });
    expect(spend).toEqual({ power: 30, updatedAtMs: base.updatedAtMs });
    expect(powerDomain.spendPower({ ...base, nowMs: base.updatedAtMs, cost: 51 })).toBeNull();
    expect(powerDomain.spendPower({ ...base, nowMs: base.updatedAtMs, cost: 50 })).not.toBeNull();
  });

  test('regen credit is applied before the affordability check', () => {
    // 50 stored + 2 regenerated = 52: a 52-cost spend is affordable.
    const spend = powerDomain.spendPower({ ...base, nowMs: base.updatedAtMs + 240000, cost: 52 });
    expect(spend.power).toBe(0);
  });

  test('sub-interval regen phase is preserved across spends', () => {
    // 150s elapsed = 1 whole interval + 30s phase. Spending must keep the
    // 30s of progress toward the next point.
    const now = base.updatedAtMs + 150000;
    const spend = powerDomain.spendPower({ ...base, nowMs: now, cost: 1 });
    expect(spend.power).toBe(50); // 51 effective - 1
    expect(spend.updatedAtMs).toBe(base.updatedAtMs + 120000); // phase preserved
    // 90s after the spend the next point lands (150s - 120s phase + 90s).
    const follow = powerDomain.reconcilePower({ storedPower: spend.power, updatedAtMs: spend.updatedAtMs, nowMs: now + 90000, maxPower: 100, regenMsPerPoint: 120000 });
    expect(follow.power).toBe(51);
  });

  test('spending with a future stored stamp keeps the stamp (regen stays paused)', () => {
    const future = base.updatedAtMs + 3600000;
    const spend = powerDomain.spendPower({ storedPower: 10, updatedAtMs: future, nowMs: base.updatedAtMs, cost: 4, maxPower: 100, regenMsPerPoint: 120000 });
    expect(spend).toEqual({ power: 6, updatedAtMs: future });
  });

  test('cost must be a non-negative integer', () => {
    expect(() => powerDomain.spendPower({ ...base, nowMs: 0, cost: 1.5 })).toThrow(/integer/);
    expect(() => powerDomain.spendPower({ ...base, nowMs: 0, cost: -1 })).toThrow(/integer/);
  });
});

describe('V2-2 Power domain: position limit', () => {
  test('live positions are quantity > 0 and not collapsed; collapsed and zero-quantity holdings are excluded', () => {
    const holdings = [
      { coinId: 1, quantity: 5, dead: false },
      { coinId: 2, quantity: 0, dead: false },   // closed: no slot
      { coinId: 3, quantity: 9, dead: true },    // collapsed: no slot
      { coinId: 4, quantity: 0.00000001, dead: false }
    ];
    expect([...powerDomain.livePositionCoinIds(holdings)].sort()).toEqual([1, 4]);
  });

  test('adding to an existing live position is always allowed, even at the cap', () => {
    const holdings = [
      { coinId: 1, quantity: 1, dead: false },
      { coinId: 2, quantity: 1, dead: false },
      { coinId: 3, quantity: 1, dead: false }
    ];
    const add = powerDomain.evaluatePositionLimit({ holdings, coinId: 2, maxOpenPositions: 3 });
    expect(add.allowed).toBe(true);
    expect(add.openPositions).toBe(3);
  });

  test('a fourth distinct live position is rejected; reopening a closed coin counts as new', () => {
    const holdings = [
      { coinId: 1, quantity: 1, dead: false },
      { coinId: 2, quantity: 1, dead: false },
      { coinId: 3, quantity: 1, dead: false },
      { coinId: 5, quantity: 0, dead: false } // closed earlier: NOT a slot
    ];
    const fourth = powerDomain.evaluatePositionLimit({ holdings, coinId: 4, maxOpenPositions: 3 });
    expect(fourth.allowed).toBe(false);
    expect(fourth.reason).toBe('position-limit');
    const reopen = powerDomain.evaluatePositionLimit({ holdings, coinId: 5, maxOpenPositions: 3 });
    expect(reopen.allowed).toBe(false); // 3 live already: reopening is a NEW open
    const afterSellDown = powerDomain.evaluatePositionLimit({
      holdings: holdings.filter((h) => h.coinId !== 3), coinId: 5, maxOpenPositions: 3
    });
    expect(afterSellDown.allowed).toBe(true);
  });

  test('collapsed holdings free their slot immediately', () => {
    const holdings = [
      { coinId: 1, quantity: 1, dead: false },
      { coinId: 2, quantity: 1, dead: false },
      { coinId: 3, quantity: 7, dead: true } // dead: slot free
    ];
    const result = powerDomain.evaluatePositionLimit({ holdings, coinId: 9, maxOpenPositions: 3 });
    expect(result.allowed).toBe(true);
    expect(result.openPositions).toBe(2);
  });

  test('precomputed live id sets are accepted (live SQL path parity)', () => {
    const result = powerDomain.evaluatePositionLimit({ liveCoinIds: [1, 2, 3], coinId: 4, maxOpenPositions: 3 });
    expect(result.allowed).toBe(false);
    expect(powerDomain.evaluatePositionLimit({ liveCoinIds: new Set([1, 2]), coinId: 4, maxOpenPositions: 3 }).allowed).toBe(true);
    expect(powerDomain.evaluatePositionLimit({ liveCoinIds: [1, 2, 3], coinId: 1, maxOpenPositions: 3 }).allowed).toBe(true);
  });
});
