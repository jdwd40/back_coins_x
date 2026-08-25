// Crypto Chaos issue #18: passive economic pressure — fees, taxes and
// Apocalypse events.
//
// This module owns the single authoritative debit engine for the round
// economy. EVERY passive drain — recurring fees, recurring taxes and
// scheduled Apocalypse events — flows through the ONE shared atomic domain
// debit path (applyRoundDebit): a set-based, row-locking UPDATE of
// apocalypse_participants.current_cash that never drives cash negative and
// inserts the explanatory apocalypse_cash_events ledger rows in the SAME
// statement, inside the SAME advisory-locked transaction as the durable
// tick/event claim. There are no unrelated direct balance mutations.
//
// Concurrency model: every pass runs inside its own PostgreSQL transaction
// guarded by the SAME transaction-scoped advisory lock Core 1 uses for
// cycle reconciliation (key 727001), so drains serialise with trades,
// settlement and rollover across every Node/PM2 process. This module only
// ever locks PARTICIPANT rows (never coin rows), so it cannot deadlock
// against the coins -> participants ordering used by trades and the market
// simulator.
//
// Idempotency: the database is the duplicate-work authority.
//   * Fee/tax ticks are claimed in apocalypse_economy_ticks with
//     INSERT ... ON CONFLICT DO NOTHING — one row per (cycle_id, kind,
//     tick_id), committed atomically with the debits, so a tick charges at
//     most once across retries, restarts and any number of processes.
//   * Events are persisted schedule rows (apocalypse_economy_events)
//     derived deterministically from the cycle's Core 1 seed at cycle start;
//     execution stamps executed_at with a guarded UPDATE, so a restart
//     observes the persisted schedule and never rerolls or double-charges.
//   * apocalypse_cash_events UNIQUE (cycle_id, participant_id, type,
//     event_key) is the per-participant backstop for every logical debit.
//
// Lifecycle: a pass reconciles the cycle first (the Core 1 loop is the
// cross-process authority on which cycle is live), then revalidates the
// ACTIVE, unexpired cycle inside the lock. A cycle that is SETTLING or
// COMPLETED — or whose window has ended — receives no debits, ever.
//
// users.funds is never read or written. Drains touch only the current
// Apocalypse Cash of ACTIVE participants — humans (online or offline,
// browser or no browser) and bots identically, because issue #17
// auto-participation guarantees every registered user has a participant row.
//
// Circular-import safety: gameCycleService requires THIS module at load
// time (ensureActiveCycle persists the event schedule at cycle start).
// This module therefore never requires gameCycleService at the top level —
// the two places that need it (runEconomyPass / getPlayerRoundEconomy)
// require it lazily inside the function, exactly like joinRound. The
// advisory lock key is re-declared locally.

const db = require('../db/connection');
const { createSeededRandom } = require('./collapseScheduleService');
const gameRoundService = require('./gameRoundService');
const { EVENT_DESCRIPTIONS, resolveEconomyConfig, scaleEconomyAmount } = require('./economyConfig');

// Must match gameCycleService's GAME_CYCLE_ADVISORY_LOCK_KEY. Re-declared
// (not imported) to keep this module free of any top-level dependency on
// gameCycleService.
const GAME_CYCLE_ADVISORY_LOCK_KEY = 727001;

// Domain error carrying an HTTP status for the controller layer. Unknown
// errors still fall through to the generic 500 handler.
class GameEconomyError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'GameEconomyError';
    this.status = status;
  }
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

// ---------------------------------------------------------------------------
// Pure, testable event-schedule mathematics (no database, no clock).
// Deterministic given the cycle seed: same seed + same window + same config
// -> identical schedule, in every process, forever. The random stream is
// keyed off the Core 1 seed with an economy-specific domain separator so it
// can never correlate with the Core 3 collapse shuffle or Core 5 bot moves.
// ---------------------------------------------------------------------------
function buildEventSchedule({ seed, startTime, endTime, config = resolveEconomyConfig() }) {
  const startMs = new Date(startTime).getTime();
  const endMs = new Date(endTime).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw new Error(`event schedule requires endTime after startTime; received ${startTime} .. ${endTime}`);
  }
  // V2-3: config.scale (default 1 = legacy Core 7 amounts) weakens the
  // event amounts. The seeded stream is consumed identically at every
  // scale, so timing/descriptions never shift with the scale and the
  // default output is byte-identical to the pre-V2-3 schedule. Events
  // scaled below one penny are dropped entirely.
  const scale = config.scale === undefined ? 1 : config.scale;
  const random = createSeededRandom(`${seed}:core7-economy`);
  const rows = [];
  for (let i = 0; i < config.eventCount; i++) {
    const fraction = config.eventMinFraction + random() * (config.eventMaxFraction - config.eventMinFraction);
    const drawnAmount = round2(config.eventMinAmount + random() * (config.eventMaxAmount - config.eventMinAmount));
    const description = EVENT_DESCRIPTIONS[Math.floor(random() * EVENT_DESCRIPTIONS.length)];
    const amount = scaleEconomyAmount(drawnAmount, scale);
    if (!(amount > 0)) continue;
    rows.push({
      event_key: `EV-${i + 1}`,
      scheduled_at: new Date(Math.round(startMs + fraction * (endMs - startMs))),
      amount,
      description
    });
  }
  // Canonical order by scheduled instant (stable, deterministic).
  return rows.sort((a, b) => a.scheduled_at.getTime() - b.scheduled_at.getTime() || a.event_key.localeCompare(b.event_key));
}

// ---------------------------------------------------------------------------
// Persist the cycle's event schedule exactly once. Called by
// gameCycleService.ensureActiveCycle INSIDE the Core 1 advisory-locked cycle
// transaction — both at cycle creation and on recovery of a pre-existing
// ACTIVE cycle (which may predate this engine). ON CONFLICT DO NOTHING
// makes replays/restarts pure no-ops: the persisted rows are authoritative
// and are never rerolled or rewritten.
// ---------------------------------------------------------------------------
async function ensureCycleEconomy(client, cycle, { config = resolveEconomyConfig() } = {}) {
  const schedule = buildEventSchedule({
    seed: cycle.seed,
    startTime: cycle.start_time,
    endTime: cycle.end_time,
    config
  });
  if (schedule.length === 0) return [];
  await client.query(
    `INSERT INTO apocalypse_economy_events (cycle_id, event_key, scheduled_at, amount, description)
     SELECT $1, t.event_key, t.scheduled_at, t.amount, t.description
     FROM unnest($2::text[], $3::timestamptz[], $4::numeric[], $5::text[])
       AS t(event_key, scheduled_at, amount, description)
     ON CONFLICT (cycle_id, event_key) DO NOTHING`,
    [
      cycle.cycle_id,
      schedule.map((r) => r.event_key),
      schedule.map((r) => r.scheduled_at.toISOString()),
      schedule.map((r) => r.amount),
      schedule.map((r) => r.description)
    ]
  );
  return schedule;
}

// ---------------------------------------------------------------------------
// THE single shared atomic domain debit path. Every passive drain — FEE,
// TAX or EVENT — goes through here and nowhere else.
//
// One statement: the ACTIVE participants of the cycle are row-locked in
// canonical participant_id order, each is charged
// LEAST(amount, current_cash) — so cash can NEVER go negative (the
// current_cash >= 0 CHECK is the database backstop) — and the explanatory
// ledger rows are inserted from the SAME row set with the exact
// balance_before/balance_after of the mutation. The ledger's own CHECK
// (balance_after = balance_before - amount) makes a mismatched row
// impossible, and UNIQUE (cycle_id, participant_id, type, event_key) makes
// the logical debit idempotent even if the caller's claim somehow replayed.
//
// Every ACTIVE participant of the cycle at claim time is charged
// identically. Drains are claimed on the server cadence (durable tick/event
// claims) against whoever participates at that moment: issue #17 makes
// participation continuous and automatic from cycle start, so in practice
// every registered user is charged from the cycle's first tick. A user
// registered mid-cycle joins every drain claimed after their participant
// row exists and is never retro-charged for ticks/events already committed
// before they joined — their starting cash is never adjusted.
//
// Runs inside the caller's advisory-locked transaction. Returns the number
// of participants actually charged (rows inserted).
// ---------------------------------------------------------------------------
async function applyRoundDebit(client, { cycleId, type, amount, description, eventKey }) {
  if (!['FEE', 'TAX', 'EVENT'].includes(type)) {
    throw new GameEconomyError(`Invalid debit type ${JSON.stringify(type)}.`, 400);
  }
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    throw new GameEconomyError(`Debit amount must be a positive finite number; received ${String(amount)}.`, 400);
  }
  const debitAmount = round2(amount);
  const { rowCount } = await client.query(
    `WITH target AS (
       SELECT participant_id, user_id, current_cash,
              LEAST($1::numeric, current_cash) AS charge
       FROM apocalypse_participants
       WHERE cycle_id = $2 AND status = 'ACTIVE' AND current_cash > 0
       ORDER BY participant_id
       FOR UPDATE
     ), updated AS (
       UPDATE apocalypse_participants p
       SET current_cash = p.current_cash - t.charge, updated_at = now()
       FROM target t
       WHERE p.participant_id = t.participant_id
       RETURNING p.participant_id, t.user_id, t.current_cash AS balance_before,
                 p.current_cash AS balance_after, t.charge AS charged
     )
     INSERT INTO apocalypse_cash_events
       (participant_id, cycle_id, user_id, type, amount, balance_before, balance_after, description, event_key)
     SELECT participant_id, $2, user_id, $3, charged, balance_before, balance_after, $4, $5
     FROM updated`,
    [debitAmount, cycleId, type, description, eventKey]
  );
  return rowCount;
}

// ---------------------------------------------------------------------------
// Tick arithmetic. Tick k of a cadence lands at cycle start + k * interval
// and is due once now >= that instant. Ticks are 1-based; a tick landing
// exactly at (or after) cycle end never fires — the cycle is no longer
// ACTIVE then, and no debit may land after the cycle stops being ACTIVE.
// ---------------------------------------------------------------------------
function latestDueTick({ startMs, endMs, nowMs, intervalMs }) {
  const maxTick = Math.floor((endMs - startMs - 1) / intervalMs);
  const dueTick = Math.floor((nowMs - startMs) / intervalMs);
  return Math.min(dueTick, maxTick);
}

// Claim every due, unexecuted tick of one cadence for the cycle. The claim
// is the durable duplicate-tick authority: ON CONFLICT DO NOTHING returns
// only the ticks THIS transaction claimed, so retries/restarts/duplicate
// workers each see an empty claim for ticks already committed.
async function claimDueTicks(client, cycleId, kind, latestTick) {
  if (latestTick < 1) return [];
  const { rows } = await client.query(
    `INSERT INTO apocalypse_economy_ticks (cycle_id, kind, tick_id)
     SELECT $1, $2, k FROM generate_series(1, $3) AS k
     ON CONFLICT (cycle_id, kind, tick_id) DO NOTHING
     RETURNING tick_id`,
    [cycleId, kind, latestTick]
  );
  return rows.map((r) => Number(r.tick_id)).sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// The single economy pass. Reconciles the lifecycle first (recovery/rollover
// is Core 1's job), then — inside ONE advisory-locked transaction —
// revalidates the live cycle, ensures the persisted event schedule exists,
// claims and applies every due fee tick, every due tax tick, and every due
// persisted event (in schedule order), each through the shared debit path.
// A failure anywhere rolls back claims and debits together, so a retry
// converges to exactly one application of every logical debit.
// ---------------------------------------------------------------------------
async function runEconomyPass({ now = new Date(), config = resolveEconomyConfig() } = {}) {
  if (!config.enabled) {
    return { skipped: true, reason: 'disabled' };
  }
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
  if (!Number.isFinite(nowMs)) {
    throw new GameEconomyError(`runEconomyPass requires a valid time; received ${String(now)}.`, 400);
  }

  // Recover/roll the lifecycle first: the Core 1 reconciliation is the
  // cross-process authority on which cycle is live. (Lazy require: avoids
  // the load-time cycle gameCycleService -> this module -> gameCycleService.)
  const { reconcileCycle } = require('./gameCycleService');
  await reconcileCycle({ now });

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [GAME_CYCLE_ADVISORY_LOCK_KEY]);

    // Revalidate inside the lock: only a live, unexpired ACTIVE cycle can
    // receive debits. SETTLING/COMPLETED cycles and expired windows are
    // never charged.
    const { rows } = await client.query(
      `SELECT * FROM apocalypse_cycles WHERE status = 'ACTIVE' LIMIT 1 FOR UPDATE`
    );
    const cycle = rows[0];
    if (!cycle || new Date(cycle.end_time).getTime() <= nowMs) {
      await client.query('COMMIT');
      return { skipped: true, reason: 'no-live-cycle' };
    }

    const startMs = new Date(cycle.start_time).getTime();
    const endMs = new Date(cycle.end_time).getTime();
    const summary = {
      skipped: false,
      cycleId: cycle.cycle_id,
      apocalypseId: cycle.apocalypse_id,
      feeTicks: [],
      taxTicks: [],
      events: [],
      participantsCharged: 0
    };

    // Recovery: a live cycle whose schedule is missing (created before this
    // engine, or a crashed creation) gets its deterministic persisted
    // schedule now — observing existing rows, never rerolling.
    await ensureCycleEconomy(client, cycle, { config });

    // Recurring fees, then recurring taxes: claim the due ticks durably,
    // then debit each claimed tick through the shared path in tick order.
    // V2-3: the explicit config scale weakens the charged amounts; a kind
    // scaled below one penny is not claimed or charged at all (the durable
    // tick rows are simply never created, so a later scale restore can
    // still claim them — no debit is ever lost silently mid-config).
    const feeAmount = scaleEconomyAmount(config.feeAmount, config.scale === undefined ? 1 : config.scale);
    if (feeAmount > 0) {
      const feeTicks = await claimDueTicks(
        client, cycle.cycle_id, 'FEE',
        latestDueTick({ startMs, endMs, nowMs, intervalMs: config.feeTickIntervalMs })
      );
      for (const tick of feeTicks) {
        summary.participantsCharged += await applyRoundDebit(client, {
          cycleId: cycle.cycle_id,
          type: 'FEE',
          amount: feeAmount,
          description: `Recurring round fee (tick ${tick})`,
          eventKey: `FEE-T${tick}`
        });
        summary.feeTicks.push(tick);
      }
    }

    const taxAmount = scaleEconomyAmount(config.taxAmount, config.scale === undefined ? 1 : config.scale);
    if (taxAmount > 0) {
      const taxTicks = await claimDueTicks(
        client, cycle.cycle_id, 'TAX',
        latestDueTick({ startMs, endMs, nowMs, intervalMs: config.taxTickIntervalMs })
      );
      for (const tick of taxTicks) {
        summary.participantsCharged += await applyRoundDebit(client, {
          cycleId: cycle.cycle_id,
          type: 'TAX',
          amount: taxAmount,
          description: `Recurring wealth tax (tick ${tick})`,
          eventKey: `TAX-T${tick}`
        });
        summary.taxTicks.push(tick);
      }
    }

    // Due persisted events, in schedule order. Execution stamps the durable
    // row with a guarded UPDATE; a row that changed under us aborts the
    // whole transaction (Core 3 pattern) rather than corrupt event state.
    const { rows: dueEvents } = await client.query(
      `SELECT event_pk, event_key, scheduled_at, amount, description
       FROM apocalypse_economy_events
       WHERE cycle_id = $1 AND executed_at IS NULL AND scheduled_at <= $2
       ORDER BY scheduled_at, event_key
       FOR UPDATE`,
      [cycle.cycle_id, new Date(nowMs).toISOString()]
    );
    for (const event of dueEvents) {
      summary.participantsCharged += await applyRoundDebit(client, {
        cycleId: cycle.cycle_id,
        type: 'EVENT',
        amount: parseFloat(event.amount),
        description: event.description,
        eventKey: event.event_key
      });
      const { rowCount } = await client.query(
        `UPDATE apocalypse_economy_events SET executed_at = $1
         WHERE event_pk = $2 AND executed_at IS NULL`,
        [new Date(nowMs).toISOString(), event.event_pk]
      );
      if (rowCount !== 1) {
        throw new Error(`economy event ${event.event_pk} changed under execution; aborting economy transaction`);
      }
      summary.events.push(event.event_key);
    }

    await client.query('COMMIT');
    return summary;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Player-safe reads for the frontend (#11 contract). Only EXECUTED ledger
// rows are ever returned — the persisted future event schedule is internal
// only and is never read here, so no future timing/amount/seed information
// can leak.
// ---------------------------------------------------------------------------
const DEFAULT_CASH_EVENT_LIMIT = 20;
const MAX_CASH_EVENT_LIMIT = 100;

function validateCashEventLimit(raw) {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_CASH_EVENT_LIMIT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_CASH_EVENT_LIMIT) {
    throw new GameEconomyError(
      `Invalid limit. Please provide an integer between 1 and ${MAX_CASH_EVENT_LIMIT}.`,
      400
    );
  }
  return value;
}

async function getParticipantCashEvents({ participantId, limit, queryable = db } = {}) {
  const capped = validateCashEventLimit(limit);
  const { rows } = await queryable.query(
    `SELECT cash_event_id, type, amount, balance_before, balance_after,
            description, event_key, created_at
     FROM apocalypse_cash_events
     WHERE participant_id = $1
     ORDER BY cash_event_id DESC
     LIMIT $2`,
    [participantId, capped]
  );
  return rows.map((row) => ({
    cashEventId: row.cash_event_id,
    type: row.type,
    amount: parseFloat(row.amount),
    balanceBefore: parseFloat(row.balance_before),
    balanceAfter: parseFloat(row.balance_after),
    description: row.description,
    eventKey: row.event_key,
    createdAt: new Date(row.created_at).toISOString()
  }));
}

// Authenticated player view: the caller's participant for the live cycle
// (falling back to their most recent participant during the brief
// settlement window between cycles), plus their recent FEE/TAX/EVENT ledger
// rows. Reading reconciles the lifecycle first, exactly like the public
// state endpoint.
async function getPlayerRoundEconomy({ userId, now = new Date(), limit } = {}) {
  const { reconcileCycle } = require('./gameCycleService'); // lazy: see header
  const cycle = await reconcileCycle({ now });

  const { rows } = await db.query(
    `SELECT participant_id FROM apocalypse_participants
     WHERE cycle_id = $1 AND user_id = $2`,
    [cycle.cycle_id, userId]
  );
  let participantId = rows[0] && rows[0].participant_id;
  if (!participantId) {
    const { rows: latest } = await db.query(
      `SELECT participant_id FROM apocalypse_participants
       WHERE user_id = $1
       ORDER BY cycle_id DESC, participant_id DESC
       LIMIT 1`,
      [userId]
    );
    participantId = latest[0] && latest[0].participant_id;
  }
  if (!participantId) {
    throw new GameEconomyError('No participant for this user. Join the round first via POST /api/game/join.', 404);
  }

  const participant = await gameRoundService.getParticipantRoundState(participantId);
  const cashEvents = await getParticipantCashEvents({ participantId, limit });
  return { participant, cashEvents };
}

module.exports = {
  GameEconomyError,
  buildEventSchedule,
  ensureCycleEconomy,
  applyRoundDebit,
  latestDueTick,
  runEconomyPass,
  getParticipantCashEvents,
  getPlayerRoundEconomy
};
