// V2-2 multi-round Power study.
//
// Extends the SAME V2-1 simulator (identical seeded market paths, identical
// 15-second observation cadence, identical trade mechanics) to consecutive
// apocalypse rounds played under the SAME persistent Power rules as the
// live game. The Power cost, lazy reconciliation and position-limit logic
// are imported from game/powerDomain.js — the exact module the locked live
// buy path uses — never re-implemented here.
//
// Study shape: S independent seeded SEQUENCES of R consecutive 30-minute
// rounds each (default 40 x 24 ≈ 12 hours of continuous play per sequence).
// Every player trades every sequence with ONE persistent Power account on
// one continuous study clock (round r occupies [r*duration, (r+1)*duration)
// — regeneration simply continues across rollover, like the live wall
// clock). All players face identical round seeds in a sequence, so paired
// per-round comparisons stay valid.

const crypto = require('crypto');
const { createRoundEnvironment, DEFAULT_ROUND_DURATION_MS } = require('./roundEnvironment');
const { createRoundContext, runRound, DEFAULT_OBSERVATION_MS } = require('./engine');
const { STRATEGIES } = require('./strategies');
const { deriveRoundSeed } = require('./batch');
const { mean, median, summarizeStrategy, pairedWinRate, pairedAdvantage } = require('./metrics');
const powerDomain = require('../game/powerDomain');
const { GAME_STARTING_CASH } = require('../game/gameConstants');

const POWER_STUDY_BASE_SEED = 'v2-2-power-study-base-seed';

// The nine required study players. LATE_ENTRANT is a DIP_BOOM player who
// only starts trading halfway through every round (with whatever Power
// their account has stored); RETURNING plays two rounds then sits one out —
// the classic "back after a break" player.
const PLAYER_DEFS = [
  { id: 'RANDOM', strategyId: 'RANDOM' },
  { id: 'DIP_BOOM', strategyId: 'DIP_BOOM' },
  { id: 'SPAM', strategyId: 'SPAM' },
  { id: 'PUBLIC_SIGNAL_EXPLOITER', strategyId: 'PUBLIC_SIGNAL_EXPLOITER' },
  { id: 'CONSERVATIVE_POWER', strategyId: 'CONSERVATIVE_POWER' },
  { id: 'AGGRESSIVE_POWER', strategyId: 'AGGRESSIVE_POWER' },
  { id: 'SPLITTER', strategyId: 'SPLITTER' },
  { id: 'LATE_ENTRANT', strategyId: 'DIP_BOOM', joinFraction: 0.5 },
  { id: 'RETURNING', strategyId: 'DIP_BOOM', awayWhen: (roundIndex) => roundIndex % 3 === 1 }
];
const ALL_PLAYER_IDS = PLAYER_DEFS.map((p) => p.id);

function deriveSequenceSeed(baseSeed, sequenceIndex) {
  return crypto.createHash('sha256').update(`${baseSeed}:sequence:${sequenceIndex}`).digest('hex');
}

function runPowerStudy({
  sequences = 40,
  roundsPerSequence = 24,
  baseSeed = POWER_STUDY_BASE_SEED,
  observationMs = DEFAULT_OBSERVATION_MS,
  economy = true,
  startingCash = GAME_STARTING_CASH,
  playerIds = ALL_PLAYER_IDS,
  powerConfig: powerConfigOverrides = null,
  onProgress = null
} = {}) {
  if (!Number.isInteger(sequences) || sequences <= 0) throw new Error(`sequences must be a positive integer; received ${sequences}`);
  if (!Number.isInteger(roundsPerSequence) || roundsPerSequence <= 0) throw new Error(`roundsPerSequence must be a positive integer; received ${roundsPerSequence}`);

  const powerConfig = powerDomain.resolvePowerConfig(powerConfigOverrides || {});
  const players = playerIds.map((id) => {
    const def = PLAYER_DEFS.find((p) => p.id === id);
    if (!def) throw new Error(`unknown power-study player ${String(id)}`);
    return { ...def, strategy: STRATEGIES[def.strategyId] };
  });

  const records = new Map(players.map((p) => [p.id, []]));
  const totalSteps = sequences * roundsPerSequence;
  let stepsDone = 0;

  for (let s = 0; s < sequences; s++) {
    const sequenceSeed = deriveSequenceSeed(baseSeed, s);
    // One persistent Power account per player for the whole sequence.
    const accounts = new Map(players.map((p) => [p.id, { power: powerConfig.maxPower, updatedAtMs: 0 }]));

    for (let r = 0; r < roundsPerSequence; r++) {
      const roundSeed = deriveRoundSeed(sequenceSeed, r);
      const env = createRoundEnvironment({ seed: roundSeed, economy });
      const context = createRoundContext(env, { observationMs });
      const timeOffsetMs = r * env.durationMs;

      for (const player of players) {
        const account = accounts.get(player.id);
        if (player.awayWhen && player.awayWhen(r)) {
          // Away round: no trades, but the account keeps reconciling.
          records.get(player.id).push({
            playerId: player.id, strategyId: player.strategyId, sequenceIndex: s, roundIndex: r, absent: true,
            powerStart: powerDomain.reconcilePower({ storedPower: account.power, updatedAtMs: account.updatedAtMs, nowMs: timeOffsetMs, maxPower: powerConfig.maxPower, regenMsPerPoint: powerConfig.regenMsPerPoint }).power,
            powerEnd: powerDomain.reconcilePower({ storedPower: account.power, updatedAtMs: account.updatedAtMs, nowMs: timeOffsetMs + env.durationMs, maxPower: powerConfig.maxPower, regenMsPerPoint: powerConfig.regenMsPerPoint }).power
          });
          continue;
        }
        const result = runRound(context, player.strategy, {
          startingCash,
          powerAccount: account,
          maxPositions: powerConfig.maxOpenPositions,
          joinAtMs: player.joinFraction ? Math.floor(env.durationMs * player.joinFraction) : 0,
          powerConfig,
          timeOffsetMs
        });
        result.playerId = player.id;
        result.sequenceIndex = s;
        result.roundIndex = r;
        result.absent = false;
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
      startingCash,
      roundDurationMs: DEFAULT_ROUND_DURATION_MS,
      powerConfig,
      playerIds: players.map((p) => p.id)
    },
    records
  };
}

// ---------------------------------------------------------------------------
// Aggregation.
// ---------------------------------------------------------------------------
function summarizePlayer(records, startingCash) {
  const played = records.filter((r) => !r.absent);
  const starts = records.map((r) => r.powerStart);
  const ends = records.map((r) => r.powerEnd);

  // Consecutive rounds started under 10 Power (reported snapshot metric)
  // and consecutive MAJORITY-STARVED rounds (starved for over half the
  // round's ticks — the true "starved for hours" measure).
  let maxStarvedRun = 0;
  let currentRun = 0;
  let maxMajorityStarvedRun = 0;
  let currentMajorityRun = 0;
  for (const r of records) {
    if (r.powerStart < 10) {
      currentRun += 1;
      maxStarvedRun = Math.max(maxStarvedRun, currentRun);
    } else {
      currentRun = 0;
    }
    if (!r.absent && r.starvedTickPct > 50) {
      currentMajorityRun += 1;
      maxMajorityStarvedRun = Math.max(maxMajorityStarvedRun, currentMajorityRun);
    } else {
      currentMajorityRun = 0;
    }
  }

  const invariantViolations = played.reduce(
    (n, r) => n + (r.cashDrift > 0.01 ? 1 : 0) + (r.basisDrift > 0.01 ? 1 : 0) + r.positionLimitViolations,
    0
  );
  const powerSpent = played.reduce((n, r) => n + r.powerSpent, 0);
  const cashDeployed = played.reduce((n, r) => n + r.cashDeployed, 0);

  return {
    roundsPlayed: played.length,
    roundsTotal: records.length,
    powerAtRoundStart: { mean: round2(mean(starts)), median: round2(median(starts)) },
    powerAtRoundEnd: { mean: round2(mean(ends)), median: round2(median(ends)) },
    meanTickPower: round2(mean(played.map((r) => r.meanTickPower))),
    starvedTickPct: round2(mean(played.map((r) => r.starvedTickPct))),
    tradesPerRound: round2(mean(played.map((r) => r.trades))),
    attemptedBuysPerRound: round2(mean(played.map((r) => r.attemptedBuys))),
    executedBuysPerRound: round2(mean(played.map((r) => r.executedBuys))),
    opportunitiesSkippedByPower: played.reduce((n, r) => n + r.blockedByPower, 0),
    blockedByPowerPerRound: round2(mean(played.map((r) => r.blockedByPower))),
    positionLimitBlocked: played.reduce((n, r) => n + r.blockedByPosition, 0),
    powerSpentTotal: powerSpent,
    cashDeployedTotal: round2(cashDeployed),
    powerPerPoundDeployed: cashDeployed > 0 ? Math.round((powerSpent / cashDeployed) * 100000) / 100000 : 0,
    maxConsecutiveStarvedRoundStarts: maxStarvedRun,
    maxConsecutiveMajorityStarvedRounds: maxMajorityStarvedRun,
    invariantViolations,
    ...summarizeStrategy(played, startingCash)
  };
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

// Pair two players' played records by (sequenceIndex, roundIndex).
function pairRecords(aRecords, bRecords) {
  const bByKey = new Map(bRecords.filter((r) => !r.absent).map((r) => [`${r.sequenceIndex}:${r.roundIndex}`, r]));
  const a = [];
  const b = [];
  for (const ra of aRecords) {
    if (ra.absent) continue;
    const rb = bByKey.get(`${ra.sequenceIndex}:${ra.roundIndex}`);
    if (rb) {
      a.push(ra);
      b.push(rb);
    }
  }
  return [a, b];
}

function buildPowerReport(study) {
  const { config, records } = study;
  const players = {};
  for (const [id, recs] of records) players[id] = summarizePlayer(recs, config.startingCash);

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

  const p = players;
  const gate = {};

  // The V2-2 strategy gate is only defined over the full nine-player study;
  // partial player lists (tests, tuning probes) get metrics without a verdict.
  const fullRoster = ALL_PLAYER_IDS.every((id) => p[id] && paired[id]);
  if (!fullRoster) {
    gate.skipped = { reason: 'partial player roster — the V2-2 gate requires the full nine-player study', pass: null };
    gate.pass = null;
    return { config, gate, players, paired };
  }

  // 1. DIP-BOOM retains a clear advantage over RANDOM under Power rules.
  gate.dipBoomBeatsRandom = {
    target: '>= 70% paired win rate',
    winRatePct: paired.DIP_BOOM.RANDOM.winRatePct,
    medianDiff: paired.DIP_BOOM.RANDOM.medianDiff,
    pass: paired.DIP_BOOM.RANDOM.winRatePct >= 70 && paired.DIP_BOOM.RANDOM.medianDiff > 0
  };

  // 2. SPAM is constrained: DIP_BOOM beats it decisively and it cannot
  //    convert activity into profit.
  gate.spamConstrained = {
    target: 'DIP_BOOM beats SPAM >= 70% paired and SPAM median ROI < DIP_BOOM median ROI',
    dipBoomVsSpamWinRatePct: paired.DIP_BOOM.SPAM.winRatePct,
    spamMedianRoi: p.SPAM.medianRoi,
    dipBoomMedianRoi: p.DIP_BOOM.medianRoi,
    spamBlockedByPower: p.SPAM.opportunitiesSkippedByPower,
    pass: paired.DIP_BOOM.SPAM.winRatePct >= 70 && p.SPAM.medianRoi < p.DIP_BOOM.medianRoi
  };

  // 3. Splitting does not bypass Power. The structural proof is the flat
  //    per-order charge (game/powerDomain.js), and the paired measurement
  //    confirms the fragmentation attacker pays strictly MORE Power per
  //    pound deployed on identical market paths. (ROI is deliberately NOT
  //    compared here: after the first blocked/executed difference the two
  //    portfolios diverge, so the study SPLITTER is a different — and as it
  //    happens better — position SIZING policy, which is legal play, not a
  //    Power bypass. The exact same-trades fragmentation experiment is
  //    asserted deterministically in __tests__/v2-power-simulation.test.js.)
  gate.splittingDoesNotBypass = {
    target: 'splitter Power per £ deployed >= DIP_BOOM x 1.01 on identical paths',
    splitterPowerPerPound: p.SPLITTER.powerPerPoundDeployed,
    dipBoomPowerPerPound: p.DIP_BOOM.powerPerPoundDeployed,
    splitterMedianRoi: p.SPLITTER.medianRoi,
    dipBoomMedianRoi: p.DIP_BOOM.medianRoi,
    pass: p.SPLITTER.powerPerPoundDeployed >= p.DIP_BOOM.powerPerPoundDeployed * 1.01
  };

  // 4. Late entrants with stored Power still make meaningful moves.
  gate.lateEntrantMeaningful = {
    target: 'late entrant beats RANDOM >= 60% paired with positive median ROI',
    lateVsRandomWinRatePct: paired.LATE_ENTRANT.RANDOM.winRatePct,
    lateMedianRoi: p.LATE_ENTRANT.medianRoi,
    lateProfitableRoundPct: p.LATE_ENTRANT.profitableRoundPct,
    pass: paired.LATE_ENTRANT.RANDOM.winRatePct >= 60 && p.LATE_ENTRANT.medianRoi > 0
  };

  // 5. Power creates decisions rather than preventing play: skilled play
  //    still trades every round, Power binds somewhere (someone is blocked)
  //    but skilled players are not starved most of the time, and the
  //    returning player banks a real reserve while away.
  gate.powerCreatesDecisions = {
    target: 'DIP_BOOM >= 2 trades/round, DIP_BOOM starved < 40% of ticks, Power demonstrably binds aggressive/spam play, returning player banks reserve',
    dipBoomTradesPerRound: p.DIP_BOOM.tradesPerRound,
    dipBoomStarvedTickPct: p.DIP_BOOM.starvedTickPct,
    aggressiveBlockedByPower: p.AGGRESSIVE_POWER.opportunitiesSkippedByPower,
    spamBlockedByPower: p.SPAM.opportunitiesSkippedByPower,
    returningMeanStartPower: p.RETURNING.powerAtRoundStart.mean,
    pass: p.DIP_BOOM.tradesPerRound >= 2
      && p.DIP_BOOM.starvedTickPct < 40
      && (p.AGGRESSIVE_POWER.opportunitiesSkippedByPower > 0 || p.SPAM.opportunitiesSkippedByPower > 0)
      && p.RETURNING.powerAtRoundStart.mean >= 30
  };

  // 6. No prolonged starvation after one normal round. The gated measure is
  //    MAJORITY-starved rounds (unable to afford even the cheapest buy for
  //    over half a round's ticks — the true "starved for hours"): normal
  //    play must never hit one, and even the deliberately-depleting
  //    AGGRESSIVE player (the plan's documented trade-off) gets at most one
  //    in a row. Round-start snapshots and median start Power are reported
  //    as supporting evidence that a normal player reliably returns to
  //    meaningful Power.
  gate.noProlongedStarvation = {
    target: 'zero majority-starved rounds for normal play (<= 1 consecutive for the deliberate aggressive depleter); DIP_BOOM median round-start Power >= 10',
    dipBoomMajorityStarvedRun: p.DIP_BOOM.maxConsecutiveMajorityStarvedRounds,
    aggressiveMajorityStarvedRun: p.AGGRESSIVE_POWER.maxConsecutiveMajorityStarvedRounds,
    dipBoomMedianStartPower: p.DIP_BOOM.powerAtRoundStart.median,
    aggressiveMedianStartPower: p.AGGRESSIVE_POWER.powerAtRoundStart.median,
    dipBoomSnapshotMaxRun: p.DIP_BOOM.maxConsecutiveStarvedRoundStarts,
    aggressiveSnapshotMaxRun: p.AGGRESSIVE_POWER.maxConsecutiveStarvedRoundStarts,
    pass: p.DIP_BOOM.maxConsecutiveMajorityStarvedRounds === 0
      && p.AGGRESSIVE_POWER.maxConsecutiveMajorityStarvedRounds <= 1
      && p.DIP_BOOM.powerAtRoundStart.median >= 10
  };

  // 7. Cost basis / P&L stays correct through repeated rounds.
  gate.costBasisCorrect = {
    target: 'zero cash/basis accounting drift and zero position-limit violations across all rounds',
    invariantViolations: Object.values(players).reduce((n, pl) => n + pl.invariantViolations, 0),
    pass: Object.values(players).every((pl) => pl.invariantViolations === 0)
  };

  // 8. The position limit is real: it was exercised (aggressive/spam hit it)
  //    and never violated.
  gate.positionLimitReal = {
    target: 'limit exercised by at least one player, zero violations',
    aggressiveBlocked: p.AGGRESSIVE_POWER.positionLimitBlocked,
    spamBlocked: p.SPAM.positionLimitBlocked,
    violations: Object.values(players).reduce((n, pl) => n + pl.invariantViolations, 0),
    pass: (p.AGGRESSIVE_POWER.positionLimitBlocked > 0 || p.SPAM.positionLimitBlocked > 0)
      && Object.values(players).every((pl) => pl.invariantViolations === 0)
  };

  gate.pass = Object.values(gate).every((c) => c === gate.pass || c.pass !== false);

  return { config, gate, players, paired };
}

module.exports = {
  POWER_STUDY_BASE_SEED,
  PLAYER_DEFS,
  ALL_PLAYER_IDS,
  deriveSequenceSeed,
  runPowerStudy,
  buildPowerReport
};
