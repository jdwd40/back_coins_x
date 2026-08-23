// Crypto Chaos issue #18: centralized, validated economy configuration.
//
// This module is the ONLY place the passive-drain runtime knobs are
// resolved. The game-design defaults live once in gameConstants.js; every
// knob can be overridden by an environment variable and is validated on
// every resolution — malformed values are configuration errors and are
// REJECTED, never silently clamped or coerced (the botConfig.js pattern).

const {
  GAME_FEE_TICK_INTERVAL_MS,
  GAME_FEE_AMOUNT,
  GAME_TAX_TICK_INTERVAL_MS,
  GAME_TAX_AMOUNT,
  GAME_EVENT_COUNT,
  GAME_EVENT_MIN_FRACTION,
  GAME_EVENT_MAX_FRACTION,
  GAME_EVENT_MIN_AMOUNT,
  GAME_EVENT_MAX_AMOUNT,
  GAME_ECONOMY_WORKER_INTERVAL_MS
} = require('./gameConstants');

// Public, player-safe flavor text for Apocalypse events. Exactly which
// description a given event gets is decided deterministically from the
// cycle seed at schedule creation; nothing here reveals timing or amounts
// ahead of execution.
const EVENT_DESCRIPTIONS = Object.freeze([
  'Apocalypse event: exchange withdrawal freeze levy',
  'Apocalypse event: network congestion surcharge',
  'Apocalypse event: emergency protocol toll',
  'Apocalypse event: market circuit-breaker fee',
  'Apocalypse event: liquidity crisis levy',
  'Apocalypse event: vault maintenance charge'
]);

// Explicit bounds for operator-configured values. Anything outside these
// ranges is a configuration error, not a value to silently clamp.
const MIN_ECONOMY_TICK_INTERVAL_MS = 60 * 1000; // 1 minute
const MAX_ECONOMY_TICK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const MIN_ECONOMY_WORKER_INTERVAL_MS = 1000; // 1 second
const MAX_ECONOMY_WORKER_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const MIN_ECONOMY_AMOUNT = 0.01; // one penny
const MAX_ECONOMY_AMOUNT = 500; // a single charge never exceeds 5% of starting cash
const MAX_EVENT_COUNT = 20;

// Parse a string/number env value into a number, rejecting anything that is
// not an exact numeric representation.
function parseNumber(raw, name) {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!/^[+-]?\d+(\.\d+)?$/.test(trimmed)) {
      throw new Error(`${name} must be a number; received ${JSON.stringify(raw)}`);
    }
    return Number(trimmed);
  }
  if (typeof raw !== 'number' || Number.isNaN(raw)) {
    throw new Error(`${name} must be a number; received ${typeof raw === 'string' ? JSON.stringify(raw) : String(raw)}`);
  }
  return raw;
}

// Validate a configured tick/worker interval: a finite integer number of
// milliseconds within [min, max]. Absent (undefined / empty string) yields
// the default.
function validateIntervalMs(raw, name, defaultValue, min, max) {
  if (raw === undefined || raw === null) return defaultValue;
  if (typeof raw === 'string' && raw.trim() === '') return defaultValue;

  const value = parseNumber(raw, name);
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be finite; received ${String(raw)}`);
  }
  if (!Number.isInteger(value)) {
    throw new Error(`${name} must be an integer; received ${String(raw)}`);
  }
  if (value < min) {
    throw new Error(`${name} ${value} is below the minimum of ${min}ms`);
  }
  if (value > max) {
    throw new Error(`${name} ${value} exceeds the maximum of ${max}ms`);
  }
  return value;
}

// Validate a configured charge amount: a finite money amount with at most 2
// decimal places (exact DECIMAL(18,2) precision), strictly positive and
// bounded — a single passive charge above the bound is a configuration
// error, not game balance.
function validateMoneyAmount(raw, name, defaultValue) {
  if (raw === undefined || raw === null) return defaultValue;
  if (typeof raw === 'string' && raw.trim() === '') return defaultValue;

  const value = parseNumber(raw, name);
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be finite; received ${String(raw)}`);
  }
  const scaled = value * 100;
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(scaled)) * 4;
  if (Math.abs(scaled - Math.round(scaled)) > tolerance) {
    throw new Error(`${name} must have at most two decimal places (exact 2-decimal money precision); received ${value}`);
  }
  if (value < MIN_ECONOMY_AMOUNT) {
    throw new Error(`${name} ${value} is below the minimum of ${MIN_ECONOMY_AMOUNT}`);
  }
  if (value > MAX_ECONOMY_AMOUNT) {
    throw new Error(`${name} ${value} exceeds the maximum of ${MAX_ECONOMY_AMOUNT}`);
  }
  return value;
}

// Validate the per-cycle event count: a finite integer within bounds. Zero
// is a valid explicit choice (no events); negatives never are.
function validateEventCount(raw) {
  if (raw === undefined || raw === null) return GAME_EVENT_COUNT;
  if (typeof raw === 'string' && raw.trim() === '') return GAME_EVENT_COUNT;

  const value = parseNumber(raw, 'GAME_EVENT_COUNT');
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`GAME_EVENT_COUNT must be an integer; received ${String(raw)}`);
  }
  if (value < 0) {
    throw new Error(`GAME_EVENT_COUNT must be nonnegative; received ${value}`);
  }
  if (value > MAX_EVENT_COUNT) {
    throw new Error(`GAME_EVENT_COUNT ${value} exceeds the maximum of ${MAX_EVENT_COUNT}`);
  }
  return value;
}

// Validate an event schedule fraction of the cycle duration: a finite
// number in [0, 1).
function validateEventFraction(raw, name, defaultValue) {
  if (raw === undefined || raw === null) return defaultValue;
  if (typeof raw === 'string' && raw.trim() === '') return defaultValue;

  const value = parseNumber(raw, name);
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be finite; received ${String(raw)}`);
  }
  if (value < 0 || value >= 1) {
    throw new Error(`${name} must be in [0, 1); received ${value}`);
  }
  return value;
}

// Strict boolean parsing: absent means enabled; only the explicit strings
// 'true'/'false' are accepted. Anything else is a configuration error.
function validateEconomyEnabled(raw) {
  if (raw === undefined || raw === null) return true;
  if (typeof raw === 'string' && raw.trim() === '') return true;
  if (raw === true || raw === 'true') return true;
  if (raw === false || raw === 'false') return false;
  throw new Error(`GAME_ECONOMY_ENABLED must be "true" or "false"; received ${JSON.stringify(raw)}`);
}

// Resolve the effective economy runtime config. Validation runs on every
// resolution, so a bad config throws before any tick can run on it.
function resolveEconomyConfig(env = process.env) {
  const eventMinFraction = validateEventFraction(env.GAME_EVENT_MIN_FRACTION, 'GAME_EVENT_MIN_FRACTION', GAME_EVENT_MIN_FRACTION);
  const eventMaxFraction = validateEventFraction(env.GAME_EVENT_MAX_FRACTION, 'GAME_EVENT_MAX_FRACTION', GAME_EVENT_MAX_FRACTION);
  if (eventMaxFraction <= eventMinFraction) {
    throw new Error(`GAME_EVENT_MAX_FRACTION (${eventMaxFraction}) must be greater than GAME_EVENT_MIN_FRACTION (${eventMinFraction})`);
  }
  const eventMinAmount = validateMoneyAmount(env.GAME_EVENT_MIN_AMOUNT, 'GAME_EVENT_MIN_AMOUNT', GAME_EVENT_MIN_AMOUNT);
  const eventMaxAmount = validateMoneyAmount(env.GAME_EVENT_MAX_AMOUNT, 'GAME_EVENT_MAX_AMOUNT', GAME_EVENT_MAX_AMOUNT);
  if (eventMaxAmount < eventMinAmount) {
    throw new Error(`GAME_EVENT_MAX_AMOUNT (${eventMaxAmount}) must be at least GAME_EVENT_MIN_AMOUNT (${eventMinAmount})`);
  }
  return {
    enabled: validateEconomyEnabled(env.GAME_ECONOMY_ENABLED),
    feeTickIntervalMs: validateIntervalMs(env.GAME_FEE_TICK_INTERVAL_MS, 'GAME_FEE_TICK_INTERVAL_MS', GAME_FEE_TICK_INTERVAL_MS, MIN_ECONOMY_TICK_INTERVAL_MS, MAX_ECONOMY_TICK_INTERVAL_MS),
    feeAmount: validateMoneyAmount(env.GAME_FEE_AMOUNT, 'GAME_FEE_AMOUNT', GAME_FEE_AMOUNT),
    taxTickIntervalMs: validateIntervalMs(env.GAME_TAX_TICK_INTERVAL_MS, 'GAME_TAX_TICK_INTERVAL_MS', GAME_TAX_TICK_INTERVAL_MS, MIN_ECONOMY_TICK_INTERVAL_MS, MAX_ECONOMY_TICK_INTERVAL_MS),
    taxAmount: validateMoneyAmount(env.GAME_TAX_AMOUNT, 'GAME_TAX_AMOUNT', GAME_TAX_AMOUNT),
    eventCount: validateEventCount(env.GAME_EVENT_COUNT),
    eventMinFraction,
    eventMaxFraction,
    eventMinAmount,
    eventMaxAmount,
    workerIntervalMs: validateIntervalMs(env.GAME_ECONOMY_WORKER_INTERVAL_MS, 'GAME_ECONOMY_WORKER_INTERVAL_MS', GAME_ECONOMY_WORKER_INTERVAL_MS, MIN_ECONOMY_WORKER_INTERVAL_MS, MAX_ECONOMY_WORKER_INTERVAL_MS)
  };
}

module.exports = {
  EVENT_DESCRIPTIONS,
  MIN_ECONOMY_TICK_INTERVAL_MS,
  MAX_ECONOMY_TICK_INTERVAL_MS,
  MIN_ECONOMY_WORKER_INTERVAL_MS,
  MAX_ECONOMY_WORKER_INTERVAL_MS,
  MIN_ECONOMY_AMOUNT,
  MAX_ECONOMY_AMOUNT,
  MAX_EVENT_COUNT,
  validateIntervalMs,
  validateMoneyAmount,
  validateEventCount,
  validateEventFraction,
  validateEconomyEnabled,
  resolveEconomyConfig
};
