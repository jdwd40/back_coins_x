// Director Coin Events Wave 2: the adaptive Director runtime seam.
//
// One evaluation of the adaptive Director control loop:
//   1. resolve THE active persistent world (game/persistentWorld);
//   2. load the committed Director control state through the Wave 1 model
//      (models/directorControlState.model.js — lock-free validated read);
//   3. build the bounded current-market observation
//      (game/adaptiveDirectorObservation.js — one pooled-client REPEATABLE
//      READ snapshot when handed the pool);
//   4. compute the next decision with the PURE domain
//      (game/adaptiveDirector.js);
//   5. persist through upsertDirectorControlState ONLY — the model owns
//      the world-row lock order, the monotone decision cursor, the
//      identical-replay no-op and the loud stale/conflict failures. This
//      module writes NO SQL of its own.
//
// Deliberately NOT wired into any worker: this is an explicit callable
// seam with full test coverage. A future wave may attach it to the
// persistent market cadence; doing so must not change this module's
// contract.
//
// Semantics:
//   * nowMs is the evaluation instant. Production callers pass the real
//     clock (the default is Date.now()); tests and simulations inject it.
//     All PURE layers below receive it explicitly — no hidden clock reads.
//   * Idempotency: a repeated evaluation at the same identity recomputes
//     the identical decision; the model's identical-replay rule makes the
//     persist a write-free no-op (outcome 'unchanged').
//   * Restart: the runtime holds NOTHING in memory; a fresh process reads
//     the one committed row and resumes it.
//   * Concurrency: concurrent evaluations race into the model's world-row
//     serialisation. A loser whose computed cursor went stale or conflicts
//     with the winner's committed decision is reported as 'superseded'
//     (the authoritative committed state is re-read and returned) — the
//     loud model failure is never swallowed into a rewrite.
//   * Scope: this module cannot create persistent_coin_events rows, change
//     prices, conditions, deaths, replacements, bots, or any public state.
//
// The `persist` parameter exists ONLY as a test/simulation interleaving
// seam; it defaults to the model's upsert and production callers never
// override it.

const defaultDb = require('../db/connection');
const persistentWorld = require('./persistentWorld');
const control = require('../models/directorControlState.model');
const { buildAdaptiveDirectorObservation } = require('./adaptiveDirectorObservation');
const { evaluateAdaptiveDirectorDecision } = require('./adaptiveDirector');
const { resolveSimulationConfig } = require('./simulationConfig');

async function runAdaptiveDirectorEvaluation({
  nowMs,
  db: queryable = defaultDb,
  config = resolveSimulationConfig(),
  persist = control.upsertDirectorControlState
} = {}) {
  const effectiveNowMs = nowMs === undefined ? Date.now() : nowMs;
  if (typeof effectiveNowMs !== 'number' || !Number.isFinite(effectiveNowMs)) {
    throw new Error(`adaptive director runtime nowMs must be finite; received ${String(nowMs)}`);
  }
  if (typeof persist !== 'function') {
    throw new Error('adaptive director runtime persist must be the control-state upsert function');
  }

  const world = await persistentWorld.resolveActiveWorld(queryable);
  const committed = await control.loadDirectorControlState(queryable, world.worldId);
  const observation = await buildAdaptiveDirectorObservation(queryable, {
    world,
    nowMs: effectiveNowMs,
    config
  });
  const { state, changed } = evaluateAdaptiveDirectorDecision({
    worldSeed: world.seed,
    nowMs: effectiveNowMs,
    controlState: committed,
    observation,
    config
  });
  const fullState = { ...state, worldId: world.worldId };

  try {
    await persist(queryable, fullState);
  } catch (error) {
    // The model's monotone-cursor loud failures: this evaluation computed
    // from a read that a concurrent winner has already advanced past. The
    // committed cursor is authoritative — re-read and report it.
    if (/stale|conflict/i.test(error && error.message ? error.message : '')) {
      const winner = await control.loadDirectorControlState(queryable, world.worldId);
      return { outcome: 'superseded', state: winner, rejected: fullState };
    }
    throw error;
  }
  return { outcome: changed ? 'committed' : 'unchanged', state: fullState };
}

module.exports = {
  runAdaptiveDirectorEvaluation
};
