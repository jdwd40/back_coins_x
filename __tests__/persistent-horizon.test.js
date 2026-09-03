// Persistent-market Stage 2: the persistent-world horizon harness invariants
// (simulation/persistentHorizon.js — the Stage 2 gate: 90-day stability/variation,
// deterministic replay, no absorbing/extinct market, no runaway values.
//
// The full 90/365-day gates run via `npm run simulate:persistent-horizon`;
// this suite pins the harness's hard invariants and replay machinery over
// a bounded window so the contract is enforced in CI-time.

const {
  CANONICAL_PERSISTENT_COINS,
  runPersistentHorizon,
  assertHorizonInvariants,
  assertReplayIdentity
} = require('../simulation/persistentHorizon');

jest.setTimeout(180000);

const SEED = 'stage2-persistent-horizon-test-seed';

describe('Stage 2 persistent horizon harness', () => {
  test('a bounded neutral run satisfies every hard invariant (no runaway, no extinction, no absorbing floor, genuine variety)', () => {
    const result = runPersistentHorizon({ days: 30, seed: SEED });
    expect(() => assertHorizonInvariants(result)).not.toThrow();
    // Every coin produced a sane band and both-direction condition movement.
    for (const coin of CANONICAL_PERSISTENT_COINS) {
      const m = result.metrics.get(coin.coinId);
      expect(m.minPrice).toBeGreaterThan(0);
      expect(m.floorTouches).toBe(0);
      expect(m.conditionUpSteps).toBeGreaterThan(0);
      expect(m.conditionDownSteps).toBeGreaterThan(0);
    }
  });

  test('deterministic replay: an interrupted run resumed from its frozen snapshot is bit-identical', () => {
    const result = runPersistentHorizon({ days: 20, seed: SEED, replayDay: 10 });
    const replay = assertReplayIdentity(result);
    expect(replay.checked).toBeGreaterThan(50);
  });

  test('two independent full runs agree exactly (deterministic simulation)', () => {
    const a = runPersistentHorizon({ days: 5, seed: SEED });
    const b = runPersistentHorizon({ days: 5, seed: SEED });
    for (const coin of CANONICAL_PERSISTENT_COINS) {
      const ma = a.metrics.get(coin.coinId);
      const mb = b.metrics.get(coin.coinId);
      expect(Object.is(ma.minPrice, mb.minPrice)).toBe(true);
      expect(Object.is(ma.maxPrice, mb.maxPrice)).toBe(true);
      expect(Object.is(ma.conditionMin, mb.conditionMin)).toBe(true);
    }
  });

  test('a different world seed produces a different (but still invariant-satisfying) market — seeded variety', () => {
    const a = runPersistentHorizon({ days: 5, seed: SEED });
    const b = runPersistentHorizon({ days: 5, seed: `${SEED}-other` });
    // Different seeds: different trajectories (some metric differs)...
    const differs = CANONICAL_PERSISTENT_COINS.some((coin) => {
      const ma = a.metrics.get(coin.coinId);
      const mb = b.metrics.get(coin.coinId);
      return !Object.is(ma.minPrice, mb.minPrice) || !Object.is(ma.maxPrice, mb.maxPrice);
    });
    expect(differs).toBe(true);
    // ...but both satisfy the hard invariants.
    expect(() => assertHorizonInvariants(a)).not.toThrow();
    expect(() => assertHorizonInvariants(b)).not.toThrow();
  });

  test('degenerate horizons fail loudly', () => {
    expect(() => runPersistentHorizon({ days: 0.001, cadenceMinutes: 30, seed: SEED })).toThrow(/at least one step/);
    expect(() => runPersistentHorizon({ days: -5, seed: SEED })).toThrow(/at least one step/);
  });
});
