// V2-1: headless simulation harness — paired determinism, trade mechanics,
// strategy legality, metrics and batch reproducibility.

const { createRoundEnvironment, CANONICAL_COINS } = require('../simulation/roundEnvironment');
const { createRoundContext, runRound, createPortfolio, executeBuy, executeSell } = require('../simulation/engine');
const { STRATEGIES } = require('../simulation/strategies');
const { runBatch, buildReport, deriveRoundSeed } = require('../simulation/batch');
const { summarizeStrategy, pairedWinRate, median, percentile } = require('../simulation/metrics');

jest.setTimeout(120000);

const SEED = 'v2-sim-test-seed';

describe('V2-1 simulation: paired identical market paths', () => {
  test('two contexts from the same seed produce identical price and signal grids', () => {
    const a = createRoundContext(createRoundEnvironment({ seed: SEED }));
    const b = createRoundContext(createRoundEnvironment({ seed: SEED }));
    expect(a.ticks).toEqual(b.ticks);
    for (const coin of CANONICAL_COINS) {
      expect(a.gridByCoin.get(coin.coinId)).toEqual(b.gridByCoin.get(coin.coinId));
    }
    expect(JSON.stringify(a.signalGrid)).toBe(JSON.stringify(b.signalGrid));
  });

  test('different seeds produce different collapse schedules and price paths', () => {
    const a = createRoundEnvironment({ seed: 'seed-one' });
    const b = createRoundEnvironment({ seed: 'seed-two' });
    expect([...a.collapseAtMs.entries()]).not.toEqual([...b.collapseAtMs.entries()]);
    const t = 10 * 60 * 1000;
    const pricesA = CANONICAL_COINS.map((c) => a.priceAt(c.coinId, t));
    const pricesB = CANONICAL_COINS.map((c) => b.priceAt(c.coinId, t));
    expect(pricesA).not.toEqual(pricesB);
  });

  test('every coin is dead by round end and prices are never negative', () => {
    const env = createRoundEnvironment({ seed: SEED });
    const end = env.durationMs;
    for (const coin of CANONICAL_COINS) {
      expect(env.priceAt(coin.coinId, end)).toBe(0);
      for (let t = 0; t < end; t += 45_000) {
        expect(env.priceAt(coin.coinId, t)).toBeGreaterThanOrEqual(0);
      }
    }
  });

  test('the collapse window matches Core 3: no deaths before 70%, all dead at 100%', () => {
    const env = createRoundEnvironment({ seed: SEED });
    for (const [, atMs] of env.collapseAtMs) {
      expect(atMs).toBeGreaterThanOrEqual(env.durationMs * 0.7);
      expect(atMs).toBeLessThanOrEqual(env.durationMs);
    }
  });

  test('the same strategy on the same context is fully reproducible', () => {
    const context = createRoundContext(createRoundEnvironment({ seed: SEED }));
    const first = runRound(context, STRATEGIES.DIP_BOOM);
    const second = runRound(context, STRATEGIES.DIP_BOOM);
    expect(first.finalCash).toBe(second.finalCash);
    expect(first.trades).toBe(second.trades);
    expect(first.equityCurve).toEqual(second.equityCurve);
  });
});

describe('V2-1 simulation: trade mechanics mirror the live domain', () => {
  test('buy debits the 2dp consideration; sell credits it; min notional enforced', () => {
    const portfolio = createPortfolio(100);
    expect(executeBuy(portfolio, 1, 10, 2)).toBe(true);
    expect(portfolio.cash).toBe(90);
    expect(portfolio.holdings.get(1).quantity).toBe(5);

    expect(executeSell(portfolio, 1, 0.5, 2)).toBe(true);
    expect(portfolio.cash).toBe(95);

    // A spend whose consideration rounds below £0.01 cannot execute.
    expect(executeBuy(portfolio, 1, 0.004, 100)).toBe(false);
    // Dead coin (price 0) can never be bought.
    expect(executeBuy(portfolio, 1, 10, 0)).toBe(false);
  });

  test('oversell is rejected; selling at £0 credits exactly zero', () => {
    const portfolio = createPortfolio(100);
    executeBuy(portfolio, 1, 10, 2);
    expect(executeSell(portfolio, 1, 2, 2)).toBe(true); // fraction clamped to 1
    expect(portfolio.holdings.has(1)).toBe(false);
    executeBuy(portfolio, 1, 10, 2);
    const cashBefore = portfolio.cash;
    expect(executeSell(portfolio, 1, 1, 0)).toBe(true);
    expect(portfolio.cash).toBe(cashBefore);
  });

  test('settlement scores cash only: open positions at round end are worth £0', () => {
    const context = createRoundContext(createRoundEnvironment({ seed: SEED }));
    const result = runRound(context, STRATEGIES.HOLD_FOREVER);
    // HOLD_FOREVER deploys ~95% of £10,000 and never sells; everything
    // collapses, so only the undeployed cash (minus economy debits) remains.
    expect(result.finalCash).toBeLessThan(600);
    expect(result.finalCash).toBeGreaterThan(0);
    expect(result.profitable).toBe(false);
  });
});

describe('V2-1 simulation: strategy legality', () => {
  test('PERFECT_INFORMATION is the only strategy allowed future knowledge', () => {
    for (const [id, strategy] of Object.entries(STRATEGIES)) {
      if (id === 'PERFECT_INFORMATION') {
        expect(strategy.usesFuture).toBe(true);
      } else {
        expect(strategy.usesFuture).toBe(false);
      }
    }
  });

  test('no legal strategy observation contains seed, future or timing internals', () => {
    const context = createRoundContext(createRoundEnvironment({ seed: SEED }));
    let captured = null;
    const probe = {
      id: 'PROBE',
      usesFuture: false,
      usesOwnRandom: false,
      decide(observation) {
        captured = observation;
        return [];
      }
    };
    runRound(context, probe);
    const serialised = JSON.stringify(captured);
    expect(serialised).not.toContain(SEED);
    expect(serialised).not.toContain('collapseAt');
    for (const key of Object.keys(captured.coins[0])) {
      expect(key).not.toMatch(/seed|future|anchor|duration|schedule/i);
    }
  });
});

describe('V2-1 simulation: metrics', () => {
  test('median/percentile behave on known inputs', () => {
    expect(median([1, 2, 3])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(percentile([10, 20, 30, 40, 50], 50)).toBe(30);
    expect(percentile([10, 20, 30, 40, 50], 90)).toBe(50);
    expect(percentile([10, 20, 30, 40, 50], 10)).toBe(10);
  });

  test('paired win rate counts strict wins with ties at 0.5', () => {
    const a = [{ finalCash: 2 }, { finalCash: 1 }, { finalCash: 3 }];
    const b = [{ finalCash: 1 }, { finalCash: 1 }, { finalCash: 4 }];
    // win, tie, loss -> (1 + 0.5) / 3 = 50%
    expect(pairedWinRate(a, b)).toBe(50);
  });

  test('strategy summary reports the required V2-1 metric set', () => {
    const results = [
      { roundIndex: 0, finalCash: 12000, roi: 20, profitable: true, trades: 10, timeInMarket: 0.5, maxDrawdown: 0.1 },
      { roundIndex: 1, finalCash: 8000, roi: -20, profitable: false, trades: 6, timeInMarket: 0.25, maxDrawdown: 0.4 }
    ];
    const summary = summarizeStrategy(results, 10000);
    expect(summary.meanFinalCash).toBe(10000);
    expect(summary.medianFinalCash).toBe(10000);
    expect(summary.profitableRoundPct).toBe(50);
    expect(summary.best.finalCash).toBe(12000);
    expect(summary.worst.finalCash).toBe(8000);
    expect(summary.meanTradesPerRound).toBe(8);
    expect(summary.meanTimeInMarket).toBe(0.375);
    expect(summary.worstMaxDrawdown).toBe(0.4);
    expect(summary.percentiles.p50).toBe(8000); // nearest-rank percentile
  });
});

describe('V2-1 simulation: batch reproducibility and pairing', () => {
  test('identical batch configuration produces an identical report', () => {
    const config = { rounds: 3, baseSeed: 'v2-sim-repro-test', economy: true };
    const first = buildReport(runBatch(config));
    const second = buildReport(runBatch(config));
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  test('round seeds derive deterministically and never repeat', () => {
    const seeds = new Set();
    for (let i = 0; i < 100; i++) seeds.add(deriveRoundSeed('base', i));
    expect(seeds.size).toBe(100);
    expect(deriveRoundSeed('base', 5)).toBe(deriveRoundSeed('base', 5));
  });

  test('a small paired batch shows the intended skill ordering (DIP_BOOM >> RANDOM)', () => {
    const batch = runBatch({ rounds: 5, baseSeed: 'v2-sim-skill-test' });
    const report = buildReport(batch);
    expect(report.paired.DIP_BOOM.RANDOM.winRatePct).toBeGreaterThanOrEqual(60);
    expect(report.strategies.DIP_BOOM.medianFinalCash).toBeGreaterThan(report.strategies.RANDOM.medianFinalCash);
    expect(report.strategies.PERFECT_INFORMATION.medianFinalCash).toBeGreaterThanOrEqual(report.strategies.DIP_BOOM.medianFinalCash);
    expect(report.strategies.HOLD_FOREVER.medianFinalCash).toBeLessThan(report.config.startingCash);
  });
});
