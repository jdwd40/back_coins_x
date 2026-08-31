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

// V2-4: the public-signal vocabularies the personalities are allowed to
// key on. These mirror the shared market/risk domains exactly (coarse
// DIP/RISE/BOOM/FALL phases and STABLE/SHAKY/DANGER/CRITICAL risk levels);
// they are validated here so a malformed profile fails at module load.
// DEAD is never an entry/exit level — dead coins are handled structurally
// (never buyable, sellable at £0) before any personality rule runs.
const BOT_MARKET_PHASES = Object.freeze(['DIP', 'RISE', 'BOOM', 'FALL']);
const BOT_RISK_LEVELS = Object.freeze(['STABLE', 'SHAKY', 'DANGER', 'CRITICAL']);
// The public archetype vocabulary, imported from the single authoritative
// market domain rather than duplicated here.
const { MARKET_ARCHETYPES } = require('./marketDomain');
const BOT_ARCHETYPE_IDS = Object.freeze(Object.keys(MARKET_ARCHETYPES));

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
// the £10,000 starting cash; the upper bound is the entire starting
// bankroll — a "cap" above it would cap nothing.
const DEFAULT_BOT_MAX_TRADE_SIZE = 2500;
const MIN_BOT_MAX_TRADE_SIZE = 1;
const MAX_BOT_MAX_TRADE_SIZE = 10000;

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

// ---------------------------------------------------------------------------
// Issue #20: centralized exit strategy + exposure safeguards.
//
// These are the single authoritative game-design values for HOW bots exit
// positions and how much exposure they may carry — do not scatter literals.
// Everything here is a function of PUBLIC information only (apocalypse
// progress, live prices, public price history, the bot's own cash/holdings);
// nothing here can see the collapse schedule.
// ---------------------------------------------------------------------------

// Universal liquidation-pressure phases, keyed ONLY off public Apocalypse
// progress (apocalypsePercent). The same boundaries apply to every
// personality; the profiles below decide how strongly each one reacts.
const BOT_MID_PHASE_PERCENT = 40; // below: normal personality strategy
const BOT_LATE_PHASE_PERCENT = 70; // mid: profit-taking/cut weak positions
const BOT_EXTREME_PHASE_PERCENT = 90; // late: reduce exposure; extreme: liquidate

// In the mid phase, new BUYs still happen but the personality's invested
// fraction cap is scaled down by this factor (exposure starts shrinking
// before the late phase forbids new entries entirely).
const BOT_MID_PHASE_INVESTED_SCALE = 0.5;

// Central exposure safeguard: no single coin may exceed this fraction of the
// bot's total round wealth (cash + live holdings value). Validated and
// env-overridable like every other runtime knob.
const DEFAULT_BOT_MAX_COIN_EXPOSURE_FRACTION = 0.5;
const MIN_BOT_MAX_COIN_EXPOSURE_FRACTION = 0.01;
const MAX_BOT_MAX_COIN_EXPOSURE_FRACTION = 1;

// The canonical personality trading profiles. Every strategy of the
// canonical roster has exactly one profile; the profiles are what keep the
// personalities observably distinct under the shared phase rules.
//   stakeFraction           — BUY size as a fraction of current cash
//   maxInvestedFraction     — total holdings value cap, as a fraction of wealth
//   minCashReserveFraction  — cash floor, as a fraction of wealth
//   profitTakeThreshold     — relative gain that triggers profit-taking
//   profitSellFraction      — fraction of the position sold on profit-taking
//   lossCutThreshold        — relative decline that triggers loss-cutting
//   lossSellFraction        — fraction of the position sold on loss-cutting
//   lateCashTargetFraction  — late-phase cash target, as a fraction of wealth
//   lateSellFraction        — fraction of the worst position sold per late tick
// V2-4 public-signal fields (coarse phase/momentum/archetype/collapse-risk
// are the ONLY market inputs — never schedule, seed or future data):
//   preferredEntryPhases    — coarse phases the personality will open into
//   maxEntryRisk            — highest public risk level it will BUY into
//   exitAtRisk              — held coin at this risk level or worse is sold
//   preferredArchetypes     — archetypes the personality seeks out
// Plus personality-specific entries documented inline.
const BOT_PERSONALITY_PROFILES = Object.freeze({
  // Conservative Carl: preserve capital. Small stakes, a high cash reserve,
  // quick modest profit-taking, fast full loss-cutting, and the strongest
  // late-game cash target of the roster. V2-4: enters only DIP/early-RISE
  // coins reading STABLE/SHAKY, walks away from anything DANGEROUS, and
  // banks a BOOM the moment its momentum stops confirming — lower activity
  // and lower drawdown than the rest of the roster by design. SIM-12: the
  // fastest panic seller of the roster (any crash-sized public drop on a
  // held coin is exited in full) and almost never contrarian.
  conservative: Object.freeze({
    stakeFraction: 0.05,
    activityGate: 0.5, // only acts when the seeded random lands below this
    maxInvestedFraction: 0.4,
    minCashReserveFraction: 0.3,
    profitTakeThreshold: 0.08,
    profitSellFraction: 0.5,
    lossCutThreshold: -0.05,
    lossSellFraction: 1,
    lateCashTargetFraction: 0.7,
    lateSellFraction: 1,
    preferredEntryPhases: ['DIP', 'RISE'],
    maxEntryRisk: 'SHAKY',
    exitAtRisk: 'DANGER',
    boomExitOnWeakMomentum: true,
    panicSellThreshold: -0.08, // a public crash-sized drop on a held coin: bail in full
    panicSellFraction: 1,
    contrarianProbability: 0.02
  }),
  // Momentum Mike: trades the short-term trend. V2-4: enters an ESTABLISHED
  // RISE whose public momentum still reads UP (it may enter later than the
  // Dip Buyer), and exits the moment the trend stops confirming — public
  // momentum DOWN, the coin rolling into FALL, or a solid banked gain.
  // SIM-12: panic-trims a crash-sized public drop on a held coin even
  // before the trend rules fire, and occasionally fades the crowd.
  momentum: Object.freeze({
    stakeFraction: 0.1,
    momentumWindow: 4, // recent history points the trend is measured over
    momentumEntryThreshold: 0.01, // deliberately reachable entry bar
    maxInvestedFraction: 0.6,
    minCashReserveFraction: 0.1,
    profitTakeThreshold: 0.12,
    profitSellFraction: 0.5,
    reversalSellFraction: 0.5, // sell fraction when a holding's trend reverses
    lateCashTargetFraction: 0.5,
    lateSellFraction: 0.5,
    preferredEntryPhases: ['RISE'],
    maxEntryRisk: 'DANGER',
    exitAtRisk: 'CRITICAL',
    exitOnDownMomentum: true,
    exitOnPhases: ['FALL'],
    boomExitOnWeakMomentum: true,
    panicSellThreshold: -0.12, // a violent public drop: trim before the trend rules confirm
    panicSellFraction: 0.5,
    contrarianProbability: 0.05
  }),
  // Dip Buyer Dana: buys meaningful dips, sells meaningful recoveries, cuts
  // a dip that keeps collapsing instead of averaging down forever, and is
  // exposure-capped so repeated dip buys cannot consume nearly all cash.
  // V2-4: entries are driven by the public coarse phase — a DIP (or a RISE
  // that has barely left the trough, the same public rule the DIP_BOOM
  // human benchmark uses) — riding toward the BOOM before selling. It
  // tolerates DANGER entries like a skilled dip buyer, holds longer than
  // Conservative and may occasionally overstay, but never buys CRITICAL.
  // SIM-12: NEVER panic sells — a crash-sized public drop is exactly what
  // it hunts (crash-dip entries qualify even outside the strict DIP-phase
  // rule); the most deliberately contrarian calm personality.
  dip_buyer: Object.freeze({
    stakeFraction: 0.3,
    dipEntryThreshold: -0.1,
    recoveryExitThreshold: 0.25,
    maxInvestedFraction: 0.75,
    minCashReserveFraction: 0.1,
    lossCutThreshold: -0.25,
    lossSellFraction: 1,
    lateCashTargetFraction: 0.5,
    lateSellFraction: 0.5,
    preferredEntryPhases: ['DIP'],
    riseEntryMaxChangePct: 2, // a RISE barely off the trough still counts as a dip entry
    fallExitThreshold: -0.08, // a FALL-phase position this far underwater: the boom did not come — cut
    maxEntryRisk: 'DANGER',
    crashDipBuyThreshold: -0.08, // a crash-sized public drop qualifies as a dip entry anywhere
    contrarianProbability: 0.08
  }),
  // Reckless Ray: still the aggressor — the largest stakes and the highest
  // invested cap — but locks big wins, panic-cuts only deep losses, and the
  // invested cap + cash reserve mean he can no longer buy down toward £0.
  // V2-4: hunts the high-swing/high-upside archetypes (DEGEN/RUG first) and
  // willingly buys DANGER/CRITICAL readings the calmer personalities refuse
  // — sometimes winning large, sometimes riding a collapse. The universal
  // late/extreme safeguards still force liquidation, and sells never need
  // Power. SIM-12: slow to panic (only a truly violent public drop forces a
  // full bail) and the most contrarian bot on the roster.
  reckless: Object.freeze({
    stakeFraction: 0.4,
    maxInvestedFraction: 0.8,
    minCashReserveFraction: 0.02,
    profitTakeThreshold: 0.3,
    profitSellFraction: 0.5,
    lossCutThreshold: -0.5,
    lossSellFraction: 1,
    lateCashTargetFraction: 0.3,
    lateSellFraction: 0.5,
    preferredArchetypes: ['DEGEN', 'RUG'],
    maxEntryRisk: 'CRITICAL',
    panicSellThreshold: -0.2, // only a genuinely violent public drop forces the bail
    panicSellFraction: 1,
    contrarianProbability: 0.15
  })
});

// Validate the personality profiles. Called at module load: a malformed
// profile is a build-time bug, so it throws immediately. Every canonical
// strategy must have exactly one profile; each field is checked against its
// own range (fractions in (0, 1], signed thresholds, positive integers).
function validateBotPersonalityProfiles(profiles = BOT_PERSONALITY_PROFILES) {
  // field -> [strategies that require it, range checker]
  const isFraction = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 1;
  const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);
  const isPositiveInteger = (v) => Number.isInteger(v) && v > 0;
  // V2-4 public-signal field checkers.
  const isPhaseList = (v) => Array.isArray(v) && v.length > 0
    && v.every((phase) => BOT_MARKET_PHASES.includes(phase))
    && new Set(v).size === v.length;
  const isRiskLevel = (v) => BOT_RISK_LEVELS.includes(v);
  const isArchetypeList = (v) => Array.isArray(v) && v.length > 0
    && v.every((id) => BOT_ARCHETYPE_IDS.includes(id))
    && new Set(v).size === v.length;
  const isBoolean = (v) => typeof v === 'boolean';
  const REQUIREMENTS = [
    ['stakeFraction', BOT_STRATEGIES, isFraction],
    ['maxInvestedFraction', BOT_STRATEGIES, isFraction],
    ['minCashReserveFraction', BOT_STRATEGIES, isFraction],
    ['profitTakeThreshold', ['conservative', 'momentum', 'reckless'], (v) => isFiniteNumber(v) && v > 0],
    ['profitSellFraction', ['conservative', 'momentum', 'reckless'], isFraction],
    ['lateCashTargetFraction', BOT_STRATEGIES, isFraction],
    ['lateSellFraction', BOT_STRATEGIES, isFraction],
    ['lossCutThreshold', ['conservative', 'dip_buyer', 'reckless'], (v) => isFiniteNumber(v) && v < 0],
    ['lossSellFraction', ['conservative', 'dip_buyer', 'reckless'], isFraction],
    ['activityGate', ['conservative'], isFraction],
    ['momentumWindow', ['momentum'], isPositiveInteger],
    ['momentumEntryThreshold', ['momentum'], (v) => isFiniteNumber(v) && v > 0],
    ['reversalSellFraction', ['momentum'], isFraction],
    ['dipEntryThreshold', ['dip_buyer'], (v) => isFiniteNumber(v) && v < 0],
    ['recoveryExitThreshold', ['dip_buyer'], (v) => isFiniteNumber(v) && v > 0],
    // V2-4 public-signal rules.
    ['preferredEntryPhases', ['conservative', 'momentum', 'dip_buyer'], isPhaseList],
    ['maxEntryRisk', BOT_STRATEGIES, isRiskLevel],
    ['exitAtRisk', ['conservative', 'momentum'], isRiskLevel],
    ['boomExitOnWeakMomentum', ['conservative', 'momentum'], isBoolean],
    ['exitOnDownMomentum', ['momentum'], isBoolean],
    ['exitOnPhases', ['momentum'], isPhaseList],
    ['riseEntryMaxChangePct', ['dip_buyer'], (v) => isFiniteNumber(v) && v >= 0],
    ['fallExitThreshold', ['dip_buyer'], (v) => isFiniteNumber(v) && v < 0],
    ['preferredArchetypes', ['reckless'], isArchetypeList],
    // SIM-12 feedback fields: panic selling, crash-dip buying and
    // occasional contrarian behaviour (all public-signal driven).
    ['panicSellThreshold', ['conservative', 'momentum', 'reckless'], (v) => isFiniteNumber(v) && v < 0 && v > -1],
    ['panicSellFraction', ['conservative', 'momentum', 'reckless'], isFraction],
    ['crashDipBuyThreshold', ['dip_buyer'], (v) => isFiniteNumber(v) && v < 0 && v > -1],
    ['contrarianProbability', BOT_STRATEGIES, (v) => isFiniteNumber(v) && v >= 0 && v <= 0.5]
  ];
  for (const strategy of BOT_STRATEGIES) {
    const profile = profiles[strategy];
    if (!profile || typeof profile !== 'object') {
      throw new Error(`BOT_PERSONALITY_PROFILES is missing a profile for strategy ${strategy}`);
    }
    for (const [field, strategies, check] of REQUIREMENTS) {
      if (!strategies.includes(strategy)) continue;
      if (!check(profile[field])) {
        throw new Error(
          `BOT_PERSONALITY_PROFILES.${strategy}.${field} is missing or out of range; received ${String(profile[field])}`
        );
      }
    }
  }
  return profiles;
}

// Validate the central per-coin exposure cap: a finite fraction in (0, 1].
function validateBotMaxCoinExposureFraction(raw) {
  if (raw === undefined || raw === null) return DEFAULT_BOT_MAX_COIN_EXPOSURE_FRACTION;
  if (typeof raw === 'string' && raw.trim() === '') return DEFAULT_BOT_MAX_COIN_EXPOSURE_FRACTION;

  let value = raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!/^[+-]?(\d+(\.\d+)?|\.\d+)$/.test(trimmed)) {
      throw new Error(
        `GAME_BOT_MAX_COIN_EXPOSURE_FRACTION must be a numeric fraction; received ${JSON.stringify(raw)}`
      );
    }
    value = Number(trimmed);
  }
  if (typeof value !== 'number' || Number.isNaN(value) || !Number.isFinite(value)) {
    throw new Error(`GAME_BOT_MAX_COIN_EXPOSURE_FRACTION must be finite; received ${String(raw)}`);
  }
  if (value < MIN_BOT_MAX_COIN_EXPOSURE_FRACTION) {
    throw new Error(
      `GAME_BOT_MAX_COIN_EXPOSURE_FRACTION ${value} is below the minimum of ${MIN_BOT_MAX_COIN_EXPOSURE_FRACTION}`
    );
  }
  if (value > MAX_BOT_MAX_COIN_EXPOSURE_FRACTION) {
    throw new Error(
      `GAME_BOT_MAX_COIN_EXPOSURE_FRACTION ${value} exceeds the maximum of ${MAX_BOT_MAX_COIN_EXPOSURE_FRACTION}`
    );
  }
  return value;
}

// Resolve the effective bot runtime config. Validation runs on every
// resolution, so a bad config throws before any tick can run on it.
function resolveBotConfig(env = process.env) {
  return {
    enabled: validateBotsEnabled(env.GAME_BOTS_ENABLED),
    tickIntervalMs: validateBotTickIntervalMs(env.GAME_BOT_TICK_INTERVAL_MS),
    maxTradeSize: validateBotMaxTradeSize(env.GAME_BOT_MAX_TRADE_SIZE),
    cooldownMs: validateBotCooldownMs(env.GAME_BOT_COOLDOWN_MS),
    maxActionsPerTick: validateBotMaxActionsPerTick(env.GAME_BOT_MAX_ACTIONS_PER_TICK),
    maxCoinExposureFraction: validateBotMaxCoinExposureFraction(env.GAME_BOT_MAX_COIN_EXPOSURE_FRACTION)
  };
}

// Module-load roster validation: a malformed roster can never reach a tick.
validateBotRoster();
// Module-load profile validation: a malformed exit/exposure profile can
// never reach a decision either.
validateBotPersonalityProfiles();

module.exports = {
  BOT_STRATEGIES,
  BOT_MARKET_PHASES,
  BOT_RISK_LEVELS,
  BOT_ARCHETYPE_IDS,
  BOT_ROSTER,
  validateBotRoster,
  BOT_MID_PHASE_PERCENT,
  BOT_LATE_PHASE_PERCENT,
  BOT_EXTREME_PHASE_PERCENT,
  BOT_MID_PHASE_INVESTED_SCALE,
  DEFAULT_BOT_MAX_COIN_EXPOSURE_FRACTION,
  MIN_BOT_MAX_COIN_EXPOSURE_FRACTION,
  MAX_BOT_MAX_COIN_EXPOSURE_FRACTION,
  BOT_PERSONALITY_PROFILES,
  validateBotPersonalityProfiles,
  validateBotMaxCoinExposureFraction,
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
