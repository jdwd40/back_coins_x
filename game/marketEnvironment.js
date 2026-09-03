// Persistent-market Stage 2 (master plan §8-10): the single Market
// Environment seam.
//
// One coherent environment structure is the ONLY way broad market
// conditions reach the persistent pricing composition, the coin-event /
// signal layers and (later) the persistent collapse-risk domain. It
// REPLACES the obsolete Apocalypse pressure inputs — apocalypse
// percentage, late-game escalation, one-way lifecycle pressure and
// Apocalypse volatility are never inputs to the persistent path (no fake
// apocalypsePercent = 0 anywhere).
//
// The environment is supplied by a PROVIDER: a pure, deterministic object
// with environmentAt(nowMs). Stage 2 ships the deterministic NEUTRAL
// provider (the structural default: no bias, unit scales). Stage 3's
// Market Director is a second provider behind this exact seam; pricing
// never knows which provider it is evaluating.
//
// Fields (master plan §9, project camelCase style):
//   structuralBias            expected log drift per day added to the
//                             coin's structural walk (0 in neutral).
//   volatilityScale           scales cycle deviation-from-anchor and
//                             short-term noise (1 in neutral).
//   positiveEventBias         shifts coin-event direction selection toward
//                             positive (0 in neutral; consumed by the
//                             event layer, never by pricing directly).
//   negativeEventBias         shifts coin-event direction selection toward
//                             negative (0 in neutral).
//   eventSeverityScale        scales coin-event strength draws (1 in neutral).
//   crashProbabilityModifier  multiplies the persistent base crash
//                             probability (1 in neutral).
//   recoveryModifier          scales rally recovery strength (1 in neutral).
//   collapseRiskModifier      scales the persistent death/collapse risk
//                             (1 in neutral; consumed by the collapse-risk
//                             domain, never by pricing directly).
//
// Determinism contract: no Math.random(), no wall-clock reads, no
// database access. A provider's environmentAt(nowMs) is a pure function
// of its own seeded state and the injected instant — bots never see the
// provider, its rolls, or any future environment (master plan §10).
//
// This module never requires any database or service module.

// Validation bounds. These are SAFETY bounds on any provider's output,
// not gameplay tuning: an environment outside them is a broken provider
// and fails loudly instead of repricing the market.
const BOUNDS = Object.freeze({
  structuralBias: Object.freeze({ min: -0.5, max: 0.5 }), // log/day
  volatilityScale: Object.freeze({ min: 0.1, max: 4 }),
  positiveEventBias: Object.freeze({ min: -0.5, max: 0.5 }),
  negativeEventBias: Object.freeze({ min: -0.5, max: 0.5 }),
  eventSeverityScale: Object.freeze({ min: 0.1, max: 4 }),
  crashProbabilityModifier: Object.freeze({ min: 0, max: 4 }),
  recoveryModifier: Object.freeze({ min: 0, max: 2 }),
  collapseRiskModifier: Object.freeze({ min: 0, max: 4 })
});

const ENVIRONMENT_KEYS = Object.freeze(Object.keys(BOUNDS));

// The deterministic neutral/default environment (Stage 2): structurally
// unbiased, unit scales — approximately zero expected log drift, baseline
// crash/recovery behaviour, unmodified event and risk layers.
const NEUTRAL_ENVIRONMENT = Object.freeze({
  structuralBias: 0,
  volatilityScale: 1,
  positiveEventBias: 0,
  negativeEventBias: 0,
  eventSeverityScale: 1,
  crashProbabilityModifier: 1,
  recoveryModifier: 1,
  collapseRiskModifier: 1
});

// Loud structural validation: exact key set, every value finite and inside
// the safety bounds. A corrupt environment can never silently bias the
// market. Returns the environment unchanged.
function assertMarketEnvironment(environment) {
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) {
    throw new Error('market environment must be an object');
  }
  const keys = Object.keys(environment).sort();
  const expected = ENVIRONMENT_KEYS.slice().sort();
  if (keys.length !== expected.length || !keys.every((k, i) => k === expected[i])) {
    throw new Error(`market environment must have exactly the keys { ${expected.join(', ')} }; received { ${keys.join(', ')} }`);
  }
  for (const key of ENVIRONMENT_KEYS) {
    const value = environment[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`market environment ${key} must be a finite number; received ${String(value)}`);
    }
    const { min, max } = BOUNDS[key];
    if (value < min || value > max) {
      throw new Error(`market environment ${key} must be within [${min}, ${max}]; received ${value}`);
    }
  }
  return environment;
}

// Validate a provider: an object carrying environmentAt(nowMs) -> a valid
// environment. The provider id (when present) is diagnostic only.
function assertEnvironmentProvider(provider) {
  if (!provider || typeof provider !== 'object' || Array.isArray(provider)) {
    throw new Error('market environment provider must be an object');
  }
  if (typeof provider.environmentAt !== 'function') {
    throw new Error('market environment provider must expose environmentAt(nowMs)');
  }
  return provider;
}

// Resolve the environment for one instant from a provider (or pass a
// literal environment through after validation). Both call shapes are
// validated loudly.
function resolveEnvironment(providerOrEnvironment, nowMs) {
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) {
    throw new Error(`market environment nowMs must be a finite number; received ${String(nowMs)}`);
  }
  if (providerOrEnvironment && typeof providerOrEnvironment.environmentAt === 'function') {
    return assertMarketEnvironment(providerOrEnvironment.environmentAt(nowMs));
  }
  return assertMarketEnvironment(providerOrEnvironment);
}

// The Stage 2 deterministic neutral/default provider: the same frozen
// neutral environment at every instant. environmentAt ignores time by
// construction — neutral conditions never vary.
function createNeutralEnvironmentProvider() {
  return Object.freeze({
    id: 'NEUTRAL',
    environmentAt(nowMs) {
      if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) {
        throw new Error(`neutral environment provider nowMs must be a finite number; received ${String(nowMs)}`);
      }
      return NEUTRAL_ENVIRONMENT;
    }
  });
}

module.exports = {
  ENVIRONMENT_KEYS,
  BOUNDS,
  NEUTRAL_ENVIRONMENT,
  assertMarketEnvironment,
  assertEnvironmentProvider,
  resolveEnvironment,
  createNeutralEnvironmentProvider
};
