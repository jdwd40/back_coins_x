// V2-1 headless simulation: deterministic round environment.
//
// A round environment is the COMPLETE deterministic state of one seeded
// 30-minute apocalypse round: the same market-domain pricing the live game
// uses (game/marketDomain.js), the same Core 3 collapse schedule
// mathematics (game/collapseScheduleService.buildSchedule), the same Core 2
// apocalypse amplitude curve and the same deterministic passive-economy
// schedule (game/economyService.buildEventSchedule). Nothing here uses
// Math.random(), a real clock, or a database handle: time is injected.
//
// Paired strategy comparison: every strategy played on the same environment
// experiences the EXACT same market path, collapses and economy debits.

const marketDomain = require('../game/marketDomain');
const collapseRiskDomain = require('../game/collapseRiskDomain');
const { getApocalypseVolatility } = require('../game/apocalypseVolatility');
const { buildSchedule } = require('../game/collapseScheduleService');
const { buildEventSchedule } = require('../game/economyService');
const { scaleEconomyAmount } = require('../game/economyConfig');
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

  // Persisted-precision gameplay price: 0 for a dead coin, otherwise the
  // shared domain price at the same amplitude a live batch would use.
  function priceAt(coinId, nowMs) {
    if (isDead(coinId, nowMs)) return 0;
    return marketDomain.priceAt({
      seed,
      coinId,
      baselinePrice: baselineByCoin.get(coinId),
      roundStartMs: 0,
      nowMs,
      amplitude: amplitudeAt(nowMs)
    });
  }

  // The public signal a legal client could observe: the shared coarse
  // domain signal for a live coin, or a minimal dead marker. Dead coins
  // expose only their death and archetype identity — no phase/momentum
  // pretence. V2-3: live coins also carry the shared coarse collapse-risk
  // level — the exact field the live market-signals endpoint publishes,
  // computed by the same domain module from the same inputs.
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
    return {
      ...signal,
      collapseRisk: collapseRiskDomain.getCollapseRisk({
        seed,
        coinId,
        apocalypsePercent: apocalypsePercentAt(nowMs),
        phase: signal.phase,
        momentum: signal.momentum,
        recentChangePct: signal.recentChangePct,
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
    publicSignal
  };
}

module.exports = {
  CANONICAL_COINS,
  DEFAULT_ROUND_DURATION_MS,
  createRoundEnvironment
};
