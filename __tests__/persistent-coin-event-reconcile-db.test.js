// Director Coin Events Wave 3: the writer-batch reconciliation wrapper
// (game/persistentCoinEventRuntime.js#reconcilePersistentCoinEvents)
// against the REAL disposable test database.
//
// Covered:
//   * reconciliation to the planner targets through the Wave 1 model:
//     missing-to-target creation, exact persisted payloads, monotone
//     per-coin sequences;
//   * same-batch replay idempotency: a repeated reconcile at the same
//     instant with the same committed state creates nothing (the Wave 1
//     identity backstop observes the committed rows);
//   * restart/re-entry: with active events already committed, a reconcile
//     does NOT recreate a full set — only genuine shortfalls top up;
//   * expiry: expired rows are retained untouched as history while the
//     sequence cursor continues past them;
//   * caps: creation never exceeds the configured total/per-direction
//     active caps, even above-target plans;
//   * concurrency: two transactions reconciling the same coin race into
//     the model's coin-row serialisation — exactly one payload set
//     survives, no duplicates, and a divergent payload at a committed
//     identity fails loudly (never a silent overwrite);
//   * scope: persistent_coin_events only — never apocalypse_coin_events.
//
// Every mutating test passes through the repository's disposable test DB
// guard (jest.setup.js also reseeds before each test).

const db = require('../db/connection');
const persistentWorld = require('../game/persistentWorld');
const eventsModel = require('../models/persistentCoinEvents.model');
const { reconcilePersistentCoinEvents } = require('../game/persistentCoinEventRuntime');
const { resolveSimulationConfig } = require('../game/simulationConfig');
const { assertDisposableTestDatabase } = require('./helpers/testDatabaseGuard');

jest.setTimeout(30000);

const CONFIG = resolveSimulationConfig();
const WORLD_SEED = 'wave3-reconcile-db-seed';
const EPOCH_MS = Date.parse('2026-08-31T00:00:00.000Z');
const BASE_MS = Date.parse('2026-09-01T00:00:00.000Z');
const MINUTE = 60 * 1000;
const DECISION = { mode: 'NORMAL', decisionIndex: 0 };

async function provisionedWorld() {
  return persistentWorld.provisionWorld(db, { seed: WORLD_SEED, epochStartedAt: new Date(EPOCH_MS) });
}

function planFor(coinIds, overrides = {}) {
  return coinIds.map((coinId) => ({
    coinId,
    targetPositive: 1,
    targetNegative: 1,
    role: null,
    reason: 'NORMAL baseline',
    ...overrides
  }));
}

// Run one reconcile inside its own transaction on a dedicated client
// (mirroring the writer batch: the wrapper never opens a nested one).
async function reconciled(args) {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const result = await reconcilePersistentCoinEvents(client, args);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function eventRows(worldId, coinId = null) {
  const params = [worldId];
  let sql = `SELECT coin_id, event_seq, name, direction, source, modifier::text, starts_at, ends_at
               FROM persistent_coin_events WHERE world_id = $1`;
  if (coinId !== null) {
    params.push(coinId);
    sql += ' AND coin_id = $2';
  }
  sql += ' ORDER BY coin_id, event_seq';
  const { rows } = await db.query(sql, params);
  return rows;
}

describe('Wave 3 reconcile (DB): creation, replay and expiry', () => {
  beforeEach(() => {
    assertDisposableTestDatabase();
  });

  test('creates exactly the missing events to the planner targets and returns the post-reconcile active sets', async () => {
    const world = await provisionedWorld();
    const result = await reconciled({
      world, decision: DECISION, plan: planFor([1, 2]), eventSeverityScale: 1, nowMs: BASE_MS, config: CONFIG
    });

    const rows = await eventRows(world.worldId);
    expect(rows).toHaveLength(4); // 2 coins x (1 positive + 1 negative)
    for (const coinId of [1, 2]) {
      const coinRows = rows.filter((r) => r.coin_id === coinId);
      expect(coinRows.map((r) => r.event_seq)).toEqual([1, 2]);
      expect(coinRows.map((r) => r.direction).sort()).toEqual(['NEGATIVE', 'POSITIVE']);
      for (const row of coinRows) {
        expect(row.source).toBe('NORMAL');
        expect(Math.abs(parseFloat(row.modifier))).toBeLessThanOrEqual(CONFIG.persistentEvents.maxIndividualModifier);
        expect(parseFloat(row.modifier)).not.toBe(0);
        const durationMs = row.ends_at.getTime() - row.starts_at.getTime();
        expect(durationMs).toBeGreaterThanOrEqual(CONFIG.persistentEvents.durationMs.min);
        expect(durationMs).toBeLessThanOrEqual(CONFIG.persistentEvents.durationMs.max);
        expect(row.starts_at.getTime()).toBe(BASE_MS);
      }
      // The returned map carries exactly the coin's post-reconcile actives.
      const activeAfter = result.get(coinId);
      expect(activeAfter).toHaveLength(2);
      expect(activeAfter.map((e) => e.eventSeq).sort()).toEqual([1, 2]);
    }
  });

  test('same-instant replay is a strict no-op (identity backstop; no duplicates)', async () => {
    const world = await provisionedWorld();
    await reconciled({ world, decision: DECISION, plan: planFor([1]), eventSeverityScale: 1, nowMs: BASE_MS, config: CONFIG });
    const before = await eventRows(world.worldId);

    const replay = await reconciled({
      world, decision: DECISION, plan: planFor([1]), eventSeverityScale: 1, nowMs: BASE_MS, config: CONFIG
    });

    expect(await eventRows(world.worldId)).toEqual(before);
    // The replayed reconcile returns the committed actives unchanged.
    expect(replay.get(1).map((e) => e.eventSeq).sort()).toEqual([1, 2]);
  });

  test('restart/re-entry with existing active events does not recreate a full set; expiry retains history and continues the sequence', async () => {
    const world = await provisionedWorld();
    await reconciled({ world, decision: DECISION, plan: planFor([1]), eventSeverityScale: 1, nowMs: BASE_MS, config: CONFIG });
    const committed = await eventRows(world.worldId, 1);
    expect(committed).toHaveLength(2);

    // Re-entry while both events are still active: nothing is recreated.
    const reentry = await reconciled({
      world, decision: DECISION, plan: planFor([1]), eventSeverityScale: 1, nowMs: BASE_MS + 30 * 1000, config: CONFIG
    });
    expect(await eventRows(world.worldId, 1)).toHaveLength(2);
    expect(reentry.get(1)).toHaveLength(2);

    // After both expire, a later reconcile tops up with FRESH sequences;
    // the expired rows survive byte-identical as history.
    const latestEnd = Math.max(...committed.map((r) => r.ends_at.getTime()));
    const laterMs = latestEnd + MINUTE;
    await reconciled({ world, decision: DECISION, plan: planFor([1]), eventSeverityScale: 1, nowMs: laterMs, config: CONFIG });
    const after = await eventRows(world.worldId, 1);
    expect(after).toHaveLength(4);
    expect(after.slice(0, 2)).toEqual(committed); // expired history untouched
    expect(after.slice(2).map((r) => r.event_seq)).toEqual([3, 4]);
    expect(after.slice(2).every((r) => r.starts_at.getTime() === laterMs)).toBe(true);
  });

  test('creation is clamped to the configured caps even for an above-target plan', async () => {
    const world = await provisionedWorld();
    await reconciled({
      world,
      decision: DECISION,
      plan: [{ coinId: 1, targetPositive: 4, targetNegative: 4, role: null, reason: 'over-plan' }],
      eventSeverityScale: 1,
      nowMs: BASE_MS,
      config: CONFIG
    });
    const rows = await eventRows(world.worldId, 1);
    // Total cap 5: four positives fill first (canonical order), one negative fits.
    expect(rows).toHaveLength(CONFIG.persistentEvents.maxActivePerCoin);
    expect(rows.filter((r) => r.direction === 'POSITIVE')).toHaveLength(CONFIG.persistentEvents.maxActivePositivePerCoin);
    expect(rows.filter((r) => r.direction === 'NEGATIVE')).toHaveLength(1);
    // The Wave 1 model's own capacity verdict agrees: every created event
    // overlapped at the creation instant within the caps (no capacity error
    // was thrown) and the persisted rows prove the bound.
  });

  test('planner roles and decision modes flow through to persisted sources', async () => {
    const world = await provisionedWorld();
    await reconciled({
      world,
      decision: { mode: 'RESCUE', decisionIndex: 3 },
      plan: [
        { coinId: 1, targetPositive: 1, targetNegative: 0, role: 'GOLDEN', reason: 'golden positive bias' },
        { coinId: 2, targetPositive: 1, targetNegative: 0, role: null, reason: 'rescue' }
      ],
      eventSeverityScale: 1,
      nowMs: BASE_MS,
      config: CONFIG
    });
    const rows = await eventRows(world.worldId);
    expect(rows.find((r) => r.coin_id === 1).source).toBe('GOLDEN');
    expect(rows.find((r) => r.coin_id === 2).source).toBe('RESCUE');
  });

  test('scope: reconciliation never touches the Apocalypse cycle event authority', async () => {
    const world = await provisionedWorld();
    await reconciled({ world, decision: DECISION, plan: planFor([1, 2]), eventSeverityScale: 1, nowMs: BASE_MS, config: CONFIG });
    expect((await db.query('SELECT count(*)::int AS n FROM apocalypse_coin_events')).rows[0].n).toBe(0);
  });

  test('loud validation: client, world, decision and plan are required', async () => {
    const world = await provisionedWorld();
    await expect(reconcilePersistentCoinEvents(null, {
      world, decision: DECISION, plan: [], nowMs: BASE_MS, config: CONFIG
    })).rejects.toThrow(/client/);
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      await expect(reconcilePersistentCoinEvents(client, {
        world: { worldId: 0, seed: '' }, decision: DECISION, plan: [], nowMs: BASE_MS, config: CONFIG
      })).rejects.toThrow(/world/);
      await expect(reconcilePersistentCoinEvents(client, {
        world, decision: { mode: 'SIDEWAYS', decisionIndex: 0 }, plan: [], nowMs: BASE_MS, config: CONFIG
      })).rejects.toThrow(/mode/);
      await expect(reconcilePersistentCoinEvents(client, {
        world, decision: DECISION, plan: 'nope', nowMs: BASE_MS, config: CONFIG
      })).rejects.toThrow(/plan/);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });
});

describe('Wave 3 reconcile (DB): concurrency and identity safety', () => {
  beforeEach(() => {
    assertDisposableTestDatabase();
  });

  test('concurrent identical reconciliations serialise on the coin lock: one payload set, no duplicates', async () => {
    const world = await provisionedWorld();
    const args = { world, decision: DECISION, plan: planFor([1]), eventSeverityScale: 1, nowMs: BASE_MS, config: CONFIG };

    const clientA = await db.getClient();
    const clientB = await db.getClient();
    try {
      await clientA.query('BEGIN');
      await clientB.query('BEGIN');
      // A reconciles first and holds the coin row lock until commit; B's
      // first insert blocks on that lock, then observes A's committed rows
      // (READ COMMITTED fresh snapshot per statement) and no-ops.
      const resultA = await reconcilePersistentCoinEvents(clientA, args);
      const pendingB = reconcilePersistentCoinEvents(clientB, args)
        .then(async (resultB) => { await clientB.query('COMMIT'); return resultB; })
        .catch(async (error) => { await clientB.query('ROLLBACK').catch(() => {}); throw error; });
      await new Promise((resolve) => setImmediate(resolve)); // let B reach its blocking insert
      await clientA.query('COMMIT');
      const resultB = await pendingB;

      expect(resultA.get(1)).toHaveLength(2);
      expect(resultB.get(1)).toHaveLength(2); // B observes the committed actives
      const rows = await eventRows(world.worldId, 1);
      expect(rows).toHaveLength(2); // exactly one payload set committed
      expect(new Set(rows.map((r) => r.event_seq)).size).toBe(2);
    } finally {
      clientA.release();
      clientB.release();
    }
  });

  test('a divergent payload at a committed identity fails loudly and is never silently overwritten', async () => {
    const world = await provisionedWorld();
    await reconciled({ world, decision: DECISION, plan: planFor([1]), eventSeverityScale: 1, nowMs: BASE_MS, config: CONFIG });
    const committed = await eventRows(world.worldId, 1);

    // A hand-forged divergent payload at the committed (world, coin, seq 1)
    // identity — the Wave 1 model must reject it loudly.
    await expect(eventsModel.insertPersistentCoinEvent(db, {
      worldId: world.worldId,
      coinId: 1,
      eventSeq: 1,
      name: 'Forged Overwrite Attempt',
      direction: 'POSITIVE',
      source: 'NORMAL',
      modifier: 0.04,
      startsAt: new Date(BASE_MS).toISOString(),
      endsAt: new Date(BASE_MS + 5 * MINUTE).toISOString()
    }, { config: CONFIG })).rejects.toThrow(/identity conflict/);

    expect(await eventRows(world.worldId, 1)).toEqual(committed);
  });
});
