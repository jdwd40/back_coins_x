// Migration runner + schema verification coverage for Crypto Chaos
// issue #18 (passive economic pressure: cash-event ledger, economy tick
// claims, deterministic event schedule).
//
// Runs the REAL migration runner (db/migrate.js) and the REAL verification
// (db/verify-game-schema.js) against the disposable test database. The guard
// refuses any non-test target. db/seed.js is never used as a migration or
// verification mechanism here; it only provides the pre-existing Coins
// schema and data (via jest.setup.js beforeEach) that migration 016 must
// preserve.

const db = require('../db/connection');
const { runMigrations } = require('../db/migrate');
const { verifyGameSchema } = require('../db/verify-game-schema');
const { assertDisposableTestDatabase } = require('./helpers/testDatabaseGuard');

const MIGRATION_016 = '016_create_apocalypse_economy.sql';

async function drop016() {
  await db.query('DROP TABLE IF EXISTS apocalypse_cash_events CASCADE');
  await db.query('DROP TABLE IF EXISTS apocalypse_economy_events CASCADE');
  await db.query('DROP TABLE IF EXISTS apocalypse_economy_ticks CASCADE');
  await db.query('DELETE FROM schema_migrations WHERE migration = $1', [MIGRATION_016]);
}

describe('issue #18: tracked production migration 016', () => {
  beforeEach(async () => {
    assertDisposableTestDatabase();
    await runMigrations({ log: () => {} }); // tracked, fully migrated baseline
  });

  test('applies 016 to an existing database, preserving all pre-existing schema and data', async () => {
    // \"Existing production data\": a live cycle with participants.
    await db.query(
      `INSERT INTO apocalypse_cycles (apocalypse_id, seed, start_time, end_time, duration_ms, status)
       VALUES ('APOC-0001', 'mig016-seed', '2026-08-20T10:00:00Z', '2026-08-20T10:30:00Z', 1800000, 'ACTIVE')`
    );
    await db.query(
      `INSERT INTO apocalypse_participants (cycle_id, user_id, starting_cash, current_cash, peak_wealth, status)
       VALUES (1, 1, 10000.00, 10000.00, 10000.00, 'ACTIVE')`
    );
    const usersBefore = await db.query('SELECT count(*)::int AS n FROM users');
    const coinsBefore = await db.query('SELECT count(*)::int AS n FROM coins');

    await drop016(); // simulate the pre-#18 schema on top of existing data
    const result = await runMigrations({ log: () => {} });
    expect(result.applied).toContain(MIGRATION_016);

    const verification = await verifyGameSchema();
    expect(verification.problems).toEqual([]);
    expect(verification.ok).toBe(true);

    // Pre-existing data fully preserved; the new tables start empty.
    expect((await db.query('SELECT count(*)::int AS n FROM users')).rows[0].n).toBe(usersBefore.rows[0].n);
    expect((await db.query('SELECT count(*)::int AS n FROM coins')).rows[0].n).toBe(coinsBefore.rows[0].n);
    expect((await db.query('SELECT count(*)::int AS n FROM apocalypse_participants')).rows[0].n).toBe(1);
    for (const t of ['apocalypse_cash_events', 'apocalypse_economy_ticks', 'apocalypse_economy_events']) {
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
    // Lose only the tracking row: the runner must re-execute 016 against the
    // existing compatible tables, detect compatibility, and record it again.
    await db.query('DELETE FROM schema_migrations WHERE migration = $1', [MIGRATION_016]);
    const rerun = await runMigrations({ log: () => {} });
    expect(rerun.applied).toContain(MIGRATION_016);
    const verification = await verifyGameSchema();
    expect(verification.ok).toBe(true);
  });

  test('fails clearly on an incompatible pre-existing apocalypse_cash_events table', async () => {
    await drop016();
    await db.query('CREATE TABLE apocalypse_cash_events (cash_event_id integer)');
    await expect(runMigrations({ log: () => {} })).rejects.toThrow(/INCOMPATIBLE/);

    // The failed migration was rolled back: not recorded.
    const tracked = await db.query('SELECT migration FROM schema_migrations WHERE migration = $1', [MIGRATION_016]);
    expect(tracked.rows).toHaveLength(0);

    const verification = await verifyGameSchema();
    expect(verification.ok).toBe(false);
  });

  test('verification fails clearly when the economy tables are absent', async () => {
    await drop016();
    const verification = await verifyGameSchema();
    expect(verification.ok).toBe(false);
    expect(verification.problems).toContain('table public.apocalypse_cash_events does not exist');
    expect(verification.problems).toContain('table public.apocalypse_economy_ticks does not exist');
    expect(verification.problems).toContain('table public.apocalypse_economy_events does not exist');
  });

  test('the database enforces the ledger invariants: idempotent identity, exact balance chain, valid types', async () => {
    await db.query(
      `INSERT INTO apocalypse_cycles (apocalypse_id, seed, start_time, end_time, duration_ms, status)
       VALUES ('APOC-0001', 'mig016-seed', '2026-08-20T10:00:00Z', '2026-08-20T10:30:00Z', 1800000, 'ACTIVE')`
    );
    await db.query(
      `INSERT INTO apocalypse_participants (cycle_id, user_id, starting_cash, current_cash, peak_wealth, status)
       VALUES (1, 1, 10000.00, 9995.00, 10000.00, 'ACTIVE')`
    );
    await db.query(
      `INSERT INTO apocalypse_cash_events
         (participant_id, cycle_id, user_id, type, amount, balance_before, balance_after, description, event_key)
       VALUES (1, 1, 1, 'FEE', 5.00, 10000.00, 9995.00, 'Recurring round fee (tick 1)', 'FEE-T1')`
    );

    // The idempotency backstop: the same logical debit can never be inserted twice.
    await expect(
      db.query(
        `INSERT INTO apocalypse_cash_events
           (participant_id, cycle_id, user_id, type, amount, balance_before, balance_after, description, event_key)
         VALUES (1, 1, 1, 'FEE', 5.00, 10000.00, 9995.00, 'Recurring round fee (tick 1)', 'FEE-T1')`
      )
    ).rejects.toThrow(/duplicate key/);

    // The balance chain must explain the mutation exactly.
    await expect(
      db.query(
        `INSERT INTO apocalypse_cash_events
           (participant_id, cycle_id, user_id, type, amount, balance_before, balance_after, description, event_key)
         VALUES (1, 1, 1, 'TAX', 10.00, 10000.00, 9999.00, 'bad chain', 'TAX-T1')`
      )
    ).rejects.toThrow(/violates check/);

    // Types are exactly FEE/TAX/EVENT; amounts are strictly positive.
    await expect(
      db.query(
        `INSERT INTO apocalypse_cash_events
           (participant_id, cycle_id, user_id, type, amount, balance_before, balance_after, description, event_key)
         VALUES (1, 1, 1, 'BUY', 5.00, 10000.00, 9995.00, 'wrong type', 'X-1')`
      )
    ).rejects.toThrow(/violates check/);
    await expect(
      db.query(
        `INSERT INTO apocalypse_cash_events
           (participant_id, cycle_id, user_id, type, amount, balance_before, balance_after, description, event_key)
         VALUES (1, 1, 1, 'FEE', 0.00, 10000.00, 10000.00, 'zero', 'FEE-T9')`
      )
    ).rejects.toThrow(/violates check/);

    // Tick claims: one row per (cycle_id, kind, tick_id), forever.
    await db.query(`INSERT INTO apocalypse_economy_ticks (cycle_id, kind, tick_id) VALUES (1, 'FEE', 1)`);
    await expect(
      db.query(`INSERT INTO apocalypse_economy_ticks (cycle_id, kind, tick_id) VALUES (1, 'FEE', 1)`)
    ).rejects.toThrow(/duplicate key/);
    await expect(
      db.query(`INSERT INTO apocalypse_economy_ticks (cycle_id, kind, tick_id) VALUES (1, 'LEVY', 1)`)
    ).rejects.toThrow(/violates check/);

    // The composite FK ties every ledger row to its exact participant.
    await expect(
      db.query(
        `INSERT INTO apocalypse_cash_events
           (participant_id, cycle_id, user_id, type, amount, balance_before, balance_after, description, event_key)
         VALUES (1, 1, 2, 'FEE', 5.00, 10000.00, 9995.00, 'wrong user', 'FEE-T2')`
      )
    ).rejects.toThrow(/violates foreign key/);
  });
});
