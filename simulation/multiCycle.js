// SIM-18/19 (gameplay_build_plan.md Stage 13): the authoritative automated
// multi-cycle harness. Runs MANY accelerated, complete, deterministic
// apocalypse cycles through the SAME pure round environment
// (simulation/roundEnvironment.js) and engine (simulation/engine.js) the
// other studies use — there is no second market implementation here.
//
// Scenarios (all over the SAME deterministic per-cycle seeds):
//   * market   — no-trade market shape: index trajectory, peak, lifecycle
//                entry times, crash/rally episodes, collapse order/timing,
//                per-coin price/event paths, exact final £0 assertion.
//   * pressure — trading/bot shape: a fixed strategy roster plays each
//                cycle twice. Pass A on the no-tape environment records the
//                executed-trade tape (engine recordTrades); pass B rebuilds
//                the environment WITH that tape (one deterministic feedback
//                iteration — the SIM-11 bounded pressure path the live
//                pricing context computes from the persisted ledger) and
//                re-plays the roster, capturing pressure magnitudes, the
//                price-path divergence the tape caused, collapse-order
//                shift and per-strategy bot metrics.
//   * events   — event bias/variety analysis over the market cycles (coin
//                events are trade-independent, so this is a separate
//                analysis pass over the same deterministic cycles, not a
//                separate market).
//
// Determinism contract: identical options produce a byte-identical report
// (the CLI adds wall-clock runtimeMs as an explicitly separate field). No
// Math.random(), no clock, no database. A configurable number of cycles is
// captured TWICE (replay check) and the full per-cycle records compared —
// any drift is the deterministicReplayMismatch failure flag.
//
// One cycle is never a balance conclusion: flags/quality verdicts are
// computed over the whole aggregate with explicit thresholds (exported as
// DEFAULT_THRESHOLDS, carried into the report, tunable for Waves 6-7).

const crypto = require('crypto');
const {
  createRoundEnvironment,
  DEFAULT_ROUND_DURATION_MS,
  MARKET_EVALUATION_STEP_MS
} = require('./roundEnvironment');
const { createRoundContext, runRound, DEFAULT_OBSERVATION_MS } = require('./engine');
const { STRATEGIES } = require('./strategies');
const { mean, median } = require('./metrics');
const priceEngine = require('../game/priceEngine');
const { resolveSimulationConfig } = require('../game/simulationConfig');
const { GAME_STARTING_CASH } = require('../game/gameConstants');

const MULTI_CYCLE_BASE_SEED = 'sim18-multi-cycle-base-seed';

// Scenario ids. 'market' always runs (every other analysis consumes its
// per-cycle records); 'pressure' is the optional trading/bot feedback pass;
// 'events' is the event bias/variety analysis section over market cycles.
const SCENARIO_IDS = Object.freeze(['market', 'pressure', 'events']);

// Strategy roster for the pressure scenario: three active legal traders
// with distinct styles (skilled dip timing, noise, churn). Perfect/future
// information strategies are deliberately excluded — the tape must be
// something a live round could legally produce.
const PRESSURE_STRATEGY_IDS = Object.freeze(['DIP_BOOM', 'RANDOM', 'SPAM']);

// Quality-flag thresholds. Starting values for Waves 6-7 balancing — every
// value is carried into the report so a run is self-describing. Fractions
// are plain numbers; times are milliseconds; pct fields are 0-100.
const DEFAULT_THRESHOLDS = Object.freeze({
  // prematureMassCollapse: a cycle is premature when at least this fraction
  // of coins died NATURALLY before this cycle-progress fraction...
  prematureCollapseCoinFraction: 0.5,
  prematureCollapseProgressCap: 0.5,
  // ...and the flag fails when premature cycles exceed this share.
  prematureCollapseCycleFraction: 0.02,
  // noMeaningfulRally: cycles with zero activated rally episodes.
  noRallyCycleFraction: 0.10,
  // lateCrashFullRecovery: of crashes whose window closed in DECLINE/
  // COLLAPSE, the share recovering at full strength (strength >= 1) must
  // stay below this ("every late crash fully recovers" fails).
  lateCrashFullRecoveryFraction: 0.95,
  // identicalCoinPaths: a cycle's mean pairwise divergence between
  // baseline-normalised coin paths below this epsilon reads as one graph.
  identicalPathDivergenceEpsilon: 0.02,
  identicalPathCycleFraction: 0.01,
  // unboundedCoinGrowth: no coin's peak may exceed its baseline by this
  // multiple (a generous bound — the plateau target caps the INDEX at 3x;
  // individual MOON/DEGEN swings legitimately reach far higher).
  maxPeakGrowthMultiple: 50,
  // negativeEventsKillEarlyGrowth: a cycle is flagged when the measured
  // index at this progress fraction sits below the starting index...
  earlyGrowthCheckProgress: 0.25,
  // ...and the flag fails when flagged cycles exceed this share.
  earlyGrowthDeclineCycleFraction: 0.25,
  // identicalCollapseOrderAcrossSeeds: share of cycle PAIRS with an
  // identical full collapse order.
  identicalCollapseOrderPairFraction: 0.05,
  // noPhaseEventVariety.
  minDistinctPhaseIds: 6,
  minDistinctEventNames: 8,
  zeroEventCycleFraction: 0.05,
  // latePeakInstantDeath (build plan Stage 13 list): the market peak lands
  // at or beyond this position (pct of the cycle) — rising almost until
  // the end then instantly dying.
  latePeakPositionPct: 95,
  latePeakCycleFraction: 0.05
});

function roundTo(value, decimals) {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

const round4 = (value) => roundTo(value, 4);
const round2 = (value) => roundTo(value, 2);

function deriveCycleSeed(baseSeed, cycleIndex) {
  return crypto.createHash('sha256').update(`${baseSeed}:multi-cycle:${cycleIndex}`).digest('hex');
}

// The lifecycle state in force at tMs from the environment's step
// trajectory (latest evaluation at or before tMs — the live lag).
function lifecycleStateAtFactory(steps) {
  return (tMs) => {
    let state = steps[0].lifecycleState;
    for (const step of steps) {
      if (step.atMs > tMs) break;
      state = step.lifecycleState;
    }
    return state;
  };
}

// Walk one coin's seeded crash-episode chain over the whole cycle,
// classifying each candidate with the lifecycle state in force at the END
// of its window (the lifecycle is monotone and the configured crash/rally
// probabilities are non-decreasing along it, so this is the strongest state
// the episode experienced — and exactly what the price engine's residuals
// reflect once the window has passed). Returns ACTIVATED episodes only,
// each with its crash magnitude and effective rally recovery strength
// resolved by the SAME priceEngine functions prices are computed with.
function walkActivatedEpisodes({ seed, coinId, durationMs, lifecycleStateAt, config }) {
  const cr = config.crashRally;
  const episodes = [];
  let cursor = 0;
  for (let index = 1; index <= 10000; index++) {
    const episode = priceEngine.drawCrashEpisode({ seed, coinId, episodeIndex: index, config });
    const start = cursor + episode.gapMs;
    const crashEnd = start + episode.crashDurationMs;
    const end = crashEnd + episode.rallyDurationMs;
    if (start >= durationMs) break;
    const state = lifecycleStateAt(Math.min(end, durationMs));
    const activated = episode.activationRoll < cr.crashProbability[state];
    if (activated) {
      const rallyActive = episode.rallyRoll < cr.rallyProbabilityAfterCrash[state];
      const strength = rallyActive ? priceEngine.resolveRecoveryStrength(episode, state, config) : 0;
      episodes.push({
        coinId,
        episodeIndex: index,
        startAtMs: start,
        endAtMs: Math.min(end, durationMs),
        lifecycleState: state,
        magnitude: round4(episode.magnitude),
        rallyActive,
        strength: round4(strength),
        recoveredFraction: round4(episode.magnitude * strength),
        late: state === 'DECLINE' || state === 'COLLAPSE'
      });
    }
    cursor = end; // the chain advances on drawn windows, never on activation
  }
  return episodes;
}

// Collapse order over ALL coins: natural deaths by instant, then coins the
// final safety rule forced (all at round end), coin id breaking ties.
function computeCollapseOrder(env, naturalCollapseAtMs) {
  return env.coins
    .slice()
    .sort((a, b) => {
      const aTime = naturalCollapseAtMs.has(a.coinId) ? naturalCollapseAtMs.get(a.coinId) : env.durationMs;
      const bTime = naturalCollapseAtMs.has(b.coinId) ? naturalCollapseAtMs.get(b.coinId) : env.durationMs;
      return aTime - bTime || a.coinId - b.coinId;
    })
    .map((coin) => coin.coinId);
}

// Kendall-style discordant-pair count between two total orders over the
// same coin ids (0 = identical order).
function discordantPairs(orderA, orderB) {
  const posB = new Map(orderB.map((coinId, index) => [coinId, index]));
  let discordant = 0;
  for (let i = 0; i < orderA.length; i++) {
    for (let j = i + 1; j < orderA.length; j++) {
      if (posB.get(orderA[i]) > posB.get(orderA[j])) discordant += 1;
    }
  }
  return discordant;
}

// Event aggregates for one coin's pure event stream. Event modifiers may
// arrive as strings from the shared engine — parseFloat every one.
function summarizeEvents(events) {
  let positiveCount = 0;
  let negativeCount = 0;
  let positiveTotal = 0;
  let negativeTotal = 0;
  const names = new Set();
  for (const event of events) {
    const modifier = typeof event.modifier === 'string' ? parseFloat(event.modifier) : event.modifier;
    names.add(event.name);
    if (event.direction === 'POSITIVE') {
      positiveCount += 1;
      positiveTotal += modifier;
    } else {
      negativeCount += 1;
      negativeTotal += modifier;
    }
  }
  return {
    eventCount: events.length,
    positiveEventCount: positiveCount,
    negativeEventCount: negativeCount,
    positiveEventTotal: roundTo(positiveTotal, 6),
    negativeEventTotal: roundTo(negativeTotal, 6),
    eventNames: [...names].sort()
  };
}

// ---------------------------------------------------------------------------
// Per-cycle capture.
// ---------------------------------------------------------------------------

// The MARKET scenario record for one cycle: complete market shape, per-coin
// paths and events, collapse timing/order, and the exact final £0 survivor
// assertion. Pure; identical seed -> identical record.
function captureMarketCycle({ seed, cycleIndex, economy, config, thresholds }) {
  const env = createRoundEnvironment({ seed, economy });
  const durationMs = env.durationMs;
  const diagnostics = env.gameplayDiagnostics();
  const { steps, phases, naturalCollapseAtMs, forcedSafetyCoinIds, coinEventsByCoin } = diagnostics;
  const lifecycleStateAt = lifecycleStateAtFactory(steps);

  // --- Market index trajectory (the environment's measured steps) ---
  const startingIndex = steps[0].index;
  let peakIndex = -Infinity;
  let peakAtMs = 0;
  for (const step of steps) {
    if (step.index > peakIndex) {
      peakIndex = step.index;
      peakAtMs = step.atMs;
    }
  }
  const finalMeasuredIndex = steps[steps.length - 1].index;
  let firstPlateauAtMs = null;
  let firstDeclineAtMs = null;
  for (const step of steps) {
    if (firstPlateauAtMs === null && step.lifecycleState === 'PLATEAU') firstPlateauAtMs = step.atMs;
    if (firstDeclineAtMs === null && step.lifecycleState === 'DECLINE') firstDeclineAtMs = step.atMs;
  }
  const earlyCheckStep = steps[Math.min(steps.length - 1, Math.round(thresholds.earlyGrowthCheckProgress * (steps.length - 1)))];
  const earlyIndex = earlyCheckStep.index;

  // --- Exact final £0 survivor assertion (gameplay_changes.md §22) ---
  // Every coin dead at round end; final market value over survivors is
  // exactly 0 (dead coins price at exactly £0; the survivor index of an
  // empty set is exactly 0).
  let survivorCount = 0;
  let finalMarketValue = 0;
  for (const coin of env.coins) {
    if (!env.isDead(coin.coinId, durationMs)) survivorCount += 1;
    finalMarketValue += env.priceAt(coin.coinId, durationMs);
  }
  finalMarketValue = round4(finalMarketValue);

  // --- Crash/rally episodes (activated only), per coin ---
  const episodes = [];
  for (const coin of env.coins) {
    episodes.push(...walkActivatedEpisodes({ seed, coinId: coin.coinId, durationMs, lifecycleStateAt, config }));
  }
  const rallies = episodes.filter((episode) => episode.rallyActive && episode.strength > 0);
  const lateCrashes = episodes.filter((episode) => episode.late);
  const lateCrashFullRecoveries = lateCrashes.filter((episode) => episode.strength >= 1);

  // --- Collapse timing/order ---
  const collapseOrder = computeCollapseOrder(env, naturalCollapseAtMs);
  const naturalTimes = [...naturalCollapseAtMs.values()].sort((a, b) => a - b);
  const firstCollapseAtMs = naturalTimes.length > 0 ? naturalTimes[0] : null;
  const finalNaturalCollapseAtMs = naturalTimes.length > 0 ? naturalTimes[naturalTimes.length - 1] : null;
  const collapseSpreadMs = naturalTimes.length > 1 ? naturalTimes[naturalTimes.length - 1] - naturalTimes[0] : 0;

  // --- Per-coin paths at the market evaluation cadence (the same 30s
  // cadence the live writer persists at) + per-coin events ---
  const sampleTimes = steps.map((step) => step.atMs);
  const coins = [];
  const normalizedPaths = [];
  let peakGrowthMultiple = 0;
  const allEventNames = new Set();
  for (const coin of env.coins) {
    const naturalAtMs = naturalCollapseAtMs.has(coin.coinId) ? naturalCollapseAtMs.get(coin.coinId) : null;
    const prices = sampleTimes.map((t) => env.priceAt(coin.coinId, t));
    let peakPrice = coin.baselinePrice;
    let minPricePreCollapse = coin.baselinePrice;
    for (let i = 0; i < sampleTimes.length; i++) {
      const t = sampleTimes[i];
      if (naturalAtMs !== null && t >= naturalAtMs) continue; // pre-collapse only
      const price = prices[i];
      if (price > peakPrice) peakPrice = price;
      if (price < minPricePreCollapse) minPricePreCollapse = price;
    }
    const events = summarizeEvents(coinEventsByCoin.get(coin.coinId) || []);
    for (const name of events.eventNames) allEventNames.add(name);
    peakGrowthMultiple = Math.max(peakGrowthMultiple, peakPrice / coin.baselinePrice);
    normalizedPaths.push(prices.map((price) => price / coin.baselinePrice));
    coins.push({
      coinId: coin.coinId,
      symbol: coin.symbol,
      startingPrice: coin.baselinePrice,
      peakPrice,
      minPricePreCollapse,
      eventCount: events.eventCount,
      positiveEventCount: events.positiveEventCount,
      negativeEventCount: events.negativeEventCount,
      positiveEventTotal: events.positiveEventTotal,
      negativeEventTotal: events.negativeEventTotal,
      // null when the harness's final safety rule had to force the collapse
      // (the coin never died naturally); otherwise the natural instant.
      collapseAtMs: naturalAtMs
    });
  }

  // Mean pairwise divergence between baseline-normalised coin paths (0 =
  // every coin drew the same graph).
  let divergenceSum = 0;
  let divergencePairs = 0;
  for (let i = 0; i < normalizedPaths.length; i++) {
    for (let j = i + 1; j < normalizedPaths.length; j++) {
      let pairSum = 0;
      for (let k = 0; k < sampleTimes.length; k++) {
        pairSum += Math.abs(normalizedPaths[i][k] - normalizedPaths[j][k]);
      }
      divergenceSum += pairSum / sampleTimes.length;
      divergencePairs += 1;
    }
  }
  const pathDivergence = divergencePairs > 0 ? divergenceSum / divergencePairs : 0;

  // --- Cycle event + phase totals ---
  let eventCount = 0;
  let positiveEventCount = 0;
  let negativeEventCount = 0;
  let positiveEventTotal = 0;
  let negativeEventTotal = 0;
  for (const coin of coins) {
    eventCount += coin.eventCount;
    positiveEventCount += coin.positiveEventCount;
    negativeEventCount += coin.negativeEventCount;
    positiveEventTotal += coin.positiveEventTotal;
    negativeEventTotal += coin.negativeEventTotal;
  }
  const phaseIds = [...new Set(phases.map((phase) => phase.phase))].sort();

  return {
    cycleIndex,
    seed,
    market: {
      startingIndex,
      peakIndex,
      peakAtMs,
      peakPositionPct: round2((peakAtMs / durationMs) * 100),
      finalMeasuredIndex,
      finalMarketValue,
      survivorCount,
      earlyIndex,
      earlyProgressPct: round2(thresholds.earlyGrowthCheckProgress * 100),
      crashCount: episodes.length,
      rallyCount: rallies.length,
      largestCrashPct: episodes.length > 0 ? round2(Math.max(...episodes.map((episode) => episode.magnitude)) * 100) : 0,
      largestRallyPct: rallies.length > 0 ? round2(Math.max(...rallies.map((episode) => episode.recoveredFraction)) * 100) : 0,
      lateCrashCount: lateCrashes.length,
      lateCrashFullRecoveryCount: lateCrashFullRecoveries.length,
      firstPlateauAtMs,
      firstDeclineAtMs,
      collapseOrder,
      firstCollapseAtMs,
      finalCollapseAtMs: durationMs,
      finalNaturalCollapseAtMs,
      collapseSpreadMs,
      forcedSafetyCoinIds: forcedSafetyCoinIds.slice().sort((a, b) => a - b),
      eventCount,
      positiveEventCount,
      negativeEventCount,
      positiveEventTotal: roundTo(positiveEventTotal, 6),
      negativeEventTotal: roundTo(negativeEventTotal, 6),
      phaseIds,
      eventNames: [...allEventNames].sort(),
      pathDivergence: round4(pathDivergence),
      peakGrowthMultiple: round4(peakGrowthMultiple)
    },
    coins
  };
}

// The PRESSURE scenario record for one cycle: two-pass deterministic
// trade-tape feedback with the fixed legal strategy roster. Pass A plays
// the no-tape environment and records executed trades; pass B rebuilds the
// environment WITH the combined tape and re-plays, measuring the bounded
// pressure the tape produced, the price-path divergence it caused, the
// collapse-order shift, and per-strategy bot metrics on the fed-back path.
function capturePressureCycle({ seed, economy, observationMs, startingCash, marketRecord }) {
  const strategies = PRESSURE_STRATEGY_IDS.map((id) => STRATEGIES[id]);

  // Pass A: strategies trade the no-tape environment; their executed trades
  // become the cycle's static tape (the headless round ledger).
  const envA = createRoundEnvironment({ seed, economy });
  const contextA = createRoundContext(envA, { observationMs });
  const tape = [];
  for (const strategy of strategies) {
    const result = runRound(contextA, strategy, { startingCash, recordTrades: true });
    tape.push(...result.executedTape);
  }
  tape.sort((a, b) => a.atMs - b.atMs || a.coinId - b.coinId || (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));

  // Pass B: the SAME cycle seed with the tape wired into pricing.
  const envB = createRoundEnvironment({ seed, economy, trades: tape });
  const contextB = createRoundContext(envB, { observationMs });
  const players = {};
  for (const strategy of strategies) {
    const result = runRound(contextB, strategy, { startingCash });
    players[strategy.id] = {
      finalCash: result.finalCash,
      roi: result.roi,
      profitable: result.profitable,
      trades: result.trades,
      executedBuys: result.executedBuys,
      executedSells: result.executedSells
    };
  }

  // Pressure magnitude over the fed-back path (per coin, per evaluation
  // instant — the modifier the live pricing context would compose).
  let pressureSum = 0;
  let pressureSamples = 0;
  let maxAbsPressure = 0;
  for (let t = 0; t <= envB.durationMs; t += MARKET_EVALUATION_STEP_MS) {
    for (const coin of envB.coins) {
      const modifier = Math.abs(envB.pricingInputsAt(coin.coinId, t).pressureModifier);
      pressureSum += modifier;
      pressureSamples += 1;
      if (modifier > maxAbsPressure) maxAbsPressure = modifier;
    }
  }

  // Price-path divergence the tape caused (live coins only, both paths).
  let divergenceSum = 0;
  let divergenceSamples = 0;
  for (let t = 0; t <= envB.durationMs; t += MARKET_EVALUATION_STEP_MS) {
    for (const coin of envB.coins) {
      if (envA.isDead(coin.coinId, t) || envB.isDead(coin.coinId, t)) continue;
      const priceA = envA.priceAt(coin.coinId, t);
      const priceB = envB.priceAt(coin.coinId, t);
      if (priceA > 0) {
        divergenceSum += Math.abs(priceB - priceA) / priceA;
        divergenceSamples += 1;
      }
    }
  }

  // Collapse-order shift: discordant pairs between the no-trade order and
  // the fed-back order (natural collapses; both environments share the same
  // safety rule at round end).
  const orderB = computeCollapseOrder(envB, envB.gameplayDiagnostics().naturalCollapseAtMs);
  const orderShift = discordantPairs(marketRecord.market.collapseOrder, orderB);

  let buyNotional = 0;
  let sellNotional = 0;
  for (const entry of tape) {
    if (entry.type === 'BUY') buyNotional = round2(buyNotional + entry.notional);
    else sellNotional = round2(sellNotional + entry.notional);
  }

  return {
    tapeEntries: tape.length,
    buyNotional,
    sellNotional,
    meanAbsPressureModifier: pressureSamples > 0 ? roundTo(pressureSum / pressureSamples, 6) : 0,
    maxAbsPressureModifier: roundTo(maxAbsPressure, 6),
    priceDivergencePct: divergenceSamples > 0 ? round2((divergenceSum / divergenceSamples) * 100) : 0,
    collapseOrderShift: orderShift,
    players
  };
}

// ---------------------------------------------------------------------------
// Multi-cycle run + report.
// ---------------------------------------------------------------------------

function runMultiCycle({
  cycles,
  baseSeed = MULTI_CYCLE_BASE_SEED,
  observationMs = DEFAULT_OBSERVATION_MS,
  economy = true,
  scenarios = ['market', 'pressure', 'events'],
  startingCash = GAME_STARTING_CASH,
  replayCycles = null,
  onProgress = null
} = {}) {
  if (!Number.isInteger(cycles) || cycles <= 0) {
    throw new Error(`multi-cycle harness cycles must be a positive integer; received ${cycles}`);
  }
  if (!Number.isInteger(observationMs) || observationMs <= 0) {
    throw new Error(`multi-cycle harness observationMs must be a positive integer; received ${observationMs}`);
  }
  if (!Array.isArray(scenarios) || scenarios.length === 0) {
    throw new Error('multi-cycle harness scenarios must be a non-empty array');
  }
  for (const scenario of scenarios) {
    if (!SCENARIO_IDS.includes(scenario)) {
      throw new Error(`unknown multi-cycle scenario ${String(scenario)}; expected a subset of ${SCENARIO_IDS.join(', ')}`);
    }
  }
  const config = resolveSimulationConfig();
  const thresholds = DEFAULT_THRESHOLDS;
  const withPressure = scenarios.includes('pressure');
  // The replay check re-captures whole cycles from scratch and compares the
  // complete records; default min(10, cycles) keeps smoke batches fast.
  const replayCount = replayCycles === null ? Math.min(10, cycles) : replayCycles;
  if (!Number.isInteger(replayCount) || replayCount < 0 || replayCount > cycles) {
    throw new Error(`multi-cycle harness replayCycles must be an integer in [0, cycles]; received ${replayCount}`);
  }

  const captureOne = (cycleIndex) => {
    const seed = deriveCycleSeed(baseSeed, cycleIndex);
    const record = captureMarketCycle({ seed, cycleIndex, economy, config, thresholds });
    if (withPressure) {
      record.pressure = capturePressureCycle({ seed, economy, observationMs, startingCash, marketRecord: record });
    }
    return record;
  };

  const records = [];
  for (let i = 0; i < cycles; i++) {
    records.push(captureOne(i));
    if (onProgress && (i + 1) % Math.max(1, Math.floor(cycles / 20)) === 0) {
      onProgress(i + 1, cycles);
    }
  }

  // Deterministic replay check: re-capture the first replayCount cycles
  // from scratch and deep-compare the full per-cycle records.
  const mismatches = [];
  for (let i = 0; i < replayCount; i++) {
    const replayed = captureOne(i);
    if (JSON.stringify(replayed) !== JSON.stringify(records[i])) mismatches.push(i);
  }

  return {
    config: {
      cycles,
      baseSeed,
      observationMs,
      economy,
      scenarios: scenarios.slice(),
      pressureStrategyIds: PRESSURE_STRATEGY_IDS.slice(),
      startingCash,
      replayCycles: replayCount,
      roundDurationMs: DEFAULT_ROUND_DURATION_MS,
      evaluationStepMs: MARKET_EVALUATION_STEP_MS
    },
    thresholds: { ...thresholds },
    cycles: records,
    replay: { cyclesChecked: replayCount, mismatches }
  };
}

function stats(values, decimals = 2) {
  return {
    mean: roundTo(mean(values), decimals),
    median: roundTo(median(values), decimals),
    min: roundTo(Math.min(...values), decimals),
    max: roundTo(Math.max(...values), decimals)
  };
}

// Pure flag evaluation over precomputed aggregates — the unit-testable
// heart of the quality gate. Each flag carries its measured values, the
// threshold it was judged against, and pass. The verdict requires every
// flag to pass.
function evaluateFlags(aggregates, thresholds) {
  const t = thresholds;
  const flags = {};

  flags.prematureMassCollapse = {
    measured: { cycles: aggregates.prematureCollapseCycles, totalCycles: aggregates.totalCycles },
    threshold: `premature cycles (>= ${t.prematureCollapseCoinFraction * 100}% of coins naturally dead before ${t.prematureCollapseProgressCap * 100}% progress) must be <= ${t.prematureCollapseCycleFraction * 100}% of cycles`,
    pass: aggregates.totalCycles > 0 && aggregates.prematureCollapseCycles / aggregates.totalCycles <= t.prematureCollapseCycleFraction
  };

  flags.noMeaningfulRally = {
    measured: { cycles: aggregates.noRallyCycles, totalCycles: aggregates.totalCycles },
    threshold: `cycles with zero activated rallies must be <= ${t.noRallyCycleFraction * 100}% of cycles`,
    pass: aggregates.totalCycles > 0 && aggregates.noRallyCycles / aggregates.totalCycles <= t.noRallyCycleFraction
  };

  flags.lateCrashFullRecovery = {
    measured: { lateCrashes: aggregates.lateCrashes, fullRecoveries: aggregates.lateCrashFullRecoveries },
    threshold: `of late (DECLINE/COLLAPSE-era) crashes, full recoveries must stay below ${t.lateCrashFullRecoveryFraction * 100}% (late crashes must not fully recover every time)`,
    pass: aggregates.lateCrashes === 0
      || aggregates.lateCrashFullRecoveries / aggregates.lateCrashes < t.lateCrashFullRecoveryFraction
  };

  flags.identicalCoinPaths = {
    measured: { cycles: aggregates.identicalPathCycles, totalCycles: aggregates.totalCycles },
    threshold: `cycles with mean pairwise normalised-path divergence < ${t.identicalPathDivergenceEpsilon} must be <= ${t.identicalPathCycleFraction * 100}% of cycles`,
    pass: aggregates.totalCycles > 0 && aggregates.identicalPathCycles / aggregates.totalCycles <= t.identicalPathCycleFraction
  };

  flags.unboundedCoinGrowth = {
    measured: { maxPeakGrowthMultiple: aggregates.maxPeakGrowthMultiple },
    threshold: `no coin peak may exceed ${t.maxPeakGrowthMultiple}x its baseline`,
    pass: aggregates.maxPeakGrowthMultiple <= t.maxPeakGrowthMultiple
  };

  flags.positiveEventsOverwhelming = {
    measured: {
      positiveEventTotal: aggregates.positiveEventTotal,
      negativeEventTotal: aggregates.negativeEventTotal
    },
    threshold: 'summed positive event modifiers must stay strictly below summed |negative| modifiers (the required long-term negative bias)',
    pass: aggregates.positiveEventTotal < Math.abs(aggregates.negativeEventTotal)
  };

  flags.negativeEventsKillEarlyGrowth = {
    measured: { cycles: aggregates.earlyDeclineCycles, totalCycles: aggregates.totalCycles },
    threshold: `cycles below their starting index at ${t.earlyGrowthCheckProgress * 100}% progress must be <= ${t.earlyGrowthDeclineCycleFraction * 100}% of cycles`,
    pass: aggregates.totalCycles > 0 && aggregates.earlyDeclineCycles / aggregates.totalCycles <= t.earlyGrowthDeclineCycleFraction
  };

  flags.identicalCollapseOrderAcrossSeeds = {
    measured: { identicalOrderPairPct: aggregates.identicalCollapseOrderPairPct },
    threshold: `cycle pairs with an identical full collapse order must be <= ${t.identicalCollapseOrderPairFraction * 100}% of pairs`,
    pass: aggregates.identicalCollapseOrderPairPct <= t.identicalCollapseOrderPairFraction * 100
  };

  flags.nonzeroFinalMarketValue = {
    measured: { cycles: aggregates.nonzeroFinalValueCycles, totalCycles: aggregates.totalCycles },
    threshold: 'every cycle must end with final market value exactly £0 and zero survivors',
    pass: aggregates.nonzeroFinalValueCycles === 0
  };

  flags.deterministicReplayMismatch = {
    measured: { mismatches: aggregates.replayMismatches, cyclesChecked: aggregates.replayCyclesChecked },
    threshold: 're-captured cycles must be byte-identical to the first capture',
    pass: aggregates.replayMismatches === 0
  };

  flags.noPhaseEventVariety = {
    measured: {
      distinctPhaseIds: aggregates.distinctPhaseIds.length,
      distinctEventNames: aggregates.distinctEventNames.length,
      zeroEventCycles: aggregates.zeroEventCycles
    },
    threshold: `at least ${t.minDistinctPhaseIds} distinct phases, at least ${t.minDistinctEventNames} distinct event names, zero-event cycles <= ${t.zeroEventCycleFraction * 100}%`,
    pass: aggregates.distinctPhaseIds.length >= t.minDistinctPhaseIds
      && aggregates.distinctEventNames.length >= t.minDistinctEventNames
      && (aggregates.totalCycles === 0 || aggregates.zeroEventCycles / aggregates.totalCycles <= t.zeroEventCycleFraction)
  };

  flags.latePeakInstantDeath = {
    measured: { cycles: aggregates.latePeakCycles, totalCycles: aggregates.totalCycles },
    threshold: `cycles peaking at/after ${t.latePeakPositionPct}% of the cycle must be <= ${t.latePeakCycleFraction * 100}% of cycles`,
    pass: aggregates.totalCycles > 0 && aggregates.latePeakCycles / aggregates.totalCycles <= t.latePeakCycleFraction
  };

  const pass = Object.values(flags).every((flag) => flag.pass);
  return { flags, verdict: { pass } };
}

// Aggregate the run into the machine-readable report: raw per-cycle records
// plus per-scenario aggregates, explicit thresholds, failure flags and the
// overall verdict. Deterministic fields only — the CLI stamps wall-clock
// runtime separately.
function buildMultiCycleReport(run) {
  const { config, thresholds, cycles: records, replay } = run;
  const markets = records.map((record) => record.market);
  const totalCycles = records.length;

  // ---- aggregates feeding the flags ------------------------------------
  const distinctPhaseIds = new Set();
  const distinctEventNames = new Set();
  let prematureCollapseCycles = 0;
  let noRallyCycles = 0;
  let identicalPathCycles = 0;
  let earlyDeclineCycles = 0;
  let latePeakCycles = 0;
  let nonzeroFinalValueCycles = 0;
  let zeroEventCycles = 0;
  let lateCrashes = 0;
  let lateCrashFullRecoveries = 0;
  let positiveEventTotal = 0;
  let negativeEventTotal = 0;
  let maxPeakGrowthMultiple = 0;
  for (const record of records) {
    const market = record.market;
    for (const phaseId of market.phaseIds) distinctPhaseIds.add(phaseId);
    for (const name of market.eventNames) distinctEventNames.add(name);
    const naturalDeaths = market.collapseOrder.length - market.forcedSafetyCoinIds.length;
    const prematureDeaths = record.coins.filter((coin) => (
      coin.collapseAtMs !== null
      && coin.collapseAtMs < thresholds.prematureCollapseProgressCap * config.roundDurationMs
    )).length;
    if (naturalDeaths > 0 && prematureDeaths >= thresholds.prematureCollapseCoinFraction * market.collapseOrder.length) {
      prematureCollapseCycles += 1;
    }
    if (market.rallyCount === 0) noRallyCycles += 1;
    if (market.pathDivergence < thresholds.identicalPathDivergenceEpsilon) identicalPathCycles += 1;
    if (market.earlyIndex < market.startingIndex) earlyDeclineCycles += 1;
    if (market.peakPositionPct >= thresholds.latePeakPositionPct) latePeakCycles += 1;
    if (market.finalMarketValue !== 0 || market.survivorCount !== 0) nonzeroFinalValueCycles += 1;
    if (market.eventCount === 0) zeroEventCycles += 1;
    lateCrashes += market.lateCrashCount;
    lateCrashFullRecoveries += market.lateCrashFullRecoveryCount;
    positiveEventTotal += market.positiveEventTotal;
    negativeEventTotal += market.negativeEventTotal;
    if (market.peakGrowthMultiple > maxPeakGrowthMultiple) maxPeakGrowthMultiple = market.peakGrowthMultiple;
  }
  positiveEventTotal = roundTo(positiveEventTotal, 6);
  negativeEventTotal = roundTo(negativeEventTotal, 6);

  // Collapse-order variation across seeds: share of cycle PAIRS whose full
  // collapse order is identical.
  let identicalPairs = 0;
  let totalPairs = 0;
  for (let i = 0; i < markets.length; i++) {
    for (let j = i + 1; j < markets.length; j++) {
      totalPairs += 1;
      if (markets[i].collapseOrder.join(',') === markets[j].collapseOrder.join(',')) identicalPairs += 1;
    }
  }
  const identicalCollapseOrderPairPct = totalPairs > 0 ? round2((identicalPairs / totalPairs) * 100) : 0;

  const flagAggregates = {
    totalCycles,
    prematureCollapseCycles,
    noRallyCycles,
    identicalPathCycles,
    earlyDeclineCycles,
    latePeakCycles,
    nonzeroFinalValueCycles,
    zeroEventCycles,
    lateCrashes,
    lateCrashFullRecoveries,
    positiveEventTotal,
    negativeEventTotal,
    maxPeakGrowthMultiple: round4(maxPeakGrowthMultiple),
    identicalCollapseOrderPairPct,
    distinctPhaseIds: [...distinctPhaseIds].sort(),
    distinctEventNames: [...distinctEventNames].sort(),
    replayMismatches: replay.mismatches.length,
    replayCyclesChecked: replay.cyclesChecked
  };
  const { flags, verdict } = evaluateFlags(flagAggregates, thresholds);

  // ---- scenario sections ------------------------------------------------
  const marketSection = {
    cycles: totalCycles,
    startingIndex: stats(markets.map((m) => m.startingIndex)),
    peakIndex: stats(markets.map((m) => m.peakIndex)),
    peakPositionPct: stats(markets.map((m) => m.peakPositionPct)),
    crashCount: stats(markets.map((m) => m.crashCount)),
    rallyCount: stats(markets.map((m) => m.rallyCount)),
    largestCrashPct: stats(markets.map((m) => m.largestCrashPct)),
    largestRallyPct: stats(markets.map((m) => m.largestRallyPct)),
    collapseSpreadMs: stats(markets.map((m) => m.collapseSpreadMs), 0),
    firstCollapseAtMs: stats(markets.map((m) => (m.firstCollapseAtMs === null ? config.roundDurationMs : m.firstCollapseAtMs)), 0),
    forcedSafetyCollapses: {
      mean: round2(mean(markets.map((m) => m.forcedSafetyCoinIds.length))),
      max: Math.max(...markets.map((m) => m.forcedSafetyCoinIds.length))
    },
    pathDivergence: stats(markets.map((m) => m.pathDivergence), 4),
    peakGrowthMultiple: stats(markets.map((m) => m.peakGrowthMultiple), 4),
    firstPlateauAtMs: stats(markets.map((m) => (m.firstPlateauAtMs === null ? config.roundDurationMs : m.firstPlateauAtMs)), 0),
    firstDeclineAtMs: stats(markets.map((m) => (m.firstDeclineAtMs === null ? config.roundDurationMs : m.firstDeclineAtMs)), 0),
    collapseOrderVariation: {
      identicalOrderPairPct: identicalCollapseOrderPairPct,
      pairs: totalPairs
    }
  };

  const eventsSection = {
    cycles: totalCycles,
    eventCount: stats(markets.map((m) => m.eventCount)),
    positiveEventCount: stats(markets.map((m) => m.positiveEventCount)),
    negativeEventCount: stats(markets.map((m) => m.negativeEventCount)),
    positiveEventTotal,
    negativeEventTotal,
    negativeToPositiveRatio: positiveEventTotal > 0 ? round4(Math.abs(negativeEventTotal) / positiveEventTotal) : null,
    distinctEventNames: [...distinctEventNames].sort(),
    distinctPhaseIds: [...distinctPhaseIds].sort(),
    zeroEventCycles
  };

  let pressureSection = null;
  if (config.scenarios.includes('pressure')) {
    const pressures = records.map((record) => record.pressure);
    const players = {};
    for (const strategyId of config.pressureStrategyIds) {
      const results = pressures.map((p) => p.players[strategyId]);
      players[strategyId] = {
        medianRoi: round2(median(results.map((r) => r.roi))),
        meanRoi: round2(mean(results.map((r) => r.roi))),
        profitableRoundPct: round2((results.filter((r) => r.profitable).length / results.length) * 100),
        meanTradesPerRound: round2(mean(results.map((r) => r.trades))),
        meanBuysPerRound: round2(mean(results.map((r) => r.executedBuys))),
        meanSellsPerRound: round2(mean(results.map((r) => r.executedSells)))
      };
    }
    pressureSection = {
      cycles: totalCycles,
      strategyIds: config.pressureStrategyIds.slice(),
      tapeEntries: stats(pressures.map((p) => p.tapeEntries), 0),
      buyNotional: stats(pressures.map((p) => p.buyNotional)),
      sellNotional: stats(pressures.map((p) => p.sellNotional)),
      meanAbsPressureModifier: stats(pressures.map((p) => p.meanAbsPressureModifier), 6),
      maxAbsPressureModifier: roundTo(Math.max(...pressures.map((p) => p.maxAbsPressureModifier)), 6),
      priceDivergencePct: stats(pressures.map((p) => p.priceDivergencePct)),
      collapseOrderShift: stats(pressures.map((p) => p.collapseOrderShift), 2),
      players
    };
  }

  return {
    config,
    thresholds,
    scenarios: {
      market: marketSection,
      pressure: pressureSection,
      events: eventsSection
    },
    flags,
    verdict,
    replay: { cyclesChecked: replay.cyclesChecked, mismatches: replay.mismatches.slice() },
    cycles: records
  };
}

module.exports = {
  MULTI_CYCLE_BASE_SEED,
  SCENARIO_IDS,
  PRESSURE_STRATEGY_IDS,
  DEFAULT_THRESHOLDS,
  deriveCycleSeed,
  discordantPairs,
  captureMarketCycle,
  capturePressureCycle,
  runMultiCycle,
  evaluateFlags,
  buildMultiCycleReport
};
