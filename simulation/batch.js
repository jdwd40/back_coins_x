// V2-1 simulation batch runner: paired seeded rounds over every strategy.
// Round seeds are derived deterministically from the batch base seed —
// seeds are never cherry-picked.

const crypto = require('crypto');
const { createRoundEnvironment, DEFAULT_ROUND_DURATION_MS } = require('./roundEnvironment');
const { runRound, createRoundContext, DEFAULT_OBSERVATION_MS } = require('./engine');
const { STRATEGIES } = require('./strategies');
const { summarizeStrategy, pairedWinRate, pairedAdvantage } = require('./metrics');
const { GAME_STARTING_CASH } = require('../game/gameConstants');

const DEFAULT_BASE_SEED = 'v2-1-simulation-base-seed';
const ALL_STRATEGY_IDS = Object.keys(STRATEGIES);

function deriveRoundSeed(baseSeed, roundIndex) {
  return crypto.createHash('sha256').update(`${baseSeed}:round:${roundIndex}`).digest('hex');
}

function runBatch({
  rounds,
  strategyIds = ALL_STRATEGY_IDS,
  baseSeed = DEFAULT_BASE_SEED,
  observationMs = DEFAULT_OBSERVATION_MS,
  economy = true,
  startingCash = GAME_STARTING_CASH,
  onProgress = null
}) {
  if (!Number.isInteger(rounds) || rounds <= 0) {
    throw new Error(`simulation batch rounds must be a positive integer; received ${rounds}`);
  }
  const strategies = strategyIds.map((id) => {
    const strategy = STRATEGIES[id];
    if (!strategy) throw new Error(`unknown simulation strategy ${String(id)}`);
    return strategy;
  });

  const perStrategy = new Map(strategies.map((s) => [s.id, []]));
  for (let i = 0; i < rounds; i++) {
    const roundSeed = deriveRoundSeed(baseSeed, i);
    const env = createRoundEnvironment({ seed: roundSeed, economy });
    const context = createRoundContext(env, { observationMs });
    for (const strategy of strategies) {
      const result = runRound(context, strategy, { startingCash });
      result.roundIndex = i;
      result.roundSeed = roundSeed;
      perStrategy.get(strategy.id).push(result);
    }
    if (onProgress && (i + 1) % Math.max(1, Math.floor(rounds / 20)) === 0) {
      onProgress(i + 1, rounds);
    }
  }

  return {
    config: {
      rounds,
      strategyIds: strategies.map((s) => s.id),
      baseSeed,
      observationMs,
      economy,
      startingCash,
      roundDurationMs: DEFAULT_ROUND_DURATION_MS
    },
    perStrategy
  };
}

// Build the full machine-readable report, including the V2-1 gate verdict.
function buildReport(batch) {
  const { config, perStrategy } = batch;
  const strategies = {};
  for (const [id, results] of perStrategy) {
    strategies[id] = summarizeStrategy(results, config.startingCash);
  }

  const paired = {};
  for (const [aId, aResults] of perStrategy) {
    paired[aId] = {};
    for (const [bId, bResults] of perStrategy) {
      if (aId === bId) continue;
      paired[aId][bId] = {
        winRatePct: pairedWinRate(aResults, bResults),
        ...pairedAdvantage(aResults, bResults)
      };
    }
  }

  // ---- V2-1 gate -------------------------------------------------------
  const s = strategies;
  const gate = {};
  gate.dipBoomBeatsRandom = {
    target: '>= 70% paired win rate (or clearly justified nearby threshold)',
    winRatePct: paired.DIP_BOOM.RANDOM.winRatePct,
    medianDiff: paired.DIP_BOOM.RANDOM.medianDiff,
    pass: paired.DIP_BOOM.RANDOM.winRatePct >= 70
  };
  gate.positiveMedianSkillAdvantage = {
    medianDiff: paired.DIP_BOOM.RANDOM.medianDiff,
    pass: paired.DIP_BOOM.RANDOM.medianDiff > 0
  };
  gate.materiallyHigherMedianRoi = {
    dipBoomMedianRoi: s.DIP_BOOM.medianRoi,
    randomMedianRoi: s.RANDOM.medianRoi,
    pass: s.DIP_BOOM.medianRoi > s.RANDOM.medianRoi + 2
  };
  gate.lateSellerWorseThanGoodTiming = {
    lateSellerMedianRoi: s.LATE_SELLER.medianRoi,
    dipBoomMedianRoi: s.DIP_BOOM.medianRoi,
    lateSellerVsDipBoomWinRatePct: paired.DIP_BOOM.LATE_SELLER.winRatePct,
    pass: s.LATE_SELLER.medianRoi < s.DIP_BOOM.medianRoi && paired.DIP_BOOM.LATE_SELLER.winRatePct > 55
  };
  gate.holdForeverMeaningfullyRisky = {
    holdMedianRoi: s.HOLD_FOREVER.medianRoi,
    holdProfitableRoundPct: s.HOLD_FOREVER.profitableRoundPct,
    holdWorstMaxDrawdown: s.HOLD_FOREVER.worstMaxDrawdown,
    pass: s.HOLD_FOREVER.medianRoi < 0 && s.HOLD_FOREVER.profitableRoundPct < 25
  };
  gate.perfectInformationStrongest = {
    perfectMedianRoi: s.PERFECT_INFORMATION.medianRoi,
    bestLegalMedianRoi: Math.max(
      s.DIP_BOOM.medianRoi,
      s.PUBLIC_SIGNAL_EXPLOITER.medianRoi,
      s.SPAM.medianRoi,
      s.RANDOM.medianRoi,
      s.LATE_SELLER.medianRoi,
      s.HOLD_FOREVER.medianRoi
    ),
    pass: s.PERFECT_INFORMATION.medianRoi >= Math.max(
      s.DIP_BOOM.medianRoi,
      s.PUBLIC_SIGNAL_EXPLOITER.medianRoi,
      s.SPAM.medianRoi,
      s.RANDOM.medianRoi,
      s.LATE_SELLER.medianRoi,
      s.HOLD_FOREVER.medianRoi
    )
  };
  gate.noTrivialExploit = {
    exploiterMedianRoi: s.PUBLIC_SIGNAL_EXPLOITER.medianRoi,
    dipBoomMedianRoi: s.DIP_BOOM.medianRoi,
    perfectMedianRoi: s.PERFECT_INFORMATION.medianRoi,
    // A trivial unlimited-money exploit would let mechanical signal use
    // dwarf intended skilled play. Healthy: the exploiter stays in the same
    // league as DIP_BOOM (not systematically far above it) and strictly
    // below the perfect-information ceiling.
    pass: s.PUBLIC_SIGNAL_EXPLOITER.medianRoi <= Math.max(s.DIP_BOOM.medianRoi * 1.25, s.DIP_BOOM.medianRoi + 25)
      && s.PUBLIC_SIGNAL_EXPLOITER.medianRoi < s.PERFECT_INFORMATION.medianRoi
  };
  gate.pass = Object.values(gate).every((c) => c === gate.pass || c.pass !== false);

  return { config, gate, strategies, paired };
}

module.exports = {
  DEFAULT_BASE_SEED,
  ALL_STRATEGY_IDS,
  deriveRoundSeed,
  runBatch,
  buildReport
};
