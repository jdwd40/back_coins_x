// Director Coin Events Wave 2: the PURE adaptive Director decision domain.
//
// Given the world seed, an INJECTED instant, the committed Director control
// state (director_control_state, migration 029 — or null before the first
// decision), a bounded current-market observation and the validated config,
// this module computes the next NORMAL/BOOM/BUST/RESCUE control decision.
//
// Purity contract (identical to game/persistentCoinEventDomain.js):
//   * no database access, no wall-clock reads, no Math.random();
//   * the ONLY randomness is the project seeded RNG
//     (game/seededRandom.createSeededRandom) keyed by
//     `${worldSeed}:adaptive-director:${decisionIndex}` — the same seed +
//     state + observation + timestamp produce the identical output, in
//     every process, forever; different decision indices draw different
//     streams (deterministic variation);
//   * the domain has NO death, replacement, pricing, trade, bot or event
//     authority: it computes a control decision and nothing else. RESCUE in
//     particular carries no per-coin protection — nothing here can make a
//     coin immortal.
//
// Policy (all bounds from config.directorControl):
//   * NORMAL is the default. A cadence tick NEVER forces an intervention:
//     a healthy market mid-window returns the committed state unchanged
//     (changed=false), and an elapsed healthy swing window recommits a
//     fresh NORMAL window drawn from normalSwingTargetMs (a target/window,
//     not a rigid timer).
//   * Genesis safety: with no committed state a first evaluation still
//     opens NORMAL for a healthy observation, but explicit rescue signals
//     (or the sustained-overheat condition) already present at the first
//     evaluation intervene immediately at cursor 0 rather than waiting
//     out the opening swing window.
//   * Meaningful movement refreshes stagnation tracking: the stagnation
//     verdict uses max(committed, observed) lastMeaningfulMovementAt, so
//     fresh observed movement always resets the clock even between
//     committed decisions; the committed field is carried forward at the
//     next committed decision.
//   * Genuine prolonged stagnation (no movement of at least
//     stagnationThresholdPct for stagnationWindowMs) may choose a bounded
//     BOOM/BUST swing. Direction is a seeded draw biased by market health
//     (drawdown favours a positive swing) and the macro regime's structural
//     bias, clamped away from certainty. Anti-loop: a draw repeating the
//     last swing direction stands only when a confirmation roll clears
//     stagnationSameDirectionProbability; otherwise it flips.
//   * RESCUE (POSITIVE) is favoured by any of: severe broad drawdown, a
//     falling breadth fraction, too many weak coins, a persistent death
//     cluster, or prolonged depression (clustered critically weak
//     condition). RESCUE suppresses BUST entirely and is the ONLY
//     condition that interrupts an active intervention early (and an
//     active RESCUE under ongoing distress is retained to its committed
//     expiry rather than recommitted every tick).
//   * Overheating (a broad rise of at least overheatRisePct over the whole
//     bounded lookback with at least overheatBreadthFraction of live coins
//     rising — sustained AND extreme by construction) allows a bounded
//     negative correction (BUST, intensity capped at 0.6). Ordinary healthy
//     rises stay below the threshold and never trigger.
//   * Expired interventions return naturally to NORMAL unless conditions
//     justify a new decision.
//
// Golden/Demon roles (at most one each, never the same coin):
//   * candidates are the observation's live coins (live, non-retired,
//     non-DEAD by the observation contract);
//   * a committed role is RETAINED exactly (coin and expiry) until it
//     expires or its holder leaves the eligible set — restarts and later
//     decisions never reroll a valid role;
//   * expired/invalid roles rotate deterministically off the decision's
//     seeded stream;
//   * Golden prefers the underperforming-but-viable lower half by movement
//     (seeded pick within the half — never always the weakest coin);
//   * Demon prefers the recent upper half; while the recent-death safety
//     window is active, freshly replaced coins and critically weak coins
//     (condition at/below distressedConditionThreshold) are excluded;
//   * Demon is a control-signal role only — never a death sentence.
//
// This module never requires any database module and never touches any
// apocalypse_* table.

const { createSeededRandom } = require('./seededRandom');
const {
  resolveSimulationConfig,
  DIRECTOR_CONTROL_MODE_IDS,
  COIN_EVENT_DIRECTION_IDS,
  MARKET_PHASE_IDS
} = require('./simulationConfig');

function toMs(value, label) {
  const ms = (value instanceof Date ? value : new Date(value)).getTime();
  if (!Number.isFinite(ms)) {
    throw new Error(`adaptive director ${label} is invalid; received ${String(value)}`);
  }
  return ms;
}

function nullableToMs(value) {
  if (value === null || value === undefined) return null;
  return toMs(value, 'nullable timestamp');
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function assertObservation(observation) {
  if (!observation || typeof observation !== 'object' || Array.isArray(observation)) {
    throw new Error('adaptive director observation must be an object');
  }
  if (!Number.isInteger(observation.liveCoinCount) || observation.liveCoinCount < 0) {
    throw new Error(`adaptive director observation liveCoinCount must be a non-negative integer; received ${String(observation.liveCoinCount)}`);
  }
  if (!Array.isArray(observation.coins)) {
    throw new Error('adaptive director observation coins must be an array');
  }
  if (observation.coins.length !== observation.liveCoinCount) {
    throw new Error(`adaptive director observation coins (${observation.coins.length}) must match liveCoinCount (${observation.liveCoinCount})`);
  }
  const seen = new Set();
  for (const coin of observation.coins) {
    if (!coin || typeof coin !== 'object' || Array.isArray(coin)) {
      throw new Error('adaptive director observation coin must be an object');
    }
    if (!Number.isInteger(Number(coin.coinId)) || Number(coin.coinId) <= 0) {
      throw new Error(`adaptive director observation coinId must be a positive integer; received ${String(coin.coinId)}`);
    }
    if (seen.has(Number(coin.coinId))) {
      throw new Error(`adaptive director observation lists coin ${coin.coinId} twice`);
    }
    seen.add(Number(coin.coinId));
    if (typeof coin.condition !== 'number' || !Number.isFinite(coin.condition)) {
      throw new Error(`adaptive director observation coin ${coin.coinId} condition must be finite; received ${String(coin.condition)}`);
    }
    if (coin.movementPct !== null && (typeof coin.movementPct !== 'number' || !Number.isFinite(coin.movementPct))) {
      throw new Error(`adaptive director observation coin ${coin.coinId} movementPct must be finite or null; received ${String(coin.movementPct)}`);
    }
  }
  const breadth = observation.breadth;
  if (!breadth || typeof breadth !== 'object'
      || !Number.isInteger(breadth.rising) || !Number.isInteger(breadth.falling) || !Number.isInteger(breadth.flat)
      || breadth.rising < 0 || breadth.falling < 0 || breadth.flat < 0) {
    throw new Error('adaptive director observation breadth must carry non-negative integer rising/falling/flat counts');
  }
  for (const key of ['medianMovementPct', 'broadMovementPct']) {
    const value = observation[key];
    if (value !== null && (typeof value !== 'number' || !Number.isFinite(value))) {
      throw new Error(`adaptive director observation ${key} must be finite or null; received ${String(value)}`);
    }
  }
  if (typeof observation.drawdownPct !== 'number' || !Number.isFinite(observation.drawdownPct)
      || observation.drawdownPct < 0 || observation.drawdownPct > 1) {
    throw new Error(`adaptive director observation drawdownPct must be a fraction in [0, 1]; received ${String(observation.drawdownPct)}`);
  }
  for (const key of ['weakCount', 'distressedCount', 'recentDeathCount']) {
    if (!Number.isInteger(observation[key]) || observation[key] < 0) {
      throw new Error(`adaptive director observation ${key} must be a non-negative integer; received ${String(observation[key])}`);
    }
  }
  if (!Array.isArray(observation.recentDeaths) || !Array.isArray(observation.recentReplacements)) {
    throw new Error('adaptive director observation recentDeaths/recentReplacements must be arrays');
  }
  if (observation.lastMeaningfulMovementAtMs !== null
      && (typeof observation.lastMeaningfulMovementAtMs !== 'number' || !Number.isFinite(observation.lastMeaningfulMovementAtMs))) {
    throw new Error(`adaptive director observation lastMeaningfulMovementAtMs must be finite or null; received ${String(observation.lastMeaningfulMovementAtMs)}`);
  }
  const macro = observation.macro;
  if (!macro || typeof macro !== 'object' || !MARKET_PHASE_IDS.includes(macro.regime)
      || !Number.isInteger(macro.regimeIndex) || macro.regimeIndex < 0
      || typeof macro.intensity !== 'number' || macro.intensity < 0 || macro.intensity > 1
      || !macro.environment || typeof macro.environment !== 'object'
      || typeof macro.environment.structuralBias !== 'number' || !Number.isFinite(macro.environment.structuralBias)) {
    throw new Error('adaptive director observation macro must carry a valid regime, regimeIndex, intensity and environment');
  }
  return observation;
}

function assertControlState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error('adaptive director control state must be an object or null');
  }
  if (!DIRECTOR_CONTROL_MODE_IDS.includes(state.mode)) {
    throw new Error(`adaptive director control state mode must be one of ${DIRECTOR_CONTROL_MODE_IDS.join(', ')}; received ${JSON.stringify(state.mode)}`);
  }
  if (!COIN_EVENT_DIRECTION_IDS.includes(state.direction)) {
    throw new Error(`adaptive director control state direction must be POSITIVE or NEGATIVE; received ${JSON.stringify(state.direction)}`);
  }
  if (typeof state.intensity !== 'number' || !Number.isFinite(state.intensity) || state.intensity < 0 || state.intensity > 1) {
    throw new Error(`adaptive director control state intensity must be in [0, 1]; received ${String(state.intensity)}`);
  }
  const startedMs = toMs(state.startedAt, 'startedAt');
  const endsMs = toMs(state.endsAt, 'endsAt');
  if (endsMs <= startedMs) {
    throw new Error('adaptive director control state window must satisfy endsAt after startedAt');
  }
  if (!Number.isInteger(state.decisionIndex) || state.decisionIndex < 0) {
    throw new Error(`adaptive director control state decisionIndex must be a non-negative integer; received ${String(state.decisionIndex)}`);
  }
  return state;
}

// The recent-death safety verdict: while a persistent death lies inside
// recentDeathSafetyMs, freshly replaced coins (state rows created inside
// the same window) and critically weak coins are protected from targeting.
function safetyVerdict(observation, nowMs, config) {
  const dc = config.directorControl;
  const safetyActive = observation.recentDeaths.some(
    (death) => nowMs - death.diedAtMs <= dc.recentDeathSafetyMs
  );
  const replacedIds = new Set(
    observation.recentReplacements
      .filter((replacement) => nowMs - replacement.createdAtMs <= dc.recentDeathSafetyMs)
      .map((replacement) => Number(replacement.coinId))
  );
  return { safetyActive, replacedIds };
}

// Golden selection: underperforming-but-viable preference. Candidates are
// sorted canonically by (movement, coinId) ascending and the seeded roll
// picks within the LOWER half — modestly favouring coins that lag without
// ever deterministically picking the single weakest.
function selectGolden(candidates, roll) {
  const sorted = candidates.slice().sort((a, b) =>
    (a.movementPct ?? 0) - (b.movementPct ?? 0) || Number(a.coinId) - Number(b.coinId));
  const lowerHalf = sorted.slice(0, Math.max(1, Math.ceil(sorted.length / 2)));
  return lowerHalf[Math.floor(roll * lowerHalf.length)].coinId;
}

// Demon selection: recent upper half by movement, seeded pick. Never the
// Golden coin; safety exclusions applied by the caller.
function selectDemon(candidates, roll) {
  const sorted = candidates.slice().sort((a, b) =>
    (b.movementPct ?? 0) - (a.movementPct ?? 0) || Number(a.coinId) - Number(b.coinId));
  const upperHalf = sorted.slice(0, Math.max(1, Math.ceil(sorted.length / 2)));
  return upperHalf[Math.floor(roll * upperHalf.length)].coinId;
}

// Resolve the Golden/Demon assignments for this decision. Retained roles
// keep coin AND expiry bit-exactly; rotations draw coin and duration off
// the decision's seeded stream. Returns { goldenCoinId, goldenExpiresAt,
// demonCoinId, demonExpiresAt, rotated }.
function resolveRoles({ committed, nowMs, observation, config, draws }) {
  const dc = config.directorControl;
  const { safetyActive, replacedIds } = safetyVerdict(observation, nowMs, config);
  const eligible = observation.coins;
  const eligibleIds = new Set(eligible.map((coin) => Number(coin.coinId)));
  let rotated = false;

  // Retention validity: coin still eligible (live, non-retired, non-DEAD)
  // and the expiry strictly in the future.
  const retainedGoldenId = committed && committed.goldenCoinId !== null && committed.goldenCoinId !== undefined
    && eligibleIds.has(Number(committed.goldenCoinId))
    && nullableToMs(committed.goldenExpiresAt) > nowMs
    ? Number(committed.goldenCoinId)
    : null;
  const retainedDemonId = committed && committed.demonCoinId !== null && committed.demonCoinId !== undefined
    && eligibleIds.has(Number(committed.demonCoinId))
    && nullableToMs(committed.demonExpiresAt) > nowMs
    ? Number(committed.demonCoinId)
    : null;

  let goldenCoinId;
  let goldenExpiresAt;
  if (retainedGoldenId !== null) {
    goldenCoinId = retainedGoldenId;
    goldenExpiresAt = committed.goldenExpiresAt;
  } else {
    if (committed && committed.goldenCoinId !== null && committed.goldenCoinId !== undefined) rotated = true;
    const goldenCandidates = eligible.filter((coin) =>
      Number(coin.coinId) !== retainedDemonId
      && !(safetyActive && replacedIds.has(Number(coin.coinId))));
    if (goldenCandidates.length === 0) {
      goldenCoinId = null;
      goldenExpiresAt = null;
    } else {
      goldenCoinId = selectGolden(goldenCandidates, draws.goldenSelect);
      const range = dc.goldenDurationMs;
      goldenExpiresAt = iso(nowMs + Math.round(range.min + (range.max - range.min) * draws.goldenDuration));
    }
  }

  let demonCoinId;
  let demonExpiresAt;
  if (retainedDemonId !== null && retainedDemonId !== goldenCoinId) {
    demonCoinId = retainedDemonId;
    demonExpiresAt = committed.demonExpiresAt;
  } else {
    if (committed && committed.demonCoinId !== null && committed.demonCoinId !== undefined) rotated = true;
    const demonCandidates = eligible.filter((coin) =>
      Number(coin.coinId) !== goldenCoinId
      && !(safetyActive && replacedIds.has(Number(coin.coinId)))
      && !(safetyActive && coin.condition <= dc.distressedConditionThreshold));
    if (demonCandidates.length === 0) {
      demonCoinId = null;
      demonExpiresAt = null;
    } else {
      demonCoinId = selectDemon(demonCandidates, draws.demonSelect);
      const range = dc.demonDurationMs;
      demonExpiresAt = iso(nowMs + Math.round(range.min + (range.max - range.min) * draws.demonDuration));
    }
  }

  return { goldenCoinId, goldenExpiresAt, demonCoinId, demonExpiresAt, rotated };
}

// The RESCUE signal set and its bounded severity. Every trigger is
// documented against the observation fields it reads.
function rescueSignals(observation, config) {
  const dc = config.directorControl;
  const live = observation.liveCoinCount;
  const fallingFraction = live === 0 ? 0 : observation.breadth.falling / live;
  const severeDrawdown = observation.drawdownPct >= dc.rescueDrawdownPct;
  const broadFall = live > 0 && fallingFraction >= dc.rescueFallingBreadthFraction;
  const tooWeak = observation.weakCount >= dc.rescueWeakCount;
  const deathCluster = observation.recentDeathCount >= dc.deathClusterCount;
  // Prolonged depression: clustered critically weak CONDITION. Condition is
  // the persisted long-horizon accumulator (migration 024), so clustered
  // distressed condition is the prolonged form of distress rather than a
  // single bad tick.
  const prolongedDepression = observation.distressedCount >= dc.deathClusterCount;
  const signalled = severeDrawdown || broadFall || tooWeak || deathCluster || prolongedDepression;
  const severity = Math.min(1, Math.max(
    observation.drawdownPct / (2 * dc.rescueDrawdownPct),
    fallingFraction,
    observation.weakCount / (2 * dc.rescueWeakCount),
    observation.recentDeathCount / (2 * dc.deathClusterCount),
    observation.distressedCount / (2 * dc.deathClusterCount)
  ));
  return { signalled, severity, severeDrawdown, broadFall, tooWeak, deathCluster, prolongedDepression };
}

// The overheating verdict: a broad rise of at least overheatRisePct across
// the WHOLE bounded lookback with at least overheatBreadthFraction of live
// coins rising. Both conditions together make the rise sustained and
// extreme; ordinary healthy rises stay below the rise threshold.
function overheatVerdict(observation, config) {
  const dc = config.directorControl;
  const live = observation.liveCoinCount;
  if (live === 0 || observation.broadMovementPct === null) return false;
  return observation.broadMovementPct >= dc.overheatRisePct
    && observation.breadth.rising / live >= dc.overheatBreadthFraction;
}

// Evaluate the next adaptive Director decision.
//
// Returns { state, changed }:
//   * state    — the full Director control state payload (WITHOUT worldId;
//                the runtime attaches the world identity) ready for
//                models/directorControlState.upsertDirectorControlState;
//   * changed  — false when the committed state is retained byte-identical
//                (same decision cursor, same payload: an idempotent
//                re-evaluation); true when a NEW decision at
//                decisionIndex+1 is returned.
function evaluateAdaptiveDirectorDecision({
  worldSeed,
  nowMs,
  controlState = null,
  observation,
  config = resolveSimulationConfig()
} = {}) {
  if (typeof worldSeed !== 'string' || worldSeed.length === 0) {
    throw new Error('adaptive director requires a non-empty world seed');
  }
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) {
    throw new Error(`adaptive director nowMs must be a finite injected instant; received ${String(nowMs)}`);
  }
  if (!config || !config.directorControl) {
    throw new Error('adaptive director requires a validated config with a directorControl section');
  }
  const dc = config.directorControl;
  assertObservation(observation);
  const committed = controlState === null || controlState === undefined ? null : assertControlState(controlState);

  const observedMeaningfulMs = observation.lastMeaningfulMovementAtMs;
  const committedMeaningfulMs = committed ? nullableToMs(committed.lastMeaningfulMovementAt) : null;
  const effectiveMeaningfulMs = observedMeaningfulMs === null
    ? committedMeaningfulMs
    : committedMeaningfulMs === null
      ? observedMeaningfulMs
      : Math.max(committedMeaningfulMs, observedMeaningfulMs);
  const nextMeaningfulMs = effectiveMeaningfulMs === null ? nowMs : effectiveMeaningfulMs;

  const nextIndex = committed === null ? 0 : committed.decisionIndex + 1;
  // The decision's seeded stream: keyed by the decision cursor, so the
  // same decision index always draws the same stream and consecutive
  // decisions draw different ones. Draws are consumed in a FIXED order,
  // independent of which policy branch fires.
  const rng = createSeededRandom(`${worldSeed}:adaptive-director:${nextIndex}`);
  const draws = {
    swingDirection: rng(),
    antiLoopConfirm: rng(),
    intensity: rng(),
    duration: rng(),
    normalWindow: rng(),
    goldenSelect: rng(),
    goldenDuration: rng(),
    demonSelect: rng(),
    demonDuration: rng()
  };

  const roles = resolveRoles({ committed, nowMs, observation, config, draws });
  const rescue = rescueSignals(observation, config);
  const overheated = overheatVerdict(observation, config);
  const stagnant = effectiveMeaningfulMs !== null
    && nowMs - effectiveMeaningfulMs >= dc.stagnationWindowMs;

  const roleFields = {
    goldenCoinId: roles.goldenCoinId,
    goldenExpiresAt: roles.goldenExpiresAt,
    demonCoinId: roles.demonCoinId,
    demonExpiresAt: roles.demonExpiresAt
  };

  // --- Retention: the committed decision stands --------------------------
  // RESCUE is the ONLY early interrupt, and only while not already in
  // RESCUE (an active RESCUE under ongoing distress is retained to its
  // committed expiry — no per-tick recommit churn); everything else waits
  // for the committed window to elapse. A role rotation while the window
  // stands commits a same-window decision at the next cursor.
  if (committed !== null && nowMs < toMs(committed.endsAt, 'endsAt')
      && !(rescue.signalled && committed.mode !== 'RESCUE')) {
    if (!roles.rotated) {
      // Nothing changed: identical replay at the committed cursor.
      return { state: committed, changed: false };
    }
    return {
      state: {
        mode: committed.mode,
        direction: committed.direction,
        intensity: committed.intensity,
        startedAt: committed.startedAt,
        endsAt: committed.endsAt,
        decisionIndex: nextIndex,
        reason: 'role rotation: a Golden/Demon assignment expired or left the eligible set',
        ...roleFields,
        lastSwingDirection: committed.lastSwingDirection ?? null,
        lastMeaningfulMovementAt: iso(nextMeaningfulMs)
      },
      changed: true
    };
  }

  // --- New decision ------------------------------------------------------
  const base = {
    decisionIndex: nextIndex,
    ...roleFields,
    lastMeaningfulMovementAt: iso(nextMeaningfulMs)
  };

  const interventionDurationMs = Math.round(
    dc.interventionDurationMs.min + (dc.interventionDurationMs.max - dc.interventionDurationMs.min) * draws.duration
  );

  if (rescue.signalled) {
    const causes = [];
    if (rescue.severeDrawdown) causes.push(`broad drawdown ${Math.round(observation.drawdownPct * 100)}% >= ${Math.round(dc.rescueDrawdownPct * 100)}%`);
    if (rescue.broadFall) causes.push(`${observation.breadth.falling}/${observation.liveCoinCount} coins falling`);
    if (rescue.tooWeak) causes.push(`${observation.weakCount} weak coins`);
    if (rescue.deathCluster) causes.push(`death cluster of ${observation.recentDeathCount}`);
    if (rescue.prolongedDepression) causes.push(`${observation.distressedCount} critically weak coins (prolonged depression)`);
    return {
      state: {
        mode: 'RESCUE',
        direction: 'POSITIVE',
        // Bounded severity: [0.4, 1].
        intensity: 0.4 + 0.6 * rescue.severity,
        startedAt: iso(nowMs),
        endsAt: iso(nowMs + interventionDurationMs),
        ...base,
        reason: `rescue: ${causes.join('; ')}`,
        lastSwingDirection: 'POSITIVE'
      },
      changed: true
    };
  }

  if (overheated) {
    // Bounded negative correction: severity-scaled, hard-capped at 0.6.
    const excess = Math.min(1, observation.broadMovementPct / dc.overheatRisePct - 1);
    const intensity = Math.min(0.6, 0.3 + 0.2 * excess + 0.1 * draws.intensity);
    return {
      state: {
        mode: 'BUST',
        direction: 'NEGATIVE',
        intensity,
        startedAt: iso(nowMs),
        endsAt: iso(nowMs + interventionDurationMs),
        ...base,
        reason: `overheat correction: broad rise ${Math.round(observation.broadMovementPct * 100)}% with ${observation.breadth.rising}/${observation.liveCoinCount} coins rising`,
        lastSwingDirection: 'NEGATIVE'
      },
      changed: true
    };
  }

  if (committed === null) {
    // Genesis safety: the explicit rescue/overheat branches above have
    // already run, so a first evaluation of a currently dangerous/depressed
    // (or sustained-overheated) market intervenes immediately instead of
    // waiting out a swing window. Only a healthy first observation reaches
    // here and opens NORMAL; the first full swing/stagnation evaluation
    // happens when the opening window elapses.
    const windowMs = Math.round(
      dc.normalSwingTargetMs.min + (dc.normalSwingTargetMs.max - dc.normalSwingTargetMs.min) * draws.normalWindow
    );
    return {
      state: {
        mode: 'NORMAL',
        direction: 'POSITIVE',
        intensity: 0,
        startedAt: iso(nowMs),
        endsAt: iso(nowMs + windowMs),
        ...base,
        reason: 'genesis: normal open',
        lastSwingDirection: null
      },
      changed: true
    };
  }

  if (stagnant) {
    // Bounded stagnation swing. Direction: seeded draw biased by health
    // (drawdown favours a reviving positive swing) and the macro regime's
    // structural bias, clamped away from certainty. Anti-loop: a repeat of
    // the last swing direction needs a confirmation roll.
    const drawdownBias = observation.drawdownPct * 0.5;
    const macroBias = Math.max(-0.4, Math.min(0.4, observation.macro.environment.structuralBias)) * 0.5;
    const positiveProbability = Math.max(0.1, Math.min(0.9, 0.5 + drawdownBias + macroBias));
    let direction = draws.swingDirection < positiveProbability ? 'POSITIVE' : 'NEGATIVE';
    if (committed.lastSwingDirection === direction && draws.antiLoopConfirm >= dc.stagnationSameDirectionProbability) {
      direction = direction === 'POSITIVE' ? 'NEGATIVE' : 'POSITIVE';
    }
    const intensity = 0.3 + 0.4 * draws.intensity;
    const stagnantForMinutes = Math.round((nowMs - effectiveMeaningfulMs) / 60000);
    return {
      state: {
        mode: direction === 'POSITIVE' ? 'BOOM' : 'BUST',
        direction,
        intensity,
        startedAt: iso(nowMs),
        endsAt: iso(nowMs + interventionDurationMs),
        ...base,
        reason: `stagnation swing: no meaningful movement for ${stagnantForMinutes}m`,
        lastSwingDirection: direction
      },
      changed: true
    };
  }

  // Healthy market, window elapsed: re-commit NORMAL with a fresh swing
  // target window. No intervention is forced.
  const windowMs = Math.round(
    dc.normalSwingTargetMs.min + (dc.normalSwingTargetMs.max - dc.normalSwingTargetMs.min) * draws.normalWindow
  );
  return {
    state: {
      mode: 'NORMAL',
      direction: committed.direction,
      intensity: 0,
      startedAt: iso(nowMs),
      endsAt: iso(nowMs + windowMs),
      ...base,
      reason: 'normal swing window',
      lastSwingDirection: committed.lastSwingDirection ?? null
    },
    changed: true
  };
}

module.exports = {
  evaluateAdaptiveDirectorDecision
};
