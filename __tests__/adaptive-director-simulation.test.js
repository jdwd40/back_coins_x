// Director Coin Events Wave 2: deterministic control-layer simulation
// checks (simulation/adaptiveDirectorSimulation.js).
//
// The harness runs a synthetic observation sequence — healthy movement,
// prolonged stagnation, a broad crash, recovery, overheating — through the
// pure adaptive Director domain and reports decision frequencies and
// durations, so hyperactivity/inertia can be reviewed without any price
// simulation. These checks pin:
//   * reproducibility: two runs produce identical reports;
//   * no hyperactivity/inertia: committed decisions stay within a bounded
//     band over an 8-hour synthetic run;
//   * RESCUE fires during the crash and BUST is suppressed there;
//   * the market returns to NORMAL after recovery;
//   * Golden/Demon stay zero-or-one, distinct and rotate deterministically;
//   * no Math.random anywhere in the harness.
//
// Pure tests: no database rows.

const fs = require('fs');
const path = require('path');
const {
  runAdaptiveDirectorSimulation,
  buildCanonicalScenario,
  runDeterministicAcceptance,
  ACCEPTANCE_PROFILE_IDS
} = require('../simulation/adaptiveDirectorSimulation');
const { resolveSimulationConfig } = require('../game/simulationConfig');

const CONFIG = resolveSimulationConfig();

describe('Wave 2 adaptive Director control-layer simulation', () => {
  test('the canonical scenario is reproducible and the harness uses no Math.random', () => {
    const source = fs.readFileSync(path.join(__dirname, '../simulation/adaptiveDirectorSimulation.js'), 'utf8');
    const executable = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    expect(executable).not.toMatch(/Math\.random|Date\.now|new Date\(\)/);

    const a = runAdaptiveDirectorSimulation({ scenario: buildCanonicalScenario(), config: CONFIG });
    const b = runAdaptiveDirectorSimulation({ scenario: buildCanonicalScenario(), config: CONFIG });
    expect(a).toEqual(b);
  });

  test('the canonical scenario walks every phase with bounded decision frequency', () => {
    const report = runAdaptiveDirectorSimulation({ scenario: buildCanonicalScenario(), config: CONFIG });
    // eslint-disable-next-line no-console
    console.log('adaptive Director simulation report:', JSON.stringify(report.summary, null, 1));

    // Every phase was exercised.
    expect(report.summary.modesSeen).toEqual(expect.arrayContaining(['NORMAL', 'RESCUE']));
    expect(report.summary.modesSeen).toEqual(expect.arrayContaining(['BOOM', 'BUST']));

    // Not hyperactive, not inert: over 8 synthetic hours the committed
    // decisions stay within a reviewable band. The dominant contributors
    // are the 8-14 minute NORMAL swing windows (~5.5/hour) and the
    // bounded 10-30 minute Golden/Demon rotations (~5/hour).
    expect(report.summary.totalDecisions).toBeGreaterThanOrEqual(8);
    expect(report.summary.totalDecisions).toBeLessThanOrEqual(110);
    expect(report.summary.decisionsPerHour).toBeLessThanOrEqual(15);

    // RESCUE during the crash, and no BUST overlapping the crash window.
    expect(report.summary.rescueCount).toBeGreaterThanOrEqual(1);
    const crash = report.decisions.filter((d) =>
      d.startedAtMs >= report.scenario.crashStartMs && d.startedAtMs < report.scenario.crashEndMs);
    expect(crash.length).toBeGreaterThanOrEqual(1);
    for (const decision of crash) {
      expect(decision.mode).toBe('RESCUE');
    }

    // Return to NORMAL after recovery.
    const afterRecovery = report.decisions.filter((d) => d.startedAtMs >= report.scenario.recoveryEndMs);
    expect(afterRecovery.some((d) => d.mode === 'NORMAL')).toBe(true);

    // Every committed duration obeys the configured bands.
    for (const decision of report.decisions) {
      const durationMs = decision.endsAtMs - decision.startedAtMs;
      expect(durationMs).toBeGreaterThan(0);
      if (decision.mode === 'NORMAL') {
        expect(durationMs).toBeGreaterThanOrEqual(CONFIG.directorControl.normalSwingTargetMs.min);
        expect(durationMs).toBeLessThanOrEqual(CONFIG.directorControl.normalSwingTargetMs.max);
      } else {
        expect(durationMs).toBeGreaterThanOrEqual(CONFIG.directorControl.interventionDurationMs.min);
        expect(durationMs).toBeLessThanOrEqual(CONFIG.directorControl.interventionDurationMs.max);
      }
      expect(decision.intensity).toBeGreaterThanOrEqual(0);
      expect(decision.intensity).toBeLessThanOrEqual(1);
    }

    // Golden/Demon invariants across the WHOLE run: never the same coin,
    // and both rotate at least once over 8 hours (role durations are
    // bounded at 30 minutes).
    expect(report.summary.goldenRotations).toBeGreaterThanOrEqual(1);
    expect(report.summary.demonRotations).toBeGreaterThanOrEqual(1);
    for (const decision of report.decisions) {
      if (decision.goldenCoinId !== null && decision.demonCoinId !== null) {
        expect(decision.goldenCoinId).not.toBe(decision.demonCoinId);
      }
    }

    // Durations by mode are reported for review.
    expect(report.summary.modeDurationsMs.NORMAL).toBeGreaterThan(0);
    expect(report.summary.modeDurationsMs.RESCUE).toBeGreaterThan(0);
  });
});

describe('Wave 2 adaptive Director: deterministic acceptance sweep (PR #36 correction)', () => {
  jest.setTimeout(120000);
  // 20 deterministic seeds x 24 simulated hours over the six condition
  // profiles. Assertions hold for EVERY seed (never tuned to one).
  const acceptance = runDeterministicAcceptance({ seeds: 20, config: CONFIG });
  const MAX_INTERVENTION_MINUTES = CONFIG.directorControl.interventionDurationMs.max / 60000;

  test('the sweep covers the six condition profiles over 20 seeds x 24 hours, reproducibly', () => {
    expect([...ACCEPTANCE_PROFILE_IDS].sort()).toEqual([
      'death-cluster', 'healthy-variable', 'mild-decline',
      'severe-decline', 'stagnation', 'sustained-overheat'
    ]);
    expect(Object.keys(acceptance.profiles).sort()).toEqual([...ACCEPTANCE_PROFILE_IDS].sort());
    for (const data of Object.values(acceptance.profiles)) {
      expect(data.seeds).toHaveLength(20);
      for (const run of data.seeds) expect(run.horizonHours).toBe(24);
    }
    expect(runDeterministicAcceptance({ seeds: 20, config: CONFIG })).toEqual(acceptance);
  });

  test('healthy/variable markets stay NORMAL all day with no rescue and no interventions', () => {
    for (const run of acceptance.profiles['healthy-variable'].seeds) {
      expect(run.modeTimeFraction.NORMAL).toBe(1);
      expect(run.rescueCount).toBe(0);
      expect(run.directInterventionTransitions).toBe(0);
      expect(run.longestInterventionStreakMinutes).toBe(0);
    }
  });

  test('persistent stagnation produces refractory-bounded swings with NORMAL opportunities on every seed', () => {
    for (const run of acceptance.profiles.stagnation.seeds) {
      // No direct intervention->intervention transition without NORMAL.
      expect(run.directInterventionTransitions).toBe(0);
      // Bounded duty cycle: swings recur (continued conditions retrigger)
      // but never dominate.
      const interventionFraction = run.modeTimeFraction.BOOM + run.modeTimeFraction.BUST;
      expect(interventionFraction).toBeGreaterThan(0);
      expect(interventionFraction).toBeLessThanOrEqual(0.35);
      expect(run.modeTimeFraction.NORMAL).toBeGreaterThanOrEqual(0.65);
      // No intervention streak exceeds one bounded window; every gap is a
      // genuine NORMAL run of at least the refractory span.
      expect(run.longestInterventionStreakMinutes).toBeLessThanOrEqual(MAX_INTERVENTION_MINUTES);
      expect(run.averageNormalRunLengthMinutes).toBeGreaterThanOrEqual(
        CONFIG.directorControl.interventionRefractoryMs / 60000
      );
    }
  });

  test('mild decline never rescues on any seed (falling breadth alone is not a rescue)', () => {
    for (const run of acceptance.profiles['mild-decline'].seeds) {
      expect(run.rescueCount).toBe(0);
      expect(run.modeTimeFraction.RESCUE).toBe(0);
      expect(run.directInterventionTransitions).toBe(0);
    }
  });

  test('severe decline holds the emergency RESCUE while the emergency persists, in bounded windows', () => {
    for (const run of acceptance.profiles['severe-decline'].seeds) {
      expect(run.rescueCount).toBeGreaterThan(0);
      expect(run.modeTimeFraction.RESCUE).toBeGreaterThanOrEqual(0.9);
      // Every emergency recommit is still one bounded window.
      expect(run.averageInterventionDurationMinutes).toBeLessThanOrEqual(MAX_INTERVENTION_MINUTES);
      expect(run.averageInterventionDurationMinutes).toBeGreaterThanOrEqual(
        CONFIG.directorControl.interventionDurationMs.min / 60000
      );
    }
  });

  test('sustained overheat produces refractory-bounded BUST corrections, never a chain', () => {
    for (const run of acceptance.profiles['sustained-overheat'].seeds) {
      expect(run.directInterventionTransitions).toBe(0);
      expect(run.modeCounts.BUST).toBeGreaterThan(0);
      expect(run.modeTimeFraction.BUST).toBeGreaterThan(0);
      expect(run.modeTimeFraction.BUST).toBeLessThanOrEqual(0.35);
      expect(run.modeTimeFraction.NORMAL).toBeGreaterThanOrEqual(0.65);
      expect(run.longestInterventionStreakMinutes).toBeLessThanOrEqual(MAX_INTERVENTION_MINUTES);
    }
  });

  test('a death cluster drives bounded emergency RESCUE only while the emergency persists', () => {
    for (const run of acceptance.profiles['death-cluster'].seeds) {
      expect(run.rescueCount).toBeGreaterThan(0);
      // The cluster spans hours 4-8 of 24: RESCUE is confined to it.
      expect(run.modeTimeFraction.RESCUE).toBeLessThanOrEqual(0.3);
      expect(run.modeTimeFraction.NORMAL).toBeGreaterThanOrEqual(0.7);
      // The longest continuous RESCUE streak is bounded by the cluster
      // span plus one bounded window's tail.
      expect(run.longestRescueStreakMinutes).toBeLessThanOrEqual(4 * 60 + MAX_INTERVENTION_MINUTES);
    }
  });

  test('the aggregate review metrics are reported for controller review', () => {
    const printable = {};
    for (const [profile, data] of Object.entries(acceptance.profiles)) {
      printable[profile] = { aggregate: data.aggregate, modeTimeFraction: data.modeTimeFraction };
    }
    // eslint-disable-next-line no-console
    console.log('adaptive Director acceptance (20 seeds x 24h):', JSON.stringify(printable));
    for (const data of Object.values(acceptance.profiles)) {
      for (const key of [
        'decisionsPerHour', 'rescueCount', 'directInterventionTransitions',
        'longestInterventionStreakMinutes', 'longestRescueStreakMinutes',
        'averageNormalRunLengthMinutes', 'averageInterventionDurationMinutes',
        'goldenRotationsPerHour', 'demonRotationsPerHour'
      ]) {
        expect(data.aggregate[key]).toHaveProperty('min');
        expect(data.aggregate[key]).toHaveProperty('max');
        expect(data.aggregate[key]).toHaveProperty('mean');
      }
      // Roles keep rotating on every profile.
      expect(data.aggregate.goldenRotationsPerHour.max).toBeGreaterThan(0);
      expect(data.aggregate.demonRotationsPerHour.max).toBeGreaterThan(0);
    }
  });
});
