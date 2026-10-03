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
  buildAcceptanceScenario,
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

    // RESCUE fires promptly at the crash onset (the severe-drawdown
    // emergency interrupts the active window immediately), and no BUST is
    // committed inside the crash window. Bounded emergency correction: an
    // ended emergency window yields a NORMAL refractory opportunity even
    // while the crash persists, so later decisions starting inside the
    // crash window MAY be NORMAL refractory windows — never BUST.
    expect(report.summary.rescueCount).toBeGreaterThanOrEqual(1);
    const crashOnset = report.decisions.filter((d) =>
      d.startedAtMs >= report.scenario.crashStartMs && d.startedAtMs < report.scenario.crashStartMs + 2 * 60000);
    expect(crashOnset.length).toBeGreaterThanOrEqual(1);
    expect(crashOnset[0].mode).toBe('RESCUE');
    const crash = report.decisions.filter((d) =>
      d.startedAtMs >= report.scenario.crashStartMs && d.startedAtMs < report.scenario.crashEndMs);
    expect(crash.length).toBeGreaterThanOrEqual(1);
    for (const decision of crash) {
      expect(decision.mode).not.toBe('BUST');
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

  test('the sweep covers the condition profiles over 20 seeds x 24 hours, reproducibly', () => {
    expect([...ACCEPTANCE_PROFILE_IDS].sort()).toEqual([
      'death-cluster', 'healthy-variable', 'mild-decline', 'mild-decline-moving',
      'severe-decline', 'stagnation', 'stale-drawdown-churn', 'sustained-overheat'
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
      // The stagnant mild decline legitimately draws bounded refractory-
      // separated stagnation swings — but they never dominate the day.
      const interventionFraction = run.modeTimeFraction.BOOM + run.modeTimeFraction.BUST;
      expect(interventionFraction).toBeLessThanOrEqual(0.35);
      expect(run.modeTimeFraction.NORMAL).toBeGreaterThanOrEqual(0.65);
      expect(run.longestInterventionStreakMinutes).toBeLessThanOrEqual(MAX_INTERVENTION_MINUTES);
    }
  });

  test('a mild MOVING decline is predominantly NORMAL with zero rescue and bounded intervention frequency on every seed', () => {
    // PR #36 wave-2 acceptance: a mild decline with ONGOING meaningful
    // movement (the stagnation clock stays fresh) is not stagnation: no
    // rescue, no interventions at all, NORMAL all day, and the decision
    // cadence stays inside the reviewable band.
    for (const run of acceptance.profiles['mild-decline-moving'].seeds) {
      expect(run.rescueCount).toBe(0);
      expect(run.modeTimeFraction.RESCUE).toBe(0);
      expect(run.modeTimeFraction.BOOM).toBe(0);
      expect(run.modeTimeFraction.BUST).toBe(0);
      expect(run.modeTimeFraction.NORMAL).toBe(1);
      expect(run.directInterventionTransitions).toBe(0);
      expect(run.longestInterventionStreakMinutes).toBe(0);
      expect(run.decisionsPerHour).toBeLessThanOrEqual(15);
    }
  });

  test('the mild moving-decline profile is not passing on a null/stale movement clock', () => {
    // Distinct acceptance check: the profile's fabricated observations must
    // carry a FRESH lastMeaningfulMovementAt at every sampled tick, so the
    // predominantly-NORMAL verdict above cannot be an artifact of a frozen
    // (or null) stagnation clock.
    const scenario = buildAcceptanceScenario('mild-decline-moving', 0);
    for (const tickIndex of [0, 60, 360, 720, 1080, 1439]) {
      const nowMs = scenario.startMs + tickIndex * scenario.tickMs;
      const observation = scenario.observationAt(tickIndex, nowMs);
      expect(observation.lastMeaningfulMovementAtMs).not.toBeNull();
      expect(nowMs - observation.lastMeaningfulMovementAtMs).toBeLessThanOrEqual(5 * 60000);
      // The drift itself is the mild decline: 7/10 coins falling below the
      // rescue corroboration magnitude.
      expect(observation.breadth.falling).toBe(7);
      expect(observation.liveCoinCount).toBe(10);
    }
  });

  test('a STALE severe drawdown with fresh mixed movement never rescues on any seed (production churn pathology)', () => {
    // Long-term-balancing acceptance: the profile reproduces the exact
    // 2026-10-03T14:16:21Z production observation (persistent 0.5744
    // drawdown from decaying peaks, mixed fresh movement, one weak coin,
    // no deaths). Production rescued ~55x/day at ~0.95 intensity for 23
    // straight days on this state. A drawdown left over from earlier peaks
    // is NOT an emergency while the market is not broadly declining, so
    // rescue must not fire at all; the Director stays on its normal
    // broad-swing cadence all day.
    for (const run of acceptance.profiles['stale-drawdown-churn'].seeds) {
      expect(run.rescueCount).toBe(0);
      expect(run.modeTimeFraction.RESCUE).toBe(0);
      expect(run.modeTimeFraction.NORMAL).toBe(1);
      expect(run.directInterventionTransitions).toBe(0);
      expect(run.longestInterventionStreakMinutes).toBe(0);
      // Not inert either: the normal swing/role cadence continues.
      expect(run.decisionsPerHour).toBeGreaterThan(0);
      expect(run.decisionsPerHour).toBeLessThanOrEqual(15);
    }
  });

  test('the stale-drawdown-churn profile carries the production observation (not a passing artifact)', () => {
    // Distinct acceptance check: the fabricated observations must keep the
    // SEVERE stale drawdown (>= rescueDrawdownPct), a FRESH movement clock
    // and non-corroborating movement at every sampled tick, so the
    // zero-rescue verdict above measures the trigger semantics rather than
    // a stale clock or a vanished drawdown.
    const dc = CONFIG.directorControl;
    const scenario = buildAcceptanceScenario('stale-drawdown-churn', 0);
    for (const tickIndex of [0, 60, 360, 720, 1080, 1439]) {
      const nowMs = scenario.startMs + tickIndex * scenario.tickMs;
      const observation = scenario.observationAt(tickIndex, nowMs);
      expect(observation.drawdownPct).toBeGreaterThanOrEqual(dc.rescueDrawdownPct);
      expect(observation.lastMeaningfulMovementAtMs).not.toBeNull();
      expect(nowMs - observation.lastMeaningfulMovementAtMs).toBeLessThanOrEqual(5 * 60000);
      expect(observation.medianMovementPct).toBeGreaterThan(-dc.rescueCorroborationDeclinePct);
      expect(observation.broadMovementPct).toBeGreaterThan(-dc.rescueCorroborationDeclinePct);
      expect(observation.recentDeathCount).toBe(0);
      expect(observation.weakCount).toBeLessThan(dc.rescueWeakCount);
      expect(observation.distressedCount).toBeLessThan(dc.deathClusterCount);
      expect(observation.liveCoinCount).toBe(10);
    }
  });

  test('a severe drawdown rescues when a broad decline STARTS and disengages when the decline HALTS', () => {
    // Boundary acceptance: the same persistent 0.5 drawdown all day.
    // Hours 0-12: fresh mixed movement (stale drawdown only) — no rescue.
    // Hours 12-16: broad decline at -4% (an emergency in progress) —
    // rescue fires promptly and recurs within its bounded duty.
    // Hours 16-24: the decline halts (mixed movement returns) with the
    // drawdown unchanged — no NEW rescue window commits after the halt;
    // the Director is not a peg for old peaks.
    const startMs = Date.parse('2026-10-02T00:00:00.000Z');
    const tickMs = 60000;
    const ticks = 24 * 60;
    const observationAt = (tickIndex, nowMs) => {
      const hour = tickIndex / 60;
      const declining = hour >= 12 && hour < 16;
      const movementOf = (coinId) => (declining
        ? (coinId <= 8 ? -0.04 : 0.002)
        : (coinId % 2 === 0 ? 0.012 : -0.009));
      const coins = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((coinId) => ({
        coinId,
        archetype: 'ZIP',
        condition: -0.1,
        currentPrice: 1,
        peakReference: 2,
        structuralReference: 1,
        movementPct: movementOf(coinId)
      }));
      const breadth = { rising: 0, falling: 0, flat: 0 };
      for (const coin of coins) {
        if (Math.abs(coin.movementPct) < 0.005) breadth.flat += 1;
        else if (coin.movementPct > 0) breadth.rising += 1;
        else breadth.falling += 1;
      }
      const movements = coins.map((c) => c.movementPct).sort((a, b) => a - b);
      return {
        liveCoinCount: coins.length,
        coins,
        breadth,
        medianMovementPct: movements[Math.floor(movements.length / 2)],
        broadMovementPct: movements.reduce((s, v) => s + v, 0) / movements.length,
        drawdownPct: 0.5,
        weakCount: 1,
        distressedCount: 0,
        recentDeathCount: 0,
        recentDeaths: [],
        recentReplacements: [],
        lastMeaningfulMovementAtMs: nowMs - 2 * 60000,
        macro: {
          regime: 'BULL', regimeIndex: 3, intensity: 0.5,
          environment: {
            structuralBias: 0.02, volatilityScale: 1, positiveEventBias: 0,
            negativeEventBias: 0, eventSeverityScale: 1,
            crashProbabilityModifier: 1, recoveryModifier: 1, collapseRiskModifier: 1
          }
        }
      };
    };
    for (let seedIndex = 0; seedIndex < 20; seedIndex++) {
      const report = runAdaptiveDirectorSimulation({
        scenario: { worldSeed: `ltb-boundary:${seedIndex}`, startMs, tickMs, ticks, observationAt },
        config: CONFIG
      });
      const rescueWindows = report.decisions.filter((d, i, all) =>
        d.mode === 'RESCUE' && (i === 0 || all[i - 1].startedAtMs !== d.startedAtMs));
      const declineStartMs = startMs + 12 * 3600000;
      const haltMs = startMs + 16 * 3600000;
      // No rescue while the drawdown is stale (hours 0-12).
      expect(rescueWindows.filter((d) => d.startedAtMs < declineStartMs)).toHaveLength(0);
      // Rescue fires during the broad decline.
      expect(rescueWindows.filter((d) => d.startedAtMs >= declineStartMs && d.startedAtMs < haltMs).length)
        .toBeGreaterThan(0);
      // No NEW rescue window commits once the decline has halted, even
      // though the severe drawdown persists unchanged.
      expect(rescueWindows.filter((d) => d.startedAtMs >= haltMs)).toHaveLength(0);
      expect(report.summary.directInterventionTransitions).toBe(0);
    }
  });

  test('severe decline rescues recurrently but never continuously: bounded emergency windows separated by NORMAL opportunities', () => {
    for (const run of acceptance.profiles['severe-decline'].seeds) {
      // Nonzero rescue: the persistent severe-drawdown emergency keeps
      // triggering — rescue itself is not weakened.
      expect(run.rescueCount).toBeGreaterThan(0);
      expect(run.modeTimeFraction.RESCUE).toBeGreaterThan(0);
      // Never 100% continuous rescue: an emergency cannot override the
      // refractory its own ended window created, so every emergency window
      // is followed by a bounded NORMAL opportunity.
      expect(run.modeTimeFraction.RESCUE).toBeLessThanOrEqual(0.5);
      expect(run.modeTimeFraction.NORMAL).toBeGreaterThanOrEqual(0.5);
      // No intervention->intervention transition without a NORMAL window
      // between; each RESCUE occupancy streak is one bounded window.
      expect(run.directInterventionTransitions).toBe(0);
      expect(run.longestRescueStreakMinutes).toBeLessThanOrEqual(MAX_INTERVENTION_MINUTES);
      // The NORMAL opportunities are genuine refractory spans, not token
      // one-tick gaps.
      expect(run.averageNormalRunLengthMinutes).toBeGreaterThanOrEqual(15);
      // Every emergency window is still one bounded window.
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
      // Bounded recurrence: every emergency window is separated from the
      // next by a NORMAL refractory opportunity, and each RESCUE occupancy
      // streak is one bounded window — never a continuous chain.
      expect(run.directInterventionTransitions).toBe(0);
      expect(run.longestRescueStreakMinutes).toBeLessThanOrEqual(MAX_INTERVENTION_MINUTES);
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
