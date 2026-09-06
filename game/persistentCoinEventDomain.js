// Director Coin Events Wave 1: pure domain helpers for persistent-world
// coin events (persistent_coin_events, migration 029).
//
// These are the PURE halves of the persistent event authority: given plain
// event records (database rows or fixtures) and an INJECTED instant, they
// compute the active set, the exact signed net modifier, the stack-capped
// net modifier and the active direction counts. Determinism contract: no
// Math.random(), no wall-clock reads, no database access — the same inputs
// always produce the same outputs, in every process, forever. Seeded
// generation of FUTURE events is a later wave's concern and will follow
// the createSeededRandom conventions; nothing here generates anything.
//
// This module never requires any database module and never touches any
// apocalypse_* table (the persistent world is the only authority).

const { resolveSimulationConfig, COIN_EVENT_DIRECTION_IDS } = require('./simulationConfig');

function toMs(value, label) {
  const ms = (value instanceof Date ? value : new Date(value)).getTime();
  if (!Number.isFinite(ms)) {
    throw new Error(`persistent coin event domain requires a valid ${label}; received ${String(value)}`);
  }
  return ms;
}

// Field access contract: the domain accepts BOTH the persisted model event
// shape (camelCase — the rowToEvent output of models/persistentCoinEvents:
// startsAt/endsAt/coinId/eventSeq) and raw snake_case database rows or
// fixtures (starts_at/ends_at/coin_id/event_seq). Accessors never mutate
// the input records; a record carrying neither spelling fails loudly in
// toMs/number validation below.
function eventField(event, camel, snake) {
  if (event[camel] !== undefined) return { value: event[camel], label: camel };
  return { value: event[snake], label: snake };
}

function eventStartsMs(event) {
  const { value, label } = eventField(event, 'startsAt', 'starts_at');
  return toMs(value, label);
}

function eventEndsMs(event) {
  const { value, label } = eventField(event, 'endsAt', 'ends_at');
  return toMs(value, label);
}

function eventInteger(event, camel, snake) {
  const { value, label } = eventField(event, camel, snake);
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`persistent coin event domain requires a numeric ${label}; received ${String(value)}`);
  }
  return n;
}

function eventCoinId(event) {
  return eventInteger(event, 'coinId', 'coin_id');
}

function eventSeq(event) {
  return eventInteger(event, 'eventSeq', 'event_seq');
}

function modifierOf(event) {
  const value = typeof event.modifier === 'string' ? parseFloat(event.modifier) : event.modifier;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`persistent coin event modifier must be a finite number; received ${String(event.modifier)}`);
  }
  return value;
}

// The events active at the INJECTED `now`: starts_at <= now < ends_at.
// Expired history contributes nothing (and is never deleted upstream);
// future events are not yet active. Canonically ordered by
// (starts_at, coin_id, event_seq). The input array is never mutated.
function filterActiveEvents(events, now) {
  if (!Array.isArray(events)) {
    throw new Error('persistent coin event domain events must be an array');
  }
  const nowMs = toMs(now, 'now');
  return events
    .filter((ev) => eventStartsMs(ev) <= nowMs && nowMs < eventEndsMs(ev))
    .sort((a, b) =>
      eventStartsMs(a) - eventStartsMs(b) ||
      eventCoinId(a) - eventCoinId(b) ||
      eventSeq(a) - eventSeq(b)
    );
}

// The EXACT signed net modifier of one event set at `now`, BEFORE any
// stack cap. Positive and negative events coexist and stack; expired and
// future events contribute nothing.
function netActiveModifierExact(events, now) {
  let sum = 0;
  for (const ev of filterActiveEvents(events, now)) {
    sum += modifierOf(ev);
  }
  return sum;
}

// Clamp a raw signed modifier to the configured stack cap
// (persistentEvents.maxNetModifier), symmetrically.
function capNetModifier(net, config = resolveSimulationConfig()) {
  if (typeof net !== 'number' || !Number.isFinite(net)) {
    throw new Error(`persistent coin event net modifier must be a finite number; received ${String(net)}`);
  }
  const cap = config.persistentEvents.maxNetModifier;
  return Math.max(-cap, Math.min(cap, net));
}

// The bounded active net modifier: the exact signed net clamped to the
// configured stack cap.
function netActiveModifierCapped(events, now, config = resolveSimulationConfig()) {
  return capNetModifier(netActiveModifierExact(events, now), config);
}

// Pure per-coin capacity verdict: would admitting `candidate` breach the
// configured active caps (persistentEvents.maxActivePerCoin and the
// per-direction caps) at ANY instant of the candidate's own window?
//
// Half-open semantics throughout: an event is active exactly when
// starts_at <= t < ends_at. Because concurrency only changes at event
// boundaries, the peak INSIDE the candidate window — with the candidate
// active across its whole window — is reached at the candidate's start or
// at the start of an existing event that begins strictly inside the
// candidate window. This matches the live-data invariant in
// db/verify-game-schema.js (concurrency measured at each event's
// starts_at).
//
// `existingEvents` are the coin's persisted events (either field shape);
// only events overlapping the candidate window can contribute. Inputs are
// never mutated; nothing is generated; no clock, no database.
function activeCapacityVerdict(existingEvents, candidate, config = resolveSimulationConfig()) {
  if (!Array.isArray(existingEvents)) {
    throw new Error('persistent coin event domain events must be an array');
  }
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new Error('persistent coin event capacity candidate must be an object');
  }
  if (!COIN_EVENT_DIRECTION_IDS.includes(candidate.direction)) {
    throw new Error(`persistent coin event capacity candidate direction must be one of ${COIN_EVENT_DIRECTION_IDS.join(', ')}; received ${JSON.stringify(candidate.direction)}`);
  }
  const candStart = eventStartsMs(candidate);
  const candEnd = eventEndsMs(candidate);
  if (candEnd <= candStart) {
    throw new Error('persistent coin event capacity candidate window must satisfy ends_at after starts_at');
  }
  const caps = config.persistentEvents;
  const relevant = existingEvents.filter(
    (ev) => eventStartsMs(ev) < candEnd && eventEndsMs(ev) > candStart
  );
  const instants = [candStart];
  for (const ev of relevant) {
    const s = eventStartsMs(ev);
    if (s > candStart && s < candEnd) instants.push(s);
  }
  const peak = { total: 0, positive: 0, negative: 0 };
  for (const t of instants) {
    let total = 1;
    let positive = candidate.direction === 'POSITIVE' ? 1 : 0;
    let negative = candidate.direction === 'NEGATIVE' ? 1 : 0;
    for (const ev of relevant) {
      if (eventStartsMs(ev) <= t && t < eventEndsMs(ev)) {
        total += 1;
        if (ev.direction === 'POSITIVE') positive += 1;
        else if (ev.direction === 'NEGATIVE') negative += 1;
        else {
          throw new Error(`persistent coin event direction must be POSITIVE or NEGATIVE; received ${JSON.stringify(ev.direction)}`);
        }
      }
    }
    peak.total = Math.max(peak.total, total);
    peak.positive = Math.max(peak.positive, positive);
    peak.negative = Math.max(peak.negative, negative);
  }
  const allowed =
    peak.total <= caps.maxActivePerCoin &&
    peak.positive <= caps.maxActivePositivePerCoin &&
    peak.negative <= caps.maxActiveNegativePerCoin;
  return {
    allowed,
    peak,
    caps: {
      maxActivePerCoin: caps.maxActivePerCoin,
      maxActivePositivePerCoin: caps.maxActivePositivePerCoin,
      maxActiveNegativePerCoin: caps.maxActiveNegativePerCoin
    }
  };
}

// The active direction counts at `now` — the per-direction half of the
// configured active caps (maxActivePositivePerCoin /
// maxActiveNegativePerCoin within maxActivePerCoin).
function activeDirectionCounts(events, now) {
  let positive = 0;
  let negative = 0;
  for (const ev of filterActiveEvents(events, now)) {
    if (ev.direction === 'POSITIVE') positive += 1;
    else if (ev.direction === 'NEGATIVE') negative += 1;
    else throw new Error(`persistent coin event direction must be POSITIVE or NEGATIVE; received ${JSON.stringify(ev.direction)}`);
  }
  return { positive, negative, total: positive + negative };
}

module.exports = {
  filterActiveEvents,
  netActiveModifierExact,
  capNetModifier,
  netActiveModifierCapped,
  activeCapacityVerdict,
  activeDirectionCounts
};
