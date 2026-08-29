// Crypto Chaos issue #21: read-only operator/game diagnostics for one
// Apocalypse cycle (current or completed).
//
//   * getCycleDiagnosticsParticipants — per-participant summary: identity
//     (participant/user id, username, HUMAN/BOT + bot personality),
//     authoritative Cash (starting/current/final from
//     apocalypse_participants — NEVER recomputed from any stream), status,
//     non-zero holdings summary, BUY/SELL counts from apocalypse_transactions
//     and passive FEE/TAX/EVENT debit count/total from the #18
//     apocalypse_cash_events ledger.
//
//   * getCycleDiagnosticsActivity — ONE bounded, paginated activity stream
//     merging BUY/SELL trades (apocalypse_transactions) with FEE/TAX/EVENT
//     ledger rows (apocalypse_cash_events), normalised to a shared row
//     shape with an authoritative timestamp each. This stream is
//     explanatory only: Cash is always read from the participant row.
//
//   * getCycleDiagnosticsBots — aggregate bot behaviour from
//     apocalypse_bot_ticks: tick count, recorded action count, executed
//     BUY/SELL, HOLD/skipped (with reason breakdown) and rejected/error
//     counts, plus a per-bot breakdown. No JSON parsing is left to the
//     operator.
//
//   * getCycleDiagnosticsMonitor — Apocalypse Monitor Phase 2: the raw
//     per-coin price_history series for one cycle. Rows carrying the
//     selected cycle's id (migration 019 provenance) are EXACT — matched by
//     price_history.cycle_id ONLY, never by timestamp. Legacy rows
//     (cycle_id IS NULL, never backfilled) are attributed by the half-open
//     window [start_time, end_time) and honestly marked derived; the
//     dataset-level attribution is exact / time_window_derived / mixed and
//     `exact` is false whenever any derived row is used. Executed collapses
//     appear only as source='COLLAPSE' rows; the future schedule
//     (coin_collapse_schedule) is never read, and future-dated rows are
//     never exposed.
//
// Hard rules (matching the issue's acceptance criteria):
//   * NO duplicate BUY/SELL storage is created — everything is read from
//     the existing authoritative tables.
//   * Pure reads: every entry point runs inside a `BEGIN READ ONLY`
//     transaction, so a diagnostic call provably cannot write, reconcile,
//     settle or roll over anything. No advisory lock is ever taken —
//     mutation locks belong to the game domain ops only.
//   * Nothing internal leaks: no cycle seed, no future (unexecuted)
//     collapse/economy schedule, no auth data. Only EXECUTED economy
//     ledger rows are read; apocalypse_economy_events (the future event
//     schedule) is never touched.
//   * Retired coins stay readable: holdings/activity join coins without
//     filtering on coins.retired, so full history remains visible.

const db = require('../db/connection');

// Canonical public cycle identifier (Core 1): e.g. 'APOC-0001'.
const APOCALYPSE_ID_PATTERN = /^APOC-\d{4,}$/;

// Bounds for the activity stream. Game-design constants, deliberately not
// configurable: responses are always bounded.
const DEFAULT_ACTIVITY_LIMIT = 50;
const MAX_ACTIVITY_LIMIT = 200;
const MAX_ACTIVITY_OFFSET = 100000;

// Domain error carrying an HTTP status for the controller layer. Unknown
// errors still fall through to the generic 500 handler.
class GameDiagnosticsError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'GameDiagnosticsError';
    this.status = status;
  }
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

// ---------------------------------------------------------------------------
// Read-only transaction helper. `BEGIN READ ONLY` makes PostgreSQL itself
// reject any write, so every diagnostic query below is provably read-only
// regardless of future edits inside the callback. No advisory lock is
// acquired: diagnostics never serialise against gameplay mutations.
// ---------------------------------------------------------------------------
async function readOnly(fn) {
  const client = await db.getClient();
  try {
    await client.query('BEGIN READ ONLY');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {
      // Ignore rollback failure; the original error is authoritative.
    }
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Cycle resolution. An explicit cycleId must be the canonical APOC-NNNN id
// (400 otherwise, 404 when unknown). Omitted means "the current cycle":
// the ACTIVE cycle when one exists, otherwise the most recent cycle of any
// status (a pending rollover is reported as persisted — diagnostics never
// reconcile to force one).
// ---------------------------------------------------------------------------
function validateApocalypseId(raw) {
  if (typeof raw !== 'string' || !APOCALYPSE_ID_PATTERN.test(raw)) {
    throw new GameDiagnosticsError('Invalid cycleId. Please provide an apocalypse identifier (e.g. APOC-0001).', 400);
  }
  return raw;
}

async function resolveCycle(client, rawCycleId) {
  let cycle;
  if (rawCycleId === undefined || rawCycleId === null || rawCycleId === '') {
    const { rows } = await client.query(
      `SELECT * FROM apocalypse_cycles
       ORDER BY (status = 'ACTIVE') DESC, cycle_id DESC
       LIMIT 1`
    );
    cycle = rows[0];
    if (!cycle) {
      throw new GameDiagnosticsError('No apocalypse cycle exists yet.', 404);
    }
  } else {
    const apocalypseId = validateApocalypseId(rawCycleId);
    const { rows } = await client.query(
      `SELECT * FROM apocalypse_cycles WHERE apocalypse_id = $1`,
      [apocalypseId]
    );
    cycle = rows[0];
    if (!cycle) {
      throw new GameDiagnosticsError(`Unknown apocalypse cycle ${apocalypseId}.`, 404);
    }
  }
  return cycle;
}

function publicCycle(cycle) {
  return {
    cycleId: cycle.apocalypse_id,
    status: cycle.status,
    startTime: new Date(cycle.start_time).toISOString(),
    endTime: new Date(cycle.end_time).toISOString(),
    settledAt: cycle.settled_at ? new Date(cycle.settled_at).toISOString() : null
  };
}

// ---------------------------------------------------------------------------
// Participant summary.
// ---------------------------------------------------------------------------
async function getCycleDiagnosticsParticipants(rawCycleId) {
  return readOnly(async (client) => {
    const cycle = await resolveCycle(client, rawCycleId);

    const { rows } = await client.query(
      `SELECT p.participant_id, p.user_id, u.username, u.is_bot,
              b.strategy AS personality,
              p.joined_at, p.starting_cash, p.current_cash, p.final_cash, p.status,
              COALESCE(t.buy_count, 0)::int  AS buy_count,
              COALESCE(t.sell_count, 0)::int AS sell_count,
              COALESCE(e.passive_count, 0)::int        AS passive_debit_count,
              COALESCE(e.passive_total, 0)::numeric    AS passive_debit_total
       FROM apocalypse_participants p
       JOIN users u ON u.user_id = p.user_id
       LEFT JOIN apocalypse_bots b ON b.user_id = p.user_id
       LEFT JOIN (
         SELECT participant_id,
                count(*) FILTER (WHERE type = 'BUY')  AS buy_count,
                count(*) FILTER (WHERE type = 'SELL') AS sell_count
         FROM apocalypse_transactions
         WHERE cycle_id = $1
         GROUP BY participant_id
       ) t ON t.participant_id = p.participant_id
       LEFT JOIN (
         SELECT participant_id, count(*) AS passive_count, sum(amount) AS passive_total
         FROM apocalypse_cash_events
         WHERE cycle_id = $1
         GROUP BY participant_id
       ) e ON e.participant_id = p.participant_id
       WHERE p.cycle_id = $1
       ORDER BY p.participant_id ASC`,
      [cycle.cycle_id]
    );

    const { rows: holdingRows } = await client.query(
      `SELECT h.participant_id, h.coin_id, c.symbol, h.quantity
       FROM apocalypse_holdings h
       JOIN coins c ON c.coin_id = h.coin_id
       WHERE h.cycle_id = $1 AND h.quantity > 0
       ORDER BY h.participant_id, h.coin_id`,
      [cycle.cycle_id]
    );
    const holdingsByParticipant = new Map();
    for (const holding of holdingRows) {
      if (!holdingsByParticipant.has(holding.participant_id)) {
        holdingsByParticipant.set(holding.participant_id, []);
      }
      holdingsByParticipant.get(holding.participant_id).push({
        coinId: holding.coin_id,
        symbol: holding.symbol,
        quantity: parseFloat(holding.quantity)
      });
    }

    return {
      ...publicCycle(cycle),
      participantCount: rows.length,
      participants: rows.map((row) => ({
        participantId: row.participant_id,
        userId: row.user_id,
        username: row.username,
        kind: row.is_bot === true ? 'BOT' : 'HUMAN',
        personality: row.personality || null,
        joinedAt: new Date(row.joined_at).toISOString(),
        startingCash: parseFloat(row.starting_cash),
        currentCash: parseFloat(row.current_cash),
        finalCash: row.final_cash === null ? null : parseFloat(row.final_cash),
        status: row.status,
        holdings: holdingsByParticipant.get(row.participant_id) || [],
        buyCount: row.buy_count,
        sellCount: row.sell_count,
        passiveDebitCount: row.passive_debit_count,
        passiveDebitTotal: round2(parseFloat(row.passive_debit_total))
      }))
    };
  });
}

// ---------------------------------------------------------------------------
// Merged activity stream: BUY/SELL trades + FEE/TAX/EVENT ledger rows.
// Bounded and paginated; empty cycles return a clean empty page.
// ---------------------------------------------------------------------------
function resolveActivityLimit(raw) {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    return DEFAULT_ACTIVITY_LIMIT;
  }
  const trimmed = typeof raw === 'string' ? raw.trim() : raw;
  if (typeof trimmed === 'string' && !/^[+-]?\d+$/.test(trimmed)) {
    throw new GameDiagnosticsError(
      `Invalid limit. Please provide an integer between 1 and ${MAX_ACTIVITY_LIMIT}.`,
      400
    );
  }
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < 1 || value > MAX_ACTIVITY_LIMIT) {
    throw new GameDiagnosticsError(
      `Invalid limit. Please provide an integer between 1 and ${MAX_ACTIVITY_LIMIT}.`,
      400
    );
  }
  return value;
}

function resolveActivityOffset(raw) {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    return 0;
  }
  const trimmed = typeof raw === 'string' ? raw.trim() : raw;
  if (typeof trimmed === 'string' && !/^[+-]?\d+$/.test(trimmed)) {
    throw new GameDiagnosticsError(
      `Invalid offset. Please provide an integer between 0 and ${MAX_ACTIVITY_OFFSET}.`,
      400
    );
  }
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < 0 || value > MAX_ACTIVITY_OFFSET) {
    throw new GameDiagnosticsError(
      `Invalid offset. Please provide an integer between 0 and ${MAX_ACTIVITY_OFFSET}.`,
      400
    );
  }
  return value;
}

function resolveActivityOrder(raw) {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    return 'desc';
  }
  const value = String(raw).trim().toLowerCase();
  if (value !== 'asc' && value !== 'desc') {
    throw new GameDiagnosticsError("Invalid order. Please provide 'asc' or 'desc'.", 400);
  }
  return value;
}

async function getCycleDiagnosticsActivity(rawCycleId, { limit, offset, order } = {}) {
  const cappedLimit = resolveActivityLimit(limit);
  const safeOffset = resolveActivityOffset(offset);
  const direction = resolveActivityOrder(order);

  return readOnly(async (client) => {
    const cycle = await resolveCycle(client, rawCycleId);

    // Both branches select an identical normalised shape. source_id is the
    // per-table primary key, used only as a deterministic tie-break within
    // one timestamp. Ledger rows are EXECUTED debits by construction — the
    // future event schedule lives in apocalypse_economy_events, which is
    // never read here.
    const { rows: countRows } = await client.query(
      `SELECT (
         (SELECT count(*) FROM apocalypse_transactions WHERE cycle_id = $1) +
         (SELECT count(*) FROM apocalypse_cash_events WHERE cycle_id = $1)
       )::int AS total`,
      [cycle.cycle_id]
    );
    const total = countRows[0].total;

    const sortDirection = direction === 'asc' ? 'ASC' : 'DESC';
    const { rows } = await client.query(
      `SELECT * FROM (
         SELECT 'TRADE' AS source,
                t.type AS type,
                t.round_transaction_id AS source_id,
                t.participant_id,
                t.user_id,
                t.total_amount AS amount,
                t.coin_id,
                t.quantity,
                t.price,
                NULL::varchar AS description,
                t.created_at AS occurred_at
         FROM apocalypse_transactions t
         WHERE t.cycle_id = $1
         UNION ALL
         SELECT 'LEDGER' AS source,
                e.type AS type,
                e.cash_event_id AS source_id,
                e.participant_id,
                e.user_id,
                e.amount AS amount,
                NULL::integer AS coin_id,
                NULL::numeric AS quantity,
                NULL::numeric AS price,
                e.description AS description,
                e.created_at AS occurred_at
         FROM apocalypse_cash_events e
         WHERE e.cycle_id = $1
       ) activity
       ORDER BY occurred_at ${sortDirection},
                source ASC,
                source_id ${sortDirection}
       LIMIT $2 OFFSET $3`,
      [cycle.cycle_id, cappedLimit, safeOffset]
    );

    const participantIds = [...new Set(rows.map((row) => row.participant_id))];
    const coinIds = [...new Set(rows.filter((row) => row.coin_id !== null).map((row) => row.coin_id))];

    const identityByParticipant = new Map();
    if (participantIds.length > 0) {
      const { rows: identities } = await client.query(
        `SELECT p.participant_id, u.username, u.is_bot, b.strategy AS personality
         FROM apocalypse_participants p
         JOIN users u ON u.user_id = p.user_id
         LEFT JOIN apocalypse_bots b ON b.user_id = p.user_id
         WHERE p.participant_id = ANY($1::int[])`,
        [participantIds]
      );
      for (const identity of identities) {
        identityByParticipant.set(identity.participant_id, identity);
      }
    }

    const symbolByCoin = new Map();
    if (coinIds.length > 0) {
      const { rows: coinRows } = await client.query(
        // Deliberately unfiltered by coins.retired: retired coins keep their
        // full history readable.
        `SELECT coin_id, symbol FROM coins WHERE coin_id = ANY($1::int[])`,
        [coinIds]
      );
      for (const coin of coinRows) {
        symbolByCoin.set(coin.coin_id, coin.symbol);
      }
    }

    const activities = rows.map((row) => {
      const identity = identityByParticipant.get(row.participant_id);
      const base = {
        cycleId: cycle.apocalypse_id,
        source: row.source,
        type: row.type,
        participantId: row.participant_id,
        userId: row.user_id,
        username: identity ? identity.username : null,
        kind: identity && identity.is_bot === true ? 'BOT' : 'HUMAN',
        amount: parseFloat(row.amount),
        occurredAt: new Date(row.occurred_at).toISOString()
      };
      if (row.source === 'TRADE') {
        const quantity = parseFloat(row.quantity);
        const price = parseFloat(row.price);
        const symbol = symbolByCoin.get(row.coin_id) || null;
        return {
          ...base,
          coinId: row.coin_id,
          symbol,
          quantity,
          price,
          description: `${row.type} ${quantity} ${symbol || `coin ${row.coin_id}`} @ £${price.toFixed(2)}`
        };
      }
      return { ...base, description: row.description };
    });

    return {
      ...publicCycle(cycle),
      order: direction,
      limit: cappedLimit,
      offset: safeOffset,
      total,
      returned: activities.length,
      activities
    };
  });
}

// ---------------------------------------------------------------------------
// Bot action summary: aggregates apocalypse_bot_ticks so operators never
// parse the per-tick actions JSONB by hand. HOLD decisions (decision type
// HOLD, recorded as result 'skipped' + reason 'hold') are reported
// separately from other skip reasons; domain rejections are 'rejected'.
// ---------------------------------------------------------------------------
async function getCycleDiagnosticsBots(rawCycleId) {
  return readOnly(async (client) => {
    const cycle = await resolveCycle(client, rawCycleId);

    const { rows: tickRows } = await client.query(
      `SELECT tick_id, actions, executed_at
       FROM apocalypse_bot_ticks
       WHERE cycle_id = $1
       ORDER BY tick_id ASC`,
      [cycle.cycle_id]
    );

    const perBot = new Map();
    const skipByReason = {};
    const rejectByReason = {};
    let actionsRecorded = 0;
    let executedBuy = 0;
    let executedSell = 0;
    let holdCount = 0;
    let skippedCount = 0;
    let rejectedCount = 0;

    const botBucket = (botKey) => {
      if (!perBot.has(botKey)) {
        perBot.set(botKey, {
          botKey,
          actions: 0,
          executedBuys: 0,
          executedSells: 0,
          holds: 0,
          skipped: 0,
          rejected: 0
        });
      }
      return perBot.get(botKey);
    };

    for (const tick of tickRows) {
      // actions is JSONB (pg already parsed it); tolerate non-array rows
      // defensively rather than crashing a diagnostic read.
      const actions = Array.isArray(tick.actions) ? tick.actions : [];
      for (const action of actions) {
        if (!action || typeof action !== 'object') continue;
        actionsRecorded += 1;
        const bucket = botBucket(typeof action.botKey === 'string' ? action.botKey : 'unknown');
        bucket.actions += 1;

        const reason = typeof action.reason === 'string' ? action.reason : 'unknown';
        if (action.result === 'executed') {
          const decidedType = action.action && action.action.type;
          if (decidedType === 'BUY') {
            executedBuy += 1;
            bucket.executedBuys += 1;
          } else if (decidedType === 'SELL') {
            executedSell += 1;
            bucket.executedSells += 1;
          }
        } else if (action.result === 'rejected') {
          rejectedCount += 1;
          bucket.rejected += 1;
          // Rejection reasons are GameRoundError messages — already
          // player-facing via the trade API, never internal text.
          rejectByReason[reason] = (rejectByReason[reason] || 0) + 1;
        } else {
          // Everything else is a skip; 'hold' is the deliberate HOLD
          // decision and is counted both as a skip and separately.
          skippedCount += 1;
          bucket.skipped += 1;
          skipByReason[reason] = (skipByReason[reason] || 0) + 1;
          if (reason === 'hold') {
            holdCount += 1;
            bucket.holds += 1;
          }
        }
      }
    }

    // Bot identity (strategy/personality) from the canonical Core 5 roster.
    const { rows: roster } = await client.query(
      `SELECT bot_key, strategy FROM apocalypse_bots ORDER BY bot_key ASC`
    );
    const strategyByKey = new Map(roster.map((bot) => [bot.bot_key, bot.strategy]));

    return {
      ...publicCycle(cycle),
      tickCount: tickRows.length,
      firstTickAt: tickRows.length > 0 ? new Date(tickRows[0].executed_at).toISOString() : null,
      lastTickAt: tickRows.length > 0 ? new Date(tickRows[tickRows.length - 1].executed_at).toISOString() : null,
      actionsRecorded,
      executed: { total: executedBuy + executedSell, buy: executedBuy, sell: executedSell },
      skipped: { total: skippedCount, hold: holdCount, byReason: skipByReason },
      rejected: { total: rejectedCount, byReason: rejectByReason },
      perBot: [...perBot.values()]
        .sort((a, b) => a.botKey.localeCompare(b.botKey))
        .map((bucket) => ({ ...bucket, personality: strategyByKey.get(bucket.botKey) || null }))
    };
  });
}

// ---------------------------------------------------------------------------
// Apocalypse Monitor Phase 2: raw per-coin price_history series for one
// cycle, with honest provenance attribution.
//
// Row selection (single bounded scan, no N+1):
//   * EXACT rows: price_history.cycle_id = <selected cycle's internal id>.
//     Never timestamp-matched — a row tagged to another cycle is never
//     pulled into this one, wherever its created_at falls.
//   * LEGACY rows: cycle_id IS NULL (pre-019 rows are never backfilled) AND
//     created_at >= start_time AND created_at < end_time (half-open). These
//     are attributed by time window and marked derived.
//   * Future-dated rows (created_at > now()) are never exposed: executed
//     history only.
// Attribution describes the whole selected dataset per coin (not just the
// returned sample): exact / time_window_derived / mixed. The dataset-level
// `exact` boolean is false whenever any derived row is in the dataset.
// ---------------------------------------------------------------------------

// Per-coin cap on returned points. A normal 30-minute cycle writes ~60
// ticks per coin (30s cadence), so this is ~16x headroom; the truncation
// warning tells the operator when a longer cycle exceeded it.
const MAX_MONITOR_POINTS_PER_COIN = 1000;

// ?coinId= must be a positive integer (400 otherwise, 404 when the coin
// does not exist). Never silently coerced.
function resolveMonitorCoinId(raw) {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    return null;
  }
  const trimmed = typeof raw === 'string' ? raw.trim() : raw;
  if (typeof trimmed === 'string' && !/^\d+$/.test(trimmed)) {
    throw new GameDiagnosticsError('Invalid coinId. Please provide a positive integer coin id.', 400);
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new GameDiagnosticsError('Invalid coinId. Please provide a positive integer coin id.', 400);
  }
  return value;
}

function attributionFor(exactCount, derivedCount) {
  if (derivedCount === 0) return 'exact';
  if (exactCount === 0) return 'time_window_derived';
  return 'mixed';
}

async function getCycleDiagnosticsMonitor(rawCycleId, { coinId } = {}) {
  const filterCoinId = resolveMonitorCoinId(coinId);

  return readOnly(async (client) => {
    const cycle = await resolveCycle(client, rawCycleId);
    const startTime = new Date(cycle.start_time);
    const endTime = new Date(cycle.end_time);

    // Observation timestamp from the database clock inside this read-only
    // transaction: now() is constant for the whole snapshot.
    const { rows: nowRows } = await client.query('SELECT now() AS observed_at');
    const observedAt = new Date(nowRows[0].observed_at);

    // Coin selection. Default: every non-retired coin (the live catalogue),
    // plus a retired coin only when it GENUINELY has selected-cycle history:
    // exact rows tagged to this cycle, or legacy rows inside the window.
    // With ?coinId= the operator asked for one coin explicitly: 404 when it
    // does not exist, otherwise returned even if retired.
    let coins;
    if (filterCoinId !== null) {
      const { rows } = await client.query(
        `SELECT coin_id, name, symbol FROM coins WHERE coin_id = $1`,
        [filterCoinId]
      );
      if (rows.length === 0) {
        throw new GameDiagnosticsError(`Unknown coin ${filterCoinId}.`, 404);
      }
      coins = rows;
    } else {
      const { rows } = await client.query(
        `SELECT c.coin_id, c.name, c.symbol
         FROM coins c
         WHERE c.retired = FALSE
            OR EXISTS (
                 SELECT 1 FROM price_history ph
                 WHERE ph.coin_id = c.coin_id AND ph.cycle_id = $1
                   AND ph.created_at <= now()
               )
            OR EXISTS (
                 SELECT 1 FROM price_history ph
                 WHERE ph.coin_id = c.coin_id AND ph.cycle_id IS NULL
                   AND ph.created_at >= $2 AND ph.created_at < $3
                   AND ph.created_at <= now()
               )
         ORDER BY c.coin_id ASC`,
        [cycle.cycle_id, startTime.toISOString(), endTime.toISOString()]
      );
      coins = rows;
    }

    const coinIds = coins.map((coin) => coin.coin_id);

    // Per-coin dataset totals over ALL matched rows (exact vs derived), so
    // attribution describes the selected dataset even when the returned
    // point sample is capped. One bounded GROUP BY scan — no N+1.
    const totalsByCoin = new Map();
    if (coinIds.length > 0) {
      const { rows: totals } = await client.query(
        `SELECT ph.coin_id,
                count(*)::int AS total,
                count(*) FILTER (WHERE ph.cycle_id = $1)::int AS exact_count
         FROM price_history ph
         WHERE ph.coin_id = ANY($4::int[])
           AND ph.created_at <= now()
           AND (
             ph.cycle_id = $1
             OR (ph.cycle_id IS NULL AND ph.created_at >= $2 AND ph.created_at < $3)
           )
         GROUP BY ph.coin_id`,
        [cycle.cycle_id, startTime.toISOString(), endTime.toISOString(), coinIds]
      );
      for (const row of totals) {
        totalsByCoin.set(row.coin_id, { total: row.total, exactCount: row.exact_count });
      }
    }

    // The returned point sample: earliest rows first, capped per coin via a
    // window function in ONE bounded query. `(ph.cycle_id = $1)` flags exact
    // rows; rows tagged to other cycles are excluded by the WHERE clause.
    const pointsByCoin = new Map();
    if (coinIds.length > 0) {
      const { rows: pointRows } = await client.query(
        `SELECT coin_id, price, created_at, source, exact
         FROM (
           SELECT ph.coin_id, ph.price, ph.created_at, ph.source,
                  (ph.cycle_id = $1) AS exact,
                  ROW_NUMBER() OVER (
                    PARTITION BY ph.coin_id
                    ORDER BY ph.created_at ASC, ph.price_history_id ASC
                  ) AS rn
           FROM price_history ph
           WHERE ph.coin_id = ANY($4::int[])
             AND ph.created_at <= now()
             AND (
               ph.cycle_id = $1
               OR (ph.cycle_id IS NULL AND ph.created_at >= $2 AND ph.created_at < $3)
             )
         ) sampled
         WHERE rn <= $5
         ORDER BY coin_id ASC, created_at ASC`,
        [cycle.cycle_id, startTime.toISOString(), endTime.toISOString(), coinIds, MAX_MONITOR_POINTS_PER_COIN]
      );
      for (const row of pointRows) {
        if (!pointsByCoin.has(row.coin_id)) {
          pointsByCoin.set(row.coin_id, []);
        }
        pointsByCoin.get(row.coin_id).push({
          time: new Date(row.created_at).toISOString(),
          price: parseFloat(row.price),
          // Legacy rows carry no provenance tag; null is the honest value.
          source: row.source || null
        });
      }
    }

    const warnings = [];
    let datasetExact = 0;
    let datasetDerived = 0;

    const coinsOut = coins.map((coin) => {
      const totals = totalsByCoin.get(coin.coin_id) || { total: 0, exactCount: 0 };
      const derivedCount = totals.total - totals.exactCount;
      datasetExact += totals.exactCount;
      datasetDerived += derivedCount;

      const points = pointsByCoin.get(coin.coin_id) || [];
      if (totals.total > points.length) {
        warnings.push(
          `Coin ${coin.coin_id} (${coin.symbol}) has ${totals.total} price rows in this cycle; ` +
          `showing the earliest ${points.length} (cap ${MAX_MONITOR_POINTS_PER_COIN}).`
        );
      }

      return {
        coinId: coin.coin_id,
        name: coin.name,
        symbol: coin.symbol,
        history: {
          sampleCount: points.length,
          firstObservedAt: points.length > 0 ? points[0].time : null,
          lastObservedAt: points.length > 0 ? points[points.length - 1].time : null,
          attribution: totals.total === 0 ? null : attributionFor(totals.exactCount, derivedCount),
          points
        }
      };
    });

    if (datasetDerived > 0) {
      warnings.push(
        `${datasetDerived} price row(s) carry no cycle provenance (legacy rows); ` +
        `attributed by time window [${startTime.toISOString()}, ${endTime.toISOString()}).`
      );
    }

    const attribution = attributionFor(datasetExact, datasetDerived);

    return {
      cycle: {
        cycleId: cycle.apocalypse_id,
        status: cycle.status,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        settlementStartedAt: cycle.settlement_started_at
          ? new Date(cycle.settlement_started_at).toISOString()
          : null,
        settledAt: cycle.settled_at ? new Date(cycle.settled_at).toISOString() : null,
        observedAt: observedAt.toISOString()
      },
      attribution,
      exact: datasetDerived === 0,
      coins: coinsOut,
      warnings
    };
  });
}

// ---------------------------------------------------------------------------
// Apocalypse Monitor Phase 2.5: recent cycle discovery.
//
// Newest-first list of persisted cycles (ACTIVE / SETTLING / COMPLETED) so an
// operator can pick a cycleId for the monitor endpoint above. Each entry
// exposes ONLY the public cycle fields plus hasExactHistory: true iff at
// least one price_history row carries the cycle's EXACT provenance
// (price_history.cycle_id = the cycle's internal id). Legacy rows
// (cycle_id IS NULL, never backfilled) never count, even when they fall
// inside the cycle's time window. The flag is computed with ONE correlated
// EXISTS over the page — no N+1, and the future schedule, seeds, ranks and
// bot data are never read.
// ---------------------------------------------------------------------------
const DEFAULT_MONITOR_CYCLES_LIMIT = 20;
const MAX_MONITOR_CYCLES_LIMIT = 100;

// ?limit= must be a strict integer in [1, MAX] (400 otherwise — invalid and
// excessive values are rejected, never silently coerced or capped). Same
// convention as the activity stream's resolveActivityLimit.
function resolveMonitorCyclesLimit(raw) {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    return DEFAULT_MONITOR_CYCLES_LIMIT;
  }
  const trimmed = typeof raw === 'string' ? raw.trim() : raw;
  if (typeof trimmed === 'string' && !/^[+-]?\d+$/.test(trimmed)) {
    throw new GameDiagnosticsError(
      `Invalid limit. Please provide an integer between 1 and ${MAX_MONITOR_CYCLES_LIMIT}.`,
      400
    );
  }
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < 1 || value > MAX_MONITOR_CYCLES_LIMIT) {
    throw new GameDiagnosticsError(
      `Invalid limit. Please provide an integer between 1 and ${MAX_MONITOR_CYCLES_LIMIT}.`,
      400
    );
  }
  return value;
}

async function getCycleDiagnosticsMonitorCycles({ limit } = {}) {
  const cappedLimit = resolveMonitorCyclesLimit(limit);

  return readOnly(async (client) => {
    // Newest first: cycle_id is the insertion order, matching the "most
    // recent cycle" convention in resolveCycle.
    const { rows } = await client.query(
      `SELECT c.apocalypse_id, c.status, c.start_time, c.end_time, c.settled_at,
              EXISTS (
                SELECT 1 FROM price_history ph
                WHERE ph.cycle_id = c.cycle_id
              ) AS has_exact_history
       FROM apocalypse_cycles c
       WHERE c.status IN ('ACTIVE', 'SETTLING', 'COMPLETED')
       ORDER BY c.cycle_id DESC
       LIMIT $1`,
      [cappedLimit]
    );

    return {
      limit: cappedLimit,
      returned: rows.length,
      cycles: rows.map((row) => ({
        cycleId: row.apocalypse_id,
        status: row.status,
        startTime: new Date(row.start_time).toISOString(),
        endTime: new Date(row.end_time).toISOString(),
        settledAt: row.settled_at ? new Date(row.settled_at).toISOString() : null,
        hasExactHistory: row.has_exact_history === true
      }))
    };
  });
}

module.exports = {
  DEFAULT_ACTIVITY_LIMIT,
  MAX_ACTIVITY_LIMIT,
  MAX_ACTIVITY_OFFSET,
  MAX_MONITOR_POINTS_PER_COIN,
  DEFAULT_MONITOR_CYCLES_LIMIT,
  MAX_MONITOR_CYCLES_LIMIT,
  GameDiagnosticsError,
  resolveActivityLimit,
  resolveActivityOffset,
  resolveActivityOrder,
  resolveMonitorCoinId,
  resolveMonitorCyclesLimit,
  getCycleDiagnosticsParticipants,
  getCycleDiagnosticsActivity,
  getCycleDiagnosticsBots,
  getCycleDiagnosticsMonitor,
  getCycleDiagnosticsMonitorCycles
};
