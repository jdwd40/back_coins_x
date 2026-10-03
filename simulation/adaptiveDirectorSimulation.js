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
//
// PR #36 correction metrics (hyperactivity/inertia/hysteresis review):
//   * modeTimeFraction — share of the horizon spent in each mode (per-tick
//     occupancy, not committed-window sums);
//   * longestInterventionStreakMinutes / longestRescueStreakMinutes —
//     longest continuous non-NORMAL / RESCUE occupancy;
//   * directInterventionTransitions — adjacent committed WINDOWS (same-
//     window role-rotation recommits collapsed) that move intervention ->
//     intervention with no NORMAL window between;
//   * averageNormalRunLengthMinutes — mean length of maximal NORMAL
//     occupancy runs (the refractory/NORMAL opportunities);
//   * averageInterventionDurationMinutes — mean committed intervention
//     window length;
//   * goldenRotationsPerHour / demonRotationsPerHour.
function runAdaptiveDirectorSimulation({ scenario, config = resolveSimulationConfig() } = {}) {
  if (!scenario || typeof scenario.observationAt !== 'function') {
    throw new Error('adaptive director simulation requires a scenario with observationAt(tickIndex, nowMs)');
  }
  const { worldSeed, startMs, tickMs, ticks } = scenario;

  let committed = null;
  const decisions = [];
  const tickModes = [];
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
    tickModes.push(state.mode);
    committed = state;
  }

  const horizonHours = (ticks * tickMs) / (60 * MINUTE_MS);
  const tickMinutes = tickMs / MINUTE_MS;

  // Per-tick occupancy.
  const modeTimeFraction = { NORMAL: 0, BOOM: 0, BUST: 0, RESCUE: 0 };
  for (const mode of tickModes) modeTimeFraction[mode] += 1;
  for (const mode of Object.keys(modeTimeFraction)) modeTimeFraction[mode] /= ticks;

  // Streaks (ticks -> minutes).
  const longestStreak = (predicate) => {
    let longest = 0;
    let current = 0;
    for (const mode of tickModes) {
      if (predicate(mode)) {
        current += 1;
        if (current > longest) longest = current;
      } else {
        current = 0;
      }
    }
    return longest * tickMinutes;
  };
  const longestInterventionStreakMinutes = longestStreak((mode) => mode !== 'NORMAL');
  const longestRescueStreakMinutes = longestStreak((mode) => mode === 'RESCUE');

  // Committed intervention WINDOWS (collapse same-window recommits).
  const windows = decisions.filter((d, i) => i === 0 || d.startedAtMs !== decisions[i - 1].startedAtMs);
  let directInterventionTransitions = 0;
  for (let i = 1; i < windows.length; i++) {
    if (windows[i].mode !== 'NORMAL' && windows[i - 1].mode !== 'NORMAL') {
      directInterventionTransitions += 1;
    }
  }

  // NORMAL run lengths (ticks -> minutes).
  const normalRuns = [];
  let run = 0;
  for (const mode of tickModes) {
    if (mode === 'NORMAL') {
      run += 1;
    } else if (run > 0) {
      normalRuns.push(run);
      run = 0;
    }
  }
  if (run > 0) normalRuns.push(run);
  const averageNormalRunLengthMinutes = normalRuns.length === 0
    ? 0
    : (normalRuns.reduce((sum, n) => sum + n, 0) / normalRuns.length) * tickMinutes;

  const interventionWindows = windows.filter((d) => d.mode !== 'NORMAL');
  const averageInterventionDurationMinutes = interventionWindows.length === 0
    ? 0
    : interventionWindows.reduce((sum, d) => sum + (d.endsAtMs - d.startedAtMs), 0)
      / interventionWindows.length / 60000;

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
      horizonHours,
      totalDecisions: decisions.length,
      decisionsPerHour: decisions.length / horizonHours,
      modeCounts,
      modeDurationsMs,
      modesSeen,
      rescueCount: modeCounts.RESCUE,
      goldenRotations,
      demonRotations,
      goldenRotationsPerHour: goldenRotations / horizonHours,
      demonRotationsPerHour: demonRotations / horizonHours,
      modeTimeFraction,
      longestInterventionStreakMinutes,
      longestRescueStreakMinutes,
      directInterventionTransitions,
      averageNormalRunLengthMinutes,
      averageInterventionDurationMinutes
    }
  };
}

// ---------------------------------------------------------------------------
// PR #36 correction: deterministic acceptance profiles.
//
// Seven 24-hour synthetic market narratives over 10 coins, each fabricated
// deterministically from (profile, seed, tick) — no Math.random, no wall
// clock. The only randomness remains the domain's seeded stream (keyed by
// worldSeed + decision cursor), so the 20-seed sweep varies every draw
// without tuning to any one seed.
// ---------------------------------------------------------------------------

const ACCEPTANCE_PROFILE_IDS = Object.freeze([
  'healthy-variable',
  'stagnation',
  'mild-decline',
  'mild-decline-moving',
  'severe-decline',
  'sustained-overheat',
  'death-cluster',
  'stale-drawdown-churn'
]);

const ACCEPTANCE_COINS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

// stale-drawdown-churn roster: the live production roster and exact
// per-coin observation values from the 2026-10-03T14:16:21Z read-only
// production probe (world 1, deployed SHA da8b1b6) — see the profile branch
// below for the full provenance.
const STALE_CHURN_COINS = [1, 2, 6, 9, 10, 101, 102, 104, 105, 106];
const STALE_CHURN_MOVEMENT = {
  1: -0.0038, 2: -0.0402, 6: -0.2143, 9: 0.1608, 10: -0.2693,
  101: -0.0209, 102: 0.0445, 104: 0.1768, 105: -0.0115, 106: 0.2949
};
const STALE_CHURN_CONDITION = {
  1: 0.142, 2: -0.133, 6: 0.293, 9: 0.333, 10: -0.205,
  101: -0.021, 102: -0.495, 104: 0.020, 105: 0.155, 106: 0.491
};
const STALE_CHURN_DRAWDOWN = 0.5744;

const ACCEPTANCE_MACRO = Object.freeze({
  regime: 'BULL',
  regimeIndex: 3,
  intensity: 0.5,
  environment: {
    structuralBias: 0.02, volatilityScale: 1, positiveEventBias: 0,
    negativeEventBias: 0, eventSeverityScale: 1,
    crashProbabilityModifier: 1, recoveryModifier: 1, collapseRiskModifier: 1
  }
});

// Build the 24-hour scenario for one acceptance profile and seed.
function buildAcceptanceScenario(profile, seedIndex) {
  if (!ACCEPTANCE_PROFILE_IDS.includes(profile)) {
    throw new Error(`unknown acceptance profile ${JSON.stringify(profile)}; expected one of ${ACCEPTANCE_PROFILE_IDS.join(', ')}`);
  }
  const startMs = Date.parse('2026-09-01T00:00:00.000Z');
  const tickMs = MINUTE_MS;
  const ticks = 24 * 60;

  // Deterministic per-coin jitter in [-1, 1] from (tick, coinId, seedIndex)
  // — a pure hash, not Math.random.
  const jitter = (tick, coinId, salt) => {
    let h = (tick * 2654435761) ^ (coinId * 40503) ^ ((seedIndex + 1) * 1597334677) ^ (salt * 2246822519);
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
    h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
    return (((h ^ (h >>> 15)) >>> 0) % 2000) / 1000 - 1;
  };

  function observationAt(tickIndex, nowMs) {
    const hour = tickIndex / 60;
    let movementOf;
    let drawdownPct;
    let conditionOf;
    let lastMeaningfulMovementAtMs;
    let recentDeathCount = 0;
    let recentDeaths = [];
    let recentReplacements = [];

    if (profile === 'healthy-variable') {
      // Variable healthy movement: a deterministic majority always moves
      // meaningfully; direction/magnitude vary per coin and tick.
      movementOf = (coinId) => 0.012 * jitter(tickIndex, coinId, 1) + 0.018 * (coinId % 2 === 0 ? 1 : -1);
      drawdownPct = 0.05;
      conditionOf = () => 0.05;
      lastMeaningfulMovementAtMs = nowMs - 3 * MINUTE_MS;
    } else if (profile === 'stagnation') {
      // Persistent flatness: nothing moves meaningfully all day.
      movementOf = (coinId) => 0.001 * jitter(tickIndex, coinId, 2);
      drawdownPct = 0.06;
      conditionOf = () => 0;
      lastMeaningfulMovementAtMs = startMs;
    } else if (profile === 'mild-decline') {
      // 7/10 coins drifting at -0.6%: falling breadth with NO magnitude,
      // drawdown, weak-condition or death corroboration. The movement clock
      // is stale (nothing moves meaningfully all day), so this profile also
      // exercises the refractory-bounded stagnation swings a flat mild
      // decline legitimately draws.
      movementOf = (coinId) => (coinId <= 7 ? -0.006 : 0.001) + 0.0005 * jitter(tickIndex, coinId, 3);
      drawdownPct = 0.08;
      conditionOf = () => -0.1;
      lastMeaningfulMovementAtMs = startMs;
    } else if (profile === 'mild-decline-moving') {
      // PR #36 wave-2 acceptance: the SAME mild broad decline (7/10 at
      // -0.6%, no corroboration) but with ONGOING meaningful movement —
      // the market is drifting, not stagnant, so the stagnation clock
      // stays fresh and the day is predominantly NORMAL with zero rescue
      // and no interventions at all.
      movementOf = (coinId) => (coinId <= 7 ? -0.006 : 0.001) + 0.0005 * jitter(tickIndex, coinId, 7);
      drawdownPct = 0.08;
      conditionOf = () => -0.1;
      lastMeaningfulMovementAtMs = nowMs - 2 * MINUTE_MS;
    } else if (profile === 'severe-decline') {
      // A sustained crash: 8/10 coins at -4%, 35% drawdown, weak and
      // critically weak clusters.
      movementOf = (coinId) => (coinId <= 8 ? -0.04 : 0.002) + 0.002 * jitter(tickIndex, coinId, 4);
      drawdownPct = 0.35;
      conditionOf = (coinId) => (coinId <= 2 ? -0.7 : coinId <= 6 ? -0.4 : -0.1);
      lastMeaningfulMovementAtMs = nowMs - 2 * MINUTE_MS;
    } else if (profile === 'sustained-overheat') {
      // A sustained broad rally: +12% broad with 8/10 rising.
      movementOf = (coinId) => (coinId <= 8 ? 0.12 : 0.004) + 0.003 * jitter(tickIndex, coinId, 5);
      drawdownPct = 0;
      conditionOf = () => 0.3;
      lastMeaningfulMovementAtMs = nowMs - 2 * MINUTE_MS;
    } else if (profile === 'stale-drawdown-churn') {
      // Long-term-balancing reproduction (production evidence 2026-10-03):
      // a PERSISTENT severe drawdown from the decaying peak references
      // (drawdownPct 0.5744 against rescueDrawdownPct 0.25) coexisting with
      // FRESH, mixed, both-direction movement — the exact live probe
      // observation (median -0.0077, broad +0.0117, rising 4 / falling 5 /
      // flat 1, weakCount 1, distressed 0, no deaths, movement clock
      // fresh). Production held the Director in a permanent RESCUE <>
      // refractory loop for 23 straight days (1262 RESCUE episodes,
      // 16-21% duty every day, mean intensity 0.95, zero BOOM/BUST) on
      // this state alone: the stale drawdown IS the steady state of this
      // volatility regime, not an emergency in progress.
      movementOf = (coinId) => STALE_CHURN_MOVEMENT[coinId] + 0.004 * jitter(tickIndex, coinId, 8);
      drawdownPct = STALE_CHURN_DRAWDOWN;
      conditionOf = (coinId) => STALE_CHURN_CONDITION[coinId];
      lastMeaningfulMovementAtMs = nowMs - 2 * MINUTE_MS;
    } else {
      // death-cluster: a rolling fresh death cluster during hours 4-8,
      // otherwise a calm market.
      movementOf = (coinId) => 0.008 * jitter(tickIndex, coinId, 6);
      drawdownPct = 0.07;
      conditionOf = () => 0;
      lastMeaningfulMovementAtMs = nowMs - 4 * MINUTE_MS;
      if (hour >= 4 && hour < 8) {
        recentDeathCount = 2;
        recentDeaths = [
          { coinId: 40, diedAtMs: nowMs - 10 * MINUTE_MS },
          { coinId: 41, diedAtMs: nowMs - 25 * MINUTE_MS }
        ];
        recentReplacements = [{ coinId: 9, createdAtMs: nowMs - 12 * MINUTE_MS }];
      }
    }

    const roster = profile === 'stale-drawdown-churn' ? STALE_CHURN_COINS : ACCEPTANCE_COINS;
    const coins = roster.map((coinId) => ({
      coinId,
      archetype: 'ZIP',
      condition: conditionOf(coinId),
      currentPrice: 1,
      peakReference: 1 / (1 - drawdownPct),
      structuralReference: 1,
      movementPct: movementOf(coinId)
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
      recentDeathCount,
      recentDeaths,
      recentReplacements,
      lastMeaningfulMovementAtMs,
      macro: ACCEPTANCE_MACRO
    };
  }

  return {
    worldSeed: `wave2-acceptance:${profile}:${seedIndex}`,
    startMs,
    tickMs,
    ticks,
    observationAt
  };
}

// The deterministic acceptance sweep: every profile x seeds. Returns
// per-profile runs and an aggregate (min/max/mean over seeds) of the
// review metrics. Fully reproducible.
function runDeterministicAcceptance({ seeds = 20, config = resolveSimulationConfig() } = {}) {
  const profiles = {};
  for (const profile of ACCEPTANCE_PROFILE_IDS) {
    const runs = [];
    for (let seedIndex = 0; seedIndex < seeds; seedIndex++) {
      runs.push(runAdaptiveDirectorSimulation({
        scenario: buildAcceptanceScenario(profile, seedIndex),
        config
      }).summary);
    }
    const metricKeys = [
      'decisionsPerHour', 'rescueCount', 'directInterventionTransitions',
      'longestInterventionStreakMinutes', 'longestRescueStreakMinutes',
      'averageNormalRunLengthMinutes', 'averageInterventionDurationMinutes',
      'goldenRotationsPerHour', 'demonRotationsPerHour'
    ];
    const aggregate = {};
    for (const key of metricKeys) {
      const values = runs.map((summary) => summary[key]);
      aggregate[key] = {
        min: Math.min(...values),
        max: Math.max(...values),
        mean: values.reduce((sum, value) => sum + value, 0) / values.length
      };
    }
    const modeTimeFraction = {};
    for (const mode of ['NORMAL', 'BOOM', 'BUST', 'RESCUE']) {
      const values = runs.map((summary) => summary.modeTimeFraction[mode]);
      modeTimeFraction[mode] = {
        min: Math.min(...values),
        max: Math.max(...values),
        mean: values.reduce((sum, value) => sum + value, 0) / values.length
      };
    }
    profiles[profile] = { seeds: runs, aggregate, modeTimeFraction };
  }
  return { profiles, seedCount: seeds, horizonHours: 24 };
}

module.exports = {
  buildCanonicalScenario,
  runAdaptiveDirectorSimulation,
  buildAcceptanceScenario,
  runDeterministicAcceptance,
  ACCEPTANCE_PROFILE_IDS
};

// CLI: node simulation/adaptiveDirectorSimulation.js [--acceptance]
if (require.main === module) {
  if (process.argv.includes('--acceptance')) {
    const acceptance = runDeterministicAcceptance({});
    const printable = {};
    for (const [profile, data] of Object.entries(acceptance.profiles)) {
      printable[profile] = { aggregate: data.aggregate, modeTimeFraction: data.modeTimeFraction };
    }
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ seedCount: acceptance.seedCount, horizonHours: acceptance.horizonHours, profiles: printable }, null, 2));
  } else {
    const report = runAdaptiveDirectorSimulation({ scenario: buildCanonicalScenario() });
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(report.summary, null, 2));
  }
}
