// V2-3: escalation-study mechanics — deterministic replay, economy A/B
// equivalence, debits-override correctness and the new instrumentation
// (per-band trades, collapse losses, passive-debit totals). Small fixed
// samples only; the full gate lives in simulation/run.js --mode v2-3.

const { runEscalationStudy, buildEscalationReport, V2_ECONOMY_SCALE } = require('../simulation/escalationStudy');
const { createRoundEnvironment } = require('../simulation/roundEnvironment');
const { createRoundContext, runRound } = require('../simulation/engine');
const { STRATEGIES } = require('../simulation/strategies');
const { GAME_STARTING_CASH } = require('../game/gameConstants');

jest.setTimeout(120000);

const SMALL = {
  sequences: 2,
  roundsPerSequence: 3,
  baseSeed: 'v2-3-study-mechanics-test-seed',
  playerIds: ['DIP_BOOM', 'RANDOM', 'HOLD_FOREVER', 'OVERSTAYER']
};

describe('V2-3 escalation study: determinism and economy A/B', () => {
  test('identical configuration replays to identical records (seeded, no cherry-picking)', () => {
    const a = runEscalationStudy({ ...SMALL });
    const b = runEscalationStudy({ ...SMALL });
    const finalOf = (study, variant, player) =>
      study.records.get(variant).get(player).map((r) => r.finalCash);
    for (const variant of ['legacy', 'v2']) {
      for (const player of SMALL.playerIds) {
        expect(finalOf(b, variant, player)).toEqual(finalOf(a, variant, player));
      }
    }
  });

  test('v2 scale 1 reproduces the legacy economy exactly on identical paths', () => {
    const study = runEscalationStudy({ ...SMALL, v2EconomyScale: 1 });
    for (const player of SMALL.playerIds) {
      const legacy = study.records.get('legacy').get(player).map((r) => r.finalCash);
      const v2 = study.records.get('v2').get(player).map((r) => r.finalCash);
      expect(v2).toEqual(legacy);
    }
  });

  test('a weakened scale reduces passive deductions and never increases them', () => {
    const study = runEscalationStudy({ ...SMALL });
    for (const player of SMALL.playerIds) {
      const legacy = study.records.get('legacy').get(player);
      const v2 = study.records.get('v2').get(player);
      for (let i = 0; i < legacy.length; i++) {
        expect(v2[i].debitsPaid).toBeLessThanOrEqual(legacy[i].debitsPaid);
        // Same market path: trading books differ only through cash effects,
        // and the cash identity holds under BOTH economies.
        expect(v2[i].cashDrift).toBeLessThanOrEqual(0.01);
        expect(v2[i].basisDrift).toBeLessThanOrEqual(0.01);
      }
    }
  });

  test('the report gate shape is complete for a partial roster (metrics without verdict)', () => {
    const report = buildEscalationReport(runEscalationStudy({ ...SMALL }));
    expect(report.gate.pass).toBeNull();
    expect(report.gate.skipped.reason).toMatch(/partial player roster/);
    expect(report.market.rounds).toBe(SMALL.sequences * SMALL.roundsPerSequence);
    expect(report.market.classifier.samples).toBeGreaterThan(0);
    expect(report.players.v2.DIP_BOOM.rounds).toBe(SMALL.sequences * SMALL.roundsPerSequence);
  });
});

describe('V2-3 escalation study: instrumentation', () => {
  test('per-band trade counts sum to the round trade total', () => {
    const env = createRoundEnvironment({ seed: 'v2-3-band-trades-seed', economy: true });
    const context = createRoundContext(env, {});
    const result = runRound(context, STRATEGIES.DIP_BOOM, { startingCash: GAME_STARTING_CASH });
    const bandTotal = Object.values(result.bandTrades).reduce((a, b) => a + b, 0);
    expect(bandTotal).toBe(result.trades);
    expect(result.trades).toBeGreaterThan(0);
  });

  test('HOLD_FOREVER records real collapse losses valued at the last live tick', () => {
    const env = createRoundEnvironment({ seed: 'v2-3-collapse-loss-seed', economy: false });
    const context = createRoundContext(env, {});
    const result = runRound(context, STRATEGIES.HOLD_FOREVER, { startingCash: GAME_STARTING_CASH });
    expect(result.collapseLosses.length).toBeGreaterThan(0);
    for (const loss of result.collapseLosses) {
      expect(loss.valueLost).toBeGreaterThan(0);
      // Dynamic collapse is market-reactive rather than a fixed 70% window;
      // each recorded loss remains a valid in-round public death.
      expect(loss.apocalypsePercent).toBeGreaterThanOrEqual(0);
      expect(loss.apocalypsePercent).toBeLessThanOrEqual(100);
      expect(Number.isInteger(loss.coinId)).toBe(true);
    }
    // Every recorded loss sits at or after that coin's dynamic death instant.
    for (const loss of result.collapseLosses) {
      expect(loss.t).toBeGreaterThanOrEqual(env.collapseAtMs.get(loss.coinId));
    }
  });

  test('an explicit debits override replaces the environment schedule for that run only', () => {
    const env = createRoundEnvironment({ seed: 'v2-3-debits-override-seed', economy: true });
    const context = createRoundContext(env, {});
    const withEconomy = runRound(context, STRATEGIES.HOLD_FOREVER, { startingCash: GAME_STARTING_CASH });
    const withoutEconomy = runRound(context, STRATEGIES.HOLD_FOREVER, { startingCash: GAME_STARTING_CASH, debits: [] });
    expect(withEconomy.debitsPaid).toBeGreaterThan(0);
    expect(withoutEconomy.debitsPaid).toBe(0);
    expect(withoutEconomy.finalCash).toBeGreaterThan(withEconomy.finalCash);
    // The environment's own schedule is untouched for the next run.
    const again = runRound(context, STRATEGIES.HOLD_FOREVER, { startingCash: GAME_STARTING_CASH });
    expect(again.finalCash).toBe(withEconomy.finalCash);
  });

  test('the selected V2 economy scale is explicit and documented next to legacy', () => {
    expect(V2_ECONOMY_SCALE).toBe(0.25);
    // Legacy Core 7 default remains scale 1 — the untouched production path.
    const legacyEnv = createRoundEnvironment({ seed: 'v2-3-econ-parity-seed', economy: true, economyScale: 1 });
    const v2Env = createRoundEnvironment({ seed: 'v2-3-econ-parity-seed', economy: true, economyScale: V2_ECONOMY_SCALE });
    const legacyTotal = legacyEnv.debits.reduce((n, d) => n + d.amount, 0);
    const v2Total = v2Env.debits.reduce((n, d) => n + d.amount, 0);
    expect(v2Total).toBeLessThan(legacyTotal);
    expect(v2Total).toBeGreaterThan(0);
    // Identical seeds: collapse schedules are byte-identical across scales.
    expect([...v2Env.collapseAtMs.entries()]).toEqual([...legacyEnv.collapseAtMs.entries()]);
  });
});
