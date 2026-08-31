// Crypto Chaos gameplay overhaul SIM-06/SIM-07: the market index and the
// hidden lifecycle state machine.
//
// SIM-06 (gameplay_changes.md §10/§13, build plan Stage 4): a single
// measurement of overall market health. The market index is the combined
// current value of all SURVIVING coins — the raw sum of the persisted
// coins.current_price over the active catalogue (retired coins excluded,
// migration 014) minus the cycle's executed collapses as recorded by the
// dynamic collapse authority (apocalypse_coin_collapses; death is
// never inferred from a zero price). The index is therefore deterministic
// from canonical persisted coin state in every process. This module never
// writes coin prices: it is a measurement, never a second price writer.
//
// Around the index the engine tracks:
//   * peak_index / peak_at — the monotonic cycle peak (only ever lifted,
//     persisted, so a restart can never reset it);
//   * drawdown  = (peak - current) / peak   (0 at a new high, 1 at £0);
//   * momentum  = (current - previous persisted evaluation) / previous
//     (0 when the previous evaluation was 0 — a zero base carries no
//     momentum signal).
//
// SIM-07 (gameplay_changes.md §7-13/§18-19, build plan Stage 5): the hidden
// lifecycle state machine. Transitions are pure, deterministic, and only
// ever in legal order — GROWTH -> PLATEAU -> DECLINE -> COLLAPSE, at most
// one step per evaluation, never backwards:
//   * GROWTH -> PLATEAU primarily when the actual index reaches the
//     generated peak region (plateau_target x (1 - plateauTolerance));
//     elapsed time is only a safety guard, never the sole trigger.
//   * PLATEAU -> DECLINE only when market behaviour confirms weakening
//     (drawdown past the struggle threshold AND negative momentum), with a
//     bounded late-cycle safety guard.
//   * DECLINE -> COLLAPSE under severe drawdown (the collapse-risk
//     threshold) or the bounded late-cycle guard. COLLAPSE is terminal.
// The plateau target is generated ONCE per cycle from the persisted Core 1
// seed (`${seed}:sim2-market-state:plateau-target`, SHA-256 counter mode —
// Math.random() is never used) and persisted; reconciliation observes it
// and never rerolls.
//
// Persistence: one row per cycle in apocalypse_market_state (migration
// 021), UNIQUE (cycle_id) as the idempotency backstop. All mutations run
// inside the caller's Core 1 advisory-locked transaction (lock key 727001):
// the database is the cross-process authority; there is no process-local
// lifecycle state and no timers.
//
// Wave 2 scope: the state is internal-only. Nothing here is exposed through
// public endpoints (no seed, target, lifecycle, or balancing internals —
// that is the Wave 5 / SIM-15..17 boundary), and nothing here feeds the
// price path yet (Wave 3 / SIM-08). This module never requires
// gameCycleService (no circular imports).

const db = require('../db/connection');
const { createSeededRandom } = require('./seededRandom');
const {
  LIFECYCLE_STATE_IDS,
  resolveSimulationConfig
} = require('./simulationConfig');

// Index/momentum values are persisted as NUMERIC(20, 8); rounding to 8
// decimal places keeps persisted rows byte-identical to a pure
// recomputation (restart-equivalent state). Sign-aware to mirror
// PostgreSQL's half-away-from-zero numeric rounding for negative momentum.
function round8(value) {
  return Math.sign(value) * Math.round(Math.abs(value) * 1e8) / 1e8;
}

function toMs(value, label) {
  const ms = (value instanceof Date ? value : new Date(value)).getTime();
  if (!Number.isFinite(ms)) {
    throw new Error(`market state engine requires a valid ${label}; received ${String(value)}`);
  }
  return ms;
}

function requireFiniteNonNegative(name, value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`market state engine requires ${name} to be a finite non-negative number; received ${typeof value === 'string' ? JSON.stringify(value) : String(value)}`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Pure, testable market measurements (no database, no clock, no globals).
// Same inputs -> identical values, in every process, forever.
// ---------------------------------------------------------------------------

// The market index: the combined current value of the surviving coins.
// `survivingCoins` must already exclude retired and collapsed coins (the
// persistence layer applies the canonical exclusion); each entry carries a
// numeric or numeric-string current_price. The index is a plain sum at 8dp
// — the simplest stable measure (build plan Stage 4) — and can never be
// NaN, Infinity, or negative: every component is validated.
function computeMarketIndex(survivingCoins) {
  if (!Array.isArray(survivingCoins)) {
    throw new Error('market index requires an array of surviving coins');
  }
  let sum = 0;
  for (const coin of survivingCoins) {
    const raw = coin.current_price;
    const price = typeof raw === 'string' ? parseFloat(raw) : raw;
    if (typeof price !== 'number' || !Number.isFinite(price) || price < 0) {
      throw new Error(`market index requires finite non-negative coin prices; coin ${String(coin.coin_id)} has ${String(raw)}`);
    }
    sum += price;
  }
  return round8(sum);
}

// Drawdown from the cycle peak: (peak - current) / peak. 0 at a new high,
// 1 when the market has fallen to £0. A zero peak (only possible for an
// empty/degenerate catalogue, where the starting index itself was 0) has
// no meaningful drawdown: 0 by definition. The caller maintains peak >=
// current; an inverted input is a contract violation, never silently
// clamped.
function computeDrawdown(peakIndex, currentIndex) {
  requireFiniteNonNegative('peakIndex', peakIndex);
  requireFiniteNonNegative('currentIndex', currentIndex);
  if (currentIndex > peakIndex) {
    throw new Error(`drawdown requires peakIndex >= currentIndex; received peak ${peakIndex}, current ${currentIndex}`);
  }
  if (peakIndex === 0) return 0;
  return round8((peakIndex - currentIndex) / peakIndex);
}

// Recent momentum: (current - previous persisted evaluation) / previous.
// Bounded below by -1 (a market can never lose more than 100% between
// evaluations). A zero previous evaluation carries no signal: 0.
function computeMomentum(previousIndex, currentIndex) {
  requireFiniteNonNegative('previousIndex', previousIndex);
  requireFiniteNonNegative('currentIndex', currentIndex);
  if (previousIndex === 0) return 0;
  return round8((currentIndex - previousIndex) / previousIndex);
}

// The per-cycle generated plateau target: startingIndex x a multiplier
// drawn from the configured range, seeded by the cycle's persisted Core 1
// seed. Pure: same seed + starting index -> identical target, in every
// process, forever. The persisted row is authoritative once written; this
// draw exists so tests can prove the persisted target equals the pure
// recomputation.
function drawPlateauTarget({ seed, startingIndex, config = resolveSimulationConfig() }) {
  requireFiniteNonNegative('startingIndex', startingIndex);
  const range = config.lifecycle.plateauTargetMultiplier;
  const rng = createSeededRandom(`${seed}:sim2-market-state:plateau-target`);
  const multiplier = range.min + rng() * (range.max - range.min);
  return round8(startingIndex * multiplier);
}

// The single-step lifecycle transition. Pure and deterministic from the
// persisted state plus the current measurements. Returns the existing
// state or the NEXT state in legal order — never a skip, never backwards:
//
//   GROWTH   -> PLATEAU   when the index reaches the generated peak region
//                         (plateauTarget x (1 - plateauTolerance)), or the
//                         late-cycle safety guard elapses. A zero target
//                         (degenerate empty catalogue) can never trigger
//                         the value path — time guards still advance it.
//   PLATEAU  -> DECLINE   when weakening is confirmed (drawdown past the
//                         struggle threshold AND negative momentum), or
//                         the bounded late-cycle guard elapses.
//   DECLINE  -> COLLAPSE  under severe drawdown (the collapse-risk
//                         threshold) or the bounded late-cycle guard.
//   COLLAPSE -> COLLAPSE  (structurally terminal).
//
// cycleProgress is the elapsed fraction of the cycle window in [0, 1]
// (the caller clamps it). All measurements must be finite; drawdown is in
// [0, 1]; indexes and the target are non-negative.
function nextLifecycleState({
  lifecycleState,
  currentIndex,
  peakIndex,
  drawdown,
  momentum,
  plateauTarget,
  cycleProgress,
  config = resolveSimulationConfig()
}) {
  if (!LIFECYCLE_STATE_IDS.includes(lifecycleState)) {
    throw new Error(`unknown lifecycle state ${JSON.stringify(lifecycleState)}; expected one of ${LIFECYCLE_STATE_IDS.join(', ')}`);
  }
  requireFiniteNonNegative('currentIndex', currentIndex);
  requireFiniteNonNegative('peakIndex', peakIndex);
  requireFiniteNonNegative('plateauTarget', plateauTarget);
  if (typeof drawdown !== 'number' || !Number.isFinite(drawdown) || drawdown < 0 || drawdown > 1) {
    throw new Error(`drawdown must be a fraction in [0, 1]; received ${String(drawdown)}`);
  }
  if (typeof momentum !== 'number' || !Number.isFinite(momentum)) {
    throw new Error(`momentum must be a finite number; received ${String(momentum)}`);
  }
  if (typeof cycleProgress !== 'number' || !Number.isFinite(cycleProgress) || cycleProgress < 0 || cycleProgress > 1) {
    throw new Error(`cycleProgress must be a fraction in [0, 1]; received ${String(cycleProgress)}`);
  }

  const lc = config.lifecycle;
  switch (lifecycleState) {
    case 'GROWTH': {
      const regionLow = plateauTarget * (1 - lc.plateauTolerance);
      if (plateauTarget > 0 && currentIndex >= regionLow) return 'PLATEAU';
      if (cycleProgress >= lc.plateauEntryProgressGuard) return 'PLATEAU';
      return 'GROWTH';
    }
    case 'PLATEAU':
      if (drawdown >= lc.drawdownThresholds.struggle && momentum < 0) return 'DECLINE';
      if (cycleProgress >= lc.declineEntryProgressGuard) return 'DECLINE';
      return 'PLATEAU';
    case 'DECLINE':
      if (drawdown >= lc.drawdownThresholds.collapseRisk) return 'COLLAPSE';
      if (cycleProgress >= lc.collapseEntryProgressGuard) return 'COLLAPSE';
      return 'DECLINE';
    default:
      return 'COLLAPSE'; // terminal: no transition out of COLLAPSE
  }
}

// ---------------------------------------------------------------------------
// Persistence + reconciliation. Every mutation takes the caller's Core 1
// advisory-locked transaction client; reads accept any queryable.
// ---------------------------------------------------------------------------

async function getCycleMarketState(queryable = db, cycleId) {
  const { rows } = await queryable.query(
    `SELECT state_id, cycle_id, starting_index, current_index, peak_index,
            peak_at, drawdown, momentum, lifecycle_state, plateau_target,
            last_evaluated_at, created_at, updated_at
     FROM apocalypse_market_state
     WHERE cycle_id = $1`,
    [cycleId]
  );
  return rows.length > 0 ? rows[0] : null;
}

// The canonical surviving coin state for the index: persisted current
// prices of the active catalogue (retired coins excluded, migration 014)
// minus this cycle's persisted deaths, read from the dynamic collapse
// authority (apocalypse_coin_collapses — never inferred from a zero
// price). Canonical coin_id order.
async function getSurvivingCoins(client, cycleId) {
  const { rows } = await client.query(
    `SELECT c.coin_id, c.current_price
     FROM coins c
     WHERE c.retired = FALSE
       AND NOT EXISTS (
         SELECT 1 FROM apocalypse_coin_collapses cc
         WHERE cc.cycle_id = $1 AND cc.coin_id = c.coin_id
       )
     ORDER BY c.coin_id`,
    [cycleId]
  );
  return rows;
}

// Scaled-integer comparison at the persisted precision: NUMERIC(20, 8)
// values round-tripped through parseFloat can differ from a freshly rounded
// draw by sub-representational noise, so "new high" decisions compare at
// the 1e-8 integer scale.
function scale8(value) {
  return Math.round(value * 1e8);
}

// Create or advance the cycle's durable market state. Called by
// gameCycleService.ensureActiveCycle INSIDE the Core 1 advisory-locked
// cycle transaction (lock key 727001) — at cycle creation and on every
// later reconciliation of a live cycle.
//
// Idempotent under repeated calls and restarts: the persisted row is
// observed (SELECT ... FOR UPDATE), the plateau target is drawn once and
// never rerolled, the peak is only ever lifted, and the lifecycle advances
// at most one legal step per evaluation. INSERT ... ON CONFLICT (cycle_id)
// DO NOTHING is the backstop when a row appears concurrently (only possible
// without the advisory lock): the persisted row wins, never our draw.
//
// Returns the current persisted row (after any update).
async function ensureMarketState(client, cycle, now, { config = resolveSimulationConfig() } = {}) {
  const nowMs = toMs(now, 'now');
  const nowDate = new Date(nowMs);
  const startMs = toMs(cycle.start_time, 'cycle.start_time');
  const endMs = toMs(cycle.end_time, 'cycle.end_time');
  if (endMs <= startMs) {
    throw new Error(`market state requires the cycle end after its start; received ${cycle.start_time} .. ${cycle.end_time}`);
  }
  // The elapsed fraction of the cycle window, clamped to [0, 1] (a chained
  // cycle recovered after long downtime can be evaluated past its end).
  const cycleProgress = Math.min(1, Math.max(0, (nowMs - startMs) / (endMs - startMs)));

  // The measurement: deterministic from the canonical surviving coin state.
  const survivors = await getSurvivingCoins(client, cycle.cycle_id);
  const currentIndex = computeMarketIndex(survivors);

  let { rows } = await client.query(
    `SELECT state_id, cycle_id, starting_index, current_index, peak_index,
            peak_at, drawdown, momentum, lifecycle_state, plateau_target,
            last_evaluated_at, created_at, updated_at
     FROM apocalypse_market_state
     WHERE cycle_id = $1
     FOR UPDATE`,
    [cycle.cycle_id]
  );

  if (rows.length === 0) {
    // First evaluation: open the cycle's state. Growth, at the starting
    // index, peak = current, no drawdown, no momentum yet; the plateau
    // target is drawn once from the cycle's persisted seed.
    const plateauTarget = drawPlateauTarget({ seed: cycle.seed, startingIndex: currentIndex, config });
    const { rows: inserted } = await client.query(
      `INSERT INTO apocalypse_market_state
         (cycle_id, starting_index, current_index, peak_index, peak_at,
          drawdown, momentum, lifecycle_state, plateau_target, last_evaluated_at)
       VALUES ($1, $2, $2, $2, $3, 0, 0, 'GROWTH', $4, $3)
       ON CONFLICT (cycle_id) DO NOTHING
       RETURNING state_id, cycle_id, starting_index, current_index, peak_index,
                 peak_at, drawdown, momentum, lifecycle_state, plateau_target,
                 last_evaluated_at, created_at, updated_at`,
      [cycle.cycle_id, currentIndex, nowDate.toISOString(), plateauTarget]
    );
    if (inserted.length > 0) return inserted[0];

    // Another writer committed the row first (only possible without the
    // advisory lock): observe the persisted row instead of our draw — the
    // database is the authority, never reroll.
    ({ rows } = await client.query(
      `SELECT state_id, cycle_id, starting_index, current_index, peak_index,
              peak_at, drawdown, momentum, lifecycle_state, plateau_target,
              last_evaluated_at, created_at, updated_at
       FROM apocalypse_market_state
       WHERE cycle_id = $1
       FOR UPDATE`,
      [cycle.cycle_id]
    ));
    if (rows.length === 0) {
      throw new Error(`market state row for cycle ${cycle.cycle_id} vanished during reconciliation; aborting`);
    }
  }

  const persisted = rows[0];
  const previousIndex = parseFloat(persisted.current_index);
  const persistedPeak = parseFloat(persisted.peak_index);

  // Monotonic peak: lift only on a genuine new high at persisted precision.
  const newHigh = scale8(currentIndex) > scale8(persistedPeak);
  const peakIndex = newHigh ? currentIndex : persistedPeak;
  const peakAt = newHigh ? nowDate : persisted.peak_at;

  const drawdown = computeDrawdown(peakIndex, currentIndex);
  const momentum = computeMomentum(previousIndex, currentIndex);
  const lifecycleState = nextLifecycleState({
    lifecycleState: persisted.lifecycle_state,
    currentIndex,
    peakIndex,
    drawdown,
    momentum,
    plateauTarget: parseFloat(persisted.plateau_target),
    cycleProgress,
    config
  });

  const { rows: updated } = await client.query(
    `UPDATE apocalypse_market_state
       SET current_index = $2,
           peak_index = $3,
           peak_at = $4,
           drawdown = $5,
           momentum = $6,
           lifecycle_state = $7,
           last_evaluated_at = $8,
           updated_at = now()
     WHERE state_id = $1
     RETURNING state_id, cycle_id, starting_index, current_index, peak_index,
               peak_at, drawdown, momentum, lifecycle_state, plateau_target,
               last_evaluated_at, created_at, updated_at`,
    [
      persisted.state_id,
      currentIndex,
      peakIndex,
      (peakAt instanceof Date ? peakAt : new Date(peakAt)).toISOString(),
      drawdown,
      momentum,
      lifecycleState,
      nowDate.toISOString()
    ]
  );
  return updated[0];
}

module.exports = {
  computeMarketIndex,
  computeDrawdown,
  computeMomentum,
  drawPlateauTarget,
  nextLifecycleState,
  getCycleMarketState,
  ensureMarketState
};
