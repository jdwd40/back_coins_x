// SIM-18/19 (gameplay_build_plan.md Stage 13): multi-cycle harness tests —
// deterministic replay, complete per-cycle/per-coin metric capture, exact
// final £0 safety, quality failure flags, cross-seed variation and the
// CLI/report shape. Pure and fast: smoke batches of 2-12 cycles only; the
// real validation run is the CLI (hundreds of cycles).

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  runMultiCycle,
  buildMultiCycleReport,
  evaluateFlags,
  captureMarketCycle,
  capturePressureCycle,
  deriveCycleSeed,
  discordantPairs,
  DEFAULT_THRESHOLDS,
  SCENARIO_IDS,
  PRESSURE_STRATEGY_IDS,
  MULTI_CYCLE_BASE_SEED
} = require('../simulation/multiCycle');
const { createRoundEnvironment } = require('../simulation/roundEnvironment');
const { createRoundContext, runRound } = require('../simulation/engine');
const { STRATEGIES } = require('../simulation/strategies');
const { resolveSimulationConfig } = require('../game/simulationConfig');

jest.setTimeout(180000);

const TEST_BASE_SEED = 'sim18-test-base-seed';
const EXPECTED_FLAG_IDS = [
  'prematureMassCollapse',
  'noMeaningfulRally',
  'lateCrashFullRecovery',
  'identicalCoinPaths',
  'unboundedCoinGrowth',
  'positiveEventsOverwhelming',
  'negativeEventsKillEarlyGrowth',
  'identicalCollapseOrderAcrossSeeds',
  'nonzeroFinalMarketValue',
  'deterministicReplayMismatch',
  'noPhaseEventVariety',
  'latePeakInstantDeath'
];

function runSmoke(overrides = {}) {
  return runMultiCycle({
    cycles: 6,
    baseSeed: TEST_BASE_SEED,
    scenarios: ['market'],
    replayCycles: 3,
    ...overrides
  });
}

describe('SIM-18 multi-cycle harness: complete per-cycle metric capture', () => {
  test('every cycle record carries the full Stage 13 market shape', () => {
    const run = runSmoke();
    expect(run.cycles).toHaveLength(6);
    for (const record of run.cycles) {
      expect(typeof record.cycleIndex).toBe('number');
      expect(typeof record.seed).toBe('string');
      const m = record.market;
      for (const key of [
        'startingIndex', 'peakIndex', 'peakAtMs', 'peakPositionPct',
        'finalMeasuredIndex', 'finalMarketValue', 'survivorCount',
        'crashCount', 'rallyCount', 'largestCrashPct', 'largestRallyPct',
        'lateCrashCount', 'lateCrashFullRecoveryCount',
        'firstPlateauAtMs', 'firstDeclineAtMs',
        'collapseOrder', 'firstCollapseAtMs', 'finalCollapseAtMs',
        'finalNaturalCollapseAtMs', 'collapseSpreadMs', 'forcedSafetyCoinIds',
        'eventCount', 'positiveEventCount', 'negativeEventCount',
        'positiveEventTotal', 'negativeEventTotal',
        'phaseIds', 'eventNames', 'pathDivergence', 'peakGrowthMultiple'
      ]) {
        expect(m).toHaveProperty(key);
      }
      // The index rises then dies: peak must sit at or above the start.
      expect(m.peakIndex).toBeGreaterThanOrEqual(m.startingIndex);
      expect(m.collapseOrder).toHaveLength(record.coins.length);
    }
  });

  test('every coin record carries starting/peak/min prices, events and collapse time', () => {
    const run = runSmoke();
    for (const record of run.cycles) {
      expect(record.coins.length).toBeGreaterThan(0);
      for (const coin of record.coins) {
        for (const key of [
          'coinId', 'symbol', 'startingPrice', 'peakPrice',
          'minPricePreCollapse', 'eventCount', 'positiveEventCount',
          'negativeEventCount', 'positiveEventTotal', 'negativeEventTotal',
          'collapseAtMs'
        ]) {
          expect(coin).toHaveProperty(key);
        }
        expect(coin.peakPrice).toBeGreaterThanOrEqual(coin.minPricePreCollapse);
        // collapseAtMs is the natural instant or explicitly null when the
        // final safety rule had to force this coin's collapse.
        if (coin.collapseAtMs === null) {
          expect(record.market.forcedSafetyCoinIds).toContain(coin.coinId);
        } else {
          expect(record.market.forcedSafetyCoinIds).not.toContain(coin.coinId);
          expect(coin.collapseAtMs).toBeLessThanOrEqual(run.config.roundDurationMs);
        }
      }
    }
  });

  test('the pressure scenario adds tape, pressure and per-strategy bot metrics', () => {
    const seed = deriveCycleSeed(TEST_BASE_SEED, 0);
    const config = resolveSimulationConfig();
    const marketRecord = captureMarketCycle({
      seed, cycleIndex: 0, economy: true, config, thresholds: DEFAULT_THRESHOLDS
    });
    const pressure = capturePressureCycle({
      seed, economy: true, observationMs: 15000, startingCash: 10000, marketRecord
    });
    expect(pressure.tapeEntries).toBeGreaterThan(0);
    expect(pressure.buyNotional).toBeGreaterThan(0);
    expect(typeof pressure.meanAbsPressureModifier).toBe('number');
    expect(typeof pressure.maxAbsPressureModifier).toBe('number');
    expect(typeof pressure.priceDivergencePct).toBe('number');
    expect(typeof pressure.collapseOrderShift).toBe('number');
    for (const id of PRESSURE_STRATEGY_IDS) {
      const p = pressure.players[id];
      expect(p).toBeDefined();
      for (const key of ['finalCash', 'roi', 'profitable', 'trades', 'executedBuys', 'executedSells']) {
        expect(p).toHaveProperty(key);
      }
    }
  });
});

describe('SIM-18 multi-cycle harness: exact final £0 survivor assertion', () => {
  test('every cycle ends with final market value exactly £0 and zero survivors', () => {
    const run = runSmoke({ cycles: 12 });
    for (const record of run.cycles) {
      expect(record.market.finalMarketValue).toBe(0);
      expect(record.market.survivorCount).toBe(0);
      // Dead coins price at exactly £0 at round end in the same environment.
      const env = createRoundEnvironment({ seed: record.seed, economy: true });
      for (const coin of env.coins) {
        expect(env.isDead(coin.coinId, env.durationMs)).toBe(true);
        expect(env.priceAt(coin.coinId, env.durationMs)).toBe(0);
      }
    }
    const report = buildMultiCycleReport(run);
    expect(report.flags.nonzeroFinalMarketValue.pass).toBe(true);
  });
});

describe('SIM-18 multi-cycle harness: deterministic replay', () => {
  test('two identical runs produce byte-identical reports', () => {
    const first = buildMultiCycleReport(runSmoke());
    const second = buildMultiCycleReport(runSmoke());
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  test('the built-in replay check re-captures cycles byte-identically', () => {
    const run = runSmoke({ replayCycles: 6 });
    expect(run.replay.cyclesChecked).toBe(6);
    expect(run.replay.mismatches).toEqual([]);
    const report = buildMultiCycleReport(run);
    expect(report.flags.deterministicReplayMismatch.pass).toBe(true);
  });

  test('engine recordTrades tape is deterministic and counts executed trades only', () => {
    const context = createRoundContext(createRoundEnvironment({ seed: deriveCycleSeed(TEST_BASE_SEED, 0) }));
    const a = runRound(context, STRATEGIES.DIP_BOOM, { recordTrades: true });
    const b = runRound(context, STRATEGIES.DIP_BOOM, { recordTrades: true });
    expect(a.executedTape).toEqual(b.executedTape);
    expect(a.executedTape.length).toBe(a.executedBuys + a.executedSells);
    expect(a.executedTape.length).toBeGreaterThan(0);
    for (const entry of a.executedTape) {
      expect(['BUY', 'SELL']).toContain(entry.type);
      expect(entry.notional).toBeGreaterThan(0);
      expect(entry.atMs).toBeGreaterThanOrEqual(0);
    }
    const off = runRound(context, STRATEGIES.DIP_BOOM);
    expect(off.executedTape).toEqual([]);
  });
});

describe('SIM-18 multi-cycle harness: variation across seeds', () => {
  test('different base seeds produce different cycles; collapse order varies within a run', () => {
    const runA = runSmoke({ baseSeed: 'sim18-variation-a' });
    const runB = runSmoke({ baseSeed: 'sim18-variation-b' });
    expect(JSON.stringify(runA.cycles)).not.toBe(JSON.stringify(runB.cycles));

    // Within one run, not every cycle shares one collapse order or one path.
    const orders = new Set(runA.cycles.map((r) => r.market.collapseOrder.join(',')));
    expect(orders.size).toBeGreaterThan(1);
    const divergences = runA.cycles.map((r) => r.market.pathDivergence);
    expect(Math.max(...divergences)).toBeGreaterThan(0);
    expect(deriveCycleSeed('x', 0)).not.toBe(deriveCycleSeed('x', 1));
  });

  test('discordantPairs scores order shifts (0 = identical)', () => {
    expect(discordantPairs([1, 2, 3], [1, 2, 3])).toBe(0);
    expect(discordantPairs([1, 2, 3], [3, 2, 1])).toBe(3);
    expect(discordantPairs([1, 2, 3], [1, 3, 2])).toBe(1);
  });
});

describe('SIM-19 quality failure flags', () => {
  // A fully passing aggregate baseline (matches evaluateFlags' contract);
  // each test breaks exactly one measured value and expects exactly that
  // flag (and the verdict) to fail.
  const passingAggregates = () => ({
    totalCycles: 20,
    prematureCollapseCycles: 0,
    noRallyCycles: 1,
    identicalPathCycles: 0,
    earlyDeclineCycles: 2,
    latePeakCycles: 0,
    nonzeroFinalValueCycles: 0,
    zeroEventCycles: 0,
    lateCrashes: 10,
    lateCrashFullRecoveries: 5,
    positiveEventTotal: 1.5,
    negativeEventTotal: -3,
    maxPeakGrowthMultiple: 6,
    identicalCollapseOrderPairPct: 1,
    distinctPhaseIds: ['P1', 'P2', 'P3', 'P4', 'P5', 'P6'],
    distinctEventNames: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
    replayMismatches: 0,
    replayCyclesChecked: 5
  });

  test('the baseline passes every flag and the verdict', () => {
    const { flags, verdict } = evaluateFlags(passingAggregates(), DEFAULT_THRESHOLDS);
    expect(Object.keys(flags).sort()).toEqual(EXPECTED_FLAG_IDS.slice().sort());
    for (const flag of Object.values(flags)) {
      expect(flag.pass).toBe(true);
      expect(flag.measured).toBeDefined();
      expect(typeof flag.threshold).toBe('string');
    }
    expect(verdict.pass).toBe(true);
  });

  const breakingCases = [
    ['prematureMassCollapse', { prematureCollapseCycles: 5 }],
    ['noMeaningfulRally', { noRallyCycles: 10 }],
    ['lateCrashFullRecovery', { lateCrashes: 10, lateCrashFullRecoveries: 10 }],
    ['identicalCoinPaths', { identicalPathCycles: 2 }],
    ['unboundedCoinGrowth', { maxPeakGrowthMultiple: 500 }],
    ['positiveEventsOverwhelming', { positiveEventTotal: 4 }],
    ['negativeEventsKillEarlyGrowth', { earlyDeclineCycles: 10 }],
    ['identicalCollapseOrderAcrossSeeds', { identicalCollapseOrderPairPct: 50 }],
    ['nonzeroFinalMarketValue', { nonzeroFinalValueCycles: 1 }],
    ['deterministicReplayMismatch', { replayMismatches: 2 }],
    ['noPhaseEventVariety', { distinctEventNames: ['only-one'] }],
    ['latePeakInstantDeath', { latePeakCycles: 5 }]
  ];
  test.each(breakingCases)('%s fails when its measured value breaks', (flagId, patch) => {
    const aggregates = { ...passingAggregates(), ...patch };
    const { flags, verdict } = evaluateFlags(aggregates, DEFAULT_THRESHOLDS);
    expect(flags[flagId].pass).toBe(false);
    expect(verdict.pass).toBe(false);
  });

  test('a real smoke run reports all flags with an explicit verdict', () => {
    const report = buildMultiCycleReport(runSmoke());
    expect(Object.keys(report.flags).sort()).toEqual(EXPECTED_FLAG_IDS.slice().sort());
    // The verdict is a real aggregate judgement: small smoke samples can
    // legitimately fail balance thresholds (that is the harness working,
    // not a broken test), so we assert the verdict is explicit and matches
    // the flags rather than forcing a pass.
    expect(typeof report.verdict.pass).toBe('boolean');
    expect(report.verdict.pass).toBe(Object.values(report.flags).every((f) => f.pass));
    expect(report.thresholds).toEqual(DEFAULT_THRESHOLDS);
  });
});

describe('SIM-18 multi-cycle harness: CLI and report shape', () => {
  test('input validation rejects bad cycle/observation/scenario values', () => {
    expect(() => runMultiCycle({ cycles: 0 })).toThrow(/cycles must be a positive integer/);
    expect(() => runMultiCycle({ cycles: 2, observationMs: -1 })).toThrow(/observationMs/);
    expect(() => runMultiCycle({ cycles: 2, scenarios: [] })).toThrow(/scenarios/);
    expect(() => runMultiCycle({ cycles: 2, scenarios: ['nope'] })).toThrow(/unknown multi-cycle scenario/);
    expect(() => runMultiCycle({ cycles: 2, replayCycles: 99 })).toThrow(/replayCycles/);
  });

  test('the CLI writes a deterministic JSON report and a separate runtime field', () => {
    const outPath = path.join(os.tmpdir(), 'multi-cycle-cli-test.json');
    // Exit code carries the verdict (0 pass / 1 fail) — capture stdout either
    // way; the smoke verdict is an aggregate judgement, not a test fixture.
    const cli = () => {
      const result = spawnSync(
        process.execPath,
        [
          path.join(__dirname, '..', 'simulation', 'run.js'),
          '--mode', 'multi-cycle', '--cycles', '3', '--scenarios', 'market',
          '--base-seed', 'sim18-cli-test', '--out', outPath, '--json'
        ],
        { encoding: 'utf8' }
      );
      expect(result.error).toBeUndefined();
      expect([0, 1]).toContain(result.status);
      // Under NODE_ENV=test (inherited from jest) the app's db config logs a
      // connection line before the payload; the JSON report starts at the
      // first '{'.
      const stdout = result.stdout.slice(result.stdout.indexOf('{'));
      return { report: JSON.parse(stdout), status: result.status };
    };
    const firstRun = cli();
    const first = firstRun.report;
    const second = cli().report;

    expect(first.mode).toBe('multi-cycle');
    expect(first.config.cycles).toBe(3);
    expect(first.config.baseSeed).toBe('sim18-cli-test');
    expect(first.config.scenarios).toContain('market');
    expect(first.scenarios.pressure).toBeNull(); // not selected
    expect(first.cycles).toHaveLength(3);
    expect(typeof first.verdict.pass).toBe('boolean');
    expect(firstRun.status).toBe(first.verdict.pass ? 0 : 1);
    expect(typeof first.runtimeMs).toBe('number'); // explicitly separate

    // Deterministic report fields are byte-identical; only runtimeMs moves.
    delete first.runtimeMs;
    delete second.runtimeMs;
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));

    // The written report file matches the stdout payload shape.
    const written = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    expect(written.mode).toBe('multi-cycle');
    expect(written.config.cycles).toBe(3);
    expect(Object.keys(written.flags).sort()).toEqual(EXPECTED_FLAG_IDS.slice().sort());
    fs.unlinkSync(outPath);
  });

  test('scenario ids and defaults are exported and stable', () => {
    expect(SCENARIO_IDS).toEqual(['market', 'pressure', 'events']);
    expect(PRESSURE_STRATEGY_IDS).toEqual(['DIP_BOOM', 'RANDOM', 'SPAM']);
    expect(typeof MULTI_CYCLE_BASE_SEED).toBe('string');
  });
});
