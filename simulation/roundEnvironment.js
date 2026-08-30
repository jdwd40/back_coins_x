// V2-1 headless simulation: deterministic round environment.
//
// A round environment is the COMPLETE deterministic state of one seeded
// 30-minute apocalypse round: the same UNIFIED market pricing the live game
// uses (game/priceEngine.js over game/marketDomain.js, SIM-08/09/10), the
// same Core 3 collapse schedule mathematics
// (game/collapseScheduleService.buildSchedule), the same Core 2 apocalypse
// amplitude curve and the same deterministic passive-economy schedule
// (game/economyService.buildEventSchedule). Nothing here uses
// Math.random(), a real clock, or a database handle: time is injected.
//
// SIM-08 parity: the live writer prices each coin from the persisted Wave
// 1/2 authorities (coin events, market phases, hidden lifecycle) via
// game/pricingContext.js. Those authorities are themselves deterministic
// from the cycle seed, so this environment derives the same inputs purely:
//   * coin events    — coinEventEngine.buildCycleCoinEvents (pure seeded
//                      whole-window schedule; identical rows to what the
//                      live rolling persistence produces);
//   * market phases  — marketPhaseEngine.drawPhaseAt chain, extended lazily
//                      with the current lifecycle state, mirroring the live
//                      ensureMarketPhaseCoverage order;
//   * lifecycle      — a forward pass over a fixed evaluation cadence
//                      (MARKET_EVALUATION_STEP_MS, mirroring the live
//                      writer's 30s batch cadence): each step measures the
//                      market index from the prices computed at the PREVIOUS
//                      step (the live reconcile-measures-then-writes lag),
//                      lifts the monotonic peak, derives drawdown/momentum
//                      and advances the lifecycle via the same pure
//                      marketStateEngine functions. The opening state is
//                      measured from the restored baselines, exactly like
//                      live cycle creation.
// priceAt() then calls the SAME priceEngine.unifiedPriceAt the live writer
// persists. Paired strategy comparison: every strategy played on the same
// environment experiences the EXACT same market path, collapses and
// economy debits.

const marketDomain = require('../game/marketDomain');
const collapseRiskDomain = require('../game/collapseRiskDomain');
const { getApocalypseVolatility } = require('../game/apocalypseVolatility');
const { buildSchedule } = require('../game/collapseScheduleService');
const { buildEventSchedule } = require('../game/economyService');
const { scaleEconomyAmount } = require('../game/economyConfig');
const coinEventEngine = require('../game/coinEventEngine');
const marketPhaseEngine = require('../game/marketPhaseEngine');
const marketStateEngine = require('../game/marketStateEngine');
const priceEngine = require('../game/priceEngine');
const { resolveSimulationConfig } = require('../game/simulationConfig');
const {
  GAME_FEE_TICK_INTERVAL_MS,
  GAME_FEE_AMOUNT,
  GAME_TAX_TICK_INTERVAL_MS,
  GAME_TAX_AMOUNT,
  GAME_EVENT_COUNT,
  GAME_EVENT_MIN_FRACTION,
  GAME_EVENT_MAX_FRACTION,
  GAME_EVENT_MIN_AMOUNT,
  GAME_EVENT_MAX_AMOUNT
} = require('../game/gameConstants');

// The canonical active catalogue (mirrors db/test_data/coins.json and
// production migrations 013/014). Baselines are the persisted
// cycle_baseline_price values the live game restores at every round start.
const CANONICAL_COINS = [
  { coinId: 1, symbol: 'FTR', baselinePrice: 0.10 },
  { coinId: 2, symbol: 'NVC', baselinePrice: 1.37 },
  { coinId: 3, symbol: 'BYT', baselinePrice: 0.12 },
  { coinId: 4, symbol: 'DGV', baselinePrice: 0.10 },
  { coinId: 5, symbol: 'CYB', baselinePrice: 96.45 },
  { coinId: 6, symbol: 'BLN', baselinePrice: 43.46 },
  { coinId: 7, symbol: 'STF', baselinePrice: 3.91 },
  { coinId: 8, symbol: 'JDC', baselinePrice: 33.48 },
  { coinId: 9, symbol: 'MTC', baselinePrice: 0.10 },
  { coinId: 10, symbol: 'CZN', baselinePrice: 32.00 }
];

const DEFAULT_ROUND_DURATION_MS = 30 * 60 * 1000;

// The market-state evaluation cadence, mirroring the live writer's 30s
// batch interval: the hidden lifecycle/phase inputs a price is computed
// with come from the latest evaluation at or before the priced instant.
const MARKET_EVALUATION_STEP_MS = 30 * 1000;

// economyScale: the V2-3 explicit passive-economy multiplier (default 1 =
// the legacy Core 7 amounts). Every debit is scaled through the SAME
// scaleEconomyAmount the live service uses; debits scaled below a penny
// simply do not exist. The event schedule is built with an explicit
// config assembled from the game-design constants — the simulator never
// reads process.env, so runs stay hermetic.
function createRoundEnvironment({ seed, coins = CANONICAL_COINS, durationMs = DEFAULT_ROUND_DURATION_MS, economy = true, economyScale = 1 } = {}) {
  if (typeof seed !== 'string' || seed.length === 0) {
    throw new Error('round environment seed must be a non-empty string');
  }
  if (!Number.isInteger(durationMs) || durationMs <= 0) {
    throw new Error(`round environment durationMs must be a positive integer; received ${durationMs}`);
  }
  if (typeof economyScale !== 'number' || !Number.isFinite(economyScale) || economyScale < 0 || economyScale > 1) {
    throw new Error(`round environment economyScale must be a finite number in [0, 1]; received ${String(economyScale)}`);
  }

  // Core 3: the exact deterministic collapse schedule the live game would
  // persist for this seed + coin set + window. Collapses execute inside the
  // final 30% of the round; every coin is dead by round end (settlement
  // scores cash only).
  const schedule = buildSchedule({
    seed,
    coins: coins.map((c) => ({ coin_id: c.coinId, baseline_price: c.baselinePrice })),
    startTime: new Date(0),
    endTime: new Date(durationMs)
  });
  const collapseAtMs = new Map(schedule.map((row) => [row.coin_id, row.scheduled_at.getTime()]));

  // Issue #18 passive economy: the same deterministic event schedule plus
  // the fixed fee/tax cadences (first tick lands one interval after start;
  // a tick exactly at round end never fires), all scaled by economyScale.
  const economyEvents = economy
    ? buildEventSchedule({
      seed,
      startTime: new Date(0),
      endTime: new Date(durationMs),
      config: {
        eventCount: GAME_EVENT_COUNT,
        eventMinFraction: GAME_EVENT_MIN_FRACTION,
        eventMaxFraction: GAME_EVENT_MAX_FRACTION,
        eventMinAmount: GAME_EVENT_MIN_AMOUNT,
        eventMaxAmount: GAME_EVENT_MAX_AMOUNT,
        scale: economyScale
      }
    })
    : [];
  const debits = [];
  if (economy) {
    const feeAmount = scaleEconomyAmount(GAME_FEE_AMOUNT, economyScale);
    const taxAmount = scaleEconomyAmount(GAME_TAX_AMOUNT, economyScale);
    if (feeAmount > 0) {
      for (let t = GAME_FEE_TICK_INTERVAL_MS; t < durationMs; t += GAME_FEE_TICK_INTERVAL_MS) {
        debits.push({ atMs: t, amount: feeAmount, type: 'FEE' });
      }
    }
    if (taxAmount > 0) {
      for (let t = GAME_TAX_TICK_INTERVAL_MS; t < durationMs; t += GAME_TAX_TICK_INTERVAL_MS) {
        debits.push({ atMs: t, amount: taxAmount, type: 'TAX' });
      }
    }
    for (const ev of economyEvents) {
      debits.push({ atMs: ev.scheduled_at.getTime(), amount: ev.amount, type: 'EVENT' });
    }
    debits.sort((a, b) => a.atMs - b.atMs);
  }

  const baselineByCoin = new Map(coins.map((c) => [c.coinId, c.baselinePrice]));

  // SIM-08: the pure per-coin event streams (the same rows the live rolling
  // persistence would produce for this seed/window), grouped per coin.
  const coinEventsByCoin = new Map(coins.map((c) => [c.coinId, []]));
  for (const event of coinEventEngine.buildCycleCoinEvents({
    seed,
    coinIds: coins.map((c) => c.coinId),
    startTime: new Date(0),
    endTime: new Date(durationMs)
  })) {
    coinEventsByCoin.get(event.coin_id).push(event);
  }

  function apocalypsePercentAt(nowMs) {
    return Math.min(100, Math.max(0, (nowMs / durationMs) * 100));
  }

  // Core 2 amplitude: the exact translation live batches apply.
  function amplitudeAt(nowMs) {
    return getApocalypseVolatility(apocalypsePercentAt(nowMs));
  }

  function isDead(coinId, nowMs) {
    return nowMs >= collapseAtMs.get(coinId);
  }

  // -----------------------------------------------------------------------
  // SIM-08 forward market-state pass (memoised, pure). Steps mirror the
  // live reconciliation order per batch: extend event/phase coverage,
  // measure the index from the prices computed at the previous step,
  // advance the lifecycle, then extend the phase chain with the new state.
  // -----------------------------------------------------------------------
  let gameplayCache = null;

  function buildGameplayState() {
    const simConfig = resolveSimulationConfig();

    // Opening measurement: the sum of restored baselines — exactly what
    // live cycle creation persists before the first writer batch.
    const startingIndex = marketStateEngine.computeMarketIndex(
      coins.map((c) => ({ coin_id: c.coinId, current_price: c.baselinePrice }))
    );
    const plateauTarget = marketStateEngine.drawPlateauTarget({ seed, startingIndex, config: simConfig });

    const phases = [];
    let phaseSeq = 1;
    let phaseCursorMs = 0;
    // Lazily extend the contiguous phase chain to cover upToMs, drawing
    // each new phase with the lifecycle state current at extension time —
    // the live ensureMarketPhaseCoverage contract.
    const extendPhases = (upToMs, lifecycleState) => {
      while (phaseCursorMs <= upToMs && phaseCursorMs < durationMs) {
        const drawn = marketPhaseEngine.drawPhaseAt({ seed, phaseSeq, lifecycleState, config: simConfig });
        phases.push({
          phase_seq: phaseSeq,
          phase: drawn.phase,
          modifier: drawn.modifier,
          starts_at: new Date(phaseCursorMs),
          ends_at: new Date(phaseCursorMs + drawn.durationMs)
        });
        phaseCursorMs += drawn.durationMs;
        phaseSeq += 1;
      }
    };

    const phaseModifierAt = (tMs) => {
      const phase = marketPhaseEngine.getPhaseAt(phases, tMs);
      return phase ? parseFloat(phase.modifier) : 0;
    };

    // The unified price of one LIVE coin at tMs under a given market state.
    // Dead coins are excluded by callers (measurement) or return 0
    // (priceAt): death is the collapse schedule's, not the engine's.
    const livePriceAt = (coinId, tMs, lifecycleState) => priceEngine.unifiedPriceAt({
      seed,
      coinId,
      baselinePrice: baselineByCoin.get(coinId),
      roundStartMs: 0,
      nowMs: tMs,
      amplitude: amplitudeAt(tMs),
      lifecycleState,
      cycleProgress: Math.min(1, Math.max(0, tMs / durationMs)),
      phaseModifier: phaseModifierAt(tMs),
      eventModifier: coinEventEngine.netEventModifier(coinEventsByCoin.get(coinId), tMs, simConfig)
    });

    const steps = [];
    // Step 0: the opening GROWTH state at the starting index (live parity:
    // the market-state row is created at cycle start, before any tick).
    extendPhases(0, 'GROWTH');
    steps.push({ atMs: 0, lifecycleState: 'GROWTH', index: startingIndex, peak: startingIndex, drawdown: 0, momentum: 0 });

    const stepCount = Math.ceil(durationMs / MARKET_EVALUATION_STEP_MS);
    for (let s = 1; s <= stepCount; s++) {
      const tMs = s * MARKET_EVALUATION_STEP_MS;
      const prev = steps[s - 1];

      // Measure the index from the prices computed at the PREVIOUS
      // evaluation instant under the previous state — the live lag where
      // reconcile measures the persisted prices of the last batch. Dead
      // coins are excluded at the measurement instant (canonical survivor
      // rule; never inferred from a zero price).
      const tMeas = prev.atMs;
      const survivors = [];
      for (const coin of coins) {
        if (isDead(coin.coinId, tMeas)) continue;
        survivors.push({
          coin_id: coin.coinId,
          current_price: livePriceAt(coin.coinId, tMeas, prev.lifecycleState)
        });
      }
      const index = marketStateEngine.computeMarketIndex(survivors);
      const peak = index > prev.peak ? index : prev.peak;
      const drawdown = marketStateEngine.computeDrawdown(peak, index);
      const momentum = marketStateEngine.computeMomentum(prev.index, index);
      const lifecycleState = marketStateEngine.nextLifecycleState({
        lifecycleState: prev.lifecycleState,
        currentIndex: index,
        peakIndex: peak,
        drawdown,
        momentum,
        plateauTarget,
        cycleProgress: Math.min(1, tMs / durationMs),
        config: simConfig
      });
      extendPhases(tMs, lifecycleState);
      steps.push({ atMs: tMs, lifecycleState, index, peak, drawdown, momentum });
    }

    return { steps, phases, phaseModifierAt, livePriceAt };
  }

  function gameplay() {
    if (!gameplayCache) gameplayCache = buildGameplayState();
    return gameplayCache;
  }

  // The market state a price at nowMs is computed with: the latest
  // evaluation at or before nowMs (live: the most recent reconcile).
  function marketStateAt(nowMs) {
    const { steps } = gameplay();
    const stepIndex = Math.min(steps.length - 1, Math.max(0, Math.floor(nowMs / MARKET_EVALUATION_STEP_MS)));
    return steps[stepIndex];
  }

  // Internal/test surface: the exact inputs priceAt feeds the unified
  // engine for a live coin at nowMs. Never part of any public response.
  function pricingInputsAt(coinId, nowMs) {
    const state = marketStateAt(nowMs);
    return {
      lifecycleState: state.lifecycleState,
      cycleProgress: Math.min(1, Math.max(0, nowMs / durationMs)),
      phaseModifier: gameplay().phaseModifierAt(nowMs),
      eventModifier: coinEventEngine.netEventModifier(coinEventsByCoin.get(coinId), nowMs, resolveSimulationConfig()),
      amplitude: amplitudeAt(nowMs),
      // Diagnostic context for the Wave 6 harness: the market-state step
      // this instant prices under.
      marketIndex: state.index,
      peakIndex: state.peak,
      drawdown: state.drawdown
    };
  }

  // Persisted-precision gameplay price: 0 for a dead coin, otherwise the
  // SAME unified engine call the live writer persists.
  function priceAt(coinId, nowMs) {
    if (isDead(coinId, nowMs)) return 0;
    const inputs = pricingInputsAt(coinId, nowMs);
    return priceEngine.unifiedPriceAt({
      seed,
      coinId,
      baselinePrice: baselineByCoin.get(coinId),
      roundStartMs: 0,
      nowMs,
      amplitude: inputs.amplitude,
      lifecycleState: inputs.lifecycleState,
      cycleProgress: inputs.cycleProgress,
      phaseModifier: inputs.phaseModifier,
      eventModifier: inputs.eventModifier
    });
  }

  // The public signal a legal client could observe: the shared coarse
  // domain signal for a live coin, or a minimal dead marker. Dead coins
  // expose only their death and archetype identity — no phase/momentum
  // pretence. V2-3: live coins also carry the shared coarse collapse-risk
  // level — the exact field the live market-signals endpoint publishes,
  // computed by the same domain module from the same inputs.
  //
  // SIM-08: currentPrice/recentChangePct/momentum reflect the UNIFIED price
  // path (the prices strategies actually trade at), exactly like the live
  // market-signals endpoint; the coarse phase label and typical archetype
  // ranges stay domain-based.
  function publicSignal(coinId, nowMs) {
    if (isDead(coinId, nowMs)) {
      return {
        coinId,
        archetype: marketDomain.resolveArchetypeId(coinId),
        currentPrice: 0,
        recentChangePct: null,
        phase: 'DEAD',
        momentum: 'FLAT',
        typicalCycleMinutes: null,
        typicalSwingPct: null,
        collapseRisk: collapseRiskDomain.DEAD_RISK_MARKER,
        dead: true
      };
    }
    const signal = marketDomain.getPublicCoinSignal({
      seed,
      coinId,
      baselinePrice: baselineByCoin.get(coinId),
      roundStartMs: 0,
      nowMs,
      amplitude: amplitudeAt(nowMs)
    });
    const currentPrice = priceAt(coinId, nowMs);
    const pastPrice = priceAt(coinId, Math.max(0, nowMs - marketDomain.PUBLIC_SIGNAL_LOOKBACK_MS));
    const recentChangePct = pastPrice > 0
      ? Math.round(((currentPrice - pastPrice) / pastPrice) * 10000) / 100
      : null;
    const momentum = recentChangePct === null
      ? signal.momentum
      : recentChangePct > marketDomain.PUBLIC_MOMENTUM_THRESHOLD_PCT
        ? 'UP'
        : recentChangePct < -marketDomain.PUBLIC_MOMENTUM_THRESHOLD_PCT
          ? 'DOWN'
          : 'FLAT';
    return {
      ...signal,
      currentPrice,
      recentChangePct,
      momentum,
      collapseRisk: collapseRiskDomain.getCollapseRisk({
        seed,
        coinId,
        apocalypsePercent: apocalypsePercentAt(nowMs),
        phase: signal.phase,
        momentum,
        recentChangePct,
        nowMs
      }),
      dead: false
    };
  }

  return {
    seed,
    coins,
    durationMs,
    collapseAtMs,
    debits,
    apocalypsePercentAt,
    amplitudeAt,
    isDead,
    priceAt,
    publicSignal,
    pricingInputsAt
  };
}

module.exports = {
  CANONICAL_COINS,
  DEFAULT_ROUND_DURATION_MS,
  MARKET_EVALUATION_STEP_MS,
  createRoundEnvironment
};
