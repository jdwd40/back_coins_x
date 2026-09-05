// Persistent-market Stage 8: persistent roster bots (master plan §8).
//
// The SAME four roster personalities (botConfig.BOT_PERSONALITY_PROFILES)
// now trade THE persistent economy through the shared persistent domain
// services (persistentEconomy.buy/sell, persistentDebt.issue/repay) —
// never through HTTP/controllers and never through direct state edits, so
// every Stage 5/8 guarantee (one client, locked server price, guarded
// writes, ledger-after-success, debt invariants) applies to bots
// identically.
//
// Determinism: every pseudo-random choice comes from the SHA-256 counter
// stream (botService.createBotRandom) keyed by the persistent world seed +
// the bot's stable identity + the tick id. Same inputs -> identical
// decisions, in every process, forever. Math.random() is never used.
//
// Public-state-only decisions: the decision layer accepts ONLY the shaped
// public state built here — live coin prices, recent public price history,
// permanent death status, the SAME coarse persistent public signals
// (phase/momentum/archetype/recent movement/collapse-risk level, computed
// through game/persistentSignals — the shape the Stage 11 human endpoint
// will share), and the bot's own cash/debt/holdings economics. No Director
// rolls, no world internals, no future information; the world seed is used
// ONLY to evaluate the shared public-signal domains and to key the
// deterministic random stream — it never enters the shaped state. The
// exact-key allowlist (assertPublicPersistentBotState) runs on every
// decision input, live and simulated alike.
//
// Versus the retired cycle bot surface: no apocalypsePercent, no Power, no
// position cap (humans shed those in Stage 7; bots keep only their
// personality EXPOSURE limits — invested-fraction cap, cash reserve,
// per-trade stake). Debt is bot-only: a bankrupt bot (no usable cash AND no
// meaningful sellable holdings) takes an interest-free loan; cash above the
// operating reserve repays outstanding debt first, automatically.
//
// Tick identity: runPersistentBotTick claims (world_id, tick_id) in
// persistent_bot_ticks with INSERT ... ON CONFLICT DO NOTHING — at most one
// execution per tick across every process. This module owns no timers.

const db = require('../db/connection');
const persistentWorld = require('./persistentWorld');
const persistentEconomy = require('./persistentEconomy');
const persistentDebt = require('./persistentDebt');
const persistentSignals = require('./persistentSignals');
const checkpointModel = require('../models/pricingCheckpoint.model');
const coinStateModel = require('../models/marketCoinState.model');
const marketDomain = require('./marketDomain');
const {
  BOT_ROSTER,
  BOT_PERSONALITY_PROFILES,
  DEFAULT_BOT_MAX_TRADE_SIZE
} = require('./botConfig');
const {
  GAME_MIN_TRADE_VALUE,
  GAME_QUANTITY_DECIMALS
} = require('./gameConstants');
const { createBotRandom, ensureBotsProvisioned } = require('./botService');

class PersistentBotError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'PersistentBotError';
    this.status = status;
  }
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function floorQuantity(value) {
  const factor = 10 ** GAME_QUANTITY_DECIMALS;
  return Math.floor(value * factor) / factor;
}

// Coarse risk severity order for the public maxEntryRisk/exitAtRisk rules.
const RISK_RANK = Object.freeze({ STABLE: 0, SHAKY: 1, DANGER: 2, CRITICAL: 3, DEAD: 4 });

// ---------------------------------------------------------------------------
// The shaped PUBLIC bot state contract (exact-key allowlists). No seed, no
// Director internals, no cycle/apocalypse identifier, no Power, no position
// cap — an extra OR missing key is a hard error.
// ---------------------------------------------------------------------------
const PERSISTENT_BOT_STATE_KEYS = Object.freeze(['coins', 'cash', 'debt', 'holdings']);
const PERSISTENT_BOT_COIN_KEYS = Object.freeze([
  'coinId', 'symbol', 'currentPrice', 'dead', 'history',
  'phase', 'momentum', 'archetype', 'collapseRisk', 'recentChangePct'
]);
const PERSISTENT_BOT_HOLDING_KEYS = Object.freeze([
  'coinId', 'symbol', 'quantity', 'costBasis', 'averageEntryPrice',
  'currentValue', 'unrealizedPnlPct'
]);

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
// every simulated decision alike).
function assertPublicPersistentBotState(marketState) {
  if (!marketState || typeof marketState !== 'object') {
    throw new PersistentBotError('persistent bot decision requires a shaped market state object', 400);
  }
  const stateViolations = keyViolations(marketState, PERSISTENT_BOT_STATE_KEYS);
  if (stateViolations.length > 0) {
    throw new PersistentBotError(`persistent bot market state contract violated: ${stateViolations.join(', ')}`, 500);
  }
  if (!Array.isArray(marketState.coins) || !Array.isArray(marketState.holdings)) {
    throw new PersistentBotError('persistent bot market state coins/holdings must be arrays', 500);
  }
  for (const coin of marketState.coins) {
    const violations = keyViolations(coin, PERSISTENT_BOT_COIN_KEYS);
    if (violations.length > 0) {
      throw new PersistentBotError(`persistent bot coin state contract violated for ${JSON.stringify(coin && coin.symbol)}: ${violations.join(', ')}`, 500);
    }
  }
  for (const holding of marketState.holdings) {
    const violations = keyViolations(holding, PERSISTENT_BOT_HOLDING_KEYS);
    if (violations.length > 0) {
      throw new PersistentBotError(`persistent bot holding contract violated for ${JSON.stringify(holding && holding.symbol)}: ${violations.join(', ')}`, 500);
    }
  }
}

// ---------------------------------------------------------------------------
// Build the shaped public state from the database. The world seed enters the
// shared public-signal domain evaluation ONLY (exactly like the human-facing
// signals); it is never present in the returned shape.
// ---------------------------------------------------------------------------
async function buildPublicPersistentMarketState({ world, account, nowMs, queryable = db, historyWindow = 20 } = {}) {
  const { rows: coinRows } = await queryable.query(
    `SELECT c.coin_id, c.symbol, c.current_price, c.retired
       FROM coins c
      WHERE c.retired = FALSE
      ORDER BY c.coin_id`
  );
  const stateByCoinId = await coinStateModel.loadCoinStates(queryable, world.worldId);
  // Checkpoints are keyed by the world's seed (migration 023 contract).
  const checkpointByCoinId = await checkpointModel.loadCheckpoints(queryable, world.seed);

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
      [row.coin_id, historyWindow]
    );
    const history = historyRows.map((h) => parseFloat(h.price));
    const state = stateByCoinId.get(row.coin_id) || null;
    const dead = state !== null && state.status === 'DEAD';
    const archetypeId = state ? state.archetype : marketDomain.resolveArchetypeId(row.coin_id);
    const base = {
      coinId: row.coin_id,
      symbol: row.symbol,
      currentPrice: dead ? 0 : parseFloat(row.current_price),
      dead,
      history
    };
    if (dead) {
      const marker = persistentSignals.deadPersistentSignal({ coinId: row.coin_id, archetypeId });
      coins.push({
        ...base,
        phase: marker.phase,
        momentum: marker.momentum,
        archetype: marker.archetype,
        collapseRisk: marker.collapseRisk,
        recentChangePct: marker.recentChangePct
      });
      continue;
    }
    const signal = persistentSignals.computePersistentCoinSignal({
      seed: world.seed,
      coinId: row.coin_id,
      archetypeId,
      originMs: world.epochStartedAtMs,
      nowMs,
      structuralReference: state ? state.structuralReference : parseFloat(row.current_price),
      condition: state ? state.condition : 0,
      checkpoint: checkpointByCoinId.get(row.coin_id) || null
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

  return {
    coins,
    cash: account ? account.cash : 0,
    debt: account ? account.debt : 0,
    holdings: (account ? account.holdings : []).map((h) => ({
      coinId: h.coinId,
      symbol: h.symbol,
      quantity: h.quantity,
      costBasis: h.costBasis,
      averageEntryPrice: h.averageEntryPrice,
      currentValue: h.currentValue,
      unrealizedPnlPct: h.unrealizedPnlPct
    }))
  };
}

// ---------------------------------------------------------------------------
// The pure decision layer. Deterministic given (strategy, shaped state,
// random, config). Every BUY is constructed so quantity * price can never
// exceed cash NOR the per-trade size cap NOR the personality exposure
// limits (invested fraction, cash reserve); every SELL so quantity can never
// exceed the actual holding; dead or zero-priced coins are never bought.
// Returns { type, coinId?, quantity?, reason? } — reason explains HOLDs.
// ---------------------------------------------------------------------------
function decidePersistentBotAction({ strategy, state, random, maxTradeSize = DEFAULT_BOT_MAX_TRADE_SIZE }) {
  const profile = BOT_PERSONALITY_PROFILES[strategy];
  if (!profile) {
    throw new PersistentBotError(`unknown persistent bot strategy ${JSON.stringify(strategy)}`, 500);
  }
  assertPublicPersistentBotState(state);

  const { coins, cash, debt, holdings } = state;
  const holdingsValue = round2(holdings.reduce((sum, h) => sum + h.currentValue, 0));
  const wealth = round2(cash + holdingsValue);
  const coinById = new Map(coins.map((coin) => [coin.coinId, coin]));

  // --- Exit rules for held LIVE positions (one action per decision) --------
  for (const holding of holdings) {
    if (!(holding.quantity > 0)) continue;
    const coin = coinById.get(holding.coinId);
    if (!coin || coin.dead) continue; // dead holdings are unsellable history
    const pnlFraction = holding.averageEntryPrice !== null && holding.averageEntryPrice > 0
      ? (coin.currentPrice - holding.averageEntryPrice) / holding.averageEntryPrice
      : (holding.unrealizedPnlPct !== null ? holding.unrealizedPnlPct / 100 : 0);

    // Panic: a crash-sized public drop on a held coin (SIM-12 behaviour).
    if (profile.panicSellThreshold !== undefined
        && coin.recentChangePct !== null
        && coin.recentChangePct / 100 <= profile.panicSellThreshold) {
      const quantity = floorQuantity(holding.quantity * (profile.panicSellFraction ?? 1));
      if (quantity > 0 && round2(quantity * coin.currentPrice) >= GAME_MIN_TRADE_VALUE) {
        return { type: 'SELL', coinId: coin.coinId, quantity, reason: 'panic' };
      }
    }
    // Risk exit: the public collapse-risk reading turned unacceptable.
    if (profile.exitAtRisk !== undefined && RISK_RANK[coin.collapseRisk] >= RISK_RANK[profile.exitAtRisk]) {
      return { type: 'SELL', coinId: coin.coinId, quantity: holding.quantity, reason: 'risk-exit' };
    }
    // Profit-taking above the public gain threshold.
    if (profile.profitTakeThreshold !== undefined && pnlFraction >= profile.profitTakeThreshold) {
      const quantity = floorQuantity(holding.quantity * (profile.profitSellFraction ?? 1));
      if (quantity > 0 && round2(quantity * coin.currentPrice) >= GAME_MIN_TRADE_VALUE) {
        return { type: 'SELL', coinId: coin.coinId, quantity, reason: 'profit-take' };
      }
    }
    // Loss-cutting below the public decline threshold.
    if (profile.lossCutThreshold !== undefined && pnlFraction <= profile.lossCutThreshold) {
      const quantity = floorQuantity(holding.quantity * (profile.lossSellFraction ?? 1));
      if (quantity > 0 && round2(quantity * coin.currentPrice) >= GAME_MIN_TRADE_VALUE) {
        return { type: 'SELL', coinId: coin.coinId, quantity, reason: 'loss-cut' };
      }
    }
    // Momentum personality: the trend stopped confirming.
    if (profile.exitOnDownMomentum && coin.momentum === 'DOWN') {
      const quantity = floorQuantity(holding.quantity * (profile.reversalSellFraction ?? 1));
      if (quantity > 0 && round2(quantity * coin.currentPrice) >= GAME_MIN_TRADE_VALUE) {
        return { type: 'SELL', coinId: coin.coinId, quantity, reason: 'momentum-reversal' };
      }
    }
    if (profile.exitOnPhases && profile.exitOnPhases.includes(coin.phase)) {
      const quantity = floorQuantity(holding.quantity * (profile.reversalSellFraction ?? 1));
      if (quantity > 0 && round2(quantity * coin.currentPrice) >= GAME_MIN_TRADE_VALUE) {
        return { type: 'SELL', coinId: coin.coinId, quantity, reason: 'phase-exit' };
      }
    }
  }

  // --- Entry rules ----------------------------------------------------------
  const heldIds = new Set(holdings.filter((h) => h.quantity > 0).map((h) => h.coinId));
  const contrarian = random() < (profile.contrarianProbability ?? 0);
  const gated = profile.activityGate !== undefined && random() >= profile.activityGate;

  const candidates = coins.filter((coin) => {
    if (coin.dead || !(coin.currentPrice > 0)) return false;
    if (heldIds.has(coin.coinId)) return false;
    if (RISK_RANK[coin.collapseRisk] > RISK_RANK[profile.maxEntryRisk]) return false;
    if (contrarian) {
      // Contrarian entries hunt the public dip/crash anywhere it shows.
      return coin.phase === 'DIP'
        || coin.phase === 'FALL'
        || (coin.recentChangePct !== null && profile.crashDipBuyThreshold !== undefined
            && coin.recentChangePct / 100 <= profile.crashDipBuyThreshold);
    }
    if (profile.preferredArchetypes) {
      return profile.preferredArchetypes.includes(coin.archetype);
    }
    if (profile.preferredEntryPhases && profile.preferredEntryPhases.includes(coin.phase)) {
      if (strategy === 'momentum') {
        return coin.momentum === 'UP'
          && coin.recentChangePct !== null
          && coin.recentChangePct / 100 >= (profile.momentumEntryThreshold ?? 0);
      }
      if (strategy === 'dip_buyer') {
        const dipped = coin.recentChangePct !== null && coin.recentChangePct / 100 <= (profile.dipEntryThreshold ?? -Infinity);
        const barelyOffTrough = coin.phase === 'RISE'
          && coin.recentChangePct !== null
          && coin.recentChangePct <= (profile.riseEntryMaxChangePct ?? 0);
        const crashDip = profile.crashDipBuyThreshold !== undefined
          && coin.recentChangePct !== null
          && coin.recentChangePct / 100 <= profile.crashDipBuyThreshold;
        return coin.phase === 'DIP' || barelyOffTrough || crashDip || dipped;
      }
      return true;
    }
    return false;
  });

  if (candidates.length > 0 && !gated) {
    // Deterministic candidate choice: seeded random over the stable order.
    const coin = candidates[Math.floor(random() * candidates.length) % candidates.length];
    // Stake: personality fraction of cash, capped by the per-trade size cap,
    // the invested-fraction cap and the cash-reserve floor (exposure limits
    // are the bot-only risk controls; there is no Power and no position cap).
    const investedCap = round2(profile.maxInvestedFraction * wealth) - holdingsValue;
    const reserveFloor = round2(profile.minCashReserveFraction * wealth);
    const spendable = round2(Math.min(profile.stakeFraction * cash, maxTradeSize, Math.max(0, investedCap), Math.max(0, cash - reserveFloor)));
    if (spendable >= GAME_MIN_TRADE_VALUE) {
      const quantity = floorQuantity(spendable / coin.currentPrice);
      if (quantity > 0 && round2(quantity * coin.currentPrice) >= GAME_MIN_TRADE_VALUE) {
        return {
          type: 'BUY',
          coinId: coin.coinId,
          quantity,
          reason: contrarian ? 'contrarian-entry' : 'entry'
        };
      }
    }
  }

  // --- Bankruptcy: no usable cash AND nothing meaningful left to sell -------
  const sellableProceeds = round2(
    holdings
      .filter((h) => h.quantity > 0 && coinById.get(h.coinId) && !coinById.get(h.coinId).dead)
      .reduce((sum, h) => sum + h.currentValue, 0)
  );
  if (persistentDebt.isPersistentBankrupt({ cash, sellableProceeds })) {
    return { type: 'LOAN', reason: 'bankrupt' };
  }

  return { type: 'HOLD', reason: candidates.length === 0 ? 'no-entry-signal' : (gated ? 'activity-gate' : 'no-affordable-entry') };
}

// ---------------------------------------------------------------------------
// Tick execution. Claims (world_id, tick_id) first — a claimed tick is a
// no-op everywhere else. Then each roster bot: provision (idempotent), read
// its account, build+assert the shaped public state, decide, execute through
// the shared persistent services, repay debt above the reserve after any
// cash inflow. A domain rejection (price moved mid-tick, a coin died) is
// recorded as a non-fatal skip — never bypassed, never a direct mutation.
// ---------------------------------------------------------------------------
async function runPersistentBotTick({ tickId, nowMs = Date.now(), queryable = db } = {}) {
  if (!Number.isInteger(tickId) || tickId < 0) {
    throw new PersistentBotError(`persistent bot tickId must be a non-negative integer; received ${String(tickId)}`, 400);
  }
  const world = await persistentWorld.resolveActiveWorld(queryable);

  // Claim the tick: the database is the duplicate-tick authority.
  const { rows: claimed } = await queryable.query(
    `INSERT INTO persistent_bot_ticks (world_id, tick_id)
     VALUES ($1, $2)
     ON CONFLICT (world_id, tick_id) DO NOTHING
     RETURNING tick_id`,
    [world.worldId, tickId]
  );
  if (claimed.length === 0) {
    return { tickId, claimed: false, actions: [] };
  }

  // Roster identity provisioning is idempotent and shared with the legacy
  // worker (same users rows, same unauthenticatable credentials).
  const roster = await ensureBotsProvisioned({ queryable });

  const actions = [];
  for (const bot of roster) {
    await persistentEconomy.provisionPersistentAccount({ userId: bot.userId, queryable });
    const account = await persistentEconomy.getPersistentAccountState({ userId: bot.userId, queryable });
    const state = await buildPublicPersistentMarketState({ world, account, nowMs, queryable });
    const random = createBotRandom({ seed: world.seed, botKey: bot.botKey, tickId });

    let decision;
    try {
      decision = decidePersistentBotAction({ strategy: bot.strategy, state, random });
    } catch (err) {
      actions.push({ botKey: bot.botKey, userId: bot.userId, action: 'SKIP', reason: `decision-error: ${err.message}` });
      continue;
    }

    try {
      if (decision.type === 'BUY') {
        const result = await persistentEconomy.buyPersistentTrade({ userId: bot.userId, coinId: decision.coinId, quantity: decision.quantity });
        actions.push({ botKey: bot.botKey, userId: bot.userId, action: 'BUY', coinId: decision.coinId, quantity: decision.quantity, reason: decision.reason, totalAmount: result.transaction.totalAmount });
      } else if (decision.type === 'SELL') {
        const result = await persistentEconomy.sellPersistentTrade({ userId: bot.userId, coinId: decision.coinId, quantity: decision.quantity });
        actions.push({ botKey: bot.botKey, userId: bot.userId, action: 'SELL', coinId: decision.coinId, quantity: decision.quantity, reason: decision.reason, totalAmount: result.transaction.totalAmount });
        // Cash inflow: outstanding debt is repaid first, above the reserve.
        const repayment = await persistentDebt.repayBotDebt({ userId: bot.userId });
        if (repayment.repaid > 0) {
          actions.push({ botKey: bot.botKey, userId: bot.userId, action: 'REPAY', amount: repayment.repaid, debt: repayment.debt });
        }
      } else if (decision.type === 'LOAN') {
        const loan = await persistentDebt.issueBotLoan({ userId: bot.userId });
        actions.push({ botKey: bot.botKey, userId: bot.userId, action: 'LOAN', amount: loan.amount, debt: loan.debt, reason: decision.reason });
      } else {
        actions.push({ botKey: bot.botKey, userId: bot.userId, action: 'HOLD', reason: decision.reason });
      }
    } catch (err) {
      // A residual authoritative rejection (mid-tick price move, a coin
      // dying between read and write, a no-longer-bankrupt loan request) is
      // a non-fatal skip — the shared services already rolled back cleanly.
      actions.push({
        botKey: bot.botKey,
        userId: bot.userId,
        action: 'SKIP',
        reason: `${decision.type.toLowerCase()}-rejected: ${err.message}`
      });
    }
  }

  return { tickId, claimed: true, actions };
}

module.exports = {
  PERSISTENT_BOT_STATE_KEYS,
  PERSISTENT_BOT_COIN_KEYS,
  PERSISTENT_BOT_HOLDING_KEYS,
  PersistentBotError,
  assertPublicPersistentBotState,
  buildPublicPersistentMarketState,
  decidePersistentBotAction,
  runPersistentBotTick
};
