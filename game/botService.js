// Crypto Chaos Core 5: autonomous roster bots.
//
// Bots are first-class game participants backed by real users rows marked
// is_bot = true, provisioned with credentials that can never authenticate
// (a bcrypt hash of a never-stored random secret). They join rounds through
// the EXACT SAME Core 4 domain service humans use (gameRoundService.joinRound
// / buyRoundTrade / sellRoundTrade) — never through HTTP/controllers and
// never through direct cash/holding/transaction edits. All Core 4 isolation
// guarantees (advisory lock, row locks, ledger-only writes, legacy funds
// untouched) therefore apply to bots identically.
//
// Determinism: every pseudo-random choice comes from a SHA-256 counter
// stream keyed by the cycle's persisted Core 1 seed + the bot's stable
// identity + the tick id. Same inputs -> identical decisions, in every
// process, forever. Math.random() is never used.
//
// Public-state-only decisions: the decision layer accepts ONLY the
// deliberately shaped market state built here — live coin prices, recent
// public price history, EXECUTED collapse status (a coin publicly dead at
// £0, read from the dynamic collapse engine's persisted death records),
// the SAME coarse V2 public signals human clients receive (phase,
// momentum, archetype, recent public movement, collapse-risk level), the
// bot's own cash/holdings economics, its own effective Power view and
// open-position count/limit, and apocalypsePercent. Future collapse data
// is never read for decisions and — under the dynamic engine — is never
// even persisted ahead of time, so none can exist in the shaped state; the
// cycle seed is used ONLY to evaluate the shared public-signal domains and
// to key the deterministic random stream — it never enters the shaped
// state. V2-4 enforces this with an exact-key allowlist
// (assertPublicBotState) that runs on every live AND simulated decision
// input.
//
// V2-4 resource legality: bots buy/sell only through the shared Core 4
// domain ops, so every bot buy pays the SAME Power cost and obeys the SAME
// 3-position limit as a human (game/powerDomain inside the locked live
// path). The decision layer is aware of its own public Power balance and
// position slots (unaffordable/illegal buys become explained HOLDs), and
// any residual authoritative rejection from the shared service is recorded
// as a non-fatal skip ('power-blocked' / 'position-limit'), never bypassed
// and never converted into a direct state mutation. Sells never need Power.
//
// Tick identity: runBotTick claims (cycle_id, tick_id) in
// apocalypse_bot_ticks with INSERT ... ON CONFLICT DO NOTHING, so a given
// tick executes at most once across every Node/PM2 process — the database is
// the duplicate-tick authority. This module owns no timers; the single
// lifecycle-owned bot worker (botWorker.js) is the only scheduler.
//
// Limits (validated in botConfig, enforced HERE at the service layer):
// a per-trade size cap on every executed BUY, a per-bot cooldown read from
// the PERSISTED apocalypse_bots.last_action_at (never in-memory state), and
// a maximum number of executed actions per tick. Executed trades stamp
// last_action_at so the cooldown survives restarts and holds across
// processes. Issue #20 adds central exit/exposure safeguards (validated in
// botConfig as phase boundaries + per-personality profiles): every BUY is
// clamped by the per-coin exposure cap, the personality's invested-fraction
// cap and minimum cash reserve, and rising public apocalypsePercent drives
// universal profit-taking/loss-cutting/liquidation pressure.

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const db = require('../db/connection');
const {
  BOT_ROSTER,
  BOT_STRATEGIES,
  resolveBotConfig,
  BOT_MID_PHASE_PERCENT,
  BOT_LATE_PHASE_PERCENT,
  BOT_EXTREME_PHASE_PERCENT,
  BOT_MID_PHASE_INVESTED_SCALE,
  DEFAULT_BOT_MAX_COIN_EXPOSURE_FRACTION,
  BOT_PERSONALITY_PROFILES
} = require('./botConfig');
const { GAME_MIN_TRADE_VALUE, resolveGameMaxOpenPositions } = require('./gameConstants');
const gameRoundService = require('./gameRoundService');
const { reconcileCycle, deriveProgress } = require('./gameCycleService');
const marketDomain = require('./marketDomain');
const collapseRiskDomain = require('./collapseRiskDomain');
const powerDomain = require('./powerDomain');
const { getApocalypseVolatility } = require('./apocalypseVolatility');
const { computeLiveCoinSignal } = require('./marketSignalsService');
const { loadPricingContext } = require('./pricingContext');

// How many recent price points each coin carries in the shaped public state.
// A fixed game-design constant — deliberately not configurable.
const BOT_HISTORY_WINDOW = 20;

// ---------------------------------------------------------------------------
// V2-4: the shaped PUBLIC bot state contract.
//
// These allowlists are the redaction contract between the state builders
// (live: buildPublicMarketState below; simulation: the bot observation
// adapter in simulation/botStudy.js) and the pure decision layer. The
// decision layer receives EXACTLY this shape and nothing else: no seed, no
// collapse schedule/rank/timestamp, no future phase/peak/timing, no anchor,
// no cycle index. assertPublicBotState enforces the contract on every
// decision input, live and simulated alike — an extra OR missing key is a
// hard error, so hidden information can never silently reach a decision.
// ---------------------------------------------------------------------------
const BOT_MARKET_STATE_KEYS = Object.freeze([
  'coins', 'cash', 'holdings', 'apocalypsePercent', 'power', 'openPositions'
]);
const BOT_COIN_KEYS = Object.freeze([
  'coinId', 'symbol', 'currentPrice', 'collapsed', 'history',
  'phase', 'momentum', 'archetype', 'collapseRisk', 'recentChangePct'
]);
const BOT_HOLDING_KEYS = Object.freeze([
  'coinId', 'symbol', 'quantity', 'costBasis', 'averageEntryPrice',
  'currentValue', 'unrealizedPnlPct'
]);
const BOT_POWER_KEYS = Object.freeze(['current', 'max', 'regenMsPerPoint']);
const BOT_OPEN_POSITION_KEYS = Object.freeze(['open', 'max']);

// Legal vocabularies for the V2 public-signal fields (dead coins carry the
// DEAD markers instead of a live phase/level).
const BOT_COIN_PHASES = Object.freeze(['DIP', 'RISE', 'BOOM', 'FALL', 'DEAD']);
const BOT_COIN_MOMENTA = Object.freeze(['UP', 'DOWN', 'FLAT']);
const BOT_COIN_RISKS = Object.freeze([
  ...collapseRiskDomain.COLLAPSE_RISK_LEVELS,
  collapseRiskDomain.DEAD_RISK_MARKER
]);

// Domain error for bot tick validation (mirrors GameRoundError's contract:
// message first, HTTP-ish status second for any future controller use).
class BotServiceError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'BotServiceError';
    this.status = status;
  }
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function floor2(value) {
  return Math.floor(value * 100) / 100;
}

// ---------------------------------------------------------------------------
// Deterministic PRNG: SHA-256 counter mode keyed by cycle seed + stable bot
// identity + tick. Same (seed, botKey, tickId) -> identical stream, in every
// process, forever.
// ---------------------------------------------------------------------------
function createBotRandom({ seed, botKey, tickId }) {
  if (typeof seed !== 'string' || seed.length === 0) {
    throw new Error(`bot random seed must be a non-empty string; received ${typeof seed === 'string' ? JSON.stringify(seed) : String(seed)}`);
  }
  if (typeof botKey !== 'string' || botKey.length === 0) {
    throw new Error(`bot random botKey must be a non-empty string; received ${typeof botKey === 'string' ? JSON.stringify(botKey) : String(botKey)}`);
  }
  if (!Number.isInteger(tickId) || tickId < 0) {
    throw new Error(`bot random tickId must be a non-negative integer; received ${String(tickId)}`);
  }
  let counter = 0;
  return function botRandom() {
    const digest = crypto.createHash('sha256').update(`${seed}:core5:${botKey}:${tickId}:${counter}`).digest();
    counter += 1;
    return digest.readUInt32BE(0) / 0x100000000; // [0, 1)
  };
}

// ---------------------------------------------------------------------------
// Provisioning: create (exactly once) the roster's backing users and durable
// identity rows. Idempotent under repetition AND genuine concurrency — the
// users.username UNIQUE constraint and apocalypse_bots UNIQUE constraints are
// the database backstops. Repeated runs reuse the same stable user ids and
// never rotate credentials.
// ---------------------------------------------------------------------------
async function ensureBotsProvisioned({ queryable = db } = {}) {
  const provisioned = [];
  for (const bot of BOT_ROSTER) {
    // The password hash is a syntactically valid bcrypt hash of a random
    // secret generated here and NEVER stored anywhere: no candidate password
    // can ever authenticate as a bot. A fresh secret is generated only when
    // the row does not yet exist (ON CONFLICT DO NOTHING discards it).
    const unusableHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
    await queryable.query(
      `INSERT INTO users (username, email, password_hash, funds, is_bot)
       VALUES ($1, $2, $3, 0.00, true)
       ON CONFLICT (username) DO NOTHING`,
      [bot.username, bot.email, unusableHash]
    );
    const { rows: userRows } = await queryable.query(
      'SELECT user_id, is_bot FROM users WHERE username = $1',
      [bot.username]
    );
    const user = userRows[0];
    if (!user) {
      throw new Error(`bot provisioning: failed to resolve roster user ${bot.username}`);
    }
    if (user.is_bot !== true) {
      // The roster username belongs to a pre-existing HUMAN account. That is
      // a deployment conflict, never something to silently take over.
      throw new Error(
        `bot provisioning: username ${bot.username} already exists and is not a bot; refusing to adopt a human account`
      );
    }

    await queryable.query(
      `INSERT INTO apocalypse_bots (bot_key, strategy, user_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (bot_key) DO NOTHING`,
      [bot.botKey, bot.strategy, user.user_id]
    );
    const { rows: identityRows } = await queryable.query(
      'SELECT bot_key, strategy, user_id, last_action_at FROM apocalypse_bots WHERE bot_key = $1',
      [bot.botKey]
    );
    const identity = identityRows[0];
    if (identity.user_id !== user.user_id) {
      throw new Error(
        `bot provisioning: identity ${bot.botKey} is pinned to user ${identity.user_id}, expected ${user.user_id}`
      );
    }
    if (identity.strategy !== bot.strategy) {
      throw new Error(
        `bot provisioning: identity ${bot.botKey} persists strategy ${identity.strategy}, roster now says ${bot.strategy}; reconcile manually`
      );
    }
    provisioned.push({
      botKey: bot.botKey,
      strategy: bot.strategy,
      userId: user.user_id,
      lastActionAt: identity.last_action_at ? new Date(identity.last_action_at) : null
    });
  }
  return provisioned;
}

// ---------------------------------------------------------------------------
// Deliberately shaped PUBLIC market state — the ONLY input the decision
// layer may use. Contains: live coin prices, the recent public price
// history window, EXECUTED collapse status for this cycle (a coin that is
// already publicly dead at £0), the SAME coarse V2 public signals a human
// client receives from the market-signals endpoint (phase, momentum,
// archetype, recent public movement, collapse-risk level), the bot's own
// cash/holdings economics, its own effective Power view and its own open
// live position count/limit, plus apocalypsePercent. Future collapse data
// is never selected here (and under the dynamic engine is never persisted
// ahead of time); the cycle seed is used ONLY to evaluate the shared
// public-signal domains (exactly like marketSignalsService) and is never
// present in the returned shape — the exact key allowlists above are the
// contract.
// ---------------------------------------------------------------------------
async function buildPublicMarketState({ cycle, participant, now = new Date(), queryable = db } = {}) {
  const nowDate = now instanceof Date ? now : new Date(now);
  const nowMs = nowDate.getTime();
  const { apocalypsePercent } = deriveProgress({
    startTime: cycle.start_time,
    endTime: cycle.end_time,
    durationMs: cycle.duration_ms,
    now: nowDate
  });
  const amplitude = getApocalypseVolatility(apocalypsePercent);
  const roundStartMs = new Date(cycle.start_time).getTime();
  const cycleDurationMs = Number(cycle.duration_ms);

  // SIM-08/SIM-11: the persisted Wave 1/2/4 pricing context for the shared
  // unified signal, read through the caller's queryable (same transaction
  // snapshot when inside the advisory-locked bot tick). Internal only.
  const pricingContext = await loadPricingContext(queryable, cycle, { nowMs });

  const { rows: coinRows } = await queryable.query(
    `SELECT c.coin_id, c.symbol, c.current_price, c.cycle_baseline_price,
            EXISTS (
              SELECT 1 FROM apocalypse_coin_collapses cc
              WHERE cc.cycle_id = $1 AND cc.coin_id = c.coin_id
            ) AS collapsed
     FROM coins c
     WHERE c.retired = FALSE
     ORDER BY c.coin_id`,
    [cycle.cycle_id]
  );

  const coins = [];
  for (const row of coinRows) {
    const { rows: historyRows } = await queryable.query(
      `SELECT price FROM (
         SELECT price, created_at FROM price_history
         WHERE coin_id = $1
         ORDER BY created_at DESC
         LIMIT $2
       ) recent
       ORDER BY created_at ASC`,
      [row.coin_id, BOT_HISTORY_WINDOW]
    );
    const history = historyRows.map((h) => parseFloat(h.price));
    const base = {
      coinId: row.coin_id,
      symbol: row.symbol,
      currentPrice: parseFloat(row.current_price),
      collapsed: row.collapsed === true,
      history
    };
    if (base.collapsed) {
      // Dead coins expose only their death and archetype identity — the
      // same minimal dead marker the public signals endpoint publishes.
      coins.push({
        ...base,
        phase: 'DEAD',
        momentum: 'FLAT',
        archetype: marketDomain.resolveArchetypeId(row.coin_id),
        collapseRisk: collapseRiskDomain.DEAD_RISK_MARKER,
        recentChangePct: null
      });
      continue;
    }
    // The SAME shared public signal the human-facing market-signals
    // endpoint publishes for this instant (SIM-08: unified price path via
    // marketSignalsService.computeLiveCoinSignal — parity enforced by
    // v2-bot-signals.test.js). The seed never leaves this function; only
    // the coarse signal survives.
    const signal = computeLiveCoinSignal({
      seed: cycle.seed,
      coin: row,
      nowMs,
      amplitude,
      apocalypsePercent,
      roundStartMs,
      cycleDurationMs,
      pricingContext
    });
    coins.push({
      ...base,
      phase: signal.phase,
      momentum: signal.momentum,
      archetype: signal.archetype,
      collapseRisk: signal.collapseRisk,
      recentChangePct: signal.recentChangePct
    });
  }

  // The bot's own open LIVE position count under the shared V2-2 rule: a
  // holding with quantity > 0 whose coin has not collapsed this cycle. The
  // limit itself is public game configuration.
  const collapsedIds = new Set(coins.filter((c) => c.collapsed).map((c) => c.coinId));
  const openLive = participant.holdings.filter(
    (h) => h.quantity > 0 && !collapsedIds.has(h.coinId)
  ).length;

  return {
    coins,
    cash: participant.currentCash,
    holdings: participant.holdings.map((h) => ({
      coinId: h.coinId,
      symbol: h.symbol,
      quantity: h.quantity,
      costBasis: h.costBasis,
      averageEntryPrice: h.averageEntryPrice,
      currentValue: h.currentValue,
      unrealizedPnlPct: h.unrealizedPnlPct
    })),
    apocalypsePercent,
    power: {
      current: participant.power.current,
      max: participant.power.max,
      regenMsPerPoint: participant.power.regenMsPerPoint
    },
    openPositions: {
      open: openLive,
      max: resolveGameMaxOpenPositions()
    }
  };
}

// ---------------------------------------------------------------------------
// Pure decision layer. Deterministic given (strategy, shaped state, random,
// maxTradeSize, maxCoinExposureFraction). Every BUY is constructed so
// quantity * price can never exceed cash NOR the configured per-trade size
// cap NOR the central exposure safeguards (per-coin exposure, invested
// fraction, minimum cash reserve); every SELL so quantity can never exceed
// the actual holding; collapsed or zero-priced coins are never bought. As
// public apocalypsePercent rises, every personality progressively prefers
// Cash over open positions (issue #20). Returns
// { type, coinId?, quantity?, reason? } — reason explains HOLDs.
// ---------------------------------------------------------------------------
// Exact-key-set check: returns the list of violations (missing or extra
// keys), empty when the object carries precisely the allowed keys.
function keyViolations(obj, allowedKeys) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return ['not-an-object'];
  const violations = [];
  const keys = Object.keys(obj);
  for (const key of allowedKeys) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) violations.push(`missing:${key}`);
  }
  for (const key of keys) {
    if (!allowedKeys.includes(key)) violations.push(`forbidden:${key}`);
  }
  return violations;
}

// The redaction contract, enforced on EVERY decision input (live ticks and
// every simulated decision alike): the shaped state must carry EXACTLY the
// public allowlist — any extra key (a seed, a schedule row, a collapse rank,
// a future timestamp, an anchor) or any missing public field is a hard
// error, so hidden information can never silently reach a personality.
function assertPublicBotState(marketState) {
  if (!marketState || typeof marketState !== 'object') {
    throw new BotServiceError('bot decision requires a shaped market state object', 400);
  }
  const top = keyViolations(marketState, BOT_MARKET_STATE_KEYS);
  if (top.length > 0) {
    throw new BotServiceError(`bot decision market state violates the public-state contract: ${top.join(', ')}`, 400);
  }
  if (typeof marketState.cash !== 'number' || !Number.isFinite(marketState.cash)) {
    throw new BotServiceError('bot decision market state requires a finite cash number', 400);
  }
  if (typeof marketState.apocalypsePercent !== 'number' || !Number.isFinite(marketState.apocalypsePercent)) {
    throw new BotServiceError('bot decision market state requires a finite apocalypsePercent', 400);
  }
  if (!Array.isArray(marketState.coins)) {
    throw new BotServiceError('bot decision market state requires a coins array', 400);
  }
  if (!Array.isArray(marketState.holdings)) {
    throw new BotServiceError('bot decision market state requires a holdings array', 400);
  }
  for (const coin of marketState.coins) {
    const violations = keyViolations(coin, BOT_COIN_KEYS);
    if (violations.length > 0) {
      throw new BotServiceError(`bot decision coin state violates the public-state contract: ${violations.join(', ')}`, 400);
    }
    if (!BOT_COIN_PHASES.includes(coin.phase)) {
      throw new BotServiceError(`bot decision coin phase must be one of ${BOT_COIN_PHASES.join(', ')}; received ${JSON.stringify(coin.phase)}`, 400);
    }
    if (!BOT_COIN_MOMENTA.includes(coin.momentum)) {
      throw new BotServiceError(`bot decision coin momentum must be one of ${BOT_COIN_MOMENTA.join(', ')}; received ${JSON.stringify(coin.momentum)}`, 400);
    }
    if (!BOT_COIN_RISKS.includes(coin.collapseRisk)) {
      throw new BotServiceError(`bot decision coin collapseRisk must be one of ${BOT_COIN_RISKS.join(', ')}; received ${JSON.stringify(coin.collapseRisk)}`, 400);
    }
    // Death is reported consistently: a collapsed coin is exactly the DEAD
    // marker everywhere, and vice versa.
    const dead = coin.collapsed === true;
    if (dead !== (coin.phase === 'DEAD') || dead !== (coin.collapseRisk === collapseRiskDomain.DEAD_RISK_MARKER)) {
      throw new BotServiceError('bot decision coin dead state is inconsistent across collapsed/phase/collapseRisk', 400);
    }
  }
  for (const holding of marketState.holdings) {
    const violations = keyViolations(holding, BOT_HOLDING_KEYS);
    if (violations.length > 0) {
      throw new BotServiceError(`bot decision holding state violates the public-state contract: ${violations.join(', ')}`, 400);
    }
  }
  const powerViolations = keyViolations(marketState.power, BOT_POWER_KEYS);
  if (powerViolations.length > 0) {
    throw new BotServiceError(`bot decision power state violates the public-state contract: ${powerViolations.join(', ')}`, 400);
  }
  if (typeof marketState.power.current !== 'number' || !Number.isFinite(marketState.power.current)
    || typeof marketState.power.max !== 'number' || !Number.isFinite(marketState.power.max)) {
    throw new BotServiceError('bot decision power state requires finite current/max', 400);
  }
  const positionViolations = keyViolations(marketState.openPositions, BOT_OPEN_POSITION_KEYS);
  if (positionViolations.length > 0) {
    throw new BotServiceError(`bot decision openPositions state violates the public-state contract: ${positionViolations.join(', ')}`, 400);
  }
  if (!Number.isInteger(marketState.openPositions.open) || marketState.openPositions.open < 0
    || !Number.isInteger(marketState.openPositions.max) || marketState.openPositions.max < 0) {
    throw new BotServiceError('bot decision openPositions state requires non-negative integer open/max', 400);
  }
}

// Recent relative change of a coin's public history; 0 without enough data.
function recentChange(coin) {
  const history = coin.history;
  if (!Array.isArray(history) || history.length < 2) return 0;
  const first = history[0];
  const last = history[history.length - 1];
  if (!(first > 0)) return 0;
  return (last - first) / first;
}

// Short-window relative change over the most recent `window` public history
// points — the reachable trend signal Momentum Mike trades on. A grinding
// market-wide decline rarely produces a positive FULL-window change (which
// is why the old momentum entry almost never fired in production); the
// recent window reacts to genuine short-term moves instead.
function shortMomentum(coin, window = 4) {
  const history = coin.history;
  if (!Array.isArray(history) || history.length < 2) return 0;
  const slice = history.slice(-Math.min(window, history.length));
  const first = slice[0];
  const last = slice[slice.length - 1];
  if (!(first > 0)) return 0;
  return (last - first) / first;
}

// Recent relative change for a held position, looked up in the public coin
// state by coinId (0 when the coin has no usable history).
function holdingChange(marketState, holding) {
  const coin = marketState.coins.find((c) => c.coinId === holding.coinId);
  return coin ? recentChange(coin) : 0;
}

// The holding's own unrealised P&L as a fraction — the V2-2 cost-basis
// economics the bot legitimately knows about its OWN position. Falls back
// to the public full-window history change only when the economics were
// not shaped (null), keeping the decision total over the allowed shape.
function holdingPnlFraction(marketState, holding) {
  if (typeof holding.unrealizedPnlPct === 'number' && Number.isFinite(holding.unrealizedPnlPct)) {
    return holding.unrealizedPnlPct / 100;
  }
  return holdingChange(marketState, holding);
}

// Ordinal of a public collapse-risk level; DEAD (or anything unexpected)
// sorts below STABLE — dead coins are structurally excluded before any
// risk comparison runs.
function riskOrdinal(level) {
  const ordinal = collapseRiskDomain.COLLAPSE_RISK_ORDINAL[level];
  return ordinal === undefined ? -1 : ordinal;
}

// A coin's public recent movement as a fraction, preferring the shared
// domain signal (recentChangePct) and falling back to the public history
// window when the signal carries null (dead coins — excluded earlier).
function coinMoveFraction(coin) {
  if (typeof coin.recentChangePct === 'number' && Number.isFinite(coin.recentChangePct)) {
    return coin.recentChangePct / 100;
  }
  return recentChange(coin);
}

// The universal liquidation-pressure phase, derived ONLY from public
// Apocalypse progress. No collapse-schedule knowledge is involved: the same
// shaped state at a higher apocalypsePercent simply prefers Cash more.
function liquidationPhase(apocalypsePercent) {
  if (apocalypsePercent >= BOT_EXTREME_PHASE_PERCENT) return 'extreme';
  if (apocalypsePercent >= BOT_LATE_PHASE_PERCENT) return 'late';
  if (apocalypsePercent >= BOT_MID_PHASE_PERCENT) return 'mid';
  return 'early';
}

// Value the bot's portfolio from the shaped public state. Collapsed or
// zero-priced coins are worth £0 (dead) and can never recover cash.
function portfolioSnapshot(marketState) {
  const cash = Math.max(0, marketState.cash);
  const livePriceOf = (coinId) => {
    const coin = marketState.coins.find((c) => c.coinId === coinId);
    return coin && coin.collapsed !== true && coin.currentPrice > 0 ? coin.currentPrice : 0;
  };
  const holdings = marketState.holdings
    .filter((h) => h.quantity > 0)
    .map((holding) => {
      const price = livePriceOf(holding.coinId);
      return { holding, price, value: round2(holding.quantity * price) };
    });
  const investedValue = round2(holdings.reduce((sum, entry) => sum + entry.value, 0));
  return { cash, holdings, investedValue, wealth: round2(cash + investedValue) };
}

// A bounded sell of a held position: never more than the actual holding. A
// full exit sells the EXACT (fractional) holding — rounding an 8-decimal
// quantity UP to 2dp would oversell and be rejected by the shared service,
// which is the last thing an endgame liquidation should do.
function boundedSell(holding, fraction) {
  const quantity = fraction >= 1 ? holding.quantity : floor2(holding.quantity * fraction);
  if (!(quantity > 0)) return { type: 'HOLD' };
  return { type: 'SELL', coinId: holding.coinId, quantity };
}

// The personality's desired stake: a fraction of cash, additionally clamped
// by the configured per-trade size cap (and never above cash itself).
function spendFor(cash, fraction, maxTradeSize) {
  const desired = cash * fraction;
  const capped = Number.isFinite(maxTradeSize) ? Math.min(desired, maxTradeSize) : desired;
  return round2(Math.max(0, Math.min(capped, cash)));
}

// Issue #20 central exposure safeguards, applied to EVERY bot BUY in one
// place. A proposed spend is clamped so that after the trade:
//   * cash stays at or above the personality's minimum reserve
//     (minCashReserveFraction of total wealth);
//   * total invested value stays at or below the personality's invested cap
//     (maxInvestedFraction of wealth, scaled down in the mid phase);
//   * the target coin stays at or below the central per-coin exposure cap
//     (maxCoinExposureFraction of wealth).
// Returns the clamped spend, or null when the rules leave nothing to buy
// with — repeated BUY decisions can never violate these rules.
function clampBuySpend({ spend, coinId, snapshot, profile, maxCoinExposureFraction, investedCapScale }) {
  const { cash, wealth, investedValue } = snapshot;
  if (!(wealth > 0) || !(spend > 0)) return null;
  const coinEntry = snapshot.holdings.find((e) => e.holding.coinId === coinId);
  const coinValue = coinEntry ? coinEntry.value : 0;
  const allowed = Math.min(
    spend,
    cash - profile.minCashReserveFraction * wealth,
    profile.maxInvestedFraction * investedCapScale * wealth - investedValue,
    maxCoinExposureFraction * wealth - coinValue
  );
  if (!(allowed > 0)) return null;
  return round2(allowed);
}

// Construct a bounded BUY for `coin`: floor-quantized so the total can never
// exceed `spend` (itself a capped fraction of cash). Returns HOLD when
// unaffordable.
function boundedBuy(coin, spend) {
  const quantity = floor2(spend / coin.currentPrice);
  if (quantity <= 0) return { type: 'HOLD' };
  return { type: 'BUY', coinId: coin.coinId, quantity };
}

// The worst-performing LIVE holding (lowest public full-window change,
// deterministic coinId tie-break). Dead holdings are excluded: a collapsed
// coin is worth £0 and selling it recovers no cash.
function worstLiveHolding(marketState, snapshot) {
  const ranked = snapshot.holdings
    .filter((entry) => entry.price > 0)
    .map((entry) => ({ entry, change: holdingChange(marketState, entry.holding) }))
    .sort((a, b) => a.change - b.change || a.entry.holding.coinId - b.entry.holding.coinId);
  return ranked.length > 0 ? ranked[0].entry : null;
}

// A personality BUY guarded by the central exposure safeguards AND the
// shared V2-2 resource rules the bot can legally see: the position limit
// (a NEW coin may not be opened at the cap; adding to a held coin is
// always allowed) and the bot's own effective Power (a buy whose shared
// domain cost exceeds the visible balance is a constrained HOLD, not a
// doomed service call — the shared service remains the authoritative
// enforcement point). Clamps the desired stake and degrades to an
// explained HOLD when the rules leave nothing to buy with.
function guardedBuy({ coin, snapshot, profile, maxTradeSize, maxCoinExposureFraction, investedCapScale, marketState }) {
  // Position limit (the bot's own public count/limit): opening a NEW
  // position at the cap is a constrained skip.
  if (marketState && marketState.openPositions) {
    const held = snapshot.holdings.some((e) => e.holding.coinId === coin.coinId);
    if (!held && marketState.openPositions.open >= marketState.openPositions.max) {
      return { type: 'HOLD', reason: 'position-limit' };
    }
  }
  const desired = spendFor(snapshot.cash, profile.stakeFraction, maxTradeSize);
  const spend = clampBuySpend({
    spend: desired,
    coinId: coin.coinId,
    snapshot,
    profile,
    maxCoinExposureFraction,
    investedCapScale
  });
  if (spend === null) return { type: 'HOLD', reason: 'exposure-limits' };
  const buy = boundedBuy(coin, spend);
  if (buy.type === 'HOLD') return { type: 'HOLD', reason: 'exposure-limits' };
  // Power (the bot's own public balance): the SHARED live cost function
  // estimates this order's price in Power; a balance that cannot cover it
  // makes the buy a constrained skip. Selling is never affected — sells
  // cost zero Power by rule.
  if (marketState && marketState.power) {
    const estimatedTotal = round2(buy.quantity * coin.currentPrice);
    if (estimatedTotal > 0) {
      const cost = powerDomain.buyPowerCost(estimatedTotal);
      if (marketState.power.current < cost) {
        return { type: 'HOLD', reason: 'power-constrained' };
      }
    }
  }
  return buy;
}

// The canonical Core 5 personalities, extended for issue #20 with real exit
// strategies under shared, central exposure safeguards, and adapted for
// V2-4 to trade the SAME coarse public signals a human client receives
// (phase, momentum, archetype, collapse-risk, recent public movement) plus
// the bot's own position economics, Power balance and position slots. Each
// personality is REQUIRED to be observably, deterministically distinct —
// and each has reachable SELL behaviour (profit-taking AND loss-cutting):
//   conservative — favours DIP/early-RISE entries reading STABLE/SHAKY,
//                  acts less often, buys small, banks a BOOM as soon as its
//                  momentum stops confirming, walks away from DANGER coins,
//                  dumps meaningful decliners in full, and holds the
//                  strongest late-game cash target.
//   momentum     — enters an ESTABLISHED RISE whose public momentum still
//                  reads UP (later than the Dip Buyer), and exits the
//                  moment the trend stops confirming: public momentum DOWN,
//                  the coin rolling into FALL, or a solid banked gain.
//   dip_buyer    — buys the public DIP phase (or a RISE barely off the
//                  trough, the same public rule the DIP_BOOM benchmark
//                  uses), rides toward the BOOM before selling, tolerates
//                  DANGER entries, holds longer than Conservative, and cuts
//                  a dip that keeps collapsing instead of averaging forever.
//   reckless     — hunts the high-swing DEGEN/RUG archetypes with large
//                  stakes, willingly buys DANGER/CRITICAL readings, locks
//                  big wins and panic-cuts deep losses — sometimes winning
//                  large, sometimes riding a collapse — while the central
//                  caps and universal late/extreme safeguards still bind.
//
// SIM-12 layers on top (still public-state only, still through the shared
// Core 4 ops and the same bounded pressure path as human trades):
//   panic selling  — a held coin whose public recent move breaches the
//                    personality's panic threshold is exited before any
//                    other strategy rule (thresholds and fractions differ
//                    per personality; the Dip Buyer never panics);
//   crash-dip buys — the Dip Buyer treats a crash-sized public drop as a
//                    dip entry in any coarse phase;
//   contrarian     — an otherwise-HOLD decision is occasionally (small
//                    seeded per-personality probability) overridden by a
//                    guarded buy of the most-fallen FALL coin or a trim of
//                    the best BOOM gainer. No two personalities share a
//                    panic threshold, dip rule and contrarian rate, so the
//                    roster stays observably non-identical.
function decideBotAction({
  strategy,
  marketState,
  random,
  maxTradeSize = Infinity,
  maxCoinExposureFraction = DEFAULT_BOT_MAX_COIN_EXPOSURE_FRACTION
}) {
  if (!BOT_STRATEGIES.includes(strategy)) {
    throw new BotServiceError(`unknown bot strategy ${JSON.stringify(strategy)}`, 400);
  }
  // The public-state contract: EXACTLY the allowlisted shape, or a hard
  // error. This is where hidden information is structurally kept out.
  assertPublicBotState(marketState);
  if (typeof random !== 'function') {
    throw new BotServiceError('bot decision requires a random function', 400);
  }
  const profile = BOT_PERSONALITY_PROFILES[strategy];

  const alive = marketState.coins.filter((c) => c.collapsed !== true && c.currentPrice > 0);
  const snapshot = portfolioSnapshot(marketState);
  const phase = liquidationPhase(marketState.apocalypsePercent);
  const buyGuards = { snapshot, profile, maxTradeSize, maxCoinExposureFraction, marketState };

  // Universal endgame pressure. As public Apocalypse progress rises, every
  // personality progressively prefers Cash over open positions — without
  // any knowledge of the future collapse schedule.
  if (phase === 'extreme') {
    // Aggressively liquidate surviving holdings before collapse/settlement.
    const worst = worstLiveHolding(marketState, snapshot);
    if (worst) return boundedSell(worst.holding, 1);
    return { type: 'HOLD', reason: 'extreme-no-live-holdings' };
  }
  if (phase === 'late') {
    // Reduce exposure toward the personality's late-game cash target; no
    // new positions are opened this close to the end.
    const cashFraction = snapshot.wealth > 0 ? snapshot.cash / snapshot.wealth : 1;
    const worst = worstLiveHolding(marketState, snapshot);
    if (worst && cashFraction < profile.lateCashTargetFraction) {
      return boundedSell(worst.holding, profile.lateSellFraction);
    }
    return { type: 'HOLD', reason: 'late-cash-target-met' };
  }

  // Early/mid phases: normal personality strategy. The mid phase still
  // trades, but the invested-fraction cap is scaled down so exposure starts
  // shrinking before the late phase forbids new entries entirely.
  const investedCapScale = phase === 'mid' ? BOT_MID_PHASE_INVESTED_SCALE : 1;

  // Ranked live holdings enriched with the coin's public signals and the
  // position's own P&L. Dead holdings (price £0) are excluded — a collapsed
  // coin can never recover cash.
  const rankedHoldings = snapshot.holdings
    .filter((entry) => entry.price > 0)
    .map((entry) => {
      const coin = marketState.coins.find((c) => c.coinId === entry.holding.coinId);
      return {
        entry,
        coin,
        pnl: holdingPnlFraction(marketState, entry.holding),
        move: coin ? coinMoveFraction(coin) : 0
      };
    });

  // SIM-12 panic selling, differentiated by personality: a held coin whose
  // PUBLIC recent move is a crash-sized drop forces the personality's panic
  // exit (worst public drop first, deterministic tie-break) — Conservative
  // bails in full almost immediately, Momentum trims on a violent drop even
  // before its trend rules confirm, Reckless only folds on a truly violent
  // drop, and the Dip Buyer has no panic threshold at all (a crash is what
  // it hunts). Pure function of the shaped public state — no random draws,
  // no hidden inputs.
  if (typeof profile.panicSellThreshold === 'number') {
    const panicked = rankedHoldings
      .filter((e) => e.coin && e.move <= profile.panicSellThreshold)
      .sort((a, b) => a.move - b.move || a.entry.holding.coinId - b.entry.holding.coinId);
    if (panicked.length > 0) {
      return boundedSell(panicked[0].entry.holding, profile.panicSellFraction);
    }
  }

  // A held coin whose public risk reading has reached the personality's
  // exit level is sold (worst P&L first). This is the intended V2-3
  // decision mechanised per personality: Conservative bails at DANGER,
  // Momentum at CRITICAL; Dip Buyer and Reckless have no risk-only exit.
  function riskExit() {
    if (!profile.exitAtRisk) return null;
    const threshold = riskOrdinal(profile.exitAtRisk);
    const danger = rankedHoldings
      .filter((e) => e.coin && riskOrdinal(e.coin.collapseRisk) >= threshold)
      .sort((a, b) => a.pnl - b.pnl || a.entry.holding.coinId - b.entry.holding.coinId);
    if (danger.length === 0) return null;
    return boundedSell(danger[0].entry.holding, profile.lossSellFraction || profile.profitSellFraction);
  }

  function profitTake(threshold, fraction) {
    const gainers = rankedHoldings
      .filter((e) => e.pnl >= threshold)
      .sort((a, b) => b.pnl - a.pnl || a.entry.holding.coinId - b.entry.holding.coinId);
    if (gainers.length === 0) return null;
    return boundedSell(gainers[0].entry.holding, fraction);
  }

  function lossCut(threshold, fraction, { requireStress = false } = {}) {
    const losers = rankedHoldings
      .filter((e) => e.pnl <= threshold)
      .filter((e) => !requireStress
        || (e.coin && (e.coin.phase === 'FALL' || e.coin.momentum === 'DOWN')))
      .sort((a, b) => a.pnl - b.pnl || a.entry.holding.coinId - b.entry.holding.coinId);
    if (losers.length === 0) return null;
    return boundedSell(losers[0].entry.holding, fraction);
  }

  // Entry candidates under the personality's public-signal rules: alive,
  // coarse phase preferred, public risk no worse than the personality's
  // tolerance. `extraFilter`/`sorter` carry the personality's taste.
  function entryCandidates({ extraFilter = null, sorter = null } = {}) {
    const maxRisk = riskOrdinal(profile.maxEntryRisk);
    return alive
      .filter((coin) => riskOrdinal(coin.collapseRisk) <= maxRisk)
      .filter((coin) => !Array.isArray(profile.preferredEntryPhases)
        || profile.preferredEntryPhases.includes(coin.phase)
        || (extraFilter && extraFilter(coin)))
      .sort(sorter || ((a, b) => a.coinId - b.coinId));
  }

  // SIM-12 occasional contrarian behaviour: only ever converts an
  // otherwise-HOLD decision, with the personality's small seeded
  // probability. Two legal public-state plays, in order: BUY the most
  // fallen FALL-phase coin the personality's risk tolerance allows (fading
  // public pessimism, still through every central guard), or TRIM the best
  // BOOM-phase gainer (fading public euphoria). Returns null when neither
  // play exists — the HOLD stands.
  function contrarianAction() {
    const maxRisk = riskOrdinal(profile.maxEntryRisk);
    const fallen = alive
      .filter((coin) => coin.phase === 'FALL' && riskOrdinal(coin.collapseRisk) <= maxRisk)
      .sort((a, b) => coinMoveFraction(a) - coinMoveFraction(b) || a.coinId - b.coinId);
    if (fallen.length > 0) {
      const buy = guardedBuy({ coin: fallen[0], ...buyGuards, investedCapScale });
      if (buy.type === 'BUY') return buy;
    }
    const euphoric = rankedHoldings
      .filter((e) => e.coin && e.coin.phase === 'BOOM' && e.pnl > 0)
      .sort((a, b) => b.pnl - a.pnl || a.entry.holding.coinId - b.entry.holding.coinId);
    if (euphoric.length > 0) {
      return boundedSell(euphoric[0].entry.holding, 0.25);
    }
    return null;
  }

  // The personality's own strategy logic. Each case returns its decision.
  function personalityDecision() {
  switch (strategy) {
    case 'conservative': {
      // Capital preservation first: bail out of any coin the public risk
      // signal calls DANGEROUS, dump the worst meaningful decliner in full,
      // bank a BOOM the instant its momentum stops confirming, then take a
      // modest profit on the best remaining gainer.
      const dangerExit = riskExit();
      if (dangerExit) return dangerExit;
      const cut = lossCut(profile.lossCutThreshold, profile.lossSellFraction);
      if (cut) return cut;
      if (profile.boomExitOnWeakMomentum) {
        const stalling = rankedHoldings
          .filter((e) => e.coin && e.coin.phase === 'BOOM' && e.coin.momentum !== 'UP')
          .sort((a, b) => b.pnl - a.pnl || a.entry.holding.coinId - b.entry.holding.coinId);
        if (stalling.length > 0) {
          return boundedSell(stalling[0].entry.holding, profile.profitSellFraction);
        }
      }
      const profit = profitTake(profile.profitTakeThreshold, profile.profitSellFraction);
      if (profit) return profit;
      // Preserve cash and Power: act less often, and only a SMALL stake on
      // a DIP/early-RISE coin reading calm — never a dangerous one.
      if (alive.length === 0) return { type: 'HOLD' };
      if (random() >= profile.activityGate) return { type: 'HOLD' };
      const candidates = entryCandidates({
        sorter: (a, b) => (a.phase === 'DIP' ? 0 : 1) - (b.phase === 'DIP' ? 0 : 1)
          || Math.abs(coinMoveFraction(a)) - Math.abs(coinMoveFraction(b))
          || a.coinId - b.coinId
      });
      if (candidates.length === 0) return { type: 'HOLD', reason: 'no-calm-entry' };
      return guardedBuy({ coin: candidates[0], ...buyGuards, investedCapScale });
    }
    case 'momentum': {
      // Trend stops confirming -> reduce: the coin rolled into a FALL, the
      // BOOM's momentum stalled, public momentum reads DOWN on a position
      // that is not even ahead, or the risk signal has gone CRITICAL.
      const weakening = rankedHoldings
        .filter((e) => e.coin && (
          profile.exitOnPhases.includes(e.coin.phase)
          || (profile.boomExitOnWeakMomentum && e.coin.phase === 'BOOM' && e.coin.momentum !== 'UP')
          || (profile.exitOnDownMomentum && e.coin.momentum === 'DOWN' && e.pnl <= 0)
        ))
        .sort((a, b) => a.move - b.move || a.entry.holding.coinId - b.entry.holding.coinId);
      if (weakening.length > 0) {
        return boundedSell(weakening[0].entry.holding, profile.reversalSellFraction);
      }
      const dangerExit = riskExit();
      if (dangerExit) return dangerExit;
      // Then take profit on a solid gain rather than holding indefinitely.
      const profit = profitTake(profile.profitTakeThreshold, profile.profitSellFraction);
      if (profit) return profit;
      if (alive.length === 0) return { type: 'HOLD' };
      // Enter an ESTABLISHED RISE with confirming public momentum — the
      // public momentum reads UP AND the observed short-window history
      // confirms a genuinely positive trend; the strongest recent public
      // move first, seeded random only among the top candidates.
      const risers = entryCandidates({
        extraFilter: null, // preferredEntryPhases (RISE) is the whole rule
        sorter: (a, b) => coinMoveFraction(b) - coinMoveFraction(a) || a.coinId - b.coinId
      }).filter((coin) => coin.momentum === 'UP'
        && shortMomentum(coin, profile.momentumWindow) >= profile.momentumEntryThreshold);
      if (risers.length === 0) return { type: 'HOLD' };
      const pick = risers[Math.floor(random() * Math.min(2, risers.length))];
      return guardedBuy({ coin: pick, ...buyGuards, investedCapScale });
    }
    case 'dip_buyer': {
      // The DIP->BOOM ride completed (or the recovery is meaningful): sell.
      const ridden = rankedHoldings
        .filter((e) => (e.coin && e.coin.phase === 'BOOM') || e.pnl >= profile.recoveryExitThreshold)
        .sort((a, b) => b.pnl - a.pnl || a.entry.holding.coinId - b.entry.holding.coinId);
      if (ridden.length > 0) {
        return boundedSell(ridden[0].entry.holding, 1);
      }
      // The boom did not come: a FALL-phase position meaningfully
      // underwater is cut, and a deep collapse is cut whatever the phase —
      // but a mere FALL wobble is ridden out (this is the personality that
      // may occasionally overstay).
      const falling = rankedHoldings
        .filter((e) => e.pnl <= profile.lossCutThreshold
          || (e.coin && e.coin.phase === 'FALL' && e.pnl <= profile.fallExitThreshold))
        .sort((a, b) => a.pnl - b.pnl || a.entry.holding.coinId - b.entry.holding.coinId);
      if (falling.length > 0) {
        return boundedSell(falling[0].entry.holding, profile.lossSellFraction);
      }
      if (alive.length === 0) return { type: 'HOLD' };
      // Buy the public DIP phase (deepest recent public drop first) or a
      // RISE that has barely left the trough — the same legal public cues
      // as the DIP_BOOM human benchmark. Held coins qualify for an add only
      // when the dip has gone deeper than entry. SIM-12: a crash-sized
      // public drop qualifies as a dip entry in ANY coarse phase (panic
      // selling elsewhere is exactly the dip this personality buys).
      const heldIds = new Set(marketState.holdings.filter((h) => h.quantity > 0).map((h) => h.coinId));
      const candidates = entryCandidates({
        extraFilter: (coin) =>
          (coin.phase === 'RISE' && coin.momentum !== 'DOWN'
            && typeof coin.recentChangePct === 'number'
            && coin.recentChangePct <= profile.riseEntryMaxChangePct)
          || coinMoveFraction(coin) <= profile.crashDipBuyThreshold,
        sorter: (a, b) => coinMoveFraction(a) - coinMoveFraction(b) || a.coinId - b.coinId
      }).filter((coin) => !heldIds.has(coin.coinId) || recentChange(coin) <= profile.dipEntryThreshold);
      if (candidates.length === 0) return { type: 'HOLD' };
      return guardedBuy({ coin: candidates[0], ...buyGuards, investedCapScale });
    }
    case 'reckless': {
      // Lock a big speculative win (best gainer first), then panic-cut a
      // deep loser. Otherwise: a large stake on the swing archetypes —
      // DANGER/CRITICAL readings included — bounded by the central caps.
      const profit = profitTake(profile.profitTakeThreshold, profile.profitSellFraction);
      if (profit) return profit;
      const cut = lossCut(profile.lossCutThreshold, profile.lossSellFraction);
      if (cut) return cut;
      if (alive.length === 0) return { type: 'HOLD' };
      const eligible = alive.filter((coin) => riskOrdinal(coin.collapseRisk) <= riskOrdinal(profile.maxEntryRisk));
      if (eligible.length === 0) return { type: 'HOLD' };
      const preferred = eligible.filter((coin) => profile.preferredArchetypes.includes(coin.archetype));
      const pool = preferred.length > 0 ? preferred : eligible;
      const pick = pool[Math.floor(random() * pool.length)];
      return guardedBuy({ coin: pick, ...buyGuards, investedCapScale });
    }
    default:
      // Unreachable: strategy validated above.
      throw new BotServiceError(`unknown bot strategy ${JSON.stringify(strategy)}`, 400);
  }
  }

  const decided = personalityDecision();
  if (decided.type !== 'HOLD') return decided;
  // SIM-12: an otherwise-HOLD decision is occasionally overridden by the
  // personality's contrarian play (seeded, small probability, public-state
  // only). The draw is consumed ONLY on the HOLD path, so every
  // non-HOLD personality decision keeps its existing stream usage.
  if (random() < profile.contrarianProbability) {
    const contrarian = contrarianAction();
    if (contrarian) return contrarian;
  }
  return decided;
}

// Service-side enforcement of the configured per-trade size cap. The pure
// decision layer already constructs capped trades; this is the authoritative
// enforcement point the tick runs through BEFORE calling the shared trade
// service, so a misconfigured or future decision can never exceed the cap.
// Returns the enforced decision, or null when the cap leaves nothing to trade.
function enforceTradeSizeCap(decision, marketState, maxTradeSize) {
  if (decision.type !== 'BUY' || !Number.isFinite(maxTradeSize)) return decision;
  const coin = marketState.coins.find((c) => c.coinId === decision.coinId);
  if (!coin || !(coin.currentPrice > 0)) return null;
  const cappedQuantity = Math.min(decision.quantity, floor2(maxTradeSize / coin.currentPrice));
  if (cappedQuantity <= 0) return null;
  if (round2(cappedQuantity * coin.currentPrice) > maxTradeSize) return null;
  return { ...decision, quantity: cappedQuantity };
}

// Service-side enforcement of the minimum notional (fcoins_y #6 follow-up):
// bots obey the SAME £0.01 rule as humans. A live-priced decision whose
// authoritative 2-decimal consideration rounds below one penny becomes a
// skip (null) rather than a doomed service call. A £0-priced (collapsed)
// SELL passes through untouched: exiting a dead holding at exactly £0 is
// the designed Core 3 exit, and the shared service exempts it identically.
function enforceMinTradeValue(decision, marketState) {
  if (!decision || (decision.type !== 'BUY' && decision.type !== 'SELL')) return decision;
  const coin = marketState.coins.find((c) => c.coinId === decision.coinId);
  if (!coin || !(coin.currentPrice > 0)) return decision;
  if (round2(decision.quantity * coin.currentPrice) < GAME_MIN_TRADE_VALUE) return null;
  return decision;
}

// ---------------------------------------------------------------------------
// The single scheduler tick. Claims (cycle_id, tick_id) in the durable tick
// ledger FIRST — the unique constraint makes the tick execute at most once
// across every process — then provisions the roster, autojoins each bot as a
// normal Core 4 participant, and lets each bot act exactly once through the
// shared domain trade service. Per-bot domain rejections (e.g. the cycle
// rolled over mid-tick) are recorded on the tick row, never thrown away
// silently and never fatal to the other bots.
// ---------------------------------------------------------------------------
function validateTickId(tickId) {
  if (!Number.isInteger(tickId) || tickId < 0) {
    throw new BotServiceError(`tickId must be a non-negative integer; received ${String(tickId)}`, 400);
  }
  return tickId;
}

// Classify a shared-service domain rejection. V2-2 resource rejections —
// an unaffordable Power cost or the position limit — are EXPECTED bot
// outcomes: the bot observed its own public Power/position state, the
// locked service enforced authoritatively, and the bot simply skips. They
// are recorded as non-fatal skips with a stable reason, never bypassed and
// never converted into direct state mutations. Any other domain rejection
// (stale cycle after a mid-tick rollover, insufficient funds/holdings)
// stays a recorded 'rejected'. Returns null for non-resource rejections.
function classifyBotDomainError(err) {
  if (!err || typeof err.message !== 'string') return null;
  if (err.message.startsWith('Insufficient Power')) return 'power-blocked';
  if (err.message.startsWith('Position limit reached')) return 'position-limit';
  return null;
}

async function runBotTick({ tickId: rawTickId, now = new Date() } = {}) {
  const tickId = validateTickId(rawTickId);
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();

  // Recover/roll the lifecycle first: the Core 1 reconciliation is the
  // cross-process authority on which cycle is live.
  await reconcileCycle({ now });

  // Claim the tick identity. The claim transaction is deliberately short:
  // the trades themselves each run their own Core 4 advisory-locked
  // transaction, so no lock is held across the whole tick.
  const client = await db.getClient();
  let cycle;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT * FROM apocalypse_cycles WHERE status = 'ACTIVE' LIMIT 1`
    );
    cycle = rows[0];
    if (!cycle || new Date(cycle.end_time).getTime() <= nowMs) {
      // Rollover interleaved between reconcile and claim; nothing to do.
      await client.query('COMMIT');
      return { skipped: true, reason: 'no-live-cycle', tickId };
    }
    const claim = await client.query(
      `INSERT INTO apocalypse_bot_ticks (cycle_id, tick_id)
       VALUES ($1, $2)
       ON CONFLICT (cycle_id, tick_id) DO NOTHING
       RETURNING tick_pk`,
      [cycle.cycle_id, tickId]
    );
    if (claim.rows.length === 0) {
      await client.query('COMMIT');
      return {
        skipped: true,
        reason: 'duplicate-tick',
        tickId,
        cycleId: cycle.cycle_id,
        apocalypseId: cycle.apocalypse_id
      };
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // This process owns the tick. Provision + autojoin are idempotent. The
  // validated runtime config governs this tick's limits; it is resolved once
  // so a mid-tick env change cannot reshape the tick.
  const config = resolveBotConfig();
  const roster = await ensureBotsProvisioned();

  const actions = [];
  let actionsTaken = 0; // executed trades this tick (max-actions enforcement)
  for (const bot of roster) {
    const action = { botKey: bot.botKey, action: null, result: 'skipped', reason: null };
    try {
      // Maximum actions per tick: once the cap is reached, remaining bots
      // are explicitly skipped — the tick record shows the enforcement.
      if (actionsTaken >= config.maxActionsPerTick) {
        action.result = 'skipped';
        action.reason = 'max-actions-per-tick';
        actions.push(action);
        continue;
      }
      // Per-bot cooldown, enforced from the PERSISTED last action time (the
      // database is the cross-process authority — no in-memory state).
      if (bot.lastActionAt) {
        const elapsedMs = nowMs - bot.lastActionAt.getTime();
        if (elapsedMs < config.cooldownMs) {
          action.result = 'skipped';
          action.reason = 'cooldown';
          actions.push(action);
          continue;
        }
      }

      // Autojoin through the same domain op humans use: normal participant,
      // normal starting cash, idempotent under repetition and concurrency.
      const participant = await gameRoundService.joinRound({ userId: bot.userId, now });
      const marketState = await buildPublicMarketState({ cycle, participant, now });
      const random = createBotRandom({ seed: cycle.seed, botKey: bot.botKey, tickId });
      const decided = decideBotAction({
        strategy: bot.strategy,
        marketState,
        random,
        maxTradeSize: config.maxTradeSize,
        maxCoinExposureFraction: config.maxCoinExposureFraction
      });
      // Authoritative per-trade size-cap enforcement at the service layer,
      // immediately before the shared trade call. The minimum-notional rule
      // (same one humans face) runs next: a sub-penny trade becomes a skip.
      const capped = enforceTradeSizeCap(decided, marketState, config.maxTradeSize);
      const decision = capped && enforceMinTradeValue(capped, marketState);
      action.action = decision;

      if (decision && decision.type === 'BUY') {
        await gameRoundService.buyRoundTrade({
          userId: bot.userId,
          apocalypseId: cycle.apocalypse_id,
          coinId: decision.coinId,
          quantity: decision.quantity,
          now
        });
        await db.query(
          'UPDATE apocalypse_bots SET last_action_at = $2 WHERE bot_key = $1',
          [bot.botKey, new Date(nowMs)]
        );
        actionsTaken += 1;
        action.result = 'executed';
      } else if (decision && decision.type === 'SELL') {
        await gameRoundService.sellRoundTrade({
          userId: bot.userId,
          apocalypseId: cycle.apocalypse_id,
          coinId: decision.coinId,
          quantity: decision.quantity,
          now
        });
        await db.query(
          'UPDATE apocalypse_bots SET last_action_at = $2 WHERE bot_key = $1',
          [bot.botKey, new Date(nowMs)]
        );
        actionsTaken += 1;
        action.result = 'executed';
      } else if (capped && decision === null) {
        action.result = 'skipped';
        action.reason = 'min-trade-value';
      } else if (decision === null) {
        action.result = 'skipped';
        action.reason = 'trade-size-cap';
      } else {
        action.result = 'skipped';
        action.reason = 'hold';
      }
    } catch (err) {
      if (err && err.name === 'GameRoundError') {
        // A clean domain rejection: recorded, never fatal. V2-4: Power and
        // position-limit rejections are expected resource skips with their
        // own stable reasons; anything else keeps the generic 'rejected'.
        const resourceReason = classifyBotDomainError(err);
        if (resourceReason) {
          action.result = 'skipped';
          action.reason = resourceReason;
        } else {
          action.result = 'rejected';
          action.reason = err.message;
        }
      } else {
        throw err;
      }
    }
    actions.push(action);
  }

  // Durable observability for the executed tick.
  await db.query(
    'UPDATE apocalypse_bot_ticks SET actions = $3 WHERE cycle_id = $1 AND tick_id = $2',
    [cycle.cycle_id, tickId, JSON.stringify(actions)]
  );

  return {
    skipped: false,
    tickId,
    cycleId: cycle.cycle_id,
    apocalypseId: cycle.apocalypse_id,
    actions
  };
}

module.exports = {
  BOT_HISTORY_WINDOW,
  BOT_MARKET_STATE_KEYS,
  BOT_COIN_KEYS,
  BOT_HOLDING_KEYS,
  BOT_POWER_KEYS,
  BOT_OPEN_POSITION_KEYS,
  BotServiceError,
  createBotRandom,
  ensureBotsProvisioned,
  buildPublicMarketState,
  assertPublicBotState,
  liquidationPhase,
  shortMomentum,
  portfolioSnapshot,
  clampBuySpend,
  decideBotAction,
  enforceTradeSizeCap,
  enforceMinTradeValue,
  classifyBotDomainError,
  runBotTick
};
