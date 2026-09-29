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
// stream (persistentBotProvisioning.createBotRandom) keyed by the persistent world seed +
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
const persistentMarketSignalsService = require('./persistentMarketSignalsService');
const defaultLogger = require('../utils/logger');
const checkpointModel = require('../models/pricingCheckpoint.model');
const coinStateModel = require('../models/marketCoinState.model');
const eventsModel = require('../models/persistentCoinEvents.model');
const persistentCoinEventDomain = require('./persistentCoinEventDomain');
const marketDomain = require('./marketDomain');
const { resolveSimulationConfig } = require('./simulationConfig');
const {
  BOT_ROSTER,
  BOT_PERSONALITY_PROFILES,
  DEFAULT_BOT_MAX_TRADE_SIZE
} = require('./botConfig');
const {
  GAME_MIN_TRADE_VALUE,
  GAME_QUANTITY_DECIMALS
} = require('./gameConstants');
const { createBotRandom, ensureBotsProvisioned } = require('./persistentBotProvisioning');


// Persistent provenance: only world-scoped writer ticks.
const PERSISTENT_PH = "source = 'MARKET_TICK' AND cycle_id IS NULL";

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
// The tick-wide public market snapshot. Loaded ONCE per bot tick (and read
// under one REPEATABLE READ snapshot when this module owns the connection),
// then shared by every bot in that tick — so a market-writer batch that
// commits mid-tick can never hand a later bot a checkpoint newer than the
// tick instant, and every bot in a tick decides against identical public
// data.
//
// Signals are built from COMMITTED data only (persistentSignals.
// computeCommittedPersistentCoinSignal): currentPrice is coins.current_price
// and the recent-movement comparison price is the last committed persistent
// price tick at least one public lookback old, loaded through the SAME
// query as GET /api/persistent/signals (loadCommittedPastPrices) — there is
// no epoch replay, so the world's age can never trip the pricing engine's
// bounded-walk guard, and bot movement always agrees with the endpoint.
// The coin's latest committed checkpoint is used only for the current
// coarse phase.
//
// Fault isolation: a coin whose signal cannot be built is logged with its
// coin id and left out of this tick's snapshot (never traded into, never
// sold against a fabricated signal); every other coin/bot continues. The
// failures are returned so the tick can surface a systemic failure.
//
// The world seed enters the shared public-signal domain evaluation ONLY
// (exactly like the human-facing signals); it is never present in the
// returned shape.
// ---------------------------------------------------------------------------
async function readMarketSnapshotRows({ world, nowMs, queryable, historyWindow }) {
  const { rows: coinRows } = await queryable.query(
    `SELECT c.coin_id, c.symbol, c.current_price, c.retired
       FROM coins c
      WHERE c.retired = FALSE
      ORDER BY c.coin_id`
  );
  // Plain (non-locking) reads through the models' own row mappers. The
  // writer-side loaders take FOR UPDATE row locks, which a read-only bot
  // snapshot must never take: they would contend with the market writer's
  // batch and are refused inside a READ ONLY transaction.
  const { rows: stateRows } = await queryable.query(
    `SELECT coin_id, world_id, archetype, condition, structural_reference,
            peak_reference, status, died_at
       FROM market_coin_state
      WHERE world_id = $1`,
    [world.worldId]
  );
  const stateByCoinId = new Map(stateRows.map((r) => [Number(r.coin_id), coinStateModel.rowToState(r)]));
  // Checkpoints are keyed by the world's seed (migration 023 contract).
  // Only the latest committed checkpoint per coin is read, and only for the
  // current coarse phase.
  const { rows: checkpointRows } = await queryable.query(
    `SELECT coin_id, seed, checkpoint_ms,
            domain_cycle_index, domain_cycle_start_ms, domain_anchor, domain_boundary,
            crash_episode_index, crash_cursor_ms, crash_factor, activation_context
       FROM market_price_checkpoints
      WHERE seed = $1`,
    [world.seed]
  );
  const checkpointByCoinId = new Map(checkpointRows.map((r) => [Number(r.coin_id), checkpointModel.rowToCheckpoint(r)]));
  // Wave 3: the world's ACTIVE persistent coin events at nowMs. The phase
  // evaluation needs the same current committed capped net modifier the
  // writer priced with. Only the resulting coarse public fields enter the
  // shaped state — the modifier itself, event payloads, seeds and Director
  // internals never do (the exact-key allowlist below is unchanged).
  const activeEvents = await eventsModel.listActivePersistentCoinEvents(queryable, world.worldId, nowMs);
  const activeEventsByCoin = new Map();
  for (const event of activeEvents) {
    if (!activeEventsByCoin.has(event.coinId)) activeEventsByCoin.set(event.coinId, []);
    activeEventsByCoin.get(event.coinId).push(event);
  }
  const historyByCoinId = new Map();
  for (const row of coinRows) {
    const { rows: historyRows } = await queryable.query(
      `SELECT price FROM (
         SELECT price, created_at FROM price_history
         WHERE coin_id = $1
           AND ${PERSISTENT_PH}
         ORDER BY created_at DESC
         LIMIT $2
       ) recent
       ORDER BY created_at ASC`,
      [row.coin_id, historyWindow]
    );
    historyByCoinId.set(row.coin_id, historyRows.map((h) => parseFloat(h.price)));
  }
  // The committed comparison prices — the SAME query as the public
  // /api/persistent/signals endpoint.
  const pastPrices = await persistentMarketSignalsService.loadCommittedPastPrices(queryable, {
    coinIds: coinRows.map((r) => r.coin_id),
    nowMs,
    epochStartedAtMs: world.epochStartedAtMs
  });
  return { coinRows, stateByCoinId, checkpointByCoinId, activeEventsByCoin, historyByCoinId, pastPrices };
}

async function loadPersistentBotMarketSnapshot({ world, nowMs, queryable = db, historyWindow = 20, config = resolveSimulationConfig(), logger = defaultLogger } = {}) {
  let rows;
  if (queryable === db) {
    const client = await db.getClient();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      rows = await readMarketSnapshotRows({ world, nowMs, queryable: client, historyWindow });
      await client.query('COMMIT');
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) { /* original error wins */ }
      throw err;
    } finally {
      client.release();
    }
  } else {
    rows = await readMarketSnapshotRows({ world, nowMs, queryable, historyWindow });
  }
  const { coinRows, stateByCoinId, checkpointByCoinId, activeEventsByCoin, historyByCoinId, pastPrices } = rows;

  const coins = [];
  const failures = [];
  let liveCoinCount = 0;
  for (const row of coinRows) {
    const history = historyByCoinId.get(row.coin_id) || [];
    const state = stateByCoinId.get(row.coin_id) || null;
    const dead = state !== null && state.status === 'DEAD';
    const base = {
      coinId: row.coin_id,
      symbol: row.symbol,
      currentPrice: dead ? 0 : parseFloat(row.current_price),
      dead,
      history
    };
    if (!dead) liveCoinCount += 1;
    try {
      const archetypeId = state ? state.archetype : marketDomain.resolveArchetypeId(row.coin_id);
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
      const signal = persistentSignals.computeCommittedPersistentCoinSignal({
        seed: world.seed,
        coinId: row.coin_id,
        archetypeId,
        originMs: world.epochStartedAtMs,
        nowMs,
        structuralReference: state ? state.structuralReference : parseFloat(row.current_price),
        condition: state ? state.condition : 0,
        eventModifier: persistentCoinEventDomain.netActiveModifierCapped(
          activeEventsByCoin.get(row.coin_id) || [], nowMs, config
        ),
        checkpoint: checkpointByCoinId.get(row.coin_id) || null,
        currentPrice: base.currentPrice,
        pastPrice: pastPrices.has(row.coin_id) ? pastPrices.get(row.coin_id) : null,
        config
      });
      coins.push({
        ...base,
        phase: signal.phase,
        momentum: signal.momentum,
        archetype: signal.archetype,
        collapseRisk: signal.collapseRisk,
        recentChangePct: signal.recentChangePct
      });
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      failures.push({ coinId: row.coin_id, dead, message });
      logger.error(`[GAME] Persistent bot signal failed for coin ${row.coin_id} (${row.symbol}); coin excluded from this bot tick: ${message}`);
    }
  }

  return { nowMs, coins, failures, liveCoinCount };
}

// The shaped public state for one bot: the tick's shared coin snapshot plus
// the bot's own account economics. Without a snapshot (direct callers) one
// is loaded for this call.
async function buildPublicPersistentMarketState({ world, account, nowMs, queryable = db, historyWindow = 20, config = resolveSimulationConfig(), snapshot = null, logger = defaultLogger } = {}) {
  const market = snapshot || await loadPersistentBotMarketSnapshot({ world, nowMs, queryable, historyWindow, config, logger });
  return {
    // Per-bot copies: the decision layer is pure, but no bot can ever see
    // another bot's view mutated.
    coins: market.coins.map((c) => ({ ...c, history: [...c.history] })),
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
async function runPersistentBotTick({ tickId, nowMs = Date.now(), queryable = db, logger = defaultLogger } = {}) {
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

  // ONE public market snapshot for the whole tick (see
  // loadPersistentBotMarketSnapshot): every bot decides against the same
  // committed state, however many writer batches commit meanwhile.
  const snapshot = await loadPersistentBotMarketSnapshot({ world, nowMs, queryable, logger });
  const liveFailures = snapshot.failures.filter((f) => !f.dead);
  if (snapshot.liveCoinCount > 0 && liveFailures.length === snapshot.liveCoinCount) {
    // Systemic, not a single bad coin: fail the tick loudly.
    const sample = liveFailures.slice(0, 3).map((f) => `coin ${f.coinId}: ${f.message}`).join('; ');
    logger.error(`[GAME] Persistent bot signals failed for ALL ${snapshot.liveCoinCount} live coins; aborting bot tick ${tickId}`);
    throw new PersistentBotError(`persistent bot signals failed for all ${snapshot.liveCoinCount} live coins (${sample})`, 500);
  }
  const failedCoinIds = new Set(snapshot.failures.map((f) => f.coinId));

  const actions = [];
  for (const bot of roster) {
    await persistentEconomy.provisionPersistentAccount({ userId: bot.userId, queryable });
    const account = await persistentEconomy.getPersistentAccountState({ userId: bot.userId, queryable });
    const state = await buildPublicPersistentMarketState({ world, account, nowMs, queryable, snapshot });
    const random = createBotRandom({ seed: world.seed, botKey: bot.botKey, tickId });

    let decision;
    try {
      decision = decidePersistentBotAction({ strategy: bot.strategy, state, random });
    } catch (err) {
      actions.push({ botKey: bot.botKey, userId: bot.userId, action: 'SKIP', reason: `decision-error: ${err.message}` });
      continue;
    }

    // A coin left out of the snapshot (signal failure) must not make a
    // bot holding it look bankrupt: defer any loan to a tick where every
    // held coin has a public signal.
    if (decision.type === 'LOAN'
        && state.holdings.some((h) => h.quantity > 0 && failedCoinIds.has(h.coinId))) {
      actions.push({ botKey: bot.botKey, userId: bot.userId, action: 'SKIP', reason: 'loan-deferred: held coin signal unavailable this tick' });
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
  loadPersistentBotMarketSnapshot,
  runPersistentBotTick
};
