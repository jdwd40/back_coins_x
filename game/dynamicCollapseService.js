// Crypto Chaos gameplay overhaul SIM-13/SIM-14: the dynamic collapse engine
// — the SINGLE coin-death authority for the whole backend.
//
// This module REPLACES the retired fixed scheduled-collapse controller
// (game/collapseScheduleService.js, deleted in the same wave): the old
// system pre-committed every coin's collapse rank and timestamp at cycle
// start and zeroed coins when a future-dated row fell due. No normal path
// calls both controllers — the old one no longer exists. The legacy
// coin_collapse_schedule table (migration 008) is preserved data only; it
// is never written or read by any runtime path now.
//
// WHAT CHANGED (gameplay_changes.md §20-22, gameplay_build_plan.md Stage
// 10): coins no longer die on a fixed elapsed-time rank schedule. Each
// coin's collapse risk is evaluated from ACTUAL market deterioration —
// overall market drawdown, the coin's price relative to its recorded peak,
// negative active coin events, recent crash damage, a negative market
// phase, recent sell pressure, the hidden lifecycle state, and late-cycle
// progress (the exact weighted input set of config dynamicCollapse). Death
// is probabilistic per evaluation: a coin dies when its seeded per-bucket
// roll lands under its current effective risk, so vulnerable coins die
// earlier, the order varies every cycle, and collapse chance stays very
// low before the late game (config preDeclineRiskCap) while rising with
// market damage (hard-capped per evaluation by maxRiskPerEvaluation).
//
// DURABILITY / RECOVERY: death state lives ONLY in
// apocalypse_coin_collapses (migration 022) — a row is written at the
// moment of death, never before, so nothing about future timing or order
// is ever persisted and therefore nothing can leak through public APIs or
// bot inputs. A row's existence IS the death record; death is never
// inferred from current_price === 0 and never held in a process-local set.
// Rolls are deterministic — SHA-256 counter mode (game/seededRandom.js)
// keyed by the cycle's persisted Core 1 seed, the coin id and the fixed
// evaluation bucket — so a restart re-evaluating the same instant reaches
// the same roll, and every persisted death is simply observed, never
// rerolled.
//
// TRANSACTION SEMANTICS (preserved from Core 3): every mutation runs
// inside the caller's single Core 1 advisory-locked transaction (lock key
// 727001): the durable collapsed_at stamp, the coins row lock via the
// UPDATE, the guarded insert (ON CONFLICT ... DO NOTHING with a rollback
// on an inconsistent rowCount), and the exact COLLAPSE price-history
// provenance (source='COLLAPSE', the authoritative cycle id, price exactly
// numeric 0, the death instant). Baseline restoration runs only at a new
// cycle boundary, so a previous cycle's £0 never leaks forward and a coin
// never resurrects across cycle boundaries.
//
// THE FINAL SAFETY RULE (gameplay_changes.md §22): regardless of earlier
// randomness, EVERY remaining coin is forced to exactly £0 at cycle end —
// executeRemainingCollapses runs during settlement at exactly the cycle's
// end_time before any value or result is read, so the ultimate apocalypse
// outcome stays fixed even though the path to it is market-reactive.
//
// This module never requires gameCycleService (no circular imports) and
// owns no timers.

const db = require('../db/connection');
const logger = require('../utils/logger');
const { createSeededRandom } = require('./seededRandom');
const marketPhaseEngine = require('./marketPhaseEngine');
const tradePressureDomain = require('./tradePressureDomain');
const {
  COLLAPSE_INPUT_IDS,
  NEGATIVE_MARKET_PHASE_IDS,
  resolveSimulationConfig
} = require('./simulationConfig');
const persistentWorld = require('./persistentWorld');

// The dynamic collapse evaluation bucket: one seeded roll per coin per
// bucket of elapsed cycle time. 30s mirrors the live market writer's batch
// cadence (and the headless simulator's market-evaluation step), so the
// reconcile cadence evaluates every bucket under normal operation while
// repeated reconciles inside one bucket share one stable roll. A fixed
// game-design constant — deliberately not configurable.
const COLLAPSE_EVALUATION_BUCKET_MS = 30 * 1000;

// The recent-crash window for the recentCrashDamage risk input: a coin's
// current price is compared against its highest RECORDED price inside this
// trailing window. A fixed game-design constant, mirroring the
// RISK_JITTER_BUCKET_MS convention in collapseRiskDomain.
const CRASH_DAMAGE_WINDOW_MS = 5 * 60 * 1000;

function assertFiniteNumber(name, value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`dynamic collapse ${name} must be a finite number; received ${typeof value === 'string' ? JSON.stringify(value) : String(value)}`);
  }
}

function toMs(value, label) {
  const ms = (value instanceof Date ? value : new Date(value)).getTime();
  if (!Number.isFinite(ms)) {
    throw new Error(`dynamic collapse engine requires a valid ${label}; received ${String(value)}`);
  }
  return ms;
}

// ---------------------------------------------------------------------------
// Pure, testable risk mathematics (no database, no clock, no globals).
// Same inputs -> identical risk/rolls, in every process, forever.
// ---------------------------------------------------------------------------

// The lifecycleStage risk input: the hidden lifecycle as an escalating
// fraction (GROWTH 0, PLATEAU 1/3, DECLINE 2/3, COLLAPSE 1).
function lifecycleStageInput(lifecycleState) {
  switch (lifecycleState) {
    case 'GROWTH': return 0;
    case 'PLATEAU': return 1 / 3;
    case 'DECLINE': return 2 / 3;
    case 'COLLAPSE': return 1;
    default:
      throw new Error(`unknown lifecycle state ${JSON.stringify(lifecycleState)}; expected one of GROWTH, PLATEAU, DECLINE, COLLAPSE`);
  }
}

// The weighted per-evaluation collapse risk for one coin. `inputs` must
// carry EXACTLY the COLLAPSE_INPUT_IDS keys, each a fraction in [0, 1]
// (an unknown or missing input is a hard error — a silently dropped input
// would corrupt the risk). The weighted sum is hard-capped at config
// maxRiskPerEvaluation regardless of damage, and — while the market has
// not yet reached DECLINE — further capped at config preDeclineRiskCap, so
// collapse chance stays very low before the late game (build plan Stage
// 10). Returns the effective per-evaluation death probability in [0,
// maxRiskPerEvaluation].
function computeCollapseRisk({ inputs, lifecycleState, config = resolveSimulationConfig() }) {
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) {
    throw new Error('dynamic collapse risk requires an inputs object');
  }
  const actual = Object.keys(inputs).sort();
  const expected = COLLAPSE_INPUT_IDS.slice().sort();
  if (actual.length !== expected.length || !actual.every((k, i) => k === expected[i])) {
    throw new Error(`dynamic collapse risk inputs must be exactly { ${expected.join(', ')} }; received { ${actual.join(', ')} }`);
  }
  const dc = config.dynamicCollapse;
  let risk = 0;
  for (const id of COLLAPSE_INPUT_IDS) {
    const value = inputs[id];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(`dynamic collapse risk input ${id} must be a fraction in [0, 1]; received ${String(value)}`);
    }
    risk += dc.inputWeights[id] * value;
  }
  risk = Math.min(dc.maxRiskPerEvaluation, risk);
  if (lifecycleState === 'GROWTH' || lifecycleState === 'PLATEAU') {
    risk = Math.min(dc.preDeclineRiskCap, risk);
  } else if (lifecycleState !== 'DECLINE' && lifecycleState !== 'COLLAPSE') {
    throw new Error(`unknown lifecycle state ${JSON.stringify(lifecycleState)}; expected one of GROWTH, PLATEAU, DECLINE, COLLAPSE`);
  }
  return risk;
}

// The evaluation bucket index for an instant within a cycle window. Bucket
// boundaries are fixed offsets from the cycle start, so every process
// derives the same bucket for the same instant.
function collapseBucketIndex(elapsedMs) {
  assertFiniteNumber('elapsedMs', elapsedMs);
  if (elapsedMs < 0) {
    throw new Error(`dynamic collapse elapsedMs must be non-negative; received ${elapsedMs}`);
  }
  return Math.floor(elapsedMs / COLLAPSE_EVALUATION_BUCKET_MS);
}

// The seeded per-(coin, bucket) collapse roll in [0, 1): a coin dies at an
// evaluation when its roll lands under its current effective risk. The
// stream (`${seed}:sim4-dynamic-collapse:coin:<coinId>:<bucket>`) has its
// own domain separator, uncorrelated with coin events, market phases,
// crash episodes, bot moves and the retired schedule shuffle — and it is
// never persisted or exposed, so future collapse timing/order cannot leak.
function drawCollapseRoll({ seed, coinId, bucketIndex }) {
  if (typeof seed !== 'string' || seed.length === 0) {
    throw new Error('dynamic collapse seed must be a non-empty string');
  }
  if (!Number.isInteger(bucketIndex) || bucketIndex < 0) {
    throw new Error(`dynamic collapse bucketIndex must be a non-negative integer; received ${String(bucketIndex)}`);
  }
  const rng = createSeededRandom(`${seed}:sim4-dynamic-collapse:coin:${Number(coinId)}:${bucketIndex}`);
  return rng();
}

// Assemble the exact weighted input set from raw measurements. Pure and
// total: every raw value is validated, every normalisation is explicit.
// This is the small diagnostic surface the Wave 6 harness can reuse.
//   marketDrawdown        — persisted cycle drawdown in [0, 1]
//   coinPrice / coinPeak  — current price vs the coin's recorded cycle peak
//   negativeEventSum      — signed sum of the coin's active NEGATIVE event
//                           modifiers (<= 0)
//   coinRecentPeak        — highest recorded price in the crash window
//   phaseModifier         — current primary market-phase modifier (signed)
//   sellPressure          — the coin's bounded decayed sell pressure
//   lifecycleState        — current hidden lifecycle state
//   cycleProgress         — elapsed cycle fraction in [0, 1]
function buildCollapseRiskInputs({
  marketDrawdown,
  coinPrice,
  coinPeak,
  negativeEventSum,
  coinRecentPeak,
  phaseModifier,
  sellPressure,
  lifecycleState,
  cycleProgress,
  config = resolveSimulationConfig()
}) {
  assertFiniteNumber('marketDrawdown', marketDrawdown);
  assertFiniteNumber('coinPrice', coinPrice);
  assertFiniteNumber('coinPeak', coinPeak);
  assertFiniteNumber('negativeEventSum', negativeEventSum);
  assertFiniteNumber('coinRecentPeak', coinRecentPeak);
  assertFiniteNumber('phaseModifier', phaseModifier);
  assertFiniteNumber('sellPressure', sellPressure);
  assertFiniteNumber('cycleProgress', cycleProgress);

  // The largest possible negative phase magnitude, derived from config —
  // the normaliser for the negativeMarketPhase input (for a negative phase
  // the min bound is the stronger magnitude: RECESSION spans -0.04..-0.025,
  // so the maximum magnitude is 0.04).
  const maxNegativePhaseModifier = Math.max(
    ...NEGATIVE_MARKET_PHASE_IDS.map((id) => {
      const range = config.marketPhases.phases[id].modifier;
      return Math.max(Math.abs(range.min), Math.abs(range.max));
    })
  );

  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  return {
    marketDrawdown: clamp01(marketDrawdown),
    coinPriceVsPeak: coinPeak > 0 ? clamp01(1 - coinPrice / coinPeak) : 0,
    negativeActiveEvents: clamp01(Math.abs(Math.min(0, negativeEventSum)) / config.coinEvents.maxStackedModifier),
    recentCrashDamage: coinRecentPeak > 0 ? clamp01(1 - coinPrice / coinRecentPeak) : 0,
    negativeMarketPhase: phaseModifier < 0 ? clamp01(Math.abs(phaseModifier) / maxNegativePhaseModifier) : 0,
    recentSellPressure: clamp01(sellPressure / config.tradingPressure.maxSellPressureModifier),
    lifecycleStage: lifecycleStageInput(lifecycleState),
    cycleProgress: clamp01(cycleProgress)
  };
}

// ---------------------------------------------------------------------------
// Database-backed lifecycle. Every mutation takes the caller's Core 1
// advisory-locked transaction client; reads accept any queryable.
// ---------------------------------------------------------------------------

// Restore every coin's live price from its explicit persisted baseline.
// Runs only at a new cycle boundary, so a previous cycle's £0 collapse can
// never leak into the next cycle (no resurrection across cycle boundaries).
async function restoreBaselinePrices(client) {
  // S11-01 cutover: when persistent world is active, the persistent market
  // writer is the sole authority. Legacy baseline restore must be a no-op
  // (fail-safe; never overwrites live persistent prices or resurrects DEAD).
  try {
    await persistentWorld.resolveActiveWorld(client);
    return;
  } catch (err) {
    if (!/no active market world/.test(err.message)) throw err;
  }
  await client.query(`UPDATE coins SET current_price = cycle_baseline_price`);
}

// Read-only helpers for the market writer, the public signal read side, the
// bot state builder and the legacy trade guard. Death is read from the
// persisted death records of the live cycle only — a collapse in a
// COMPLETED cycle must never make a new cycle's coins dead. The SETTLING
// cycle counts as live here, so a coin collapsed at the end of a round
// stays dead through settlement; the successor's baseline restoration
// revives prices only once the next cycle is ACTIVE.
async function getCollapsedCoinIds(queryable = db) {
  const { rows } = await queryable.query(
    `SELECT cc.coin_id
     FROM apocalypse_coin_collapses cc
     JOIN apocalypse_cycles ac ON ac.cycle_id = cc.cycle_id
     WHERE ac.status IN ('ACTIVE', 'SETTLING')`
  );
  return new Set(rows.map((r) => r.coin_id));
}

async function isCoinCollapsed(coinId, queryable = db) {
  const { rows } = await queryable.query(
    `SELECT 1
     FROM apocalypse_coin_collapses cc
     JOIN apocalypse_cycles ac ON ac.cycle_id = cc.cycle_id
     WHERE ac.status IN ('ACTIVE', 'SETTLING') AND cc.coin_id = $1`,
    [coinId]
  );
  return rows.length > 0;
}

// Execute one coin's death inside the caller's transaction: price exactly
// numeric 0 (the UPDATE takes the coin row lock), the actual £0 transition
// appended to price_history with exact COLLAPSE provenance at the death
// instant, and the durable death record inserted with its execution rank.
// The guarded insert is the consistency backstop: survivors are selected
// as not-yet-dead under the advisory lock, so a conflicting row means
// inconsistent persisted state — abort the whole lifecycle transaction
// rather than corrupt collapse state. Replay is idempotent by selection:
// only not-yet-dead coins are ever executed, so a replay finds nothing to
// do and cannot duplicate state or £0 history rows.
async function executeCollapse(client, cycleId, coinId, collapseRank, atDate) {
  // S11-01 cutover: when persistent world active, legacy Apocalypse must
  // never zero persistent coins (living, DEAD, or replacements). Price
  // write is no-op; legacy collapse record may still insert (inert for
  // persistent catalogue).
  try {
    await persistentWorld.resolveActiveWorld(client);
    // skip price + history write for persistent; death record is legacy-only
  } catch (err) {
    if (!/no active market world/.test(err.message)) throw err;
    await client.query(
      `UPDATE coins SET current_price = 0 WHERE coin_id = $1`,
      [coinId]
    );
    // Apocalypse Monitor foundation: stamp the actual £0 transition with the
    // caller's authoritative cycle id and its COLLAPSE provenance. The death
    // record remains the only collapse authority — never inferred from zero
    // prices.
    await client.query(
      `INSERT INTO price_history (coin_id, cycle_id, price, created_at, source)
       VALUES ($1, $2, 0, $3, 'COLLAPSE')`,
      [coinId, cycleId, atDate.toISOString()]
    );
  }
  const { rows: inserted } = await client.query(
    `INSERT INTO apocalypse_coin_collapses (cycle_id, coin_id, collapse_rank, collapsed_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (cycle_id, coin_id) DO NOTHING
     RETURNING collapse_id`,
    [cycleId, coinId, collapseRank, atDate.toISOString()]
  );
  if (inserted.length !== 1) {
    throw new Error(`dynamic collapse of coin ${coinId} in cycle ${cycleId} conflicted with a persisted death record; aborting lifecycle transaction`);
  }
  // Only past (executed) deaths are logged; no future timing/order exists
  // to log or expose.
  logger.log(`[GAME] Executed dynamic collapse: coin_id ${coinId} (rank ${collapseRank}, cycle ${cycleId})`);
}

// The dynamic per-cycle evaluation. Called by gameCycleService
// .ensureActiveCycle INSIDE the Core 1 advisory-locked cycle transaction on
// every reconciliation of a live cycle, BEFORE the market state advances
// (so the market index reflects just-executed deaths, exactly like the
// retired controller's ordering). Risk is computed from the PERSISTED
// market state of the previous reconcile (the same reconcile-measures-
// then-acts lag the market index itself uses) plus the current persisted
// phase/event/ledger/price-history authorities.
//
// Returns the executed death rows ([] when nothing died).
async function evaluateAndExecuteCollapses(client, cycle, now, { config = resolveSimulationConfig() } = {}) {
  const nowMs = toMs(now, 'now');
  const nowDate = new Date(nowMs);
  const startMs = toMs(cycle.start_time, 'cycle.start_time');
  const endMs = toMs(cycle.end_time, 'cycle.end_time');
  if (endMs <= startMs) {
    throw new Error(`dynamic collapse requires the cycle end after its start; received ${cycle.start_time} .. ${cycle.end_time}`);
  }
  // A reconciler can observe a newly created aligned cycle fractionally
  // before its start boundary (or race a successor's creation). No market
  // interval has elapsed, so there is deliberately no death query, roll, or
  // price write yet; the first on/after-start reconciliation evaluates
  // bucket zero. This is a safe no-op rather than a negative bucket error.
  if (nowMs < startMs) return [];
  const cycleProgress = Math.min(1, Math.max(0, (nowMs - startMs) / (endMs - startMs)));

  // Surviving coins: the active catalogue (retired coins excluded,
  // migration 014) minus this cycle's persisted deaths, in canonical order.
  const { rows: survivors } = await client.query(
    `SELECT c.coin_id, c.current_price, c.cycle_baseline_price
     FROM coins c
     WHERE c.retired = FALSE
       AND NOT EXISTS (
         SELECT 1 FROM apocalypse_coin_collapses cc
         WHERE cc.cycle_id = $1 AND cc.coin_id = c.coin_id
       )
     ORDER BY c.coin_id
     FOR UPDATE OF c`,
    [cycle.cycle_id]
  );
  if (survivors.length === 0) return [];

  // The persisted market state of the previous reconcile. A missing row is
  // only possible for a cycle that predates Wave 2 reconciliation; default
  // to the opening state rather than abort the lifecycle.
  const { rows: stateRows } = await client.query(
    `SELECT drawdown, lifecycle_state FROM apocalypse_market_state WHERE cycle_id = $1`,
    [cycle.cycle_id]
  );
  const marketDrawdown = stateRows.length > 0 ? parseFloat(stateRows[0].drawdown) : 0;
  const lifecycleState = stateRows.length > 0 ? stateRows[0].lifecycle_state : 'GROWTH';

  // Risk inputs, set-based per coin:
  //   * the current primary market phase (negative phase input);
  const phase = await marketPhaseEngine.getCurrentMarketPhase(client, cycle.cycle_id, nowDate);
  const phaseModifier = phase ? parseFloat(phase.modifier) : 0;
  //   * the signed sum of each coin's active NEGATIVE coin-event modifiers;
  const { rows: eventRows } = await client.query(
    `SELECT coin_id, COALESCE(SUM(modifier), 0) AS negative_sum
     FROM apocalypse_coin_events
     WHERE cycle_id = $1 AND direction = 'NEGATIVE'
       AND starts_at <= $2 AND ends_at > $2
     GROUP BY coin_id`,
    [cycle.cycle_id, nowDate.toISOString()]
  );
  const negativeEventSumByCoin = new Map(eventRows.map((r) => [r.coin_id, parseFloat(r.negative_sum)]));
  //   * recent sell pressure from the persisted round ledger (the SAME
  //     bounded pressure path human and bot trades feed, SIM-11);
  const pressureWindowMs = tradePressureDomain.pressureWindowMs(config);
  const { rows: txRows } = await client.query(
    `SELECT coin_id, type, total_amount, created_at
     FROM apocalypse_transactions
     WHERE cycle_id = $1 AND created_at >= $2
     ORDER BY created_at`,
    [cycle.cycle_id, new Date(nowMs - pressureWindowMs).toISOString()]
  );
  const txsByCoin = new Map();
  for (const tx of txRows) {
    const entry = {
      type: tx.type,
      notional: parseFloat(tx.total_amount),
      atMs: new Date(tx.created_at).getTime()
    };
    const list = txsByCoin.get(tx.coin_id);
    if (list) list.push(entry);
    else txsByCoin.set(tx.coin_id, [entry]);
  }
  //   * each coin's recorded cycle peak and recent-window peak from the
  //     canonical MARKET_TICK price history (never inferred from memory).
  const { rows: peakRows } = await client.query(
    `SELECT coin_id,
            MAX(price) AS peak_price,
            MAX(price) FILTER (WHERE created_at >= $2) AS recent_peak_price
     FROM price_history
     WHERE cycle_id = $1
     GROUP BY coin_id`,
    [cycle.cycle_id, new Date(nowMs - CRASH_DAMAGE_WINDOW_MS).toISOString()]
  );
  const peaksByCoin = new Map(peakRows.map((r) => [r.coin_id, r]));

  const bucketIndex = collapseBucketIndex(nowMs - startMs);
  const priorDeaths = await deathCount(client, cycle.cycle_id);

  const executed = [];
  for (const coin of survivors) {
    const coinId = coin.coin_id;
    const coinPrice = parseFloat(coin.current_price);
    const peaks = peaksByCoin.get(coinId);
    const recordedPeak = peaks && peaks.peak_price !== null ? parseFloat(peaks.peak_price) : 0;
    const recordedRecentPeak = peaks && peaks.recent_peak_price !== null ? parseFloat(peaks.recent_peak_price) : 0;
    const baseline = parseFloat(coin.cycle_baseline_price);
    const coinPeak = Math.max(baseline, recordedPeak);
    const sellPressure = tradePressureDomain.computeTradePressure({
      transactions: txsByCoin.get(coinId) || [],
      nowMs,
      config
    }).sellPressure;

    const inputs = buildCollapseRiskInputs({
      marketDrawdown,
      coinPrice,
      coinPeak,
      negativeEventSum: negativeEventSumByCoin.get(coinId) || 0,
      coinRecentPeak: Math.max(coinPrice, recordedRecentPeak),
      phaseModifier,
      sellPressure,
      lifecycleState,
      cycleProgress,
      config
    });
    const risk = computeCollapseRisk({ inputs, lifecycleState, config });
    if (risk <= 0) continue;
    const roll = drawCollapseRoll({ seed: cycle.seed, coinId, bucketIndex });
    if (roll >= risk) continue;

    await executeCollapse(client, cycle.cycle_id, coinId, priorDeaths + executed.length, nowDate);
    executed.push({ coin_id: coinId, collapse_rank: priorDeaths + executed.length, collapsed_at: nowDate });
  }
  return executed;
}

async function deathCount(client, cycleId) {
  const { rows } = await client.query(
    `SELECT count(*)::int AS n FROM apocalypse_coin_collapses WHERE cycle_id = $1`,
    [cycleId]
  );
  return rows[0].n;
}

// THE FINAL SAFETY RULE (gameplay_changes.md §22): every remaining coin is
// forced to exactly £0 at cycle end. Called by gameSettlementService
// .settleSettlingCycle INSIDE the Core 1 advisory-locked settlement
// transaction at exactly the cycle's end_time — before any participant
// value or result is read, so the last coin reaches £0 first, exactly like
// the retired controller's settlement reconciliation. Idempotent: only
// not-yet-dead coins are ever touched, so a settlement replay is a no-op.
async function executeRemainingCollapses(client, cycle, atTime, { config } = {}) {
  void config; // the safety rule is unconditional — no risk evaluation
  const atDate = atTime instanceof Date ? atTime : new Date(atTime);
  if (!Number.isFinite(atDate.getTime())) {
    throw new Error(`dynamic collapse requires a valid atTime; received ${String(atTime)}`);
  }
  const { rows: survivors } = await client.query(
    `SELECT c.coin_id
     FROM coins c
     WHERE c.retired = FALSE
       AND NOT EXISTS (
         SELECT 1 FROM apocalypse_coin_collapses cc
         WHERE cc.cycle_id = $1 AND cc.coin_id = c.coin_id
       )
     ORDER BY c.coin_id
     FOR UPDATE OF c`,
    [cycle.cycle_id]
  );
  const priorDeaths = await deathCount(client, cycle.cycle_id);
  const executed = [];
  for (const coin of survivors) {
    const rank = priorDeaths + executed.length;
    await executeCollapse(client, cycle.cycle_id, coin.coin_id, rank, atDate);
    executed.push({ coin_id: coin.coin_id, collapse_rank: rank, collapsed_at: atDate });
  }
  return executed;
}

module.exports = {
  COLLAPSE_EVALUATION_BUCKET_MS,
  CRASH_DAMAGE_WINDOW_MS,
  lifecycleStageInput,
  computeCollapseRisk,
  collapseBucketIndex,
  drawCollapseRoll,
  buildCollapseRiskInputs,
  restoreBaselinePrices,
  getCollapsedCoinIds,
  isCoinCollapsed,
  evaluateAndExecuteCollapses,
  executeRemainingCollapses
};
