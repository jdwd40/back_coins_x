// V2-1 headless simulation engine.
//
// Runs complete 30-minute apocalypse rounds against a deterministic round
// environment with an injected clock. Trade mechanics mirror the live
// gameRoundService contract: server-side price at execution, quantity at
// 8dp, consideration rounded to 2dp money, minimum £0.01 notional, dead
// coins unbuyable and worth exactly £0, settlement scores CASH ONLY (every
// coin has collapsed by round end, exactly like the live Core 3/6
// lifecycle). Passive FEE/TAX/EVENT debits follow the live deterministic
// schedules and clamp at available cash.
//
// Observation cadence: strategies observe and act once per observation tick
// (default 15 simulated seconds — a realistic mobile client cadence), never
// with millisecond omniscience. Paired strategies on the same environment
// receive identical ticks, prices and debits.

const { createSeededRandom } = require('../game/seededRandom');
const { GAME_STARTING_CASH } = require('../game/gameConstants');

const DEFAULT_OBSERVATION_MS = 15 * 1000;
const QUANTITY_DECIMALS = 8;
const MIN_TRADE_VALUE = 0.01;

function round2(value) {
  return Math.round(value * 100) / 100;
}

function floorToDecimals(value, decimals) {
  const factor = Math.pow(10, decimals);
  return Math.floor(value * factor) / factor;
}

function createPortfolio(startingCash) {
  return { cash: round2(startingCash), holdings: new Map() };
}

// BUY exactly like the live domain: server-side price, 8dp quantity, 2dp
// consideration, min-notional and affordability enforced. Returns true when
// the trade executed.
function executeBuy(portfolio, coinId, spend, price) {
  if (!(price > 0) || !(spend >= MIN_TRADE_VALUE)) return false;
  const budget = Math.min(spend, portfolio.cash);
  const quantity = floorToDecimals(budget / price, QUANTITY_DECIMALS);
  if (!(quantity > 0)) return false;
  const total = round2(quantity * price);
  if (total < MIN_TRADE_VALUE || total > portfolio.cash) return false;

  portfolio.cash = round2(portfolio.cash - total);
  const existing = portfolio.holdings.get(coinId) || { quantity: 0, costBasis: 0 };
  existing.quantity += quantity;
  existing.costBasis = round2(existing.costBasis + total);
  portfolio.holdings.set(coinId, existing);
  return true;
}

// SELL exactly like the live domain: oversell rejected, dead coin credits
// exactly £0.
function executeSell(portfolio, coinId, fraction, price) {
  const holding = portfolio.holdings.get(coinId);
  if (!holding || !(holding.quantity > 0)) return false;
  const clampedFraction = Math.min(1, Math.max(0, fraction));
  if (!(clampedFraction > 0)) return false;
  const quantity = floorToDecimals(holding.quantity * clampedFraction, QUANTITY_DECIMALS);
  if (!(quantity > 0)) return false;

  const proceeds = round2(quantity * price);
  portfolio.cash = round2(portfolio.cash + proceeds);
  holding.quantity -= quantity;
  holding.costBasis = round2(holding.costBasis * (holding.quantity / (holding.quantity + quantity)));
  if (holding.quantity <= 1e-8) {
    portfolio.holdings.delete(coinId);
  }
  return true;
}

// Build the strategy-facing observation for one tick from the precomputed
// per-round signal grid. Contains ONLY legal public information: per-coin
// public signals + dead state, the player's own cash/holdings economics,
// apocalypse progress and remaining time.
function buildObservation(env, portfolio, t, tickIndex, context, trades) {
  const coins = context.signalGrid[tickIndex];
  const signalByCoin = new Map(coins.map((c) => [c.coinId, c]));

  const holdings = [];
  for (const [coinId, holding] of portfolio.holdings) {
    const signal = signalByCoin.get(coinId);
    const currentPrice = signal.dead ? 0 : signal.currentPrice;
    const currentValue = round2(holding.quantity * currentPrice);
    const avgEntry = holding.quantity > 0 ? holding.costBasis / (holding.quantity + 1e-12) : 0;
    holdings.push({
      coinId,
      quantity: holding.quantity,
      avgEntry: round2(avgEntry * 10000) / 10000,
      costBasis: holding.costBasis,
      currentPrice,
      currentValue,
      unrealizedPct: holding.costBasis > 0
        ? Math.round(((currentValue - holding.costBasis) / holding.costBasis) * 10000) / 100
        : 0,
      dead: signal.dead
    });
  }

  return {
    t,
    tickIndex,
    apocalypsePercent: env.apocalypsePercentAt(t),
    remainingMs: Math.max(0, env.durationMs - t),
    startingCash: context.startingCash,
    coins,
    portfolio: { cash: portfolio.cash, holdings },
    trades
  };
}

// Simulation-only future view for PERFECT_INFORMATION: suffix maximum over
// the precomputed price grid (dead coins have no future).
function buildPerfectView(env, gridByCoin, ticks) {
  const suffixMax = new Map();
  for (const coin of env.coins) {
    const prices = gridByCoin.get(coin.coinId);
    const suffix = new Array(prices.length);
    let best = -1;
    let bestIndex = -1;
    for (let i = prices.length - 1; i >= 0; i--) {
      if (prices[i] > best) {
        best = prices[i];
        bestIndex = i;
      }
      suffix[i] = { price: best, tickIndex: bestIndex };
    }
    suffixMax.set(coin.coinId, suffix);
  }
  return {
    bestFuture(coinId, nowMs) {
      const tickIndex = Math.min(ticks.length - 1, Math.round(nowMs / (ticks[1] - ticks[0])));
      const suffix = suffixMax.get(coinId);
      const entry = suffix && suffix[tickIndex + 1]; // strictly future ticks
      if (!entry || !(entry.price > 0)) return null;
      return { price: entry.price, atMs: ticks[entry.tickIndex] };
    }
  };
}

// Build the shared deterministic context of one round ONCE: tick schedule,
// the whole round's persisted-precision prices, the whole round's public
// signals (identical for every strategy — signals never depend on a
// portfolio), and the simulation-only future view. Paired strategies share
// a single context, which is what makes large paired batches fast.
function createRoundContext(env, { observationMs = DEFAULT_OBSERVATION_MS } = {}) {
  const ticks = [];
  for (let t = 0; t <= env.durationMs; t += observationMs) ticks.push(t);

  const gridByCoin = new Map();
  const signalGrid = [];
  for (const coin of env.coins) {
    gridByCoin.set(coin.coinId, ticks.map((t) => env.priceAt(coin.coinId, t)));
  }
  for (let i = 0; i < ticks.length; i++) {
    signalGrid.push(env.coins.map((coin) => env.publicSignal(coin.coinId, ticks[i])));
  }

  return { env, ticks, gridByCoin, signalGrid, perfectView: null };
}

function getPerfectView(context) {
  if (!context.perfectView) {
    context.perfectView = buildPerfectView(context.env, context.gridByCoin, context.ticks);
  }
  return context.perfectView;
}

// Run one strategy through one precomputed round context. Deterministic
// given the environment seed (a strategy's own pseudo-randomness, when any,
// is keyed off the same seed).
function runRound(context, strategy, { startingCash = GAME_STARTING_CASH } = {}) {
  const { env, ticks, gridByCoin } = context;
  context.startingCash = startingCash;
  const portfolio = createPortfolio(startingCash);
  const ctx = {
    rng: strategy.usesOwnRandom ? createSeededRandom(`${env.seed}:v2-sim-strategy:${strategy.id}`) : null,
    perfect: strategy.usesFuture ? getPerfectView(context) : null
  };

  const equityCurve = [];
  let trades = 0;
  let investedTicks = 0;
  let debitIndex = 0;

  for (let i = 0; i < ticks.length; i++) {
    const t = ticks[i];

    // Passive economy: every debit due since the last tick, in schedule
    // order, clamped at available cash (exactly like applyRoundDebit).
    while (debitIndex < env.debits.length && env.debits[debitIndex].atMs <= t) {
      const debit = env.debits[debitIndex];
      portfolio.cash = round2(Math.max(0, portfolio.cash - Math.min(debit.amount, portfolio.cash)));
      debitIndex += 1;
    }

    const observation = buildObservation(env, portfolio, t, i, context, trades);
    const actions = strategy.decide(observation, ctx) || [];

    let buysThisTick = 0;
    for (const action of actions) {
      const price = gridByCoin.get(action.coinId)[i];
      if (action.action === 'buy') {
        if (buysThisTick >= 2) continue; // a real client cannot fire unlimited simultaneous orders
        if (executeBuy(portfolio, action.coinId, action.spend, price)) {
          trades += 1;
          buysThisTick += 1;
        }
      } else if (action.action === 'sell') {
        if (executeSell(portfolio, action.coinId, action.fraction, price)) {
          trades += 1;
        }
      }
    }

    // Equity for drawdown/time-in-market: cash + live holdings value.
    let holdingsValue = 0;
    for (const [coinId, holding] of portfolio.holdings) {
      holdingsValue += holding.quantity * gridByCoin.get(coinId)[i];
    }
    const equity = round2(portfolio.cash + holdingsValue);
    equityCurve.push(equity);
    if (holdingsValue > 0) investedTicks += 1;
  }

  // Settlement parity: by round end every coin has collapsed, so final
  // wealth is cash only — any position still open is worth exactly £0.
  const finalCash = round2(portfolio.cash);

  // Max drawdown over the equity curve (fraction of running peak).
  let peak = -Infinity;
  let maxDrawdown = 0;
  for (const equity of equityCurve) {
    peak = Math.max(peak, equity);
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
  }

  return {
    strategyId: strategy.id,
    finalCash,
    roi: round2(((finalCash - startingCash) / startingCash) * 10000) / 100,
    profitable: finalCash > startingCash,
    trades,
    timeInMarket: ticks.length > 0 ? Math.round((investedTicks / ticks.length) * 10000) / 10000 : 0,
    maxDrawdown: Math.round(maxDrawdown * 10000) / 10000,
    equityCurve
  };
}

module.exports = {
  DEFAULT_OBSERVATION_MS,
  createPortfolio,
  executeBuy,
  executeSell,
  buildObservation,
  createRoundContext,
  runRound
};
