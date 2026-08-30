// Migration runner + schema verification coverage for Crypto Chaos gameplay
// overhaul Wave 1 (SIM-03/04/05): the cycle-scoped coin-event schedule
// (apocalypse_coin_events) and the primary market-phase chain
// (apocalypse_market_phases).
//
// Runs the REAL migration runner (db/migrate.js) and the REAL verification
// (db/verify-game-schema.js) against the disposable test database. The guard
// refuses any non-test target. db/seed.js is never used as a migration or
// verification mechanism here; it only provides the pre-existing Coins
// schema and data (via jest.setup.js beforeEach) that migration 020 must
// preserve.

const db = require('../db/connection');
const { runMigrations } = require('../db/migrate');
const { verifyGameSchema } = require('../db/verify-game-schema');
const { assertDisposableTestDatabase } = require('./helpers/testDatabaseGuard');

const MIGRATION_020 = '020_create_coin_events_and_market_phases.sql';

async function drop020() {
  await db.query('DROP TABLE IF EXISTS apocalypse_coin_events CASCADE');
  await db.query('DROP TABLE IF EXISTS apocalypse_market_phases CASCADE');
  await db.query('DELETE FROM schema_migrations WHERE migration = $1', [MIGRATION_020]);
}

describe('Wave 1: tracked production migration 020', () => {
  beforeEach(async () => {
    assertDisposableTestDatabase();
    await runMigrations({ log: () => {} }); // tracked, fully migrated baseline
  });

  test('applies 020 to an existing database, preserving all pre-existing schema and data', async () => {
    // "Existing production data": a live cycle with a participant.
    await db.query(
      `INSERT INTO apocalypse_cycles (apocalypse_id, seed, start_time, end_time, duration_ms, status)
       VALUES ('APOC-0001', 'mig020-seed', '2026-08-20T10:00:00Z', '2026-08-20T10:30:00Z', 1800000, 'ACTIVE')`
    );
    await db.query(
      `INSERT INTO apocalypse_participants (cycle_id, user_id, starting_cash, current_cash, peak_wealth, status)
       VALUES (1, 1, 10000.00, 10000.00, 10000.00, 'ACTIVE')`
    );
    const usersBefore = await db.query('SELECT count(*)::int AS n FROM users');
    const coinsBefore = await db.query('SELECT count(*)::int AS n FROM coins');

    await drop020(); // simulate the pre-Wave-1 schema on top of existing data
    const result = await runMigrations({ log: () => {} });
    expect(result.applied).toContain(MIGRATION_020);

    const verification = await verifyGameSchema();
    expect(verification.problems).toEqual([]);
    expect(verification.ok).toBe(true);

    // Pre-existing data fully preserved; the new tables start empty.
    expect((await db.query('SELECT count(*)::int AS n FROM users')).rows[0].n).toBe(usersBefore.rows[0].n);
    expect((await db.query('SELECT count(*)::int AS n FROM coins')).rows[0].n).toBe(coinsBefore.rows[0].n);
    expect((await db.query('SELECT count(*)::int AS n FROM apocalypse_participants')).rows[0].n).toBe(1);
    for (const t of ['apocalypse_coin_events', 'apocalypse_market_phases']) {
      const { rows } = await db.query(`SELECT count(*)::int AS n FROM ${t}`);
      expect(rows[0].n).toBe(0);
    }
  });

  test('is idempotent: re-running leaves schema and data untouched', async () => {
    await runMigrations({ log: () => {} });
    const rerun = await runMigrations({ log: () => {} });
    expect(rerun.applied).toEqual([]);
    const { problems } = await verifyGameSchema();
    expect(problems).toEqual([]);
  });

  test('SQL-level rerun on compatible existing tables is a verified no-op', async () => {
    // Lose only the tracking row: the runner must re-execute 020 against the
    // existing compatible tables, detect compatibility, and record it again.
    await db.query('DELETE FROM schema_migrations WHERE migration = $1', [MIGRATION_020]);
    const rerun = await runMigrations({ log: () => {} });
    expect(rerun.applied).toContain(MIGRATION_020);
    const verification = await verifyGameSchema();
    expect(verification.ok).toBe(true);
  });

  test('fails clearly on an incompatible same-named idx_apocalypse_coin_events_active index', async () => {
    // Same name, wrong shape: first column matches but the full ordered key
    // list does not. The old first-column-only check would have accepted
    // this index; the exact catalog check must reject it.
    await db.query('DROP INDEX idx_apocalypse_coin_events_active');
    await db.query('CREATE INDEX idx_apocalypse_coin_events_active ON apocalypse_coin_events (cycle_id, created_at)');
    await db.query('DELETE FROM schema_migrations WHERE migration = $1', [MIGRATION_020]);

    await expect(runMigrations({ log: () => {} })).rejects.toThrow(/idx_apocalypse_coin_events_active is INCOMPATIBLE/);

    // Rolled back: not recorded.
    const tracked = await db.query('SELECT migration FROM schema_migrations WHERE migration = $1', [MIGRATION_020]);
    expect(tracked.rows).toHaveLength(0);

    // Restore the correct schema for subsequent tests.
    await db.query('DROP INDEX idx_apocalypse_coin_events_active');
    await runMigrations({ log: () => {} });
  });

  test('fails clearly on a unique or reordered same-named idx_apocalypse_coin_events_active index', async () => {
    // Correct columns but UNIQUE: still incompatible (shape mismatch).
    await db.query('DROP INDEX idx_apocalypse_coin_events_active');
    await db.query('CREATE UNIQUE INDEX idx_apocalypse_coin_events_active ON apocalypse_coin_events (cycle_id, coin_id, ends_at)');
    await db.query('DELETE FROM schema_migrations WHERE migration = $1', [MIGRATION_020]);

    await expect(runMigrations({ log: () => {} })).rejects.toThrow(/idx_apocalypse_coin_events_active is INCOMPATIBLE/);

    await db.query('DROP INDEX idx_apocalypse_coin_events_active');
    // Reordered key list: also incompatible.
    await db.query('CREATE INDEX idx_apocalypse_coin_events_active ON apocalypse_coin_events (coin_id, cycle_id, ends_at)');
    await expect(runMigrations({ log: () => {} })).rejects.toThrow(/idx_apocalypse_coin_events_active is INCOMPATIBLE/);

    const tracked = await db.query('SELECT migration FROM schema_migrations WHERE migration = $1', [MIGRATION_020]);
    expect(tracked.rows).toHaveLength(0);

    await db.query('DROP INDEX idx_apocalypse_coin_events_active');
    await runMigrations({ log: () => {} });
  });

  test('fails clearly on an incompatible same-named idx_apocalypse_market_phases_active index', async () => {
    await db.query('DROP INDEX idx_apocalypse_market_phases_active');
    await db.query('CREATE INDEX idx_apocalypse_market_phases_active ON apocalypse_market_phases (cycle_id, ends_at)');
    await db.query('DELETE FROM schema_migrations WHERE migration = $1', [MIGRATION_020]);

    await expect(runMigrations({ log: () => {} })).rejects.toThrow(/idx_apocalypse_market_phases_active is INCOMPATIBLE/);

    const tracked = await db.query('SELECT migration FROM schema_migrations WHERE migration = $1', [MIGRATION_020]);
    expect(tracked.rows).toHaveLength(0);

    await db.query('DROP INDEX idx_apocalypse_market_phases_active');
    await runMigrations({ log: () => {} });
  });

  test('accepts correct same-named lookup indexes as compatible and idempotent on rerun', async () => {
    // Lose only the tracking row: the runner re-executes 020, verifies the
    // existing exactly-correct indexes, and keeps them.
    await db.query('DELETE FROM schema_migrations WHERE migration = $1', [MIGRATION_020]);
    const rerun = await runMigrations({ log: () => {} });
    expect(rerun.applied).toContain(MIGRATION_020);

    const verification = await verifyGameSchema();
    expect(verification.ok).toBe(true);

    const { rows } = await db.query(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexname IN ('idx_apocalypse_coin_events_active', 'idx_apocalypse_market_phases_active')
       ORDER BY indexname`
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].indexname).toBe('idx_apocalypse_coin_events_active');
    expect(rows[0].indexdef).toContain('USING btree (cycle_id, coin_id, ends_at)');
    expect(rows[0].indexdef).not.toContain('UNIQUE');
    expect(rows[1].indexname).toBe('idx_apocalypse_market_phases_active');
    expect(rows[1].indexdef).toContain('USING btree (cycle_id, starts_at)');
    expect(rows[1].indexdef).not.toContain('UNIQUE');

    // Fully tracked again: a further rerun is a pure no-op.
    const again = await runMigrations({ log: () => {} });
    expect(again.applied).toEqual([]);
  });

  test('fails clearly on an incompatible pre-existing apocalypse_coin_events table', async () => {
    await drop020();
    await db.query('CREATE TABLE apocalypse_coin_events (event_id integer)');
    await expect(runMigrations({ log: () => {} })).rejects.toThrow(/INCOMPATIBLE/);

    // The failed migration was rolled back: not recorded.
    const tracked = await db.query('SELECT migration FROM schema_migrations WHERE migration = $1', [MIGRATION_020]);
    expect(tracked.rows).toHaveLength(0);

    const verification = await verifyGameSchema();
    expect(verification.ok).toBe(false);
  });

  test('fails clearly on an incompatible pre-existing apocalypse_market_phases table', async () => {
    await drop020();
    await db.query('CREATE TABLE apocalypse_market_phases (phase_id integer)');
    await expect(runMigrations({ log: () => {} })).rejects.toThrow(/INCOMPATIBLE/);
    const tracked = await db.query('SELECT migration FROM schema_migrations WHERE migration = $1', [MIGRATION_020]);
    expect(tracked.rows).toHaveLength(0);
  });

  test('verification fails clearly when the Wave 1 tables are absent', async () => {
    await drop020();
    const verification = await verifyGameSchema();
    expect(verification.ok).toBe(false);
    expect(verification.problems).toContain('table public.apocalypse_coin_events does not exist');
    expect(verification.problems).toContain('table public.apocalypse_market_phases does not exist');
  });

  test('the database enforces the coin-event invariants: identity, signs, windows, categories, FKs', async () => {
    await db.query(
      `INSERT INTO apocalypse_cycles (apocalypse_id, seed, start_time, end_time, duration_ms, status)
       VALUES ('APOC-0001', 'mig020-seed', '2026-08-20T10:00:00Z', '2026-08-20T10:30:00Z', 1800000, 'ACTIVE')`
    );
    const valid = `
      INSERT INTO apocalypse_coin_events
        (cycle_id, coin_id, event_seq, name, direction, strength_category, modifier, starts_at, ends_at)
      VALUES (1, 1, 1, 'Whale Accumulation', 'POSITIVE', 'MAJOR', 0.02, '2026-08-20T10:01:00Z', '2026-08-20T10:06:00Z')`;
    await db.query(valid);

    // The idempotency backstop: one row per (cycle_id, coin_id, event_seq).
    await expect(db.query(valid)).rejects.toThrow(/duplicate key/);

    // The modifier sign must match the direction.
    await expect(db.query(
      `INSERT INTO apocalypse_coin_events
         (cycle_id, coin_id, event_seq, name, direction, strength_category, modifier, starts_at, ends_at)
       VALUES (1, 1, 2, 'Bad Sign', 'POSITIVE', 'MINOR', -0.01, '2026-08-20T10:01:00Z', '2026-08-20T10:06:00Z')`
    )).rejects.toThrow(/violates check/);

    // Direction and category vocabularies are closed.
    await expect(db.query(
      `INSERT INTO apocalypse_coin_events
         (cycle_id, coin_id, event_seq, name, direction, strength_category, modifier, starts_at, ends_at)
       VALUES (1, 1, 3, 'Bad Direction', 'UP', 'MINOR', 0.01, '2026-08-20T10:01:00Z', '2026-08-20T10:06:00Z')`
    )).rejects.toThrow(/violates check/);
    await expect(db.query(
      `INSERT INTO apocalypse_coin_events
         (cycle_id, coin_id, event_seq, name, direction, strength_category, modifier, starts_at, ends_at)
       VALUES (1, 1, 4, 'Bad Category', 'NEGATIVE', 'COLOSSAL', -0.01, '2026-08-20T10:01:00Z', '2026-08-20T10:06:00Z')`
    )).rejects.toThrow(/violates check/);

    // Windows must be positive; sequence numbers start at 1.
    await expect(db.query(
      `INSERT INTO apocalypse_coin_events
         (cycle_id, coin_id, event_seq, name, direction, strength_category, modifier, starts_at, ends_at)
       VALUES (1, 1, 5, 'Bad Window', 'POSITIVE', 'MINOR', 0.01, '2026-08-20T10:06:00Z', '2026-08-20T10:01:00Z')`
    )).rejects.toThrow(/violates check/);
    await expect(db.query(
      `INSERT INTO apocalypse_coin_events
         (cycle_id, coin_id, event_seq, name, direction, strength_category, modifier, starts_at, ends_at)
       VALUES (1, 1, 0, 'Bad Seq', 'POSITIVE', 'MINOR', 0.01, '2026-08-20T10:01:00Z', '2026-08-20T10:06:00Z')`
    )).rejects.toThrow(/violates check/);

    // FKs tie every event to a real cycle and a real coin.
    await expect(db.query(
      `INSERT INTO apocalypse_coin_events
         (cycle_id, coin_id, event_seq, name, direction, strength_category, modifier, starts_at, ends_at)
       VALUES (999, 1, 1, 'Bad Cycle', 'POSITIVE', 'MINOR', 0.01, '2026-08-20T10:01:00Z', '2026-08-20T10:06:00Z')`
    )).rejects.toThrow(/violates foreign key/);
    await expect(db.query(
      `INSERT INTO apocalypse_coin_events
         (cycle_id, coin_id, event_seq, name, direction, strength_category, modifier, starts_at, ends_at)
       VALUES (1, 999, 1, 'Bad Coin', 'POSITIVE', 'MINOR', 0.01, '2026-08-20T10:01:00Z', '2026-08-20T10:06:00Z')`
    )).rejects.toThrow(/violates foreign key/);
  });

  test('the database enforces the market-phase invariants: identity, signs, windows, vocabularies, FK', async () => {
    await db.query(
      `INSERT INTO apocalypse_cycles (apocalypse_id, seed, start_time, end_time, duration_ms, status)
       VALUES ('APOC-0001', 'mig020-seed', '2026-08-20T10:00:00Z', '2026-08-20T10:30:00Z', 1800000, 'ACTIVE')`
    );
    const valid = `
      INSERT INTO apocalypse_market_phases
        (cycle_id, phase_seq, phase, lifecycle_state, modifier, starts_at, ends_at)
      VALUES (1, 1, 'BOOM', 'GROWTH', 0.02, '2026-08-20T10:00:00Z', '2026-08-20T10:05:00Z')`;
    await db.query(valid);

    // The chain-identity backstop: one row per (cycle_id, phase_seq).
    await expect(db.query(valid)).rejects.toThrow(/duplicate key/);

    // The modifier sign must match the phase group.
    await expect(db.query(
      `INSERT INTO apocalypse_market_phases
         (cycle_id, phase_seq, phase, lifecycle_state, modifier, starts_at, ends_at)
       VALUES (1, 2, 'BULL', 'GROWTH', -0.01, '2026-08-20T10:05:00Z', '2026-08-20T10:10:00Z')`
    )).rejects.toThrow(/violates check/);

    // Phase and lifecycle vocabularies are closed.
    await expect(db.query(
      `INSERT INTO apocalypse_market_phases
         (cycle_id, phase_seq, phase, lifecycle_state, modifier, starts_at, ends_at)
       VALUES (1, 3, 'MANIA', 'GROWTH', 0.01, '2026-08-20T10:05:00Z', '2026-08-20T10:10:00Z')`
    )).rejects.toThrow(/violates check/);
    await expect(db.query(
      `INSERT INTO apocalypse_market_phases
         (cycle_id, phase_seq, phase, lifecycle_state, modifier, starts_at, ends_at)
       VALUES (1, 4, 'BEAR', 'EUPHORIA', -0.01, '2026-08-20T10:05:00Z', '2026-08-20T10:10:00Z')`
    )).rejects.toThrow(/violates check/);

    // Windows must be positive; chain positions start at 1; the cycle FK holds.
    await expect(db.query(
      `INSERT INTO apocalypse_market_phases
         (cycle_id, phase_seq, phase, lifecycle_state, modifier, starts_at, ends_at)
       VALUES (1, 5, 'BEAR', 'DECLINE', -0.01, '2026-08-20T10:10:00Z', '2026-08-20T10:05:00Z')`
    )).rejects.toThrow(/violates check/);
    await expect(db.query(
      `INSERT INTO apocalypse_market_phases
         (cycle_id, phase_seq, phase, lifecycle_state, modifier, starts_at, ends_at)
       VALUES (1, 0, 'BEAR', 'DECLINE', -0.01, '2026-08-20T10:05:00Z', '2026-08-20T10:10:00Z')`
    )).rejects.toThrow(/violates check/);
    await expect(db.query(
      `INSERT INTO apocalypse_market_phases
         (cycle_id, phase_seq, phase, lifecycle_state, modifier, starts_at, ends_at)
       VALUES (999, 6, 'BEAR', 'DECLINE', -0.01, '2026-08-20T10:05:00Z', '2026-08-20T10:10:00Z')`
    )).rejects.toThrow(/violates foreign key/);
  });
});
