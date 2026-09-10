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
// Wired into the persistent market writer batch as of Wave 3
// (models/market-simulator.js): the batch calls one evaluation per batch
// on its own transaction client with the pre-resolved world; the persisted
// control cursor makes in-window re-evaluations write-free no-ops, so the
// decision never advances before its committed window is due. The module's
// contract is unchanged by that integration.
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
//
// Wave 3 runtime-integration extensions (backward compatible):
//   * `world` — an optional PRE-RESOLVED active world (the persistent
//     writer resolves THE active world exactly once per batch and hands it
//     in). When omitted the runtime resolves it as before. A supplied
//     world is shape-validated; a wrong-identity world fails loudly.
//   * the result carries `observation` — the bounded current-market
//     observation the evaluation computed from — so the caller (the
//     writer batch) can plan event targets from the SAME snapshot without
//     a second read. Present on every outcome, including 'superseded'
//     (paired there with the authoritative winner state).
//   * handed a transaction client (`db`), every read/write participates
//     in the caller's transaction — no nested transactions, and no
//     Director state is read or written outside the caller's batch.

const defaultDb = require('../db/connection');
const persistentWorld = require('./persistentWorld');
const control = require('../models/directorControlState.model');
const { buildAdaptiveDirectorObservation } = require('./adaptiveDirectorObservation');
const { evaluateAdaptiveDirectorDecision } = require('./adaptiveDirector');
const { resolveSimulationConfig } = require('./simulationConfig');

function assertPreResolvedWorld(world) {
  if (!world || typeof world !== 'object' || Array.isArray(world)
      || !Number.isInteger(Number(world.worldId)) || Number(world.worldId) <= 0
      || typeof world.seed !== 'string' || world.seed.length === 0
      || !Number.isFinite(Number(world.epochStartedAtMs))) {
    throw new Error('adaptive director runtime world must be a validated persistent world (worldId, seed, epochStartedAtMs)');
  }
  return world;
}

async function runAdaptiveDirectorEvaluation({
  nowMs,
  db: queryable = defaultDb,
  config = resolveSimulationConfig(),
  persist = control.upsertDirectorControlState,
  world = null
} = {}) {
  const effectiveNowMs = nowMs === undefined ? Date.now() : nowMs;
  if (typeof effectiveNowMs !== 'number' || !Number.isFinite(effectiveNowMs)) {
    throw new Error(`adaptive director runtime nowMs must be finite; received ${String(nowMs)}`);
  }
  if (typeof persist !== 'function') {
    throw new Error('adaptive director runtime persist must be the control-state upsert function');
  }

  const resolvedWorld = world === null || world === undefined
    ? await persistentWorld.resolveActiveWorld(queryable)
    : assertPreResolvedWorld(world);
  const committed = await control.loadDirectorControlState(queryable, resolvedWorld.worldId);
  const observation = await buildAdaptiveDirectorObservation(queryable, {
    world: resolvedWorld,
    nowMs: effectiveNowMs,
    config
  });
  const { state, changed } = evaluateAdaptiveDirectorDecision({
    worldSeed: resolvedWorld.seed,
    nowMs: effectiveNowMs,
    controlState: committed,
    observation,
    config
  });
  const fullState = { ...state, worldId: resolvedWorld.worldId };

  try {
    await persist(queryable, fullState);
  } catch (error) {
    // The model's monotone-cursor loud failures: this evaluation computed
    // from a read that a concurrent winner has already advanced past. The
    // committed cursor is authoritative — re-read and report it.
    if (/stale|conflict/i.test(error && error.message ? error.message : '')) {
      const winner = await control.loadDirectorControlState(queryable, resolvedWorld.worldId);
      return { outcome: 'superseded', state: winner, rejected: fullState, observation };
    }
    throw error;
  }
  return { outcome: changed ? 'committed' : 'unchanged', state: fullState, observation };
}

module.exports = {
  runAdaptiveDirectorEvaluation
};
