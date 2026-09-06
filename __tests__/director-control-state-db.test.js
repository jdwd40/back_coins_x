// Director Coin Events Wave 1: the persisted Director short-term
// runtime/control state (director_control_state, migration 029) against the
// REAL disposable test database — state round-trip, replay/idempotent
// decision cursor, Golden/Demon distinctness, loud failure on corrupt
// state, and safe-restart semantics.
//
// This state is deliberately SEPARATE from market_director_state (the
// deterministic six-regime Director cursor): nothing here touches or
// repurposes that table. Internal-only: no public API fields.
//
// Every mutating test passes through the repository's disposable test DB
// guard (jest.setup.js also reseeds before each test).

const db = require('../db/connection');
const persistentWorld = require('../game/persistentWorld');
const control = require('../models/directorControlState.model');
const { assertDisposableTestDatabase } = require('./helpers/testDatabaseGuard');

jest.setTimeout(30000);

const WORLD_SEED = 'wave1-director-control-db-seed';
const BASE_MS = new Date('2026-09-01T00:00:00Z').getTime();
const MINUTE = 60 * 1000;

async function provisionedWorld() {
  return persistentWorld.provisionWorld(db, { seed: WORLD_SEED, epochStartedAt: new Date('2026-08-31T00:00:00Z') });
}

function validState(worldId, overrides = {}) {
  return {
    worldId,
    mode: 'NORMAL',
    direction: 'POSITIVE',
    intensity: 0.5,
    startedAt: new Date(BASE_MS).toISOString(),
    endsAt: new Date(BASE_MS + 10 * MINUTE).toISOString(),
    decisionIndex: 3,
    reason: 'broad swing due',
    goldenCoinId: null,
    goldenExpiresAt: null,
    demonCoinId: null,
    demonExpiresAt: null,
    lastSwingDirection: 'NEGATIVE',
    lastMeaningfulMovementAt: new Date(BASE_MS - 5 * MINUTE).toISOString(),
    ...overrides
  };
}

describe('Wave 1: Director control state round-trip and safe restart', () => {
  beforeEach(() => {
    assertDisposableTestDatabase();
  });

  test('no control state exists before the first commit', async () => {
    const world = await provisionedWorld();
    expect(await control.loadDirectorControlState(db, world.worldId)).toBeNull();
  });

  test('a committed state round-trips exactly, including Golden/Demon assignments', async () => {
    const world = await provisionedWorld();
    const state = validState(world.worldId, {
      mode: 'BOOM',
      goldenCoinId: 2,
      goldenExpiresAt: new Date(BASE_MS + 20 * MINUTE).toISOString(),
      demonCoinId: 5,
      demonExpiresAt: new Date(BASE_MS + 25 * MINUTE).toISOString()
    });
    await control.upsertDirectorControlState(db, state);
    const loaded = await control.loadDirectorControlState(db, world.worldId);
    expect(loaded.worldId).toBe(world.worldId);
    expect(loaded.mode).toBe('BOOM');
    expect(loaded.direction).toBe('POSITIVE');
    expect(loaded.intensity).toBe(0.5);
    expect(new Date(loaded.startedAt).getTime()).toBe(BASE_MS);
    expect(new Date(loaded.endsAt).getTime()).toBe(BASE_MS + 10 * MINUTE);
    expect(loaded.decisionIndex).toBe(3);
    expect(loaded.reason).toBe('broad swing due');
    expect(loaded.goldenCoinId).toBe(2);
    expect(new Date(loaded.goldenExpiresAt).getTime()).toBe(BASE_MS + 20 * MINUTE);
    expect(loaded.demonCoinId).toBe(5);
    expect(new Date(loaded.demonExpiresAt).getTime()).toBe(BASE_MS + 25 * MINUTE);
    expect(loaded.lastSwingDirection).toBe('NEGATIVE');
    expect(new Date(loaded.lastMeaningfulMovementAt).getTime()).toBe(BASE_MS - 5 * MINUTE);
  });

  test('a restart reads the same committed state (durable, not in-memory)', async () => {
    const world = await provisionedWorld();
    const state = validState(world.worldId);
    await control.upsertDirectorControlState(db, state);
    // Simulate a restart: read through a brand-new pooled client/transaction
    // with no shared in-memory state.
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      const loaded = await control.loadDirectorControlState(client, world.worldId);
      await client.query('COMMIT');
      expect(loaded.decisionIndex).toBe(3);
      expect(loaded.mode).toBe('NORMAL');
      expect(new Date(loaded.lastMeaningfulMovementAt).getTime()).toBe(BASE_MS - 5 * MINUTE);
    } finally {
      client.release();
    }
  });

  test('re-committing the same decision index is replay-safe; an older cursor fails loudly', async () => {
    const world = await provisionedWorld();
    await control.upsertDirectorControlState(db, validState(world.worldId));
    // Idempotent replay of the same decision (e.g. a retried commit after a
    // crash between work and commit observation) is allowed.
    await control.upsertDirectorControlState(db, validState(world.worldId));
    // A NEWER decision advances the cursor.
    await control.upsertDirectorControlState(db, validState(world.worldId, {
      decisionIndex: 4, mode: 'RESCUE', direction: 'NEGATIVE'
    }));
    const loaded = await control.loadDirectorControlState(db, world.worldId);
    expect(loaded.decisionIndex).toBe(4);
    expect(loaded.mode).toBe('RESCUE');
    // A STALE decision index (an old decision replayed after a newer one
    // committed) is rejected — the cursor never rewinds.
    await expect(control.upsertDirectorControlState(db, validState(world.worldId, { decisionIndex: 3 })))
      .rejects.toThrow(/decisionIndex|stale|cursor/i);
    const after = await control.loadDirectorControlState(db, world.worldId);
    expect(after.decisionIndex).toBe(4);
  });

  test('an equal decision index with a CONFLICTING payload fails loudly; the identical replay is a write-free no-op', async () => {
    const world = await provisionedWorld();
    const state = validState(world.worldId); // decisionIndex 3
    await control.upsertDirectorControlState(db, state);
    const updatedAt = async () => (await db.query(
      'SELECT updated_at FROM director_control_state WHERE world_id = $1',
      [world.worldId]
    )).rows[0].updated_at.getTime();
    const committedAt = await updatedAt();

    // Identical replay: accepted as a no-op — and write-free (updated_at
    // is untouched, proving no UPSERT ran).
    await control.upsertDirectorControlState(db, validState(world.worldId));
    expect(await updatedAt()).toBe(committedAt);

    // Equal index, different payload: a conflicting replay of the SAME
    // decision — rejected loudly, committed row unchanged.
    await expect(control.upsertDirectorControlState(db, validState(world.worldId, { reason: 'different reason' })))
      .rejects.toThrow(/conflict/i);
    await expect(control.upsertDirectorControlState(db, validState(world.worldId, { mode: 'RESCUE', direction: 'NEGATIVE' })))
      .rejects.toThrow(/conflict/i);
    await expect(control.upsertDirectorControlState(db, validState(world.worldId, {
      goldenCoinId: 2, goldenExpiresAt: new Date(BASE_MS + 20 * MINUTE).toISOString()
    }))).rejects.toThrow(/conflict/i);
    const loaded = await control.loadDirectorControlState(db, world.worldId);
    expect(loaded.decisionIndex).toBe(3);
    expect(loaded.mode).toBe('NORMAL');
    expect(loaded.reason).toBe('broad swing due');
    expect(loaded.goldenCoinId).toBeNull();
    expect(await updatedAt()).toBe(committedAt);

    // The cursor still advances on a newer index after the rejected replays.
    await control.upsertDirectorControlState(db, validState(world.worldId, { decisionIndex: 4, mode: 'BUST' }));
    expect((await control.loadDirectorControlState(db, world.worldId)).mode).toBe('BUST');
  });

  test('market_director_state is untouched by control-state writes', async () => {
    const world = await provisionedWorld();
    await control.upsertDirectorControlState(db, validState(world.worldId));
    // The deterministic six-regime Director cursor table stays empty —
    // the two states are fully separate authorities.
    expect((await db.query(
      'SELECT count(*)::int AS n FROM market_director_state WHERE world_id = $1',
      [world.worldId]
    )).rows[0].n).toBe(0);
  });
});

describe('Wave 1: Director control state first-write race (two real clients)', () => {
  beforeEach(() => {
    assertDisposableTestDatabase();
  });

  // Two pooled clients on explicit interleaved transactions: client A holds
  // the first committed decision open (world-row lock held), client B races
  // in behind it. Deterministic by construction — B cannot pass the world
  // row until A commits, then re-reads the committed cursor under the full
  // monotone/equal-index rules.
  // Give client B's statements time to reach Postgres and park on the lock
  // before A commits, so the interleaving never depends on scheduler timing.
  const parked = () => new Promise((resolve) => setTimeout(resolve, 150));

  test('a conflicting equal-index first upsert racing the first commit loses loudly and never overwrites the winner', async () => {
    const world = await provisionedWorld();
    const clientA = await db.getClient();
    const clientB = await db.getClient();
    try {
      await clientA.query('BEGIN');
      await clientB.query('BEGIN');
      // A writes the FIRST decision for this world (index 3) but keeps its
      // transaction — and the world-row lock — open.
      await control.upsertDirectorControlState(clientA, validState(world.worldId, { reason: 'winner decision' }));
      // B races in with a CONFLICTING payload at the SAME decision index:
      // it queues on the world row, then must lose loudly after A commits —
      // never silently overwrite the committed decision.
      const loser = control.upsertDirectorControlState(clientB, validState(world.worldId, {
        mode: 'RESCUE', direction: 'NEGATIVE', reason: 'conflicting loser'
      }));
      const expectation = expect(loser).rejects.toThrow(/conflict/i);
      await parked();
      await clientA.query('COMMIT');
      await expectation;
      await clientB.query('ROLLBACK');
    } finally {
      clientA.release();
      clientB.release();
    }
    // The committed row is exactly the winner's decision — not rewound, not
    // replaced by the loser's conflicting payload.
    const committed = await control.loadDirectorControlState(db, world.worldId);
    expect(committed.decisionIndex).toBe(3);
    expect(committed.mode).toBe('NORMAL');
    expect(committed.direction).toBe('POSITIVE');
    expect(committed.reason).toBe('winner decision');
  });

  test('a stale first upsert racing a newer first commit is rejected after the lock wait; the cursor never rewinds', async () => {
    const world = await provisionedWorld();
    const clientA = await db.getClient();
    const clientB = await db.getClient();
    try {
      await clientA.query('BEGIN');
      await clientB.query('BEGIN');
      await control.upsertDirectorControlState(clientA, validState(world.worldId, {
        decisionIndex: 4, mode: 'BUST', reason: 'newer winner'
      }));
      const loser = control.upsertDirectorControlState(clientB, validState(world.worldId, {
        decisionIndex: 3, reason: 'stale loser'
      }));
      const expectation = expect(loser).rejects.toThrow(/stale/i);
      await parked();
      await clientA.query('COMMIT');
      await expectation;
      await clientB.query('ROLLBACK');
    } finally {
      clientA.release();
      clientB.release();
    }
    const committed = await control.loadDirectorControlState(db, world.worldId);
    expect(committed.decisionIndex).toBe(4);
    expect(committed.mode).toBe('BUST');
    expect(committed.reason).toBe('newer winner');
  });

  test('an identical equal-index replay racing the first commit resolves as a write-free no-op', async () => {
    const world = await provisionedWorld();
    const clientA = await db.getClient();
    const clientB = await db.getClient();
    try {
      await clientA.query('BEGIN');
      await clientB.query('BEGIN');
      await control.upsertDirectorControlState(clientA, validState(world.worldId));
      // Identical payload, same index: a genuine replayed commit racing the
      // original — must be accepted as a no-op once it gets the world lock.
      const replay = control.upsertDirectorControlState(clientB, validState(world.worldId));
      await parked();
      await clientA.query('COMMIT');
      await replay;
      await clientB.query('COMMIT');
    } finally {
      clientA.release();
      clientB.release();
    }
    const committed = await control.loadDirectorControlState(db, world.worldId);
    expect(committed.decisionIndex).toBe(3);
    expect(committed.mode).toBe('NORMAL');
    expect(committed.reason).toBe('broad swing due');
  });
});

describe('Wave 1: Director control state validation', () => {
  beforeEach(() => {
    assertDisposableTestDatabase();
  });

  test('a control-state write for a missing world fails loudly before any write', async () => {
    await expect(control.upsertDirectorControlState(db, validState(999999)))
      .rejects.toThrow(/market world|missing world|provisioned/i);
    expect((await db.query('SELECT count(*)::int AS n FROM director_control_state')).rows[0].n).toBe(0);
  });

  test('Golden and Demon can never be the same coin (model + CHECK)', async () => {
    const world = await provisionedWorld();
    const both = {
      goldenCoinId: 4, goldenExpiresAt: new Date(BASE_MS + 20 * MINUTE).toISOString(),
      demonCoinId: 4, demonExpiresAt: new Date(BASE_MS + 25 * MINUTE).toISOString()
    };
    await expect(control.upsertDirectorControlState(db, validState(world.worldId, both)))
      .rejects.toThrow(/Golden|Demon|golden|demon/);
    // The CHECK constraint backs the model up at the SQL layer.
    await expect(db.query(
      `INSERT INTO director_control_state
         (world_id, mode, direction, intensity, started_at, ends_at, decision_index, reason,
          golden_coin_id, golden_expires_at, demon_coin_id, demon_expires_at)
       VALUES ($1, 'NORMAL', 'POSITIVE', 0.5, now(), now() + interval '10 minutes', 0, 'x',
               4, now() + interval '20 minutes', 4, now() + interval '25 minutes')`,
      [world.worldId]
    )).rejects.toThrow();
  });

  test('Golden/Demon assignments are pair-consistent (coin + expiry together or neither)', async () => {
    const world = await provisionedWorld();
    await expect(control.upsertDirectorControlState(db, validState(world.worldId, {
      goldenCoinId: 2, goldenExpiresAt: null
    }))).rejects.toThrow(/golden/i);
    await expect(control.upsertDirectorControlState(db, validState(world.worldId, {
      demonCoinId: null, demonExpiresAt: new Date(BASE_MS + 25 * MINUTE).toISOString()
    }))).rejects.toThrow(/demon/i);
    await expect(db.query(
      `INSERT INTO director_control_state
         (world_id, mode, direction, intensity, started_at, ends_at, decision_index, reason,
          golden_coin_id, golden_expires_at)
       VALUES ($1, 'NORMAL', 'POSITIVE', 0.5, now(), now() + interval '10 minutes', 0, 'x',
               2, NULL)`,
      [world.worldId]
    )).rejects.toThrow();
    // A Golden assignment must reference a real coin.
    await expect(control.upsertDirectorControlState(db, validState(world.worldId, {
      goldenCoinId: 999999, goldenExpiresAt: new Date(BASE_MS + 20 * MINUTE).toISOString()
    }))).rejects.toThrow(/foreign key|violates/i);
  });

  test('corrupt control state fails loudly at the model layer, backed by CHECK constraints', async () => {
    const world = await provisionedWorld();
    const base = validState(world.worldId);
    await expect(control.upsertDirectorControlState(db, { ...base, mode: 'SIDEWAYS' })).rejects.toThrow(/mode/);
    await expect(control.upsertDirectorControlState(db, { ...base, direction: 'UP' })).rejects.toThrow(/direction/);
    await expect(control.upsertDirectorControlState(db, { ...base, intensity: 1.5 })).rejects.toThrow(/intensity/);
    await expect(control.upsertDirectorControlState(db, { ...base, intensity: -0.1 })).rejects.toThrow(/intensity/);
    await expect(control.upsertDirectorControlState(db, { ...base, decisionIndex: -1 })).rejects.toThrow(/decisionIndex/);
    await expect(control.upsertDirectorControlState(db, { ...base, decisionIndex: 2.5 })).rejects.toThrow(/decisionIndex/);
    await expect(control.upsertDirectorControlState(db, { ...base, reason: '' })).rejects.toThrow(/reason/);
    await expect(control.upsertDirectorControlState(db, { ...base, startedAt: 'not-a-date' })).rejects.toThrow(/startedAt/);
    await expect(control.upsertDirectorControlState(db, {
      ...base, startedAt: new Date(BASE_MS + 30 * MINUTE).toISOString()
    })).rejects.toThrow(/endsAt|startedAt|window/i);
    await expect(control.upsertDirectorControlState(db, { ...base, lastSwingDirection: 'UP' })).rejects.toThrow(/lastSwingDirection/);
    await expect(control.upsertDirectorControlState(db, { ...base, lastMeaningfulMovementAt: 'not-a-date' })).rejects.toThrow(/lastMeaningfulMovementAt/);
    // SQL layer: the mode and window CHECKs reject what bypasses the model.
    await expect(db.query(
      `INSERT INTO director_control_state
         (world_id, mode, direction, intensity, started_at, ends_at, decision_index, reason)
       VALUES ($1, 'SIDEWAYS', 'POSITIVE', 0.5, now(), now() + interval '10 minutes', 0, 'x')`,
      [world.worldId]
    )).rejects.toThrow();
    await expect(db.query(
      `INSERT INTO director_control_state
         (world_id, mode, direction, intensity, started_at, ends_at, decision_index, reason)
       VALUES ($1, 'NORMAL', 'POSITIVE', 0.5, now(), now() - interval '10 minutes', 0, 'x')`,
      [world.worldId]
    )).rejects.toThrow();
    // Nothing rejected reached the table.
    expect((await db.query('SELECT count(*)::int AS n FROM director_control_state')).rows[0].n).toBe(0);
  });

  test('reading a corrupt committed row fails loudly instead of resuming bad state', () => {
    // rowToControlState validates on read: a corrupt row (however it got
    // there — e.g. a manual edit or a future incompatible writer) must fail
    // loudly rather than silently drive decisions.
    expect(() => control.rowToControlState({
      world_id: 1, mode: 'SIDEWAYS', direction: 'POSITIVE', intensity: 0.5,
      started_at: new Date(BASE_MS), ends_at: new Date(BASE_MS + 10 * MINUTE),
      decision_index: 0, reason: 'x',
      golden_coin_id: null, golden_expires_at: null,
      demon_coin_id: null, demon_expires_at: null,
      last_swing_direction: null, last_meaningful_movement_at: null
    })).toThrow(/mode/);
    expect(() => control.rowToControlState({
      world_id: 1, mode: 'NORMAL', direction: 'POSITIVE', intensity: 0.5,
      started_at: new Date(BASE_MS), ends_at: new Date(BASE_MS + 10 * MINUTE),
      decision_index: 0, reason: 'x',
      golden_coin_id: 2, golden_expires_at: null,
      demon_coin_id: null, demon_expires_at: null,
      last_swing_direction: null, last_meaningful_movement_at: null
    })).toThrow(/golden/i);
    expect(() => control.rowToControlState(null)).toThrow(/object|row/i);
  });

  test('every control mode in the NORMAL/BOOM/BUST/RESCUE vocabulary is accepted', async () => {
    const world = await provisionedWorld();
    let decisionIndex = 0;
    for (const mode of ['NORMAL', 'BOOM', 'BUST', 'RESCUE']) {
      await control.upsertDirectorControlState(db, validState(world.worldId, { mode, decisionIndex }));
      decisionIndex += 1;
    }
    const loaded = await control.loadDirectorControlState(db, world.worldId);
    expect(loaded.mode).toBe('RESCUE');
  });
});

describe('Wave 1: Director control state transaction ownership and lock-free reads', () => {
  beforeEach(() => {
    assertDisposableTestDatabase();
  });

  // Recording wrappers: the REAL pool/client sits underneath and every
  // statement still executes against the real disposable database — the
  // wrappers only observe which statements the model issues and on how
  // many clients. Narrowly justified: they never fake or alter persistence
  // behavior. All arguments are forwarded verbatim (pg's pool internals
  // call client.query in callback style — dropping any argument would
  // break pooled reuse), and the patch is undone on release so the
  // wrapper never leaks back into the pool.
  function recordingPool(real) {
    const statements = [];
    let clientsAcquired = 0;
    return {
      statements,
      clientsAcquired: () => clientsAcquired,
      async getClient() {
        clientsAcquired += 1;
        const client = await real.getClient();
        const origQuery = client.query;
        const origRelease = client.release;
        client.query = (...args) => {
          const text = typeof args[0] === 'string' ? args[0] : args[0] && args[0].text;
          statements.push(String(text));
          return origQuery.apply(client, args);
        };
        client.release = (...args) => {
          client.query = origQuery;
          client.release = origRelease;
          return origRelease.apply(client, args);
        };
        return client;
      }
    };
  }

  function recordingQueryable(real) {
    const statements = [];
    return {
      statements,
      async query(...args) {
        const text = typeof args[0] === 'string' ? args[0] : args[0] && args[0].text;
        statements.push(String(text));
        return real.query(...args);
      }
    };
  }

  const TXN_CONTROL = /^\s*(BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION)/i;

  test('upsert through the normal pool owns exactly one transaction and round-trips safely', async () => {
    const world = await provisionedWorld();
    const rec = recordingPool(db);
    await control.upsertDirectorControlState(rec, validState(world.worldId));
    // One acquired client, one BEGIN, one COMMIT, no ROLLBACK.
    expect(rec.clientsAcquired()).toBe(1);
    expect(rec.statements.filter((s) => /^\s*BEGIN/i.test(s))).toHaveLength(1);
    expect(rec.statements.filter((s) => /^\s*COMMIT/i.test(s))).toHaveLength(1);
    expect(rec.statements.filter((s) => /^\s*ROLLBACK/i.test(s))).toHaveLength(0);
    // Fixed mutation lock order on the owned client: market_worlds row
    // FOR UPDATE first, then the director_control_state row FOR UPDATE,
    // then the write.
    const worldLock = rec.statements.findIndex((s) => /FROM market_worlds/i.test(s) && /FOR\s+UPDATE/i.test(s));
    const stateLock = rec.statements.findIndex((s) => /FROM director_control_state/i.test(s) && /FOR\s+UPDATE/i.test(s));
    const write = rec.statements.findIndex((s) => /INSERT INTO director_control_state/i.test(s));
    expect(worldLock).toBeGreaterThan(-1);
    expect(stateLock).toBeGreaterThan(worldLock);
    expect(write).toBeGreaterThan(stateLock);
    // The owned transaction committed: the state is visible to a fresh
    // ordinary read and round-trips exactly.
    const loaded = await control.loadDirectorControlState(db, world.worldId);
    expect(loaded.decisionIndex).toBe(3);
    expect(loaded.mode).toBe('NORMAL');
    expect(loaded.reason).toBe('broad swing due');
    expect(new Date(loaded.startedAt).getTime()).toBe(BASE_MS);
    expect(new Date(loaded.lastMeaningfulMovementAt).getTime()).toBe(BASE_MS - 5 * MINUTE);
  });

  test('two concurrent first writes through the normal pool serialise on the world row — neither silently overwrites the other', async () => {
    const world = await provisionedWorld();
    const lower = validState(world.worldId, { decisionIndex: 3, reason: 'first writer lower' });
    const higher = validState(world.worldId, {
      decisionIndex: 4, mode: 'BUST', direction: 'NEGATIVE', reason: 'first writer higher'
    });
    const [rLower, rHigher] = await Promise.allSettled([
      control.upsertDirectorControlState(db, lower),
      control.upsertDirectorControlState(db, higher)
    ]);
    // No silent overwrite is possible: either the lower-index write
    // committed first and the higher then advanced the cursor (both
    // fulfilled), or the higher committed first and the lower failed
    // LOUDLY as stale. The higher decision always wins the cursor.
    expect(rHigher.status).toBe('fulfilled');
    if (rLower.status === 'rejected') {
      expect(rLower.reason.message).toMatch(/stale/i);
    }
    const committed = await control.loadDirectorControlState(db, world.worldId);
    expect(committed.decisionIndex).toBe(4);
    expect(committed.mode).toBe('BUST');
    expect(committed.direction).toBe('NEGATIVE');
    expect(committed.reason).toBe('first writer higher');
    // Exactly one committed row — the loser never replaced the winner.
    expect((await db.query(
      'SELECT count(*)::int AS n FROM director_control_state WHERE world_id = $1',
      [world.worldId]
    )).rows[0].n).toBe(1);
  });

  test('two concurrent equal-index conflicting writes through the pool commit exactly one winner and one loud conflict', async () => {
    const world = await provisionedWorld();
    const [rA, rB] = await Promise.allSettled([
      control.upsertDirectorControlState(db, validState(world.worldId, { reason: 'contender A' })),
      control.upsertDirectorControlState(db, validState(world.worldId, {
        mode: 'RESCUE', direction: 'NEGATIVE', reason: 'contender B'
      }))
    ]);
    const fulfilled = [rA, rB].filter((r) => r.status === 'fulfilled');
    const rejected = [rA, rB].filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason.message).toMatch(/conflict/i);
    // The committed row is exactly the winner's decision at that index —
    // never the loser's conflicting payload.
    const committed = await control.loadDirectorControlState(db, world.worldId);
    expect(committed.decisionIndex).toBe(3);
    expect(committed.reason).toBe(rA.status === 'fulfilled' ? 'contender A' : 'contender B');
    expect((await db.query(
      'SELECT count(*)::int AS n FROM director_control_state WHERE world_id = $1',
      [world.worldId]
    )).rows[0].n).toBe(1);
  });

  test('an explicit transaction client participates in the caller transaction without nested BEGIN/COMMIT', async () => {
    const world = await provisionedWorld();
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      // Real client, real open transaction — the wrapper only records the
      // statements the model issues on it.
      const rec = recordingQueryable(client);
      await control.upsertDirectorControlState(rec, validState(world.worldId));
      // The caller owns the transaction: the model issued no transaction
      // control of its own.
      expect(rec.statements.some((s) => TXN_CONTROL.test(s))).toBe(false);
      // The caller's transaction is still open: the write is not yet
      // committed/visible outside it.
      expect(await control.loadDirectorControlState(db, world.worldId)).toBeNull();
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const committed = await control.loadDirectorControlState(db, world.worldId);
    expect(committed.decisionIndex).toBe(3);
    expect(committed.reason).toBe('broad swing due');
  });

  test('normal loadDirectorControlState is an ordinary validated read: no write lock issued, never blocked by a held write lock', async () => {
    const world = await provisionedWorld();
    await control.upsertDirectorControlState(db, validState(world.worldId));
    // World id is validated on the ordinary read path too.
    await expect(control.loadDirectorControlState(db, 0)).rejects.toThrow(/worldId/);
    // Precise statement assertion: the ordinary read issues exactly one
    // plain SELECT — no FOR UPDATE/SHARE lock clause.
    const rec = recordingQueryable(db);
    const loaded = await control.loadDirectorControlState(rec, world.worldId);
    expect(loaded.decisionIndex).toBe(3);
    expect(rec.statements).toHaveLength(1);
    expect(rec.statements.some((s) => /FOR\s+(UPDATE|SHARE)/i.test(s))).toBe(false);
    // Real two-client evidence: a writer holding the state row FOR UPDATE
    // must NOT block the ordinary read (a FOR UPDATE read would queue
    // behind it here and time out).
    const writer = await db.getClient();
    try {
      await writer.query('BEGIN');
      await writer.query(
        'SELECT world_id FROM director_control_state WHERE world_id = $1 FOR UPDATE',
        [world.worldId]
      );
      const read = await Promise.race([
        control.loadDirectorControlState(db, world.worldId).then((v) => ({ blocked: false, v })),
        new Promise((resolve) => setTimeout(() => resolve({ blocked: true }), 2000))
      ]);
      expect(read.blocked).toBe(false);
      expect(read.v.decisionIndex).toBe(3);
      expect(read.v.reason).toBe('broad swing due');
      await writer.query('ROLLBACK');
    } finally {
      writer.release();
    }
  });
});
