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
const { getEscalationBand, ESCALATION_BAND_IDS } = require('../game/apocalypseVolatility');
const powerDomain = require('../game/powerDomain');

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
// apocalypse progress and remaining time. When the round is played with a
// Power account the observation also carries the player's own current
// effective Power — exactly what the live public participant state exposes.
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

  const portfolioView = { cash: portfolio.cash, holdings };
  if (portfolio.powerAccount) {
    portfolioView.power = {
      current: powerDomain.reconcilePower({
        storedPower: portfolio.powerAccount.power,
        updatedAtMs: portfolio.powerAccount.updatedAtMs,
        nowMs: (portfolio.powerTimeOffsetMs || 0) + t,
        maxPower: portfolio.powerConfig.maxPower,
        regenMsPerPoint: portfolio.powerConfig.regenMsPerPoint
      }).power,
      max: portfolio.powerConfig.maxPower
    };
  }

  return {
    t,
    tickIndex,
    apocalypsePercent: env.apocalypsePercentAt(t),
    remainingMs: Math.max(0, env.durationMs - t),
    startingCash: context.startingCash,
    coins,
    portfolio: portfolioView,
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

// Quote a buy exactly the way the live domain would compute it: the 8dp
// quantity for the spend at the server price and the rounded 2dp
// consideration. Returns null when the trade cannot execute at all.
function quoteBuy(portfolio, spend, price) {
  if (!(price > 0) || !(spend >= MIN_TRADE_VALUE)) return null;
  const budget = Math.min(spend, portfolio.cash);
  const quantity = floorToDecimals(budget / price, QUANTITY_DECIMALS);
  if (!(quantity > 0)) return null;
  const total = round2(quantity * price);
  if (total < MIN_TRADE_VALUE || total > portfolio.cash) return null;
  return { quantity, total };
}

// Run one strategy through one precomputed round context. Deterministic
// given the environment seed (a strategy's own pseudo-randomness, when any,
// is keyed off the same seed).
//
// V2-2 options (all optional — omitting them reproduces V2-1 behaviour
// exactly):
//   powerAccount: { power, updatedAtMs } mutated IN PLACE across rounds, so
//     a multi-round study carries one persistent Power balance per player
//     (new players start at the game-design max, stamped at 0). Every buy is
//     charged the SHARED live domain cost (game/powerDomain.buyPowerCost)
//     reconciled lazily at the tick instant; a buy the account cannot cover
//     is skipped and counted. Sells never touch Power.
//   maxPositions: the live position limit (default Infinity = V2-1 parity).
//     Live positions are quantity > 0 and not collapsed, exactly the live
//     SQL rule; a buy opening a NEW position beyond the cap is skipped and
//     counted.
//   joinAtMs: late entrant — the strategy observes/acts only from this
//     round time onward. The participant exists from round start (live
//     auto-participation parity): economy debits and Power regeneration
//     apply for the whole round regardless.
//   powerConfig: explicit tunable overrides for tuning studies.
//   timeOffsetMs: global-clock offset for the Power timestamps. Multi-round
//     studies run one continuous real clock across consecutive rounds
//     (round r occupies [r*duration, (r+1)*duration) on the study clock), so
//     lazy regeneration keeps working across rollover — exactly like the
//     live game, where wall-clock time simply continues.
//   debits: V2-3 economy A/B — an explicit passive-debit schedule replacing
//     env.debits for this run. The market path, collapse schedule, signals
//     and every other input still come from the shared context, so paired
//     economy variants experience identical prices and collapses; ONLY the
//     deduction stream differs (exactly what an economy configuration
//     changes live). Omitting it reproduces env.debits behaviour.
//   recordTrades: SIM-18 multi-cycle harness — when true, every EXECUTED
//     trade is appended to the returned executedTape as
//     { coinId, type: 'BUY'|'SELL', notional, atMs } entries (the executed
//     2dp consideration/proceeds at the tick instant), ready to feed back
//     into a follow-up environment's static trade tape. Default false;
//     omitting it reproduces prior behaviour exactly (empty tape).
function runRound(context, strategy, {
  startingCash = GAME_STARTING_CASH,
  powerAccount = null,
  maxPositions = Infinity,
  joinAtMs = 0,
  powerConfig: powerConfigOverrides = null,
  timeOffsetMs = 0,
  debits = null,
  recordTrades = false
} = {}) {
  const { env, ticks, gridByCoin, signalGrid } = context;
  const debitSchedule = debits || env.debits;
  context.startingCash = startingCash;
  const portfolio = createPortfolio(startingCash);
  const powerConfig = powerDomain.resolvePowerConfig(powerConfigOverrides || {});
  if (powerAccount) {
    portfolio.powerAccount = powerAccount;
    portfolio.powerConfig = powerConfig;
    portfolio.powerTimeOffsetMs = timeOffsetMs;
  }
  const ctx = {
    rng: strategy.usesOwnRandom ? createSeededRandom(`${env.seed}:v2-sim-strategy:${strategy.id}`) : null,
    perfect: strategy.usesFuture ? getPerfectView(context) : null
  };

  const equityCurve = [];
  let trades = 0;
  let investedTicks = 0;
  let debitIndex = 0;

  // V2-2 instrumentation.
  let powerSum = 0;
  let powerSamples = 0;
  let starvedTicks = 0;
  let attemptedBuys = 0;
  let executedBuys = 0;
  let blockedByPower = 0;
  let blockedByPosition = 0;
  let powerSpent = 0;
  let cashDeployed = 0;   // sum of executed buy totals
  let cashRecovered = 0;  // sum of executed sell proceeds
  let debitsPaid = 0;     // sum of actually-applied economy debits
  let basisRemoved = 0;   // cost basis removed by sells
  let positionLimitViolations = 0;

  // V2-3 instrumentation: per-escalation-band trade counts and the value
  // destroyed by collapses while a coin was held (marked at the first tick
  // the coin is observed dead, valued at the last live tick price — the
  // exact wealth the player lost by overstaying the collapse).
  const bandTrades = {};
  for (const bandId of ESCALATION_BAND_IDS) bandTrades[bandId] = 0;
  const collapseLosses = [];
  const collapsedSeen = new Set();

  // V2-4 instrumentation: entry phase/risk distribution from the PUBLIC
  // signal grid (the exact fields a legal client saw at the entry tick),
  // buy/sell split, the largest open live position count reached, and the
  // zero-Power sell guarantee (every sell attempted at < 1 effective Power
  // must still execute — selling never costs Power).
  let executedSells = 0;
  const buyPhaseCounts = {};
  const buyRiskCounts = {};
  let maxOpenPositionsSeen = 0;
  let zeroPowerSellAttempts = 0;
  let zeroPowerSellExecuted = 0;

  // SIM-18: executed-trade tape for the multi-cycle harness (empty unless
  // recordTrades is on).
  const executedTape = [];

  const liveCoinIdsAt = (t) => {
    const ids = [];
    for (const [coinId, holding] of portfolio.holdings) {
      if (holding.quantity > 0 && !env.isDead(coinId, t)) ids.push(coinId);
    }
    return ids;
  };

  const reconcileAccountAt = (t) => powerDomain.reconcilePower({
    storedPower: powerAccount ? powerAccount.power : 0,
    updatedAtMs: powerAccount ? powerAccount.updatedAtMs : 0,
    nowMs: timeOffsetMs + t,
    maxPower: powerConfig.maxPower,
    regenMsPerPoint: powerConfig.regenMsPerPoint
  }).power;

  // Effective Power at the START of the round, from the INCOMING account
  // pair (before this round's first action).
  const powerStart = powerAccount ? reconcileAccountAt(0) : null;

  for (let i = 0; i < ticks.length; i++) {
    const t = ticks[i];

    // Passive economy: every debit due since the last tick, in schedule
    // order, clamped at available cash (exactly like applyRoundDebit).
    while (debitIndex < debitSchedule.length && debitSchedule[debitIndex].atMs <= t) {
      const debit = debitSchedule[debitIndex];
      const applied = Math.min(debit.amount, portfolio.cash);
      portfolio.cash = round2(Math.max(0, portfolio.cash - applied));
      debitsPaid = round2(debitsPaid + applied);
      debitIndex += 1;
    }

    // Power telemetry for this tick (and the starvation measure: unable to
    // afford even the cheapest possible buy).
    if (powerAccount) {
      const effective = reconcileAccountAt(t);
      powerSum += effective;
      powerSamples += 1;
      if (effective < 1) starvedTicks += 1;
    }

    if (t >= joinAtMs) {
      const observation = buildObservation(env, portfolio, t, i, context, trades);
      const actions = strategy.decide(observation, ctx) || [];

      let buysThisTick = 0;
      for (const action of actions) {
        const price = gridByCoin.get(action.coinId)[i];
        if (action.action === 'buy') {
          if (buysThisTick >= 2) continue; // a real client cannot fire unlimited simultaneous orders
          buysThisTick += 1;
          attemptedBuys += 1;

          const quote = quoteBuy(portfolio, action.spend, price);
          if (!quote) continue;

          // Position limit: the live SQL rule via the shared predicate.
          if (maxPositions !== Infinity) {
            const verdict = powerDomain.evaluatePositionLimit({
              liveCoinIds: liveCoinIdsAt(t),
              coinId: action.coinId,
              maxOpenPositions: maxPositions
            });
            if (!verdict.allowed) {
              blockedByPosition += 1;
              continue;
            }
          }

          // Power: the SHARED live cost + lazy reconciliation, charged only
          // when the buy actually executes.
          if (powerAccount) {
            const cost = powerDomain.buyPowerCost(quote.total, { buyCostDivisor: powerConfig.buyCostDivisor });
            const spendResult = powerDomain.spendPower({
              storedPower: powerAccount.power,
              updatedAtMs: powerAccount.updatedAtMs,
              nowMs: timeOffsetMs + t,
              cost,
              maxPower: powerConfig.maxPower,
              regenMsPerPoint: powerConfig.regenMsPerPoint
            });
            if (!spendResult) {
              blockedByPower += 1;
              continue;
            }
            powerAccount.power = spendResult.power;
            powerAccount.updatedAtMs = spendResult.updatedAtMs;
            powerSpent += cost;
          }

          const cashBefore = portfolio.cash;
          if (executeBuy(portfolio, action.coinId, action.spend, price)) {
            trades += 1;
            executedBuys += 1;
            bandTrades[getEscalationBand(env.apocalypsePercentAt(t))] += 1;
            cashDeployed = round2(cashDeployed + (cashBefore - portfolio.cash));
            if (recordTrades) {
              executedTape.push({ coinId: action.coinId, type: 'BUY', notional: round2(cashBefore - portfolio.cash), atMs: t });
            }
            // V2-4: the entry's PUBLIC phase/risk at this tick.
            const entrySignal = signalGrid[i].find((c) => c.coinId === action.coinId);
            if (entrySignal) {
              buyPhaseCounts[entrySignal.phase] = (buyPhaseCounts[entrySignal.phase] || 0) + 1;
              buyRiskCounts[entrySignal.collapseRisk] = (buyRiskCounts[entrySignal.collapseRisk] || 0) + 1;
            }
          }
        } else if (action.action === 'sell') {
          const holding = portfolio.holdings.get(action.coinId);
          const basisBefore = holding ? holding.costBasis : 0;
          const cashBefore = portfolio.cash;
          // V2-4: selling is always available at zero Power — count every
          // sell attempted while the account is effectively empty and
          // verify it still executed.
          const zeroPowerSell = powerAccount && reconcileAccountAt(t) < 1;
          if (zeroPowerSell) zeroPowerSellAttempts += 1;
          if (executeSell(portfolio, action.coinId, action.fraction, price)) {
            trades += 1;
            executedSells += 1;
            if (zeroPowerSell) zeroPowerSellExecuted += 1;
            bandTrades[getEscalationBand(env.apocalypsePercentAt(t))] += 1;
            const after = portfolio.holdings.get(action.coinId);
            basisRemoved = round2(basisRemoved + (basisBefore - (after ? after.costBasis : 0)));
            cashRecovered = round2(cashRecovered + (portfolio.cash - cashBefore));
            if (recordTrades) {
              executedTape.push({ coinId: action.coinId, type: 'SELL', notional: round2(portfolio.cash - cashBefore), atMs: t });
            }
          }
        }
      }
    }

    // V2-3: a held coin observed dead for the first time destroys its last
    // live value — the concrete cost of overstaying a collapse.
    for (const [coinId, holding] of portfolio.holdings) {
      if (holding.quantity > 0 && env.isDead(coinId, t) && !collapsedSeen.has(coinId)) {
        collapsedSeen.add(coinId);
        const lastLivePrice = i > 0 ? gridByCoin.get(coinId)[i - 1] : 0;
        collapseLosses.push({
          t,
          apocalypsePercent: round2(env.apocalypsePercentAt(t)),
          coinId,
          valueLost: round2(holding.quantity * lastLivePrice)
        });
      }
    }

    // Invariant: the position cap can never be exceeded.
    if (maxPositions !== Infinity && liveCoinIdsAt(t).length > maxPositions) {
      positionLimitViolations += 1;
    }
    // V2-4: the largest open live position count reached this round.
    maxOpenPositionsSeen = Math.max(maxOpenPositionsSeen, liveCoinIdsAt(t).length);

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

  // Accounting invariants (cost-basis/P&L correctness through the round):
  //   cash identity: finalCash == startingCash - deployed + recovered - debits
  //   basis identity: deployed == Σ remaining basis + Σ basis removed
  // Both books are kept in exact 2dp arithmetic; drift beyond a penny per
  // book is a genuine accounting defect.
  const cashDrift = Math.abs(round2(finalCash - round2(startingCash - cashDeployed + cashRecovered - debitsPaid)));
  let remainingBasis = 0;
  for (const [, holding] of portfolio.holdings) remainingBasis = round2(remainingBasis + holding.costBasis);
  const basisDrift = Math.abs(round2(cashDeployed - round2(remainingBasis + basisRemoved)));

  // Max drawdown over the equity curve (fraction of running peak).
  let peak = -Infinity;
  let maxDrawdown = 0;
  for (const equity of equityCurve) {
    peak = Math.max(peak, equity);
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
  }

  const powerAt = (t) => reconcileAccountAt(t);

  return {
    strategyId: strategy.id,
    finalCash,
    roi: round2(((finalCash - startingCash) / startingCash) * 10000) / 100,
    profitable: finalCash > startingCash,
    trades,
    timeInMarket: ticks.length > 0 ? Math.round((investedTicks / ticks.length) * 10000) / 10000 : 0,
    maxDrawdown: Math.round(maxDrawdown * 10000) / 10000,
    equityCurve,
    // V2-2 power study fields (null when the round ran without Power).
    powerStart,
    powerEnd: powerAccount ? powerAt(env.durationMs) : null,
    meanTickPower: powerAccount && powerSamples > 0 ? Math.round((powerSum / powerSamples) * 100) / 100 : null,
    starvedTickPct: powerAccount && powerSamples > 0 ? Math.round((starvedTicks / powerSamples) * 10000) / 100 : null,
    attemptedBuys,
    executedBuys,
    blockedByPower,
    blockedByPosition,
    powerSpent: powerAccount ? powerSpent : null,
    cashDeployed,
    cashDrift,
    basisDrift,
    positionLimitViolations,
    // V2-3 fields.
    bandTrades,
    collapseLosses,
    debitsPaid,
    // V2-4 fields.
    executedSells,
    buyPhaseCounts,
    buyRiskCounts,
    maxOpenPositionsSeen,
    zeroPowerSellAttempts,
    zeroPowerSellExecuted,
    // SIM-18: executed-trade tape (empty unless recordTrades was enabled).
    executedTape
  };
}

module.exports = {
  DEFAULT_OBSERVATION_MS,
  createPortfolio,
  executeBuy,
  executeSell,
  quoteBuy,
  buildObservation,
  createRoundContext,
  runRound
};
