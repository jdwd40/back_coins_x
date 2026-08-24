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
// price history, EXECUTED collapse status, the bot's own cash/holdings, and
// apocalypsePercent. Scheduled-but-unexecuted (future) collapse data is
// never read for decisions and never present in the shaped state.
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
const { GAME_MIN_TRADE_VALUE } = require('./gameConstants');
const gameRoundService = require('./gameRoundService');
const { reconcileCycle, deriveProgress } = require('./gameCycleService');

// How many recent price points each coin carries in the shaped public state.
// A fixed game-design constant — deliberately not configurable.
const BOT_HISTORY_WINDOW = 20;

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
// layer may use. Contains: live coin prices, the recent public price history
// window, EXECUTED collapse status for this cycle (a coin that is already
// publicly dead at £0), the bot's own cash/holdings, and apocalypsePercent.
// Future/scheduled collapse data is never selected here.
// ---------------------------------------------------------------------------
async function buildPublicMarketState({ cycle, participant, now = new Date(), queryable = db } = {}) {
  const { rows: coinRows } = await queryable.query(
    `SELECT c.coin_id, c.symbol, c.current_price,
            EXISTS (
              SELECT 1 FROM coin_collapse_schedule s
              WHERE s.cycle_id = $1 AND s.coin_id = c.coin_id AND s.executed_at IS NOT NULL
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
    coins.push({
      coinId: row.coin_id,
      symbol: row.symbol,
      currentPrice: parseFloat(row.current_price),
      collapsed: row.collapsed === true,
      history: historyRows.map((h) => parseFloat(h.price))
    });
  }

  const { apocalypsePercent } = deriveProgress({
    startTime: cycle.start_time,
    endTime: cycle.end_time,
    durationMs: cycle.duration_ms,
    now
  });

  return {
    coins,
    cash: participant.currentCash,
    holdings: participant.holdings.map((h) => ({
      coinId: h.coinId,
      symbol: h.symbol,
      quantity: h.quantity
    })),
    apocalypsePercent
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
function validateMarketState(marketState) {
  if (!marketState || typeof marketState !== 'object') {
    throw new BotServiceError('bot decision requires a shaped market state object', 400);
  }
  if (!Array.isArray(marketState.coins)) {
    throw new BotServiceError('bot decision market state requires a coins array', 400);
  }
  if (typeof marketState.cash !== 'number' || !Number.isFinite(marketState.cash)) {
    throw new BotServiceError('bot decision market state requires a finite cash number', 400);
  }
  if (!Array.isArray(marketState.holdings)) {
    throw new BotServiceError('bot decision market state requires a holdings array', 400);
  }
  if (typeof marketState.apocalypsePercent !== 'number' || !Number.isFinite(marketState.apocalypsePercent)) {
    throw new BotServiceError('bot decision market state requires a finite apocalypsePercent', 400);
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

// A personality BUY guarded by the central exposure safeguards: clamps the
// desired stake and degrades to an explained HOLD when the rules leave
// nothing to buy with.
function guardedBuy({ coin, snapshot, profile, maxTradeSize, maxCoinExposureFraction, investedCapScale }) {
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
  return buy;
}

// The canonical Core 5 personalities, extended for issue #20 with real exit
// strategies under shared, central exposure safeguards. Each personality is
// REQUIRED to be observably, deterministically distinct — and each now has
// reachable SELL behaviour (profit-taking AND loss-cutting):
//   conservative — small stakes, acts less often, preserves cash, takes
//                  modest profits early, dumps meaningful decliners in full,
//                  and holds the strongest late-game cash target.
//   momentum     — buys reachable positive SHORT-window momentum, halves a
//                  position whose trend reverses, takes profit on solid
//                  full-window gains.
//   dip_buyer    — buys a meaningfully dropped coin that is still alive,
//                  sells into a meaningful recovery, and cuts a dip that
//                  keeps collapsing instead of averaging down forever.
//   reckless     — aggressive large stakes, but locks big wins, panic-cuts
//                  deep losses, and is capped so it cannot buy down to ~£0.
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
  validateMarketState(marketState);
  if (typeof random !== 'function') {
    throw new BotServiceError('bot decision requires a random function', 400);
  }
  const profile = BOT_PERSONALITY_PROFILES[strategy];

  const alive = marketState.coins.filter((c) => c.collapsed !== true && c.currentPrice > 0);
  const snapshot = portfolioSnapshot(marketState);
  const phase = liquidationPhase(marketState.apocalypsePercent);

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

  // Ranked live holdings with their public full-window change.
  const rankedHoldings = snapshot.holdings
    .filter((entry) => entry.price > 0)
    .map((entry) => ({ entry, change: holdingChange(marketState, entry.holding) }));

  switch (strategy) {
    case 'conservative': {
      // Capital preservation first: dump the worst meaningful decliner in
      // full, then take a modest profit on the best gainer.
      const declining = rankedHoldings
        .filter((e) => e.change <= profile.lossCutThreshold)
        .sort((a, b) => a.change - b.change || a.entry.holding.coinId - b.entry.holding.coinId);
      if (declining.length > 0) {
        return boundedSell(declining[0].entry.holding, profile.lossSellFraction);
      }
      const gainers = rankedHoldings
        .filter((e) => e.change >= profile.profitTakeThreshold)
        .sort((a, b) => b.change - a.change || a.entry.holding.coinId - b.entry.holding.coinId);
      if (gainers.length > 0) {
        return boundedSell(gainers[0].entry.holding, profile.profitSellFraction);
      }
      // Preserve cash: act less often, and only with a SMALL stake on the
      // most stable surviving coin.
      if (alive.length === 0) return { type: 'HOLD' };
      if (random() >= profile.activityGate) return { type: 'HOLD' };
      const stable = alive
        .map((coin) => ({ coin, change: Math.abs(recentChange(coin)) }))
        .sort((a, b) => a.change - b.change || a.coin.coinId - b.coin.coinId)[0].coin;
      return guardedBuy({ coin: stable, snapshot, profile, maxTradeSize, maxCoinExposureFraction, investedCapScale });
    }
    case 'momentum': {
      // Trend reversal first: halve the holding whose SHORT-window momentum
      // has turned negative (weakest trend first).
      const reversed = rankedHoldings
        .map((e) => {
          const coin = marketState.coins.find((c) => c.coinId === e.entry.holding.coinId);
          return { ...e, momentum: coin ? shortMomentum(coin, profile.momentumWindow) : 0 };
        })
        .filter((e) => e.momentum < 0)
        .sort((a, b) => a.momentum - b.momentum || a.entry.holding.coinId - b.entry.holding.coinId);
      if (reversed.length > 0) {
        return boundedSell(reversed[0].entry.holding, profile.reversalSellFraction);
      }
      // Then take profit on a solid full-window gain rather than holding
      // indefinitely.
      const gainers = rankedHoldings
        .filter((e) => e.change >= profile.profitTakeThreshold)
        .sort((a, b) => b.change - a.change || a.entry.holding.coinId - b.entry.holding.coinId);
      if (gainers.length > 0) {
        return boundedSell(gainers[0].entry.holding, profile.profitSellFraction);
      }
      if (alive.length === 0) return { type: 'HOLD' };
      // Chase the strongest recent riser — reachable by design (short
      // window, low entry bar). Deterministic tie-break by coinId; the
      // seeded random only chooses among the top risers.
      const risers = alive
        .map((coin) => ({ coin, momentum: shortMomentum(coin, profile.momentumWindow) }))
        .filter((entry) => entry.momentum >= profile.momentumEntryThreshold)
        .sort((a, b) => b.momentum - a.momentum || a.coin.coinId - b.coin.coinId);
      if (risers.length === 0) return { type: 'HOLD' };
      const pick = risers[Math.floor(random() * Math.min(2, risers.length))].coin;
      return guardedBuy({ coin: pick, snapshot, profile, maxTradeSize, maxCoinExposureFraction, investedCapScale });
    }
    case 'dip_buyer': {
      // Sell into a meaningful recovery on a held position (best first).
      const recovered = rankedHoldings
        .filter((e) => e.change >= profile.recoveryExitThreshold)
        .sort((a, b) => b.change - a.change || a.entry.holding.coinId - b.entry.holding.coinId);
      if (recovered.length > 0) {
        return boundedSell(recovered[0].entry.holding, 1);
      }
      // Cut a dip that keeps collapsing instead of averaging down forever.
      const collapsing = rankedHoldings
        .filter((e) => e.change <= profile.lossCutThreshold)
        .sort((a, b) => a.change - b.change || a.entry.holding.coinId - b.entry.holding.coinId);
      if (collapsing.length > 0) {
        return boundedSell(collapsing[0].entry.holding, profile.lossSellFraction);
      }
      if (alive.length === 0) return { type: 'HOLD' };
      // Buy the deepest MEANINGFUL drop among coins that are still alive.
      // The central exposure caps stop repeated dip buys from consuming
      // nearly all cash without an exit.
      const dropped = alive
        .map((coin) => ({ coin, change: recentChange(coin) }))
        .filter((entry) => entry.change <= profile.dipEntryThreshold)
        .sort((a, b) => a.change - b.change || a.coin.coinId - b.coin.coinId);
      if (dropped.length === 0) return { type: 'HOLD' };
      return guardedBuy({ coin: dropped[0].coin, snapshot, profile, maxTradeSize, maxCoinExposureFraction, investedCapScale });
    }
    case 'reckless': {
      // Lock a big speculative win (best gainer first), then panic-cut a
      // deep loser. Otherwise: a large stake on a deterministically chosen
      // eligible coin, bounded by the central caps so endless buying can no
      // longer spend the bankroll down toward £0.
      const winners = rankedHoldings
        .filter((e) => e.change >= profile.profitTakeThreshold)
        .sort((a, b) => b.change - a.change || a.entry.holding.coinId - b.entry.holding.coinId);
      if (winners.length > 0) {
        return boundedSell(winners[0].entry.holding, profile.profitSellFraction);
      }
      const deepLosers = rankedHoldings
        .filter((e) => e.change <= profile.lossCutThreshold)
        .sort((a, b) => a.change - b.change || a.entry.holding.coinId - b.entry.holding.coinId);
      if (deepLosers.length > 0) {
        return boundedSell(deepLosers[0].entry.holding, profile.lossSellFraction);
      }
      if (alive.length === 0) return { type: 'HOLD' };
      const pick = alive[Math.floor(random() * alive.length)];
      return guardedBuy({ coin: pick, snapshot, profile, maxTradeSize, maxCoinExposureFraction, investedCapScale });
    }
    default:
      // Unreachable: strategy validated above.
      throw new BotServiceError(`unknown bot strategy ${JSON.stringify(strategy)}`, 400);
  }
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
        // A clean domain rejection (stale cycle after a mid-tick rollover,
        // insufficient funds/holdings): recorded, never fatal.
        action.result = 'rejected';
        action.reason = err.message;
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
  BotServiceError,
  createBotRandom,
  ensureBotsProvisioned,
  buildPublicMarketState,
  liquidationPhase,
  shortMomentum,
  portfolioSnapshot,
  clampBuySpend,
  decideBotAction,
  enforceTradeSizeCap,
  enforceMinTradeValue,
  runBotTick
};
