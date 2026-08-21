// Crypto Chaos Core 5: centralized, validated bot configuration.
//
// This module is the ONLY place the bot roster and bot runtime knobs are
// defined. The roster is exactly 4 stable bots with unique identities and
// deterministically distinct strategies — the canonical Core 5 personalities
// Conservative, Momentum, Dip Buyer and Reckless; it is validated at module
// load, so a malformed roster fails the process before any bot row can be
// created. Runtime knobs come from environment variables and are validated
// on every resolution — malformed values are configuration errors and are
// REJECTED, never silently clamped or coerced.

// The canonical Core 5 personality identifiers. The same set is enforced in
// the database by migration 010's CHECK constraint on
// apocalypse_bots.strategy.
const BOT_STRATEGIES = Object.freeze(['conservative', 'momentum', 'dip_buyer', 'reckless']);

// The fixed game roster: exactly 4 bots, stable keys/usernames/emails.
// Usernames/emails are deliberately namespaced so they can never collide
// with a real human registration flow that does not use the bot namespace.
const BOT_ROSTER = Object.freeze([
  Object.freeze({
    botKey: 'conservative-carl',
    displayName: 'Conservative',
    username: 'bot_conservative_carl',
    email: 'bot_conservative_carl@bots.coinsx.invalid',
    strategy: 'conservative'
  }),
  Object.freeze({
    botKey: 'momentum-mike',
    displayName: 'Momentum',
    username: 'bot_momentum_mike',
    email: 'bot_momentum_mike@bots.coinsx.invalid',
    strategy: 'momentum'
  }),
  Object.freeze({
    botKey: 'dip-buyer-dana',
    displayName: 'Dip Buyer',
    username: 'bot_dip_buyer_dana',
    email: 'bot_dip_buyer_dana@bots.coinsx.invalid',
    strategy: 'dip_buyer'
  }),
  Object.freeze({
    botKey: 'reckless-ray',
    displayName: 'Reckless',
    username: 'bot_reckless_ray',
    email: 'bot_reckless_ray@bots.coinsx.invalid',
    strategy: 'reckless'
  })
]);

// Validate the roster itself. Called at module load: a bad roster is a
// build-time bug, so it throws immediately rather than at first tick.
function validateBotRoster(roster = BOT_ROSTER) {
  if (!Array.isArray(roster) || roster.length !== 4) {
    throw new Error(`BOT_ROSTER must contain exactly 4 bots; received ${Array.isArray(roster) ? roster.length : typeof roster}`);
  }
  const seen = { botKey: new Set(), username: new Set(), email: new Set(), strategy: new Set() };
  for (const bot of roster) {
    for (const field of ['botKey', 'displayName', 'username', 'email', 'strategy']) {
      if (typeof bot[field] !== 'string' || bot[field].trim() === '') {
        throw new Error(`BOT_ROSTER entry is missing a non-empty ${field}`);
      }
    }
    if (!BOT_STRATEGIES.includes(bot.strategy)) {
      throw new Error(`BOT_ROSTER strategy must be one of ${BOT_STRATEGIES.join(', ')}; received ${JSON.stringify(bot.strategy)}`);
    }
    if (bot.username.length > 50) throw new Error(`BOT_ROSTER username exceeds the users.username column limit: ${bot.username}`);
    if (bot.email.length > 100) throw new Error(`BOT_ROSTER email exceeds the users.email column limit: ${bot.email}`);
    if (bot.botKey.length > 40) throw new Error(`BOT_ROSTER botKey exceeds the apocalypse_bots.bot_key column limit: ${bot.botKey}`);
    for (const field of ['botKey', 'username', 'email', 'strategy']) {
      if (seen[field].has(bot[field])) {
        throw new Error(`BOT_ROSTER ${field} must be unique; duplicated ${JSON.stringify(bot[field])}`);
      }
      seen[field].add(bot[field]);
    }
  }
  return roster;
}

// ---------------------------------------------------------------------------
// Runtime knobs. Every knob has a safe default and explicit bounds; any
// present-but-invalid value is a configuration error, never silently clamped.
// ---------------------------------------------------------------------------

// Default scheduler wakeups: one bot tick per minute.
const DEFAULT_BOT_TICK_INTERVAL_MS = 60 * 1000;
// Explicit bounds for an operator-configured tick interval. Anything outside
// this range is a configuration error, not a value to silently clamp.
const MIN_BOT_TICK_INTERVAL_MS = 1000; // 1 second
const MAX_BOT_TICK_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

// Per-trade size cap (pounds). Default caps one bot trade at a quarter of
// the £1,000 starting cash; the upper bound is the entire starting bankroll —
// a "cap" above it would cap nothing.
const DEFAULT_BOT_MAX_TRADE_SIZE = 250;
const MIN_BOT_MAX_TRADE_SIZE = 1;
const MAX_BOT_MAX_TRADE_SIZE = 1000;

// Per-bot cooldown between executed actions. Default matches the default
// tick interval so a bot acts at most once per tick out of the box. Zero is
// a valid explicit choice (no cooldown); negatives never are.
const DEFAULT_BOT_COOLDOWN_MS = 60 * 1000;
const MAX_BOT_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

// Maximum bot actions executed in a single tick. Each roster bot can act at
// most once per tick, so the upper bound is the roster size.
const DEFAULT_BOT_MAX_ACTIONS_PER_TICK = BOT_ROSTER.length;
const MIN_BOT_MAX_ACTIONS_PER_TICK = 1;
const MAX_BOT_MAX_ACTIONS_PER_TICK = BOT_ROSTER.length;

// Parse a string/number env value into an integer number of milliseconds,
// rejecting anything that is not an exact integer representation.
function parseIntegerMs(raw, name) {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!/^[+-]?\d+$/.test(trimmed)) {
      throw new Error(`${name} must be an integer number of milliseconds; received ${JSON.stringify(raw)}`);
    }
    return Number(trimmed);
  }
  if (typeof raw !== 'number' || Number.isNaN(raw)) {
    throw new Error(`${name} must be a number of milliseconds; received ${typeof raw === 'string' ? JSON.stringify(raw) : String(raw)}`);
  }
  return raw;
}

// Validate a configured tick interval. Absent (undefined / empty string)
// means "not configured" and yields the default. Any present-but-invalid
// value — fractional, zero, negative, NaN, Infinity, non-numeric, below the
// minimum or above the maximum — throws a clear error immediately.
function validateBotTickIntervalMs(raw) {
  if (raw === undefined || raw === null) return DEFAULT_BOT_TICK_INTERVAL_MS;
  if (typeof raw === 'string' && raw.trim() === '') return DEFAULT_BOT_TICK_INTERVAL_MS;

  const value = parseIntegerMs(raw, 'GAME_BOT_TICK_INTERVAL_MS');
  if (!Number.isFinite(value)) {
    throw new Error(`GAME_BOT_TICK_INTERVAL_MS must be finite; received ${String(raw)}`);
  }
  if (!Number.isInteger(value)) {
    throw new Error(`GAME_BOT_TICK_INTERVAL_MS must be an integer; received ${String(raw)}`);
  }
  if (value < MIN_BOT_TICK_INTERVAL_MS) {
    throw new Error(
      `GAME_BOT_TICK_INTERVAL_MS ${value} is below the minimum of ${MIN_BOT_TICK_INTERVAL_MS}ms`
    );
  }
  if (value > MAX_BOT_TICK_INTERVAL_MS) {
    throw new Error(
      `GAME_BOT_TICK_INTERVAL_MS ${value} exceeds the maximum of ${MAX_BOT_TICK_INTERVAL_MS}ms`
    );
  }
  return value;
}

// Validate the per-trade size cap: a finite money amount with at most 2
// decimal places, strictly positive and safely bounded — a cap above the
// entire starting bankroll caps nothing and is a configuration error.
function validateBotMaxTradeSize(raw) {
  if (raw === undefined || raw === null) return DEFAULT_BOT_MAX_TRADE_SIZE;
  if (typeof raw === 'string' && raw.trim() === '') return DEFAULT_BOT_MAX_TRADE_SIZE;

  let value = raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!/^[+-]?\d+(\.\d{1,2})?$/.test(trimmed)) {
      throw new Error(
        `GAME_BOT_MAX_TRADE_SIZE must be a money amount with at most 2 decimal places; received ${JSON.stringify(raw)}`
      );
    }
    value = Number(trimmed);
  }
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new Error(`GAME_BOT_MAX_TRADE_SIZE must be a finite number; received ${String(raw)}`);
  }
  if (!Number.isFinite(value)) {
    throw new Error(`GAME_BOT_MAX_TRADE_SIZE must be finite; received ${String(raw)}`);
  }
  if (Math.round(value * 100) !== value * 100) {
    throw new Error(`GAME_BOT_MAX_TRADE_SIZE must have at most 2 decimal places; received ${String(raw)}`);
  }
  if (value < MIN_BOT_MAX_TRADE_SIZE) {
    throw new Error(
      `GAME_BOT_MAX_TRADE_SIZE ${value} is below the minimum of ${MIN_BOT_MAX_TRADE_SIZE}`
    );
  }
  if (value > MAX_BOT_MAX_TRADE_SIZE) {
    throw new Error(
      `GAME_BOT_MAX_TRADE_SIZE ${value} exceeds the maximum of ${MAX_BOT_MAX_TRADE_SIZE}`
    );
  }
  return value;
}

// Validate the per-bot cooldown: a finite integer number of milliseconds,
// nonnegative (zero explicitly disables the cooldown) and bounded.
function validateBotCooldownMs(raw) {
  if (raw === undefined || raw === null) return DEFAULT_BOT_COOLDOWN_MS;
  if (typeof raw === 'string' && raw.trim() === '') return DEFAULT_BOT_COOLDOWN_MS;

  const value = parseIntegerMs(raw, 'GAME_BOT_COOLDOWN_MS');
  if (!Number.isFinite(value)) {
    throw new Error(`GAME_BOT_COOLDOWN_MS must be finite; received ${String(raw)}`);
  }
  if (!Number.isInteger(value)) {
    throw new Error(`GAME_BOT_COOLDOWN_MS must be an integer; received ${String(raw)}`);
  }
  if (value < 0) {
    throw new Error(`GAME_BOT_COOLDOWN_MS must be nonnegative; received ${value}`);
  }
  if (value > MAX_BOT_COOLDOWN_MS) {
    throw new Error(
      `GAME_BOT_COOLDOWN_MS ${value} exceeds the maximum of ${MAX_BOT_COOLDOWN_MS}ms`
    );
  }
  return value;
}

// Validate the maximum number of bot actions executed in a single tick: a
// finite integer within the roster bounds (each bot acts at most once).
function validateBotMaxActionsPerTick(raw) {
  if (raw === undefined || raw === null) return DEFAULT_BOT_MAX_ACTIONS_PER_TICK;
  if (typeof raw === 'string' && raw.trim() === '') return DEFAULT_BOT_MAX_ACTIONS_PER_TICK;

  const value = parseIntegerMs(raw, 'GAME_BOT_MAX_ACTIONS_PER_TICK');
  if (!Number.isFinite(value)) {
    throw new Error(`GAME_BOT_MAX_ACTIONS_PER_TICK must be finite; received ${String(raw)}`);
  }
  if (!Number.isInteger(value)) {
    throw new Error(`GAME_BOT_MAX_ACTIONS_PER_TICK must be an integer; received ${String(raw)}`);
  }
  if (value < MIN_BOT_MAX_ACTIONS_PER_TICK) {
    throw new Error(
      `GAME_BOT_MAX_ACTIONS_PER_TICK ${value} is below the minimum of ${MIN_BOT_MAX_ACTIONS_PER_TICK}`
    );
  }
  if (value > MAX_BOT_MAX_ACTIONS_PER_TICK) {
    throw new Error(
      `GAME_BOT_MAX_ACTIONS_PER_TICK ${value} exceeds the maximum of ${MAX_BOT_MAX_ACTIONS_PER_TICK} (one action per roster bot per tick)`
    );
  }
  return value;
}

// Strict boolean parsing: absent means enabled; only the explicit strings
// 'true'/'false' are accepted. Anything else is a configuration error.
function validateBotsEnabled(raw) {
  if (raw === undefined || raw === null) return true;
  if (typeof raw === 'string' && raw.trim() === '') return true;
  if (raw === true || raw === 'true') return true;
  if (raw === false || raw === 'false') return false;
  throw new Error(`GAME_BOTS_ENABLED must be "true" or "false"; received ${JSON.stringify(raw)}`);
}

// Resolve the effective bot runtime config. Validation runs on every
// resolution, so a bad config throws before any tick can run on it.
function resolveBotConfig(env = process.env) {
  return {
    enabled: validateBotsEnabled(env.GAME_BOTS_ENABLED),
    tickIntervalMs: validateBotTickIntervalMs(env.GAME_BOT_TICK_INTERVAL_MS),
    maxTradeSize: validateBotMaxTradeSize(env.GAME_BOT_MAX_TRADE_SIZE),
    cooldownMs: validateBotCooldownMs(env.GAME_BOT_COOLDOWN_MS),
    maxActionsPerTick: validateBotMaxActionsPerTick(env.GAME_BOT_MAX_ACTIONS_PER_TICK)
  };
}

// Module-load roster validation: a malformed roster can never reach a tick.
validateBotRoster();

module.exports = {
  BOT_STRATEGIES,
  BOT_ROSTER,
  validateBotRoster,
  DEFAULT_BOT_TICK_INTERVAL_MS,
  MIN_BOT_TICK_INTERVAL_MS,
  MAX_BOT_TICK_INTERVAL_MS,
  DEFAULT_BOT_MAX_TRADE_SIZE,
  MIN_BOT_MAX_TRADE_SIZE,
  MAX_BOT_MAX_TRADE_SIZE,
  DEFAULT_BOT_COOLDOWN_MS,
  MAX_BOT_COOLDOWN_MS,
  DEFAULT_BOT_MAX_ACTIONS_PER_TICK,
  MIN_BOT_MAX_ACTIONS_PER_TICK,
  MAX_BOT_MAX_ACTIONS_PER_TICK,
  validateBotTickIntervalMs,
  validateBotMaxTradeSize,
  validateBotCooldownMs,
  validateBotMaxActionsPerTick,
  validateBotsEnabled,
  resolveBotConfig
};
