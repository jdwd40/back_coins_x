// Long-term-balancing evidence: the adaptive Director CLOSED LOOP inside
// the Stage 9 roster-churn horizon.
//
// simulation/stage9Horizon.js already drives the real persistent pricing,
// condition/reference/peak advance, authoritative death decision,
// authored replacement reconcile and the Wave 3 persistent event ledger
// path. With adaptiveDirector: true the per-step synthetic NORMAL decision
// is replaced by the REAL adaptive Director: the bounded observation is
// reduced from the evolving in-memory world through the production
// observation semantics (game/adaptiveDirectorObservation.reduceSnapshot),
// the pure decision domain (game/adaptiveDirector.js) evaluates it with
// the committed control state threaded exactly as the runtime does, and
// the committed decision drives the SAME planner + reconcile path that
// prices the coins. These tests pin the harness properties the
// long-horizon before/after study relies on: determinism (bit-identical
// replay), genuinely evolving observations, and a live decision cadence.
// No database, no wall clock, no Math.random.

const { runStage9Horizon } = require('../simulation/stage9Horizon');

const LOOP_OPTS = {
  days: 2,
  cadenceMinutes: 5,
  seed: 'ltb-closed-loop-test-seed',
  provider: 'director',
  adaptiveDirector: true
};

describe('adaptive Director closed loop in the Stage 9 horizon harness', () => {
  test('two identical seeded runs are BIT-IDENTICAL (decisions, modes, prices, roster)', () => {
    const a = runStage9Horizon({ ...LOOP_OPTS });
    const b = runStage9Horizon({ ...LOOP_OPTS });
    expect(JSON.stringify(a.adaptive.decisionLog)).toBe(JSON.stringify(b.adaptive.decisionLog));
    expect(JSON.stringify(a.adaptive.modeStepCounts)).toBe(JSON.stringify(b.adaptive.modeStepCounts));
    expect(JSON.stringify(a.adaptive.dailyPrices)).toBe(JSON.stringify(b.adaptive.dailyPrices));
    expect(JSON.stringify(a.adaptive.finalControlState)).toBe(JSON.stringify(b.adaptive.finalControlState));
  });

  test('the observation genuinely evolves with the simulated market (no static fixture)', () => {
    const result = runStage9Horizon({ ...LOOP_OPTS });
    const obs = result.adaptive.dailyObservations;
    expect(obs.length).toBeGreaterThanOrEqual(2);
    // The drawdown the Director reads is computed from the simulated
    // prices, and it moves as the market moves.
    const drawdowns = obs.map((o) => o.drawdownPct);
    expect(Math.max(...drawdowns)).toBeGreaterThan(Math.min(...drawdowns));
    // Movement evidence is derived from the simulated tick log, not
    // pinned: at least one daily observation carries real (non-null)
    // movement and a fresh breadth-aware market clock.
    expect(obs.some((o) => o.medianMovementPct !== null)).toBe(true);
    expect(obs.some((o) => o.lastMeaningfulMovementAtMs !== null)).toBe(true);
  });

  test('the Director decides on the evolving market (non-empty seeded decision stream, valid modes)', () => {
    const result = runStage9Horizon({ ...LOOP_OPTS });
    const { decisionLog, modeStepCounts, steps } = result.adaptive;
    expect(decisionLog.length).toBeGreaterThan(0);
    for (const decision of decisionLog) {
      expect(['NORMAL', 'BOOM', 'BUST', 'RESCUE']).toContain(decision.mode);
      expect(decision.intensity).toBeGreaterThanOrEqual(0);
      expect(decision.intensity).toBeLessThanOrEqual(1);
      expect(decision.endsAtMs).toBeGreaterThan(decision.startedAtMs);
    }
    // Every step's committed mode is accounted for.
    expect(
      modeStepCounts.NORMAL + modeStepCounts.BOOM + modeStepCounts.BUST + modeStepCounts.RESCUE
    ).toBe(steps);
  });
});
