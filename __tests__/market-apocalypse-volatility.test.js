// Core 2 legacy-domain coverage (engine-level only).
//
// Stage 4 (persistent market) made the live writer persistent-authoritative:
// it no longer reconciles Apocalypse cycles, derives apocalypse percentages
// or applies the Core 2 amplitude. The writer-integration coverage that used
// to live here moved to __tests__/market-persistent-writer.test.js with the
// writer's new contract (batch state resolution, invalid-price rollback,
// lifecycle isolation, direction/scaling at the persisted-state level).
//
// What REMAINS here is the pure legacy domain engine contract
// (game/marketDomain.js + game/apocalypseVolatility.js), which is retained as
// an unreachable/compatibility module until proven cleanup (Stage 13): the
// amplitude scaling behaviour, both-directions movement, and the
// finite/positive safety envelope of evaluateMarketPoint. These tests pin the
// legacy engine's behaviour so the compatibility surface cannot drift
// silently while it remains in the tree.

const {
  getApocalypseVolatility,
  ABSOLUTE_MAX_APOCALYPSE_FACTOR
} = require('../game/apocalypseVolatility');
const marketDomain = require('../game/marketDomain');

jest.setTimeout(20000);

const CYCLE_START = new Date('2026-08-25T12:00:00.000Z');
const DURATION_MS = 30 * 60 * 1000;
// Exactly mid-cycle: deriveProgress yields apocalypsePercent 50 here.
const MID_CYCLE_MS = CYCLE_START.getTime() + DURATION_MS / 2;

// Deterministic domain fixture (no database): a roster coin on a fixed seed.
const DOMAIN_FIXTURE = {
  seed: 'v2-volatility-fixture',
  coinId: 1, // ZIP archetype on the gameplay roster
  baselinePrice: 100,
  roundStartMs: CYCLE_START.getTime()
};

describe('Core 2 legacy domain: deterministic amplitude direction and scaling', () => {
  // The pre-V2 suite injected Math.random() to force up/down moves. V2 has
  // no random component: direction is observed deterministically by
  // sweeping the shared domain across the cycle instead.
  test('both upward and downward movement remain possible at the maximum apocalypse factor', () => {
    let movedUp = false;
    let movedDown = false;
    for (let offset = 0; offset <= DURATION_MS; offset += 30000) {
      const { price } = marketDomain.evaluateMarketPoint({
        ...DOMAIN_FIXTURE,
        nowMs: CYCLE_START.getTime() + offset,
        amplitude: ABSOLUTE_MAX_APOCALYPSE_FACTOR
      });
      if (price > DOMAIN_FIXTURE.baselinePrice) movedUp = true;
      if (price < DOMAIN_FIXTURE.baselinePrice) movedDown = true;
    }
    expect(movedUp).toBe(true);
    expect(movedDown).toBe(true);
  });

  test('both directions remain possible at cycle start (factor 1) and late cycle', () => {
    for (const amplitude of [getApocalypseVolatility(0), getApocalypseVolatility(90)]) {
      let movedUp = false;
      let movedDown = false;
      for (let offset = 0; offset <= DURATION_MS; offset += 30000) {
        const { price } = marketDomain.evaluateMarketPoint({
          ...DOMAIN_FIXTURE,
          nowMs: CYCLE_START.getTime() + offset,
          amplitude
        });
        if (price > DOMAIN_FIXTURE.baselinePrice) movedUp = true;
        if (price < DOMAIN_FIXTURE.baselinePrice) movedDown = true;
      }
      expect(movedUp).toBe(true);
      expect(movedDown).toBe(true);
    }
  });

  test('the late-cycle factor produces a larger movement excursion than the start factor', () => {
    const excursion = (amplitude) => {
      let min = Infinity;
      let max = -Infinity;
      for (let offset = 0; offset < 10 * 60 * 1000; offset += 15000) {
        const { price } = marketDomain.evaluateMarketPoint({
          ...DOMAIN_FIXTURE,
          nowMs: CYCLE_START.getTime() + offset,
          amplitude
        });
        min = Math.min(min, price);
        max = Math.max(max, price);
      }
      return max - min;
    };

    const earlyExcursion = excursion(getApocalypseVolatility(0));
    const lateExcursion = excursion(getApocalypseVolatility(90));
    expect(lateExcursion).toBeGreaterThan(earlyExcursion);
  });
});

describe('Core 2 legacy domain: safety envelope', () => {
  test('prices stay finite and positive for every roster coin across the whole cycle even at the absolute maximum factor', () => {
    for (const coinId of marketDomain.GAMEPLAY_ROSTER.keys()) {
      for (let offset = 0; offset <= DURATION_MS; offset += 30000) {
        const { price } = marketDomain.evaluateMarketPoint({
          seed: DOMAIN_FIXTURE.seed,
          coinId,
          baselinePrice: 1,
          roundStartMs: DOMAIN_FIXTURE.roundStartMs,
          nowMs: CYCLE_START.getTime() + offset,
          amplitude: ABSOLUTE_MAX_APOCALYPSE_FACTOR
        });
        expect(Number.isFinite(price)).toBe(true);
        expect(price).toBeGreaterThan(0);
        // Persisted precision preserves the strictly-positive invariant.
        const persisted = marketDomain.roundGamePrice(price);
        expect(Number.isFinite(persisted)).toBe(true);
        expect(persisted).toBeGreaterThan(0);
      }
    }
  });

  test.each([
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['zero', 0],
    ['negative', -2],
    ['undefined', undefined]
  ])('an invalid amplitude (%s) safely falls back to normal volatility', (_label, amplitude) => {
    const guarded = marketDomain.evaluateMarketPoint({
      ...DOMAIN_FIXTURE,
      nowMs: MID_CYCLE_MS,
      amplitude
    });
    const normal = marketDomain.evaluateMarketPoint({
      ...DOMAIN_FIXTURE,
      nowMs: MID_CYCLE_MS,
      amplitude: 1
    });
    expect(guarded).toEqual(normal);
  });
});
