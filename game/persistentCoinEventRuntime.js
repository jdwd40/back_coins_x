// Director Coin Events Wave 3: the persistent coin-event RUNTIME — the
// reconciliation seam that makes the Wave 1 persistent event authority
// (persistent_coin_events, migration 029) and the Wave 2 adaptive Director
// (director_control_state) load-bearing in the persistent market writer.
//
// Two pure halves plus one transactional database wrapper:
//
//   * planCoinEventPayload (PURE) — the deterministic payload for one
//     stable event identity. Draws come from the project seeded RNG
//     (game/seededRandom.createSeededRandom) keyed by stable
//     world/coin/decision/event-sequence inputs:
//       `${worldSeed}:persistent-coin-events:world:${worldId}:coin:${coinId}:decision:${decisionIndex}:seq:${eventSeq}`
//     so a restarted/replayed reconciliation regenerates the IDENTICAL
//     payload for an identity and the Wave 1 model's idempotent insert is
//     a write-free no-op. No Math.random(), no wall-clock reads, no
//     database access.
//
//   * reconcileCoinEventTargets (PURE) — given one coin's ACTIVE events at
//     an injected instant, its highest committed event sequence and the
//     planner's target counts (game/adaptiveDirectorEventPlan.js output —
//     this module never duplicates planner policy), compute ONLY the
//     missing events, clamped to the Wave 1 configured caps
//     (persistentEvents.maxActivePerCoin and the per-direction caps).
//     Already-active events are left untouched; surplus actives are never
//     trimmed (they expire historically); inputs are never mutated.
//     Creation order is canonical: POSITIVE first, then NEGATIVE, with
//     sequence numbers allocated monotonically after the ledger maximum.
//
//   * reconcilePersistentCoinEvents (DATABASE) — the writer-batch wrapper:
//     loads the world's active events and per-coin sequence maxima on the
//     CALLER'S client (participating in the writer batch transaction —
//     never a nested transaction), runs the pure reconcile per planned
//     coin and inserts each missing event through the Wave 1 model
//     (models/persistentCoinEvents.model.js), whose coin-row lock
//     serialises concurrent creation and whose UNIQUE identity backstop
//     makes replay a no-op and a divergent payload a loud failure.
//
// Lifecycle contract (Wave 3 brief): reconciliation operates only on the
// coins the planner planned for (the adaptive Director observation's live
// roster — ALIVE, non-retired persistent state rows). DEAD coins are never
// planned, never receive new events and are never revived; a dead coin's
// events simply expire as history. Replacement coins join the observation
// with fresh state rows and receive fresh, independent coverage through
// this same normal reconciliation. Nothing here updates, deletes, rewrites
// or transfers event rows, and nothing here touches apocalypse_* tables or
// the cycle event engine (game/coinEventEngine.js).

const { createSeededRandom } = require('./seededRandom');
const {
  resolveSimulationConfig,
  COIN_EVENT_DIRECTION_IDS,
  DIRECTOR_CONTROL_MODE_IDS
} = require('./simulationConfig');
const eventsModel = require('../models/persistentCoinEvents.model');

// Flavour vocabulary only (mirroring the game-design-constant convention of
// the cycle engine's event names): names carry no gameplay effect beyond
// readability, so they live here rather than in simulationConfig.
const POSITIVE_EVENT_NAMES = Object.freeze([
  'Director Spotlight',
  'Institutional Accumulation',
  'Viral Momentum',
  'Strategic Partnership',
  'Protocol Upgrade Hype',
  'Whale Confidence',
  'Listing Optimism',
  'Community Rally'
]);

const NEGATIVE_EVENT_NAMES = Object.freeze([
  'Director Caution',
  'Profit-Taking Wave',
  'Security FUD',
  'Liquidity Scare',
  'Developer Walkout Rumour',
  'Regulatory Jitters',
  'Whale Distribution',
  'Confidence Wobble'
]);

// Modifiers persist as NUMERIC(12, 8); the sign-aware 8-decimal rounding
// convention (identical to the cycle engine's) keeps pure recomputation
// byte-identical to the persisted row (PostgreSQL rounds half away from
// zero; Math.round alone rounds halves toward +Infinity).
function round8(value) {
  return Math.sign(value) * Math.round(Math.abs(value) * 1e8) / 1e8;
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function assertFiniteNumber(label, value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`persistent coin event runtime ${label} must be a finite number; received ${String(value)}`);
  }
}

function assertPositiveInteger(label, value) {
  if (!Number.isInteger(Number(value)) || Number(value) <= 0) {
    throw new Error(`persistent coin event runtime ${label} must be a positive integer; received ${String(value)}`);
  }
}

function assertDirection(direction) {
  if (!COIN_EVENT_DIRECTION_IDS.includes(direction)) {
    throw new Error(`persistent coin event runtime direction must be one of ${COIN_EVENT_DIRECTION_IDS.join(', ')}; received ${JSON.stringify(direction)}`);
  }
}

function assertRole(role) {
  if (role !== null && role !== undefined && role !== 'GOLDEN' && role !== 'DEMON') {
    throw new Error(`persistent coin event runtime role must be null, GOLDEN or DEMON; received ${JSON.stringify(role)}`);
  }
}

function assertMode(mode) {
  if (!DIRECTOR_CONTROL_MODE_IDS.includes(mode)) {
    throw new Error(`persistent coin event runtime decision mode must be one of ${DIRECTOR_CONTROL_MODE_IDS.join(', ')}; received ${JSON.stringify(mode)}`);
  }
}

function assertSeverityScale(eventSeverityScale) {
  assertFiniteNumber('eventSeverityScale', eventSeverityScale);
  if (eventSeverityScale <= 0) {
    throw new Error(`persistent coin event runtime eventSeverityScale must be positive; received ${String(eventSeverityScale)}`);
  }
}

// The deterministic payload for one stable persistent event identity.
// Options:
//   worldSeed/worldId    persistent world identity (RNG key + row scope)
//   coinId               catalogue coin id
//   eventSeq             the coin's per-world sequence number (>= 1)
//   decisionIndex        the committed/current Director decision cursor the
//                        reconciliation ran under (part of the RNG key)
//   direction            POSITIVE or NEGATIVE (the planner's missing side)
//   role                 planner role: GOLDEN | DEMON | null
//   mode                 the decision mode (NORMAL/BOOM/BUST/RESCUE) —
//                        decides the source when no role stands
//   eventSeverityScale   the bounded macro environment severity scale
//                        (marketEnvironment eventSeverityScale; default 1)
//   nowMs                the injected creation instant (startsAt)
//   config               resolved simulation config
// Returns the Wave 1 model event shape (startsAt/endsAt as ISO strings).
function planCoinEventPayload({
  worldSeed,
  worldId,
  coinId,
  eventSeq,
  decisionIndex,
  direction,
  role = null,
  mode,
  eventSeverityScale = 1,
  nowMs,
  config = resolveSimulationConfig()
}) {
  if (typeof worldSeed !== 'string' || worldSeed.length === 0) {
    throw new Error('persistent coin event runtime worldSeed must be a non-empty string');
  }
  assertPositiveInteger('worldId', worldId);
  assertPositiveInteger('coinId', coinId);
  if (!Number.isInteger(eventSeq) || eventSeq < 1) {
    throw new Error(`persistent coin event runtime eventSeq must be a positive integer; received ${String(eventSeq)}`);
  }
  if (!Number.isInteger(decisionIndex) || decisionIndex < 0) {
    throw new Error(`persistent coin event runtime decisionIndex must be a non-negative integer; received ${String(decisionIndex)}`);
  }
  assertDirection(direction);
  assertRole(role);
  assertMode(mode);
  assertSeverityScale(eventSeverityScale);
  assertFiniteNumber('nowMs', nowMs);
  if (!config || !config.persistentEvents) {
    throw new Error('persistent coin event runtime requires a validated config with a persistentEvents section');
  }

  // The event's source: a standing planner role marks the event GOLDEN or
  // DEMON; otherwise the decision mode maps to NORMAL market events,
  // RESCUE interventions or DIRECTOR broad swings (BOOM/BUST).
  const source = role === 'GOLDEN' ? 'GOLDEN'
    : role === 'DEMON' ? 'DEMON'
      : mode === 'RESCUE' ? 'RESCUE'
        : mode === 'NORMAL' ? 'NORMAL'
          : 'DIRECTOR';

  const pe = config.persistentEvents;
  const rng = createSeededRandom(
    `${worldSeed}:persistent-coin-events:world:${Number(worldId)}:coin:${Number(coinId)}:decision:${decisionIndex}:seq:${eventSeq}`
  );
  // Fixed draw order: severity, duration, name.
  const severityDraw = rng();
  const durationDraw = rng();
  const nameDraw = rng();

  // The signed individual modifier: a seeded draw scaled by the bounded
  // macro severity scale, hard-clamped to the configured individual bound
  // and snapped to the persisted 8-decimal grid. A draw that rounds to
  // zero is lifted to one grid quantum so the direction-matched sign
  // constraint always holds.
  const magnitude = Math.min(
    pe.maxIndividualModifier,
    round8(severityDraw * pe.maxIndividualModifier * eventSeverityScale)
  );
  const bounded = magnitude <= 0 ? 0.00000001 : magnitude;
  const modifier = direction === 'POSITIVE' ? bounded : -bounded;

  const durationMs = Math.round(
    pe.durationMs.min + durationDraw * (pe.durationMs.max - pe.durationMs.min)
  );
  const names = direction === 'POSITIVE' ? POSITIVE_EVENT_NAMES : NEGATIVE_EVENT_NAMES;
  const name = names[Math.floor(nameDraw * names.length)];

  return {
    worldId: Number(worldId),
    coinId: Number(coinId),
    eventSeq,
    name,
    direction,
    source,
    modifier,
    startsAt: iso(nowMs),
    endsAt: iso(nowMs + durationMs)
  };
}

function eventCoinIdOf(event) {
  const value = event.coinId !== undefined ? event.coinId : event.coin_id;
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`persistent coin event runtime active event carries no usable coin id; received ${String(value)}`);
  }
  return n;
}

function eventDirectionOf(event) {
  const direction = event.direction;
  if (!COIN_EVENT_DIRECTION_IDS.includes(direction)) {
    throw new Error(`persistent coin event runtime active event direction must be one of ${COIN_EVENT_DIRECTION_IDS.join(', ')}; received ${JSON.stringify(direction)}`);
  }
  return direction;
}

// Reconcile ONE coin's active events to the planner's target counts at the
// injected instant. PURE: no database, no clock, no Math.random.
//
//   activeEvents   the coin's events ACTIVE at nowMs (either field shape);
//                  callers filter — expired rows must not be passed but DO
//                  anchor the sequence via maxEventSeq
//   maxEventSeq    the coin's highest committed event_seq (0 when none)
//   targetPositive/targetNegative — the planner's desired ACTIVE counts
//   role/reason    the planner entry's role/reason metadata (reason is
//                  audit context carried by the Director decision row; the
//                  event rows carry no reason column)
//   decision       { mode, decisionIndex } of the committed/current
//                  Director decision the plan was computed from
// Returns { created, counts } — created payloads in canonical order
// (POSITIVE then NEGATIVE, monotone sequence) and the pre-creation active
// direction counts.
function reconcileCoinEventTargets({
  activeEvents,
  maxEventSeq,
  coinId,
  targetPositive,
  targetNegative,
  role = null,
  reason = null,
  decision,
  worldSeed,
  worldId,
  eventSeverityScale = 1,
  nowMs,
  config = resolveSimulationConfig()
}) {
  if (!Array.isArray(activeEvents)) {
    throw new Error('persistent coin event runtime activeEvents must be an array');
  }
  assertPositiveInteger('coinId', coinId);
  for (const event of activeEvents) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      throw new Error('persistent coin event runtime active events must be event records');
    }
    if (eventCoinIdOf(event) !== Number(coinId)) {
      throw new Error(`persistent coin event runtime active event for coin ${eventCoinIdOf(event)} cannot be reconciled against coin ${coinId}`);
    }
    eventDirectionOf(event);
  }
  if (!Number.isInteger(maxEventSeq) || maxEventSeq < 0) {
    throw new Error(`persistent coin event runtime maxEventSeq must be a non-negative integer; received ${String(maxEventSeq)}`);
  }
  if (!Number.isInteger(targetPositive) || targetPositive < 0) {
    throw new Error(`persistent coin event runtime targetPositive must be a non-negative integer; received ${String(targetPositive)}`);
  }
  if (!Number.isInteger(targetNegative) || targetNegative < 0) {
    throw new Error(`persistent coin event runtime targetNegative must be a non-negative integer; received ${String(targetNegative)}`);
  }
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) {
    throw new Error('persistent coin event runtime decision must be an object');
  }
  assertMode(decision.mode);
  if (!Number.isInteger(decision.decisionIndex) || decision.decisionIndex < 0) {
    throw new Error(`persistent coin event runtime decisionIndex must be a non-negative integer; received ${String(decision.decisionIndex)}`);
  }
  assertRole(role);
  if (reason !== null && reason !== undefined && typeof reason !== 'string') {
    throw new Error('persistent coin event runtime reason must be a string or null');
  }
  if (typeof worldSeed !== 'string' || worldSeed.length === 0) {
    throw new Error('persistent coin event runtime worldSeed must be a non-empty string');
  }
  assertPositiveInteger('worldId', worldId);
  assertSeverityScale(eventSeverityScale);
  assertFiniteNumber('nowMs', nowMs);
  if (!config || !config.persistentEvents) {
    throw new Error('persistent coin event runtime requires a validated config with a persistentEvents section');
  }

  const counts = { positive: 0, negative: 0, total: 0 };
  for (const event of activeEvents) {
    if (eventDirectionOf(event) === 'POSITIVE') counts.positive += 1;
    else counts.negative += 1;
    counts.total += 1;
  }

  const pe = config.persistentEvents;
  // Only the MISSING count is ever created, clamped to the Wave 1
  // per-direction caps; already-active events (including any surplus over
  // a lowered target) are left to expire historically.
  const wantedPositive = Math.min(targetPositive, pe.maxActivePositivePerCoin);
  const wantedNegative = Math.min(targetNegative, pe.maxActiveNegativePerCoin);
  const missingPositive = Math.max(0, wantedPositive - counts.positive);
  const missingNegative = Math.max(0, wantedNegative - counts.negative);
  // The Wave 1 TOTAL cap bounds simultaneous actives: every active event
  // overlaps nowMs and every created event starts at nowMs, so creation
  // room is exactly the cap minus the current active total. Canonical
  // creation order fills POSITIVE first, then NEGATIVE.
  let room = Math.max(0, pe.maxActivePerCoin - counts.total);
  const createPositive = Math.min(missingPositive, room);
  room -= createPositive;
  const createNegative = Math.min(missingNegative, room);

  const created = [];
  let seq = maxEventSeq;
  for (let i = 0; i < createPositive; i += 1) {
    seq += 1;
    created.push(planCoinEventPayload({
      worldSeed, worldId, coinId, eventSeq: seq,
      decisionIndex: decision.decisionIndex,
      direction: 'POSITIVE', role, mode: decision.mode,
      eventSeverityScale, nowMs, config
    }));
  }
  for (let i = 0; i < createNegative; i += 1) {
    seq += 1;
    created.push(planCoinEventPayload({
      worldSeed, worldId, coinId, eventSeq: seq,
      decisionIndex: decision.decisionIndex,
      direction: 'NEGATIVE', role, mode: decision.mode,
      eventSeverityScale, nowMs, config
    }));
  }

  return { created, counts };
}

// The writer-batch reconciliation: bring every planned coin's active
// persistent events up to the planner's target counts, creating only the
// missing events through the Wave 1 model's idempotent, capacity-enforcing
// insert. Runs entirely on the caller's client inside the caller's open
// transaction (the writer batch): the model's per-coin catalogue row lock
// (already held by the batch) serialises concurrent creation, and the
// UNIQUE (world_id, coin_id, event_seq) backstop plus the model's
// identical-payload rule make same-batch replay a write-free no-op while a
// divergent payload at a committed identity fails loudly (never a silent
// overwrite or reroll).
//
// Returns a Map coinId -> that coin's ACTIVE events at nowMs AFTER
// reconciliation (prior actives plus the rows created here, in canonical
// starts/coin/sequence order) so the caller can compute the capped net
// modifier without a second read.
async function reconcilePersistentCoinEvents(client, {
  world,
  decision,
  plan,
  eventSeverityScale = 1,
  nowMs,
  config = resolveSimulationConfig()
}) {
  if (!client || typeof client.query !== 'function') {
    throw new Error('persistent coin event runtime reconciliation requires the caller transaction client');
  }
  if (!world || !Number.isInteger(Number(world.worldId)) || Number(world.worldId) <= 0
      || typeof world.seed !== 'string' || world.seed.length === 0) {
    throw new Error('persistent coin event runtime reconciliation requires a validated persistent world (worldId, seed)');
  }
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) {
    throw new Error('persistent coin event runtime reconciliation requires the committed/current Director decision');
  }
  assertMode(decision.mode);
  if (!Number.isInteger(decision.decisionIndex) || decision.decisionIndex < 0) {
    throw new Error(`persistent coin event runtime reconciliation decisionIndex must be a non-negative integer; received ${String(decision.decisionIndex)}`);
  }
  if (!Array.isArray(plan)) {
    throw new Error('persistent coin event runtime reconciliation plan must be an array');
  }
  assertSeverityScale(eventSeverityScale);
  assertFiniteNumber('nowMs', nowMs);
  if (!config || !config.persistentEvents) {
    throw new Error('persistent coin event runtime reconciliation requires a validated config with a persistentEvents section');
  }

  const worldId = Number(world.worldId);
  // The world's ACTIVE events at the injected instant (Wave 1 canonical
  // order) and each coin's highest committed sequence — expired history
  // anchors the sequence but never counts as active.
  const activeRows = await eventsModel.listActivePersistentCoinEvents(client, worldId, nowMs);
  const { rows: seqRows } = await client.query(
    `SELECT coin_id, MAX(event_seq) AS max_seq
       FROM persistent_coin_events
      WHERE world_id = $1
      GROUP BY coin_id`,
    [worldId]
  );
  const maxSeqByCoin = new Map(seqRows.map((row) => [Number(row.coin_id), Number(row.max_seq)]));
  const activeByCoin = new Map();
  for (const event of activeRows) {
    if (!activeByCoin.has(event.coinId)) activeByCoin.set(event.coinId, []);
    activeByCoin.get(event.coinId).push(event);
  }

  const result = new Map();
  for (const entry of plan) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('persistent coin event runtime reconciliation plan entries must be objects');
    }
    const coinId = Number(entry.coinId);
    if (!Number.isInteger(coinId) || coinId <= 0) {
      throw new Error(`persistent coin event runtime reconciliation plan coinId must be a positive integer; received ${String(entry && entry.coinId)}`);
    }
    const priorActive = activeByCoin.get(coinId) || [];
    const { created } = reconcileCoinEventTargets({
      activeEvents: priorActive,
      maxEventSeq: maxSeqByCoin.get(coinId) || 0,
      coinId,
      targetPositive: entry.targetPositive,
      targetNegative: entry.targetNegative,
      role: entry.role ?? null,
      reason: entry.reason ?? null,
      decision: { mode: decision.mode, decisionIndex: decision.decisionIndex },
      worldSeed: world.seed,
      worldId,
      eventSeverityScale,
      nowMs,
      config
    });
    const activeAfter = priorActive.slice();
    for (const payload of created) {
      const { event } = await eventsModel.insertPersistentCoinEvent(client, payload, { config });
      activeAfter.push(event);
    }
    // Canonical (starts_at, coin_id, event_seq) order — identical to the
    // Wave 1 model/domain ordering — so the modifier computation sees the
    // same ordering as a fresh active read.
    activeAfter.sort((a, b) =>
      (new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime())
      || (Number(a.coinId) - Number(b.coinId))
      || (Number(a.eventSeq) - Number(b.eventSeq)));
    result.set(coinId, activeAfter);
  }
  return result;
}

module.exports = {
  planCoinEventPayload,
  reconcileCoinEventTargets,
  reconcilePersistentCoinEvents
};
