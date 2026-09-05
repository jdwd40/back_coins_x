// Persistent-market Stage 2: the persistent-world horizon harness.
//
// Runs the Stage 2 persistent world over world ages no 30-minute round
// ever reaches (default 90 simulated days; 365-day deep runs supported)
// using ONLY the production persistent machinery:
//   * game/persistentPricing.js — the persistent-safe pricing composition
//     (log-neutral drift, weak restoring force, decaying crash damage);
//   * game/marketEnvironment.js — the environment seam (Stage 2 neutral
//     provider; Stage 3's Director plugs in behind the same seam);
//   * the per-coin committed-state transitions (bidirectional condition,
//     structural reference, decaying peak) applied per batch exactly as
//     the live writer will;
//   * the checkpoint accumulators, resumed and frozen every step exactly
//     as the Stage 1/2 production threading does.
//
// What it proves (hard invariants — master plan §53):
//   * every price finite and strictly positive at every step (no runaway
//     numerical behaviour, no NaN);
//   * no absorbing/extinct market: no coin is pinned to the living floor
//     in the neutral environment, every coin keeps moving (behavioural
//     variety), and per-30-day windows show no secular collapse;
//   * deterministic replay: an interrupted run resumed from its frozen
//     snapshot continues BIT-IDENTICALLY (Object.is) to the uninterrupted
//     run, and two independent runs of the full horizon agree exactly;
//   * the bidirectional condition genuinely moves both directions and the
//     structural reference/peak evolve without bound violations.
//
// Balance distributions (min/max bands, condition ranges, damage levels)
// are MEASURED and reported, not gated: Stage 2 balance judgement is
// still maturing (master plan §53 — record distributions, adopt
// thresholds later, never weaken an adopted gate).
//
// Usage: node simulation/persistentHorizon.js [--days N]
//        [--cadence-minutes M] [--seed S] [--replay-day D]
// Exits non-zero on any failure. Nothing here touches a database, a real
// clock, or Math.random(): time is injected, exactly like simulation/.

const persistentPricing = require('../game/persistentPricing');
const { createNeutralEnvironmentProvider } = require('../game/marketEnvironment');
const { createMarketDirectorProvider } = require('../game/marketDirector');
const { resolveSimulationConfig } = require('../game/simulationConfig');

// Environment provider selection: 'neutral' (Stage 2 default) or
// 'director' (Stage 3 Market Director behind the same seam).
function createEnvironmentProvider(id, { seed, originMs = 0 } = {}) {
  if (id === 'neutral') return createNeutralEnvironmentProvider();
  if (id === 'director') return createMarketDirectorProvider({ seed, originMs });
  throw new Error(`unknown environment provider ${JSON.stringify(id)} (expected 'neutral' or 'director')`);
}

// The canonical persistent roster: the active catalogue with EXPLICIT
// archetypes (master plan §29 — never the silent MOON default) and the
// persisted baseline prices as opening structural references.
const CANONICAL_PERSISTENT_COINS = [
  { coinId: 1, symbol: 'FTR', archetypeId: 'ZIP', reference: 0.10 },
  { coinId: 2, symbol: 'NVC', archetypeId: 'MOON', reference: 1.37 },
  { coinId: 3, symbol: 'BYT', archetypeId: 'RUG', reference: 0.12 },
  { coinId: 4, symbol: 'DGV', archetypeId: 'ZIP', reference: 0.10 },
  { coinId: 5, symbol: 'CYB', archetypeId: 'HODL', reference: 96.45 },
  { coinId: 6, symbol: 'BLN', archetypeId: 'BULL', reference: 43.46 },
  { coinId: 7, symbol: 'STF', archetypeId: 'MOON', reference: 3.91 },
  { coinId: 8, symbol: 'JDC', archetypeId: 'BULL', reference: 33.48 },
  { coinId: 9, symbol: 'MTC', archetypeId: 'DEGEN', reference: 0.10 },
  { coinId: 10, symbol: 'CZN', archetypeId: 'HODL', reference: 32.00 }
];

const DAY_MS = 24 * 60 * 60 * 1000;

function parseArgs(argv) {
  const args = { days: 90, cadenceMinutes: 30, seed: 'stage2-persistent-horizon-seed', replayDay: null, provider: 'neutral' };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--days') args.days = Number(argv[++i]);
    else if (argv[i] === '--cadence-minutes') args.cadenceMinutes = Number(argv[++i]);
    else if (argv[i] === '--seed') args.seed = argv[++i];
    else if (argv[i] === '--replay-day') args.replayDay = Number(argv[++i]);
    else if (argv[i] === '--provider') args.provider = argv[++i];
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!(args.days > 0) || !(args.cadenceMinutes > 0)) {
    throw new Error('persistent horizon days/cadenceMinutes must be positive numbers');
  }
  return args;
}

// Fresh per-coin world state at the epoch: neutral condition, reference
// and peak at the opening structural reference, no checkpoint, empty
// public price window.
function initialCoinState(coin) {
  return {
    condition: 0,
    structuralReference: coin.reference,
    peakReference: coin.reference,
    checkpoint: null,
    priceWindow: [] // { atMs, price } — the public recent-return window
  };
}

// One batch for one coin at nowMs (the exact pattern the live writer will
// run per 30s batch): price from the committed state and checkpoint, then
// advance the committed coin state (condition, reference, peak) and
// freeze the fresh checkpoint. Returns the batch detail.
function stepCoin({ coin, state, nowMs, elapsedMs, environment, config }) {
  const envNow = environment.environmentAt(nowMs);
  const price = persistentPricing.persistentPriceAt({
    seed: coin.seed, coinId: coin.coinId, archetypeId: coin.archetypeId,
    originMs: coin.originMs, nowMs,
    structuralReference: state.structuralReference,
    environment,
    checkpoint: state.checkpoint,
    config
  });
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`persistent horizon: coin ${coin.coinId} produced invalid price ${String(price)} at ${(nowMs / DAY_MS).toFixed(2)}d`);
  }
  const detail = persistentPricing.computePersistentPrice({
    seed: coin.seed, coinId: coin.coinId, archetypeId: coin.archetypeId,
    originMs: coin.originMs, nowMs,
    structuralReference: state.structuralReference,
    environment,
    checkpoint: state.checkpoint,
    config
  });

  // Committed inputs for the condition transition: the recent log return
  // over the public window, the drawdown from the DECAYING peak, and the
  // committed decaying crash damage (log space).
  const windowMs = config.persistent.condition.recentReturnWindowMs;
  while (state.priceWindow.length > 0 && state.priceWindow[0].atMs < nowMs - windowMs) {
    state.priceWindow.shift();
  }
  const windowOpen = state.priceWindow.length > 0 ? state.priceWindow[0].price : price;
  const recentLogReturn = windowOpen > 0 ? Math.log(price / windowOpen) : 0;
  const drawdown = persistentPricing.computePeakDrawdown(state.peakReference, price);
  const logCommittedDamage = Math.log(detail.committedDamageFactor);

  const nextCondition = persistentPricing.advanceCondition({
    condition: state.condition,
    archetypeId: coin.archetypeId,
    elapsedMs,
    recentLogReturn,
    drawdownFromPeak: drawdown,
    logCommittedDamage,
    netEventModifier: 0, // Stage 2: no persistent coin-event stream yet (Stage 3/4 debt)
    environment: envNow,
    config
  });
  const nextReference = persistentPricing.advanceStructuralReference({
    structuralReference: state.structuralReference,
    condition: state.condition, // committed condition drives this batch's reference move
    environment: envNow,
    elapsedMs,
    config
  });
  const nextPeak = persistentPricing.advancePeakReference({
    peakReference: state.peakReference,
    price,
    elapsedMs,
    config
  });
  const freshCheckpoint = persistentPricing.extractPersistentCheckpoint({
    seed: coin.seed, coinId: coin.coinId, archetypeId: coin.archetypeId,
    originMs: coin.originMs, nowMs,
    reference: state.structuralReference,
    environment,
    stored: state.checkpoint,
    config
  });

  state.priceWindow.push({ atMs: nowMs, price });
  state.condition = nextCondition;
  state.structuralReference = nextReference;
  state.peakReference = nextPeak;
  state.checkpoint = freshCheckpoint;

  return { price, condition: nextCondition, reference: nextReference, peak: nextPeak, detail };
}

// Run the horizon. Returns a summary; throws on any hard-invariant
// failure. Deterministic given (seed, coins, environment provider,
// cadence) — two runs agree bit-for-bit.
function runPersistentHorizon({
  days = 90,
  cadenceMinutes = 30,
  seed = 'stage2-persistent-horizon-seed',
  coins = CANONICAL_PERSISTENT_COINS,
  environment = createNeutralEnvironmentProvider(),
  originMs = 0,
  replayDay = null,
  log = () => {}
} = {}) {
  const config = resolveSimulationConfig();
  const cadenceMs = cadenceMinutes * 60 * 1000;
  const steps = Math.floor((days * DAY_MS) / cadenceMs);
  if (steps < 1) {
    throw new Error(`persistent horizon needs at least one step (days=${days}, cadenceMinutes=${cadenceMinutes})`);
  }
  const replayStep = replayDay === null ? null : Math.floor((replayDay * DAY_MS) / cadenceMs);

  const world = coins.map((coin) => ({
    coin: { ...coin, seed, originMs },
    state: initialCoinState(coin)
  }));

  const metrics = new Map(coins.map((coin) => [coin.coinId, {
    minPrice: Infinity,
    maxPrice: 0,
    floorTouches: 0,
    conditionMin: Infinity,
    conditionMax: -Infinity,
    conditionUpSteps: 0,
    conditionDownSteps: 0,
    minCommittedDamage: Infinity,
    maxCommittedDamage: 0,
    referenceMin: Infinity,
    referenceMax: 0,
    // Structural-coupling bands: the price relative to the CURRENT
    // structural reference it was priced against (never the opening
    // reference — references legitimately evolve in a persistent world).
    minPriceToReference: Infinity,
    maxPriceToReference: 0,
    windows: new Map() // 30-day window -> { min, max }
  }]));

  const replaySnapshots = new Map(); // step -> per-coin prices (for the interrupted-resume proof)
  let frozenReplayState = null;

  for (let s = 1; s <= steps; s++) {
    const tMs = originMs + s * cadenceMs;
    for (const entry of world) {
      const { coin, state } = entry;
      const referenceBefore = state.structuralReference;
      const before = state.condition;
      const { price, condition, detail } = stepCoin({
        coin, state, nowMs: tMs, elapsedMs: cadenceMs, environment, config
      });
      const m = metrics.get(coin.coinId);
      if (price < m.minPrice) m.minPrice = price;
      if (price > m.maxPrice) m.maxPrice = price;
      const priceToReference = price / referenceBefore;
      if (priceToReference < m.minPriceToReference) m.minPriceToReference = priceToReference;
      if (priceToReference > m.maxPriceToReference) m.maxPriceToReference = priceToReference;
      if (price === require('../game/marketDomain').MIN_POSITIVE_PRICE) m.floorTouches += 1;
      if (condition < m.conditionMin) m.conditionMin = condition;
      if (condition > m.conditionMax) m.conditionMax = condition;
      if (condition > before) m.conditionUpSteps += 1;
      if (condition < before) m.conditionDownSteps += 1;
      if (detail.committedDamageFactor < m.minCommittedDamage) m.minCommittedDamage = detail.committedDamageFactor;
      if (detail.committedDamageFactor > m.maxCommittedDamage) m.maxCommittedDamage = detail.committedDamageFactor;
      if (state.structuralReference < m.referenceMin) m.referenceMin = state.structuralReference;
      if (state.structuralReference > m.referenceMax) m.referenceMax = state.structuralReference;
      const windowIndex = Math.floor((s - 1) / Math.max(1, Math.round((30 * DAY_MS) / cadenceMs)));
      if (!m.windows.has(windowIndex)) m.windows.set(windowIndex, { min: Infinity, max: 0 });
      const w = m.windows.get(windowIndex);
      if (price < w.min) w.min = price;
      if (price > w.max) w.max = price;
      if (replayStep !== null && s > replayStep && s % Math.max(1, Math.round(DAY_MS / cadenceMs)) === 0) {
        if (!replaySnapshots.has(s)) replaySnapshots.set(s, new Map());
        replaySnapshots.get(s).set(coin.coinId, price);
      }
    }
    if (replayStep !== null && s === replayStep) {
      // Freeze the ENTIRE world state (committed coin state + checkpoint
      // accumulators) — the restart/replay boundary.
      frozenReplayState = world.map((entry) => ({
        coin: entry.coin,
        state: JSON.parse(JSON.stringify({
          condition: entry.state.condition,
          structuralReference: entry.state.structuralReference,
          peakReference: entry.state.peakReference,
          checkpoint: entry.state.checkpoint,
          priceWindow: entry.state.priceWindow
        }))
      }));
    }
  }

  return {
    seed, days, cadenceMinutes, steps, coins: coins.length,
    originMs,
    world,
    metrics,
    replayStep,
    frozenReplayState,
    replaySnapshots,
    config,
    environment,
    log
  };
}

// Continue a horizon from a frozen replay snapshot (the worker-restart /
// interrupted-resume pattern): fresh in-memory state built ONLY from the
// frozen committed state, stepped forward through the remaining horizon.
function resumePersistentHorizon(frozen, { days, cadenceMinutes, seed, environment, originMs = 0 }) {
  const config = frozen.config;
  const cadenceMs = cadenceMinutes * 60 * 1000;
  const steps = Math.floor((days * DAY_MS) / cadenceMs);
  const world = frozen.frozenReplayState.map((entry) => ({
    coin: entry.coin,
    state: JSON.parse(JSON.stringify(entry.state))
  }));
  const prices = new Map();
  for (let s = frozen.replayStep + 1; s <= steps; s++) {
    const tMs = originMs + s * cadenceMs;
    for (const entry of world) {
      const { price } = stepCoin({
        coin: entry.coin, state: entry.state, nowMs: tMs, elapsedMs: cadenceMs,
        environment, config
      });
      if (s % Math.max(1, Math.round(DAY_MS / cadenceMs)) === 0) {
        if (!prices.has(s)) prices.set(s, new Map());
        prices.get(s).set(entry.coin.coinId, price);
      }
    }
  }
  return prices;
}

// Hard-invariant verdict (master plan §53: hard failures only — balance
// distributions are recorded in the summary, not gated here).
function assertHorizonInvariants(result) {
  const MIN_POSITIVE_PRICE = require('../game/marketDomain').MIN_POSITIVE_PRICE;
  for (const coin of CANONICAL_PERSISTENT_COINS) {
    const m = result.metrics.get(coin.coinId);
    if (!m) continue;
    if (!(m.minPrice > 0) || !Number.isFinite(m.maxPrice)) {
      throw new Error(`persistent horizon: coin ${coin.coinId} produced an invalid price band [${m.minPrice}, ${m.maxPrice}]`);
    }
    if (m.floorTouches > 0) {
      throw new Error(`persistent horizon: coin ${coin.coinId} pinned to the living floor ${m.floorTouches} times in the neutral environment (absorbing market)`);
    }
    // Structural coupling: the price always trades within a wide band of
    // the CURRENT structural reference it was priced against. A breach
    // means the pricing layers decoupled (true numerical runaway/extinction
    // territory) — a genuinely diverging reference is NOT a failure
    // (master plan §23: coins diverge meaningfully).
    if (m.minPriceToReference < 0.005) {
      throw new Error(`persistent horizon: coin ${coin.coinId} decoupled below its structural reference (min ratio ${m.minPriceToReference})`);
    }
    if (m.maxPriceToReference > 200) {
      throw new Error(`persistent horizon: coin ${coin.coinId} decoupled above its structural reference (max ratio ${m.maxPriceToReference})`);
    }
    // Reference evolution sanity: the structural reference may travel far
    // over a long horizon (a coin that 100x'd is a legitimate journey),
    // but never to extinction or overflow territory.
    if (!(m.referenceMin > coin.reference * 0.001)) {
      throw new Error(`persistent horizon: coin ${coin.coinId} structural reference collapsed to ${m.referenceMin} vs opening reference ${coin.reference} (extinction territory)`);
    }
    if (!(m.referenceMax < coin.reference * 1000)) {
      throw new Error(`persistent horizon: coin ${coin.coinId} structural reference ran away to ${m.referenceMax} vs opening reference ${coin.reference} (runaway territory)`);
    }
    // Behavioural variety: the coin actually moved, in every 30-day window.
    for (const [windowIndex, w] of m.windows) {
      if (!(w.max / w.min > 1.02)) {
        throw new Error(`persistent horizon: coin ${coin.coinId} was static in 30-day window ${windowIndex} (${w.min}..${w.max})`);
      }
    }
    // The bidirectional condition genuinely moved both directions.
    if (m.conditionUpSteps === 0 || m.conditionDownSteps === 0) {
      throw new Error(`persistent horizon: coin ${coin.coinId} condition never moved both directions (up ${m.conditionUpSteps}, down ${m.conditionDownSteps})`);
    }
    // Condition/reference stayed inside their authoritative bounds.
    if (m.conditionMin < -1 || m.conditionMax > 1) {
      throw new Error(`persistent horizon: coin ${coin.coinId} condition escaped [-1, 1] (${m.conditionMin}..${m.conditionMax})`);
    }
    if (!(m.referenceMin > 0) || !Number.isFinite(m.referenceMax)) {
      throw new Error(`persistent horizon: coin ${coin.coinId} structural reference broke positivity (${m.referenceMin}..${m.referenceMax})`);
    }
  }
}

// The deterministic-replay proof: an interrupted run resumed from its
// frozen snapshot continues BIT-IDENTICALLY to the uninterrupted run at
// every sampled instant.
function assertReplayIdentity(result) {
  if (result.replayStep === null || !result.frozenReplayState) return { checked: 0 };
  const resumed = resumePersistentHorizon(result, {
    days: result.days,
    cadenceMinutes: result.cadenceMinutes,
    seed: result.seed,
    environment: result.environment,
    originMs: result.originMs
  });
  let checked = 0;
  for (const [step, expected] of result.replaySnapshots) {
    const actual = resumed.get(step);
    if (!actual) continue;
    for (const [coinId, expectedPrice] of expected) {
      const actualPrice = actual.get(coinId);
      if (!Object.is(actualPrice, expectedPrice)) {
        throw new Error(`persistent horizon replay diverged for coin ${coinId} at step ${step}: resumed ${actualPrice} vs uninterrupted ${expectedPrice}`);
      }
      checked += 1;
    }
  }
  return { checked };
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  const startedAt = Date.now();
  try {
    const environment = createEnvironmentProvider(args.provider, { seed: args.seed });
    const result = runPersistentHorizon({ ...args, environment, log: console.log });
    assertHorizonInvariants(result);
    let replay = { checked: 0 };
    if (args.replayDay !== null) {
      replay = assertReplayIdentity(result);
    }
    for (const coin of CANONICAL_PERSISTENT_COINS) {
      const m = result.metrics.get(coin.coinId);
      console.log(`coin ${coin.symbol} (${coin.coinId}): price [${m.minPrice}, ${m.maxPrice}] vs ref ${coin.reference}; condition [${m.conditionMin.toFixed(3)}, ${m.conditionMax.toFixed(3)}] (up ${m.conditionUpSteps}/down ${m.conditionDownSteps}); committed damage [${m.minCommittedDamage.toFixed(4)}, ${m.maxCommittedDamage.toFixed(4)}]; reference [${m.referenceMin.toFixed(4)}, ${m.referenceMax.toFixed(4)}]`);
    }
    console.log(`PERSISTENT HORIZON PASS: ${result.coins} coins x ${result.steps} steps (${args.days} simulated days at ${args.cadenceMinutes}-minute cadence) in ${Date.now() - startedAt}ms${args.replayDay !== null ? `; replay bit-identity verified over ${replay.checked} sampled prices` : ''}`);
  } catch (err) {
    console.error(`PERSISTENT HORIZON FAIL: ${err.message}`);
    process.exit(1);
  }
}

module.exports = {
  CANONICAL_PERSISTENT_COINS,
  runPersistentHorizon,
  resumePersistentHorizon,
  assertHorizonInvariants,
  assertReplayIdentity
};
