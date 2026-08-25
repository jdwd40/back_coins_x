// V2-4 deterministic headless bot study.
//
// Runs the FOUR canonical Core 5 bot personalities (Conservative, Momentum,
// Dip Buyer, Reckless) through repeated seeded apocalypse rounds under the
// exact V2 rules — persistent Power, the 3-position limit, cost-basis
// accounting and the selected V2 economy — paired against the DIP_BOOM
// human-like benchmark on IDENTICAL seeded market paths.
//
// Architecture (the task's recommended implementation): the simulator's
// legal public observation is translated by a thin adapter into the EXACT
// bot-shaped public state contract (game/botService.js allowlists), then
// the REAL bot decision layer (botService.decideBotAction) decides, and the
// resulting trade executes through the SAME simulation trade
// mechanics/Power/position/cost-basis domain every other study uses
// (simulation/engine.js). The adapter adds NO hidden fields: it carries
// only per-coin public signals, publicly observed price history (a legal
// client watching the market), the bot's own cash/holdings economics, its
// own effective Power and its own open-position count. Every adapted state
// is verified against botService.assertPublicBotState BEFORE the decision —
// the same redaction contract the live tick enforces — so a hidden field
// (seed, schedule row, collapse rank/timestamp, future phase/peak) would
// throw and fail the study loudly.
//
// The bot's deterministic random stream is keyed by the round seed + stable
// bot identity + observation tick — exactly the live createBotRandom
// convention. The seed is used ONLY inside that keyed stream (as the live
// tick does); it never appears in the shaped decision state.
//
// Determinism: no Math.random, no real clock, no database. Same base seed
// reproduces the entire study bit-for-bit.

const crypto = require('crypto');
const { createRoundEnvironment, DEFAULT_ROUND_DURATION_MS } = require('./roundEnvironment');
const { createRoundContext, runRound, DEFAULT_OBSERVATION_MS } = require('./engine');
const { STRATEGIES } = require('./strategies');
const { deriveRoundSeed } = require('./batch');
const { mean, median, summarizeStrategy, pairedWinRate, pairedAdvantage } = require('./metrics');
const { V2_ECONOMY_SCALE } = require('./escalationStudy');
const powerDomain = require('../game/powerDomain');
const botService = require('../game/botService');
const {
  DEFAULT_BOT_MAX_TRADE_SIZE,
  DEFAULT_BOT_MAX_COIN_EXPOSURE_FRACTION
} = require('../game/botConfig');
const { GAME_STARTING_CASH } = require('../game/gameConstants');

const BOT_STUDY_BASE_SEED = 'v2-4-bot-study-base-seed';

// The study roster: the four canonical bots plus the skilled human-like
// DIP_BOOM benchmark (the strategy a competent human dip buyer is expected
// to resemble). Every player trades every round of every sequence with ONE
// persistent Power account on the continuous study clock.
const BOT_PLAYER_DEFS = [
  { id: 'BOT_CONSERVATIVE', botStrategy: 'conservative', botKey: 'conservative-carl' },
  { id: 'BOT_MOMENTUM', botStrategy: 'momentum', botKey: 'momentum-mike' },
  { id: 'BOT_DIP_BUYER', botStrategy: 'dip_buyer', botKey: 'dip-buyer-dana' },
  { id: 'BOT_RECKLESS', botStrategy: 'reckless', botKey: 'reckless-ray' },
  { id: 'DIP_BOOM', strategyId: 'DIP_BOOM' }
];
const ALL_PLAYER_IDS = BOT_PLAYER_DEFS.map((p) => p.id);
const BOT_PLAYER_IDS = BOT_PLAYER_DEFS.filter((p) => p.botStrategy).map((p) => p.id);

function deriveSequenceSeed(baseSeed, sequenceIndex) {
  return crypto.createHash('sha256').update(`${baseSeed}:sequence:${sequenceIndex}`).digest('hex');
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

// The public observation adapter: translate the simulator's legal public
// observation into the exact bot-shaped public state, maintaining the
// rolling publicly-observed price window (a real client watching ticks).
// Adds NOTHING the live builder would not shape. `tracker` counts verified
// decision inputs for the hidden-information gate evidence.
function makeBotStrategy(def, env, powerConfig, tracker) {
  const symbolByCoin = new Map(env.coins.map((c) => [c.coinId, c.symbol]));
  return {
    id: def.id,
    usesFuture: false,
    usesOwnRandom: false,
    decide(observation, ctx) {
      if (!ctx.botHistory) ctx.botHistory = new Map();
      for (const coin of observation.coins) {
        const history = ctx.botHistory.get(coin.coinId) || [];
        history.push(coin.currentPrice);
        if (history.length > botService.BOT_HISTORY_WINDOW) history.shift();
        ctx.botHistory.set(coin.coinId, history);
      }

      const holdings = observation.portfolio.holdings.map((h) => ({
        coinId: h.coinId,
        symbol: symbolByCoin.get(h.coinId),
        quantity: h.quantity,
        costBasis: h.costBasis,
        averageEntryPrice: h.avgEntry,
        currentValue: h.currentValue,
        unrealizedPnlPct: h.unrealizedPct
      }));
      const deadIds = new Set(observation.coins.filter((c) => c.dead).map((c) => c.coinId));
      const openLive = holdings.filter((h) => h.quantity > 0 && !deadIds.has(h.coinId)).length;

      const marketState = {
        coins: observation.coins.map((signal) => ({
          coinId: signal.coinId,
          symbol: symbolByCoin.get(signal.coinId),
          currentPrice: signal.currentPrice,
          collapsed: signal.dead,
          history: (ctx.botHistory.get(signal.coinId) || []).slice(),
          phase: signal.phase,
          momentum: signal.momentum,
          archetype: signal.archetype,
          collapseRisk: signal.collapseRisk,
          recentChangePct: signal.recentChangePct
        })),
        cash: observation.portfolio.cash,
        holdings,
        apocalypsePercent: observation.apocalypsePercent,
        power: {
          current: observation.portfolio.power ? observation.portfolio.power.current : powerConfig.maxPower,
          max: powerConfig.maxPower,
          regenMsPerPoint: powerConfig.regenMsPerPoint
        },
        openPositions: {
          open: openLive,
          max: powerConfig.maxOpenPositions
        }
      };

      // The redaction contract, verified on EVERY simulated decision input.
      botService.assertPublicBotState(marketState);
      tracker.decisionInputsChecked += 1;

      const random = botService.createBotRandom({
        seed: env.seed,
        botKey: def.botKey,
        tickId: observation.tickIndex
      });
      const decision = botService.decideBotAction({
        strategy: def.botStrategy,
        marketState,
        random,
        maxTradeSize: DEFAULT_BOT_MAX_TRADE_SIZE,
        maxCoinExposureFraction: DEFAULT_BOT_MAX_COIN_EXPOSURE_FRACTION
      });
      if (!decision || decision.type === 'HOLD') {
        if (decision && decision.reason) tracker.holdReasons[decision.reason] = (tracker.holdReasons[decision.reason] || 0) + 1;
        return [];
      }
      if (decision.type === 'BUY') {
        const signal = observation.coins.find((c) => c.coinId === decision.coinId);
        const spend = round2(decision.quantity * signal.currentPrice);
        return spend >= 0.01 ? [{ action: 'buy', coinId: decision.coinId, spend }] : [];
      }
      // SELL: the bounded quantity becomes a fraction of the actual holding.
      const holding = observation.portfolio.holdings.find((h) => h.coinId === decision.coinId);
      if (!holding || !(holding.quantity > 0)) return [];
      const fraction = Math.min(1, decision.quantity / holding.quantity);
      return [{ action: 'sell', coinId: decision.coinId, fraction }];
    }
  };
}

function runBotStudy({
  sequences = 24,
  roundsPerSequence = 16,
  baseSeed = BOT_STUDY_BASE_SEED,
  observationMs = DEFAULT_OBSERVATION_MS,
  economy = true,
  economyScale = V2_ECONOMY_SCALE,
  startingCash = GAME_STARTING_CASH,
  playerIds = ALL_PLAYER_IDS,
  powerConfig: powerConfigOverrides = null,
  onProgress = null
} = {}) {
  if (!Number.isInteger(sequences) || sequences <= 0) throw new Error(`sequences must be a positive integer; received ${sequences}`);
  if (!Number.isInteger(roundsPerSequence) || roundsPerSequence <= 0) throw new Error(`roundsPerSequence must be a positive integer; received ${roundsPerSequence}`);

  const powerConfig = powerDomain.resolvePowerConfig(powerConfigOverrides || {});
  const players = playerIds.map((id) => {
    const def = BOT_PLAYER_DEFS.find((p) => p.id === id);
    if (!def) throw new Error(`unknown bot-study player ${String(id)}`);
    return { ...def, strategy: def.strategyId ? STRATEGIES[def.strategyId] : null };
  });

  const records = new Map(players.map((p) => [p.id, []]));
  const tracker = { decisionInputsChecked: 0, holdReasons: {} };
  const totalSteps = sequences * roundsPerSequence;
  let stepsDone = 0;

  for (let s = 0; s < sequences; s++) {
    const sequenceSeed = deriveSequenceSeed(baseSeed, s);
    // One persistent Power account per player for the whole sequence.
    const accounts = new Map(players.map((p) => [p.id, { power: powerConfig.maxPower, updatedAtMs: 0 }]));

    for (let r = 0; r < roundsPerSequence; r++) {
      const roundSeed = deriveRoundSeed(sequenceSeed, r);
      const env = createRoundEnvironment({ seed: roundSeed, economy, economyScale });
      const context = createRoundContext(env, { observationMs });
      const timeOffsetMs = r * env.durationMs;

      for (const player of players) {
        const account = accounts.get(player.id);
        // Bots get a FRESH per-round adapter bound to this round's seed —
        // the live parity of createBotRandom(seed, botKey, tickId). The
        // benchmark reuses the shared DIP_BOOM strategy object.
        const strategy = player.botStrategy
          ? makeBotStrategy(player, env, powerConfig, tracker)
          : player.strategy;
        const result = runRound(context, strategy, {
          startingCash,
          powerAccount: account,
          maxPositions: powerConfig.maxOpenPositions,
          powerConfig,
          timeOffsetMs
        });
        result.playerId = player.id;
        result.sequenceIndex = s;
        result.roundIndex = r;
        records.get(player.id).push(result);
      }

      stepsDone += 1;
      if (onProgress && (stepsDone % Math.max(1, Math.floor(totalSteps / 20)) === 0 || stepsDone === totalSteps)) {
        onProgress(stepsDone, totalSteps);
      }
    }
  }

  return {
    config: {
      sequences,
      roundsPerSequence,
      baseSeed,
      observationMs,
      economy,
      economyScale,
      startingCash,
      roundDurationMs: DEFAULT_ROUND_DURATION_MS,
      powerConfig,
      botDecisionConfig: {
        maxTradeSize: DEFAULT_BOT_MAX_TRADE_SIZE,
        maxCoinExposureFraction: DEFAULT_BOT_MAX_COIN_EXPOSURE_FRACTION
      },
      playerIds: players.map((p) => p.id)
    },
    records,
    tracker
  };
}

// ---------------------------------------------------------------------------
// Aggregation.
// ---------------------------------------------------------------------------
function distribution(records, field) {
  const totals = {};
  for (const r of records) {
    for (const [key, n] of Object.entries(r[field] || {})) {
      totals[key] = (totals[key] || 0) + n;
    }
  }
  const sum = Object.values(totals).reduce((a, b) => a + b, 0);
  const shares = {};
  for (const [key, n] of Object.entries(totals)) {
    shares[key] = sum > 0 ? Math.round((n / sum) * 10000) / 100 : 0;
  }
  return { counts: totals, sharesPct: shares, total: sum };
}

function summarizeBotPlayer(records, startingCash) {
  const starts = records.map((r) => r.powerStart);
  const ends = records.map((r) => r.powerEnd);

  // Consecutive MAJORITY-starved rounds (unable to afford even the cheapest
  // buy for over half the round's ticks) — the "starved for hours" measure.
  let maxMajorityStarvedRun = 0;
  let currentRun = 0;
  for (const r of records) {
    if (r.starvedTickPct > 50) {
      currentRun += 1;
      maxMajorityStarvedRun = Math.max(maxMajorityStarvedRun, currentRun);
    } else {
      currentRun = 0;
    }
  }

  const invariantViolations = records.reduce(
    (n, r) => n + (r.cashDrift > 0.01 ? 1 : 0) + (r.basisDrift > 0.01 ? 1 : 0) + r.positionLimitViolations,
    0
  );
  const collapseLossPerRound = records.map(
    (r) => round2(r.collapseLosses.reduce((sum, loss) => sum + loss.valueLost, 0))
  );

  return {
    roundsPlayed: records.length,
    powerAtRoundStart: { mean: round2(mean(starts)), median: round2(median(starts)) },
    powerAtRoundEnd: { mean: round2(mean(ends)), median: round2(median(ends)) },
    starvedTickPct: round2(mean(records.map((r) => r.starvedTickPct))),
    maxConsecutiveMajorityStarvedRounds: maxMajorityStarvedRun,
    tradesPerRound: round2(mean(records.map((r) => r.trades))),
    buysPerRound: round2(mean(records.map((r) => r.executedBuys))),
    sellsPerRound: round2(mean(records.map((r) => r.executedSells))),
    blockedByPower: records.reduce((n, r) => n + r.blockedByPower, 0),
    blockedByPosition: records.reduce((n, r) => n + r.blockedByPosition, 0),
    maxOpenPositionsSeen: Math.max(...records.map((r) => r.maxOpenPositionsSeen)),
    entryPhases: distribution(records, 'buyPhaseCounts'),
    entryRisks: distribution(records, 'buyRiskCounts'),
    collapseLossPerRound: { mean: round2(mean(collapseLossPerRound)), median: round2(median(collapseLossPerRound)) },
    overstayedCollapses: records.reduce((n, r) => n + r.collapseLosses.length, 0),
    zeroPowerSells: {
      attempts: records.reduce((n, r) => n + r.zeroPowerSellAttempts, 0),
      executed: records.reduce((n, r) => n + r.zeroPowerSellExecuted, 0)
    },
    invariantViolations,
    ...summarizeStrategy(records, startingCash)
  };
}

// Pair two players' records by (sequenceIndex, roundIndex).
function pairRecords(aRecords, bRecords) {
  const bByKey = new Map(bRecords.map((r) => [`${r.sequenceIndex}:${r.roundIndex}`, r]));
  const a = [];
  const b = [];
  for (const ra of aRecords) {
    const rb = bByKey.get(`${ra.sequenceIndex}:${ra.roundIndex}`);
    if (rb) {
      a.push(ra);
      b.push(rb);
    }
  }
  return [a, b];
}

// Per-round winner shares among ALL players (ties split the round equally)
// — the "no single personality dominates" evidence.
function roundWinShares(records) {
  const totals = new Map([...records.keys()].map((id) => [id, 0]));
  let rounds = 0;
  const byRound = new Map();
  for (const [id, recs] of records) {
    for (const r of recs) byRound.set(`${r.sequenceIndex}:${r.roundIndex}`, [...(byRound.get(`${r.sequenceIndex}:${r.roundIndex}`) || []), { id, finalCash: r.finalCash }]);
  }
  for (const players of byRound.values()) {
    rounds += 1;
    const best = Math.max(...players.map((p) => p.finalCash));
    const winners = players.filter((p) => p.finalCash === best);
    for (const winner of winners) totals.set(winner.id, totals.get(winner.id) + 1 / winners.length);
  }
  const shares = {};
  for (const [id, total] of totals) {
    shares[id] = rounds > 0 ? Math.round((total / rounds) * 10000) / 100 : 0;
  }
  return { rounds, winPct: shares };
}

function buildBotReport(study) {
  const { config, records, tracker } = study;
  const players = {};
  for (const [id, recs] of records) players[id] = summarizeBotPlayer(recs, config.startingCash);

  const paired = {};
  for (const aId of records.keys()) {
    paired[aId] = {};
    for (const bId of records.keys()) {
      if (aId === bId) continue;
      const [a, b] = pairRecords(records.get(aId), records.get(bId));
      if (a.length === 0) continue;
      paired[aId][bId] = { winRatePct: pairedWinRate(a, b), ...pairedAdvantage(a, b), pairedRounds: a.length };
    }
  }

  const wins = roundWinShares(records);
  const p = players;
  const gate = {};

  const fullRoster = ALL_PLAYER_IDS.every((id) => p[id] && paired[id]);
  if (!fullRoster) {
    gate.skipped = { reason: 'partial player roster — the V2-4 gate requires the full five-player study', pass: null };
    gate.pass = null;
    return { config, gate, players, paired, roundWins: wins, hiddenInfoEvidence: hiddenInfoEvidence(study) };
  }

  const botIds = BOT_PLAYER_IDS.filter((id) => p[id]);

  // 1. All four bots execute real trades and can win rounds.
  gate.allBotsTradeAndWin = {
    target: 'every bot: executed buys > 0 and profitable rounds > 0%',
    perBot: Object.fromEntries(botIds.map((id) => [id, {
      executedBuys: p[id].entryPhases.total,
      profitableRoundPct: p[id].profitableRoundPct,
      roundWinPct: wins.winPct[id]
    }])),
    pass: botIds.every((id) => p[id].entryPhases.total > 0 && p[id].profitableRoundPct > 0)
  };

  // 2. Measurable personality separation — not merely different labels:
  //    distinct entry phases, distinct risk appetites and distinct activity.
  const riskyShare = (id) => ((p[id].entryRisks.counts.DANGER || 0) + (p[id].entryRisks.counts.CRITICAL || 0))
    / Math.max(1, p[id].entryRisks.total);
  const dipShare = (id) => (p[id].entryPhases.counts.DIP || 0) / Math.max(1, p[id].entryPhases.total);
  const riseShare = (id) => (p[id].entryPhases.counts.RISE || 0) / Math.max(1, p[id].entryPhases.total);
  const tradesRange = Math.max(...botIds.map((id) => p[id].tradesPerRound))
    - Math.min(...botIds.map((id) => p[id].tradesPerRound));
  gate.personalitySeparation = {
    target: 'conservative never enters DANGER+; reckless materially does; dip buyer is DIP-dominated; momentum is RISE-dominated; activity spread >= 2 trades/round',
    conservativeRiskyEntryShare: round2(riskyShare('BOT_CONSERVATIVE') * 100) / 100,
    recklessRiskyEntryShare: round2(riskyShare('BOT_RECKLESS') * 100) / 100,
    dipBuyerDipEntryShare: round2(dipShare('BOT_DIP_BUYER') * 100) / 100,
    momentumDipEntryShare: round2(dipShare('BOT_MOMENTUM') * 100) / 100,
    momentumRiseEntryShare: round2(riseShare('BOT_MOMENTUM') * 100) / 100,
    tradesPerRoundByPlayer: Object.fromEntries(botIds.map((id) => [id, p[id].tradesPerRound])),
    pass: riskyShare('BOT_CONSERVATIVE') === 0
      && riskyShare('BOT_RECKLESS') >= 0.02
      && dipShare('BOT_DIP_BUYER') >= 0.5
      && dipShare('BOT_MOMENTUM') <= 0.15
      && riseShare('BOT_MOMENTUM') >= 0.6
      && tradesRange >= 2
  };

  // 3. Bots obey Power and the position limit with zero violations.
  gate.safeguardsHold = {
    target: 'zero cash/basis/position invariant violations; max open positions never above the limit',
    invariantViolations: Object.values(players).reduce((n, pl) => n + pl.invariantViolations, 0),
    maxOpenPositionsSeen: Object.fromEntries(botIds.map((id) => [id, p[id].maxOpenPositionsSeen])),
    positionLimitBlocks: Object.fromEntries(botIds.map((id) => [id, p[id].blockedByPosition])),
    pass: Object.values(players).every((pl) => pl.invariantViolations === 0)
      && botIds.every((id) => p[id].maxOpenPositionsSeen <= config.powerConfig.maxOpenPositions)
  };

  // 4. Power remains sustainable over repeated rounds: no bot hits a
  //    majority-starved round and every bot reliably returns to meaningful
  //    Power at round starts.
  gate.powerSustainable = {
    target: 'zero majority-starved rounds per bot; median round-start Power >= 10',
    majorityStarvedRuns: Object.fromEntries(botIds.map((id) => [id, p[id].maxConsecutiveMajorityStarvedRounds])),
    medianStartPower: Object.fromEntries(botIds.map((id) => [id, p[id].powerAtRoundStart.median])),
    starvedTickPct: Object.fromEntries(botIds.map((id) => [id, p[id].starvedTickPct])),
    pass: botIds.every((id) => p[id].maxConsecutiveMajorityStarvedRounds === 0
      && p[id].powerAtRoundStart.median >= 10)
  };

  // 5. Sells succeed when Power is zero: the invariant (every sell
  //    attempted at < 1 effective Power executed) must ALWAYS hold. The
  //    organic zero-Power sell overlap is rare by design (the decision
  //    layer is Power-aware, so bots seldom sit at zero Power with a
  //    sellable position), so the mechanism itself is additionally proven
  //    deterministically in __tests__/v2-bot-signals.test.js (engine-level
  //    zero-Power sell executes) and the live sell path never reads Power.
  const zeroAttempts = Object.values(players).reduce((n, pl) => n + pl.zeroPowerSells.attempts, 0);
  const zeroExecuted = Object.values(players).reduce((n, pl) => n + pl.zeroPowerSells.executed, 0);
  gate.sellsSucceedAtZeroPower = {
    target: 'every sell attempted at < 1 Power executed (invariant always holds; organic attempts reported)',
    attempts: zeroAttempts,
    executed: zeroExecuted,
    pass: zeroExecuted === zeroAttempts
  };

  // 6. No one BOT personality wins almost every round (the DIP_BOOM
  //    benchmark is the skilled human-like yardstick, not a roster
  //    personality; its share is reported for context and gated by the
  //    dipBuyerCompetitive criterion instead).
  const maxBotWinPct = Math.max(...botIds.map((id) => wins.winPct[id]));
  gate.noDominantPersonality = {
    target: 'every bot personality round-win share <= 45%',
    winPct: wins.winPct,
    benchmarkWinPct: wins.winPct.DIP_BOOM,
    pass: maxBotWinPct <= 45
  };

  // 7. Dip Buyer remains competitive with the skilled DIP_BOOM benchmark:
  //    not systematically outclassed (paired win rate at least a real
  //    contest) and in the same ROI league.
  gate.dipBuyerCompetitive = {
    target: 'BOT_DIP_BUYER vs DIP_BOOM paired win rate >= 30% and median ROI within 10 points of the benchmark',
    pairedWinRatePct: paired.BOT_DIP_BUYER.DIP_BOOM.winRatePct,
    medianDiff: paired.BOT_DIP_BUYER.DIP_BOOM.medianDiff,
    dipBuyerMedianRoi: p.BOT_DIP_BUYER.medianRoi,
    benchmarkMedianRoi: p.DIP_BOOM.medianRoi,
    pass: paired.BOT_DIP_BUYER.DIP_BOOM.winRatePct >= 30
      && p.BOT_DIP_BUYER.medianRoi >= p.DIP_BOOM.medianRoi - 10
  };

  // 8. Reckless has materially higher risk/collapse exposure than
  //    Conservative (collapse losses and/or drawdown), and Conservative
  //    shows the intended lower-activity/lower-drawdown profile.
  gate.recklessRiskierThanConservative = {
    target: 'reckless mean collapse loss per round materially above conservative, and reckless drawdown above conservative',
    recklessCollapseLossPerRound: p.BOT_RECKLESS.collapseLossPerRound.mean,
    conservativeCollapseLossPerRound: p.BOT_CONSERVATIVE.collapseLossPerRound.mean,
    recklessMeanMaxDrawdown: p.BOT_RECKLESS.meanMaxDrawdown,
    conservativeMeanMaxDrawdown: p.BOT_CONSERVATIVE.meanMaxDrawdown,
    recklessOverstayedCollapses: p.BOT_RECKLESS.overstayedCollapses,
    conservativeOverstayedCollapses: p.BOT_CONSERVATIVE.overstayedCollapses,
    pass: p.BOT_RECKLESS.collapseLossPerRound.mean >= p.BOT_CONSERVATIVE.collapseLossPerRound.mean + 25
      && p.BOT_RECKLESS.meanMaxDrawdown > p.BOT_CONSERVATIVE.meanMaxDrawdown
  };

  // 9. No hidden information ever reached a decision: every adapted input
  //    was verified against the exact public allowlist (a violation would
  //    have thrown and failed the study).
  const evidence = hiddenInfoEvidence(study);
  gate.noHiddenInformation = {
    target: 'every bot decision input verified against the public allowlist; zero hidden-field violations',
    ...evidence,
    pass: evidence.decisionInputsChecked > 0 && evidence.hiddenFieldViolations === 0
  };

  gate.pass = Object.values(gate).every((c) => c === gate.pass || c.pass !== false);

  return { config, gate, players, paired, roundWins: wins, hiddenInfoEvidence: evidence };
}

function hiddenInfoEvidence(study) {
  return {
    decisionInputsChecked: study.tracker.decisionInputsChecked,
    hiddenFieldViolations: 0, // any violation throws inside the adapter and aborts the study
    contract: 'botService.assertPublicBotState on every adapted decision input (live tick and simulation share the exact allowlist)'
  };
}

module.exports = {
  BOT_STUDY_BASE_SEED,
  BOT_PLAYER_DEFS,
  ALL_PLAYER_IDS,
  BOT_PLAYER_IDS,
  deriveSequenceSeed,
  makeBotStrategy,
  runBotStudy,
  buildBotReport
};
