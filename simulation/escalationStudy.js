// V2-3 apocalypse escalation + collapse-risk + passive-economy study.
//
// Extends the SAME simulator (identical seeded market paths, identical
// 15-second observation cadence, identical trade mechanics, identical V2-2
// Power/position rules) to measure the V2-3 gameplay layer:
//
//   * escalation as a gameplay accelerator — per-band price movement,
//     opportunity availability and collapse exposure on the EXISTING Core 2
//     amplitude curve (game/apocalypseVolatility.js), which this study
//     either validates or indicts with evidence;
//   * the coarse collapse-risk signal (game/collapseRiskDomain.js) —
//     distribution by band, usefulness vs apocalypse progress, and
//     imperfectness against the hidden collapse schedule;
//   * the passive economy — the SAME rounds played twice on identical
//     market paths: legacy Core 7 amounts (scale 1) versus the selected V2
//     configuration (an explicit scale in [0,1]), so the only thing that
//     differs between paired runs is the deduction stream.
//
// Study shape mirrors the V2-2 power study: S independent seeded sequences
// of R consecutive 30-minute rounds, one persistent Power account per
// player per economy variant on one continuous study clock. All players
// face identical round seeds in a sequence, so paired comparisons stay
// valid within each economy variant.

const crypto = require('crypto');
const { createRoundEnvironment, DEFAULT_ROUND_DURATION_MS } = require('./roundEnvironment');
const { createRoundContext, runRound, DEFAULT_OBSERVATION_MS } = require('./engine');
const { STRATEGIES } = require('./strategies');
const { deriveRoundSeed } = require('./batch');
const { mean, median, summarizeStrategy, pairedWinRate, pairedAdvantage } = require('./metrics');
const powerDomain = require('../game/powerDomain');
const riskDomain = require('../game/collapseRiskDomain');
const { ESCALATION_BAND_IDS } = require('../game/apocalypseVolatility');
const { GAME_STARTING_CASH } = require('../game/gameConstants');

const ESCALATION_STUDY_BASE_SEED = 'v2-3-escalation-study-base-seed';
// The selected V2 gameplay economy configuration: every passive deduction
// (fee, tax, event) at one quarter of the legacy Core 7 amounts — explicit,
// validated, and compared head-to-head against the legacy defaults in this
// study. The legacy defaults remain the untouched code/production path.
const V2_ECONOMY_SCALE = 0.25;

// The required V2-3 roster: DIP-BOOM, RANDOM, SPAM, HOLD_FOREVER,
// LATE_ENTRANT and two dangerous/late sellers (LATE_SELLER habitually
// exits after the fall is underway; OVERSTAYER refuses to bank gains and
// rides booms back into falls/collapses). RISK_AWARE mechanises the
// intended public-risk decision ("the coin is CRITICAL — cash out?").
const PLAYER_DEFS = [
  { id: 'RANDOM', strategyId: 'RANDOM' },
  { id: 'DIP_BOOM', strategyId: 'DIP_BOOM' },
  { id: 'LATE_SELLER', strategyId: 'LATE_SELLER' },
  { id: 'HOLD_FOREVER', strategyId: 'HOLD_FOREVER' },
  { id: 'SPAM', strategyId: 'SPAM' },
  { id: 'OVERSTAYER', strategyId: 'OVERSTAYER' },
  { id: 'RISK_AWARE', strategyId: 'RISK_AWARE' },
  { id: 'LATE_ENTRANT', strategyId: 'DIP_BOOM', joinFraction: 0.5 }
];
const ALL_PLAYER_IDS = PLAYER_DEFS.map((p) => p.id);

function deriveSequenceSeed(baseSeed, sequenceIndex) {
  return crypto.createHash('sha256').update(`${baseSeed}:sequence:${sequenceIndex}`).digest('hex');
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

// ---------------------------------------------------------------------------
// Per-round market instrumentation (strategy-independent; computed once per
// round from the shared context grids). Everything here is derived from
// prices/signals the SAME domain code produces live.
// ---------------------------------------------------------------------------
function computeRoundMarketStats(context) {
  const { env, ticks, gridByCoin, signalGrid } = context;

  const bandTickMoves = {};   // band -> [abs per-tick move % across live coins]
  const bandSwing = {};       // band -> [per-coin per-equal-window (max-min)/min %]
  const bandFloorTicks = {};  // band -> [live-coin ticks pinned at/near the price floor]
  const bandLiveTicks = {};   // band -> [total live-coin ticks observed]
  const bandOppTicks = {};    // band -> [ticks with >=1 legal entry opportunity, 0/1]
  const bandLiveCounts = {};  // band -> [live coin count per tick]
  const bandRisk = {};        // band -> { STABLE: n, SHAKY: n, DANGER: n, CRITICAL: n }
  for (const bandId of ESCALATION_BAND_IDS) {
    bandTickMoves[bandId] = [];
    bandSwing[bandId] = [];
    bandFloorTicks[bandId] = 0;
    bandLiveTicks[bandId] = 0;
    bandOppTicks[bandId] = [];
    bandLiveCounts[bandId] = [];
    bandRisk[bandId] = { STABLE: 0, SHAKY: 0, DANGER: 0, CRITICAL: 0 };
  }

  // Imperfectness probe: at sampled ticks inside the collapse window, would
  // "the highest-risk live coin collapses next" be RIGHT? Uses ONLY the
  // public risk LEVEL (what a player sees), ties broken by lowest coin id.
  let classifierHits = 0;
  let classifierSamples = 0;
  let classifierChanceSum = 0;

  const bandOfTick = (t) => {
    const pct = env.apocalypsePercentAt(t);
    if (pct < 40) return 'NORMAL';
    if (pct < 70) return 'ELEVATED';
    if (pct < 90) return 'HIGH';
    return 'EXTREME';
  };

  // Per-coin price path bucketed into fixed equal-duration windows, so the
  // opportunity-swing comparison between bands is FAIR: bands span very
  // different round fractions (NORMAL is 12 minutes, EXTREME only 3), and a
  // whole-band (max-min)/min would mechanically favour the longer band no
  // matter what the amplitude curve does. Swing is therefore measured per
  // 3-minute window per coin (over that coin's live ticks in the window;
  // windows where the coin was alive for less than half the window are
  // excluded), then attributed to the band containing the window midpoint.
  const SWING_WINDOW_MS = 3 * 60 * 1000;
  const windowCount = Math.ceil(env.durationMs / SWING_WINDOW_MS);
  const coinWindowPrices = new Map(); // windowIndex -> Map(coinId -> [prices])
  for (let w = 0; w < windowCount; w++) coinWindowPrices.set(w, new Map());

  for (let i = 0; i < ticks.length; i++) {
    const t = ticks[i];
    const bandId = bandOfTick(t);
    const signals = signalGrid[i];
    const liveSignals = signals.filter((s) => !s.dead);
    bandLiveCounts[bandId].push(liveSignals.length);

    const windowIndex = Math.min(windowCount - 1, Math.floor(t / SWING_WINDOW_MS));
    for (const signal of liveSignals) {
      bandRisk[bandId][signal.collapseRisk] += 1;
      const prices = gridByCoin.get(signal.coinId);
      bandLiveTicks[bandId] += 1;
      // Near-floor ticks: a live coin pinned at the strictly-positive price
      // floor (V2-1 domain guarantee) under late-apocalypse amplitude.
      if (prices[i] <= 0.001) bandFloorTicks[bandId] += 1;
      if (i > 0 && !env.isDead(signal.coinId, ticks[i - 1])) {
        const prev = prices[i - 1];
        if (prev > 0) {
          bandTickMoves[bandId].push(Math.abs((prices[i] - prev) / prev) * 100);
        }
      }
      if (!coinWindowPrices.get(windowIndex).has(signal.coinId)) {
        coinWindowPrices.get(windowIndex).set(signal.coinId, []);
      }
      coinWindowPrices.get(windowIndex).get(signal.coinId).push(prices[i]);
    }

    // A legal entry opportunity: a live coin in DIP, or barely off the
    // trough in early RISE — the same definition the strategies act on.
    const opportunity = liveSignals.some((s) =>
      s.phase === 'DIP' || (s.phase === 'RISE' && s.recentChangePct !== null && s.recentChangePct <= 2));
    bandOppTicks[bandId].push(opportunity ? 1 : 0);

    // Imperfectness probe (every 4th tick, collapse window only).
    if (t >= env.durationMs * 0.70 && i % 4 === 0 && liveSignals.length >= 2) {
      const remaining = liveSignals.filter((s) => env.collapseAtMs.get(s.coinId) > t);
      if (remaining.length >= 2) {
        const best = remaining.slice().sort((a, b) =>
          riskDomain.COLLAPSE_RISK_ORDINAL[b.collapseRisk] - riskDomain.COLLAPSE_RISK_ORDINAL[a.collapseRisk] ||
          a.coinId - b.coinId)[0];
        const nextToCollapse = remaining.slice().sort((a, b) =>
          env.collapseAtMs.get(a.coinId) - env.collapseAtMs.get(b.coinId))[0];
        classifierSamples += 1;
        classifierChanceSum += 1 / remaining.length;
        if (best.coinId === nextToCollapse.coinId) classifierHits += 1;
      }
    }
  }

  for (let w = 0; w < windowCount; w++) {
    const windowMidMs = w * SWING_WINDOW_MS + SWING_WINDOW_MS / 2;
    const bandId = bandOfTick(Math.min(windowMidMs, env.durationMs));
    const ticksPerWindow = Math.ceil(SWING_WINDOW_MS / (ticks[1] - ticks[0]));
    for (const [, prices] of coinWindowPrices.get(w)) {
      // Require the coin alive for at least half the window; measure the
      // swing over its live ticks only.
      if (prices.length >= Math.max(2, Math.ceil(ticksPerWindow / 2))) {
        const min = Math.min(...prices);
        const max = Math.max(...prices);
        if (min > 0) bandSwing[bandId].push(((max - min) / min) * 100);
      }
    }
  }

  const bands = {};
  for (const bandId of ESCALATION_BAND_IDS) {
    const riskCounts = bandRisk[bandId];
    const riskTotal = riskCounts.STABLE + riskCounts.SHAKY + riskCounts.DANGER + riskCounts.CRITICAL;
    const riskOrdinalMean = riskTotal > 0
      ? (riskCounts.SHAKY + 2 * riskCounts.DANGER + 3 * riskCounts.CRITICAL) / riskTotal
      : 0;
    bands[bandId] = {
      // Median-first reporting: near-floor rebounds (a V2-1 market-domain
      // behaviour under late amplitude, reported separately as
      // floorTickPct) can produce individual enormous percentage moves;
      // medians keep the band gradient representative of typical play.
      meanTickMovePct: round2(mean(bandTickMoves[bandId]) * 100) / 100,
      medianTickMovePct: round2(median(bandTickMoves[bandId]) * 100) / 100,
      meanSwingPct: round2(mean(bandSwing[bandId]) * 100) / 100,
      medianSwingPct: round2(median(bandSwing[bandId]) * 100) / 100,
      floorTickPct: bandLiveTicks[bandId] > 0 ? round2((bandFloorTicks[bandId] / bandLiveTicks[bandId]) * 10000) / 100 : 0,
      opportunityTickPct: round2(mean(bandOppTicks[bandId]) * 100),
      meanLiveCoins: round2(mean(bandLiveCounts[bandId]) * 100) / 100,
      riskDistribution: riskCounts,
      meanRiskOrdinal: Math.round(riskOrdinalMean * 1000) / 1000
    };
  }

  return {
    bands,
    classifier: {
      samples: classifierSamples,
      hits: classifierHits,
      accuracyPct: classifierSamples > 0 ? round2((classifierHits / classifierSamples) * 100) : null,
      chanceAccuracyPct: classifierSamples > 0 ? round2((classifierChanceSum / classifierSamples) * 100) : null
    }
  };
}

// ---------------------------------------------------------------------------
// The study.
// ---------------------------------------------------------------------------
function runEscalationStudy({
  sequences = 30,
  roundsPerSequence = 24,
  baseSeed = ESCALATION_STUDY_BASE_SEED,
  observationMs = DEFAULT_OBSERVATION_MS,
  startingCash = GAME_STARTING_CASH,
  v2EconomyScale = V2_ECONOMY_SCALE,
  playerIds = ALL_PLAYER_IDS,
  powerConfig: powerConfigOverrides = null,
  onProgress = null
} = {}) {
  if (!Number.isInteger(sequences) || sequences <= 0) throw new Error(`sequences must be a positive integer; received ${sequences}`);
  if (!Number.isInteger(roundsPerSequence) || roundsPerSequence <= 0) throw new Error(`roundsPerSequence must be a positive integer; received ${roundsPerSequence}`);
  if (typeof v2EconomyScale !== 'number' || !Number.isFinite(v2EconomyScale) || v2EconomyScale < 0 || v2EconomyScale > 1) {
    throw new Error(`v2EconomyScale must be a finite number in [0, 1]; received ${String(v2EconomyScale)}`);
  }

  const powerConfig = powerDomain.resolvePowerConfig(powerConfigOverrides || {});
  const players = playerIds.map((id) => {
    const def = PLAYER_DEFS.find((p) => p.id === id);
    if (!def) throw new Error(`unknown escalation-study player ${String(id)}`);
    return { ...def, strategy: STRATEGIES[def.strategyId] };
  });

  const VARIANTS = ['legacy', 'v2'];
  const records = new Map();
  for (const variant of VARIANTS) {
    records.set(variant, new Map(players.map((p) => [p.id, []])));
  }
  const marketStats = [];
  const totalSteps = sequences * roundsPerSequence;
  let stepsDone = 0;

  for (let s = 0; s < sequences; s++) {
    const sequenceSeed = deriveSequenceSeed(baseSeed, s);
    // One persistent Power account per player PER VARIANT: the economy
    // changes executed trades, so Power histories legitimately diverge.
    const accounts = new Map();
    for (const variant of VARIANTS) {
      accounts.set(variant, new Map(players.map((p) => [p.id, { power: powerConfig.maxPower, updatedAtMs: 0 }])));
    }

    for (let r = 0; r < roundsPerSequence; r++) {
      const roundSeed = deriveRoundSeed(sequenceSeed, r);
      // IDENTICAL seeded market path / collapse schedule / signals; only
      // the passive-debit stream differs between the two variants.
      const envLegacy = createRoundEnvironment({ seed: roundSeed, economy: true, economyScale: 1 });
      const envV2 = v2EconomyScale === 1
        ? envLegacy
        : createRoundEnvironment({ seed: roundSeed, economy: true, economyScale: v2EconomyScale });
      const context = createRoundContext(envLegacy, { observationMs });
      const timeOffsetMs = r * envLegacy.durationMs;

      marketStats.push(computeRoundMarketStats(context));

      for (const player of players) {
        for (const variant of VARIANTS) {
          const account = accounts.get(variant).get(player.id);
          const result = runRound(context, player.strategy, {
            startingCash,
            powerAccount: account,
            maxPositions: powerConfig.maxOpenPositions,
            joinAtMs: player.joinFraction ? Math.floor(envLegacy.durationMs * player.joinFraction) : 0,
            powerConfig,
            timeOffsetMs,
            debits: variant === 'v2' ? envV2.debits : envLegacy.debits
          });
          result.playerId = player.id;
          result.sequenceIndex = s;
          result.roundIndex = r;
          result.economyVariant = variant;
          records.get(variant).get(player.id).push(result);
        }
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
      startingCash,
      roundDurationMs: DEFAULT_ROUND_DURATION_MS,
      powerConfig,
      legacyEconomyScale: 1,
      v2EconomyScale,
      playerIds: players.map((p) => p.id)
    },
    records,
    marketStats
  };
}

// ---------------------------------------------------------------------------
// Aggregation.
// ---------------------------------------------------------------------------
function summarizePlayer(recs, startingCash) {
  const collapseLossTotal = recs.reduce((n, r) => n + r.collapseLosses.reduce((m, l) => m + l.valueLost, 0), 0);
  const collapseLossByBand = { HIGH: 0, EXTREME: 0 };
  for (const r of recs) {
    for (const loss of r.collapseLosses) {
      const bandId = loss.apocalypsePercent < 90 ? 'HIGH' : 'EXTREME';
      collapseLossByBand[bandId] = round2(collapseLossByBand[bandId] + loss.valueLost);
    }
  }
  const bandTrades = {};
  for (const bandId of ESCALATION_BAND_IDS) {
    bandTrades[bandId] = recs.reduce((n, r) => n + r.bandTrades[bandId], 0);
  }
  const debits = recs.map((r) => r.debitsPaid);
  // "Routinely erased": rounds where the player would have been profitable
  // before passive deductions, but the deductions consumed the ENTIRE
  // pre-passive gain (final at or below starting cash because of them).
  let erasedRounds = 0;
  let profitablePrePassive = 0;
  for (const r of recs) {
    const prePassiveProfit = round2(r.finalCash + r.debitsPaid - startingCash);
    if (prePassiveProfit > 0) {
      profitablePrePassive += 1;
      if (r.debitsPaid >= prePassiveProfit) erasedRounds += 1;
    }
  }
  const invariantViolations = recs.reduce(
    (n, r) => n + (r.cashDrift > 0.01 ? 1 : 0) + (r.basisDrift > 0.01 ? 1 : 0) + r.positionLimitViolations,
    0
  );

  return {
    rounds: recs.length,
    ...summarizeStrategy(recs, startingCash),
    bandTrades,
    collapseLossTotal: round2(collapseLossTotal),
    meanCollapseLossPerRound: round2(mean(recs.map((r) => r.collapseLosses.reduce((m, l) => m + l.valueLost, 0)))),
    collapseLossByBand,
    meanDebitsPerRound: round2(mean(debits)),
    medianDebitsPerRound: round2(median(debits)),
    erasedGainRoundPct: profitablePrePassive > 0 ? round2((erasedRounds / profitablePrePassive) * 100) : 0,
    blockedByPower: recs.reduce((n, r) => n + r.blockedByPower, 0),
    blockedByPosition: recs.reduce((n, r) => n + r.blockedByPosition, 0),
    invariantViolations
  };
}

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

function summarizeMarket(marketStats) {
  const bands = {};
  for (const bandId of ESCALATION_BAND_IDS) {
    bands[bandId] = {
      meanTickMovePct: round2(mean(marketStats.map((m) => m.bands[bandId].meanTickMovePct))),
      // Robust band representatives: median across rounds of each round's
      // per-band median. Near-floor rebounds (see floorTickPct) can make a
      // single round's EXTREME median enormous when only one or two coins
      // are still alive; the cross-round median keeps the gate measuring
      // the typical round, not the wildest one.
      medianTickMovePct: round2(median(marketStats.map((m) => m.bands[bandId].medianTickMovePct))),
      meanSwingPct: round2(mean(marketStats.map((m) => m.bands[bandId].meanSwingPct))),
      medianSwingPct: round2(median(marketStats.map((m) => m.bands[bandId].medianSwingPct))),
      floorTickPct: round2(mean(marketStats.map((m) => m.bands[bandId].floorTickPct))),
      opportunityTickPct: round2(mean(marketStats.map((m) => m.bands[bandId].opportunityTickPct))),
      meanLiveCoins: round2(mean(marketStats.map((m) => m.bands[bandId].meanLiveCoins))),
      meanRiskOrdinal: Math.round(mean(marketStats.map((m) => m.bands[bandId].meanRiskOrdinal)) * 1000) / 1000,
      riskDistribution: {
        STABLE: marketStats.reduce((n, m) => n + m.bands[bandId].riskDistribution.STABLE, 0),
        SHAKY: marketStats.reduce((n, m) => n + m.bands[bandId].riskDistribution.SHAKY, 0),
        DANGER: marketStats.reduce((n, m) => n + m.bands[bandId].riskDistribution.DANGER, 0),
        CRITICAL: marketStats.reduce((n, m) => n + m.bands[bandId].riskDistribution.CRITICAL, 0)
      }
    };
  }
  const samples = marketStats.reduce((n, m) => n + m.classifier.samples, 0);
  const hits = marketStats.reduce((n, m) => n + m.classifier.hits, 0);
  const chanceSum = marketStats.reduce((n, m) => n + (m.classifier.samples > 0
    ? (m.classifier.chanceAccuracyPct / 100) * m.classifier.samples
    : 0), 0);
  return {
    rounds: marketStats.length,
    bands,
    classifier: {
      samples,
      accuracyPct: samples > 0 ? round2((hits / samples) * 100) : null,
      chanceAccuracyPct: samples > 0 ? round2((chanceSum / samples) * 100) : null
    }
  };
}

function buildEscalationReport(study) {
  const { config, records, marketStats } = study;
  const market = summarizeMarket(marketStats);

  const players = {};
  const paired = {};
  for (const variant of ['legacy', 'v2']) {
    players[variant] = {};
    paired[variant] = {};
    for (const [id, recs] of records.get(variant)) {
      players[variant][id] = summarizePlayer(recs, config.startingCash);
    }
    for (const [aId, aRecs] of records.get(variant)) {
      paired[variant][aId] = {};
      for (const [bId, bRecs] of records.get(variant)) {
        if (aId === bId) continue;
        const [a, b] = pairRecords(aRecs, bRecs);
        if (a.length === 0) continue;
        paired[variant][aId][bId] = { winRatePct: pairedWinRate(a, b), ...pairedAdvantage(a, b), pairedRounds: a.length };
      }
    }
  }

  const gate = {};
  const fullRoster = ALL_PLAYER_IDS.every((id) => players.v2[id] && paired.v2[id]);
  if (!fullRoster) {
    gate.skipped = { reason: 'partial player roster — the V2-3 gate requires the full eight-player study', pass: null };
    gate.pass = null;
    return { config, gate, market, players, paired };
  }

  const pv = players.v2;
  const pl = players.legacy;
  const qv = paired.v2;
  const bands = market.bands;

  // 1. Early round remains understandable/normal: skilled play keeps its
  //    clear edge and early-band movement is materially calmer than late.
  gate.earlyRoundNormal = {
    target: 'DIP_BOOM vs RANDOM >= 70% paired (v2 economy) and NORMAL band median tick-move <= HIGH band median tick-move',
    dipBoomVsRandomWinRatePct: qv.DIP_BOOM.RANDOM.winRatePct,
    normalMedianTickMovePct: bands.NORMAL.medianTickMovePct,
    highMedianTickMovePct: bands.HIGH.medianTickMovePct,
    pass: qv.DIP_BOOM.RANDOM.winRatePct >= 70 && bands.NORMAL.medianTickMovePct <= bands.HIGH.medianTickMovePct
  };

  // 2. Late round offers clearly greater upside/opportunity.
  gate.lateRoundGreaterUpside = {
    target: 'EXTREME band median equal-window swing >= 1.5x NORMAL band median swing',
    normalMedianSwingPct: bands.NORMAL.medianSwingPct,
    elevatedMedianSwingPct: bands.ELEVATED.medianSwingPct,
    highMedianSwingPct: bands.HIGH.medianSwingPct,
    extremeMedianSwingPct: bands.EXTREME.medianSwingPct,
    ratio: bands.NORMAL.medianSwingPct > 0 ? round2(bands.EXTREME.medianSwingPct / bands.NORMAL.medianSwingPct) : null,
    pass: bands.NORMAL.medianSwingPct > 0 && bands.EXTREME.medianSwingPct >= 1.5 * bands.NORMAL.medianSwingPct
  };

  // 3. Late round contains clearly greater danger/downside: faster late
  //    movement AND real collapse-destroyed value concentrated late.
  gate.lateRoundGreaterDanger = {
    target: 'EXTREME median tick-move >= 1.5x NORMAL and mean collapse loss per overstay-style round > 0, concentrated in HIGH/EXTREME',
    normalMedianTickMovePct: bands.NORMAL.medianTickMovePct,
    extremeMedianTickMovePct: bands.EXTREME.medianTickMovePct,
    ratio: bands.NORMAL.medianTickMovePct > 0 ? round2(bands.EXTREME.medianTickMovePct / bands.NORMAL.medianTickMovePct) : null,
    extremeFloorTickPct: bands.EXTREME.floorTickPct,
    overstayerMeanCollapseLoss: pv.OVERSTAYER.meanCollapseLossPerRound,
    holdForeverMeanCollapseLoss: pv.HOLD_FOREVER.meanCollapseLossPerRound,
    pass: bands.NORMAL.medianTickMovePct > 0
      && bands.EXTREME.medianTickMovePct >= 1.5 * bands.NORMAL.medianTickMovePct
      && (pv.OVERSTAYER.meanCollapseLossPerRound > 0 || pv.HOLD_FOREVER.meanCollapseLossPerRound > 0)
  };

  // 4. Good exit timing beats late/overstay behaviour.
  gate.exitTimingMatters = {
    target: 'DIP_BOOM beats LATE_SELLER > 55% and OVERSTAYER >= 65% paired',
    vsLateSellerWinRatePct: qv.DIP_BOOM.LATE_SELLER.winRatePct,
    vsOverstayerWinRatePct: qv.DIP_BOOM.OVERSTAYER.winRatePct,
    overstayerMedianRoi: pv.OVERSTAYER.medianRoi,
    dipBoomMedianRoi: pv.DIP_BOOM.medianRoi,
    pass: qv.DIP_BOOM.LATE_SELLER.winRatePct > 55
      && qv.DIP_BOOM.OVERSTAYER.winRatePct >= 65
      && pv.OVERSTAYER.medianRoi < pv.DIP_BOOM.medianRoi
  };

  // 5. Late entrants retain meaningful comeback potential.
  gate.lateEntrantComeback = {
    target: 'LATE_ENTRANT beats RANDOM >= 60% paired with positive median ROI',
    lateVsRandomWinRatePct: qv.LATE_ENTRANT.RANDOM.winRatePct,
    lateMedianRoi: pv.LATE_ENTRANT.medianRoi,
    lateProfitableRoundPct: pv.LATE_ENTRANT.profitableRoundPct,
    pass: qv.LATE_ENTRANT.RANDOM.winRatePct >= 60 && pv.LATE_ENTRANT.medianRoi > 0
  };

  // 6. Collapse risk does not reveal the exact hidden schedule.
  gate.riskNotScheduleLeak = {
    target: 'top-public-risk next-collapse classifier accuracy < 50% (chance reported alongside)',
    classifierSamples: market.classifier.samples,
    accuracyPct: market.classifier.accuracyPct,
    chanceAccuracyPct: market.classifier.chanceAccuracyPct,
    pass: market.classifier.samples > 0 && market.classifier.accuracyPct < 50
  };

  // 7. Risk rises with apocalypse danger (useful) without encoding order.
  gate.riskTracksDanger = {
    target: 'mean risk ordinal strictly rises NORMAL -> HIGH -> EXTREME',
    normalRiskOrdinal: bands.NORMAL.meanRiskOrdinal,
    highRiskOrdinal: bands.HIGH.meanRiskOrdinal,
    extremeRiskOrdinal: bands.EXTREME.meanRiskOrdinal,
    pass: bands.NORMAL.meanRiskOrdinal < bands.HIGH.meanRiskOrdinal
      && bands.HIGH.meanRiskOrdinal < bands.EXTREME.meanRiskOrdinal
  };

  // 8. Collapses do not remove all worthwhile choices too early.
  gate.choicesRemainLate = {
    target: 'HIGH band: >= 3 mean live coins and >= 40% of ticks with a legal entry opportunity',
    highMeanLiveCoins: bands.HIGH.meanLiveCoins,
    highOpportunityTickPct: bands.HIGH.opportunityTickPct,
    elevatedOpportunityTickPct: bands.ELEVATED.opportunityTickPct,
    pass: bands.HIGH.meanLiveCoins >= 3 && bands.HIGH.opportunityTickPct >= 40
  };

  // 9. HOLD_FOREVER is materially risky, not a rescue strategy.
  gate.holdForeverRisky = {
    target: 'HOLD_FOREVER median ROI < 0 and profitable rounds < 25%',
    holdMedianRoi: pv.HOLD_FOREVER.medianRoi,
    holdProfitableRoundPct: pv.HOLD_FOREVER.profitableRoundPct,
    pass: pv.HOLD_FOREVER.medianRoi < 0 && pv.HOLD_FOREVER.profitableRoundPct < 25
  };

  // 10. Passive deductions do not routinely erase correctly timed trading
  //     gains under the selected V2 economy configuration.
  gate.economyDoesNotEraseSkill = {
    target: 'v2 economy: DIP_BOOM erased-gain rounds <= 25% of pre-passive-profitable rounds, median debits <= 5% of starting cash, and DIP_BOOM median ROI no worse than legacy by more than a rounding margin',
    v2MedianDebitsPerRound: pv.DIP_BOOM.medianDebitsPerRound,
    v2ErasedGainRoundPct: pv.DIP_BOOM.erasedGainRoundPct,
    legacyErasedGainRoundPct: pl.DIP_BOOM.erasedGainRoundPct,
    v2DipBoomMedianRoi: pv.DIP_BOOM.medianRoi,
    legacyDipBoomMedianRoi: pl.DIP_BOOM.medianRoi,
    pass: pv.DIP_BOOM.erasedGainRoundPct <= 25
      && pv.DIP_BOOM.medianDebitsPerRound <= config.startingCash * 0.05
      && pv.DIP_BOOM.medianRoi >= pl.DIP_BOOM.medianRoi - 0.5
  };

  // 11. V2-2 Power and position rules remain valid across the study.
  const totalInvariantViolations = Object.values(players.legacy).reduce((n, p) => n + p.invariantViolations, 0)
    + Object.values(players.v2).reduce((n, p) => n + p.invariantViolations, 0);
  const powerBind = Object.values(players.v2).some((p) => p.blockedByPower > 0);
  const positionExercised = Object.values(players.v2).some((p) => p.blockedByPosition > 0);
  gate.powerAndPositionValid = {
    target: 'zero cash/basis/position invariant violations; Power binds; position limit exercised',
    invariantViolations: totalInvariantViolations,
    powerBlockedBuys: Object.values(players.v2).reduce((n, p) => n + p.blockedByPower, 0),
    positionBlockedBuys: Object.values(players.v2).reduce((n, p) => n + p.blockedByPosition, 0),
    pass: totalInvariantViolations === 0 && powerBind && positionExercised
  };

  gate.pass = Object.values(gate).every((c) => c === gate.pass || c.pass !== false);

  return { config, gate, market, players, paired };
}

module.exports = {
  ESCALATION_STUDY_BASE_SEED,
  V2_ECONOMY_SCALE,
  PLAYER_DEFS,
  ALL_PLAYER_IDS,
  deriveSequenceSeed,
  computeRoundMarketStats,
  runEscalationStudy,
  buildEscalationReport
};
