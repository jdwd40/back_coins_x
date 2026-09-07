// Director Coin Events Wave 1: the persistent-world coin-event authority
// against the REAL disposable test database — migration 029, constraint
// enforcement, model validation, idempotent/replay-safe inserts, active
// reads, bounded internal history, and the production-neutrality guarantees
// (no Apocalypse dependency, no live price change).
//
// Every mutating test passes through the repository's disposable test DB
// guard (jest.setup.js also reseeds before each test).

const fs = require('fs');
const path = require('path');
const db = require('../db/connection');
const { runMigrations } = require('../db/migrate');
const { verifyGameSchema } = require('../db/verify-game-schema');
const persistentWorld = require('../game/persistentWorld');
const eventsModel = require('../models/persistentCoinEvents.model');
const { assertDisposableTestDatabase } = require('./helpers/testDatabaseGuard');

jest.setTimeout(30000);

const MIGRATION_029 = '029_create_persistent_coin_events.sql';
const WORLD_SEED = 'wave1-persistent-events-db-seed';
const BASE_MS = new Date('2026-09-01T00:00:00Z').getTime();
const MINUTE = 60 * 1000;

async function provisionedWorld() {
  return persistentWorld.provisionWorld(db, { seed: WORLD_SEED, epochStartedAt: new Date('2026-08-31T00:00:00Z') });
}

function validEvent(worldId, overrides = {}) {
  return {
    worldId,
    coinId: 1,
    eventSeq: 1,
    name: 'Director Wave 1 Test Event',
    direction: 'POSITIVE',
    source: 'NORMAL',
    modifier: 0.03125,
    startsAt: new Date(BASE_MS).toISOString(),
    endsAt: new Date(BASE_MS + 5 * MINUTE).toISOString(),
    ...overrides
  };
}

describe('Wave 1: tracked production migration 029', () => {
  beforeEach(async () => {
    assertDisposableTestDatabase();
    await runMigrations({ log: () => {} });
  });

  test('applies 029 to an existing database, preserving all pre-existing schema and data', async () => {
    const usersBefore = await db.query('SELECT count(*)::int AS n FROM users');
    const coinsBefore = await db.query('SELECT count(*)::int AS n FROM coins');

    await db.query('DROP TABLE IF EXISTS persistent_coin_events CASCADE');
    await db.query('DROP TABLE IF EXISTS director_control_state CASCADE');
    // 030/031 add columns to director_control_state: dropping the table
    // must also un-track 030/031 so the replay rebuilds the full current
    // shape.
    await db.query('DELETE FROM schema_migrations WHERE migration = ANY($1)',
      [[MIGRATION_029, '030_director_control_refractory.sql', '031_director_control_last_intervention_mode.sql']]);
    const result = await runMigrations({ log: () => {} });
    expect(result.applied).toContain(MIGRATION_029);

    const verification = await verifyGameSchema();
    expect(verification.problems).toEqual([]);
    expect(verification.ok).toBe(true);

    expect((await db.query('SELECT count(*)::int AS n FROM users')).rows[0].n).toBe(usersBefore.rows[0].n);
    expect((await db.query('SELECT count(*)::int AS n FROM coins')).rows[0].n).toBe(coinsBefore.rows[0].n);
    const legacy = await db.query(`SELECT to_regclass('public.apocalypse_cycles') AS r`);
    expect(legacy.rows[0].r).not.toBeNull();
    // Both new tables exist and start empty.
    expect((await db.query('SELECT count(*)::int AS n FROM persistent_coin_events')).rows[0].n).toBe(0);
    expect((await db.query('SELECT count(*)::int AS n FROM director_control_state')).rows[0].n).toBe(0);
  });

  test('re-running the migration on an already-migrated database is a tracked no-op', async () => {
    const result = await runMigrations({ log: () => {} });
    expect(result.applied).not.toContain(MIGRATION_029);
    const verification = await verifyGameSchema();
    expect(verification.ok).toBe(true);
  });

  test('a fresh schema built by db/seed.js already contains both tables (DDL single-sourced)', async () => {
    // jest.setup reseeded before this test through db/seed.js; the tables
    // must exist without any migration-runner involvement.
    const reg = await db.query(
      `SELECT to_regclass('public.persistent_coin_events') AS events,
              to_regclass('public.director_control_state') AS control`
    );
    expect(reg.rows[0].events).not.toBeNull();
    expect(reg.rows[0].control).not.toBeNull();
    const verification = await verifyGameSchema();
    expect(verification.problems).toEqual([]);
  });
});

describe('Wave 1: migration 029 existing-table compatibility probes', () => {
  beforeEach(async () => {
    assertDisposableTestDatabase();
    await runMigrations({ log: () => {} });
  });

  test('a pre-existing persistent_coin_events missing the direction vocabulary CHECK is REJECTED — the modifier sign-match CHECK does not satisfy it', async () => {
    // Build an otherwise-compatible table that carries every named CHECK
    // EXCEPT persistent_coin_events_direction_known. It still carries the
    // sign-match CHECK (which names direction/POSITIVE/NEGATIVE/modifier):
    // the exact regression — a loose definition match would silently accept
    // this table and leave 'SIDEWAYS' directions writable.
    await db.query('DROP TABLE IF EXISTS persistent_coin_events CASCADE');
    await db.query(`
      CREATE TABLE public.persistent_coin_events (
        event_id   SERIAL PRIMARY KEY,
        world_id   INTEGER NOT NULL REFERENCES public.market_worlds (world_id),
        coin_id    INTEGER NOT NULL REFERENCES public.coins (coin_id),
        event_seq  INTEGER NOT NULL,
        name       VARCHAR(100) NOT NULL,
        direction  VARCHAR(8) NOT NULL,
        source     VARCHAR(8) NOT NULL,
        modifier   NUMERIC(12, 8) NOT NULL,
        starts_at  TIMESTAMPTZ NOT NULL,
        ends_at    TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (world_id, coin_id, event_seq),
        CONSTRAINT persistent_coin_events_event_seq_positive CHECK (event_seq >= 1),
        CONSTRAINT persistent_coin_events_source_known CHECK (source IN ('NORMAL', 'GOLDEN', 'DEMON', 'RESCUE', 'DIRECTOR')),
        CONSTRAINT persistent_coin_events_window_positive CHECK (ends_at > starts_at),
        CONSTRAINT persistent_coin_events_modifier_sign_matches_direction CHECK (
          (direction = 'POSITIVE' AND modifier > 0) OR (direction = 'NEGATIVE' AND modifier < 0)
        ),
        CONSTRAINT persistent_coin_events_modifier_bounded CHECK (modifier > -1 AND modifier < 1)
      )
    `);
    await db.query('DELETE FROM schema_migrations WHERE migration = $1', [MIGRATION_029]);

    await expect(runMigrations({ log: () => {} }))
      .rejects.toThrow(/persistent_coin_events table is INCOMPATIBLE[\s\S]*persistent_coin_events_direction_known/);
    // The failed migration rolled back: the probe did not "repair" or
    // replace the incompatible table, and 029 was not recorded as applied.
    expect((await db.query(
      'SELECT count(*)::int AS n FROM schema_migrations WHERE migration = $1',
      [MIGRATION_029]
    )).rows[0].n).toBe(0);

    // The schema verifier flags the same omission on the live schema.
    const verification = await verifyGameSchema();
    expect(verification.ok).toBe(false);
    expect(verification.problems.some((p) => /persistent_coin_events_direction_known/.test(p))).toBe(true);
  });

  test('a pre-existing director_control_state missing a named CHECK or a now() timestamp default is REJECTED', async () => {
    // Otherwise-compatible table: every column, the PK, the FKs, and eight
    // of the nine named CHECKs — but director_control_state_last_swing_known
    // is absent and updated_at has no now() default. The old probe verified
    // neither and would have silently accepted this table.
    await db.query('DROP TABLE IF EXISTS director_control_state CASCADE');
    await db.query(`
      CREATE TABLE public.director_control_state (
        world_id            INTEGER NOT NULL REFERENCES public.market_worlds (world_id),
        mode                VARCHAR(8) NOT NULL,
        direction           VARCHAR(8) NOT NULL,
        intensity           DOUBLE PRECISION NOT NULL,
        started_at          TIMESTAMPTZ NOT NULL,
        ends_at             TIMESTAMPTZ NOT NULL,
        decision_index      INTEGER NOT NULL,
        reason              TEXT NOT NULL,
        golden_coin_id      INTEGER REFERENCES public.coins (coin_id),
        golden_expires_at   TIMESTAMPTZ,
        demon_coin_id       INTEGER REFERENCES public.coins (coin_id),
        demon_expires_at    TIMESTAMPTZ,
        last_swing_direction VARCHAR(8),
        last_meaningful_movement_at TIMESTAMPTZ,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at          TIMESTAMPTZ NOT NULL,
        CONSTRAINT director_control_state_pkey PRIMARY KEY (world_id),
        CONSTRAINT director_control_state_mode_known CHECK (mode IN ('NORMAL', 'BOOM', 'BUST', 'RESCUE')),
        CONSTRAINT director_control_state_direction_known CHECK (direction IN ('POSITIVE', 'NEGATIVE')),
        CONSTRAINT director_control_state_intensity_bounded CHECK (intensity >= 0 AND intensity <= 1),
        CONSTRAINT director_control_state_decision_index_nonneg CHECK (decision_index >= 0),
        CONSTRAINT director_control_state_window_positive CHECK (ends_at > started_at),
        CONSTRAINT director_control_state_golden_consistent CHECK (
          (golden_coin_id IS NULL) = (golden_expires_at IS NULL)
        ),
        CONSTRAINT director_control_state_demon_consistent CHECK (
          (demon_coin_id IS NULL) = (demon_expires_at IS NULL)
        ),
        CONSTRAINT director_control_state_golden_demon_distinct CHECK (
          golden_coin_id IS NULL OR demon_coin_id IS NULL OR golden_coin_id <> demon_coin_id
        )
      )
    `);
    await db.query('DELETE FROM schema_migrations WHERE migration = $1', [MIGRATION_029]);

    await expect(runMigrations({ log: () => {} }))
      .rejects.toThrow(/director_control_state table is INCOMPATIBLE[\s\S]*director_control_state_last_swing_known/);
    await expect(runMigrations({ log: () => {} }))
      .rejects.toThrow(/updated_at is missing its now\(\) default/);
    expect((await db.query(
      'SELECT count(*)::int AS n FROM schema_migrations WHERE migration = $1',
      [MIGRATION_029]
    )).rows[0].n).toBe(0);

    const verification = await verifyGameSchema();
    expect(verification.ok).toBe(false);
    expect(verification.problems.some((p) => /director_control_state_last_swing_known/.test(p))).toBe(true);
  });
});

describe('Wave 1: persistent_coin_events database constraints', () => {
  beforeEach(async () => {
    assertDisposableTestDatabase();
  });

  test('the foreign keys to market_worlds and coins are enforced', async () => {
    const world = await provisionedWorld();
    const insert = (worldId, coinId) => db.query(
      `INSERT INTO persistent_coin_events
         (world_id, coin_id, event_seq, name, direction, source, modifier, starts_at, ends_at)
       VALUES ($1, $2, 1, 'X', 'POSITIVE', 'NORMAL', 0.01, now(), now() + interval '5 minutes')`,
      [worldId, coinId]
    );
    await expect(insert(999999, 1)).rejects.toThrow(/foreign key|violates/i);
    await expect(insert(world.worldId, 999999)).rejects.toThrow(/foreign key|violates/i);
    await expect(insert(world.worldId, 1)).resolves.toBeDefined();
  });

  test('direction, source, sign, window and modifier-bound CHECKs are enforced', async () => {
    const world = await provisionedWorld();
    const insert = (fragment) => db.query(
      `INSERT INTO persistent_coin_events
         (world_id, coin_id, event_seq, name, direction, source, modifier, starts_at, ends_at)
       VALUES ($1, 1, 1, 'X', ${fragment})`,
      [world.worldId]
    );
    await expect(insert(`'SIDEWAYS', 'NORMAL', 0.01, now(), now() + interval '5 minutes'`)).rejects.toThrow();
    await expect(insert(`'POSITIVE', 'WEIRD', 0.01, now(), now() + interval '5 minutes'`)).rejects.toThrow();
    // Sign must match direction.
    await expect(insert(`'POSITIVE', 'NORMAL', -0.01, now(), now() + interval '5 minutes'`)).rejects.toThrow();
    await expect(insert(`'NEGATIVE', 'DEMON', 0.01, now(), now() + interval '5 minutes'`)).rejects.toThrow();
    // Inverted window.
    await expect(insert(`'POSITIVE', 'NORMAL', 0.01, now(), now() - interval '5 minutes'`)).rejects.toThrow();
    // Structural modifier bound (the model layer enforces the tighter
    // configured bound; the database rejects the structurally impossible).
    await expect(insert(`'POSITIVE', 'NORMAL', 1.5, now(), now() + interval '5 minutes'`)).rejects.toThrow();
    // The whole five-value source vocabulary is accepted.
    for (const [i, source] of ['NORMAL', 'GOLDEN', 'DEMON', 'RESCUE', 'DIRECTOR'].entries()) {
      await db.query(
        `INSERT INTO persistent_coin_events
           (world_id, coin_id, event_seq, name, direction, source, modifier, starts_at, ends_at)
         VALUES ($1, 1, $2, 'X', 'POSITIVE', $3, 0.01, now(), now() + interval '5 minutes')`,
        [world.worldId, 10 + i, source]
      );
    }
  });

  test('UNIQUE (world_id, coin_id, event_seq) is the replay/idempotency backstop', async () => {
    const world = await provisionedWorld();
    await db.query(
      `INSERT INTO persistent_coin_events
         (world_id, coin_id, event_seq, name, direction, source, modifier, starts_at, ends_at)
       VALUES ($1, 1, 1, 'X', 'POSITIVE', 'NORMAL', 0.01, now(), now() + interval '5 minutes')`,
      [world.worldId]
    );
    await expect(db.query(
      `INSERT INTO persistent_coin_events
         (world_id, coin_id, event_seq, name, direction, source, modifier, starts_at, ends_at)
       VALUES ($1, 1, 1, 'Y', 'POSITIVE', 'NORMAL', 0.02, now(), now() + interval '5 minutes')`,
      [world.worldId]
    )).rejects.toThrow(/duplicate key/);
    // The same event_seq on ANOTHER coin or world is a distinct identity.
    await db.query(
      `INSERT INTO persistent_coin_events
         (world_id, coin_id, event_seq, name, direction, source, modifier, starts_at, ends_at)
       VALUES ($1, 2, 1, 'Y', 'POSITIVE', 'NORMAL', 0.02, now(), now() + interval '5 minutes')`,
      [world.worldId]
    );
  });

  test('the bounded active lookup indexes exist', async () => {
    await provisionedWorld();
    const { rows } = await db.query(
      `SELECT c.relname FROM pg_class c
       JOIN pg_index i ON i.indexrelid = c.oid
       WHERE i.indrelid = 'public.persistent_coin_events'::regclass
         AND c.relname IN ('idx_persistent_coin_events_active', 'idx_persistent_coin_events_world_active')`
    );
    expect(rows.map((r) => r.relname).sort()).toEqual([
      'idx_persistent_coin_events_active', 'idx_persistent_coin_events_world_active'
    ]);
  });
});

describe('Wave 1: persistent coin-event model', () => {
  beforeEach(() => {
    assertDisposableTestDatabase();
  });

  test('a validated event inserts and round-trips with its exact signed modifier', async () => {
    const world = await provisionedWorld();
    const event = validEvent(world.worldId);
    const result = await eventsModel.insertPersistentCoinEvent(db, event);
    expect(result.inserted).toBe(true);
    expect(result.event.eventId).toBeGreaterThan(0);
    expect(result.event.worldId).toBe(world.worldId);
    expect(result.event.coinId).toBe(1);
    expect(result.event.eventSeq).toBe(1);
    expect(result.event.direction).toBe('POSITIVE');
    expect(result.event.source).toBe('NORMAL');
    expect(result.event.modifier).toBe(0.03125); // NUMERIC string parsed
    expect(new Date(result.event.startsAt).getTime()).toBe(BASE_MS);
    expect(new Date(result.event.endsAt).getTime()).toBe(BASE_MS + 5 * MINUTE);
  });

  test('rejects structurally invalid events before SQL (direction/modifier/duration validation)', async () => {
    const world = await provisionedWorld();
    const base = validEvent(world.worldId);
    await expect(eventsModel.insertPersistentCoinEvent(db, { ...base, worldId: -1 })).rejects.toThrow(/worldId/);
    await expect(eventsModel.insertPersistentCoinEvent(db, { ...base, coinId: 0 })).rejects.toThrow(/coinId/);
    await expect(eventsModel.insertPersistentCoinEvent(db, { ...base, eventSeq: 0 })).rejects.toThrow(/eventSeq/);
    await expect(eventsModel.insertPersistentCoinEvent(db, { ...base, name: '' })).rejects.toThrow(/name/);
    await expect(eventsModel.insertPersistentCoinEvent(db, { ...base, direction: 'SIDEWAYS' })).rejects.toThrow(/direction/);
    await expect(eventsModel.insertPersistentCoinEvent(db, { ...base, source: 'WEIRD' })).rejects.toThrow(/source/);
    // Sign must match direction.
    await expect(eventsModel.insertPersistentCoinEvent(db, { ...base, modifier: -0.01 })).rejects.toThrow(/modifier/);
    await expect(eventsModel.insertPersistentCoinEvent(db, { ...base, direction: 'NEGATIVE', modifier: 0.01 })).rejects.toThrow(/modifier/);
    // The configured individual bound (0.05) rejects before SQL.
    await expect(eventsModel.insertPersistentCoinEvent(db, { ...base, modifier: 0.06 })).rejects.toThrow(/modifier/);
    // Duration outside the configured 1-15 minute band rejects before SQL.
    await expect(eventsModel.insertPersistentCoinEvent(db, {
      ...base, endsAt: new Date(BASE_MS + 30 * 1000).toISOString()
    })).rejects.toThrow(/duration/);
    await expect(eventsModel.insertPersistentCoinEvent(db, {
      ...base, endsAt: new Date(BASE_MS + 20 * MINUTE).toISOString()
    })).rejects.toThrow(/duration/);
    // Inverted/invalid windows.
    await expect(eventsModel.insertPersistentCoinEvent(db, {
      ...base, startsAt: new Date(BASE_MS + 10 * MINUTE).toISOString()
    })).rejects.toThrow(/endsAt|startsAt|window/i);
    await expect(eventsModel.insertPersistentCoinEvent(db, { ...base, startsAt: 'not-a-date' })).rejects.toThrow(/startsAt/);
    // None of the rejected writes reached the table.
    expect((await db.query('SELECT count(*)::int AS n FROM persistent_coin_events')).rows[0].n).toBe(0);
  });

  test('rejects an over-precision modifier before SQL — no silent NUMERIC(12,8) rounding, table unchanged', async () => {
    const world = await provisionedWorld();
    const base = validEvent(world.worldId);
    // 9 fractional decimal places: PostgreSQL would silently round
    // 0.010000001 to 0.01000000, so the committed row would differ from the
    // submitted event and an identical replay would be misreported as an
    // identity conflict. The model must reject it before any SQL.
    await expect(eventsModel.insertPersistentCoinEvent(db, { ...base, modifier: 0.010000001 }))
      .rejects.toThrow(/modifier.*8-decimal precision/);
    // Same for a NEGATIVE event (the magnitude is what is checked).
    await expect(eventsModel.insertPersistentCoinEvent(db, {
      ...base, direction: 'NEGATIVE', modifier: -0.010000001
    })).rejects.toThrow(/modifier.*8-decimal precision/);
    // A tiny nonzero magnitude would silently round to zero and fail only
    // in SQL; it is rejected at validation instead.
    await expect(eventsModel.insertPersistentCoinEvent(db, { ...base, modifier: 0.000000001 }))
      .rejects.toThrow(/modifier.*8-decimal precision/);
    // Nothing reached the table — every rejection happened before SQL.
    expect((await db.query('SELECT count(*)::int AS n FROM persistent_coin_events')).rows[0].n).toBe(0);
    // Exactly representable 8-decimal values still insert, round-trip and
    // replay as an exact no-op.
    const ok = await eventsModel.insertPersistentCoinEvent(db, { ...base, modifier: 0.01000001 });
    expect(ok.inserted).toBe(true);
    expect(ok.event.modifier).toBe(0.01000001);
    const replay = await eventsModel.insertPersistentCoinEvent(db, { ...base, modifier: 0.01000001 });
    expect(replay.inserted).toBe(false);
    expect((await db.query('SELECT count(*)::int AS n FROM persistent_coin_events')).rows[0].n).toBe(1);
  });

  test('duplicate/replay inserts are idempotent; identity reuse with a different payload fails loudly', async () => {
    const world = await provisionedWorld();
    const event = validEvent(world.worldId);
    const first = await eventsModel.insertPersistentCoinEvent(db, event);
    expect(first.inserted).toBe(true);
    // Replay: the identical event at the identical identity is a no-op.
    const replay = await eventsModel.insertPersistentCoinEvent(db, event);
    expect(replay.inserted).toBe(false);
    expect(replay.event.eventId).toBe(first.event.eventId);
    expect((await db.query('SELECT count(*)::int AS n FROM persistent_coin_events')).rows[0].n).toBe(1);
    // Identity reuse with a DIFFERENT payload is a loud failure, never a
    // silent overwrite.
    await expect(eventsModel.insertPersistentCoinEvent(db, { ...event, modifier: 0.015625 }))
      .rejects.toThrow(/identity|conflict|mismatch/i);
    expect((await db.query('SELECT count(*)::int AS n FROM persistent_coin_events')).rows[0].n).toBe(1);
  });

  test('active reads include live events, exclude expired history and preserve exact signed values', async () => {
    const world = await provisionedWorld();
    await eventsModel.insertPersistentCoinEvent(db, validEvent(world.worldId, {
      eventSeq: 1, modifier: 0.03125, direction: 'POSITIVE'
    }));
    await eventsModel.insertPersistentCoinEvent(db, validEvent(world.worldId, {
      eventSeq: 2, modifier: -0.015625, direction: 'NEGATIVE', source: 'DEMON'
    }));
    // Expired history: preserved, never deleted, excluded from active reads.
    await eventsModel.insertPersistentCoinEvent(db, validEvent(world.worldId, {
      eventSeq: 3, modifier: 0.0078125,
      startsAt: new Date(BASE_MS - 30 * MINUTE).toISOString(),
      endsAt: new Date(BASE_MS - 20 * MINUTE).toISOString()
    }));
    // A future event is not yet active.
    await eventsModel.insertPersistentCoinEvent(db, validEvent(world.worldId, {
      eventSeq: 4, modifier: 0.0078125,
      startsAt: new Date(BASE_MS + 10 * MINUTE).toISOString(),
      endsAt: new Date(BASE_MS + 12 * MINUTE).toISOString()
    }));
    // Another coin's event does not leak into coin 1's reads.
    await eventsModel.insertPersistentCoinEvent(db, validEvent(world.worldId, {
      coinId: 2, eventSeq: 1, modifier: 0.02
    }));

    const active = await eventsModel.listActivePersistentCoinEvents(db, world.worldId, new Date(BASE_MS + MINUTE));
    expect(active).toHaveLength(3);
    expect(active.map((e) => e.eventSeq)).toEqual([1, 2, 1]); // coin 1 seqs, then coin 2
    expect(active[0].modifier).toBe(0.03125);
    expect(active[1].modifier).toBe(-0.015625);

    const coinOne = await eventsModel.listActivePersistentCoinEvents(db, world.worldId, new Date(BASE_MS + MINUTE), { coinId: 1 });
    expect(coinOne).toHaveLength(2);

    // All four coin-1 rows are preserved history.
    expect((await db.query(
      'SELECT count(*)::int AS n FROM persistent_coin_events WHERE world_id = $1 AND coin_id = 1',
      [world.worldId]
    )).rows[0].n).toBe(4);
  });

  test('active reads follow the pure-domain canonical order (starts_at, coin_id, event_seq)', async () => {
    const world = await provisionedWorld();
    // Deliberately cross the two orderings: coin 2's event starts EARLIER
    // than coin 1's. The pure domain canonical order (starts_at first)
    // lists coin 2 first; the old model order (coin_id first) listed coin 1
    // first.
    await eventsModel.insertPersistentCoinEvent(db, validEvent(world.worldId, {
      coinId: 1, eventSeq: 1,
      startsAt: new Date(BASE_MS + MINUTE).toISOString(),
      endsAt: new Date(BASE_MS + 6 * MINUTE).toISOString()
    }));
    await eventsModel.insertPersistentCoinEvent(db, validEvent(world.worldId, {
      coinId: 2, eventSeq: 1,
      startsAt: new Date(BASE_MS).toISOString(),
      endsAt: new Date(BASE_MS + 5 * MINUTE).toISOString()
    }));
    const active = await eventsModel.listActivePersistentCoinEvents(db, world.worldId, new Date(BASE_MS + 2 * MINUTE));
    expect(active.map((e) => [e.coinId, e.eventSeq])).toEqual([[2, 1], [1, 1]]);
  });

  test('internal history is bounded and newest-first', async () => {
    const world = await provisionedWorld();
    for (let seq = 1; seq <= 3; seq += 1) {
      await eventsModel.insertPersistentCoinEvent(db, validEvent(world.worldId, {
        eventSeq: seq,
        startsAt: new Date(BASE_MS + (seq - 1) * 20 * MINUTE).toISOString(),
        endsAt: new Date(BASE_MS + (seq - 1) * 20 * MINUTE + 5 * MINUTE).toISOString()
      }));
    }
    const history = await eventsModel.getPersistentCoinEventHistory(db, world.worldId, 1, { limit: 2 });
    expect(history).toHaveLength(2);
    expect(history.map((e) => e.eventSeq)).toEqual([3, 2]);
    await expect(eventsModel.getPersistentCoinEventHistory(db, world.worldId, 1, { limit: 0 })).rejects.toThrow(/limit/);
    await expect(eventsModel.getPersistentCoinEventHistory(db, world.worldId, 1, { limit: 501 })).rejects.toThrow(/limit/);
    await expect(eventsModel.getPersistentCoinEventHistory(db, world.worldId, 1.5)).rejects.toThrow(/coinId/);
  });
});

describe('Wave 1: per-coin active capacity enforcement', () => {
  beforeEach(() => {
    assertDisposableTestDatabase();
  });

  const CAP = 5; // persistentEvents.maxActivePerCoin
  const POS_CAP = 4; // persistentEvents.maxActivePositivePerCoin

  // Five simultaneously overlapping events within BOTH per-direction caps:
  // 3 POSITIVE + 2 NEGATIVE over the same window.
  async function fillToTotalCap(worldId) {
    const directions = ['POSITIVE', 'POSITIVE', 'POSITIVE', 'NEGATIVE', 'NEGATIVE'];
    for (const [i, direction] of directions.entries()) {
      await eventsModel.insertPersistentCoinEvent(db, validEvent(worldId, {
        eventSeq: i + 1,
        direction,
        modifier: direction === 'POSITIVE' ? 0.03125 : -0.015625
      }));
    }
  }

  test('the sixth overlapping event is rejected and nothing is written', async () => {
    const world = await provisionedWorld();
    await fillToTotalCap(world.worldId);
    await expect(eventsModel.insertPersistentCoinEvent(db, validEvent(world.worldId, {
      eventSeq: 6, direction: 'NEGATIVE', modifier: -0.015625
    }))).rejects.toThrow(/capacity/i);
    await expect(eventsModel.insertPersistentCoinEvent(db, validEvent(world.worldId, {
      eventSeq: 7, direction: 'POSITIVE', modifier: 0.03125
    }))).rejects.toThrow(/capacity/i);
    expect((await db.query(
      'SELECT count(*)::int AS n FROM persistent_coin_events WHERE world_id = $1',
      [world.worldId]
    )).rows[0].n).toBe(CAP);
  });

  test('non-overlapping and half-open-adjacent history remains insertable at cap', async () => {
    const world = await provisionedWorld();
    await fillToTotalCap(world.worldId);
    // Disjoint later window: allowed — expired/future events do not count.
    const later = await eventsModel.insertPersistentCoinEvent(db, validEvent(world.worldId, {
      eventSeq: 6,
      startsAt: new Date(BASE_MS + 10 * MINUTE).toISOString(),
      endsAt: new Date(BASE_MS + 15 * MINUTE).toISOString()
    }));
    expect(later.inserted).toBe(true);
    // Half-open adjacency: starts exactly when the capped set ends
    // (starts_at <= now < ends_at — no overlap).
    const adjacent = await eventsModel.insertPersistentCoinEvent(db, validEvent(world.worldId, {
      eventSeq: 7,
      startsAt: new Date(BASE_MS + 5 * MINUTE).toISOString(),
      endsAt: new Date(BASE_MS + 10 * MINUTE).toISOString()
    }));
    expect(adjacent.inserted).toBe(true);
    expect((await db.query(
      'SELECT count(*)::int AS n FROM persistent_coin_events WHERE world_id = $1',
      [world.worldId]
    )).rows[0].n).toBe(CAP + 2);
  });

  test('the per-direction caps bind below the total cap', async () => {
    const world = await provisionedWorld();
    for (let seq = 1; seq <= POS_CAP; seq += 1) {
      await eventsModel.insertPersistentCoinEvent(db, validEvent(world.worldId, { eventSeq: seq }));
    }
    // A fifth POSITIVE event peaks at 5 positive > 4 even though the total
    // cap (5) would allow it.
    await expect(eventsModel.insertPersistentCoinEvent(db, validEvent(world.worldId, { eventSeq: POS_CAP + 1 })))
      .rejects.toThrow(/capacity/i);
    // A NEGATIVE event in the same window is within both caps.
    const negative = await eventsModel.insertPersistentCoinEvent(db, validEvent(world.worldId, {
      eventSeq: POS_CAP + 2, direction: 'NEGATIVE', modifier: -0.015625
    }));
    expect(negative.inserted).toBe(true);
    expect((await db.query(
      'SELECT count(*)::int AS n FROM persistent_coin_events WHERE world_id = $1',
      [world.worldId]
    )).rows[0].n).toBe(POS_CAP + 1);
  });

  test('identical replay at cap remains a no-op; conflicting identity still fails loudly', async () => {
    const world = await provisionedWorld();
    await fillToTotalCap(world.worldId);
    const replay = await eventsModel.insertPersistentCoinEvent(db, validEvent(world.worldId, { eventSeq: 1 }));
    expect(replay.inserted).toBe(false);
    await expect(eventsModel.insertPersistentCoinEvent(db, validEvent(world.worldId, {
      eventSeq: 1, modifier: 0.015625
    }))).rejects.toThrow(/identity|conflict/i);
    expect((await db.query(
      'SELECT count(*)::int AS n FROM persistent_coin_events WHERE world_id = $1',
      [world.worldId]
    )).rows[0].n).toBe(CAP);
  });

  test('concurrent inserts for the same coin serialise on the coin row lock — both cannot pass the cap check', async () => {
    const world = await provisionedWorld();
    // Four committed overlapping events: exactly one slot remains.
    for (let seq = 1; seq <= CAP - 1; seq += 1) {
      await eventsModel.insertPersistentCoinEvent(db, validEvent(world.worldId, {
        eventSeq: seq,
        direction: seq === 1 ? 'POSITIVE' : 'NEGATIVE',
        modifier: seq === 1 ? 0.03125 : -0.015625
      }));
    }
    const clientA = await db.getClient();
    const clientB = await db.getClient();
    try {
      await clientA.query('BEGIN');
      // Transaction A claims the last slot and holds the coin row lock.
      const a = await eventsModel.insertPersistentCoinEvent(clientA, validEvent(world.worldId, {
        eventSeq: CAP, direction: 'NEGATIVE', modifier: -0.015625
      }));
      expect(a.inserted).toBe(true);

      await clientB.query('BEGIN');
      // Transaction B blocks on the coin row lock until A commits, then its
      // capacity check observes A's committed row and must reject.
      const bPromise = eventsModel.insertPersistentCoinEvent(clientB, validEvent(world.worldId, {
        eventSeq: CAP + 1, direction: 'NEGATIVE', modifier: -0.015625
      }));
      bPromise.catch(() => {}); // assert below via resolution value
      await new Promise((resolve) => setTimeout(resolve, 500));
      await clientA.query('COMMIT');
      const bResult = await bPromise.then(
        () => ({ rejected: false }),
        (error) => ({ rejected: true, error })
      );
      expect(bResult.rejected).toBe(true);
      expect(String(bResult.error && bResult.error.message)).toMatch(/capacity/i);
      await clientB.query('ROLLBACK').catch(() => {});
    } finally {
      clientA.release();
      clientB.release();
    }
    expect((await db.query(
      'SELECT count(*)::int AS n FROM persistent_coin_events WHERE world_id = $1',
      [world.worldId]
    )).rows[0].n).toBe(CAP);
  });
});

describe('Wave 1: schema verifier per-direction overlap invariant', () => {
  beforeEach(() => {
    assertDisposableTestDatabase();
  });

  test('the verifier flags a per-direction overlap breach the total cap alone would miss', async () => {
    const world = await provisionedWorld();
    // Raw SQL inserts bypass the model's capacity gate: FIVE simultaneously
    // overlapping POSITIVE events. The total cap (5) is exactly met, not
    // exceeded — but the positive-direction cap (4) is breached.
    for (let seq = 1; seq <= 5; seq += 1) {
      await db.query(
        `INSERT INTO persistent_coin_events
           (world_id, coin_id, event_seq, name, direction, source, modifier, starts_at, ends_at)
         VALUES ($1, 1, $2, 'X', 'POSITIVE', 'NORMAL', 0.01, now(), now() + interval '5 minutes')`,
        [world.worldId, seq]
      );
    }
    const verification = await verifyGameSchema();
    expect(verification.ok).toBe(false);
    expect(verification.problems.some((p) => /overlap beyond the configured active caps/.test(p))).toBe(true);
  });

  test('the verifier accepts a world at the total cap when both directions stay within their caps', async () => {
    const world = await provisionedWorld();
    // 3 POSITIVE + 2 NEGATIVE overlapping: total 5 (at cap), each direction
    // within its cap of 4 — no violation.
    const directions = ['POSITIVE', 'POSITIVE', 'POSITIVE', 'NEGATIVE', 'NEGATIVE'];
    for (const [i, direction] of directions.entries()) {
      await db.query(
        `INSERT INTO persistent_coin_events
           (world_id, coin_id, event_seq, name, direction, source, modifier, starts_at, ends_at)
         VALUES ($1, 1, $2, 'X', $3, 'NORMAL', $4, now(), now() + interval '5 minutes')`,
        [world.worldId, i + 1, direction, direction === 'POSITIVE' ? 0.01 : -0.01]
      );
    }
    const verification = await verifyGameSchema();
    expect(verification.problems).toEqual([]);
    expect(verification.ok).toBe(true);
  });
});

describe('Wave 1: production-neutrality guarantees', () => {
  beforeEach(() => {
    assertDisposableTestDatabase();
  });

  test('the persistent event/domain/model modules never reference Apocalypse tables', () => {
    for (const file of [
      '../game/persistentCoinEventDomain.js',
      '../models/persistentCoinEvents.model.js',
      '../models/directorControlState.model.js'
    ]) {
      const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
      // Strip comments: the modules may DOCUMENT the no-Apocalypse rule in
      // prose, but no executable code may touch an apocalypse_* object.
      const executable = source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
      expect(executable).not.toMatch(/apocalypse_/i);
    }
  });

  test('the persistent event authority works with no Apocalypse cycle present at all', async () => {
    // Fresh seed: no apocalypse cycle exists.
    expect((await db.query('SELECT count(*)::int AS n FROM apocalypse_cycles')).rows[0].n).toBe(0);
    const world = await provisionedWorld();
    await eventsModel.insertPersistentCoinEvent(db, validEvent(world.worldId));
    const active = await eventsModel.listActivePersistentCoinEvents(db, world.worldId, new Date(BASE_MS + MINUTE));
    expect(active).toHaveLength(1);
  });

  test('exercising the Wave 1 foundations changes no live coin price', async () => {
    const before = await db.query('SELECT coin_id, current_price FROM coins ORDER BY coin_id');
    const world = await provisionedWorld();
    await eventsModel.insertPersistentCoinEvent(db, validEvent(world.worldId));
    await eventsModel.listActivePersistentCoinEvents(db, world.worldId, new Date(BASE_MS + MINUTE));
    await eventsModel.getPersistentCoinEventHistory(db, world.worldId, 1);
    const control = require('../models/directorControlState.model');
    await control.upsertDirectorControlState(db, {
      worldId: world.worldId,
      mode: 'NORMAL',
      direction: 'POSITIVE',
      intensity: 0.5,
      startedAt: new Date(BASE_MS).toISOString(),
      endsAt: new Date(BASE_MS + 10 * MINUTE).toISOString(),
      decisionIndex: 0,
      reason: 'wave 1 smoke',
      goldenCoinId: null,
      goldenExpiresAt: null,
      demonCoinId: null,
      demonExpiresAt: null,
      lastSwingDirection: null,
      lastMeaningfulMovementAt: null
    });
    await control.loadDirectorControlState(db, world.worldId);
    const after = await db.query('SELECT coin_id, current_price FROM coins ORDER BY coin_id');
    expect(after.rows).toEqual(before.rows);
  });
});
