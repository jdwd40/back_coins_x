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
// processes.

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const db = require('../db/connection');
const { BOT_ROSTER, BOT_STRATEGIES, resolveBotConfig } = require('./botConfig');
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
// maxTradeSize). Every BUY is constructed so quantity * price can never
// exceed cash NOR the configured per-trade size cap; every SELL so quantity
// can never exceed the actual holding; collapsed or zero-priced coins are
// never bought. Returns { type, coinId?, quantity? }.
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

// Recent relative change for a held position, looked up in the public coin
// state by coinId (0 when the coin has no usable history).
function holdingChange(marketState, holding) {
  const coin = marketState.coins.find((c) => c.coinId === holding.coinId);
  return coin ? recentChange(coin) : 0;
}

// A bounded sell of a held position: never more than the actual holding.
function boundedSell(holding, fraction) {
  const quantity = fraction >= 1 ? round2(holding.quantity) : floor2(holding.quantity * fraction);
  if (quantity <= 0) return { type: 'HOLD' };
  return { type: 'SELL', coinId: holding.coinId, quantity };
}

// The personality's desired stake: a fraction of cash, additionally clamped
// by the configured per-trade size cap (and never above cash itself).
function spendFor(cash, fraction, maxTradeSize) {
  const desired = cash * fraction;
  const capped = Number.isFinite(maxTradeSize) ? Math.min(desired, maxTradeSize) : desired;
  return round2(Math.max(0, Math.min(capped, cash)));
}

// Construct a bounded BUY for `coin`: floor-quantized so the total can never
// exceed `spend` (itself a capped fraction of cash). Returns HOLD when
// unaffordable.
function boundedBuy(coin, spend) {
  const quantity = floor2(spend / coin.currentPrice);
  if (quantity <= 0) return { type: 'HOLD' };
  return { type: 'BUY', coinId: coin.coinId, quantity };
}

// The canonical Core 5 personalities. Each is REQUIRED to be observably,
// deterministically distinct:
//   conservative — small stakes, acts less often, preserves cash, and sells
//                  defensively once a holding declines meaningfully.
//   momentum     — buys into a rising coin, and reduces a position after a
//                  negative move.
//   dip_buyer    — buys a meaningfully dropped coin that is still alive, and
//                  sells into a meaningful recovery.
//   reckless     — aggressive: a large stake on a deterministically chosen
//                  eligible coin whenever cash remains.
const CONSERVATIVE_DECLINE_THRESHOLD = -0.05; // defensive sell trigger
const DIP_MEANINGFUL_DROP = -0.10; // dip-buyer entry threshold
const DIP_RECOVERY_THRESHOLD = 0.10; // dip-buyer exit threshold

function decideBotAction({ strategy, marketState, random, maxTradeSize = Infinity }) {
  if (!BOT_STRATEGIES.includes(strategy)) {
    throw new BotServiceError(`unknown bot strategy ${JSON.stringify(strategy)}`, 400);
  }
  validateMarketState(marketState);
  if (typeof random !== 'function') {
    throw new BotServiceError('bot decision requires a random function', 400);
  }

  const alive = marketState.coins.filter((c) => c.collapsed !== true && c.currentPrice > 0);
  const cash = Math.max(0, marketState.cash);
  const holdings = marketState.holdings.filter((h) => h.quantity > 0);

  switch (strategy) {
    case 'conservative': {
      // Defensive first: dump the worst-declining holding in full once its
      // public history shows a meaningful decline.
      const declining = holdings
        .map((holding) => ({ holding, change: holdingChange(marketState, holding) }))
        .filter((entry) => entry.change <= CONSERVATIVE_DECLINE_THRESHOLD)
        .sort((a, b) => a.change - b.change || a.holding.coinId - b.holding.coinId);
      if (declining.length > 0) {
        return boundedSell(declining[0].holding, 1);
      }
      // Preserve cash: act less often, and only with a SMALL stake on the
      // most stable surviving coin.
      if (alive.length === 0) return { type: 'HOLD' };
      if (random() >= 0.5) return { type: 'HOLD' };
      const stable = alive
        .map((coin) => ({ coin, change: Math.abs(recentChange(coin)) }))
        .sort((a, b) => a.change - b.change || a.coin.coinId - b.coin.coinId)[0].coin;
      return boundedBuy(stable, spendFor(cash, 0.05, maxTradeSize));
    }
    case 'momentum': {
      // Reduce after a negative move: halve the worst-performing holding.
      const losers = holdings
        .map((holding) => ({ holding, change: holdingChange(marketState, holding) }))
        .filter((entry) => entry.change < 0)
        .sort((a, b) => a.change - b.change || a.holding.coinId - b.holding.coinId);
      if (losers.length > 0) {
        return boundedSell(losers[0].holding, 0.5);
      }
      if (alive.length === 0) return { type: 'HOLD' };
      // Chase the strongest recent riser. Deterministic tie-break by coinId;
      // the seeded random only chooses among the top risers.
      const risers = alive
        .map((coin) => ({ coin, change: recentChange(coin) }))
        .filter((entry) => entry.change > 0)
        .sort((a, b) => b.change - a.change || a.coin.coinId - b.coin.coinId);
      if (risers.length === 0) return { type: 'HOLD' };
      const pick = risers[Math.floor(random() * Math.min(2, risers.length))].coin;
      return boundedBuy(pick, spendFor(cash, 0.10, maxTradeSize));
    }
    case 'dip_buyer': {
      // Sell into a meaningful recovery on a held position.
      const recovered = holdings
        .map((holding) => ({ holding, change: holdingChange(marketState, holding) }))
        .filter((entry) => entry.change >= DIP_RECOVERY_THRESHOLD)
        .sort((a, b) => b.change - a.change || a.holding.coinId - b.holding.coinId);
      if (recovered.length > 0) {
        return boundedSell(recovered[0].holding, 1);
      }
      if (alive.length === 0) return { type: 'HOLD' };
      // Buy the deepest MEANINGFUL drop among coins that are still alive.
      const dropped = alive
        .map((coin) => ({ coin, change: recentChange(coin) }))
        .filter((entry) => entry.change <= DIP_MEANINGFUL_DROP)
        .sort((a, b) => a.change - b.change || a.coin.coinId - b.coin.coinId);
      if (dropped.length === 0) return { type: 'HOLD' };
      return boundedBuy(dropped[0].coin, spendFor(cash, 0.15, maxTradeSize));
    }
    case 'reckless': {
      // Aggressive: always buys a LARGE stake on a deterministically chosen
      // eligible (alive, positive-priced) coin whenever cash remains.
      if (alive.length === 0) return { type: 'HOLD' };
      const pick = alive[Math.floor(random() * alive.length)];
      return boundedBuy(pick, spendFor(cash, 0.40, maxTradeSize));
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
        maxTradeSize: config.maxTradeSize
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
  decideBotAction,
  enforceTradeSizeCap,
  enforceMinTradeValue,
  runBotTick
};
