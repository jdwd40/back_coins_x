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
const { applySessionTimeouts, isDatabaseTimeoutError } = require('../db/timeouts');
const persistentWorld = require('./persistentWorld');
const persistentEconomy = require('./persistentEconomy');
const persistentDebt = require('./persistentDebt');
const persistentSignals = require('./persistentSignals');
const persistentMarketSignalsService = require('./persistentMarketSignalsService');
const defaultLogger = require('../utils/logger');
const checkpointModel = require('../models/pricingCheckpoint.model');
const coinStateModel = require('../models/marketCoinState.model');
const eventsModel = require('../models/persistentCoinEvents.model');
const heartbeatModel = require('../models/persistentBotHeartbeat.model');
const persistentCoinEventDomain = require('./persistentCoinEventDomain');
const marketDomain = require('./marketDomain');
const { resolveSimulationConfig } = require('./simulationConfig');
const {
  BOT_ROSTER,
  BOT_PERSONALITY_PROFILES,
  DEFAULT_BOT_MAX_TRADE_SIZE,
  resolvePersistentBotTickLimits
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
// Issue #56 (verified production root cause, 8 Oct): DUST positions.
// Full exits sized as floorQuantity(quantity * 1) could leave 1e-8 behind
// (float product just below the stored value), and repeated fractional
// sells shrank positions below the £0.01 minimum notional. Such a dust
// holding can never be sold (every sale under £0.01 is rejected), yet it
// counted as "held": the coin was excluded from entries forever, and a
// risk-exit on it was re-decided — and rejected — every tick, returning
// before any entry was considered. Over weeks every catalogue coin became
// dust-held for Carl, Mike and Ray, so they held 100% cash.
//
// Rules now:
//   * a position is MEANINGFUL only when its live sale value reaches the
//     minimum notional; dust neither blocks a new entry nor produces an
//     (unexecutable) exit decision;
//   * a fraction-1 exit sells the exact held quantity (never a floored
//     product), and a partial exit that would strand a dust remainder sells
//     the whole position instead.
// ---------------------------------------------------------------------------
function isMeaningfulPosition(quantity, price) {
  return quantity > 0 && price > 0 && round2(quantity * price) >= GAME_MIN_TRADE_VALUE;
}

function exitSellQuantity(holding, coin, fraction = 1) {
  const held = holding.quantity;
  if (!isMeaningfulPosition(held, coin.currentPrice)) return null;
  let quantity = fraction >= 1 ? held : floorQuantity(held * fraction);
  if (quantity < held && !isMeaningfulPosition(held - quantity, coin.currentPrice)) {
    quantity = held; // never strand an unsellable remainder
  }
  if (!isMeaningfulPosition(quantity, coin.currentPrice)) return null;
  return quantity;
}

// Issue #55: P&L thresholds use the PRECISE average entry. The ratio is
// recomputed from the money fields when available (costBasis / quantity),
// so a caller that supplies a display-rounded averageEntryPrice can never
// shift the profit-take/loss-cut triggers.
function preciseAverageEntry(holding) {
  if (typeof holding.costBasis === 'number' && Number.isFinite(holding.costBasis) && holding.costBasis > 0
      && holding.quantity > 0) {
    return holding.costBasis / holding.quantity;
  }
  return holding.averageEntryPrice;
}

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

// `snapshotClient` (issue #56): run the REPEATABLE READ READ ONLY snapshot
// transaction on a caller-owned client (the bot tick's bounded session)
// instead of acquiring a pooled one; the caller keeps ownership/release.
async function loadPersistentBotMarketSnapshot({ world, nowMs, queryable = db, snapshotClient = null, historyWindow = 20, config = resolveSimulationConfig(), logger = defaultLogger } = {}) {
  let rows;
  if (snapshotClient || queryable === db) {
    const client = snapshotClient || await db.getClient();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      rows = await readMarketSnapshotRows({ world, nowMs, queryable: client, historyWindow });
      await client.query('COMMIT');
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) { /* original error wins */ }
      throw err;
    } finally {
      if (!snapshotClient) client.release();
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
    // Dust (issue #56) is unsellable: it never yields an exit decision.
    if (!isMeaningfulPosition(holding.quantity, coin.currentPrice)) continue;
    const averageEntry = preciseAverageEntry(holding);
    const pnlFraction = averageEntry !== null && averageEntry > 0
      ? (coin.currentPrice - averageEntry) / averageEntry
      : (holding.unrealizedPnlPct !== null ? holding.unrealizedPnlPct / 100 : 0);

    // Panic: a crash-sized public drop on a held coin (SIM-12 behaviour).
    if (profile.panicSellThreshold !== undefined
        && coin.recentChangePct !== null
        && coin.recentChangePct / 100 <= profile.panicSellThreshold) {
      const quantity = exitSellQuantity(holding, coin, profile.panicSellFraction ?? 1);
      if (quantity !== null) {
        return { type: 'SELL', coinId: coin.coinId, quantity, reason: 'panic' };
      }
    }
    // Risk exit: the public collapse-risk reading turned unacceptable.
    if (profile.exitAtRisk !== undefined && RISK_RANK[coin.collapseRisk] >= RISK_RANK[profile.exitAtRisk]) {
      const quantity = exitSellQuantity(holding, coin, 1);
      if (quantity !== null) {
        return { type: 'SELL', coinId: coin.coinId, quantity, reason: 'risk-exit' };
      }
    }
    // Profit-taking above the public gain threshold.
    if (profile.profitTakeThreshold !== undefined && pnlFraction >= profile.profitTakeThreshold) {
      const quantity = exitSellQuantity(holding, coin, profile.profitSellFraction ?? 1);
      if (quantity !== null) {
        return { type: 'SELL', coinId: coin.coinId, quantity, reason: 'profit-take' };
      }
    }
    // Loss-cutting below the public decline threshold.
    if (profile.lossCutThreshold !== undefined && pnlFraction <= profile.lossCutThreshold) {
      const quantity = exitSellQuantity(holding, coin, profile.lossSellFraction ?? 1);
      if (quantity !== null) {
        return { type: 'SELL', coinId: coin.coinId, quantity, reason: 'loss-cut' };
      }
    }
    // Momentum personality: the trend stopped confirming.
    if (profile.exitOnDownMomentum && coin.momentum === 'DOWN') {
      const quantity = exitSellQuantity(holding, coin, profile.reversalSellFraction ?? 1);
      if (quantity !== null) {
        return { type: 'SELL', coinId: coin.coinId, quantity, reason: 'momentum-reversal' };
      }
    }
    if (profile.exitOnPhases && profile.exitOnPhases.includes(coin.phase)) {
      const quantity = exitSellQuantity(holding, coin, profile.reversalSellFraction ?? 1);
      if (quantity !== null) {
        return { type: 'SELL', coinId: coin.coinId, quantity, reason: 'phase-exit' };
      }
    }
  }

  // --- Entry rules ----------------------------------------------------------
  // A coin counts as held only through a MEANINGFUL live position (issue
  // #56): unsellable dust never locks a bot out of re-entering a coin. A
  // holding whose coin is missing from this tick's snapshot stays "held"
  // (conservative; it is not a candidate anyway).
  const heldIds = new Set(holdings.filter((h) => {
    if (!(h.quantity > 0)) return false;
    const coin = coinById.get(h.coinId);
    if (!coin || coin.dead) return true;
    return isMeaningfulPosition(h.quantity, coin.currentPrice);
  }).map((h) => h.coinId));
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
// Tick execution (issue #56 hardening).
//
// Single writer + bounded work:
//   * the tick runs on ONE dedicated pooled session that is DESTROYED at
//     the end (never returned to the pool), carrying session-level
//     statement_timeout / lock_timeout / idle_in_transaction limits so the
//     SERVER cancels any stuck tick statement — a JavaScript timeout race
//     would only stop waiting while the work (and its locks) carried on;
//   * that session takes a non-blocking session advisory lock
//     (pg_try_advisory_lock, never waited on, so it cannot deadlock): at
//     most one bot tick runs at a time across every Node/PM2 process; a
//     second process gets outcome BUSY and touches nothing;
//   * each bot trade/loan/repay runs in its own transaction with the same
//     limits applied by SET LOCAL;
//   * a cooperative deadline (resolvePersistentBotTickLimits) stops the
//     tick from starting new work after the budget, so a slow tick ends
//     before the next wakeup with outcome TIMEOUT.
//
// Claim vs success (the two are distinct facts):
//   * the public market snapshot is loaded BEFORE the claim; a systemic
//     all-coin signal failure aborts with outcome SIGNALS_FAILED and claims
//     NOTHING, so the next wakeup retries cleanly;
//   * persistent_bot_ticks remains the duplicate-tick claim authority (a
//     claimed tick is a no-op everywhere else) — a claim only means the
//     tick started;
//   * only a tick that processed every roster bot WITHOUT a decision,
//     programming or infrastructure failure records SUCCESS in the durable
//     heartbeat (models/persistentBotHeartbeat.model.js); expected domain
//     rejections are skips, but any other per-bot failure, a timeout or an
//     error records a failure outcome and leaves the last success aging;
//   * each committed bot action updates last_action_at as it commits, so a
//     later failure in the same tick cannot hide it.
//
// Each bot: provision (idempotent), read its account, build+assert the
// shaped public state, decide, execute through the shared persistent
// services, repay debt above the reserve after any cash inflow. A domain
// rejection (price moved mid-tick, a coin died, a loan no longer needed) is
// a non-fatal per-bot skip — never bypassed, never a direct mutation. A
// server-cancelled lock wait or statement, a driver error or a throwing
// decision is a per-bot FAILURE: the remaining bots still run, but the
// tick is not successful.
// ---------------------------------------------------------------------------

// Session advisory lock key for the persistent bot run lock. Deliberately
// distinct from the Apocalypse game transaction lock (727001) and the
// migration runner lock (727000): it is only ever TRY-acquired at session
// level by the bot tick, so it can never block or deadlock another path.
const PERSISTENT_BOT_RUN_LOCK_KEY = 727056;

const TICK_OUTCOMES = Object.freeze({
  SUCCESS: 'SUCCESS',
  SIGNALS_FAILED: 'SIGNALS_FAILED',
  TIMEOUT: 'TIMEOUT',
  ERROR: 'ERROR',
  BUSY: 'BUSY',
  ALREADY_CLAIMED: 'ALREADY_CLAIMED'
});

function tickFailure(message, outcome, status = 500) {
  const err = new PersistentBotError(message, status);
  err.outcome = outcome;
  return err;
}

function classifyTickError(err) {
  if (err && err.outcome && TICK_OUTCOMES[err.outcome]) return err.outcome;
  if (isDatabaseTimeoutError(err)) return TICK_OUTCOMES.TIMEOUT;
  return TICK_OUTCOMES.ERROR;
}

// Expected, authoritative domain rejections from the shared persistent
// services: their own error classes with a 4xx status. Everything else (a
// raw driver/PostgreSQL error, a server-cancelled statement or lock wait, a
// 5xx service fault, a programming error) is a bot FAILURE (review R1).
function isExpectedDomainRejection(err) {
  if (!(err instanceof persistentEconomy.PersistentEconomyError || err instanceof persistentDebt.PersistentDebtError)) {
    return false;
  }
  return Number.isInteger(err.status) && err.status >= 400 && err.status < 500;
}

function summarizeActions(actions) {
  const summary = { trades: 0, holds: 0, skips: 0, errors: 0, buys: 0, sells: 0, loans: 0, repays: 0 };
  for (const action of actions) {
    if (action.action === 'BUY') { summary.buys += 1; summary.trades += 1; }
    else if (action.action === 'SELL') { summary.sells += 1; summary.trades += 1; }
    else if (action.action === 'LOAN') { summary.loans += 1; summary.trades += 1; }
    else if (action.action === 'REPAY') { summary.repays += 1; summary.trades += 1; }
    else if (action.action === 'HOLD') summary.holds += 1;
    else if (action.action === 'SKIP') summary.skips += 1;
    else if (action.action === 'ERROR') summary.errors += 1;
  }
  return summary;
}

async function runPersistentBotTick({
  tickId,
  nowMs = Date.now(),
  logger = defaultLogger,
  limits = resolvePersistentBotTickLimits(),
  clock = () => Date.now()
} = {}) {
  if (!Number.isInteger(tickId) || tickId < 0) {
    throw new PersistentBotError(`persistent bot tickId must be a non-negative integer; received ${String(tickId)}`, 400);
  }
  const startedAtMs = clock();
  const deadlineAtMs = startedAtMs + limits.deadlineMs;
  const checkDeadline = (phase) => {
    if (clock() > deadlineAtMs) {
      throw tickFailure(
        `persistent bot tick ${tickId} exceeded its ${limits.deadlineMs}ms deadline before ${phase}`,
        TICK_OUTCOMES.TIMEOUT,
        503
      );
    }
  };
  const dbLimits = {
    statementTimeoutMs: limits.statementTimeoutMs,
    lockTimeoutMs: limits.lockTimeoutMs,
    idleInTransactionTimeoutMs: limits.idleInTransactionTimeoutMs
  };

  const client = await db.getClient();
  let world = null;
  let claimed = false;
  let locked = false;
  try {
    await applySessionTimeouts(client, dbLimits);
    const { rows: lockRows } = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [PERSISTENT_BOT_RUN_LOCK_KEY]);
    locked = lockRows[0].locked === true;
    if (!locked) {
      // Another process is mid-tick: never overlap, never wait.
      return { tickId, claimed: false, outcome: TICK_OUTCOMES.BUSY, actions: [] };
    }

    world = await persistentWorld.resolveActiveWorld(client);
    await heartbeatModel.recordAttempt(client, world.worldId);

    // Cheap pre-check (the INSERT below stays the authority): a tick
    // already claimed elsewhere is a no-op without a snapshot read.
    const { rows: existing } = await client.query(
      'SELECT 1 FROM persistent_bot_ticks WHERE world_id = $1 AND tick_id = $2',
      [world.worldId, tickId]
    );
    if (existing.length > 0) {
      return { tickId, claimed: false, outcome: TICK_OUTCOMES.ALREADY_CLAIMED, actions: [] };
    }

    // ONE public market snapshot for the whole tick (see
    // loadPersistentBotMarketSnapshot), read BEFORE the claim.
    checkDeadline('the market snapshot');
    const snapshot = await loadPersistentBotMarketSnapshot({ world, nowMs, snapshotClient: client, logger });
    const liveFailures = snapshot.failures.filter((f) => !f.dead);
    if (snapshot.liveCoinCount > 0 && liveFailures.length === snapshot.liveCoinCount) {
      // Systemic, not a single bad coin: fail loudly and claim nothing.
      const sample = liveFailures.slice(0, 3).map((f) => `coin ${f.coinId}: ${f.message}`).join('; ');
      logger.error(`[GAME] Persistent bot signals failed for ALL ${snapshot.liveCoinCount} live coins; aborting bot tick ${tickId} without claiming it`);
      throw tickFailure(
        `persistent bot signals failed for all ${snapshot.liveCoinCount} live coins (${sample})`,
        TICK_OUTCOMES.SIGNALS_FAILED
      );
    }
    const failedCoinIds = new Set(snapshot.failures.map((f) => f.coinId));

    // Claim the tick: the database is the duplicate-tick authority.
    checkDeadline('the claim');
    const { rows: claimRows } = await client.query(
      `INSERT INTO persistent_bot_ticks (world_id, tick_id)
       VALUES ($1, $2)
       ON CONFLICT (world_id, tick_id) DO NOTHING
       RETURNING tick_id`,
      [world.worldId, tickId]
    );
    if (claimRows.length === 0) {
      return { tickId, claimed: false, outcome: TICK_OUTCOMES.ALREADY_CLAIMED, actions: [] };
    }
    claimed = true;
    await heartbeatModel.recordClaim(client, world.worldId, tickId);

    // Roster identity provisioning is idempotent and shared with the legacy
    // worker (same users rows, same unauthenticatable credentials).
    const roster = await ensureBotsProvisioned({ queryable: client });

    const actions = [];
    const botFailures = [];
    const fail = (bot, phase, err) => {
      const kind = isDatabaseTimeoutError(err) ? TICK_OUTCOMES.TIMEOUT : TICK_OUTCOMES.ERROR;
      botFailures.push({ botKey: bot.botKey, phase, kind });
      actions.push({
        botKey: bot.botKey,
        userId: bot.userId,
        action: 'ERROR',
        reason: `${phase}-failed (${kind.toLowerCase()}): ${err && err.message ? err.message : String(err)}`
      });
    };
    // A committed bot action is recorded durably the moment it commits
    // (review R5): a later failure in this tick cannot hide it.
    const noteCommittedAction = () => heartbeatModel.recordAction(client, world.worldId);

    for (const bot of roster) {
      checkDeadline(`bot ${bot.botKey}`);
      await persistentEconomy.provisionPersistentAccount({ userId: bot.userId, queryable: client });
      const account = await persistentEconomy.getPersistentAccountState({ userId: bot.userId, queryable: client });
      const state = await buildPublicPersistentMarketState({ world, account, nowMs, queryable: client, snapshot });
      const random = createBotRandom({ seed: world.seed, botKey: bot.botKey, tickId });

      let decision;
      try {
        decision = decidePersistentBotAction({ strategy: bot.strategy, state, random });
      } catch (err) {
        // A decision that throws is a programming/data fault, never an
        // expected skip (review R1): the bot is recorded as failed.
        fail(bot, 'decision', err);
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

      if (decision.type === 'HOLD') {
        actions.push({ botKey: bot.botKey, userId: bot.userId, action: 'HOLD', reason: decision.reason });
        continue;
      }

      let committed = false;
      try {
        if (decision.type === 'BUY') {
          const result = await persistentEconomy.buyPersistentTrade({ userId: bot.userId, coinId: decision.coinId, quantity: decision.quantity, timeouts: dbLimits });
          committed = true;
          actions.push({ botKey: bot.botKey, userId: bot.userId, action: 'BUY', coinId: decision.coinId, quantity: decision.quantity, reason: decision.reason, totalAmount: result.transaction.totalAmount });
        } else if (decision.type === 'SELL') {
          const result = await persistentEconomy.sellPersistentTrade({ userId: bot.userId, coinId: decision.coinId, quantity: decision.quantity, timeouts: dbLimits });
          committed = true;
          actions.push({ botKey: bot.botKey, userId: bot.userId, action: 'SELL', coinId: decision.coinId, quantity: decision.quantity, reason: decision.reason, totalAmount: result.transaction.totalAmount });
        } else if (decision.type === 'LOAN') {
          const loan = await persistentDebt.issueBotLoan({ userId: bot.userId, timeouts: dbLimits });
          committed = true;
          actions.push({ botKey: bot.botKey, userId: bot.userId, action: 'LOAN', amount: loan.amount, debt: loan.debt, reason: decision.reason });
        } else {
          throw new PersistentBotError(`unknown persistent bot decision type ${String(decision.type)}`, 500);
        }
      } catch (err) {
        if (isExpectedDomainRejection(err)) {
          // An authoritative domain rejection (mid-tick price move, a coin
          // dying between read and write, a no-longer-bankrupt loan
          // request): the shared services rolled back cleanly and the bot
          // simply skips this tick.
          actions.push({
            botKey: bot.botKey,
            userId: bot.userId,
            action: 'SKIP',
            reason: `${decision.type.toLowerCase()}-rejected: ${err.message}`
          });
        } else {
          // Infrastructure (connection loss, server-cancelled statement or
          // lock wait) or programming fault: a FAILED bot, never a skip.
          fail(bot, decision.type.toLowerCase(), err);
        }
      }
      if (committed) await noteCommittedAction();

      if (committed && decision.type === 'SELL') {
        // Cash inflow: outstanding debt is repaid first, above the reserve.
        // Separate from the SELL so a repay fault never mislabels the
        // already-committed sale.
        try {
          const repayment = await persistentDebt.repayBotDebt({ userId: bot.userId, timeouts: dbLimits });
          if (repayment.repaid > 0) {
            actions.push({ botKey: bot.botKey, userId: bot.userId, action: 'REPAY', amount: repayment.repaid, debt: repayment.debt });
            await noteCommittedAction();
          }
        } catch (err) {
          if (isExpectedDomainRejection(err)) {
            actions.push({ botKey: bot.botKey, userId: bot.userId, action: 'SKIP', reason: `repay-rejected: ${err.message}` });
          } else {
            fail(bot, 'repay', err);
          }
        }
      }
    }

    const summary = summarizeActions(actions);
    if (botFailures.length > 0) {
      // Processing the roster loop is not success (review R1): any bot that
      // failed for a non-domain reason fails the tick. The claim stays (its
      // committed actions are real), the success fields are untouched and
      // the failure counter advances. TIMEOUT only when every bot failure
      // was a server-cancelled statement/lock wait.
      const outcome = botFailures.every((f) => f.kind === TICK_OUTCOMES.TIMEOUT)
        ? TICK_OUTCOMES.TIMEOUT
        : TICK_OUTCOMES.ERROR;
      const phases = [...new Set(botFailures.map((f) => `${f.phase}:${f.kind.toLowerCase()}`))].join(', ');
      const err = tickFailure(
        `persistent bot tick ${tickId}: ${botFailures.length} of ${roster.length} bots failed (${phases})`,
        outcome
      );
      err.actions = actions;
      err.summary = summary;
      throw err;
    }
    await heartbeatModel.recordSuccess(client, world.worldId, tickId, {
      trades: summary.trades,
      holds: summary.holds,
      skips: summary.skips
    });
    return {
      tickId,
      claimed: true,
      outcome: TICK_OUTCOMES.SUCCESS,
      actions,
      summary,
      durationMs: clock() - startedAtMs
    };
  } catch (err) {
    const outcome = classifyTickError(err);
    if (world) {
      try {
        await heartbeatModel.recordFailure(client, world.worldId, outcome);
      } catch (heartbeatErr) {
        logger.error(`[GAME] Persistent bot heartbeat failure record failed for tick ${tickId}: ${heartbeatErr.message}`);
      }
    }
    if (err && typeof err === 'object') {
      err.outcome = outcome;
      err.claimed = claimed;
      err.tickId = tickId;
    }
    throw err;
  } finally {
    // Release the run lock explicitly (so the very next tick can take it
    // without waiting for the backend to notice a closed socket), then
    // DESTROY the dedicated session: its session timeouts and any aborted
    // state can never leak back into the shared pool. If the unlock itself
    // fails the session is torn down anyway, which also frees the lock.
    if (locked) {
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [PERSISTENT_BOT_RUN_LOCK_KEY]);
      } catch (unlockErr) {
        logger.error(`[GAME] Persistent bot run-lock release failed for tick ${tickId}; destroying the session: ${unlockErr.message}`);
      }
    }
    client.release(true);
  }
}

module.exports = {
  PERSISTENT_BOT_STATE_KEYS,
  PERSISTENT_BOT_COIN_KEYS,
  PERSISTENT_BOT_HOLDING_KEYS,
  PersistentBotError,
  PERSISTENT_BOT_RUN_LOCK_KEY,
  TICK_OUTCOMES,
  isMeaningfulPosition,
  exitSellQuantity,
  isExpectedDomainRejection,
  summarizeActions,
  assertPublicPersistentBotState,
  buildPublicPersistentMarketState,
  decidePersistentBotAction,
  loadPersistentBotMarketSnapshot,
  runPersistentBotTick
};
