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
  buildCanonicalScenario
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
