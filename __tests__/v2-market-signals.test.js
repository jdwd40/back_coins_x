// V2-1: public market signals — coarse, imperfect, and redacted.
//
// Players may see: current price, recent movement, coarse CURRENT phase,
// momentum, archetype, approximate typical ranges, dead state. Players must
// never see: the seed, exact phase timings, anchors, future phases/peaks,
// future collapse information, or any timestamp of a future transition.

const request = require('supertest');
const app = require('../app');
const db = require('../db/connection');
const marketDomain = require('../game/marketDomain');
const { reconcileCycle } = require('../game/gameCycleService');

jest.setTimeout(30000);

const SEED = 'v2-signals-test-seed-9f8c7e6d5b4a';
const ROUND_START = Date.UTC(2026, 7, 25, 10, 0, 0);

function signalFor(coinId, baselinePrice, nowMs) {
  return marketDomain.getPublicCoinSignal({
    seed: SEED,
    coinId,
    baselinePrice,
    roundStartMs: ROUND_START,
    nowMs
  });
}

describe('V2-1 public signals: shape and redaction', () => {
  test('a signal carries exactly the allowed public keys', () => {
    const signal = signalFor(2, 1.37, ROUND_START + 500_000);
    expect(Object.keys(signal).sort()).toEqual(marketDomain.PUBLIC_SIGNAL_KEYS.slice().sort());
  });

  test('signal values stay inside their legal vocabularies', () => {
    for (let t = 0; t <= 30 * 60 * 1000; t += 137_000) {
      for (const coinId of [1, 2, 3, 5, 9]) {
        const signal = signalFor(coinId, 1.5, ROUND_START + t);
        expect(['DIP', 'RISE', 'BOOM', 'FALL']).toContain(signal.phase);
        expect(['UP', 'DOWN', 'FLAT']).toContain(signal.momentum);
        expect(Object.keys(marketDomain.MARKET_ARCHETYPES)).toContain(signal.archetype);
        expect(signal.currentPrice).toBeGreaterThan(0);
        expect(Number.isFinite(signal.recentChangePct)).toBe(true);
        expect(signal.typicalCycleMinutes[0]).toBeLessThan(signal.typicalCycleMinutes[1]);
        expect(signal.typicalSwingPct[0]).toBeLessThan(signal.typicalSwingPct[1]);
      }
    }
  });

  test('the seed appears nowhere in the serialised signal', () => {
    for (const coinId of [1, 2, 3, 5, 9]) {
      const serialised = JSON.stringify(signalFor(coinId, 1.5, ROUND_START + 400_000));
      expect(serialised).not.toContain(SEED);
      expect(serialised).not.toContain('v2-signals-test');
    }
  });

  test('no timing, anchor, duration or future fields exist anywhere in the signal', () => {
    const signal = signalFor(3, 0.12, ROUND_START + 900_000);
    for (const key of Object.keys(signal)) {
      expect(key).not.toMatch(/time|date|duration|anchor|seed|peak|future|target|schedule|index|offset|cycle(?!Minutes)/i);
    }
  });

  test('signals are deterministic for identical inputs', () => {
    expect(signalFor(5, 96.45, ROUND_START + 321_000)).toEqual(signalFor(5, 96.45, ROUND_START + 321_000));
  });
});

describe('V2-1 public signals: GET /api/game/market-signals', () => {
  test('returns coarse signals for the whole active catalogue with no seed leakage', async () => {
    const response = await request(app).get('/api/game/market-signals').expect(200);
    expect(response.body.status).toBe('success');
    const data = response.body.data;
    expect(data.apocalypseId).toMatch(/^APOC-\d{4}$/);
    expect(Array.isArray(data.coins)).toBe(true);
    expect(data.coins).toHaveLength(10); // canonical active catalogue

    const allowedKeys = ['coinId', 'name', 'symbol', 'archetype', 'currentPrice', 'recentChangePct', 'phase', 'momentum', 'typicalCycleMinutes', 'typicalSwingPct', 'collapseRisk', 'dead', 'events'];
    for (const coin of data.coins) {
      expect(Object.keys(coin).sort()).toEqual(allowedKeys.slice().sort());
      expect(Array.isArray(coin.events)).toBe(true);
      if (coin.dead) {
        expect(coin.currentPrice).toBe(0);
        expect(coin.phase).toBe('DEAD');
        expect(coin.collapseRisk).toBe('DEAD');
        expect(coin.events).toEqual([]);
      } else {
        expect(coin.currentPrice).toBeGreaterThan(0);
        expect(['DIP', 'RISE', 'BOOM', 'FALL']).toContain(coin.phase);
        expect(['STABLE', 'SHAKY', 'DANGER', 'CRITICAL']).toContain(coin.collapseRisk);
      }
    }

    // The live cycle's persisted seed must appear NOWHERE in the payload.
    const { rows } = await db.query('SELECT seed FROM apocalypse_cycles ORDER BY cycle_id DESC LIMIT 1');
    const seed = rows[0].seed;
    expect(seed).toBeTruthy();
    expect(JSON.stringify(response.body)).not.toContain(seed);
  });

  test('a collapsed coin is reported dead at exactly £0 with no phase pretence', async () => {
    const cycle = await reconcileCycle({ now: new Date('2026-08-20T10:07:00.000Z') });
    const { rows: live } = await db.query('SELECT coin_id FROM coins WHERE retired = FALSE ORDER BY coin_id LIMIT 1');
    const doomedId = live[0].coin_id;
    await db.query(
      `INSERT INTO apocalypse_coin_collapses (cycle_id, coin_id, collapse_rank, collapsed_at)
       VALUES ($1, $2, 0, $3)`,
      [cycle.cycle_id, doomedId, new Date(cycle.start_time)]
    );
    await db.query('UPDATE coins SET current_price = 0 WHERE coin_id = $1', [doomedId]);
    const deadRows = [{ coin_id: doomedId }];

    // Pin the endpoint's lifecycle reconciliation to that live mid-collapse
    // cycle (the real wall clock is past the fixture cycle's window).
    const cycleService = require('../game/gameCycleService');
    const spy = jest.spyOn(cycleService, 'reconcileCycle').mockResolvedValue(cycle);
    try {
      const response = await request(app).get('/api/game/market-signals').expect(200);
      const deadCoins = response.body.data.coins.filter((c) => c.dead);
      expect(deadCoins.length).toBe(deadRows.length);
      for (const coin of deadCoins) {
        expect(coin.currentPrice).toBe(0);
        expect(coin.phase).toBe('DEAD');
        expect(coin.momentum).toBe('FLAT');
        expect(coin.recentChangePct).toBeNull();
      }
    } finally {
      spy.mockRestore();
    }
  });
});
