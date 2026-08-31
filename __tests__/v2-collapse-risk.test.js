// V2-3: collapse-risk signals — coarse, imperfect, non-leaking.
//
// The risk level is legal public information built ONLY from public state
// (apocalypse progress, public phase/momentum/movement, public archetype)
// plus seeded noise from a stream INDEPENDENT of the collapse shuffle.
// These tests pin the fixed vocabulary and response shape, determinism,
// the absence of seed/schedule/rank/timestamp/future leakage, provable
// imperfectness against the hidden schedule on seeded samples, and the
// useful relationship to rising apocalypse danger.

const request = require('supertest');
const app = require('../app');
const db = require('../db/connection');
const riskDomain = require('../game/collapseRiskDomain');
const { createRoundEnvironment, CANONICAL_COINS } = require('../simulation/roundEnvironment');
const { reconcileCycle } = require('../game/gameCycleService');

jest.setTimeout(60000);

const SEED = 'v2-3-risk-test-seed-aa11bb22cc33';

function riskFor(coinId, apocalypsePercent, extra = {}) {
  return riskDomain.getCollapseRisk({
    seed: SEED,
    coinId,
    apocalypsePercent,
    phase: 'RISE',
    momentum: 'UP',
    recentChangePct: 1.5,
    nowMs: 600000,
    ...extra
  });
}

describe('V2-3 collapse risk: vocabulary, shape and determinism', () => {
  test('the vocabulary is exactly STABLE/SHAKY/DANGER/CRITICAL with a fixed order', () => {
    expect(riskDomain.COLLAPSE_RISK_LEVELS).toEqual(['STABLE', 'SHAKY', 'DANGER', 'CRITICAL']);
    expect(riskDomain.COLLAPSE_RISK_ORDINAL).toEqual({ STABLE: 0, SHAKY: 1, DANGER: 2, CRITICAL: 3 });
    expect(riskDomain.DEAD_RISK_MARKER).toBe('DEAD');
  });

  test('every live-coin reading is one of the fixed levels across the whole round', () => {
    for (let percent = 0; percent <= 100; percent += 7) {
      for (const coin of CANONICAL_COINS) {
        const level = riskFor(coin.coinId, percent, { nowMs: (percent / 100) * 30 * 60 * 1000 });
        expect(riskDomain.COLLAPSE_RISK_LEVELS).toContain(level);
      }
    }
  });

  test('deterministic replay: identical inputs produce identical levels and scores', () => {
    const options = {
      seed: SEED, coinId: 3, apocalypsePercent: 82, phase: 'FALL', momentum: 'DOWN', recentChangePct: -6.2, nowMs: 1475000
    };
    expect(riskDomain.getCollapseRisk(options)).toBe(riskDomain.getCollapseRisk(options));
    expect(riskDomain.getCollapseRiskScore(options)).toBe(riskDomain.getCollapseRiskScore(options));
  });

  test('scores stay finite for edge inputs and malformed progress is safe', () => {
    for (const progress of [0, 45, 70, 100, -5, 140, NaN, Infinity, undefined]) {
      const score = riskDomain.getCollapseRiskScore({
        seed: SEED, coinId: 9, apocalypsePercent: progress, phase: 'DIP', momentum: 'FLAT', recentChangePct: null, nowMs: 0
      });
      expect(Number.isFinite(score)).toBe(true);
    }
    // Malformed progress never invents danger.
    expect(riskDomain.progressDanger(NaN)).toBe(0);
    expect(riskDomain.progressDanger(undefined)).toBe(0);
  });

  test('a coin\'s risk personality is not static across rounds (per-round seed changes it)', () => {
    const levels = new Set();
    for (let r = 0; r < 12; r++) {
      levels.add(riskDomain.getCollapseRisk({
        seed: `round-seed-${r}`, coinId: 3, apocalypsePercent: 80,
        phase: 'RISE', momentum: 'UP', recentChangePct: 1, nowMs: 1440000
      }));
    }
    expect(levels.size).toBeGreaterThan(1);
  });
});

describe('V2-3 collapse risk: useful but imperfect against the hidden schedule', () => {
  // Seeded rounds: measure whether "the highest-public-risk live coin is
  // the next to collapse" — a perfect leak would be right ~always; an
  // honest noisy signal lands near chance.
  const ROUNDS = 120;
  let samples = 0;
  let hits = 0;
  let chanceSum = 0;
  const ordinalAt = { 20: [], 95: [] };
  const archetypeOrdinal = { ZIP: [], RUG: [] };

  beforeAll(() => {
    for (let r = 0; r < ROUNDS; r++) {
      const seed = `v2-3-risk-imperfectness-seed:${r}`;
      const env = createRoundEnvironment({ seed, economy: false });

      // Usefulness probes: mean risk ordinal early vs late, and per
      // archetype (ZIP coin 1 vs RUG coin 3) at the same progress.
      for (const [percent, bucket] of [[20, ordinalAt[20]], [95, ordinalAt[95]]]) {
        const t = Math.floor(env.durationMs * (percent / 100));
        for (const coin of CANONICAL_COINS) {
          if (env.isDead(coin.coinId, t)) continue;
          const level = env.publicSignal(coin.coinId, t).collapseRisk;
          bucket.push(riskDomain.COLLAPSE_RISK_ORDINAL[level]);
        }
      }
      const t80 = Math.floor(env.durationMs * 0.8);
      for (const [coinId, bucket] of [[1, archetypeOrdinal.ZIP], [3, archetypeOrdinal.RUG]]) {
        if (!env.isDead(coinId, t80)) {
          bucket.push(riskDomain.COLLAPSE_RISK_ORDINAL[env.publicSignal(coinId, t80).collapseRisk]);
        }
      }

      // Imperfectness probe inside the collapse window.
      for (const percent of [72, 76, 80, 84, 88, 92]) {
        const t = Math.floor(env.durationMs * (percent / 100));
        const live = CANONICAL_COINS.filter((c) => !env.isDead(c.coinId, t) && env.collapseAtMs.get(c.coinId) > t);
        if (live.length < 2) continue;
        const byRisk = live.slice().sort((a, b) => {
          const ra = riskDomain.COLLAPSE_RISK_ORDINAL[env.publicSignal(a.coinId, t).collapseRisk];
          const rb = riskDomain.COLLAPSE_RISK_ORDINAL[env.publicSignal(b.coinId, t).collapseRisk];
          return rb - ra || a.coinId - b.coinId;
        });
        const next = live.slice().sort((a, b) => env.collapseAtMs.get(a.coinId) - env.collapseAtMs.get(b.coinId))[0];
        samples += 1;
        chanceSum += 1 / live.length;
        if (byRisk[0].coinId === next.coinId) hits += 1;
      }
    }
  });

  test('the signal is NOT a next-collapse classifier (accuracy far below a leak)', () => {
    expect(samples).toBeGreaterThan(300);
    const accuracy = hits / samples;
    const chance = chanceSum / samples;
    // A schedule leak would sit near 100%. The honest signal must stay
    // clearly imperfect: below 50% absolutely, and within a modest margin
    // of the chance baseline for a uniform pick.
    expect(accuracy).toBeLessThan(0.5);
    expect(accuracy).toBeLessThan(chance + 0.15);
  });

  test('risk rises with apocalypse danger (useful gradient)', () => {
    const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(mean(ordinalAt[95])).toBeGreaterThan(mean(ordinalAt[20]) + 1.0);
  });

  test('public archetype personality matters: RUG reads riskier than ZIP at identical progress', () => {
    const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(mean(archetypeOrdinal.RUG)).toBeGreaterThan(mean(archetypeOrdinal.ZIP));
  });
});

describe('V2-3 collapse risk: no leakage through the public endpoint', () => {
  test('risk fields carry no seed, schedule, rank, timestamp or future keys', async () => {
    const response = await request(app).get('/api/game/market-signals').expect(200);
    const data = response.body.data;
    expect(Array.isArray(data.coins)).toBe(true);
    expect(data.coins.length).toBeGreaterThan(0);

    for (const coin of data.coins) {
      expect(coin).toHaveProperty('collapseRisk');
      for (const key of Object.keys(coin)) {
        expect(key).not.toMatch(/seed|rank|schedule|timestamp|collapseAt|future|window|order/i);
      }
    }
    // The risk value itself is never a number, timestamp, index or fraction.
    for (const coin of data.coins) {
      expect(typeof coin.collapseRisk).toBe('string');
      expect(['STABLE', 'SHAKY', 'DANGER', 'CRITICAL', 'DEAD']).toContain(coin.collapseRisk);
    }

    // The live cycle's persisted seed appears nowhere in the payload.
    const { rows } = await db.query('SELECT seed FROM apocalypse_cycles ORDER BY cycle_id DESC LIMIT 1');
    expect(JSON.stringify(response.body)).not.toContain(rows[0].seed);
  });

  test('a collapsed coin reports risk DEAD at exactly £0 and stays visibly dead', async () => {
    const cycle = await reconcileCycle({ now: new Date('2026-08-20T10:07:00.000Z') });
    // Persist an actual dynamic death record and its authoritative £0 price;
    // the old fixed schedule no longer controls a coin's state.
    const { rows: live } = await db.query('SELECT coin_id FROM coins WHERE retired = FALSE ORDER BY coin_id LIMIT 1');
    const doomedId = live[0].coin_id;
    await db.query(
      `INSERT INTO apocalypse_coin_collapses (cycle_id, coin_id, collapse_rank, collapsed_at)
       VALUES ($1, $2, 0, $3)`,
      [cycle.cycle_id, doomedId, new Date(cycle.start_time)]
    );
    await db.query('UPDATE coins SET current_price = 0 WHERE coin_id = $1', [doomedId]);
    const deadRows = [{ coin_id: doomedId }];

    const cycleService = require('../game/gameCycleService');
    const spy = jest.spyOn(cycleService, 'reconcileCycle').mockResolvedValue(cycle);
    try {
      const response = await request(app).get('/api/game/market-signals').expect(200);
      const deadCoins = response.body.data.coins.filter((c) => c.dead);
      expect(deadCoins.length).toBe(deadRows.length);
      for (const coin of deadCoins) {
        expect(coin.currentPrice).toBe(0);
        expect(coin.phase).toBe('DEAD');
        expect(coin.collapseRisk).toBe('DEAD');
      }
    } finally {
      spy.mockRestore();
    }
  });
});
