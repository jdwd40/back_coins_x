// Crypto Chaos gameplay overhaul SIM-05: the market phase engine.
//
// The overall market moves through temporary phases — Golden Age, Boom,
// Bull, Bear, Bust, Recession (gameplay_changes.md §5-6, build plan Stage
// 3). Exactly ONE primary phase covers any instant of a cycle. Each phase
// has a randomized strength (modifier) and duration drawn from its
// configured ranges, and phase selection is weighted by the hidden lifecycle
// state (growth favours positive phases, decline favours negative ones,
// while every group stays possible in every state — Rule 8: believable
// hope late in the game).
//
// Persistence/recovery: phases form a contiguous chain per cycle — phase
// N+1 starts exactly at phase N's ends_at — persisted in
// apocalypse_market_phases with UNIQUE (cycle_id, phase_seq) as the
// identity backstop. Contiguity plus the unique chain position makes two
// overlapping primary phases impossible by construction, across restarts,
// reconciliations and any number of processes (all mutations run inside
// the caller's Core 1 advisory-locked transaction, lock key 727001).
// Coverage is extended lazily up to `now`: each phase's draw is a pure
// function of (cycle seed, phase_seq, lifecycle state), keyed
// `${seed}:sim1-market-phases:phase:<seq>` — deterministic in every
// process, never Math.random(), and never rerolled once persisted.
//
// Wave 1 scope: the lifecycle engine does not exist yet (SIM-07, Wave 2),
// so the engine is wired with the constant GROWTH lifecycle state; the
// selection functions already accept every lifecycle state and are tested
// against all of them. Phase state is internal-only: no public endpoint
// exposes it (Wave 5 / SIM-15..17), and nothing here feeds the price path
// yet (Wave 3 / SIM-08). This module never requires gameCycleService (no
// circular imports) and owns no timers.

const db = require('../db/connection');
const { createSeededRandom } = require('./seededRandom');
const {
  MARKET_PHASE_IDS,
  LIFECYCLE_STATE_IDS,
  resolveSimulationConfig
} = require('./simulationConfig');

function toMs(value, label) {
  const ms = (value instanceof Date ? value : new Date(value)).getTime();
  if (!Number.isFinite(ms)) {
    throw new Error(`market phase engine requires a valid ${label}; received ${String(value)}`);
  }
  return ms;
}

// Modifiers are persisted as NUMERIC(12, 8); rounding to 8 decimal places in
// the pure draw keeps persisted rows byte-identical to a pure recomputation
// (restart-equivalent state). Sign-aware to mirror PostgreSQL's
// half-away-from-zero numeric rounding for negative modifiers.
function round8(value) {
  return Math.sign(value) * Math.round(Math.abs(value) * 1e8) / 1e8;
}

// ---------------------------------------------------------------------------
// Pure, testable phase selection (no database, no clock, no globals).
// ---------------------------------------------------------------------------

// Draw one phase from a lifecycle state's normalised weight set, iterating
// the canonical MARKET_PHASE_IDS order. Pure function of the draw value.
function selectPhaseFromWeights(draw, weights) {
  if (typeof draw !== 'number' || !Number.isFinite(draw) || draw < 0 || draw >= 1) {
    throw new Error(`phase selection draw must be in [0, 1); received ${String(draw)}`);
  }
  let cumulative = 0;
  for (const id of MARKET_PHASE_IDS) {
    cumulative += weights[id];
    if (draw < cumulative) return id;
  }
  return MARKET_PHASE_IDS[MARKET_PHASE_IDS.length - 1];
}

// The deterministic draw for one chain position: phase id, signed modifier
// and duration are pure functions of (seed, phaseSeq, lifecycleState). The
// three stream draws are consumed in a fixed order (selection, modifier,
// duration) so the result is stable in every process, forever.
function drawPhaseAt({ seed, phaseSeq, lifecycleState, config = resolveSimulationConfig() }) {
  if (!Number.isInteger(phaseSeq) || phaseSeq < 1) {
    throw new Error(`phase sequence must be a positive integer; received ${String(phaseSeq)}`);
  }
  if (!LIFECYCLE_STATE_IDS.includes(lifecycleState)) {
    throw new Error(`unknown lifecycle state ${JSON.stringify(lifecycleState)}; expected one of ${LIFECYCLE_STATE_IDS.join(', ')}`);
  }
  const weights = config.marketPhases.lifecycleWeights[lifecycleState];
  const rng = createSeededRandom(`${seed}:sim1-market-phases:phase:${phaseSeq}`);
  const phase = selectPhaseFromWeights(rng(), weights);
  const def = config.marketPhases.phases[phase];
  const modifier = round8(def.modifier.min + rng() * (def.modifier.max - def.modifier.min));
  const durationMs = Math.round(def.durationMs.min + rng() * (def.durationMs.max - def.durationMs.min));
  return { phase, modifier, durationMs, lifecycleState };
}

// Build the contiguous primary-phase chain covering [startTime, endTime) for
// a constant lifecycle state. Phase windows may nominally extend past the
// cycle end — the cycle window dominates every read, and the chain simply
// stops being extended once the cycle is over. Returns rows in phase_seq
// order. Pure: same inputs -> identical chain in every process.
function buildPhaseChain({ seed, startTime, endTime, lifecycleState, config = resolveSimulationConfig() }) {
  const startMs = toMs(startTime, 'startTime');
  const endMs = toMs(endTime, 'endTime');
  if (endMs <= startMs) {
    throw new Error(`phase chain requires endTime after startTime; received ${startTime} .. ${endTime}`);
  }
  const rows = [];
  let seq = 1;
  let cursor = startMs;
  while (cursor < endMs) {
    const drawn = drawPhaseAt({ seed, phaseSeq: seq, lifecycleState, config });
    rows.push({
      phase_seq: seq,
      phase: drawn.phase,
      lifecycle_state: drawn.lifecycleState,
      modifier: drawn.modifier,
      starts_at: new Date(cursor),
      ends_at: new Date(cursor + drawn.durationMs)
    });
    cursor += drawn.durationMs;
    seq += 1;
  }
  return rows;
}

// The phase covering `now` from a chain (pure rows or database rows), or
// null when no row covers the instant.
function getPhaseAt(phases, now) {
  const nowMs = toMs(now, 'now');
  const covering = phases
    .filter((p) => toMs(p.starts_at, 'starts_at') <= nowMs && nowMs < toMs(p.ends_at, 'ends_at'))
    .sort((a, b) => a.phase_seq - b.phase_seq);
  return covering.length > 0 ? covering[covering.length - 1] : null;
}

// ---------------------------------------------------------------------------
// Persistence + reconciliation. Every function takes the caller's Core 1
// advisory-locked transaction client (or a plain queryable for reads).
// ---------------------------------------------------------------------------

async function getCycleMarketPhases(queryable = db, cycleId) {
  const { rows } = await queryable.query(
    `SELECT phase_id, cycle_id, phase_seq, phase, lifecycle_state, modifier,
            starts_at, ends_at, created_at
     FROM apocalypse_market_phases
     WHERE cycle_id = $1
     ORDER BY phase_seq`,
    [cycleId]
  );
  return rows;
}

// Ensure the cycle's persisted primary-phase chain covers `now`, extending
// it deterministically (one phase at a time, each starting exactly at the
// predecessor's end) as far as needed — never past the cycle end. Called by
// gameCycleService.ensureActiveCycle INSIDE the Core 1 advisory-locked cycle
// transaction, both at cycle creation and on every later reconciliation of
// a live cycle.
//
// Idempotent under repeated calls and restarts: existing rows are observed
// and reused (INSERT ... ON CONFLICT DO NOTHING is the backstop), so a
// restart can neither reroll the active phase nor resurrect an expired one,
// and a reconcile/lookup can never create two overlapping primary phases.
//
// lifecycleState is the hidden lifecycle input for NEW draws only (Wave 1
// wires the constant 'GROWTH'; SIM-07 supplies the real state). Persisted
// rows are authoritative regardless of the current lifecycle input.
async function ensureMarketPhaseCoverage(client, cycle, now, { lifecycleState = 'GROWTH', config = resolveSimulationConfig() } = {}) {
  const nowMs = toMs(now, 'now');
  const startMs = toMs(cycle.start_time, 'cycle.start_time');
  const endMs = toMs(cycle.end_time, 'cycle.end_time');
  if (endMs <= startMs) {
    throw new Error(`market phase coverage requires the cycle end after its start; received ${cycle.start_time} .. ${cycle.end_time}`);
  }

  // Read the persisted chain. The caller's Core 1 advisory lock (727001)
  // serialises all chain mutations across processes, and the unique
  // (cycle_id, phase_seq) backstop plus the guarded insert below make a
  // duplicate or overlapping extension impossible even without it.
  const phases = await getCycleMarketPhases(client, cycle.cycle_id);

  const created = [];
  let latestSeq = phases.length > 0 ? Number(phases[phases.length - 1].phase_seq) : 0;
  let latestEndMs = phases.length > 0 ? toMs(phases[phases.length - 1].ends_at, 'ends_at') : startMs;

  // Extend the chain while the persisted tail does not cover `now` (and the
  // cycle window still has room). Bounded: every phase has a positive
  // minimum duration, so each iteration strictly advances latestEndMs.
  while (latestEndMs <= nowMs && latestEndMs < endMs) {
    const nextSeq = latestSeq + 1;
    const drawn = drawPhaseAt({ seed: cycle.seed, phaseSeq: nextSeq, lifecycleState, config });
    const { rows: inserted } = await client.query(
      `INSERT INTO apocalypse_market_phases
         (cycle_id, phase_seq, phase, lifecycle_state, modifier, starts_at, ends_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (cycle_id, phase_seq) DO NOTHING
       RETURNING phase_seq, ends_at`,
      [
        cycle.cycle_id,
        nextSeq,
        drawn.phase,
        drawn.lifecycleState,
        drawn.modifier,
        new Date(latestEndMs).toISOString(),
        new Date(latestEndMs + drawn.durationMs).toISOString()
      ]
    );
    if (inserted.length > 0) {
      latestEndMs = toMs(inserted[0].ends_at, 'ends_at');
      created.push(nextSeq);
    } else {
      // Another writer committed this chain position first (only possible
      // without the advisory lock): observe the persisted row instead of
      // our draw — the database is the authority, never reroll.
      const { rows: existing } = await client.query(
        `SELECT phase_seq, ends_at FROM apocalypse_market_phases
         WHERE cycle_id = $1 AND phase_seq = $2`,
        [cycle.cycle_id, nextSeq]
      );
      if (existing.length === 0) {
        throw new Error(`market phase chain row (cycle ${cycle.cycle_id}, seq ${nextSeq}) vanished during reconciliation; aborting`);
      }
      latestEndMs = toMs(existing[0].ends_at, 'ends_at');
    }
    latestSeq = nextSeq;
  }

  const all = created.length > 0 || phases.length === 0
    ? await getCycleMarketPhases(client, cycle.cycle_id)
    : phases;
  return { phases: all, current: getPhaseAt(all, nowMs), created };
}

// Internal read: the cycle's primary phase covering `now` (or null). Wave 1
// keeps this shape internal — no public endpoint consumes it.
async function getCurrentMarketPhase(queryable = db, cycleId, now) {
  const nowDate = now instanceof Date ? now : new Date(now);
  const { rows } = await queryable.query(
    `SELECT phase_id, cycle_id, phase_seq, phase, lifecycle_state, modifier,
            starts_at, ends_at
     FROM apocalypse_market_phases
     WHERE cycle_id = $1 AND starts_at <= $2 AND ends_at > $2
     ORDER BY phase_seq DESC
     LIMIT 1`,
    [cycleId, nowDate.toISOString()]
  );
  return rows.length > 0 ? rows[0] : null;
}

module.exports = {
  selectPhaseFromWeights,
  drawPhaseAt,
  buildPhaseChain,
  getPhaseAt,
  getCycleMarketPhases,
  ensureMarketPhaseCoverage,
  getCurrentMarketPhase
};
