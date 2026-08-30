// Crypto Chaos gameplay overhaul SIM-03/SIM-04: the coin event engine.
//
// Every coin of a cycle carries 0-5 active temporary events at any instant
// (gameplay_changes.md §4, build plan Stage 2). Each event has an explicit
// name, direction (POSITIVE/NEGATIVE), strength category, signed modifier,
// start/end window and coin identity. Positive and negative events coexist
// and stack; the stacked net modifier is capped (config
// coinEvents.maxStackedModifier). Durations are 1-15 minutes; expiry is
// purely time-based — an expired event stops affecting calculations
// immediately and is never deleted, mutated or resurrected.
//
// Determinism (SIM-04): every event's draws are a pure function of the
// cycle's persisted Core 1 seed, the coin id and the event's per-coin
// sequence number — the stream is SHA-256 counter mode keyed
// `${seed}:sim1-coin-events:coin:<coinId>:<seq>`, uncorrelated with the
// collapse shuffle, the economy schedule, bot moves and the market-phase
// stream. Math.random() is never used.
//
// Persistence is ROLLING, not whole-schedule-at-start: coverage extends each
// coin's persisted stream only up to `now`, one event at a time, inside the
// caller's Core 1 advisory-locked transaction (lock key 727001). The next
// event's position depends only on the persisted stream (its predecessor's
// start, plus recent unexpired events for the stacking cap), so rolling
// generation is byte-identical to whole-window generation truncated at the
// same horizon — while keeping cycle creation O(events due), not O(cycle
// length): a 7-day test/stress cycle must not mint weeks of events up
// front. UNIQUE (cycle_id, coin_id, event_seq) is the idempotency backstop:
// restarts and repeated reconciliations observe persisted rows and never
// reroll them.
//
// Long-run pressure (gameplay_changes.md §2, Rule 1): negative modifiers are
// scaled by config coinEvents.negativeBiasFactor (target band 1.20-1.30),
// so the expected total event contribution is slightly negative without
// needing more negative events than positive ones.
//
// This module never requires gameCycleService (no circular imports) and owns
// no timers.
//
// Wave 1 scope: event state is internal-only. Nothing here is exposed
// through public endpoints (that is Wave 5 / SIM-15..17), and nothing here
// feeds the price path yet (that is Wave 3 / SIM-08). Event data is fully
// separate from portfolio, trade, price-history and cash-event data.

const db = require('../db/connection');
const { createSeededRandom } = require('./seededRandom');
const {
  COIN_EVENT_STRENGTH_IDS,
  resolveSimulationConfig
} = require('./simulationConfig');

// Flavour vocabulary only (gameplay_changes.md §4.1/§4.2): names carry no
// gameplay effect beyond readability. These are game-design constants, not
// tunable balance numbers, so they live here rather than in
// simulationConfig (mirroring EVENT_DESCRIPTIONS in economyConfig.js).
const POSITIVE_EVENT_NAMES = Object.freeze([
  'Celebrity Endorsement',
  'Viral Attention',
  'Whale Accumulation',
  'Major Partnership',
  'Successful Product Launch',
  'Strong Community Hype',
  'Exchange Listing Rumour',
  'Network Upgrade'
]);

const NEGATIVE_EVENT_NAMES = Object.freeze([
  'Security Rumours',
  'Developer Scandal',
  'Whale Sell-Off',
  'Network Outage',
  'Failed Upgrade',
  'Community Backlash',
  'Fraud Allegations',
  'Exchange Delisting Rumour'
]);

// Modifiers are persisted as NUMERIC(12, 8); rounding to 8 decimal places in
// the pure generator keeps the persisted rows byte-identical to a pure
// recomputation (restart-equivalent state). PostgreSQL rounds half away
// from zero, so the rounding here is sign-aware (Math.round alone rounds
// halves toward +Infinity, which would diverge for negative modifiers).
function round8(value) {
  return Math.sign(value) * Math.round(Math.abs(value) * 1e8) / 1e8;
}

function toMs(value, label) {
  const ms = (value instanceof Date ? value : new Date(value)).getTime();
  if (!Number.isFinite(ms)) {
    throw new Error(`coin event engine requires a valid ${label}; received ${String(value)}`);
  }
  return ms;
}

// Draw one strength category from the configured normalised probabilities,
// iterating the canonical category order. Pure function of the draw value.
function drawStrengthCategory(draw, probabilities) {
  let cumulative = 0;
  for (const id of COIN_EVENT_STRENGTH_IDS) {
    cumulative += probabilities[id];
    if (draw < cumulative) return id;
  }
  return COIN_EVENT_STRENGTH_IDS[COIN_EVENT_STRENGTH_IDS.length - 1];
}

// Exact concurrency check: would adding [startMs, endMs) push the number of
// simultaneously active events above `cap` at any instant? `priorEvents`
// must contain every accepted event that could overlap the candidate window
// (all of them start at or before the candidate start: generation order is
// non-decreasing in starts). Concurrency only changes at event boundaries,
// and no prior event can START inside the candidate window, so concurrency
// is maximal exactly at the candidate start — measuring there is exact.
function wouldExceedCap(priorEvents, startMs, endMs, cap) {
  let active = 1; // the candidate event itself
  for (const ev of priorEvents) {
    if (ev.startMs <= startMs && startMs < ev.endMs) active += 1;
  }
  return active > cap;
}

// ---------------------------------------------------------------------------
// Pure, testable event generation (no database, no clock, no globals).
// Same seed + coin id + sequence number + config -> identical draws, in
// every process, forever.
// ---------------------------------------------------------------------------

// The deterministic attribute draws for one per-coin sequence number. Draw
// order is fixed: gap, duration, direction, category, strength, name. The
// gap is the spacing AFTER the predecessor's (final, possibly postponed)
// start — or after the cycle start for sequence 1.
function drawCoinEventAt({ seed, coinId, eventSeq, config = resolveSimulationConfig() }) {
  if (!Number.isInteger(eventSeq) || eventSeq < 1) {
    throw new Error(`coin event sequence must be a positive integer; received ${String(eventSeq)}`);
  }
  const ce = config.coinEvents;
  const rng = createSeededRandom(`${seed}:sim1-coin-events:coin:${coinId}:${eventSeq}`);
  const gapMs = Math.round(ce.arrivalGapMs.min + rng() * (ce.arrivalGapMs.max - ce.arrivalGapMs.min));
  const durationMs = Math.round(ce.durationMs.min + rng() * (ce.durationMs.max - ce.durationMs.min));
  const direction = rng() < ce.directionWeights.positive ? 'POSITIVE' : 'NEGATIVE';
  const strengthCategory = drawStrengthCategory(rng(), ce.strengthProbabilities);
  const range = ce.strengthRanges[strengthCategory];
  const magnitude = range.min + rng() * (range.max - range.min);
  const names = direction === 'POSITIVE' ? POSITIVE_EVENT_NAMES : NEGATIVE_EVENT_NAMES;
  const name = names[Math.floor(rng() * names.length)];
  const modifier = round8(direction === 'POSITIVE' ? magnitude : -magnitude * ce.negativeBiasFactor);
  return { gapMs, durationMs, direction, strengthCategory, name, modifier };
}

// Place one event: candidate start = baseStartMs + drawn gap, postponed
// (never redrawn) until the stacking cap has room. `priorEvents` must cover
// every accepted event whose window could overlap the candidate — i.e. all
// accepted events with endMs > baseStartMs (starts are non-decreasing, so
// anything older has already expired before the candidate starts).
// Returns the placed event, or null when no room remains before endMs.
function placeCoinEvent({ drawn, coinId, eventSeq, baseStartMs, priorEvents, endMs, config = resolveSimulationConfig() }) {
  const cap = config.coinEvents.maxActivePerCoin;
  let start = baseStartMs + drawn.gapMs;
  // Each retry jumps to the earliest expiry strictly after the current
  // start: a finite, strictly increasing set of instants, so this ends.
  while (start < endMs && wouldExceedCap(priorEvents, start, start + drawn.durationMs, cap)) {
    let earliestEnd = Infinity;
    for (const ev of priorEvents) {
      if (ev.startMs <= start && start < ev.endMs && ev.endMs < earliestEnd) earliestEnd = ev.endMs;
    }
    if (earliestEnd === Infinity) break; // unreachable (cap overflow implies overlap), but never loop forever
    start = earliestEnd;
  }
  if (start >= endMs) return null;
  return {
    coin_id: coinId,
    event_seq: eventSeq,
    name: drawn.name,
    direction: drawn.direction,
    strength_category: drawn.strengthCategory,
    modifier: drawn.modifier,
    startMs: start,
    endMs: start + drawn.durationMs
  };
}

// The whole-window schedule for one coin: sequence 1..N placed until no room
// remains before endMs. This is exactly what rolling persistence produces
// for the same coin when the horizon reaches endMs — same draws, same
// placements, same rows (minus the Date/number presentation).
function buildCoinEventSchedule({ seed, coinId, startTime, endTime, config = resolveSimulationConfig() }) {
  if (!Number.isFinite(coinId)) {
    throw new Error(`coin event schedule requires a numeric coinId; received ${String(coinId)}`);
  }
  const startMs = toMs(startTime, 'startTime');
  const endMs = toMs(endTime, 'endTime');
  if (endMs <= startMs) {
    throw new Error(`coin event schedule requires endTime after startTime; received ${startTime} .. ${endTime}`);
  }

  const events = [];
  let baseMs = startMs;
  let seq = 1;
  for (;;) {
    const drawn = drawCoinEventAt({ seed, coinId, eventSeq: seq, config });
    // Only events that could still overlap future candidates are relevant
    // to the cap: anything ending at or before the candidate's base has
    // expired before it starts.
    const recent = events.filter((ev) => ev.endMs > baseMs);
    const placed = placeCoinEvent({ drawn, coinId, eventSeq: seq, baseStartMs: baseMs, priorEvents: recent, endMs, config });
    if (!placed) break;
    events.push(placed);
    baseMs = placed.startMs;
    seq += 1;
  }

  return events.map((ev) => ({
    coin_id: ev.coin_id,
    event_seq: ev.event_seq,
    name: ev.name,
    direction: ev.direction,
    strength_category: ev.strength_category,
    modifier: ev.modifier,
    starts_at: new Date(ev.startMs),
    ends_at: new Date(ev.endMs)
  }));
}

// The whole cycle's schedule across the canonical sorted coin ids. Input
// order of coinIds is irrelevant: the set is canonicalised first, so the
// same seed + same coin set always produces the same schedule.
function buildCycleCoinEvents({ seed, coinIds, startTime, endTime, config = resolveSimulationConfig() }) {
  if (!Array.isArray(coinIds)) {
    throw new Error('coin event schedule coinIds must be an array');
  }
  const canonical = coinIds.slice().sort((a, b) => a - b);
  const rows = [];
  for (const coinId of canonical) {
    rows.push(...buildCoinEventSchedule({ seed, coinId, startTime, endTime, config }));
  }
  return rows; // already in canonical (coin_id, event_seq) order
}

// The events active at `now`: starts_at <= now < ends_at. Accepts pure
// generated rows or database rows (Date or ISO timestamp fields). Canonical
// order: starts_at, then coin_id, then event_seq.
function getActiveEvents(events, now) {
  const nowMs = toMs(now, 'now');
  return events
    .filter((ev) => toMs(ev.starts_at, 'starts_at') <= nowMs && nowMs < toMs(ev.ends_at, 'ends_at'))
    .sort((a, b) =>
      toMs(a.starts_at, 'starts_at') - toMs(b.starts_at, 'starts_at') ||
      a.coin_id - b.coin_id ||
      a.event_seq - b.event_seq
    );
}

// The net stacked modifier of one coin's events active at `now`, clamped to
// the configured stack cap (spec §4.4: approximately ±6%). Expired and
// future events contribute nothing.
function netEventModifier(events, now, config = resolveSimulationConfig()) {
  const cap = config.coinEvents.maxStackedModifier;
  let sum = 0;
  for (const ev of getActiveEvents(events, now)) {
    sum += typeof ev.modifier === 'string' ? parseFloat(ev.modifier) : ev.modifier;
  }
  return Math.max(-cap, Math.min(cap, sum));
}

// ---------------------------------------------------------------------------
// Persistence (SIM-04). Runs inside the caller's Core 1 advisory-locked
// transaction: each coin's stream is extended up to `now`, drawing only what
// is due; everything persisted is observed — never rerolled — on every later
// reconciliation.
// ---------------------------------------------------------------------------

async function getCycleCoinEvents(queryable = db, cycleId) {
  const { rows } = await queryable.query(
    `SELECT event_id, cycle_id, coin_id, event_seq, name, direction,
            strength_category, modifier, starts_at, ends_at, created_at
     FROM apocalypse_coin_events
     WHERE cycle_id = $1
     ORDER BY coin_id, event_seq`,
    [cycleId]
  );
  return rows;
}

// Extend the cycle's persisted coin-event streams to cover `now`. Called by
// gameCycleService.ensureActiveCycle INSIDE the Core 1 advisory-locked cycle
// transaction — at cycle creation and on every later reconciliation of a
// live cycle.
//
// Idempotent under repeated calls and restarts: the per-coin continuation
// point is read from the persisted rows (latest event_seq/start), each new
// event is a pure function of (seed, coin_id, seq), and
// INSERT ... ON CONFLICT (cycle_id, coin_id, event_seq) DO NOTHING is the
// backstop. A restart can neither reroll an active event nor resurrect an
// expired one (rows are never updated or deleted). The horizon never
// extends past the cycle end.
//
// Returns the number of rows this call created (0 on a no-op reconcile).
async function ensureCoinEventCoverage(client, cycle, now, { config = resolveSimulationConfig() } = {}) {
  const nowMs = toMs(now, 'now');
  const startMs = toMs(cycle.start_time, 'cycle.start_time');
  const endMs = toMs(cycle.end_time, 'cycle.end_time');
  if (endMs <= startMs) {
    throw new Error(`coin event coverage requires the cycle end after its start; received ${cycle.start_time} .. ${cycle.end_time}`);
  }

  // Eligible coins are the active (non-retired) catalogue, read under row
  // locks in canonical coin_id order (Core 3 collapse-schedule pattern).
  const { rows: coins } = await client.query(
    `SELECT coin_id FROM coins WHERE retired = FALSE ORDER BY coin_id FOR UPDATE`
  );

  let created = 0;
  for (const coin of coins) {
    const coinId = coin.coin_id;
    // The persisted continuation point: the latest event of this coin.
    const { rows: lastRows } = await client.query(
      `SELECT event_seq, starts_at FROM apocalypse_coin_events
       WHERE cycle_id = $1 AND coin_id = $2
       ORDER BY event_seq DESC
       LIMIT 1`,
      [cycle.cycle_id, coinId]
    );
    let baseMs = lastRows.length > 0 ? toMs(lastRows[0].starts_at, 'starts_at') : startMs;
    let nextSeq = lastRows.length > 0 ? Number(lastRows[0].event_seq) + 1 : 1;

    // The stacking-cap context: every persisted event whose window could
    // still overlap a future candidate (ends after the base instant).
    const { rows: recentRows } = await client.query(
      `SELECT starts_at, ends_at FROM apocalypse_coin_events
       WHERE cycle_id = $1 AND coin_id = $2 AND ends_at > $3
       ORDER BY event_seq`,
      [cycle.cycle_id, coinId, new Date(baseMs).toISOString()]
    );
    const recent = recentRows.map((r) => ({
      startMs: toMs(r.starts_at, 'starts_at'),
      endMs: toMs(r.ends_at, 'ends_at')
    }));

    for (;;) {
      const drawn = drawCoinEventAt({ seed: cycle.seed, coinId, eventSeq: nextSeq, config });
      const placed = placeCoinEvent({
        drawn, coinId, eventSeq: nextSeq, baseStartMs: baseMs, priorEvents: recent, endMs, config
      });
      // Stop at the horizon or when the window has no room left.
      if (!placed || placed.startMs > nowMs) break;

      const { rows: inserted } = await client.query(
        `INSERT INTO apocalypse_coin_events
           (cycle_id, coin_id, event_seq, name, direction, strength_category, modifier, starts_at, ends_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (cycle_id, coin_id, event_seq) DO NOTHING
         RETURNING event_seq, starts_at, ends_at`,
        [
          cycle.cycle_id,
          coinId,
          nextSeq,
          placed.name,
          placed.direction,
          placed.strength_category,
          placed.modifier,
          new Date(placed.startMs).toISOString(),
          new Date(placed.endMs).toISOString()
        ]
      );
      if (inserted.length > 0) {
        created += 1;
        recent.push({ startMs: placed.startMs, endMs: placed.endMs });
        baseMs = placed.startMs;
      } else {
        // Another writer committed this sequence first (only possible
        // without the advisory lock): observe the persisted row instead of
        // our draw — the database is the authority, never reroll.
        const { rows: existing } = await client.query(
          `SELECT starts_at, ends_at FROM apocalypse_coin_events
           WHERE cycle_id = $1 AND coin_id = $2 AND event_seq = $3`,
          [cycle.cycle_id, coinId, nextSeq]
        );
        if (existing.length === 0) {
          throw new Error(`coin event row (cycle ${cycle.cycle_id}, coin ${coinId}, seq ${nextSeq}) vanished during reconciliation; aborting`);
        }
        const existingStart = toMs(existing[0].starts_at, 'starts_at');
        recent.push({ startMs: existingStart, endMs: toMs(existing[0].ends_at, 'ends_at') });
        baseMs = existingStart;
        if (existingStart > nowMs) break;
      }
      nextSeq += 1;
    }
  }
  return created;
}

// Internal read: the given cycle's events active at `now` (any coin).
// Wave 1 keeps this shape internal — no public endpoint consumes it.
async function getActiveCoinEvents(queryable = db, cycleId, now) {
  const nowDate = now instanceof Date ? now : new Date(now);
  const { rows } = await queryable.query(
    `SELECT event_id, cycle_id, coin_id, event_seq, name, direction,
            strength_category, modifier, starts_at, ends_at
     FROM apocalypse_coin_events
     WHERE cycle_id = $1 AND starts_at <= $2 AND ends_at > $2
     ORDER BY coin_id, starts_at, event_seq`,
    [cycleId, nowDate.toISOString()]
  );
  return rows;
}

module.exports = {
  POSITIVE_EVENT_NAMES,
  NEGATIVE_EVENT_NAMES,
  drawCoinEventAt,
  placeCoinEvent,
  buildCoinEventSchedule,
  buildCycleCoinEvents,
  getActiveEvents,
  netEventModifier,
  getCycleCoinEvents,
  ensureCoinEventCoverage,
  getActiveCoinEvents
};
