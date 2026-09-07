// Director Coin Events Wave 2: deterministic control-layer simulation.
//
// NOT a price-market simulation: a synthetic observation sequence is
// driven through the PURE adaptive Director domain
// (game/adaptiveDirector.js) at the configured cadence, threading the
// committed control state through exactly as the runtime would. The
// canonical scenario walks healthy movement, prolonged stagnation
// (bounded BOOM/BUST swings), a broad crash (RESCUE, BUST suppressed),
// recovery back to NORMAL, sustained overheating (bounded correction) and
// calm — with Golden/Demon rotation occurring naturally off the bounded
// role durations.
//
// The report exists for hyperactivity/inertia review: decision counts per
// mode, committed durations per mode, role rotations and the per-decision
// log. Fully reproducible: no Math.random, no wall clock, no database —
// the only randomness is the domain's seeded stream.

const { evaluateAdaptiveDirectorDecision } = require('../game/adaptiveDirector');
const { resolveSimulationConfig } = require('../game/simulationConfig');

const MINUTE_MS = 60 * 1000;

// The canonical 8-hour scenario at a 1-minute cadence over 8 synthetic
// coins. observationAt(tickIndex, nowMs) fabricates the bounded
// observation the DB-backed observation layer WOULD report for the
// scripted market narrative.
function buildCanonicalScenario() {
  const startMs = Date.parse('2026-09-01T00:00:00.000Z');
  const tickMs = MINUTE_MS;
  const ticks = 480;
  const coinIds = [1, 2, 3, 4, 5, 6, 7, 8];

  const macro = {
    regime: 'BULL',
    regimeIndex: 3,
    intensity: 0.5,
    environment: {
      structuralBias: 0.02, volatilityScale: 1, positiveEventBias: 0,
      negativeEventBias: 0, eventSeverityScale: 1,
      crashProbabilityModifier: 1, recoveryModifier: 1, collapseRiskModifier: 1
    }
  };

  // Phase boundaries in minutes.
  const phases = {
    healthy: [0, 90],
    stagnation: [90, 190],
    crash: [190, 215],
    recovery: [215, 330],
    overheat: [330, 370],
    calm: [370, 480]
  };
  const phaseOf = (minute) => {
    for (const [name, [from, until]] of Object.entries(phases)) {
      if (minute >= from && minute < until) return name;
    }
    return 'calm';
  };

  const stagnationStartMs = startMs + phases.stagnation[0] * MINUTE_MS;

  function observationAt(tickIndex, nowMs) {
    const minute = tickIndex;
    const phase = phaseOf(minute);

    // Per-coin movement over the (synthetic) lookback, deterministic in
    // (phase, minute, coinId) — a small spread around the phase level.
    const spread = (coinId) => 1 + 0.1 * ((coinId % 3) - 1);
    let baseMovement;
    let drawdownPct;
    let conditionOf;
    let lastMeaningfulMovementAtMs;

    if (phase === 'stagnation') {
      baseMovement = 0.001;
      drawdownPct = 0.06;
      conditionOf = () => 0;
      // No meaningful movement since the phase began.
      lastMeaningfulMovementAtMs = stagnationStartMs;
    } else if (phase === 'crash') {
      baseMovement = -0.05;
      drawdownPct = 0.4;
      conditionOf = (coinId) => (coinId <= 2 ? -0.7 : coinId <= 5 ? -0.4 : -0.1);
      // A crash IS movement.
      lastMeaningfulMovementAtMs = nowMs - 2 * MINUTE_MS;
    } else if (phase === 'recovery') {
      baseMovement = 0.01;
      drawdownPct = Math.max(0.05, 0.35 - 0.003 * (minute - phases.recovery[0]));
      conditionOf = (coinId) => (minute < 230 && coinId <= 2 ? -0.7 : minute < 235 && coinId <= 4 ? -0.4 : -0.05);
      lastMeaningfulMovementAtMs = nowMs - 2 * MINUTE_MS;
    } else if (phase === 'overheat') {
      baseMovement = 0.12;
      drawdownPct = 0;
      conditionOf = () => 0.2;
      lastMeaningfulMovementAtMs = nowMs - 2 * MINUTE_MS;
    } else {
      // healthy / calm: small oscillating movement, mixed direction across
      // coins (a healthy market never moves as one block).
      baseMovement = 0.01 * ((minute % 3) - 1);
      drawdownPct = 0.06;
      conditionOf = () => 0;
      lastMeaningfulMovementAtMs = nowMs - 2 * MINUTE_MS;
    }

    const directionSpread = (coinId) => (phase === 'crash' || phase === 'overheat' ? 1 : (coinId % 2 === 0 ? 1 : -1));
    const coins = coinIds.map((coinId) => ({
      coinId,
      archetype: 'ZIP',
      condition: conditionOf(coinId),
      currentPrice: 1,
      peakReference: 1,
      structuralReference: 1,
      movementPct: baseMovement * spread(coinId) * directionSpread(coinId)
    }));

    const breadthThresholdPct = 0.005;
    const breadth = { rising: 0, falling: 0, flat: 0 };
    for (const coin of coins) {
      if (Math.abs(coin.movementPct) < breadthThresholdPct) breadth.flat += 1;
      else if (coin.movementPct > 0) breadth.rising += 1;
      else breadth.falling += 1;
    }
    const movements = coins.map((coin) => coin.movementPct).sort((a, b) => a - b);
    const mid = Math.floor(movements.length / 2);
    const medianMovementPct = movements.length % 2 === 1
      ? movements[mid]
      : (movements[mid - 1] + movements[mid]) / 2;

    return {
      liveCoinCount: coins.length,
      coins,
      breadth,
      medianMovementPct,
      broadMovementPct: movements.reduce((sum, value) => sum + value, 0) / movements.length,
      drawdownPct,
      weakCount: coins.filter((coin) => coin.condition <= -0.3).length,
      distressedCount: coins.filter((coin) => coin.condition <= -0.6).length,
      recentDeathCount: 0,
      recentDeaths: [],
      recentReplacements: [],
      lastMeaningfulMovementAtMs,
      macro
    };
  }

  return {
    worldSeed: 'wave2-adaptive-director-simulation-seed',
    startMs,
    tickMs,
    ticks,
    observationAt
  };
}

// Run a scenario through the pure decision domain at the configured
// cadence. Committed decisions are threaded exactly as the runtime would
// (the computed state becomes the next tick's controlState). Returns the
// full decision log plus a review summary.
function runAdaptiveDirectorSimulation({ scenario, config = resolveSimulationConfig() } = {}) {
  if (!scenario || typeof scenario.observationAt !== 'function') {
    throw new Error('adaptive director simulation requires a scenario with observationAt(tickIndex, nowMs)');
  }
  const { worldSeed, startMs, tickMs, ticks } = scenario;

  let committed = null;
  const decisions = [];
  const modeDurationsMs = { NORMAL: 0, BOOM: 0, BUST: 0, RESCUE: 0 };
  const modeCounts = { NORMAL: 0, BOOM: 0, BUST: 0, RESCUE: 0 };
  let goldenRotations = 0;
  let demonRotations = 0;

  for (let i = 0; i < ticks; i++) {
    const nowMs = startMs + i * tickMs;
    const observation = scenario.observationAt(i, nowMs);
    const { state, changed } = evaluateAdaptiveDirectorDecision({
      worldSeed,
      nowMs,
      controlState: committed,
      observation,
      config
    });
    if (changed) {
      const startedAtMs = new Date(state.startedAt).getTime();
      const endsAtMs = new Date(state.endsAt).getTime();
      modeDurationsMs[state.mode] += endsAtMs - startedAtMs;
      modeCounts[state.mode] += 1;
      if (committed && state.goldenCoinId !== committed.goldenCoinId) goldenRotations += 1;
      if (committed && state.demonCoinId !== committed.demonCoinId) demonRotations += 1;
      decisions.push({
        decisionIndex: state.decisionIndex,
        mode: state.mode,
        direction: state.direction,
        intensity: state.intensity,
        startedAtMs,
        endsAtMs,
        goldenCoinId: state.goldenCoinId,
        demonCoinId: state.demonCoinId,
        reason: state.reason
      });
    }
    committed = state;
  }

  const modesSeen = Object.keys(modeCounts).filter((mode) => modeCounts[mode] > 0);
  return {
    decisions,
    scenario: {
      worldSeed,
      startMs,
      tickMs,
      ticks,
      crashStartMs: startMs + 190 * MINUTE_MS,
      crashEndMs: startMs + 215 * MINUTE_MS,
      recoveryEndMs: startMs + 330 * MINUTE_MS
    },
    summary: {
      totalTicks: ticks,
      horizonHours: (ticks * tickMs) / (60 * MINUTE_MS),
      totalDecisions: decisions.length,
      decisionsPerHour: decisions.length / ((ticks * tickMs) / (60 * MINUTE_MS)),
      modeCounts,
      modeDurationsMs,
      modesSeen,
      rescueCount: modeCounts.RESCUE,
      goldenRotations,
      demonRotations
    }
  };
}

module.exports = {
  buildCanonicalScenario,
  runAdaptiveDirectorSimulation
};

// CLI: node simulation/adaptiveDirectorSimulation.js
if (require.main === module) {
  const report = runAdaptiveDirectorSimulation({ scenario: buildCanonicalScenario() });
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(report.summary, null, 2));
}
