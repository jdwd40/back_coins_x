// Director Coin Events Wave 2: the PURE event-count planning seam.
//
// Maps an adaptive Director decision (game/adaptiveDirector.js) plus the
// bounded observation's macro environment and per-coin health to the
// DESIRED active persistent coin-event counts per live coin. This seam
// INSERTS NOTHING: it returns a plan of simple target counts with
// deterministic reason/role metadata. A later wave's writer decides how
// (or whether) to realise the plan through the Wave 1 persistent event
// authority.
//
// Purity contract: no database, no clock, no Math.random — plain
// deterministic arithmetic only.
//
// Tendencies (all bounds from config; interpolation by bounded intensity,
// never a rigid table):
//   * NORMAL healthy: both directions, 1/1;
//   * BOOM: positive scales 1 .. maxTargetPositivePerCoin by intensity,
//     negative stays at its floor;
//   * BUST: negative scales by intensity, positive never drops below 1;
//   * RESCUE: broad positive favour scaled by intensity, negative never
//     erased (floor 1);
//   * the macro environment nudges each direction by at most ±1
//     (rounded from the bounded environment biases);
//   * Golden adds +1 positive, Demon adds +1 negative;
//   * floors: each direction keeps at least 1 (believable hope/danger in
//     both directions), caps: directorControl.maxTarget{Positive,Negative}-
//     PerCoin AND the Wave 1 persistentEvents per-direction active caps;
//     the Wave 1 TOTAL cap trims the less-favoured direction first, never
//     below the floors — and under NORMAL neither direction is favoured,
//     so the deterministic tie-break trims negative first (a 2/2 split
//     under a 3-total cap resolves to 2 positive/1 negative).
//
// This module never requires any database module and never touches any
// apocalypse_* table.

const {
  resolveSimulationConfig,
  DIRECTOR_CONTROL_MODE_IDS
} = require('./simulationConfig');

function assertDecision(decision) {
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) {
    throw new Error('adaptive event plan decision must be an object');
  }
  if (!DIRECTOR_CONTROL_MODE_IDS.includes(decision.mode)) {
    throw new Error(`adaptive event plan decision mode must be one of ${DIRECTOR_CONTROL_MODE_IDS.join(', ')}; received ${JSON.stringify(decision.mode)}`);
  }
  if (typeof decision.intensity !== 'number' || !Number.isFinite(decision.intensity)
      || decision.intensity < 0 || decision.intensity > 1) {
    throw new Error(`adaptive event plan decision intensity must be in [0, 1]; received ${String(decision.intensity)}`);
  }
  return decision;
}

function clampInteger(value, floor, cap) {
  return Math.max(floor, Math.min(cap, value));
}

// The bounded macro nudge for one direction: the environment bias
// (marketEnvironment.BOUNDS confine these to [-0.5, 0.5]) scaled to a
// [-1, 1] integer step.
function macroNudge(bias) {
  if (typeof bias !== 'number' || !Number.isFinite(bias)) {
    throw new Error(`adaptive event plan environment bias must be finite; received ${String(bias)}`);
  }
  return Math.round(Math.max(-0.5, Math.min(0.5, bias)) * 2);
}

// Plan the desired active event counts per live coin. Returns an array in
// canonical coin-id order of { coinId, targetPositive, targetNegative,
// role, reason }.
function planAdaptiveEventTargets({
  decision,
  observation,
  config = resolveSimulationConfig()
} = {}) {
  assertDecision(decision);
  if (!observation || typeof observation !== 'object' || !Array.isArray(observation.coins)) {
    throw new Error('adaptive event plan observation must carry a coins array');
  }
  if (!observation.macro || !observation.macro.environment) {
    throw new Error('adaptive event plan observation must carry a macro environment');
  }
  if (!config || !config.directorControl || !config.persistentEvents) {
    throw new Error('adaptive event plan requires a validated config with directorControl and persistentEvents sections');
  }
  const dc = config.directorControl;
  const pe = config.persistentEvents;

  // Effective per-direction caps: the Wave 2 planning caps AND the Wave 1
  // persisted-authority active caps, whichever is tighter.
  const posCap = Math.min(dc.maxTargetPositivePerCoin, pe.maxActivePositivePerCoin);
  const negCap = Math.min(dc.maxTargetNegativePerCoin, pe.maxActiveNegativePerCoin);
  const totalCap = pe.maxActivePerCoin;

  const posNudge = macroNudge(observation.macro.environment.positiveEventBias);
  const negNudge = macroNudge(observation.macro.environment.negativeEventBias);

  const goldenId = decision.goldenCoinId === null || decision.goldenCoinId === undefined ? null : Number(decision.goldenCoinId);
  const demonId = decision.demonCoinId === null || decision.demonCoinId === undefined ? null : Number(decision.demonCoinId);

  const plan = [];
  for (const coin of observation.coins) {
    const coinId = Number(coin && coin.coinId);
    if (!Number.isInteger(coinId) || coinId <= 0) {
      throw new Error(`adaptive event plan coin id must be a positive integer; received ${String(coin && coin.coinId)}`);
    }

    let positive = 1;
    let negative = 1;
    const parts = [];

    if (decision.mode === 'BOOM') {
      positive = 1 + Math.round(decision.intensity * (posCap - 1));
      parts.push(`BOOM intensity ${decision.intensity.toFixed(2)}`);
    } else if (decision.mode === 'BUST') {
      negative = 1 + Math.round(decision.intensity * (negCap - 1));
      parts.push(`BUST intensity ${decision.intensity.toFixed(2)}`);
    } else if (decision.mode === 'RESCUE') {
      positive = 1 + Math.round(decision.intensity * (posCap - 1));
      parts.push(`RESCUE intensity ${decision.intensity.toFixed(2)}`);
    } else {
      parts.push('NORMAL baseline');
    }

    if (posNudge !== 0 || negNudge !== 0) {
      positive += posNudge;
      negative += negNudge;
      parts.push(`macro nudge ${posNudge >= 0 ? '+' : ''}${posNudge}/${negNudge >= 0 ? '+' : ''}${negNudge}`);
    }

    const role = coinId === goldenId ? 'GOLDEN' : coinId === demonId ? 'DEMON' : null;
    if (role === 'GOLDEN') {
      positive += 1;
      parts.push('golden positive bias');
    } else if (role === 'DEMON') {
      negative += 1;
      parts.push('demon negative bias');
    }

    // Floors first (both directions always possible), then the caps.
    positive = clampInteger(positive, 1, posCap);
    negative = clampInteger(negative, 1, negCap);

    // The Wave 1 TOTAL cap: trim the direction the mode favours LEAST,
    // one at a time, never below the floors. NORMAL favours neither
    // direction, so the deterministic tie-break trims negative first: a
    // 2/2 split under a 3-total cap resolves to 2 positive/1 negative.
    const favoured = decision.mode === 'BUST' ? 'negative' : 'positive';
    while (positive + negative > totalCap) {
      if (favoured === 'negative' && positive > 1) positive -= 1;
      else if (favoured === 'positive' && negative > 1) negative -= 1;
      else if (positive >= negative && positive > 1) positive -= 1;
      else if (negative > 1) negative -= 1;
      else break; // both at floor 1 and still over the cap: the floors cannot fit — the function throws loudly below
    }
    if (positive + negative > totalCap) {
      throw new Error(`adaptive event plan cannot satisfy the total cap ${totalCap} for coin ${coinId} within the per-direction floors`);
    }

    plan.push({
      coinId,
      targetPositive: positive,
      targetNegative: negative,
      role,
      reason: parts.join('; ')
    });
  }

  plan.sort((a, b) => a.coinId - b.coinId);
  return plan;
}

module.exports = {
  planAdaptiveEventTargets
};
