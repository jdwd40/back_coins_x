// Persistent-market Stage 9 (S9-02): authored replacement-coin pool.
//
// When a coin permanently dies (S9-01 ownership), a NEW coin identity may
// later enter the market (S9-03 ownership). This module is the SINGLE
// source of truth for:
//   * the authored replacement roster (stable order, unique coin_ids);
//   * the configurable replacement delay and target active-market size;
//   * load-time validation (mandatory explicit archetype; no silent MOON
//     or any other default; historical coin_id values never reused).
//
// Pure and deterministic: no database, no Math.random, no Date.now, no
// environment reads. Validation happens at module load for the defaults
// and again whenever callers pass an override. This module never inserts
// coins and never schedules runtime replacement — S9-03 consumes the
// exported helpers to pick the next unused authored definition and apply
// the configured delay.
//
// Migration 029 is NOT required: the roster lives as authored config (like
// simulationConfig / botConfig). Identity uniqueness is enforced against
// the reserved historical set (canonical 1..10 + retired legacy 11..13)
// plus any additional historicalIds the caller supplies at validation time.

const { MARKET_ARCHETYPES, GAMEPLAY_ROSTER } = require('./marketDomain');

// Exact archetype vocabulary — same keys as MARKET_ARCHETYPES / ARCHETYPE_RISK.
const VALID_ARCHETYPE_IDS = Object.freeze(Object.keys(MARKET_ARCHETYPES));

const HOUR_MS = 60 * 60 * 1000;

// Historical identities that MUST never be reused as replacements.
//   * coin_ids 1..10 — the live canonical catalogue (migrations 013/014)
//   * coin_ids 11..13 — retired legacy seed-only coins (migration 014)
const HISTORICAL_RESERVED_COIN_IDS = Object.freeze([
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13
]);

// Authored replacement definitions. coin_ids start at 101 so they never
// collide with historical 1..13 and leave room for any intervening ids.
// Stable array order is the consumption order for peekNextReplacement.
// Distribution mirrors the live roster (~two of each core archetype, with
// extra DEGEN/RUG wildcards so deaths can be refilled without recycling).
const AUTHORED_REPLACEMENT_ROSTER = Object.freeze([
  Object.freeze({
    coinId: 101,
    name: 'PulseLedger',
    symbol: 'PLD',
    description: 'Authored ZIP replacement — short-cycle bread-and-butter coin.',
    startingPrice: 0.12,
    marketCap: 8000,
    circulatingSupply: 4000,
    founder: 'Stage9 Authored',
    archetype: 'ZIP'
  }),
  Object.freeze({
    coinId: 102,
    name: 'NanoForge',
    symbol: 'NFR',
    description: 'Authored ZIP replacement — second short-cycle spare.',
    startingPrice: 0.15,
    marketCap: 9000,
    circulatingSupply: 4500,
    founder: 'Stage9 Authored',
    archetype: 'ZIP'
  }),
  Object.freeze({
    coinId: 103,
    name: 'OrbitCash',
    symbol: 'ORB',
    description: 'Authored MOON replacement — mid-tempo swing coin.',
    startingPrice: 1.40,
    marketCap: 16000,
    circulatingSupply: 5000,
    founder: 'Stage9 Authored',
    archetype: 'MOON'
  }),
  Object.freeze({
    coinId: 104,
    name: 'LumenVault',
    symbol: 'LMV',
    description: 'Authored MOON replacement — second mid-tempo spare.',
    startingPrice: 1.75,
    marketCap: 17500,
    circulatingSupply: 5200,
    founder: 'Stage9 Authored',
    archetype: 'MOON'
  }),
  Object.freeze({
    coinId: 105,
    name: 'Bullwark',
    symbol: 'BWK',
    description: 'Authored BULL replacement — slower larger swings.',
    startingPrice: 28.50,
    marketCap: 22000,
    circulatingSupply: 3000,
    founder: 'Stage9 Authored',
    archetype: 'BULL'
  }),
  Object.freeze({
    coinId: 106,
    name: 'RidgeChain',
    symbol: 'RGC',
    description: 'Authored BULL replacement — second larger-swing spare.',
    startingPrice: 31.20,
    marketCap: 24000,
    circulatingSupply: 2800,
    founder: 'Stage9 Authored',
    archetype: 'BULL'
  }),
  Object.freeze({
    coinId: 107,
    name: 'AnchorHodl',
    symbol: 'AHD',
    description: 'Authored HODL replacement — long-cycle heavyweight.',
    startingPrice: 55.00,
    marketCap: 30000,
    circulatingSupply: 2500,
    founder: 'Stage9 Authored',
    archetype: 'HODL'
  }),
  Object.freeze({
    coinId: 108,
    name: 'StoneReserve',
    symbol: 'SRV',
    description: 'Authored HODL replacement — second long-cycle spare.',
    startingPrice: 48.75,
    marketCap: 28000,
    circulatingSupply: 2600,
    founder: 'Stage9 Authored',
    archetype: 'HODL'
  }),
  Object.freeze({
    coinId: 109,
    name: 'ChaosSpark',
    symbol: 'CSK',
    description: 'Authored DEGEN replacement — irregular high-risk wildcard.',
    startingPrice: 0.25,
    marketCap: 7000,
    circulatingSupply: 6000,
    founder: 'Stage9 Authored',
    archetype: 'DEGEN'
  }),
  Object.freeze({
    coinId: 110,
    name: 'WildVolt',
    symbol: 'WVT',
    description: 'Authored DEGEN replacement — second irregular wildcard.',
    startingPrice: 0.40,
    marketCap: 8500,
    circulatingSupply: 5500,
    founder: 'Stage9 Authored',
    archetype: 'DEGEN'
  }),
  Object.freeze({
    coinId: 111,
    name: 'TrapDoor',
    symbol: 'TPD',
    description: 'Authored RUG replacement — widest irregular risk profile.',
    startingPrice: 0.18,
    marketCap: 6000,
    circulatingSupply: 7000,
    founder: 'Stage9 Authored',
    archetype: 'RUG'
  }),
  Object.freeze({
    coinId: 112,
    name: 'SinkHole',
    symbol: 'SNK',
    description: 'Authored RUG replacement — second irregular risk spare.',
    startingPrice: 0.22,
    marketCap: 6500,
    circulatingSupply: 6800,
    founder: 'Stage9 Authored',
    archetype: 'RUG'
  }),
  Object.freeze({
    coinId: 113,
    name: 'ZipStream',
    symbol: 'ZPS',
    description: 'Extra ZIP spare for sustained roster churn.',
    startingPrice: 0.11,
    marketCap: 7500,
    circulatingSupply: 4200,
    founder: 'Stage9 Authored',
    archetype: 'ZIP'
  }),
  Object.freeze({
    coinId: 114,
    name: 'MoonGlider',
    symbol: 'MGD',
    description: 'Extra MOON spare for sustained roster churn.',
    startingPrice: 2.10,
    marketCap: 18000,
    circulatingSupply: 4800,
    founder: 'Stage9 Authored',
    archetype: 'MOON'
  }),
  Object.freeze({
    coinId: 115,
    name: 'BullForge',
    symbol: 'BFR',
    description: 'Extra BULL spare for sustained roster churn.',
    startingPrice: 36.00,
    marketCap: 26000,
    circulatingSupply: 2700,
    founder: 'Stage9 Authored',
    archetype: 'BULL'
  }),
  Object.freeze({
    coinId: 116,
    name: 'DegenNova',
    symbol: 'DNV',
    description: 'Extra DEGEN spare for sustained roster churn.',
    startingPrice: 0.55,
    marketCap: 9000,
    circulatingSupply: 5800,
    founder: 'Stage9 Authored',
    archetype: 'DEGEN'
  })
]);

const DEFAULT_REPLACEMENT_CONFIG = Object.freeze({
  // Delay between a permanent death and the eligibility of the next
  // authored replacement (S9-03 schedules against this single value).
  replacementDelayMs: 6 * HOUR_MS,
  // Target size of the live active market (~10 coins).
  targetActiveCount: 10,
  roster: AUTHORED_REPLACEMENT_ROSTER
});

// ---------------------------------------------------------------------------
// Validation — everything throws; nothing is coerced or defaulted.
// ---------------------------------------------------------------------------

class ReplacementConfigError extends Error {
  constructor(message) {
    super(`Invalid replacement configuration: ${message}`);
    this.name = 'ReplacementConfigError';
  }
}

class ReplacementIdentityError extends Error {
  constructor(message) {
    super(`Replacement identity error: ${message}`);
    this.name = 'ReplacementIdentityError';
  }
}

function failConfig(message) {
  throw new ReplacementConfigError(message);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireFiniteNumber(name, value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    failConfig(`${name} must be a finite number; received ${typeof value === 'string' ? JSON.stringify(value) : String(value)}`);
  }
  return value;
}

function requirePositiveInteger(name, value) {
  requireFiniteNumber(name, value);
  if (!Number.isInteger(value) || value <= 0) {
    failConfig(`${name} must be a positive integer; received ${value}`);
  }
  return value;
}

function requireNonEmptyString(name, value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    failConfig(`${name} must be a non-empty string; received ${typeof value === 'string' ? JSON.stringify(value) : String(value)}`);
  }
  return value;
}

// Mandatory explicit archetype. Missing OR invalid fails LOUDLY.
// There is NO silent MOON (or any other) fallback — contrast marketDomain
// resolveArchetypeId, which must never be used for replacements.
function requireExplicitArchetype(name, archetype) {
  if (archetype === undefined || archetype === null) {
    failConfig(`${name}: archetype is mandatory and must be set explicitly (no silent default; MOON is never substituted)`);
  }
  if (typeof archetype !== 'string') {
    failConfig(`${name}: archetype must be a string; received ${typeof archetype}`);
  }
  if (!VALID_ARCHETYPE_IDS.includes(archetype)) {
    failConfig(`${name}: archetype ${JSON.stringify(archetype)} is not a valid archetype (expected one of ${VALID_ARCHETYPE_IDS.join(', ')}); no silent fallback applies`);
  }
  return archetype;
}

function getHistoricalReservedCoinIds() {
  return HISTORICAL_RESERVED_COIN_IDS.slice();
}

// Fail loudly when a coin_id collides with any historical/live identity.
function assertIdentityUnused(coinId, historicalIds = HISTORICAL_RESERVED_COIN_IDS) {
  const id = Number(coinId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new ReplacementIdentityError(`coinId must be a positive integer; received ${String(coinId)}`);
  }
  const reserved = historicalIds instanceof Set
    ? historicalIds
    : new Set(Array.from(historicalIds, Number));
  if (reserved.has(id)) {
    throw new ReplacementIdentityError(
      `coin_id ${id} collides with a historical or live identity; dead and live coin_ids are never reused`
    );
  }
  return id;
}

// Validate one authored replacement definition. Returns a frozen copy.
function validateReplacementDefinition(definition, {
  historicalIds = HISTORICAL_RESERVED_COIN_IDS,
  path = 'replacement'
} = {}) {
  if (!isPlainObject(definition)) {
    failConfig(`${path} must be an object; received ${Array.isArray(definition) ? 'array' : typeof definition}`);
  }

  const requiredKeys = [
    'coinId', 'name', 'symbol', 'description', 'startingPrice',
    'marketCap', 'circulatingSupply', 'founder', 'archetype'
  ];
  for (const key of requiredKeys) {
    if (!(key in definition)) {
      // Archetype absence is called out with the mandatory-archetype wording
      // so tests can pin "no silent MOON fallback" explicitly.
      if (key === 'archetype') {
        requireExplicitArchetype(`${path}.archetype`, definition.archetype);
      }
      failConfig(`${path} is missing required field ${key}`);
    }
  }

  const coinId = requirePositiveInteger(`${path}.coinId`, definition.coinId);
  assertIdentityUnused(coinId, historicalIds);

  requireNonEmptyString(`${path}.name`, definition.name);
  requireNonEmptyString(`${path}.symbol`, definition.symbol);
  if (definition.symbol.length > 10) {
    failConfig(`${path}.symbol exceeds the coins.symbol VARCHAR(10) limit`);
  }
  requireNonEmptyString(`${path}.description`, definition.description);
  requireNonEmptyString(`${path}.founder`, definition.founder);

  requireFiniteNumber(`${path}.startingPrice`, definition.startingPrice);
  if (!(definition.startingPrice > 0)) {
    failConfig(`${path}.startingPrice must be strictly positive; received ${definition.startingPrice}`);
  }
  requireFiniteNumber(`${path}.marketCap`, definition.marketCap);
  if (!(definition.marketCap > 0)) {
    failConfig(`${path}.marketCap must be strictly positive; received ${definition.marketCap}`);
  }
  requirePositiveInteger(`${path}.circulatingSupply`, definition.circulatingSupply);

  const archetype = requireExplicitArchetype(`${path}.archetype`, definition.archetype);

  return Object.freeze({
    coinId,
    name: definition.name.trim(),
    symbol: definition.symbol.trim().toUpperCase(),
    description: definition.description.trim(),
    startingPrice: definition.startingPrice,
    marketCap: definition.marketCap,
    circulatingSupply: definition.circulatingSupply,
    founder: definition.founder.trim(),
    archetype
  });
}

function validateReplacementConfig(config, { historicalIds = HISTORICAL_RESERVED_COIN_IDS } = {}) {
  if (!isPlainObject(config)) {
    failConfig(`config must be an object; received ${Array.isArray(config) ? 'array' : typeof config}`);
  }
  requirePositiveInteger('replacementDelayMs', config.replacementDelayMs);
  requirePositiveInteger('targetActiveCount', config.targetActiveCount);
  if (!Array.isArray(config.roster)) {
    failConfig(`roster must be an array; received ${typeof config.roster}`);
  }
  if (config.roster.length < config.targetActiveCount) {
    failConfig(
      `roster length ${config.roster.length} is below targetActiveCount ${config.targetActiveCount}; the pool must be large enough to refill the active market without recycling identities`
    );
  }

  const seenIds = new Set();
  const seenSymbols = new Set();
  const validated = [];
  for (let i = 0; i < config.roster.length; i++) {
    const entry = validateReplacementDefinition(config.roster[i], {
      historicalIds,
      path: `roster[${i}]`
    });
    if (seenIds.has(entry.coinId)) {
      failConfig(`roster has duplicate coinId ${entry.coinId}`);
    }
    if (seenSymbols.has(entry.symbol)) {
      failConfig(`roster has duplicate symbol ${entry.symbol}`);
    }
    seenIds.add(entry.coinId);
    seenSymbols.add(entry.symbol);
    validated.push(entry);
  }

  return Object.freeze({
    replacementDelayMs: config.replacementDelayMs,
    targetActiveCount: config.targetActiveCount,
    roster: Object.freeze(validated.slice())
  });
}

function deepFreezeRoster(config) {
  return validateReplacementConfig(config);
}

// Resolve effective config. Defaults validate at load; overrides re-validate.
function resolveReplacementConfig(overrides) {
  if (overrides === undefined || overrides === null) {
    return DEFAULT_REPLACEMENT_CONFIG;
  }
  if (!isPlainObject(overrides)) {
    failConfig(`overrides must be an object; received ${Array.isArray(overrides) ? 'array' : typeof overrides}`);
  }
  const merged = {
    replacementDelayMs: overrides.replacementDelayMs !== undefined
      ? overrides.replacementDelayMs
      : DEFAULT_REPLACEMENT_CONFIG.replacementDelayMs,
    targetActiveCount: overrides.targetActiveCount !== undefined
      ? overrides.targetActiveCount
      : DEFAULT_REPLACEMENT_CONFIG.targetActiveCount,
    roster: overrides.roster !== undefined
      ? overrides.roster
      : DEFAULT_REPLACEMENT_CONFIG.roster
  };
  return validateReplacementConfig(merged);
}

function getReplacementDelayMs(config = resolveReplacementConfig()) {
  const resolved = config === DEFAULT_REPLACEMENT_CONFIG
    ? config
    : resolveReplacementConfig(config);
  return resolved.replacementDelayMs;
}

function getTargetActiveCount(config = resolveReplacementConfig()) {
  const resolved = config === DEFAULT_REPLACEMENT_CONFIG
    ? config
    : resolveReplacementConfig(config);
  return resolved.targetActiveCount;
}

// Load the authored roster. Deterministic: same order and ids every call.
function loadReplacementRoster(config = resolveReplacementConfig()) {
  const resolved = config === DEFAULT_REPLACEMENT_CONFIG
    ? config
    : (Array.isArray(config) ? validateReplacementConfig({
      replacementDelayMs: DEFAULT_REPLACEMENT_CONFIG.replacementDelayMs,
      targetActiveCount: DEFAULT_REPLACEMENT_CONFIG.targetActiveCount,
      roster: config
    }) : resolveReplacementConfig(config));
  // Return a fresh shallow array of the frozen entries (order preserved).
  return resolved.roster.slice();
}

// Next unused authored definition in stable roster order.
// usedAuthoredIds: Set/Array of coinIds already consumed (inserted or reserved).
// Returns the definition or null when the pool is exhausted.
function peekNextReplacement(usedAuthoredIds = [], config = resolveReplacementConfig()) {
  const used = usedAuthoredIds instanceof Set
    ? usedAuthoredIds
    : new Set(Array.from(usedAuthoredIds, Number));
  const roster = loadReplacementRoster(config);
  for (const definition of roster) {
    if (!used.has(definition.coinId)) {
      return definition;
    }
  }
  return null;
}

// Live roster coin_ids (from marketDomain) — documented for S9-03 consumers.
function getLiveGameplayCoinIds() {
  return Array.from(GAMEPLAY_ROSTER.keys()).sort((a, b) => a - b);
}

// Defaults validated at module load — a broken authored roster fails the
// process before any consumer can pick a malformed replacement.
validateReplacementConfig(DEFAULT_REPLACEMENT_CONFIG);
Object.freeze(DEFAULT_REPLACEMENT_CONFIG);

module.exports = {
  VALID_ARCHETYPE_IDS,
  HISTORICAL_RESERVED_COIN_IDS,
  AUTHORED_REPLACEMENT_ROSTER,
  DEFAULT_REPLACEMENT_CONFIG,
  ReplacementConfigError,
  ReplacementIdentityError,
  getHistoricalReservedCoinIds,
  getLiveGameplayCoinIds,
  assertIdentityUnused,
  validateReplacementDefinition,
  validateReplacementConfig,
  resolveReplacementConfig,
  getReplacementDelayMs,
  getTargetActiveCount,
  loadReplacementRoster,
  peekNextReplacement
};
