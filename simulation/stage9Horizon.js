// Persistent-market Stage 9 S9-04: deterministic roster-churn horizon harness.
//
// Proves permanent death (S9-01) + authored delayed replacement (S9-02/S9-03)
// over a long-lived injected-time world WITHOUT wall-clock waits.
//
// This is a pure deterministic DOMAIN simulation of the writer+reconcile
// loop. It consumes the real Stage 9 modules:
//   * game/persistentPricing.js          — living pricing + condition advance
//   * game/persistentCoinDeath.js        — authoritative death decision
//   * game/replacementPool.js            — authored roster / delay / target
//   * game/marketDirector.js             — default persistent environment
//
// It deliberately does NOT touch PostgreSQL. Persistence / restart /
// idempotency / trade-reject gates live in
// __tests__/stage9-simulation-gates.test.js and hit coins_test with the
// real marketSimulator.updateAllPrices({nowMs}) +
// reconcilePersistentReplacements({nowMs}).
//
// Production defaults are NOT retuned here. If default death balancing
// fails a quality gate, that is a Stage 9 block — not a cue to weaken
// riskThreshold.
//
// Usage: node simulation/stage9Horizon.js [--days N] [--cadence-minutes M]
//        [--seed S] [--delay-ms MS] [--provider director|neutral]
// Exits non-zero on quality-gate failure.

const persistentPricing = require('../game/persistentPricing');
const persistentCoinDeath = require('../game/persistentCoinDeath');
const replacementPool = require('../game/replacementPool');
const { createNeutralEnvironmentProvider, NEUTRAL_ENVIRONMENT } = require('../game/marketEnvironment');
const { createMarketDirectorProvider } = require('../game/marketDirector');
const { resolveSimulationConfig } = require('../game/simulationConfig');
const marketDomain = require('../game/marketDomain');

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

// Canonical opening roster — explicit archetypes, never silent MOON.
const CANONICAL_PERSISTENT_COINS = Object.freeze([
  Object.freeze({ coinId: 1, symbol: 'FTR', archetypeId: 'ZIP', reference: 0.10 }),
  Object.freeze({ coinId: 2, symbol: 'NVC', archetypeId: 'MOON', reference: 1.37 }),
  Object.freeze({ coinId: 3, symbol: 'BYT', archetypeId: 'RUG', reference: 0.12 }),
  Object.freeze({ coinId: 4, symbol: 'DGV', archetypeId: 'ZIP', reference: 0.10 }),
  Object.freeze({ coinId: 5, symbol: 'CYB', archetypeId: 'HODL', reference: 96.45 }),
  Object.freeze({ coinId: 6, symbol: 'BLN', archetypeId: 'BULL', reference: 43.46 }),
  Object.freeze({ coinId: 7, symbol: 'STF', archetypeId: 'MOON', reference: 3.91 }),
  Object.freeze({ coinId: 8, symbol: 'JDC', archetypeId: 'BULL', reference: 33.48 }),
  Object.freeze({ coinId: 9, symbol: 'MTC', archetypeId: 'DEGEN', reference: 0.10 }),
  Object.freeze({ coinId: 10, symbol: 'CZN', archetypeId: 'HODL', reference: 32.00 })
]);

function createEnvironmentProvider(id, { seed, originMs = 0 } = {}) {
  if (id === 'neutral') return createNeutralEnvironmentProvider();
  if (id === 'director') return createMarketDirectorProvider({ seed, originMs });
  throw new Error(`unknown environment provider ${JSON.stringify(id)} (expected 'neutral' or 'director')`);
}

function parseArgs(argv) {
  const args = {
    days: 30,
    cadenceMinutes: 60,
    seed: 'stage9-horizon-seed',
    delayMs: replacementPool.DEFAULT_REPLACEMENT_CONFIG.replacementDelayMs,
    provider: 'director'
  };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--days') args.days = Number(argv[++i]);
    else if (argv[i] === '--cadence-minutes') args.cadenceMinutes = Number(argv[++i]);
    else if (argv[i] === '--seed') args.seed = argv[++i];
    else if (argv[i] === '--delay-ms') args.delayMs = Number(argv[++i]);
    else if (argv[i] === '--provider') args.provider = argv[++i];
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!(args.days > 0) || !(args.cadenceMinutes > 0) || !(args.delayMs > 0)) {
    throw new Error('stage9 horizon days/cadenceMinutes/delayMs must be positive numbers');
  }
  return args;
}

function initialCoinState(coin, introducedAtMs) {
  return {
    condition: 0,
    structuralReference: coin.reference,
    peakReference: coin.reference,
    checkpoint: null,
    priceWindow: [],
    status: 'ALIVE',
    diedAt: null,
    introducedAtMs,
    lifetimeMs: 0,
    recoveryCount: 0,
    sawNegativeCondition: false,
    isReplacement: false,
    generation: 0,
    lastPrice: coin.reference,
    floorTouchesWhileAlive: 0
  };
}

function countActive(world) {
  return world.reduce((n, entry) => (entry.state.status === 'ALIVE' ? n + 1 : n), 0);
}

function authoredInsertedCount(world, authoredIds) {
  return world.reduce((n, entry) => (
    authoredIds.has(entry.coin.coinId) ? n + 1 : n
  ), 0);
}

// Mirror S9-03 reconcilePersistentReplacements domain rules in-memory:
// delay eligibility by count, one authored identity per pending eligible
// death, refill only up to targetActiveCount, never reuse historical ids.
function reconcileDomain({
  world,
  historicalIds,
  nowMs,
  replacementConfig,
  authoredIds,
  seed,
  events
}) {
  const targetActiveCount = replacementPool.getTargetActiveCount(replacementConfig);
  const replacementDelayMs = replacementPool.getReplacementDelayMs(replacementConfig);
  const eligibilityCutoffMs = nowMs - replacementDelayMs;

  const deadEntries = world.filter((entry) => entry.state.status === 'DEAD');
  const eligibleDeathCount = deadEntries.reduce((n, entry) => (
    entry.state.diedAt <= eligibilityCutoffMs ? n + 1 : n
  ), 0);
  const insertedAuthored = authoredInsertedCount(world, authoredIds);
  const pendingEligibleDeaths = Math.max(0, eligibleDeathCount - insertedAuthored);
  const activeBefore = countActive(world);
  const openSlots = Math.max(0, targetActiveCount - activeBefore);
  const insertCount = Math.min(openSlots, pendingEligibleDeaths);

  const inserted = [];
  for (let i = 0; i < insertCount; i += 1) {
    const definition = replacementPool.peekNextReplacement(historicalIds, replacementConfig);
    if (!definition) {
      throw new Error(
        `stage9 horizon: authored replacement pool exhausted with ${pendingEligibleDeaths - i} eligible death(s) still pending`
      );
    }
    const validated = replacementPool.validateReplacementDefinition(definition, {
      historicalIds
    });

    // Match S9-03: intro checkpoint frozen at the introduction instant with
    // NEUTRAL environment; subsequent writer ticks resume using the world
    // epoch origin (see stepAliveCoin).
    const checkpoint = persistentPricing.extractPersistentCheckpoint({
      seed,
      coinId: validated.coinId,
      archetypeId: validated.archetype,
      originMs: nowMs,
      nowMs,
      reference: validated.startingPrice,
      environment: NEUTRAL_ENVIRONMENT
    });

    const coin = {
      coinId: validated.coinId,
      symbol: validated.symbol,
      archetypeId: validated.archetype,
      reference: validated.startingPrice
    };
    const state = initialCoinState(coin, nowMs);
    state.isReplacement = true;
    state.generation = 1;
    state.checkpoint = checkpoint;
    state.priceWindow = [{ atMs: nowMs, price: validated.startingPrice }];
    state.lastPrice = validated.startingPrice;

    world.push({ coin, state });
    historicalIds.push(validated.coinId);
    inserted.push({
      coinId: validated.coinId,
      symbol: validated.symbol,
      archetype: validated.archetype,
      introducedAtMs: nowMs
    });
    events.replacements.push({
      coinId: validated.coinId,
      symbol: validated.symbol,
      archetype: validated.archetype,
      atMs: nowMs
    });
  }

  return {
    inserted,
    eligibleDeaths: eligibleDeathCount,
    pendingEligibleDeaths,
    activeBefore,
    activeAfter: activeBefore + inserted.length
  };
}

function stepAliveCoin({
  entry,
  seed,
  worldOriginMs,
  nowMs,
  cadenceMs,
  environment,
  config,
  events
}) {
  const { coin, state } = entry;

  const price = persistentPricing.persistentPriceAt({
    seed,
    coinId: coin.coinId,
    archetypeId: coin.archetypeId,
    originMs: worldOriginMs,
    nowMs,
    structuralReference: state.structuralReference,
    environment,
    checkpoint: state.checkpoint,
    config
  });
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(
      `stage9 horizon: coin ${coin.coinId} produced invalid living price ${String(price)} at ${nowMs}`
    );
  }

  const detail = persistentPricing.computePersistentPrice({
    seed,
    coinId: coin.coinId,
    archetypeId: coin.archetypeId,
    originMs: worldOriginMs,
    nowMs,
    structuralReference: state.structuralReference,
    environment,
    checkpoint: state.checkpoint,
    config
  });

  const windowMs = config.persistent.condition.recentReturnWindowMs;
  while (state.priceWindow.length > 0 && state.priceWindow[0].atMs < nowMs - windowMs) {
    state.priceWindow.shift();
  }
  const windowOpen = state.priceWindow.length > 0 ? state.priceWindow[0].price : price;
  const recentLogReturn = windowOpen > 0 ? Math.log(price / windowOpen) : 0;
  const drawdown = persistentPricing.computePeakDrawdown(state.peakReference, price);
  const logCommittedDamage = Math.log(detail.committedDamageFactor);
  const envNow = environment.environmentAt(nowMs);

  const nextCondition = persistentPricing.advanceCondition({
    condition: state.condition,
    archetypeId: coin.archetypeId,
    elapsedMs: cadenceMs,
    recentLogReturn,
    drawdownFromPeak: drawdown,
    logCommittedDamage,
    netEventModifier: 0,
    environment: envNow,
    config
  });
  const nextReference = persistentPricing.advanceStructuralReference({
    structuralReference: state.structuralReference,
    condition: state.condition,
    environment: envNow,
    elapsedMs: cadenceMs,
    config
  });
  const nextPeak = persistentPricing.advancePeakReference({
    peakReference: state.peakReference,
    price,
    elapsedMs: cadenceMs,
    config
  });
  const freshCheckpoint = persistentPricing.extractPersistentCheckpoint({
    seed,
    coinId: coin.coinId,
    archetypeId: coin.archetypeId,
    originMs: worldOriginMs,
    nowMs,
    reference: state.structuralReference,
    environment,
    stored: state.checkpoint,
    config
  });

  const recentChangePct = windowOpen > 0
    ? ((price - windowOpen) / windowOpen) * 100
    : 0;

  // Authoritative S9-01 decision — never inferred from the living floor.
  const deathDecision = persistentCoinDeath.decideAuthoritativePersistentDeath({
    seed,
    coinId: coin.coinId,
    archetypeId: coin.archetypeId,
    condition: nextCondition,
    phase: detail.phase,
    recentChangePct,
    nowMs,
    config
  });

  if (price === marketDomain.MIN_POSITIVE_PRICE) {
    state.floorTouchesWhileAlive += 1;
  }

  if (state.condition < -0.05) {
    state.sawNegativeCondition = true;
  }
  if (state.sawNegativeCondition && nextCondition > 0.05) {
    state.recoveryCount += 1;
    state.sawNegativeCondition = false;
    events.recoveries += 1;
  }

  state.priceWindow.push({ atMs: nowMs, price });
  state.condition = nextCondition;
  state.structuralReference = nextReference;
  state.peakReference = nextPeak;
  state.checkpoint = freshCheckpoint;
  state.lastPrice = price;
  state.lifetimeMs += cadenceMs;

  if (deathDecision.shouldDie) {
    // Living floor alone never kills: death requires the risk threshold.
    if (!(deathDecision.riskScore >= deathDecision.threshold)) {
      throw new Error(
        `stage9 horizon: death fired without risk crossing threshold (score=${deathDecision.riskScore}, threshold=${deathDecision.threshold})`
      );
    }
    state.status = 'DEAD';
    state.diedAt = nowMs;
    state.lastPrice = 0;
    events.deaths.push({
      coinId: coin.coinId,
      symbol: coin.symbol,
      archetype: coin.archetypeId,
      atMs: nowMs,
      riskScore: deathDecision.riskScore,
      threshold: deathDecision.threshold,
      reason: deathDecision.reason,
      isReplacement: state.isReplacement,
      lifetimeMs: state.lifetimeMs,
      priceAtDecision: price,
      floorTouch: price === marketDomain.MIN_POSITIVE_PRICE
    });
    return { died: true, price: 0 };
  }

  return { died: false, price };
}

function emptyMetrics() {
  return {
    originalDeaths: 0,
    replacementDeaths: 0,
    replacements: 0,
    recoveries: 0,
    minActive: Infinity,
    maxActive: -Infinity,
    finalActive: 0,
    originalSurvivors: 0,
    replacementSurvivors: 0,
    longestSurvivorMs: 0,
    duplicateIds: 0,
    earlyReplacementChurn: 0,
    minReplacementLifetimeMs: null,
    medianReplacementLifetimeMs: null,
    floorTouchesWhileAlive: 0,
    deathsOnFloor: 0,
    poolExhausted: false,
    durationMs: 0,
    steps: 0
  };
}

function finalizeMetrics(world, events, { durationMs, steps, earlyChurnMs }) {
  const metrics = emptyMetrics();
  metrics.durationMs = durationMs;
  metrics.steps = steps;
  metrics.recoveries = events.recoveries;
  metrics.replacements = events.replacements.length;

  const lifetimes = [];
  const ids = [];
  for (const entry of world) {
    ids.push(entry.coin.coinId);
    metrics.floorTouchesWhileAlive += entry.state.floorTouchesWhileAlive;
    if (entry.state.status === 'ALIVE') {
      metrics.finalActive += 1;
      if (entry.state.isReplacement) metrics.replacementSurvivors += 1;
      else metrics.originalSurvivors += 1;
      // Longest survivor is currently-ALIVE lifetime only — a dead coin is
      // not a survivor, even if it lived longer before dying.
      if (entry.state.lifetimeMs > metrics.longestSurvivorMs) {
        metrics.longestSurvivorMs = entry.state.lifetimeMs;
      }
    }
    if (entry.state.isReplacement && entry.state.status === 'DEAD') {
      lifetimes.push(entry.state.lifetimeMs);
    }
  }

  for (const death of events.deaths) {
    if (death.isReplacement) metrics.replacementDeaths += 1;
    else metrics.originalDeaths += 1;
    if (death.floorTouch) metrics.deathsOnFloor += 1;
  }

  metrics.duplicateIds = ids.length - new Set(ids).size;
  if (lifetimes.length > 0) {
    const sorted = lifetimes.slice().sort((a, b) => a - b);
    metrics.minReplacementLifetimeMs = sorted[0];
    metrics.medianReplacementLifetimeMs = sorted[Math.floor(sorted.length / 2)];
    metrics.earlyReplacementChurn = lifetimes.filter((ms) => ms < earlyChurnMs).length;
  }

  // Active roster envelope was tracked live; restore from events tracker.
  metrics.minActive = events.minActive;
  metrics.maxActive = events.maxActive;
  return metrics;
}

// Comparable fingerprint for deterministic replay equality.
function replayFingerprint(result) {
  const roster = result.world
    .map((entry) => ({
      coinId: entry.coin.coinId,
      symbol: entry.coin.symbol,
      archetype: entry.coin.archetypeId,
      status: entry.state.status,
      diedAt: entry.state.diedAt,
      introducedAtMs: entry.state.introducedAtMs,
      isReplacement: entry.state.isReplacement,
      condition: entry.state.condition,
      structuralReference: entry.state.structuralReference,
      lastPrice: entry.state.lastPrice
    }))
    .sort((a, b) => a.coinId - b.coinId);

  return {
    deaths: result.events.deaths.map((d) => ({
      coinId: d.coinId,
      atMs: d.atMs,
      archetype: d.archetype,
      isReplacement: d.isReplacement,
      riskScore: d.riskScore
    })),
    replacements: result.events.replacements.map((r) => ({
      coinId: r.coinId,
      atMs: r.atMs,
      archetype: r.archetype
    })),
    roster,
    metrics: {
      originalDeaths: result.metrics.originalDeaths,
      replacementDeaths: result.metrics.replacementDeaths,
      replacements: result.metrics.replacements,
      recoveries: result.metrics.recoveries,
      minActive: result.metrics.minActive,
      maxActive: result.metrics.maxActive,
      finalActive: result.metrics.finalActive,
      originalSurvivors: result.metrics.originalSurvivors,
      duplicateIds: result.metrics.duplicateIds,
      earlyReplacementChurn: result.metrics.earlyReplacementChurn
    }
  };
}

function runStage9Horizon({
  days = 30,
  cadenceMinutes = 60,
  seed = 'stage9-horizon-seed',
  originMs = 0,
  provider = 'director',
  replacementDelayMs = replacementPool.DEFAULT_REPLACEMENT_CONFIG.replacementDelayMs,
  replacementConfig = null,
  earlyChurnMs = DAY_MS,
  log = () => {}
} = {}) {
  if (!(days > 0) || !(cadenceMinutes > 0)) {
    throw new Error(`stage9 horizon needs positive days/cadenceMinutes (days=${days}, cadenceMinutes=${cadenceMinutes})`);
  }

  const config = resolveSimulationConfig();
  const effectiveReplacementConfig = replacementConfig
    || replacementPool.resolveReplacementConfig({ replacementDelayMs });
  // Refuse silent production-default retunes: callers may shorten delay for
  // injected timelines, but death.riskThreshold always comes from validated
  // DEFAULT simulation config above.
  const cadenceMs = cadenceMinutes * 60 * 1000;
  const steps = Math.floor((days * DAY_MS) / cadenceMs);
  if (steps < 1) {
    throw new Error(`stage9 horizon needs at least one step (days=${days}, cadenceMinutes=${cadenceMinutes})`);
  }

  const environment = typeof provider === 'string'
    ? createEnvironmentProvider(provider, { seed, originMs })
    : provider;

  const authoredIds = new Set(
    replacementPool.loadReplacementRoster(effectiveReplacementConfig).map((entry) => entry.coinId)
  );
  const historicalIds = [];
  const world = CANONICAL_PERSISTENT_COINS.map((coin) => {
    historicalIds.push(coin.coinId);
    return {
      coin: { ...coin },
      state: initialCoinState(coin, originMs)
    };
  });

  const events = {
    deaths: [],
    replacements: [],
    recoveries: 0,
    minActive: countActive(world),
    maxActive: countActive(world)
  };

  const wallStart = Date.now();
  for (let s = 1; s <= steps; s += 1) {
    const nowMs = originMs + s * cadenceMs;

    // Snapshot the live set before this step's deaths — replacements inserted
    // this step must not be priced until the next cadence (matches writer
    // then reconcile ordering used by the production worker).
    const liveAtStepStart = world.filter((entry) => entry.state.status === 'ALIVE');
    for (const entry of liveAtStepStart) {
      if (entry.state.status !== 'ALIVE') continue;
      stepAliveCoin({
        entry,
        seed,
        worldOriginMs: originMs,
        nowMs,
        cadenceMs,
        environment,
        config,
        events
      });
    }

    try {
      reconcileDomain({
        world,
        historicalIds,
        nowMs,
        replacementConfig: effectiveReplacementConfig,
        authoredIds,
        seed,
        events
      });
    } catch (err) {
      if (/pool exhausted/.test(err.message)) {
        events.poolExhausted = true;
        // Soft-fail the remainder: continue stepping survivors without new
        // inserts so extinction behaviour remains measurable. Re-throw only
        // if the caller wants strict pool depth (CLI gate asserts below).
        log(`stage9 horizon: ${err.message}`);
      } else {
        throw err;
      }
    }

    const active = countActive(world);
    if (active < events.minActive) events.minActive = active;
    if (active > events.maxActive) events.maxActive = active;
  }

  const metrics = finalizeMetrics(world, events, {
    durationMs: days * DAY_MS,
    steps,
    earlyChurnMs
  });
  metrics.poolExhausted = events.poolExhausted === true;
  metrics.wallClockMs = Date.now() - wallStart;

  log(`stage9 horizon complete: ${days}d @ ${cadenceMinutes}m, seed=${seed}`);
  log(JSON.stringify(metrics, null, 2));

  return {
    seed,
    days,
    cadenceMinutes,
    originMs,
    provider: typeof provider === 'string' ? provider : 'custom',
    replacementDelayMs: replacementPool.getReplacementDelayMs(effectiveReplacementConfig),
    targetActiveCount: replacementPool.getTargetActiveCount(effectiveReplacementConfig),
    config,
    world,
    events,
    metrics,
    historicalIds: historicalIds.slice()
  };
}

// No-extinction active-roster floor for the default-director 30d gate.
// Measured minActive under deterministic seed stage9-gate-seed is 9 (~10
// roster). Floor 7 fails regressions that wipe most of the roster (>30%
// loss) without asserting the brittle exact measured value of 9.
const DEFAULT_NO_EXTINCTION_ACTIVE_FLOOR = 7;

// Quality gates for Stage 9 long-lived roster behaviour under DEFAULT
// death balancing. Thresholds are measurable floors/ceilings — not brittle
// single magic numbers — derived from observed default-director behaviour.
function assertStage9QualityGates(result, {
  requireDeaths = true,
  requireReplacements = true,
  requireReplacementDeaths = false,
  requireReplacementChain = false,
  minOriginalSurvivors = 1,
  minRecoveries = 1,
  minActiveFloor = DEFAULT_NO_EXTINCTION_ACTIVE_FLOOR,
  maxActiveCeiling = null,
  maxEarlyChurn = 0,
  minReplacementLifetimeMs = 12 * HOUR_MS,
  allowPoolExhaustion = false
} = {}) {
  const { metrics, events, targetActiveCount } = result;
  const activeCeiling = maxActiveCeiling == null ? targetActiveCount : maxActiveCeiling;
  const failures = [];

  if (metrics.duplicateIds !== 0) {
    failures.push(`duplicate coin ids observed (${metrics.duplicateIds})`);
  }
  if (requireDeaths && metrics.originalDeaths + metrics.replacementDeaths < 1) {
    failures.push('expected at least one authoritative permanent death under default config');
  }
  if (requireReplacements && metrics.replacements < 1) {
    failures.push('expected at least one authored replacement after delayed eligibility');
  }
  if (metrics.originalSurvivors < minOriginalSurvivors) {
    failures.push(
      `expected >= ${minOriginalSurvivors} long-lived original survivor(s); got ${metrics.originalSurvivors}`
    );
  }
  if (metrics.recoveries < minRecoveries) {
    failures.push(`expected >= ${minRecoveries} condition recovery path(s); got ${metrics.recoveries}`);
  }
  if (metrics.minActive < minActiveFloor) {
    failures.push(
      `extinction cascade: active roster dropped to ${metrics.minActive} (floor ${minActiveFloor})`
    );
  }
  if (metrics.maxActive > activeCeiling) {
    failures.push(
      `active roster exceeded target via duplicates/over-insert (${metrics.maxActive} > ${activeCeiling})`
    );
  }
  if (metrics.earlyReplacementChurn > maxEarlyChurn) {
    failures.push(
      `replacement churn: ${metrics.earlyReplacementChurn} replacement(s) died within early window (max allowed ${maxEarlyChurn})`
    );
  }
  if (metrics.replacementDeaths > 0 && metrics.minReplacementLifetimeMs == null) {
    failures.push('replacement deaths recorded but minReplacementLifetimeMs missing');
  }
  if (
    metrics.minReplacementLifetimeMs != null
    && metrics.minReplacementLifetimeMs < minReplacementLifetimeMs
  ) {
    failures.push(
      `replacement min lifetime ${metrics.minReplacementLifetimeMs}ms below gate ${minReplacementLifetimeMs}ms`
    );
  }
  if (!allowPoolExhaustion && metrics.poolExhausted) {
    failures.push('authored replacement pool exhausted during horizon');
  }
  if (requireReplacementDeaths && metrics.replacementDeaths < 1) {
    failures.push(
      'expected at least one natural replacement death via S9-01 (replacementDeaths >= 1)'
    );
  }
  if (requireReplacementChain) {
    if (metrics.replacements < 1) {
      failures.push('replacement chain: expected at least one authored replacement born');
    }
    if (metrics.replacementDeaths < 1) {
      failures.push('replacement chain: expected at least one natural replacement death');
    } else {
      // After a replacement dies, another authored insert must follow at/after
      // death + configured delay (multi-generation chain without spies).
      const delayMs = result.replacementDelayMs;
      const replacementDeathEvents = events.deaths.filter((d) => d.isReplacement);
      const chained = replacementDeathEvents.some((death) => (
        events.replacements.some((repl) => repl.atMs >= death.atMs + delayMs)
      ));
      if (!chained) {
        failures.push(
          'replacement chain: expected another authored replacement after a replacement death + delay'
        );
      }
    }
  }
  // Living floor never kills: every recorded death must carry the named
  // threshold reason with riskScore >= threshold.
  for (const death of events.deaths) {
    if (death.reason !== 'PERSISTENT_COLLAPSE_RISK_THRESHOLD') {
      failures.push(`death of coin ${death.coinId} missing authoritative reason`);
    }
    if (!(death.riskScore >= death.threshold)) {
      failures.push(
        `death of coin ${death.coinId} had riskScore ${death.riskScore} < threshold ${death.threshold}`
      );
    }
  }

  // Explicit archetypes on every replacement event.
  for (const repl of events.replacements) {
    if (!marketDomain.MARKET_ARCHETYPES[repl.archetype]) {
      failures.push(`replacement ${repl.coinId} missing/invalid archetype ${JSON.stringify(repl.archetype)}`);
    }
    // Authored ids must never resolve through the legacy silent MOON map
    // as their persisted identity — persisted archetype is authoritative.
    if (marketDomain.resolveArchetypeId(repl.coinId) === 'MOON' && repl.archetype === 'MOON') {
      // MOON is a valid authored archetype for some spare ids; only fail when
      // the roster entry is NOT authored as MOON but legacy resolution is MOON
      // AND we somehow recorded MOON. The harness records the authored value,
      // so cross-check against the pool definition.
      const authored = replacementPool.loadReplacementRoster()
        .find((entry) => entry.coinId === repl.coinId);
      if (authored && authored.archetype !== repl.archetype) {
        failures.push(
          `replacement ${repl.coinId} archetype drift: authored ${authored.archetype} vs recorded ${repl.archetype}`
        );
      }
    } else {
      const authored = replacementPool.loadReplacementRoster()
        .find((entry) => entry.coinId === repl.coinId);
      if (authored && authored.archetype !== repl.archetype) {
        failures.push(
          `replacement ${repl.coinId} archetype drift: authored ${authored.archetype} vs recorded ${repl.archetype}`
        );
      }
    }
  }

  // Authored order: replacement coin ids must be strictly increasing in the
  // authored roster consumption order.
  const rosterOrder = replacementPool.loadReplacementRoster().map((entry) => entry.coinId);
  for (let i = 1; i < events.replacements.length; i += 1) {
    const prevIdx = rosterOrder.indexOf(events.replacements[i - 1].coinId);
    const curIdx = rosterOrder.indexOf(events.replacements[i].coinId);
    if (prevIdx < 0 || curIdx < 0 || curIdx <= prevIdx) {
      failures.push('authored replacement order violated');
      break;
    }
  }

  if (failures.length > 0) {
    throw new Error(`Stage 9 quality gates failed:\n- ${failures.join('\n- ')}`);
  }
  return true;
}

function assertDeterministicReplay(a, b) {
  const fa = replayFingerprint(a);
  const fb = replayFingerprint(b);
  const aJson = JSON.stringify(fa);
  const bJson = JSON.stringify(fb);
  if (aJson !== bJson) {
    throw new Error('Stage 9 deterministic replay mismatch between two identical seeded runs');
  }
  return {
    checkedDeaths: fa.deaths.length,
    checkedReplacements: fa.replacements.length,
    checkedRoster: fa.roster.length
  };
}

function main(argv = process.argv) {
  const args = parseArgs(argv);
  const result = runStage9Horizon({
    days: args.days,
    cadenceMinutes: args.cadenceMinutes,
    seed: args.seed,
    replacementDelayMs: args.delayMs,
    provider: args.provider,
    log: console.log
  });
  assertStage9QualityGates(result);
  const replay = runStage9Horizon({
    days: args.days,
    cadenceMinutes: args.cadenceMinutes,
    seed: args.seed,
    replacementDelayMs: args.delayMs,
    provider: args.provider
  });
  const replayCheck = assertDeterministicReplay(result, replay);
  console.log('deterministic replay OK', replayCheck);
  console.log('STAGE9 HORIZON PASS');
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  }
}

module.exports = {
  DAY_MS,
  HOUR_MS,
  DEFAULT_NO_EXTINCTION_ACTIVE_FLOOR,
  CANONICAL_PERSISTENT_COINS,
  createEnvironmentProvider,
  runStage9Horizon,
  replayFingerprint,
  assertStage9QualityGates,
  assertDeterministicReplay
};
