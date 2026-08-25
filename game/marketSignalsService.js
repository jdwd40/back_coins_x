// V2-1: public market signals (read side).
//
// Builds the coarse, imperfect public signal set for every active catalogue
// coin from the shared market domain — the exact same signal shape the
// headless simulator's legal strategies act on. Reconcile-then-read, like
// GET /api/game/state. The cycle seed is read here ONLY to evaluate the
// domain and is never included in the returned payload; no future phase,
// peak, timing or collapse information is present.

const db = require('../db/connection');
const marketDomain = require('./marketDomain');
const collapseRiskDomain = require('./collapseRiskDomain');
const { getApocalypseVolatility } = require('./apocalypseVolatility');
const collapseScheduleService = require('./collapseScheduleService');

async function getPublicMarketSignals({ now = new Date() } = {}) {
  // Lazy require, matching the codebase's cycle-boundary convention (this
  // module is a read-side consumer of Core 1; gameCycleService never
  // requires this module).
  const { reconcileCycle, deriveProgress } = require('./gameCycleService');

  const nowDate = now instanceof Date ? now : new Date(now);
  const nowMs = nowDate.getTime();
  const cycle = await reconcileCycle({ now: nowDate });
  const { apocalypsePercent } = deriveProgress({
    startTime: cycle.start_time,
    endTime: cycle.end_time,
    durationMs: cycle.duration_ms,
    now: nowDate
  });
  const amplitude = getApocalypseVolatility(apocalypsePercent);

  const collapsedCoinIds = await collapseScheduleService.getCollapsedCoinIds();
  const { rows: coins } = await db.query(
    `SELECT coin_id, name, symbol, cycle_baseline_price
     FROM coins
     WHERE retired = FALSE
     ORDER BY coin_id ASC`
  );

  const roundStartMs = new Date(cycle.start_time).getTime();
  const signals = coins.map((coin) => {
    if (collapsedCoinIds.has(coin.coin_id)) {
      return {
        coinId: coin.coin_id,
        name: coin.name,
        symbol: coin.symbol,
        archetype: marketDomain.resolveArchetypeId(coin.coin_id),
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
    const publicSignal = marketDomain.getPublicCoinSignal({
      seed: cycle.seed,
      coinId: coin.coin_id,
      baselinePrice: parseFloat(coin.cycle_baseline_price),
      roundStartMs,
      nowMs,
      amplitude
    });
    return {
      name: coin.name,
      symbol: coin.symbol,
      ...publicSignal,
      // V2-3: coarse, imperfect collapse-risk level. Computed ONLY from
      // public state (progress, public phase/momentum/movement, public
      // archetype) plus schedule-independent seeded noise — never from the
      // hidden collapse schedule, which is not even read here.
      collapseRisk: collapseRiskDomain.getCollapseRisk({
        seed: cycle.seed,
        coinId: coin.coin_id,
        apocalypsePercent,
        phase: publicSignal.phase,
        momentum: publicSignal.momentum,
        recentChangePct: publicSignal.recentChangePct,
        nowMs
      }),
      dead: false
    };
  });

  return {
    apocalypseId: cycle.apocalypse_id,
    apocalypsePercent,
    serverTime: nowDate.toISOString(),
    coins: signals
  };
}

module.exports = { getPublicMarketSignals };
